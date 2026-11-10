import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { fingerprint } from './fingerprint.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { datasheetReadCell, datasheetRoleSummary, datasheetTypeNames, datasheetVisibility } from './datasheet-visibility.js'
import { describeDatasheet } from './datasheet.js'
import type { Workflow } from './workflows.js'

export type DatasheetRecordsAction = 'describe' | 'list' | 'get'
export const datasheetRecordsSteps = [
  ['identity', 'GET', '/task/login/authAjax'], ['project', 'GET', '/task/v1/kanbanCrud'], ['modules', 'GET', '/task/v1/kanbanChildCrud/list'],
  ['context', 'GET', '/task/mt/datasheet/{datasheetId}/dataPack'], ['records', 'POST', '/task/mt/datasheet/{datasheetId}/records'],
  ['verifiedContext', 'GET', '/task/mt/datasheet/{datasheetId}/dataPack'],
] as const
export const datasheetRecordsStepsFor = (action: DatasheetRecordsAction) => action === 'describe' ? datasheetRecordsSteps.slice(0, 4) : datasheetRecordsSteps
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const assert = (condition: unknown, message: string): void => { if (!condition) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const opaque = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : invalid('缺少精确的资源 ID。')
const numeric = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('项目 ID 必须是精确正整数。')

export function validateDatasheetRecordsWorkflow(flow: Workflow) {
  const expected = datasheetRecordsStepsFor(flow.datasheetRecordsAction!)
  if (flow.executor !== 'datasheet-records' || !['describe', 'list', 'get'].includes(flow.datasheetRecordsAction!) || flow.command !== (flow.datasheetRecordsAction === 'describe' ? 'datasheet describe' : 'datasheet record ' + flow.datasheetRecordsAction) || flow.effect !== 'write' || flow.steps.length !== expected.length || expected.some(([id, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step?.operationId)
    return step.id !== id || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.readback || step.authentication || step.resources || step.assertions || step.expectAbsent || step.waitBeforeMs
  })) throw new RsqError('INVALID_CONTRACT', '数据表读取命令必须保留已核对的身份、项目、权限和独立记录 HTTP 步骤。', 6)
}

export type DatasheetRecordSelection = { recordIds: string[]; contextVersion: string }
export function datasheetRecordPage(data: JsonObject, input: JsonObject, binding: { projectId: string; moduleId: string; mainProjectId: string; userId: string; teamId: string }, selection?: DatasheetRecordSelection) {
  const visible = datasheetVisibility(data, binding.mainProjectId !== binding.projectId)
  if (!visible.completeTable) throw new RsqError('VIEW_CONTEXT_REQUIRED', '当前身份只可访问部分视图，不能绕过视图筛选读取全表；此分支仍需视图上下文适配。', 4, { permittedViews: visible.views.map(view => ({ id: view.id, name: view.name })) })
  const fields = input.fieldIds === undefined ? visible.fields : (() => {
    if (!Array.isArray(input.fieldIds) || !input.fieldIds.length || input.fieldIds.length > 1000 || new Set(input.fieldIds).size !== input.fieldIds.length || input.fieldIds.some(key => typeof key !== 'string' || !visible.fieldIds.has(key))) invalid('fieldIds 必须是当前可见字段的唯一 ID 列表。')
    return (input.fieldIds as string[]).map(key => visible.fields.find(field => field.id === key)!)
  })()
  if (input.expectedRevision !== undefined && input.expectedRevision !== visible.table.revision) throw new RsqError('CONTEXT_CONFLICT', '数据表 revision 已变化，请重新发现并读取。', 5, { revision: visible.table.revision })
  // A statistics cache selects records; it grants no record or column rights.
  // This argument is internal, never taken from the public command input.
  if (selection && (!Array.isArray(selection.recordIds) || selection.recordIds.length > 100000 || selection.recordIds.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) || new Set(selection.recordIds).size !== selection.recordIds.length || !/^[a-f0-9]{64}$/.test(selection.contextVersion))) invalid('统计记录选择上下文不完整。')
  const selectedSet = selection ? new Set(selection.recordIds) : null
  const recordIds = selectedSet ? visible.recordIds.filter(key => selectedSet.has(key)) : visible.recordIds
  const contextVersion = fingerprint({ ...binding, datasheetId: visible.table.id, revision: visible.table.revision, role: visible.role,
    fields: fields.map(field => ({ id: field.id, type: field.type, attr: field.attr })), recordIds: visible.recordIds,
    ...(selection && { selection: { contextVersion: selection.contextVersion, recordIds: [...selection.recordIds].sort() } }) })
  let after: string | undefined
  if (input.cursor !== undefined) {
    if (input.recordId !== undefined || typeof input.cursor !== 'string' || input.cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('分页游标无效。')
    let cursor: JsonObject
    try { cursor = asObject(JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8'))) } catch { return invalid('分页游标不是有效 JSON。') }
    if (Object.keys(cursor).sort().join(',') !== 'after,contextVersion,version' || cursor.version !== 1 || typeof cursor.after !== 'string') invalid('分页游标结构无效。')
    if (cursor.contextVersion !== contextVersion || !recordIds.includes(String(cursor.after))) throw new RsqError('CONTEXT_CONFLICT', '分页期间版本、角色、字段或可见记录范围已变化，请重新开始。', 5, { revision: visible.table.revision })
    after = String(cursor.after)
  }
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500) invalid('limit 必须在 1–500 之间。')
  let selected: string[], hasMore = false
  if (input.recordId !== undefined) {
    const recordId = opaque(input.recordId)
    if (!recordIds.includes(recordId)) throw new RsqError('RESOURCE_NOT_FOUND', '当前项目上下文中没有可见的目标记录。', 4)
    selected = [recordId]
  } else {
    const start = after === undefined ? 0 : recordIds.indexOf(after) + 1
    selected = recordIds.slice(start, start + Number(limit)); hasMore = start + selected.length < recordIds.length
  }
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({ version: 1, contextVersion, after: selected.at(-1) })).toString('base64url') : null
  const result = { datasheetId: visible.table.id, revision: visible.table.revision, contextVersion, scope: selection ? 'role-visible-chart-records' : 'role-visible-table-records', order: 'record-id-ascending',
    role: datasheetRoleSummary(visible.role), fields: fields.map(field => ({ id: field.id, name: field.name, type: field.type, typeName: datasheetTypeNames[Number(field.type)], attr: field.attr, role: visible.fieldRoles[String(field.id)] })),
    records: selected.map(id => ({ id, cells: Object.fromEntries(fields.map(field => [String(field.id), datasheetReadCell(field, asObject(visible.recordMap[id]))])) })),
    pagination: { limit: Number(limit), visibleTotal: recordIds.length, returned: selected.length, hasMore, nextCursor },
    ...(selection && { selection: { requestedTotal: selection.recordIds.length, visibleTotal: recordIds.length, unavailableTotal: selection.recordIds.length - recordIds.length } }) }
  return { visible, selected, fields, result }
}

export async function runDatasheetRecords(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean; timeoutMs?: number; selection?: DatasheetRecordSelection }) {
  validateDatasheetRecordsWorkflow(flow)
  const session = requireSession(supplied), projectId = numeric(input.projectId), datasheetId = opaque(input.datasheetId)
  const resources: Record<string, string> = { projectId, datasheetId }, completed: string[] = []
  let phase = 'identity', packAttempted = false
  const call = async (id: string, args: JsonObject = {}) => {
    phase = id; if (id === 'context' || id === 'verifiedContext') packAttempted = true
    const step = flow.steps.find(step => step.id === id)!, op = catalog.operations.find(op => op.id === step.operationId)!
    const result = await runOperation(ctx, op, args, session, { ...options, transport: options.transport ?? request })
    completed.push(id); return result
  }
  try {
    const actor = asObject(await call('identity'))
    assert(numeric(actor.id) === session.identity.userId && numeric(asObject(actor.team).id) === session.identity.teamId, '数据表读取身份与当前 profile 不一致。')
    const project = asObject(await call('project', { query: { id: projectId } }))
    assert(numeric(project.id) === projectId && Object.hasOwn(project, 'coverId') && project.coverId === null, '此命令必须绑定真实普通项目；模板上下文不能混用。')
    const rawModules = await call('modules', { query: { kanbanId: projectId } })
    assert(Array.isArray(rawModules) && rawModules.length <= 10000, '缺少完整项目模块。')
    const modules = (rawModules as unknown[]).map(asObject).filter(module => module.type === 'datasheet' && asObject(module.datasheetInfo).datasheetId === datasheetId)
    assert(modules.length === 1, '项目中没有唯一关联的目标数据表模块。')
    const moduleId = numeric(modules[0].id), mainProjectId = numeric(asObject(modules[0].datasheetInfo).mainProjectId)
    Object.assign(resources, { moduleId, mainProjectId })
    const data = asObject(asObject(await call('context', { path: { datasheetId }, query: { projectId } })).data)
    assert(asObject(data.datasheet).id === datasheetId, '返回的数据表与实际模块不一致。')
    if (flow.datasheetRecordsAction === 'describe') {
      if (input.expectedRevision !== undefined && input.expectedRevision !== asObject(data.datasheet).revision) throw new RsqError('CONTEXT_CONFLICT', '数据表 revision 已变化，请重新发现。', 5)
      return { workflow: flow.id, completedSteps: completed, resources, result: describeDatasheet({ context: { data } }, mainProjectId !== projectId) }
    }
    const page = datasheetRecordPage(data, input, { projectId, moduleId, mainProjectId, userId: session.identity.userId, teamId: numeric(session.identity.teamId) }, options.selection)
    if (page.selected.length) {
      const verified = asObject(asObject(await call('records', { path: { datasheetId }, body: page.selected })).data), records = asObject(verified.recordMap)
      assert(verified.revision === page.result.revision, '独立记录读取期间 revision 已变化，不能返回混合快照。')
      assert(isDeepStrictEqual(Object.keys(records).sort(), [...page.selected].sort()), '独立记录接口返回缺失或额外记录。')
      for (const id of page.selected) {
        const actual = asObject(records[id]), original = asObject(page.visible.recordMap[id])
        assert(actual.id === id, '独立记录身份不一致。')
        for (const field of page.fields) if (![15, 16, 19, 20, 21, 22, 24, 26].includes(Number(field.type))) assert(isDeepStrictEqual(asObject(actual.data)[String(field.id)] ?? null, asObject(original.data)[String(field.id)] ?? null), '独立记录值与权限快照不同，请重新读取。')
      }
    }
    const refreshed = asObject(asObject(await call('verifiedContext', { path: { datasheetId }, query: { projectId } })).data)
    const finalPage = datasheetRecordPage(refreshed, input, { projectId, moduleId, mainProjectId, userId: session.identity.userId, teamId: numeric(session.identity.teamId) }, options.selection)
    if (page.result.contextVersion !== finalPage.result.contextVersion || !isDeepStrictEqual(page.result.records, finalPage.result.records)) throw new RsqError('CONTEXT_CONFLICT', '独立读取期间权限、版本或实际值变化，请重新开始。', 5)
    return { workflow: flow.id, completedSteps: completed, resources, result: { ...page.result, proof: { nativeStoredValuesReadBack: page.selected.length > 0,
      computedValuesSource: 'http-dataPack-recordMeta', roleAndProjectBound: true, uiViewFiltersApplied: false, writeReplay: false } } }
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('UNEXPECTED_ERROR', '数据表读取失败。', 1)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...cause.details, resources, completedSteps: completed, failedStep: phase,
      writeOutcome: packAttempted ? 'dataPack-may-have-initialized-permission-or-computed-values' : 'business-mutation-not-sent', automaticReplay: false })
  }
}
