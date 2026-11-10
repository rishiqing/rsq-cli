import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { checkAccess } from './access.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { normalizeCell } from './datasheet.js'
import { newId, type Field } from './datasheet-fields.js'
import type { Workflow } from './workflows.js'

export type WorkflowDatasheetAction = 'inspect' | 'add' | 'set' | 'remove' | 'validate'
type Route = readonly [string, string, string]
const prefix = '/task/workflow/process-info/{processInfoId}/fields/{fieldId}/datasheet-modify/'
const actions = { inspect: 'inspect', add: 'record add', set: 'cell set', remove: 'record remove', validate: 'validate' }
const fail = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const data = (raw: unknown) => { const value = asObject(raw); return Object.hasOwn(value, 'data') ? asObject(value.data) : value }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '流程数据表缺少精确资源编号。')
const opaque = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : fail('CONTEXT_MISSING', '流程数据表缺少有效内部编号。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('CONTEXT_MISSING', '流程数据表缺少完整列表。')
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 1000) return fail('CONTEXT_INCOMPLETE', '流程数据表列表缺失或超过1000项，未将截断列表当成完整上下文。')
  const result = value.map(opaque); if (new Set(result).size !== result.length) fail('CONTEXT_MISMATCH', '流程数据表包含重复编号。'); return result
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(asObject(value)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const version = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
/** FieldVO also contains computed value/linkContentFieldData. Pack loading
 * materializes that data, so only definition properties belong in this part. */
export function workflowDatasheetDefinition(field: JsonObject) {
  const config = asObject(field.datasheetLinkVO)
  return { ...Object.fromEntries(['id', 'name', 'type', 'isRequired', 'isHidden'].map(key => [key, field[key] ?? null])), datasheetLinkVO: Object.fromEntries(['projectId', 'datasheetId', 'linkType', 'isAddDatasheetData', 'isAddMultiDatasheetData', 'isShowField', 'datasheetFieldIdList', 'requiredFieldIds'].map(key => [key, config[key] ?? null])) }
}

export function workflowDatasheetSteps(action: WorkflowDatasheetAction, project: boolean): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['process', 'GET', '/task/workflow/process/info/details'], ['instanceStep', 'GET', '/task/workflow/process/info/step'], ['instanceForm', 'GET', '/task/workflow/process/info/step/list/auditsAndForms'], ['application', 'GET', '/task/workflow/application'], ...(project ? [['project', 'GET', '/task/v1/kanbanCrud']] as Route[] : []), ['pack', 'GET', prefix + 'pack'], ...(action === 'inspect' ? [] : [['changed', action === 'set' ? 'PUT' : 'POST', prefix + ({ add: 'records', set: 'records/{recordId}/fields/{targetFieldId}', remove: 'records/delete', validate: 'validate' }[action])]] as Route[])]
}
export function validateWorkflowDatasheetWorkflow(flow: Workflow) {
  const action = flow.workflowDatasheetAction
  if (flow.executor !== 'workflow-datasheet' || !action || !Object.hasOwn(actions, action) || typeof flow.workflowDatasheetProject !== 'boolean') fail('INVALID_CONTRACT', '未知流程数据表业务。')
  if (flow.command !== (flow.workflowDatasheetProject ? 'project workflow datasheet ' : 'workflow datasheet ') + actions[action!] || flow.effect !== (['inspect', 'validate'].includes(action!) ? 'write' : 'destructive')) fail('INVALID_CONTRACT', '流程数据表命令和副作用不一致。')
  const expected = workflowDatasheetSteps(action!, flow.workflowDatasheetProject!)
  if (flow.steps.length !== expected.length || flow.steps.some((step, index) => {
    const [name, method, route] = expected[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op?.route !== route || Object.keys(step.input).length || step.prepare || step.transfer || step.forEach || step.collectPages || step.waitBeforeMs || step.readback || step.expectAbsent || step.assertions || step.resources || step.authentication || step.creationVisibility
  })) fail('INVALID_CONTRACT', '流程数据表只能执行已核对的固定 HTTP 上下文及写入步骤。')
}

/** The virtual pack stores workflow IDs; it is not the target datasheet snapshot. */
export function workflowDatasheetPack(raw: unknown, field: JsonObject) {
  const pack = data(raw), config = asObject(pack.config), target = asObject(pack.target), snapshot = asObject(pack.snapshot), metadata = asObject(snapshot.meta)
  const definition = asObject(field.datasheetLinkVO), recordIds = ids(asObject(pack.value).recordIds), map = asObject(snapshot.recordMap)
  if (![3, 4].includes(Number(config.linkType)) || Number(definition.linkType) !== Number(config.linkType) || opaque(config.linkDatasheetId) !== opaque(target.datasheetId) || opaque(definition.datasheetId) !== target.datasheetId || (definition.projectId == null ? null : id(definition.projectId)) !== (target.projectId == null ? null : id(target.projectId)) || (config.projectId == null ? null : id(config.projectId)) !== (target.projectId == null ? null : id(target.projectId)) || opaque(snapshot.datasheetId) !== opaque(config.datasheetId)) fail('CONTEXT_MISMATCH', '运行包的真实目标、字段配置或虚拟表身份不一致。')
  for (const key of ['multipleRecord', 'customField', 'canAddRecord']) if (typeof config[key] !== 'boolean') fail('CONTEXT_MISSING', '运行包缺少明确的记录与字段配置。')
  if (config.multipleRecord !== (definition.isAddMultiDatasheetData === true) || config.customField !== (definition.isShowField === true) || config.canAddRecord !== (definition.isAddDatasheetData === true)) fail('CONTEXT_MISMATCH', '运行包与当前流程字段配置发生变化。')
  const configuredFields = ids(config.customFieldIds), requiredFields = ids(config.requiredFieldIds), readonly = ids(pack.readonlyFieldIds), missing = ids(pack.missingFieldIds), permissions = asObject(pack.permissions)
  if (!isDeepStrictEqual(configuredFields, ids(definition.datasheetFieldIdList ?? [])) || !isDeepStrictEqual(requiredFields, ids(definition.requiredFieldIds ?? []))) fail('CONTEXT_MISMATCH', '运行包的实际字段范围或必填配置与当前表单不一致。')
  for (const key of ['canAddRecord', 'canEditRecord', 'canDeleteRecord']) if (typeof permissions[key] !== 'boolean') fail('CONTEXT_MISSING', '运行包缺少真实远端编辑权限。')
  const views = rows(metadata.views); if (views.length !== 1) fail('CONTEXT_MISMATCH', '流程数据表运行视图不唯一。')
  const order = ids(rows(views[0].rows).map(row => row.recordId)), visible = ids(rows(views[0].columns).map(column => column.fieldId)), fieldMap = asObject(metadata.fieldMap)
  if (!isDeepStrictEqual(order, recordIds) || !isDeepStrictEqual(Object.keys(map).sort(), [...recordIds].sort())) fail('CONTEXT_INCOMPLETE', '字段内部记录顺序或完整记录包不一致。')
  for (const key of recordIds) if (asObject(map[key]).id !== key || !Object.hasOwn(asObject(map[key]), 'data')) fail('CONTEXT_MISMATCH', '字段记录包与实际记录编号不一致。')
  for (const key of visible) if (opaque(asObject(fieldMap[key]).id) !== key || !Number.isSafeInteger(asObject(fieldMap[key]).type)) fail('CONTEXT_MISSING', '运行视图引用不存在或无类型的真实字段。')
  return { pack, config, target, recordIds, map, visible, fieldMap, readonly, missing, permissions, requiredFields }
}
function assertUnchanged(before: ReturnType<typeof workflowDatasheetPack>, after: ReturnType<typeof workflowDatasheetPack>, changedRecord?: string, changedField?: string, removed: string[] = []) {
  if (!isDeepStrictEqual(before.target, after.target) || !isDeepStrictEqual(before.config, after.config) || !isDeepStrictEqual(before.visible, after.visible) || !isDeepStrictEqual(before.readonly, after.readonly) || !isDeepStrictEqual(before.missing, after.missing)) fail('BUSINESS_ASSERTION_FAILED', '写入后目标或字段配置已变化，需要重新核对。')
  for (const recordId of before.recordIds.filter(key => !removed.includes(key))) {
    const a = asObject(asObject(before.map[recordId]).data), b = asObject(asObject(after.map[recordId]).data)
    for (const fieldId of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (recordId === changedRecord && fieldId === changedField || before.readonly.includes(fieldId)) continue
      if (!isDeepStrictEqual(a[fieldId] ?? null, b[fieldId] ?? null)) fail('BUSINESS_ASSERTION_FAILED', '未修改的可写单元格发生变化；未将部分写入外推为业务成功。')
    }
  }
}
export async function runWorkflowDatasheet(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { approved?: boolean; transport?: Transport } = {}) {
  validateWorkflowDatasheetWorkflow(flow)
  const session = requireSession(supplied), action = flow.workflowDatasheetAction!, completed: string[] = [], resources: JsonObject = { processId: input.processId, stepId: input.stepId, fieldId: input.fieldId }
  let phase = 'identity', pending = false, written = false
  const call = async (name: string, args: JsonObject = {}) => {
    phase = name; const step = flow.steps.find(step => step.id === name)!, op = catalog.operations.find(op => op.id === step.operationId)!
    const transport: Transport = async (url, init) => { if (name === 'changed') pending = true; return (options.transport ?? request)(url, init) }
    const result = await runOperation(ctx, op, args, session, { approved: options.approved, transport }); if (name === 'changed') written = true
    pending = false; completed.push(name); return data(result)
  }
  const identity = async () => { const actual = await call('identity'); if (id(actual.id) !== session.identity.userId || id(asObject(actual.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '流程数据表身份或公司与当前 profile 不一致。') }
  const path = { processInfoId: input.processId, fieldId: input.fieldId }
  const read = async () => {
    const process = await call('process', { query: { processInfoId: input.processId } }), step = await call('instanceStep', { query: { stepInfoId: input.stepId } })
    if (id(process.id) !== input.processId || id(step.id) !== input.stepId || id(step.processInfoId) !== input.processId || id(step.applicationId) !== id(process.flowAppId) || !rows(process.processInfoStepList).some(row => id(row.id) === input.stepId)) fail('CONTEXT_MISMATCH', '流程实例、应用与实际步骤不一致。')
    const form = await call('instanceForm', { query: { stepInfoId: input.stepId, isRefresh: false } })
    if (id(form.formId) !== id(step.formId)) fail('CONTEXT_MISMATCH', '步骤表单身份发生变化。')
    const selected = rows(form.fields).filter(row => id(row.id) === input.fieldId)
    if (selected.length !== 1 || Number(selected[0].type) !== 45 || selected[0].isHidden === true || typeof selected[0].isRequired !== 'boolean') fail('INVALID_INPUT', '请选择当前步骤可见的 DatasheetModify 字段45；不能将普通关联字段35当作修改草稿。')
    const field = selected[0], application = await call('application', { query: { id: id(process.flowAppId) } })
    if (id(application.id) !== id(process.flowAppId)) fail('CONTEXT_MISMATCH', '实际流程应用与实例不一致。')
    const subtype = application.workflowModuleSubType
    if (flow.workflowDatasheetProject) {
      if (!['projectWorkflow', 'alterationWorkflow'].includes(String(subtype)) || id(process.belongToProjectId) !== input.projectId) fail('FORBIDDEN', '项目流程命令须绑定实际所属项目，不能猜测所属或使用独立流程。')
      const project = await call('project', { query: { id: input.projectId, isDefault: false } })
      if (id(project.id) !== input.projectId || !Object.hasOwn(project, 'coverId') || project.coverId != null) fail('FORBIDDEN', '项目流程实例只接受实际普通项目。')
      if (subtype === 'alterationWorkflow') await checkAccess(ctx, { ...flow, command: 'project alteration flow inspect' }, input, session, options.transport)
    } else if (subtype != null || process.belongToProjectId != null) fail('FORBIDDEN', '此实例来自项目；请用 project workflow datasheet 并明确项目。')
    const controls = asObject(form.editControl), canEdit = controls.fillStepForm === true || controls.modifyStepForm === true
    if (action !== 'inspect' && !canEdit) fail('FORBIDDEN', '当前身份不能填写或修改此步骤表单。')
    const pack = workflowDatasheetPack(await call('pack', { path, query: { stepInfoId: input.stepId, mode: canEdit ? 'edit' : 'view' } }), field)
    resources.applicationId = process.flowAppId; resources.target = pack.target
    const contextParts: JsonObject = { processId: process.id, applicationId: process.flowAppId, projectId: process.belongToProjectId ?? null, status: process.status, step: Object.fromEntries(['id', 'applicationId', 'processInfoId', 'formId', 'status', 'type', 'isDisplay'].map(key => [key, step[key] ?? null])), field: workflowDatasheetDefinition(field), controls, subtype, config: pack.config, target: pack.target, visible: pack.visible, fieldMap: pack.fieldMap, readonly: pack.readonly, missing: pack.missing, permissions: pack.permissions, recordIds: pack.recordIds, records: pack.map }
    const contextChecks = Object.fromEntries(Object.entries(contextParts).map(([key, value]) => [key, version(value)])), contextVersion = version(contextParts)
    return { field, pack, contextVersion, contextChecks, canEdit }
  }
  const done = (result: JsonObject) => ({ command: flow.command, completedSteps: completed, resources, result })
  try {
    await identity(); const before = await read()
    if (input.contextVersion != null && input.contextVersion !== before.contextVersion) throw new RsqError('CONTEXT_CONFLICT', '运行上下文已变化，请重新 inspect 后明确操作。', 5, { currentContextChecks: before.contextChecks, currentVersion: before.contextVersion, mutationSent: false })
    if (action === 'inspect') return done({ field: { id: before.field.id, name: before.field.name, required: before.field.isRequired }, contextVersion: before.contextVersion, contextChecks: before.contextChecks, canEdit: before.canEdit, ...before.pack.pack, proofScope: 'workflow-draft-only', targetSynchronizationVerified: false, sideEffect: 'pack-can-create-draft-refresh-snapshot-and-annex-folder' })
    const prepare = (current: typeof before) => {
      const pack = current.pack, body: JsonObject = { stepInfoId: input.stepId }, requestPath = { ...path }
      if (action === 'add') {
        if (pack.permissions.canAddRecord !== true || pack.config.canAddRecord !== true) fail('FORBIDDEN', '当前流程和目标表不允许增加记录。')
        if (pack.config.multipleRecord === false && pack.recordIds.length || pack.recordIds.length >= 1000) fail('INVALID_INPUT', '当前字段只允许一条记录或已达到 CLI 的完整性上限。')
        const index = input.index ?? pack.recordIds.length; if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > pack.recordIds.length) fail('INVALID_INPUT', '插入位置超出当前实际记录范围。')
        Object.assign(body, { recordId: resources.recordId ?? input.recordId ?? newId('rec'), index }); resources.recordId = opaque(body.recordId)
        if (pack.recordIds.includes(String(body.recordId))) fail('INVALID_INPUT', '内部记录已存在；请先 inspect，不能重复增加记录。')
      } else if (action === 'set') {
        if (pack.permissions.canEditRecord !== true) fail('FORBIDDEN', '当前流程和目标表不允许修改记录。')
        const recordId = opaque(input.recordId), fieldId = opaque(input.targetFieldId)
        if (!pack.recordIds.includes(recordId) || !pack.visible.includes(fieldId) || pack.config.customField === true && !(pack.config.customFieldIds as string[]).includes(fieldId)) fail('INVALID_INPUT', '请选择实际运行包中的可见记录和配置字段。')
        if (pack.readonly.includes(fieldId) || pack.missing.includes(fieldId)) fail('READ_ONLY_FIELD', '字段已移除或只读，不能赋值。')
        if (!Object.hasOwn(input, 'value')) fail('INVALID_INPUT', '必须显式提供 value，null 表示清空。')
        Object.assign(requestPath, { recordId, targetFieldId: fieldId }); body.value = normalizeCell(asObject(pack.fieldMap[fieldId]) as Field, input.value); resources.recordId = recordId; resources.targetFieldId = fieldId
      } else if (action === 'remove') {
        if (pack.permissions.canDeleteRecord !== true) fail('FORBIDDEN', '当前流程和目标表不允许删除记录。')
        body.recordIds = ids(input.recordIds); if (!(body.recordIds as string[]).length || (body.recordIds as string[]).some(key => !pack.recordIds.includes(key))) fail('INVALID_INPUT', '只能删除当前实际可见、无重复的内部记录。')
        resources.recordIds = body.recordIds
      } else body.requireRecord = current.field.isRequired === true
      return { path: requestPath, body }
    }
    prepare(before); await identity(); await checkAccess(ctx, flow, input, session, options.transport)
    const fresh = await read(); if (before.contextVersion !== fresh.contextVersion) throw new RsqError('CONTEXT_CONFLICT', '提交前步骤、权限、目标或数据包变化，未提交修改。', 5, { changedContextKeys: Object.keys(before.contextChecks).filter(key => before.contextChecks[key] !== fresh.contextChecks[key]), mutationSent: false })
    const args = prepare(fresh), receipt = await call('changed', args)
    if (action === 'validate') {
      if (typeof receipt.valid !== 'boolean' || !Array.isArray(receipt.errors)) fail('BUSINESS_ASSERTION_FAILED', '校验接口没有返回结构化结果。')
      return done({ validation: receipt, required: fresh.field.isRequired, targetSynchronizationVerified: false, stepSubmitted: false, automaticallyRetried: false })
    }
    const after = await read(), a = after.pack, b = fresh.pack, body = asObject(args.body)
    if (action === 'add') {
      const expected = [...b.recordIds]; expected.splice(Number(body.index), 0, String(body.recordId))
      if (receipt.recordId !== body.recordId || receipt.index !== body.index || !isDeepStrictEqual(a.recordIds, expected)) fail('BUSINESS_ASSERTION_FAILED', '新增内部记录未通过独立顺序及身份读回。')
      assertUnchanged(b, a)
    } else if (action === 'set') {
      const recordId = String(input.recordId), fieldId = String(input.targetFieldId), value = asObject(asObject(a.map[recordId]).data)[fieldId] ?? null
      if (receipt.recordId !== recordId || receipt.fieldId !== fieldId || !isDeepStrictEqual(receipt.value ?? null, body.value) || !isDeepStrictEqual(value, body.value) || !isDeepStrictEqual(a.recordIds, b.recordIds)) fail('BUSINESS_ASSERTION_FAILED', '单元格未通过独立 HTTP 数据包读回。')
      assertUnchanged(b, a, recordId, fieldId)
    } else {
      const removed = body.recordIds as string[]
      if (!isDeepStrictEqual(ids(receipt.recordIds).sort(), [...removed].sort()) || !isDeepStrictEqual(a.recordIds, b.recordIds.filter(key => !removed.includes(key)))) fail('BUSINESS_ASSERTION_FAILED', '移除的内部记录未通过独立数据包读回。')
      assertUnchanged(b, a, undefined, undefined, removed)
    }
    return done({ contextVersion: after.contextVersion, target: a.target, recordIds: a.recordIds, ...(action === 'set' && { recordId: input.recordId, targetFieldId: input.targetFieldId, value: body.value }), proof: { independentlyReadBack: true, scope: 'workflow-draft', targetSynchronizationVerified: false, sourceRecordsDeleted: false, stepSubmitted: false }, automaticallyRetried: false })
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', error instanceof Error ? error.message : '流程数据表操作失败。', 5)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...asObject(cause.details), failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown' : written ? 'accepted-needs-verification' : 'business-mutation-not-sent; pack-may-have-created-draft', automaticallyRetried: false })
  }
}
