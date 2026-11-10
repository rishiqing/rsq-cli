import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { checkAccess } from './access.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, sessionOrigin, type Session } from './session.js'
import { taskLabels } from './task-personal-labels.js'
import { verifyTaskBusiness } from './task-business.js'
import type { Workflow } from './workflows.js'

export type TaskTypeTarget = 'project' | 'project-template' | 'actual'
export type TaskTypeAction = 'inspect' | 'apply'
type Route = readonly [string, string, string]
const fail = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '任务类型上下文缺少精确资源 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('CONTEXT_MISSING', '任务类型上下文缺少完整列表。')
const people = (value: unknown) => rows(value).map(row => id(row.id)).sort()
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(asObject(value)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const version = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
function fileContext(raw: unknown, allowedOrigin?: string) {
  const file = structuredClone(asObject(raw))
  if ((typeof file.id !== 'string' || !/^[1-9][0-9]*$/.test(file.id)) && (typeof file.id !== 'number' || !Number.isSafeInteger(file.id) || file.id <= 0)) return file
  if (typeof file.realPath !== 'string' || !allowedOrigin) return file
  try {
    const url = new URL(file.realPath)
    if (url.protocol === 'https:' && url.origin === allowedOrigin && url.pathname === '/task/v1/folder/file/url' && [...url.searchParams.keys()].length === 1 && url.searchParams.get('signature')) { url.searchParams.delete('signature'); file.realPath = url.href }
  } catch { /* Unknown paths remain part of the context. */ }
  return file
}
/** FileVO signs realPath on each read. Keep the file identity and all metadata;
 * exclude only that same-service download endpoint's transient signature. */
export function taskTypeDefinitionContext(definition: JsonObject, allowedOrigin: string): JsonObject {
  const result = structuredClone(definition)
  const visit = (field: JsonObject) => {
    for (const key of ['defaultFileList', 'sampleTemplateList']) if (Array.isArray(field[key])) field[key] = (field[key] as unknown[]).map(file => fileContext(file, allowedOrigin))
    if (Array.isArray(field.tables)) for (const child of field.tables) visit(asObject(child))
  }
  if (Array.isArray(result.fields)) for (const field of result.fields) visit(asObject(field))
  return result
}
const stableKeys = ['id', 'name', 'note', 'priorityV2', 'progress', 'isDone', 'isClose', 'cardId', 'taskId', 'hasSubTask', 'subTaskNum', 'rrule', 'alert', 'isOpenToMember']
export function taskTypeTaskSnapshot(task: JsonObject): JsonObject {
  return { ...Object.fromEntries(stableKeys.map(key => [key, task[key] ?? null])), from: { projectId: asObject(task.from).projectId, planId: asObject(task.from).planId }, templateId: id(asObject(task.taskTemplate).id), members: people(task.members), participants: people(task.participants), responsibilityId: task.responsibilityId == null ? null : id(task.responsibilityId), labels: taskLabels(task.labelList).map(row => ({ id: id(row.id), type: row.type })).sort((a, b) => canonical(a).localeCompare(canonical(b))), realStartDate: task.realStartDate ?? null, realEndDate: task.realEndDate ?? null }
}
// TaskDate.getTaskEndDate is interpreted by the Java service in Asia/Shanghai.
function serverDay(value: unknown): string {
  if (typeof value !== 'string') return fail('CONTEXT_MISSING', '里程碑转换缺少可确定的原结束日期。')
  const literal = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d\d:\d\d(?::\d\d)?)?$/.exec(value)
  const day = literal ? literal[1] : Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : ''
  if (!day || !Number.isFinite(Date.parse(day + 'T00:00:00Z')) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) return fail('CONTEXT_MISSING', '原任务日期格式未知，不能猜测里程碑日期。')
  return day
}
/** The update path uses findSimple, whose converter receives no creation defaults. */
export function taskTypeTransitionPlan(task: JsonObject, definition: JsonObject, beforeFields: JsonObject = {}): JsonObject {
  const before = taskTypeTaskSnapshot(task), targetId = id(definition.id), expected = structuredClone(before), applied: string[] = []
  const noOp = before.templateId === targetId
  if (!noOp) {
    expected.templateId = targetId
    if ((before.realStartDate != null || before.realEndDate != null) && definition.isMilepost === true) {
      const day = serverDay(before.realEndDate ?? before.realStartDate)
      expected.realStartDate = day; expected.realEndDate = day; applied.push('milestone-date')
    }
  }
  const oldFields = rows(beforeFields.templateFields ?? []), newFields = rows(definition.fields ?? [])
  return { noOp, expected, appliedDefaults: applied, creationDefaultsApplied: false, defaultLoading: 'findSimple-without-creation-default-values', preserved: ['members', 'participants', 'principal', 'labels', 'name', 'note', 'priority', 'progress', 'completion', 'position', 'child-count', 'reminders', 'repeat'], fieldLifecycle: {
    clearOldFromProjectFieldIds: noOp ? [] : oldFields.filter(field => Number(field.type) === 10).map(field => id(field.id)),
    closeOldAuditFieldIds: noOp ? [] : oldFields.filter(field => Number(field.type) === 31).map(field => id(field.id)),
    initializeOrRestartTargetAuditFieldIds: noOp ? [] : newFields.filter(field => Number(field.type) === 31).map(field => id(field.id)),
    mayInitializeTargetFieldIds: noOp ? [] : newFields.map(field => id(field.id)),
    asynchronous: !noOp, specificFieldLifecycleVerified: false,
  }, hiddenOldFieldValues: 'requires-business-specific-verification; leaving-old-definition-is-not-a-delete-receipt', automaticallyRetried: false }
}
const fieldValues = (value: unknown, allowedOrigin?: string) => rows(asObject(value).templateFields).filter(field => field.isHidden !== true && ![10, 16, 24, 25, 26, 27, 31, 34, 35].includes(Number(field.type))).map(field => ({ id: id(field.id), type: field.type, ...Object.fromEntries(['value', 'list', 'hours', 'files', 'tableRows', 'date', 'time'].map(key => [key, key === 'files' && Array.isArray(field.files) ? field.files.map(file => fileContext(file, allowedOrigin)) : field[key] ?? null])) }))
export function verifyTaskTypeTransition(before: JsonObject, after: JsonObject, definition: JsonObject, beforeFields: unknown, afterFields: unknown, plan: JsonObject, allowedOrigin?: string) {
  const expected = asObject(plan.expected), actual = taskTypeTaskSnapshot(after)
  for (const key of Object.keys(expected)) if (!['realStartDate', 'realEndDate'].includes(key) && !isDeepStrictEqual(actual[key], expected[key])) fail('BUSINESS_ASSERTION_FAILED', '类型切换后的任务内容或关联不一致：' + key)
  verifyTaskBusiness({}, { taskBusiness: { expected: { realStartDate: expected.realStartDate, realEndDate: expected.realEndDate } }, after }, 'after')
  if (asObject(after.taskTemplate).isMilepost !== definition.isMilepost) fail('BUSINESS_ASSERTION_FAILED', '任务类型的里程碑语义未通过独立核对。')
  const fields = rows(asObject(afterFields).templateFields), declared = rows(definition.fields)
  if (id(asObject(asObject(afterFields).taskTemplate).id) !== id(definition.id) || !isDeepStrictEqual(fields.map(field => id(field.id)).sort(), declared.map(field => id(field.id)).sort())) fail('BUSINESS_ASSERTION_FAILED', '当前字段包与目标类型的完整字段定义不一致。')
  const shared: string[] = []
  for (const field of fieldValues(beforeFields, allowedOrigin)) {
    const actual = fieldValues(afterFields, allowedOrigin).find(row => row.id === field.id)
    if (actual) { if (!isDeepStrictEqual(field, actual)) fail('BUSINESS_ASSERTION_FAILED', '共享可见字段的已填内容在类型切换后改变。'); shared.push(String(field.id)) }
  }
  return { sourceTemplateId: id(asObject(before.taskTemplate).id), targetTemplateId: id(definition.id), sharedVisibleFieldIdsPreserved: shared, activeFieldIds: fields.map(field => id(field.id)), previousFieldIdsNoLongerVisible: rows(asObject(beforeFields).templateFields).filter(field => !fields.some(actual => id(actual.id) === id(field.id))).map(field => id(field.id)), oldFieldStorageVerified: false, independentlyReadBack: true }
}
export function taskTypeTransitionSteps(action: TaskTypeAction): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['project', 'GET', '/task/v1/kanbanCrud'], ['cover', 'GET', '/task/v4/template'], ['task', 'GET', '/task/api/v3/task'], ['permissions', 'GET', '/task/api/v3/task/editcontrol'], ['selectable', 'GET', '/task/api/v3/template/listByTask'], ['definition', 'GET', '/task/api/v3/template'], ['fields', 'GET', '/task/api/v3/task/template'], ...(action === 'apply' ? [['changed', 'PUT', '/task/api/v3/task']] as Route[] : [])]
}
export function validateTaskTypeTransitionWorkflow(flow: Workflow) {
  if (flow.executor !== 'task-type-transition' || !['inspect', 'apply'].includes(flow.taskTypeAction ?? '') || !['project', 'project-template', 'actual'].includes(flow.taskTypeTarget ?? '')) fail('INVALID_CONTRACT', '未知任务类型业务目标或步骤。')
  const command = flow.taskTypeTarget === 'actual' ? 'task template apply' : (flow.taskTypeTarget === 'project-template' ? 'project template task type ' : 'project task type ') + flow.taskTypeAction
  if (flow.command !== command || flow.taskTypeTarget === 'actual' && flow.taskTypeAction !== 'apply' || flow.effect !== (flow.taskTypeAction === 'apply' ? 'destructive' : 'write')) fail('INVALID_CONTRACT', '任务类型命令、目标和副作用不一致。')
  const expected = taskTypeTransitionSteps(flow.taskTypeAction!)
  if (flow.steps.length !== expected.length || flow.steps.some((step, index) => { const [name, method, route] = expected[index], op = catalog.operations.find(op => op.id === step.operationId); return step.id !== name || op?.method !== method || op?.route !== route || Object.keys(step.input).length || step.prepare || step.transfer || step.forEach || step.collectPages || step.waitBeforeMs || step.readback || step.expectAbsent || step.assertions || step.resources || step.authentication })) fail('INVALID_CONTRACT', '类型业务只能执行已核对的固定 HTTP 步骤。')
}
export async function runTaskTypeTransition(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { approved?: boolean; transport?: Transport } = {}) {
  validateTaskTypeTransitionWorkflow(flow)
  const session = requireSession(supplied), action = flow.taskTypeAction!, completed: string[] = [], resources = { projectId: input.projectId, taskId: input.taskId, targetTemplateId: input.templateId }
  let phase = 'identity', pending = false, written = false
  const call = async (name: string, args: JsonObject = {}) => {
    phase = name; const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)!
    const transport: Transport = async (url, init) => { if (name === 'changed') pending = true; return (options.transport ?? request)(url, init) }
    const value = await runOperation(ctx, op, args, session, { ...options, transport }); if (name === 'changed') written = true
    pending = false; completed.push(name); return value
  }
  const identity = async () => { const value = asObject(await call('identity')); if (id(value.id) !== session.identity.userId || id(asObject(value.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '任务类型操作身份或公司与当前 profile 不一致。') }
  const where = { module: 'project', siteId: input.projectId }
  const read = async () => {
    const project = asObject(await call('project', { query: { id: input.projectId, isDefault: false } }))
    if (id(project.id) !== input.projectId || !Object.hasOwn(project, 'coverId')) fail('CONTEXT_MISMATCH', '项目未明确普通项目或模板封面归属。')
    const target = project.coverId == null ? 'project' : 'project-template'
    if (flow.taskTypeTarget !== 'actual' && target !== flow.taskTypeTarget) fail('FORBIDDEN', '普通项目和项目模板请分别使用对应任务类型命令。')
    let cover: JsonObject | null = null
    if (target === 'project-template') { cover = asObject(await call('cover', { query: { id: id(project.coverId) } })); if (id(cover.id) !== id(project.coverId) || id(cover.templateKanbanId) !== input.projectId || action === 'apply' && cover.withEdit !== true) fail('FORBIDDEN', '真实模板封面不匹配或没有当前编辑权。') }
    const task = asObject(await call('task', { query: { id: input.taskId, ...where } }))
    if (task.id !== input.taskId || id(asObject(task.from).projectId) !== input.projectId) fail('CONTEXT_MISMATCH', '目标任务不属于明确项目。')
    const permissions = asObject(await call('permissions', { query: { taskId: input.taskId, ...where } }))
    if (permissions.taskId !== input.taskId || permissions.module !== 'project' || String(permissions.siteId) !== input.projectId) fail('CONTEXT_MISMATCH', '任务类型操作权限未绑定实际资源。')
    const selectable = rows(await call('selectable', { query: { id: input.taskId, realKanbanId: input.projectId } })), selected = selectable.find(row => id(row.id) === input.templateId)
    if (!selected || selected.isStop === true) fail('INVALID_INPUT', '目标类型不在当前任务实际可选列表中。')
    const definition = asObject(await call('definition', { query: { id: input.templateId } }))
    if (id(definition.id) !== input.templateId || !Array.isArray(definition.fields) || typeof definition.isMilepost !== 'boolean') fail('CONTEXT_MISMATCH', '目标类型完整定义与选择不一致。')
    const fields = await call('fields', { query: { taskId: input.taskId, ...where } })
    if (id(asObject(asObject(fields).taskTemplate).id) !== id(asObject(task.taskTemplate).id)) fail('CONTEXT_CONFLICT', '任务详情与字段包类型已变化。')
    rows(asObject(fields).templateFields)
    const plan = taskTypeTransitionPlan(task, definition, asObject(fields))
    const canApply = task.forbidEdit !== true && asObject(permissions.editControl).modifyTaskType === true && (cover == null || cover.withEdit === true)
    const contextParts: JsonObject = { target, project: { id: project.id, coverId: project.coverId }, cover: cover && { id: cover.id, templateKanbanId: cover.templateKanbanId, withEdit: cover.withEdit }, task: taskTypeTaskSnapshot(task), permissions, selectable, definition: taskTypeDefinitionContext(definition, sessionOrigin(ctx, session.method)), fields: fieldValues(fields, sessionOrigin(ctx, session.method)) }
    return { target, project: { id: project.id, coverId: project.coverId }, cover: contextParts.cover, task, permissions, selectable, definition, fields, plan, canApply, contextParts, contextVersion: version(contextParts) }
  }
  try {
    await identity()
    const before = await read()
    if (input.contextVersion != null && input.contextVersion !== before.contextVersion) fail('CONTEXT_CONFLICT', '任务类型上下文已变化；请重新 inspect。')
    if (action === 'inspect') return { command: flow.command, completedSteps: completed, resources, result: { target: before.target, project: before.project, taskId: input.taskId, currentTemplateId: asObject(before.task.taskTemplate).id, targetTemplateId: input.templateId, contextVersion: before.contextVersion, canApply: before.canApply, plan: before.plan, targetFields: rows(before.definition.fields).map(field => ({ id: field.id, name: field.name, type: field.type, isHidden: field.isHidden === true })), concurrency: 'fresh-preflight-and-readback; no-server-atomic-cas' } }
    if (!before.canApply) fail('FORBIDDEN', '当前任务或模板没有切换类型的实际权限。')
    await identity(); await checkAccess(ctx, flow, input, session, options.transport)
    const fresh = await read()
    if (!fresh.canApply || before.contextVersion !== fresh.contextVersion) {
      const changedContextPaths: string[] = []
      const compare = (a: unknown, b: unknown, path: string) => {
        if (version(a) === version(b)) return
        if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) a.forEach((value, index) => compare(value, b[index], path + '/' + index))
        else if (a && b && !Array.isArray(a) && !Array.isArray(b) && typeof a === 'object' && typeof b === 'object') for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(asObject(a)[key], asObject(b)[key], path + '/' + key)
        else changedContextPaths.push(path)
      }
      compare(before.contextParts, fresh.contextParts, '')
      throw new RsqError('CONTEXT_CONFLICT', '提交前任务、权限、默认值或字段上下文发生变化；未切换类型。', 5, { changedContextPaths, beforeVersion: before.contextVersion, currentVersion: fresh.contextVersion, writeSent: false })
    }
    if (fresh.plan.noOp !== true) await call('changed', { body: { id: input.taskId, taskTemplateId: input.templateId, ...where } })
    const actual = asObject(await call('task', { query: { id: input.taskId, ...where } })), fields = await call('fields', { query: { taskId: input.taskId, ...where } })
    const proof = verifyTaskTypeTransition(fresh.task, actual, fresh.definition, fresh.fields, fields, fresh.plan, sessionOrigin(ctx, session.method))
    return { command: flow.command, completedSteps: completed, resources, result: flow.command === 'task template apply' ? actual : { target: fresh.target, task: actual, plan: fresh.plan, proof, noOp: fresh.plan.noOp, concurrency: 'fresh-preflight-and-readback; no-server-atomic-cas', automaticallyRetried: false } }
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', error instanceof Error ? error.message : '任务类型切换失败。', 5)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...asObject(cause.details), failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown' : written ? 'accepted-needs-verification' : 'not-sent', automaticallyRetried: false })
  }
}
