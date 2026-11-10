import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { replayRelationContext } from './replay.js'
import { companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'
const fail = (message: string, code = 'BUSINESS_ASSERTION_FAILED'): never => { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : code === 'INVALID_INPUT' ? 2 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('缺少有效的业务 ID。', 'CONTEXT_MISSING')
const taskId = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : fail('服务未返回可精确识别的任务 ID。', 'CONTEXT_MISSING')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('服务未返回完整列表。', 'CONTEXT_MISSING')
function tasks(value: unknown) {
  const seen = new Set<string>()
  return rows(value).map(row => { const key = taskId(row.id); if (seen.has(key)) fail('重复的复盘原生任务 ID。', 'CONTEXT_MISSING'); seen.add(key); return row })
}
function context(input: JsonObject, results: JsonObject, session: Session | null, writable: boolean) {
  const original = replayRelationContext(input, results, session, writable, 'createTask')
  const current = results.preflight === undefined ? original : replayRelationContext(input, { ...results, report: results.preflight }, session, writable, 'createTask')
  if (current.componentId !== original.componentId || current.report.status !== original.report.status || !isDeepStrictEqual(current.component, original.component)) fail('复盘状态或任务组件已变化。', 'CONTEXT_CONFLICT')
  return current
}
function choices(results: JsonObject) {
  const templates = rows(results.templates), users = companyDirectoryUsers(results.directory)
  if (new Set(templates.map(template => id(template.id))).size !== templates.length) fail('可创建任务类型重复。', 'CONTEXT_MISSING')
  return { templates, users }
}
export function prepareReplayCreatedTasks(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject {
  const current = context(input, results, session, kind === 'replay-created-tasks-create')
  results.prepared = { ...asObject(results.prepared), resources: { ...asObject(asObject(results.prepared).resources), replayId: id(current.report.id), replayComponentId: current.componentId } }
  if (kind === 'replay-created-tasks-list' || kind === 'replay-created-tasks-preflight-list') return { query: { id: current.componentId } }
  if (kind === 'replay-created-tasks-create') {
    if (!isDeepStrictEqual(tasks(results.before), tasks(results.preflightTasks))) fail('关联任务在写入前已变化，停止创建。', 'CONTEXT_CONFLICT')
    const { templates, users } = choices(results), chosen = input.taskTemplateId == null ? templates.filter(row => row.isDefault === true) : templates.filter(row => id(row.id) === input.taskTemplateId)
    if (chosen.length !== 1 || chosen[0]!.isMilepost === true) fail('必须选择当前可创建的普通任务类型，默认类型须唯一；里程碑有独立业务。', 'INVALID_INPUT')
    const members = input.memberIds == null ? [id(requireSession(session).identity.userId)] : input.memberIds as string[]
    if ([...members, ...(input.responsibilityId == null ? [] : [id(input.responsibilityId)])].some(member => !users.some(user => id(user.id) === member))) fail('执行人和负责人必须属于当前公司。', 'FORBIDDEN')
    const name = String(input.name)
    if (!name.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(name)) fail('任务名称不能为空或含控制字符。', 'INVALID_INPUT')
    const period = Object.fromEntries(['year', 'month', 'week', 'day'].filter(key => current.report[key] != null).map(key => [key, current.report[key]]))
    results.nativeExpected = { name, members, taskTemplateId: id(chosen[0]!.id), ...(input.responsibilityId != null && { responsibilityId: input.responsibilityId }) }
    return { body: { replayCollectId: id(current.collection.id), replayCollectTemplateComponentId: input.componentId, ...period, name, memberIds: members.join(','), taskTemplateId: id(chosen[0]!.id), ...(input.responsibilityId != null && { responsibilityId: input.responsibilityId }) } }
  }
  const created = asObject(results.changed), createdId = taskId(created.id)
  results.prepared = { ...asObject(results.prepared), resources: { ...asObject(asObject(results.prepared).resources), taskId: createdId } }
  if (tasks(results.before).some(row => row.id === createdId)) fail('创建响应重用了已有任务 ID；请读回核对，不重放。')
  if (kind === 'replay-created-tasks-readback') return { query: { id: current.componentId } }
  if (kind === 'replay-created-tasks-task') return { query: { id: createdId, module: 'common', siteId: 'common' } }
  return fail('未知复盘原生任务适配。', 'INVALID_CONTRACT')
}
export function describeReplayCreatedTasks(input: JsonObject, results: JsonObject, session: Session | null) {
  const current = context(input, results, session, false), after = tasks(results.verified ?? results.before), available = choices(results), expected = asObject(results.nativeExpected)
  if (results.changed !== undefined) {
    const before = tasks(results.before), created = asObject(results.changed), actual = after.find(row => row.id === created.id), source = asObject(results.verifiedTask)
    if (!actual || after.length !== before.length + 1 || before.some(row => !isDeepStrictEqual(after.find(item => item.id === row.id), row)) || actual.name !== expected.name) fail('新任务未能从独立组件列表核对，或已有任务被改变。')
    const members = rows(actual!.members).map(user => id(user.id)).sort()
    if (!isDeepStrictEqual(members, [...expected.members as string[]].sort())) fail('实际关联任务执行人与请求不同。')
    if (source.id !== created.id || source.name !== expected.name || source.isDisplay === false || id(asObject(source.taskTemplate).id) !== expected.taskTemplateId) fail('Task HTTP 未能独立核对新任务及任务类型。')
    if (expected.responsibilityId != null && id(source.responsibilityId) !== expected.responsibilityId) fail('实际任务负责人未读回一致。')
  }
  return { replayId: id(current.report.id), replayComponentId: current.componentId, templateComponentId: input.componentId, tasks: after, taskTemplates: available.templates, members: available.users.map(user => ({ id: id(user.id), name: user.showName })),
    ...(results.changed !== undefined && { createdTaskId: taskId(asObject(results.changed).id) }), taskPolicy: 'creates an actual task with replay association; later task changes and deletion use task business commands; not an imported snapshot' }
}
