import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { checkAccess } from './access.js'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'
export const docGroupActions = ['groups-list', 'group-create', 'group-rename', 'group-move', 'group-remove'] as const
export type DocGroupAction = typeof docGroupActions[number]
type Route = [string, string, string]
const base = '/task/v1/corpusGroup', spacesRoute = '/task/v1/corpus/list'
const fail = (message: string, code = 'CONTEXT_MISSING', details?: JsonObject): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'RESOURCE_FORBIDDEN' ? 4 : 5, details) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('文集分组上下文缺少精确资源 ID。')
const array = (value: unknown) => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('文集分组上下文不是有界完整数组。', 'CONTEXT_LIMIT')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const name = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value) ? value : fail('分组名称须为1–80个 UTF-16 长度单位的非空文本，不能包含控制字符。', 'INVALID_INPUT')
function groups(value: unknown) {
 const seen = new Set<string>(), real: JsonObject[] = [], virtual: JsonObject[] = []
 for (const row of array(value)) {
  const key = row.id === 'all' || row.id === 'star' ? row.id : id(row.id)
  if (seen.has(key) || typeof row.name !== 'string' || !Number.isFinite(row.displayOrder) || typeof row.checked !== 'boolean' || row.corpusCount !== null && (!Number.isSafeInteger(row.corpusCount) || Number(row.corpusCount) < 0)) fail('分组目录存在重复 ID、错误顺序或缺少实际计数。')
  seen.add(key); (key === 'all' || key === 'star' ? virtual : real).push({ id: key, name: row.name, displayOrder: row.displayOrder, corpusCount: row.corpusCount })
 }
 real.sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder))
 if (real.some((row, index) => index && row.displayOrder === real[index - 1].displayOrder)) fail('当前分组顺序存在并列值，请刷新上下文后再试。', 'CONTEXT_CONFLICT')
 return { real, virtual }
}
function spaces(value: unknown) {
 const seen = new Set<string>()
 return array(value).map(row => {
  const key = id(row.id), groupId = row.corpusGroupId == null ? null : id(row.corpusGroupId)
  if (seen.has(key) || typeof row.type !== 'string' || typeof row.name !== 'string') fail('可见文集列表存在重复或缺少类型/名称。')
  seen.add(key); return { id: key, name: row.name, type: row.type, groupId }
 }).sort((a, b) => a.id.localeCompare(b.id))
}
export function docGroupSteps(action: DocGroupAction): Route[] {
 const before: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['company', 'GET', '/task/authority/v3/authorities/company/current'], ['groups', 'GET', base + '/list'], ['spaces', 'GET', spacesRoute]]
 if (action === 'groups-list') return before
 return [...before, ['preflightIdentity', 'GET', '/task/login/authAjax'], ['preflightCompany', 'GET', '/task/authority/v3/authorities/company/current'], ['preflightGroups', 'GET', base + '/list'], ['preflightSpaces', 'GET', spacesRoute], ['changed', action === 'group-create' ? 'POST' : action === 'group-remove' ? 'DELETE' : 'PUT', base + (action === 'group-create' ? '' : action === 'group-move' ? '/sort' : '/{id}')], ['verifiedGroups', 'GET', base + '/list'], ['verifiedSpaces', 'GET', spacesRoute]]
}
export async function runDocGroups(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
 const session = requireSession(supplied), action = flow.docAction as DocGroupAction, completed: string[] = [], resources: JsonObject = { companyId: session.identity.teamId }
 let phase = 'identity', pending = false, changed = false, writeUnknown = false
 const call = async (stepId: string, args: JsonObject = {}) => {
  const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === stepId)?.operationId) ?? fail('未声明文集分组 HTTP 步骤。', 'INVALID_CONTRACT')
  phase = stepId; pending = false
  const transport: Transport = async (url, init) => {
   pending = op.effect !== 'read'
   if (stepId === 'changed') writeUnknown = true
   const response = await (options.transport ?? request)(url, init)
   if (stepId === 'changed' && response.ok) {
    changed = true
    if (action === 'group-create') try { const receipt = asObject(parseJson(await response.clone().text())); if (receipt.id != null) resources.groupId = id(receipt.id) } catch {}
   }
   return response
  }
  const result = await runOperation(ctx, op!, args, session, { ...options, transport }); pending = false
  if (stepId === 'changed') { changed = true; writeUnknown = false; if (action === 'group-create') resources.groupId = id(asObject(result).id) }
  completed.push(stepId); return result
 }
 const identity = (value: unknown) => { const row = asObject(value); if (id(row.id) !== session.identity.userId || id(asObject(row.team).id) !== session.identity.teamId) fail('服务端用户或公司与当前 profile 不符。', 'IDENTITY_CHANGED') }
 const permission = (value: unknown, write: boolean) => { const row = asObject(value); if (row.useCorpus !== true || write && row.editCorpusGroup !== true) fail(write ? '当前公司不允许维护文集分组。' : '当前公司不允许使用知识库。', 'RESOURCE_FORBIDDEN') }
 const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources, result })
 try {
  if (action !== 'groups-list' && input.companyId !== session.identity.teamId) fail('文集分组是公司级配置，必须明确指定当前 companyId。', 'INVALID_INPUT')
  if (['group-create', 'group-rename'].includes(action)) name(input.name)
  identity(await call('identity')); permission(await call('company'), action !== 'groups-list')
  const before = groups(await call('groups')), visible = spaces(await call('spaces')), snapshot = { groups: before.real, visibleSpaces: visible }, contextVersion = hash(snapshot)
  if (input.expectedVersion != null && input.expectedVersion !== contextVersion) fail('分组或可见文集已变化，请重新发现上下文。', 'CONTEXT_CONFLICT')
  const scope = { companyId: session.identity.teamId, contextVersion, scope: 'current-company-groups-and-current-identity-visible-spaces', hiddenSpacesIndependentlyVerified: false }
  if (action === 'groups-list') return done({ ...scope, groups: before.real, virtualGroups: before.virtual, visibleSpaces: visible, selectedGroupNotChangedExplicitly: true })
  const selected = action === 'group-create' ? undefined : before.real.find(row => row.id === input.groupId)
  if (action !== 'group-create' && !selected) fail('分组必须从当前公司实际数字分组中发现；all/star 不能修改。', 'RESOURCE_FORBIDDEN')
  if (selected) resources.groupId = selected.id
  if (action === 'group-remove' && input.expectedName !== selected!.name) fail('删除分组前名称与实际分组不符。', 'GROUP_NAME_MISMATCH')
  const oldOrder = before.real.map(row => String(row.id)), expectedOrder = oldOrder.filter(key => key !== selected?.id)
  let frontId: string | null = null, nextId: string | null = null
  if (action === 'group-move') {
   if (Number(input.placement != null) + Number(input.beforeId != null) + Number(input.afterId != null) !== 1 || input.placement != null && !['first', 'last'].includes(String(input.placement))) fail('排序须明确指定 first、last、beforeId 或 afterId 中的一项。', 'INVALID_INPUT')
   let index = input.placement === 'first' ? 0 : expectedOrder.length
   if (input.beforeId != null || input.afterId != null) {
    const neighbour = id(input.beforeId ?? input.afterId), found = expectedOrder.indexOf(neighbour)
    if (found < 0) fail('排序参照分组必须是当前公司其他实际分组。', 'INVALID_INPUT')
    index = found + (input.afterId != null ? 1 : 0)
   }
   frontId = expectedOrder[index - 1] ?? null; nextId = expectedOrder[index] ?? null; expectedOrder.splice(index, 0, String(selected!.id))
  }
  phase = 'preflightAccess'; await checkAccess(ctx, flow, input, session, options.transport)
  identity(await call('preflightIdentity')); permission(await call('preflightCompany'), true)
  const fresh = groups(await call('preflightGroups')), freshSpaces = spaces(await call('preflightSpaces'))
  if (!isDeepStrictEqual({ groups: fresh.real, visibleSpaces: freshSpaces }, snapshot)) fail('分组、权限或文集归属在写入前已变化。', 'CONTEXT_CONFLICT')
  if (action === 'group-move' && isDeepStrictEqual(oldOrder, expectedOrder) || action === 'group-rename' && selected!.name === input.name) return done({ ...scope, groups: fresh.real, changed: false, verified: true })
  const receipt = await call('changed', action === 'group-create' ? { body: { name: input.name } } : action === 'group-move' ? { body: { moveId: input.groupId, frontId, nextId } } : { path: { id: input.groupId }, ...(action === 'group-rename' && { body: { name: input.name } }) })
  const after = groups(await call('verifiedGroups')), afterSpaces = spaces(await call('verifiedSpaces')), targetId = String(resources.groupId), target = after.real.find(row => row.id === targetId)
  const sameOtherGroups = isDeepStrictEqual(before.real.filter(row => row.id !== targetId).map(row => ({ id: row.id, name: row.name, corpusCount: row.corpusCount })).sort((a,b) => String(a.id).localeCompare(String(b.id))), after.real.filter(row => row.id !== targetId).map(row => ({ id: row.id, name: row.name, corpusCount: row.corpusCount })).sort((a,b) => String(a.id).localeCompare(String(b.id))))
  if (!sameOtherGroups) fail('独立读回时无关分组丢失或名称/计数变化。', 'BUSINESS_ASSERTION_FAILED')
  const expectedSpaces = visible.map(row => action === 'group-remove' && row.groupId === targetId ? { ...row, groupId: null } : row)
  if (!isDeepStrictEqual(expectedSpaces, afterSpaces)) fail('文集被删除、改名或发生非预期分组归属变化。', 'BUSINESS_ASSERTION_FAILED')
  if (action === 'group-create') {
   if (oldOrder.includes(targetId) || !target || target.name !== input.name || !isDeepStrictEqual(after.real.map(row => String(row.id)), [...oldOrder, targetId]) || id(asObject(receipt).id) !== targetId) fail('创建回执与独立公司分组目录不一致。', 'BUSINESS_ASSERTION_FAILED')
  } else if (action === 'group-remove') {
   if (target || !isDeepStrictEqual(after.real.map(row => String(row.id)), expectedOrder)) fail('分组仍存在或无关分组顺序变化。', 'BUSINESS_ASSERTION_FAILED')
  } else if (action === 'group-rename') {
   if (!target || target.name !== input.name || !isDeepStrictEqual(after.real.map(row => String(row.id)), oldOrder) || id(asObject(receipt).id) !== targetId) fail('重命名回执与独立分组目录不一致。', 'BUSINESS_ASSERTION_FAILED')
  } else if (!target || !Number.isFinite(asObject(receipt).displayOrder) || !isDeepStrictEqual(after.real.map(row => String(row.id)), expectedOrder)) fail('排序回执或独立分组相对顺序不一致。', 'BUSINESS_ASSERTION_FAILED')
  return done({ ...scope, contextVersion: hash({ groups: after.real, visibleSpaces: afterSpaces }), groups: after.real, group: target ?? { id: targetId, name: selected!.name, removed: true }, changed: true, verified: true, ...(action === 'group-remove' && { affectedScope: 'all-company-spaces-in-group-moved-to-ungrouped', verifiedVisibleSpaceIds: visible.filter(row => row.groupId === targetId).map(row => row.id), spacesDeleted: false }), concurrency: 'fresh-observation-without-server-cas' })
 } catch (cause) {
  const error = cause instanceof RsqError ? cause : new RsqError('HTTP_ERROR', cause instanceof Error ? cause.message : String(cause), 5)
  throw new RsqError(error.code, error.message, error.exit, { ...error.details, failedStep: phase, completedSteps: completed, resources, groupWriteCompleted: changed, writeOutcome: writeUnknown ? 'unknown-not-replayed' : changed ? 'completed-readback-may-have-failed' : pending ? 'context-read-may-have-side-effects' : 'not-sent', autoReplay: false })
 }
}
