import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { checkAccess } from './access.js'
import { taskDatesPatch, taskMembersAllowed, prepareTaskBusiness } from './task-business.js'
import { archiveTarget } from './archive.js'
import { readCopyForest, copySnapshot, copyNodes, verifyCopiedForest } from './project-copy-proof.js'
import { requireSession, type Session } from './session.js'
import { taskLabels } from './task-personal-labels.js'
import type { Workflow } from './workflows.js'

export const projectCardBatchActions = ['inspect', 'copy', 'move', 'members', 'members-add', 'members-remove', 'labels-add', 'labels-remove', 'labels-clear', 'dates', 'priority', 'status', 'archive-completed'] as const
export type ProjectCardBatchAction = typeof projectCardBatchActions[number]
type Route = readonly [string, string, string]
const fail = (code: string, message: string, details?: JsonObject): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5, details) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '卡片上下文缺少精确数字 ID。')
const tid = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : fail('CONTEXT_MISSING', '卡片上下文缺少真实任务 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('CONTEXT_MISSING', '卡片上下文缺少完整列表。')
const people = (value: unknown) => rows(value).map(row => id(row.id)).sort()
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sameDate = (actual: unknown, expected: unknown) => expected == null ? actual == null : String(expected).length === 10 ? actual === expected : Number.isFinite(Date.parse(String(expected))) && Date.parse(String(actual)) === Date.parse(String(expected))
const assert = (value: unknown, message: string): void => { if (!value) fail('BUSINESS_ASSERTION_FAILED', message) }
export function projectCardBatchCommand(action: ProjectCardBatchAction, template: boolean) { const aliases: Partial<Record<ProjectCardBatchAction, string>> = { members: 'members set', 'members-add': 'members add', 'members-remove': 'members remove', 'labels-add': 'labels add', 'labels-remove': 'labels remove', 'labels-clear': 'labels clear', dates: 'dates set', priority: 'priority set', status: 'status set' }; return 'project ' + (template ? 'template ' : '') + 'card tasks ' + (aliases[action] ?? action) }
export const projectCardBatchDestructive = (action: ProjectCardBatchAction) => ['move', 'members', 'members-remove', 'labels-add', 'labels-remove', 'labels-clear', 'dates', 'archive-completed'].includes(action)
export function projectCardBatchSteps(action: ProjectCardBatchAction, template: boolean): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['project', 'GET', '/task/v1/kanbanCrud'], ...(template ? [['cover', 'GET', '/task/v4/template']] as Route[] : []), ['modules', 'GET', '/task/v1/kanbanChildCrud/list'], ['module', 'GET', '/task/v1/kanbanChildCrud'], ['cards', 'GET', '/task/v1/kanbanCardCrud/list'], ['cardPermissions', 'GET', '/task/api/v3/projectTask/cardEditControl'], ['tasks', 'PUT', '/task/api/v3/projectTask/taskList'], ['task', 'GET', '/task/api/v3/task'], ['permissions', 'GET', '/task/api/v3/task/editcontrol'],
    ...(['copy', 'move'].includes(action) ? [['targetProject', 'GET', '/task/v1/kanbanCrud'], ...(template ? [['targetCover', 'GET', '/task/v4/template']] as Route[] : []), ['targetModules', 'GET', '/task/v1/kanbanChildCrud/list'], ['targetModule', 'GET', '/task/v1/kanbanChildCrud'], ['targetCards', 'GET', '/task/v1/kanbanCardCrud/list'], ['targetPermissions', 'GET', '/task/api/v3/projectTask/cardEditControl'], ['targetTasks', 'PUT', '/task/api/v3/projectTask/taskList']] as Route[] : []),
    ...(['members', 'members-add', 'members-remove'].includes(action) ? [['memberScope', 'GET', '/task/authority/v3/scopes/company/current']] as Route[] : []),
    ...(['labels-add', 'labels-remove'].includes(action) ? [['labels', 'GET', '/task/v1/kanbanLabel/list'], ['personalLabels', 'GET', '/task/v1/todoLabel/userLabels']] as Route[] : []),
    ...(action === 'status' ? [['values', 'GET', '/task/api/v3/task/template']] as Route[] : []),
    ...(action === 'archive-completed' ? [['bags', 'GET', '/task/v1/archiveBag/list'], ['archiveItems', 'GET', '/task/v1/archiveFile/list']] as Route[] : []),
    ...(action !== 'inspect' ? [['changed', ['copy', 'archive-completed'].includes(action) ? 'POST' : 'PUT', ['members', 'dates', 'labels-add'].includes(action) ? '/task/api/v3/task' : '/task/api/v3/projectTask/batch' + ({ copy: 'Copy', move: 'Move', priority: 'Update', status: 'Update', 'members-add': 'Update', 'members-remove': 'RemoveMember', 'labels-remove': 'RemoveLabel', 'labels-clear': 'Update', 'archive-completed': 'Archive' } as Partial<Record<ProjectCardBatchAction, string>>)[action]]] as Route[] : []),
    ...(action === 'copy' ? [['copyType', 'GET', '/task/api/v3/template'], ['copyChildren', 'GET', '/task/api/v3/task/subs'], ['copyComments', 'GET', '/task/api/v3/comment/list'], ['copyLabels', 'GET', '/task/v1/kanbanLabel/list']] as Route[] : [])]
}
export function validateProjectCardBatchWorkflow(flow: Workflow) {
  const action = flow.projectCardBatchAction!, template = flow.projectCardBatchTemplate === true
  if (!projectCardBatchActions.includes(action) || template && action === 'archive-completed' || flow.command !== projectCardBatchCommand(action, template) || flow.effect !== (projectCardBatchDestructive(action) ? 'destructive' : 'write') || flow.outputAdapter || Object.keys(asObject(flow.output)).length) fail('INVALID_CONTRACT', '未知卡片批量业务或错误副作用。')
  const expected = projectCardBatchSteps(action, template)
  if (flow.steps.length !== expected.length || flow.steps.some((step, index) => { const [name, method, route] = expected[index], op = catalog.operations.find(op => op.id === step.operationId); return !op || step.id !== name || op.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.collectPages || step.forEach || step.transfer || step.authentication || step.readback || step.waitBeforeMs || step.expectAbsent || step.assertions?.length })) fail('INVALID_CONTRACT', '卡片批量业务只能使用已核对的固定 HTTP 上下文；成员替换、日期和标签追加逐任务提交；其余动作各提交一次批量请求。')
}
function taskSnapshot(task: JsonObject) {
  return Object.fromEntries(['id', 'name', 'note', 'from', 'cardId', 'taskId', 'members', 'participants', 'responsibilityId', 'realStartDate', 'realEndDate', 'priorityV2', 'progress', 'isDone', 'isClose', 'isOpenToMember', 'forbidEdit', 'taskTemplate', 'labelList', 'rrule', 'rruleType', 'rruleContent', 'dateUpdate'].map(key => [key, task[key] ?? null]))
}
function verifyMembers(before: JsonObject, actual: JsonObject, input: JsonObject) {
  const chosen = Object.hasOwn(input, 'memberIds') ? [...input.memberIds as string[]].sort() : people(before.members)
  assert(isDeepStrictEqual(people(actual.members), chosen), '成员替换未独立读回为完整目标集合；未继续其他任务。')
  for (const [option, key] of [['principalId', 'responsibilityId'], ['isOpenToMember', 'isOpenToMember']]) {
    const expected = Object.hasOwn(input, option) ? input[option] : before[key]
    assert(key === 'responsibilityId' ? String(actual[key] ?? '') === String(expected ?? '') : (actual[key] ?? null) === (expected ?? null), '负责人或可见性未按明确补丁保存或保留。')
  }
  for (const key of ['name', 'note', 'from', 'cardId', 'taskId', 'participants', 'realStartDate', 'realEndDate', 'priorityV2', 'progress', 'isDone', 'isClose', 'taskTemplate', 'labelList']) assert(isDeepStrictEqual(actual[key] ?? null, before[key] ?? null), '成员更新意外改变其他任务内容：' + key)
}
function resolvedDates(before: JsonObject, input: JsonObject): JsonObject {
  return { realStartDate: before.realStartDate ?? null, realEndDate: before.realEndDate ?? null, ...taskDatesPatch(asObject(input.dates), before) }
}
function verifyDates(before: JsonObject, actual: JsonObject, input: JsonObject) {
  for (const [key, value] of Object.entries(resolvedDates(before, input))) assert(sameDate(actual[key], value), '日期更新未保存明确端点或未保留省略的一端：' + key)
  for (const [key, value] of Object.entries(taskSnapshot(before))) if (!['realStartDate', 'realEndDate', 'dateUpdate'].includes(key)) assert(isDeepStrictEqual(actual[key] ?? null, value), '日期更新意外改变其他任务内容：' + key)
}
const labelKey = (label: JsonObject) => label.type + ':' + id(label.id)
const labelKeys = (value: unknown) => taskLabels(value ?? []).map(labelKey).sort()
function verifyBatchChange(action: ProjectCardBatchAction, before: JsonObject, actual: JsonObject, input: JsonObject, catalogue: JsonObject[] = []) {
  if (action === 'members-add' || action === 'members-remove') {
    const previous = people(before.members), selected = input.memberIds as string[]
    const chosen = action === 'members-add' ? [...new Set([...previous, ...selected])] : previous.filter(value => !selected.includes(value))
    verifyMembers(before, actual, { memberIds: chosen }); return
  }
  const previous = taskLabels(before.labelList ?? []), selected = ((input.labels ?? []) as JsonObject[]).map(label => catalogue.find(item => labelKey(item) === labelKey(label)) ?? label)
  const chosen = action === 'labels-clear' ? [] : action === 'labels-add' ? [...new Map([...previous, ...selected].map(label => [labelKey(label), label])).values()] : previous.filter(label => !selected.some(item => labelKey(item) === labelKey(label)))
  if (!isDeepStrictEqual(labelKeys(actual.labelList), chosen.map(labelKey).sort())) fail('BUSINESS_ASSERTION_FAILED', '批量标签未按来源及 ID 完整生效；不会重发。', { taskId: before.id, expectedLabels: chosen.map(labelKey).sort(), actualLabels: labelKeys(actual.labelList) })
  for (const [key, value] of Object.entries(taskSnapshot(before))) if (!['labelList', 'dateUpdate'].includes(key)) assert(isDeepStrictEqual(actual[key] ?? null, value), '标签更新意外改变其他任务内容：' + key)
  for (const label of taskLabels(actual.labelList ?? [])) {
    const old = chosen.find(item => labelKey(item) === labelKey(label))
    if (old) assert(isDeepStrictEqual(label, old), '保留标签的来源或元信息发生变化。')
  }
}
function resolvedLabels(before: JsonObject, input: JsonObject): JsonObject {
  const labels = [...new Map([...taskLabels(before.labelList ?? []), ...input.labels as JsonObject[]].map(label => [labelKey(label), label])).values()]
  return { kanbanLabelIds: labels.filter(label => label.type === 'project').map(label => id(label.id)).join(','), todoLabelIds: labels.filter(label => label.type === 'todo').map(label => id(label.id)).join(',') }
}
export async function runProjectCardBatch(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateProjectCardBatchWorkflow(flow)
  const action = flow.projectCardBatchAction!, template = flow.projectCardBatchTemplate === true, session = requireSession(supplied), completed: string[] = [], resources: JsonObject = { projectId: input.projectId, moduleId: input.moduleId, cardId: input.cardId }
  let phase = 'identity', pending = false, written = false
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) return fail('INVALID_CONTRACT', '缺少固定卡片步骤：' + name)
    phase = name; pending = false
    const transport: Transport = async (url, init) => { if (name === 'changed') pending = true; return (options.transport ?? request)(url, init) }
    const value = await runOperation(ctx, op, args, session, { ...options, transport })
    if (name === 'changed') written = true
    pending = false; completed.push(name); return value
  }
  const identity = async () => { const who = asObject(await call('identity')); if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '卡片批量业务身份或公司与当前 profile 不一致。') }
  const legacy = template ? { headers: { 'Plan-Type': 'template' } } : {}
  const source = { projectId: id(input.projectId), moduleId: id(input.moduleId), cardId: id(input.cardId) }
  const target = ['copy', 'move'].includes(action) ? { projectId: id(input.targetProjectId ?? input.projectId), moduleId: id(input.targetModuleId ?? input.moduleId), cardId: id(input.targetCardId) } : null
  const context = async (destination = false) => {
    const where = destination ? target! : source, name = (base: string) => destination ? 'target' + base[0].toUpperCase() + base.slice(1) : base
    const project = asObject(await call(name('project'), { query: { id: where.projectId, isDefault: false }, ...legacy }))
    if (id(project.id) !== where.projectId || !Object.hasOwn(project, 'coverId') || (template ? project.coverId == null : project.coverId !== null)) fail('FORBIDDEN', '普通项目与项目模板目标必须分别使用对应命令。')
    let cover: JsonObject | null = null
    if (template) { cover = asObject(await call(name('cover'), { query: { id: id(project.coverId) } })); if (id(cover.id) !== id(project.coverId) || id(cover.templateKanbanId) !== where.projectId || action !== 'inspect' && cover.withEdit !== true) fail('FORBIDDEN', '模板封面与真实项目不匹配或模板不可编辑。') }
    const modules = rows(await call(name('modules'), { query: { kanbanId: where.projectId }, ...legacy })), member = modules.find(row => id(row.id) === where.moduleId && row.type === 'task')
    if (!member) fail('FORBIDDEN', '任务模块不属于当前项目目录。')
    const module = asObject(await call(name('module'), { query: { id: where.moduleId }, ...legacy }))
    if (id(module.id) !== where.moduleId || module.type !== 'task' || module.name !== member!.name) fail('CONTEXT_MISMATCH', '任务模块详情与项目目录不一致。')
    const cards = rows(await call(name('cards'), { query: { kanbanChildId: where.moduleId }, ...legacy }))
    if (!cards.some(card => id(card.id) === where.cardId)) fail('FORBIDDEN', '卡片不属于明确项目的当前任务模块。')
    const permissions = asObject(await call(name(destination ? 'permissions' : 'cardPermissions'), { query: { planId: where.moduleId } }))
    return { project: { id: project.id, coverId: project.coverId, editControl: project.editControl }, module: { id: module.id, name: module.name, type: module.type }, card: cards.find(card => id(card.id) === where.cardId), permissions, cover: cover && { id: cover.id, templateKanbanId: cover.templateKanbanId, withEdit: cover.withEdit } }
  }
  const collect = async (destination = false) => {
    const where = destination ? target! : source, list: JsonObject[] = [], seen = new Set<string>()
    for (let offset = 0; offset < 10000; offset += 200) {
      const page = rows(await call(destination ? 'targetTasks' : 'tasks', { body: { planId: where.moduleId, groupType: 'card', key: where.cardId, filter: null, sortType: null, showView: 'list', isNeedTemplateField: false, offset, max: 200 } }))
      if (page.length > 200) fail('CONTEXT_MISSING', '任务服务没有遵守分页界限。')
      for (const row of page) { const key = tid(row.id); if (seen.has(key) || id(row.cardId) !== where.cardId) fail('CONTEXT_CONFLICT', '任务分页重复、变化或返回其他卡片资源。'); seen.add(key); list.push(row) }
      if (page.length < 200) return list
    }
    return fail('CONTEXT_MISSING', '卡片可见任务达到10000项，无法证明列表结束；请拆分卡片后执行。')
  }
  const detail = async (taskId: string, destination = false) => {
    const where = destination ? target! : source, task = asObject(await call('task', { query: { id: taskId, module: 'project', siteId: where.projectId } }))
    if (task.id !== taskId || id(asObject(task.from).projectId) !== where.projectId || id(asObject(task.from).planId) !== where.moduleId || id(task.cardId) !== where.cardId || task.taskId != null && task.taskId !== '') fail('CONTEXT_MISMATCH', '所选任务不属于明确项目、模块和卡片的根任务。')
    return task
  }
  const taskPermissions = async (task: JsonObject) => {
    const value = asObject(await call('permissions', { query: { taskId: task.id, module: 'project', siteId: source.projectId } }))
    if (value.taskId !== task.id || value.module !== 'project' || String(value.siteId) !== source.projectId) fail('CONTEXT_MISMATCH', '逐任务权限没有绑定当前项目和真实任务。')
    return asObject(value.editControl)
  }
  const allowed = (permissions: JsonObject, permission: string) => { if (permissions[permission] !== true) fail('FORBIDDEN', '当前 UI 未授予权限：' + permission) }
  const archiveRead = async (bags: unknown) => { archiveTarget(bags, input.bagId, session); const items = rows(await call('archiveItems', { query: { id: input.bagId, max: 10000 } })); if (items.length >= 10000) fail('CONTEXT_MISSING', '档案袋达到查询窗口上限，不能证明完整读回。'); return items }
  const copyForest = (roots: JsonObject[], destination = false) => {
    const where = destination ? target! : source
    return readCopyForest(roots, { task: taskId => call('task', { query: { id: taskId, module: 'project', siteId: where.projectId } }), comments: taskId => call('copyComments', { query: { taskId } }), children: taskId => call('copyChildren', { query: { taskId, planId: where.moduleId } }) }, where, destination ? taskId => { resources.observedCopiedTaskIds = [...(resources.observedCopiedTaskIds as string[] ?? []), taskId] } : undefined)
  }
  try {
    await identity(); await checkAccess(ctx, flow, input, session, options.transport)
    const beforeContext = await context(), available = await collect(), requested = input.taskIds
    if (action !== 'inspect' && (Array.isArray(requested) === (input.allVisible === true))) fail('INVALID_INPUT', '显式选择 taskIds 或 allVisible=true，二者只能选一个。')
    const selected = !Array.isArray(requested) ? available : requested.map(value => available.find(task => task.id === value) ?? fail('FORBIDDEN', '所选任务不在本次卡片的完整可见目录。'))
    if (selected.length > 100) fail('INVALID_INPUT', '一次最多核对和处理100个根任务，请显式拆分 taskIds。')
    const tasks = [] as JsonObject[], grants = [] as JsonObject[]
    for (const row of selected) { tasks.push(await detail(tid(row.id))); grants.push(await taskPermissions(tasks.at(-1)!)) }
    const version = hash({ source, context: beforeContext, available: available.map(task => task.id), tasks: tasks.map(taskSnapshot), grants })
    resources.taskIds = tasks.map(task => task.id)
    if (action === 'inspect') return { command: flow.command, completedSteps: completed, resources, result: { ...source, contextVersion: version, visibility: 'current-user-visible-root-tasks', tasks: tasks.map((task, index) => ({ ...taskSnapshot(task), editControl: grants[index] })), cardPermissions: beforeContext.permissions } }
    if (input.expectedContextVersion != null && input.expectedContextVersion !== version) fail('CONTEXT_CONFLICT', '卡片版本已改变，未提交批量请求。')
    if (!tasks.length) fail('INVALID_INPUT', '本次选择没有任务，未提交空批量请求。')
    const sourceForest = action === 'copy' ? await copyForest(tasks) : null
    if (sourceForest) copySnapshot(sourceForest)
    const beforeTarget = target ? await context(true) : null, targetList = target ? await collect(true) : []
    if (target && source.moduleId === target.moduleId && source.cardId === target.cardId && source.projectId === target.projectId) fail('INVALID_INPUT', '源卡片和目标卡片必须不同。')
    if (target) allowed(beforeTarget!.permissions, 'createTask')
    let memberScope: unknown, beforeBags: unknown, beforeArchive: JsonObject[] = [], personalLabels: JsonObject[] = []
    const memberAction = ['members', 'members-add', 'members-remove'].includes(action), labelAction = action.startsWith('labels-'), labelCatalogues: JsonObject[][] = []
    if (memberAction) memberScope = await call('memberScope')
    if (['labels-add', 'labels-remove'].includes(action)) personalLabels = taskLabels(await call('personalLabels'), true)
    if (action === 'archive-completed') { beforeBags = await call('bags'); beforeArchive = await archiveRead(beforeBags); allowed(beforeContext.permissions, 'archiveKanbanCard') }
    const fields: JsonObject = {}
    if (action === 'members') {
      if (!['memberIds', 'principalId', 'isOpenToMember'].some(key => Object.hasOwn(input, key))) fail('INVALID_INPUT', '至少提供一个成员配置；未提供项保持原值。')
      if (Object.hasOwn(input, 'memberIds')) fields.memberIds = (input.memberIds as string[]).join(',')
      if (Object.hasOwn(input, 'principalId')) fields.responsibilityId = input.principalId
      if (Object.hasOwn(input, 'isOpenToMember')) fields.isOpenToMember = input.isOpenToMember
    }
    if (action === 'dates') { if (!Object.keys(asObject(input.dates)).length) fail('INVALID_INPUT', '至少提供 start 或 end；null 表示清空。'); Object.assign(fields, taskDatesPatch(asObject(input.dates), tasks[0])) }
    if (action === 'priority') fields.priorityV2 = input.priority
    if (action === 'status') fields.isDone = input.done
    if (action === 'members-add' || action === 'members-remove') fields.memberIds = (input.memberIds as string[]).join(',')
    if (labelAction && action !== 'labels-add') {
      if (action === 'labels-clear') Object.assign(fields, { kanbanLabelIds: '', todoLabelIds: '' })
      else for (const [type, field] of [['project', 'kanbanLabelIds'], ['todo', 'todoLabelIds']]) {
        const selected = (input.labels as JsonObject[]).filter(label => label.type === type)
        // RemoveLabel subtracts each category independently.
        if (selected.length) fields[field!] = selected.map(label => id(label.id)).join(',')
      }
    }
    const fieldContexts: JsonObject[] = []
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index], permissions = grants[index]!
      if (task.forbidEdit === true) fail('FORBIDDEN', '所选任务已禁止编辑，未提交整批写入。')
      const permission: Partial<Record<ProjectCardBatchAction, string>> = { copy: 'copyTask', move: 'moveTask', 'archive-completed': 'archiveTask' }
      if (permission[action]) allowed(permissions, permission[action]!)
      if (action === 'priority' || action === 'status') {
        allowed(beforeContext.permissions, action === 'priority' ? 'editTaskPriority' : 'finishTask')
        const values = action === 'status' ? asObject(await call('values', { query: { taskId: task.id, module: 'project', siteId: source.projectId } })) : {}
        fieldContexts.push(values)
        prepareTaskBusiness('task-business-update', { taskId: task.id, projectId: source.projectId, patch: fields }, { task, project: beforeContext.project, templateCover: beforeContext.cover, templateCoverFresh: beforeContext.cover, permissions: { taskId: task.id, module: 'project', siteId: source.projectId, editControl: permissions }, values }, session)
      }
      if (action === 'members') {
        const previous = people(task.members), chosen = Object.hasOwn(input, 'memberIds') ? taskMembersAllowed(input.memberIds, { memberScope }, previous) : previous
        if (chosen.some(value => !previous.includes(value))) { allowed(permissions, 'addTaskMember'); allowed(beforeContext.permissions, 'addTaskMember') }
        if (previous.some(value => !chosen.includes(value))) { allowed(permissions, 'removeTaskMember'); allowed(beforeContext.permissions, 'removeTaskMember') }
        const principal = Object.hasOwn(input, 'principalId') ? input.principalId : task.responsibilityId
        if (principal != null && principal !== '' && !chosen.includes(String(principal))) fail('INVALID_INPUT', '每个任务的负责人必须属于写入后的执行人；移除负责人时请显式 principalId=null。')
        if (Object.hasOwn(input, 'principalId')) allowed(permissions, 'addTaskMember')
        if (Object.hasOwn(input, 'isOpenToMember')) allowed(permissions, 'editIsOpenToMember')
      }
      if (action === 'members-add' || action === 'members-remove') {
        const previous = people(task.members), selected = taskMembersAllowed(input.memberIds, { memberScope }, action === 'members-remove' ? previous : [])
        const grant = action === 'members-add' ? 'addTaskMember' : 'removeTaskMember'
        allowed(permissions, grant); allowed(beforeContext.permissions, grant)
        if (action === 'members-remove' && task.responsibilityId != null && selected.includes(String(task.responsibilityId))) fail('INVALID_INPUT', '所选执行人仍是任务负责人；先用 members set 显式调整或清空负责人，再移除。整批未发送。')
      }
      if (labelAction) {
        allowed(permissions, 'editTaskLabel'); allowed(beforeContext.permissions, 'selectTaskLabel')
        if (action !== 'labels-clear') {
          const projectLabels = taskLabels(await call('labels', { query: { kanbanId: source.projectId, taskId: task.id }, ...legacy }))
          const catalogue = [...new Map([...personalLabels, ...projectLabels].map(label => [labelKey(label), label])).values()]
          if ((input.labels as JsonObject[]).some(label => !catalogue.some(item => labelKey(item) === labelKey(label)))) fail('FORBIDDEN', '标签不属于当前用户个人库、当前项目库或该任务实际已选的外部标签；整批未发送。')
          labelCatalogues.push(catalogue)
        }
        taskLabels(task.labelList ?? [])
      }
      if (action === 'dates') {
        allowed(permissions, 'editTaskDate'); allowed(beforeContext.permissions, 'editTaskDate'); taskDatesPatch(asObject(input.dates), task)
        if (task.rrule) fail('INVALID_INPUT', '重复任务的日期须先明确处理整条重复规则；未发送日期写入。')
        if (asObject(task.taskTemplate).isMilepost === true && !sameDate(Object.hasOwn(fields, 'realStartDate') ? fields.realStartDate : task.realStartDate, Object.hasOwn(fields, 'realEndDate') ? fields.realEndDate : task.realEndDate)) fail('INVALID_INPUT', '里程碑必须保持单日日期；请使用 milestone update。')
      }
      if (action === 'archive-completed' && task.isDone !== true && task.isClose !== true) fail('INVALID_INPUT', '归档已完成任务需要显式选中的任务都已完成或关闭。')
    }
    await identity(); await checkAccess(ctx, flow, input, session, options.transport)
    const freshContext = await context(), freshAvailable = await collect(), freshTasks = [] as JsonObject[], freshGrants = [] as JsonObject[]
    for (const task of tasks) { freshTasks.push(await detail(tid(task.id))); freshGrants.push(await taskPermissions(freshTasks.at(-1)!)) }
    if (hash({ source, context: freshContext, available: freshAvailable.map(task => task.id), tasks: freshTasks.map(taskSnapshot), grants: freshGrants }) !== version) fail('CONTEXT_CONFLICT', '提交前任务、权限或卡片目录已变化，未发送批量写入。')
    if (action === 'status') for (let index = 0; index < tasks.length; index++) if (!isDeepStrictEqual(asObject(await call('values', { query: { taskId: tasks[index]!.id, module: 'project', siteId: source.projectId } })), fieldContexts[index])) fail('CONTEXT_CONFLICT', '提交前任务字段及必填上下文已变化，未发送状态写入。')
    if (sourceForest && !isDeepStrictEqual(copySnapshot(await copyForest(freshTasks)), copySnapshot(sourceForest))) fail('CONTEXT_CONFLICT', '提交前复制的评论、标签或子任务树已变化，未发送写入。')
    if (target && (!isDeepStrictEqual(await context(true), beforeTarget) || !isDeepStrictEqual((await collect(true)).map(row => row.id), targetList.map(row => row.id)))) fail('CONTEXT_CONFLICT', '目标卡片或权限已改变，未发送批量写入。')
    if (memberAction && !isDeepStrictEqual(await call('memberScope'), memberScope)) fail('CONTEXT_CONFLICT', '可选成员范围已变化。')
    if (['labels-add', 'labels-remove'].includes(action)) {
      if (!isDeepStrictEqual(taskLabels(await call('personalLabels'), true), personalLabels)) fail('CONTEXT_CONFLICT', '个人标签库已变化，未发送批量写入。')
      for (let index = 0; index < tasks.length; index++) {
        const actual = taskLabels(await call('labels', { query: { kanbanId: source.projectId, taskId: tasks[index]!.id }, ...legacy }))
        const catalogue = [...new Map([...personalLabels, ...actual].map(label => [labelKey(label), label])).values()]
        if (!isDeepStrictEqual(catalogue, labelCatalogues[index])) fail('CONTEXT_CONFLICT', '任务可选标签已变化，未发送批量写入。')
      }
    }
    if (action === 'archive-completed' && (!isDeepStrictEqual(await call('bags'), beforeBags) || !isDeepStrictEqual(await archiveRead(beforeBags), beforeArchive))) fail('CONTEXT_CONFLICT', '档案袋权限或内容已变化。')
    const body: JsonObject = { ids: tasks.map(task => task.id).join(','), module: 'project', siteId: source.projectId, ...fields,
      ...(action === 'copy' ? { cardId: target!.cardId, hasComments: true, hasLabelsLinks: true, hasSubTasks: true, hasTaskDate: true, hasTaskUserLink: true } : action === 'move' ? { cardId: target!.cardId, originalCardId: source.cardId } : action === 'archive-completed' ? { bagId: input.bagId, isDone: true } : {}) }
    if (action === 'members' || action === 'dates' || action === 'labels-add') {
      // Bulk appends members, adjusts dates, and drops the omitted label source
      // during toLabelList. Resolve exact context per task in one PUT instead.
      resources.mutatedTaskIds = []; resources.verifiedTaskIds = []
      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index]!, taskId = tid(task.id); resources.currentTaskId = taskId
        await identity(); await checkAccess(ctx, flow, input, session, options.transport)
        const current = await detail(taskId), currentGrant = await taskPermissions(current)
        if (!isDeepStrictEqual(await context(), freshContext) || !isDeepStrictEqual(taskSnapshot(current), taskSnapshot(task)) || !isDeepStrictEqual(currentGrant, freshGrants[index])) fail('CONTEXT_CONFLICT', '下一项更新前资源或权限已变化；保留已完成任务，不继续写入。')
        if (action === 'labels-add') {
          const own = taskLabels(await call('personalLabels'), true), selected = taskLabels(await call('labels', { query: { kanbanId: source.projectId, taskId }, ...legacy }))
          if (!isDeepStrictEqual(own, personalLabels) || !isDeepStrictEqual([...new Map([...own, ...selected].map(label => [labelKey(label), label])).values()], labelCatalogues[index])) fail('CONTEXT_CONFLICT', '下一项追加标签前标签库已变化；保留已完成任务，不继续写入。')
        }
        await call('changed', { body: { id: taskId, module: 'project', siteId: source.projectId, ...(action === 'dates' ? resolvedDates(task, input) : action === 'labels-add' ? resolvedLabels(task, input) : fields) } })
        ;(resources.mutatedTaskIds as string[]).push(taskId)
        const actual = await detail(taskId)
        if (action === 'dates') verifyDates(task, actual, input); else if (action === 'labels-add') verifyBatchChange(action, task, actual, input, labelCatalogues[index]); else verifyMembers(task, actual, input)
        ;(resources.verifiedTaskIds as string[]).push(taskId)
      }
      delete resources.currentTaskId
    } else await call('changed', { body })
    const after = await collect(), afterTarget = target ? await collect(true) : []
    for (const row of available.filter(row => !tasks.some(task => task.id === row.id))) assert(after.some(current => current.id === row.id), '其他已观察的源卡片任务未保持。')
    for (const row of targetList) assert(afterTarget.some(current => current.id === row.id), '目标卡片已有任务未保持。')
    const verified: JsonObject[] = []
    let copyProof: JsonObject[] | undefined
    const remember = (row: JsonObject) => { verified.push(row); resources.verifiedTaskIds = verified.map(row => action === 'archive-completed' ? String(row.resourceId) : row.id) }
    if (action === 'copy') {
      const added = afterTarget.filter(row => !targetList.some(old => old.id === row.id)); resources.createdTaskIds = added.map(row => row.id)
      assert(added.length === tasks.length, '批量复制未读回预期数量的新任务；不会重发。')
      const copiedRoots: JsonObject[] = []
      for (const row of added) copiedRoots.push(await detail(tid(row.id), true))
      const copiedForest = await copyForest(copiedRoots, true), targetLabels = rows(await call('copyLabels', { query: { kanbanId: target!.projectId }, ...legacy }))
      copyProof = verifyCopiedForest(sourceForest!, copiedForest, targetLabels)
      resources.createdDescendantTaskIds = copyNodes(copiedForest).filter(node => node.task.taskId != null).map(node => node.task.id)
      const definitions = new Map<string, JsonObject>()
      for (const { task: actual } of copyNodes(copiedForest)) {
        const typeId = asObject(actual.taskTemplate).id == null ? null : id(asObject(actual.taskTemplate).id)
        let definition: JsonObject = {}
        if (typeId) {
          if (!definitions.has(typeId)) { const found = asObject(await call('copyType', { query: { id: typeId } })); if (id(found.id) !== typeId) fail('CONTEXT_MISMATCH', '复制任务的实际类型详情不一致。'); definitions.set(typeId, found) }
          definition = definitions.get(typeId)!
        }
        // The batch DTO has no hasPriority. CopyRuleConverter leaves it null;
        // cloning clears priority, then creation applies the target type default.
        const expectedPriority = asObject(definition.defaultValues).priorityV2 ?? 3
        assert(Number.isInteger(expectedPriority) && Number(expectedPriority) >= 1 && Number(expectedPriority) <= 4 && actual.priorityV2 === expectedPriority, '复制任务未采用真实目标类型的默认优先级。')
      }
      for (const actual of copiedRoots) { assert(!available.some(task => task.id === actual.id), '复制根任务仍使用源卡片 ID。'); remember(taskSnapshot(actual)) }
      for (const task of tasks) assert(isDeepStrictEqual(taskSnapshot(await detail(tid(task.id))), taskSnapshot(task)), '复制修改了源任务。')
      assert(isDeepStrictEqual(copySnapshot(await copyForest(tasks)), copySnapshot(sourceForest!)), '复制后源评论、标签或子树已改变。')
    } else if (action === 'move') {
      for (const task of tasks) { assert(!after.some(row => row.id === task.id) && afterTarget.some(row => row.id === task.id), '服务回执未证明任务已实际移动。'); const actual = await detail(tid(task.id), true); assert(actual.name === task.name && isDeepStrictEqual(people(actual.members), people(task.members)), '移动后的实际任务身份或执行人不一致。'); remember(taskSnapshot(actual)) }
    } else if (action === 'archive-completed') {
      let archived: JsonObject[] = []
      for (let attempt = 0; attempt < 5; attempt++) { archived = await archiveRead(await call('bags')); if (tasks.every(task => archived.filter(row => String(row.resourceId) === task.id && [1, 5].includes(Number(row.type)) && !beforeArchive.some(old => old.id === row.id)).length === 1)) break; if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 1000)) }
      for (const task of tasks) { const matches = archived.filter(row => String(row.resourceId) === task.id && [1, 5].includes(Number(row.type)) && !beforeArchive.some(old => old.id === row.id)); assert(matches.length === 1 && matches[0]!.name === task.name && !after.some(row => row.id === task.id), '归档未形成唯一真实记录并从源卡片移出；不会重发。'); remember(matches[0]!); }
      resources.archiveRecordIds = verified.map(row => row.id)
    } else {
      for (const [index, task] of tasks.entries()) { const actual = await detail(tid(task.id)); if (action === 'members') verifyMembers(task, actual, input); else if (action === 'dates') verifyDates(task, actual, input); else if (labelAction || action === 'members-add' || action === 'members-remove') verifyBatchChange(action, task, actual, input, labelCatalogues[index]); else for (const [key, value] of Object.entries(fields)) assert(actual[key] === value, '批量优先级或完成状态未全部生效。'); remember(taskSnapshot(actual)) }
    }
    resources.verifiedTaskIds = verified.map(row => action === 'archive-completed' ? String(row.resourceId) : row.id)
    return { command: flow.command, completedSteps: completed, resources, result: { action, source, ...(target && { target }), selectedTaskIds: tasks.map(task => task.id), verified, ...(copyProof && { copyProof }), verification: action === 'copy' ? 'independent-root-and-descendant-identities; ordered-tree-comments-labels-members-dates-and-actual-type-default-priority; visible-http-context-only' : 'independent-http-for-every-selected-task', concurrency: 'fresh-preflight-and-readback; service-has-no-atomic-compare-and-swap', automaticallyRetried: false } }
  } catch (error) { const cause = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', error instanceof Error ? error.message : '卡片批量操作失败。', 5); throw new RsqError(cause.code, cause.message, cause.exit, { ...asObject(cause.details), failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown' : written ? 'accepted-needs-verification' : 'not-sent', automaticallyRetried: false }) }
}
