import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { checkAccess } from './access.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'

export type WorkflowTaskAction = 'inspect' | 'create' | 'create-batch' | 'change' | 'remove' | 'reorder'
type Route = readonly [string, string, string]
const base = '/task/workflow/process/info'
const actions: WorkflowTaskAction[] = ['inspect', 'create', 'create-batch', 'change', 'remove', 'reorder']
const fail = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '流程任务字段缺少精确资源编号。')
const taskKey = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '流程任务缺少实际 Task3 UUID 或历史任务编号。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 1000 ? value.map(asObject) : fail('CONTEXT_INCOMPLETE', '流程任务列表缺失或超过1000项，未将截断数据当成完整上下文。')
const data = (value: unknown): unknown => value && typeof value === 'object' && Object.hasOwn(value, 'data') ? asObject(value).data : value
const ids = (items: JsonObject[]) => { const values = items.map(item => taskKey(item.id)); if (new Set(values).size !== values.length) fail('CONTEXT_MISMATCH', '同一流程任务字段返回了重复任务编号。'); return values }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(asObject(value)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const version = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export function workflowTaskSteps(action: WorkflowTaskAction, project: boolean): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['process', 'GET', base + '/details'], ['instanceStep', 'GET', base + '/step'], ['instanceForm', 'GET', base + '/step/list/auditsAndForms'], ['application', 'GET', '/task/workflow/application'],
    ...(project ? [['project', 'GET', '/task/v1/kanbanCrud']] as Route[] : []),
    ['stepTasks', 'POST', base + '/sheet/taskList'],
    ...(['change', 'remove', 'create', 'create-batch'].includes(action) ? [['task', 'GET', '/task/api/v3/task']] as Route[] : []),
    ...(action === 'change' ? [['permissions', 'GET', '/task/api/v3/task/editcontrol'], ['taskValues', 'GET', '/task/api/v3/task/template']] as Route[] : []),
    ...(action === 'inspect' ? [] : [['changed', action === 'remove' ? 'DELETE' : ['change', 'reorder'].includes(action) ? 'PUT' : 'POST', action === 'create-batch' ? base + '/form/task/batch' : action === 'create' ? base + '/form/task' : action === 'reorder' ? base + '/form' : '/task/api/v3/task']] as Route[]),
    ...(action === 'remove' ? [['recycle', 'GET', '/task/v1/recycleBin/list']] as Route[] : [])]
}
export function validateWorkflowTaskWorkflow(flow: Workflow) {
  const action = flow.workflowTaskAction
  if (flow.executor !== 'workflow-tasks' || !action || !actions.includes(action) || typeof flow.workflowTaskProject !== 'boolean'
    || flow.command !== (flow.workflowTaskProject ? 'project ' : '') + 'workflow instance task ' + action
    || flow.effect !== (['change', 'remove', 'reorder'].includes(action) ? 'destructive' : 'write')) fail('INVALID_CONTRACT', '流程任务字段命令与动作、副作用不一致。')
  const expected = workflowTaskSteps(action!, flow.workflowTaskProject!)
  if (!['processId', 'stepId', 'fieldId', ...(flow.workflowTaskProject ? ['projectId'] : [])].every(key => flow.inputSchema.required?.includes(key))
    || flow.steps.length !== expected.length || flow.steps.some((step, index) => {
      const [name, method, route] = expected[index], operation = catalog.operations.find(operation => operation.id === step.operationId)
      return step.id !== name || operation?.method !== method || operation.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.transfer || step.authentication || step.collectPages || step.waitBeforeMs || step.resources || step.readback || step.expectAbsent || step.assertions || step.creationVisibility
    })) fail('INVALID_CONTRACT', '流程任务字段必须保留已核对的实例、表单、任务权限和独立读回步骤。')
}

export async function runWorkflowTasks(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { approved?: boolean; transport?: Transport } = {}) {
  validateWorkflowTaskWorkflow(flow)
  const session = requireSession(supplied), action = flow.workflowTaskAction!, completed: string[] = [], resources: JsonObject = { processId: input.processId, stepId: input.stepId, fieldId: input.fieldId }
  const where = flow.workflowTaskProject ? { module: 'project', siteId: String(input.projectId) } : { module: 'common', siteId: 'common' }
  let phase = 'identity', mutationSent = false, accepted = false, requestInFlight = false
  const call = async (name: string, args: JsonObject = {}) => {
    phase = name
    const step = flow.steps.find(step => step.id === name)!, operation = catalog.operations.find(operation => operation.id === step.operationId)!
    const transport: Transport = async (url, init) => { if (name === 'changed') { mutationSent = true; requestInFlight = true }; return (options.transport ?? request)(url, init) }
    const response = await runOperation(ctx, operation, args, session, { approved: options.approved, transport })
    if (name === 'changed') { accepted = true; requestInFlight = false }
    completed.push(name); return data(response)
  }
  const identity = async () => {
    const actual = asObject(await call('identity'))
    if (id(actual.id) !== session.identity.userId || id(asObject(actual.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '当前用户或公司与 profile 不一致。')
  }
  const read = async () => {
    const process = asObject(await call('process', { query: { processInfoId: input.processId } })), step = asObject(await call('instanceStep', { query: { stepInfoId: input.stepId } }))
    if (id(process.id) !== input.processId || id(step.id) !== input.stepId || id(step.processInfoId) !== input.processId || id(step.applicationId) !== id(process.flowAppId)
      || !rows(process.processInfoStepList).some(row => id(row.id) === input.stepId)) fail('CONTEXT_MISMATCH', '实际流程实例、应用与步骤归属不一致。')
    const form = asObject(await call('instanceForm', { query: { stepInfoId: input.stepId, isRefresh: false } }))
    if (id(form.formId) !== id(step.formId)) fail('CONTEXT_MISMATCH', '实际步骤表单不一致。')
    const fields = rows(form.fields), selected = fields.filter(field => id(field.id) === input.fieldId)
    if (selected.length !== 1 || Number(selected[0].type) !== 23 || selected[0].isHidden === true) fail('INVALID_INPUT', '请选择当前实例步骤中实际可见的 Task 字段23。')
    const field = selected[0], tasks = rows(field.tasks ?? []), taskIds = ids(tasks), controls = asObject(form.editControl)
    const application = asObject(await call('application', { query: { id: id(process.flowAppId) } }))
    if (id(application.id) !== id(process.flowAppId)) fail('CONTEXT_MISMATCH', '实际流程应用不一致。')
    const subtype = application.workflowModuleSubType
    if (flow.workflowTaskProject) {
      if (!['projectWorkflow', 'alterationWorkflow'].includes(String(subtype)) || id(process.belongToProjectId) !== input.projectId) fail('FORBIDDEN', '请选择实际属于该项目的流程实例。')
      const project = asObject(await call('project', { query: { id: input.projectId, isDefault: false } }))
      if (id(project.id) !== input.projectId || !Object.hasOwn(project, 'coverId') || project.coverId != null) fail('FORBIDDEN', '此命令只接受普通项目中的实例，不接受项目模板。')
      if (subtype === 'alterationWorkflow') await checkAccess(ctx, { ...flow, command: 'project alteration flow inspect' }, input, session, options.transport)
    } else if (subtype != null || process.belongToProjectId != null) fail('FORBIDDEN', '项目流程请使用 project workflow instance task 并指定实际项目。')
    const map = asObject(await call('stepTasks', { body: { idList: [{ processInfoId: input.processId, flowApplicationId: id(process.flowAppId), stepInfoId: id(step.originId) }] } })), key = [id(process.flowAppId), input.processId, id(step.originId)].join('-')
    if (Object.keys(map).length !== 1 || !Object.hasOwn(map, key)) fail('CONTEXT_MISMATCH', '步骤任务查询未返回精确的实际应用/实例/定义步骤键。')
    const observed = rows(map[key])
    if (!isDeepStrictEqual(observed.filter(task => taskIds.includes(taskKey(task.id))).map(task => taskKey(task.id)), taskIds)) fail('CONTEXT_CONFLICT', '表单任务与独立步骤任务列表的编号或顺序不一致，请重新读取。')
    const definition = Object.fromEntries(['id', 'type', 'name', 'isRequired', 'isHidden', 'dataType'].map(key => [key, field[key] ?? null]))
    const otherTasks = fields.filter(other => Number(other.type) === 23 && id(other.id) !== input.fieldId).map(other => ({ fieldId: id(other.id), taskIds: ids(rows(other.tasks ?? [])) }))
    const stable = { applicationId: id(process.flowAppId), projectId: process.belongToProjectId ?? null, processStatus: process.status, processPermissions: process.editControl, step: Object.fromEntries(['id', 'originId', 'processInfoId', 'applicationId', 'formId', 'status', 'type', 'isDisplay', 'editControl'].map(key => [key, step[key] ?? null])), definition, controls, subtype, otherTasks }
    resources.applicationId = id(process.flowAppId); resources.formId = id(form.formId)
    return { field, tasks, taskIds, observed, stable, contextVersion: version({ stable, tasks }), canFill: controls.fillStepForm === true || controls.modifyStepForm === true }
  }
  const readTask = async (taskId: string) => {
    const task = asObject(await call('task', { query: { id: taskId, ...where } }))
    // TaskFromVOConverter maps projectId only from projectFrom. A workflow
    // task uses workflowFrom, including in project workflows, so its projectId
    // may legitimately be null. Bind the native workflow/process/instance step
    // instead; the process has already proved the actual ordinary project.
    const from = asObject(task.from), position = flow.workflowTaskProject ? 'projectWorkflow' : 'workflow'
    if (taskKey(task.id) !== taskId || from.type !== 'workflow' || String(from.workflowId) !== resources.applicationId || String(from.processId) !== input.processId || String(from.stepId) !== input.stepId
      || from.projectId != null && String(from.projectId) !== '0' && String(from.projectId) !== input.projectId || from.taskPosition != null && from.taskPosition !== position) throw new RsqError('CONTEXT_MISMATCH', '真实任务与实际流程应用、实例、步骤或项目归属不一致。', 5, { actualFrom: Object.fromEntries(['type', 'workflowId', 'processId', 'stepId', 'projectId', 'taskPosition'].map(key => [key, from[key] ?? null])) })
    return task
  }
  const done = (result: JsonObject) => ({ command: flow.command, completedSteps: completed, resources, result })
  const assert = (condition: unknown, message: string) => { if (!condition) fail('BUSINESS_ASSERTION_FAILED', message) }
  try {
    await identity(); const before = await read()
    if (input.contextVersion != null && input.contextVersion !== before.contextVersion) fail('CONTEXT_CONFLICT', '流程任务字段已变化，请重新 inspect。')
    if (action === 'inspect') return done({ field: Object.fromEntries(['id', 'type', 'name', 'isRequired', 'dataType'].map(key => [key, before.field[key] ?? null])), tasks: before.tasks, taskIds: before.taskIds, contextVersion: before.contextVersion, canAddOrRemove: before.canFill, proof: { formAndStepTasksReadBack: true } })
    const names = (action === 'create' ? [input.name] : action === 'create-batch' ? input.names : []) as unknown[]
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim() || name.trim() !== name || name.length > 200 || /[\r\n]/.test(name)) || names.length > 100) fail('INVALID_INPUT', '任务名称须为1到200字的单行非空文本，最多一次100条；先去掉首尾空白。')
    if ((action === 'create' || action === 'create-batch') && (!names.length || before.taskIds.length + names.length > 1000)) fail('INVALID_INPUT', '任务批次为空或超出完整性上限。')
    if (action !== 'change' && !before.canFill) fail('FORBIDDEN', '当前表单不能填写或修改，不能增加或移除任务。')
    if (['change', 'remove'].includes(action) && !before.taskIds.includes(String(input.taskId))) fail('INVALID_INPUT', '任务不属于当前实际任务字段。')
    if (action === 'reorder' && (!Array.isArray(input.taskIds) || input.taskIds.length !== before.taskIds.length || !input.taskIds.length || new Set(input.taskIds).size !== input.taskIds.length || input.taskIds.some(key => !before.taskIds.includes(String(key))))) fail('INVALID_INPUT', '排序必须提供当前字段全部实际任务编号，不能添加、遗漏、重复或清空关联。')
    if (action === 'reorder' && before.taskIds.some(key => /^[0-9]+$/.test(key)) && before.taskIds.some(key => !/^[0-9]+$/.test(key))) fail('CONTEXT_INCOMPLETE', '此字段混用了历史数字任务编号与 Task3 UUID；当前服务排序按首项类型转换，无法安全提交混合集合。请先修复服务转换，未发送排序。')
    const task = ['change', 'remove'].includes(action) ? await readTask(taskKey(input.taskId)) : null
    if (task?.forbidEdit === true) fail('FORBIDDEN', '当前真实任务处于禁止编辑状态。')
    let patch: JsonObject = {}, taskFieldVersion: string | undefined
    if (action === 'change') {
      patch = asObject(input.patch)
      const permissions = asObject(await call('permissions', { query: { taskId: input.taskId, ...where } }))
      if (taskKey(permissions.taskId) !== input.taskId || permissions.module !== where.module || String(permissions.siteId) !== where.siteId) fail('CONTEXT_MISMATCH', '任务权限返回的实际任务和场景不一致。')
      const required: Record<string, string> = { name: 'editTaskName', note: 'editTaskNote', isDone: 'finishTask', progress: 'editTaskProgress', priorityV2: 'editTaskPriority' }
      if (!Object.keys(patch).length || Object.keys(patch).some(key => !required[key])) fail('INVALID_INPUT', '请选择 Schema 支持的任务修改属性。')
      if (task!.forbidEdit === true || Object.keys(patch).some(key => asObject(permissions.editControl)[required[key]] !== true)) fail('FORBIDDEN', '任务自身的当前权限不允许此项修改。')
      if (patch.isDone === true) {
        const values = asObject(await call('taskValues', { query: { taskId: input.taskId, ...where } }))
        taskFieldVersion = version(values)
        if (rows(values.templateFields).some(field => field.isRequired === true && field.isHidden !== true && (field.value == null || field.value === '') && !['list', 'hours', 'files', 'tableRows', 'recordList'].some(key => Array.isArray(field[key]) && field[key].length))) fail('INVALID_INPUT', '真实任务仍有未填写的必填字段。')
      }
    }
    await identity(); await checkAccess(ctx, flow, input, session, options.transport)
    if (['create', 'create-batch'].includes(action) && before.field.dataType != null && Number(before.field.dataType) > 0) await checkAccess(ctx, { ...flow, command: 'task template inspect' }, {}, session, options.transport)
    const fresh = await read()
    if (before.contextVersion !== fresh.contextVersion) fail('CONTEXT_CONFLICT', '提交前实例、步骤、权限、字段定义或任务列表变化，未发送业务写入。')
    if (['change', 'remove'].includes(action)) {
      const actual = await readTask(taskKey(input.taskId))
      if (version(actual) !== version(task)) fail('CONTEXT_CONFLICT', '提交前真实任务已变化，未发送写入。')
      if (action === 'change') {
        const permission = asObject(await call('permissions', { query: { taskId: input.taskId, ...where } }))
        const required: Record<string, string> = { name: 'editTaskName', note: 'editTaskNote', isDone: 'finishTask', progress: 'editTaskProgress', priorityV2: 'editTaskPriority' }
        if (taskKey(permission.taskId) !== input.taskId || permission.module !== where.module || String(permission.siteId) !== where.siteId || actual.forbidEdit === true || Object.keys(patch).some(key => asObject(permission.editControl)[required[key]] !== true)) fail('FORBIDDEN', '提交前任务权限变化。')
        if (patch.isDone === true && version(await call('taskValues', { query: { taskId: input.taskId, ...where } })) !== taskFieldVersion) fail('CONTEXT_CONFLICT', '提交前真实任务字段或必填配置变化。')
      }
    }
    const body = action === 'create' ? { stepId: input.stepId, fieldId: input.fieldId, taskName: names[0] } : action === 'create-batch' ? { stepId: input.stepId, fieldId: input.fieldId, tasks: names } : action === 'reorder' ? { stepId: input.stepId, fieldId: input.fieldId, value: (input.taskIds as string[]).join(',') } : { id: input.taskId, ...where, ...patch }
    if (['change', 'remove'].includes(action)) resources.taskIds = [input.taskId]
    if (action === 'reorder') resources.taskIds = input.taskIds
    const receipt = await call('changed', action === 'remove' ? { query: { id: input.taskId, ...where } } : { body })
    const created = action === 'create' ? [asObject(receipt)] : action === 'create-batch' ? rows(receipt) : []
    if (['create', 'create-batch'].includes(action)) resources.taskIds = created.flatMap(task => typeof task.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(task.id) || typeof task.id === 'number' && Number.isSafeInteger(task.id) && task.id > 0 ? [String(task.id)] : [])
    const createdIds = ids(created)
    if (names.length) assert(created.length === names.length && created.every((task, index) => task.name === names[index]) && createdIds.every(taskId => !before.taskIds.includes(taskId)), '创建响应的任务数量、名称、顺序或编号不一致。')
    const after = await read()
    assert(isDeepStrictEqual(before.stable, after.stable), '写后实例、步骤、字段定义、权限或其他任务字段变化，请核对并发操作。')
    const expectedIds = names.length ? [...before.taskIds, ...createdIds] : action === 'remove' ? before.taskIds.filter(taskId => taskId !== input.taskId) : action === 'reorder' ? input.taskIds : before.taskIds
    assert(isDeepStrictEqual(after.taskIds, expectedIds), '独立表单读回的任务编号或顺序与预期不一致。')
    for (const old of before.tasks) if (action !== 'change' || taskKey(old.id) !== input.taskId) {
      if (action === 'remove' && taskKey(old.id) === input.taskId) continue
      assert(isDeepStrictEqual(old, after.tasks.find(task => taskKey(task.id) === taskKey(old.id))), '其他已有任务的内容发生变化。')
    }
    if (names.length) for (let index = 0; index < createdIds.length; index++) {
      const actual = await readTask(createdIds[index])
      assert(actual.name === names[index] && after.tasks.find(task => taskKey(task.id) === createdIds[index])?.name === names[index], '新任务未通过真实任务详情和表单的名称读回。')
    }
    if (action === 'change') {
      const actual = await readTask(taskKey(input.taskId)), summary = after.tasks.find(task => taskKey(task.id) === input.taskId)!
      for (const [key, value] of Object.entries(patch)) {
        assert(isDeepStrictEqual(actual[key], value), '任务修改未通过实际任务详情读回：' + key)
        if (['name', 'isDone'].includes(key)) assert(isDeepStrictEqual(summary[key], value), '任务修改未通过流程表单读回：' + key)
      }
    }
    if (action === 'remove') {
      const recycled = rows(await call('recycle', { query: { type: '1,5', max: 200 } }))
      assert(recycled.some(item => String(item.resourceId) === input.taskId && [1, 5].includes(Number(item.type))), '任务未在独立回收站读取中出现，不能仅凭列表缺失判定删除成功。')
      assert(!after.observed.some(task => taskKey(task.id) === input.taskId), '删除的任务仍出现在步骤任务视图。')
    }
    return done({ action, taskIds: after.taskIds, tasks: after.tasks, changedTaskIds: resources.taskIds, contextVersion: after.contextVersion, proof: { formAndStepTasksReadBack: true, taskDetailsReadBack: !['remove', 'reorder'].includes(action), recycleReadBack: action === 'remove', unrelatedTasksPreserved: true }, automaticallyRetried: false })
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', error instanceof Error ? error.message : '流程任务字段操作失败。', 5)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...asObject(cause.details), failedStep: phase, completedSteps: completed, resources, mutationSent, writeOutcome: requestInFlight ? 'unknown' : accepted ? 'accepted-needs-verification' : 'business-mutation-not-sent; form-may-have-calculated-values-and-application-may-have-updated-preference', automaticallyRetried: false })
  }
}
