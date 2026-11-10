import { createHash } from 'node:crypto'
import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { checkAccess } from './access.js'
import { companyDirectoryUsers } from './contact.js'
import type { Workflow } from './workflows.js'
export type OkrAction = 'inspect' | 'task-context' | 'task-create' | 'link-task' | 'link-project' | 'link-module' | 'unlink' | 'contribution' | 'move'
type Route = [string, string, string]
const base = '/task/okr'
const fail = (message: string, code = 'CONTEXT_MISSING'): never => { throw new RsqError(code, message, code === 'RESOURCE_FORBIDDEN' ? 4 : code === 'INVALID_INPUT' ? 2 : 5) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('行动上下文缺少精确 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('行动上下文不是有界列表。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const category = (row: JsonObject) => ['task', 'todo', 'kanbanItem'].includes(String(row.type)) ? 'task' : row.type
export function okrActionSteps(action: OkrAction): Route[] {
  const start: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['cycles', 'GET', base + '/cycle/list'], ['objective', 'GET', base + '/objective']]
  if (action === 'inspect') return start
  if (action === 'task-context') return [...start, ['templates', 'GET', '/task/v3/taskTemplate/createTemplateList'], ['directory', 'GET', '/task/v1/department/list']]
  const project: Route[] = [['projects', 'GET', '/task/v3/kanbanGroup/kanbanList'], ['project', 'GET', '/task/v1/kanbanCrud']]
  const resource: Route[] = action === 'task-create' ? [['templates', 'GET', '/task/v3/taskTemplate/createTemplateList'], ['directory', 'GET', '/task/v1/department/list']] : action === 'link-task' ? [['task', 'GET', '/task/api/v3/task'], ...project] : action === 'link-project' ? project : action === 'link-module' ? [...project, ['modules', 'GET', '/task/v1/kanbanChildCrud/list']] : []
  const method = action.startsWith('link-') || action === 'task-create' ? 'POST' : action === 'unlink' ? 'DELETE' : 'PUT', suffix = action === 'move' ? '/sort' : ''
  return [...start, ...resource, ['preflight', 'GET', base + '/objective'], ['objectiveChanged', method, base + (action === 'task-create' ? '/objective/task' : '/objective/keyAction') + suffix], ['resultChanged', method, base + (action === 'task-create' ? '/keyResult/task' : '/keyResult/relation') + suffix], ['verified', 'GET', base + '/objective'], ...(action === 'task-create' ? [['verifiedTask', 'GET', '/task/api/v3/task'] as Route] : [])]
}
export function validateOkrActionWorkflow(flow: Workflow) {
  if (!['inspect', 'task-context', 'task-create', 'link-task', 'link-project', 'link-module', 'unlink', 'contribution', 'move'].includes(flow.okrAction ?? '')) throw new RsqError('INVALID_CONTRACT', '未登记的目标行动业务。', 6)
  const expected = okrActionSteps(flow.okrAction!)
  if (flow.executor !== 'okr-actions' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.resources || step.authentication || step.readback
  })) throw new RsqError('INVALID_CONTRACT', '目标行动编排不符合核对的协议。', 6)
}
function context(value: unknown, input: JsonObject) {
  const objective = asObject(value)
  if (!same(objective.id, input.objectiveId) || asObject(objective.editControl).view !== true) fail('目标不可见或资源不符。', 'RESOURCE_FORBIDDEN')
  const owner = input.resultId == null ? objective : rows(objective.krList).find(row => row.krType === 'normal' && same(row.id, input.resultId))
  if (!owner) fail('指定 KR 不属于此目标或不是普通 KR；子目标和指标有独立业务上下文。', 'INVALID_INPUT')
  const actions = rows(owner!.keyActionList), seen = new Set<string>()
  for (const row of actions) { if (seen.has(id(row.id)) || !['task', 'todo', 'kanbanItem', 'plan', 'planModule'].includes(String(row.type))) fail('行动列表有重复 ID 或未知类型。'); seen.add(id(row.id)) }
  return { objective, owner: owner!, actions }
}
const version = (ctx: ReturnType<typeof context>) => hash({ id: ctx.owner.id, cycle: ctx.objective.cycle, controls: ctx.owner.editControl, allowTask: ctx.objective.allowObjectiveAddKeyAction, allowRelation: ctx.objective.allowObjectiveAddRelation, progressType: ctx.owner.progressType, actions: ctx.actions.map(row => ({ id: row.id, type: row.type, relationId: row.relationId, contribute: row.contribute, displayOrder: row.displayOrder, isDisplay: row.isDisplay })) })
export async function runOkrAction(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateOkrActionWorkflow(flow)
  const session = requireSession(supplied), action = flow.okrAction!, completed: string[] = [], skipped: string[] = [], resources: Record<string, string> = { objectiveId: String(input.objectiveId), ...(input.resultId != null && { resultId: String(input.resultId) }) }
  let phase = 'identity', pending = false, changed = false
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) throw new RsqError('INVALID_CONTRACT', '未声明的目标行动步骤。', 6)
    phase = name; pending = op.effect !== 'read'
    const value = await runOperation(ctx, op, args, session, { transport: options.transport, approved: options.approved })
    completed.push(name); pending = false; if (name.endsWith('Changed')) changed = true
    return value
  }
  try {
    const identity = asObject(await call('identity'))
    if (!same(identity.id, session.identity.userId) || !same(asObject(identity.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '当前用户或公司与 profile 不一致。', 3)
    const cycles = asObject(await call('cycles')), unarchived = ['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(part => rows(cycles[part])), query = { query: { id: input.objectiveId } }, before = context(await call('objective', query), input)
    if (!unarchived.some(row => row.isArchived === false && same(row.id, asObject(before.objective.cycle).id))) fail('目标不在当前公司未归档周期中。', 'RESOURCE_FORBIDDEN')
    const describe = (current: ReturnType<typeof context>) => ({ objectiveId: input.objectiveId, resultId: input.resultId ?? null, items: current.actions, contextVersion: version(current), permissions: current.owner.editControl, allowTask: input.resultId != null || current.objective.allowObjectiveAddKeyAction === true, allowRelation: current.objective.allowObjectiveAddRelation === true, concurrency: 'fresh-http-context-without-server-compare-and-swap' })
    if (action === 'inspect') return { command: flow.command, resources, completedSteps: completed, result: describe(before) }
    let native: { templates: JsonObject[]; users: JsonObject[] } | undefined
    if (action === 'task-context' || action === 'task-create') {
      const templates = rows(await call('templates')), users = companyDirectoryUsers(await call('directory'))
      native = { templates, users }
      if (action === 'task-context') return { command: flow.command, resources, completedSteps: completed, result: { ...describe(before), taskTemplates: templates, members: users.map(user => ({ id: id(user.id), name: user.showName })) } }
    }
    const contextVersion = version(before)
    if (input.expectedVersion != null && input.expectedVersion !== contextVersion) fail('行动上下文已变化。', 'CONTEXT_CONFLICT')
    if (action.startsWith('link-')) { if (before.objective.allowObjectiveAddRelation !== true) fail('当前 UI 不允许关联任务、项目或模块。', 'RESOURCE_FORBIDDEN') }
    else if (asObject(before.owner.editControl).task !== true || input.resultId == null && before.objective.allowObjectiveAddKeyAction !== true) fail('当前 UI 未授予行动管理权限。', 'RESOURCE_FORBIDDEN')
    const selected = action.startsWith('link-') || action === 'task-create' ? undefined : before.actions.find(row => same(row.id, input.actionId))
    if (!action.startsWith('link-') && action !== 'task-create' && !selected) fail('行动必须属于当前目标或 KR 的实际列表。', 'INVALID_INPUT')
    let request: JsonObject, expectedResource: { type: string; id: string; taskId?: string } | undefined, expectedOrder: string[] | undefined, nativeMembers: string[] | undefined
    if (action === 'task-create') {
      const chosen = input.taskTemplateId == null ? native!.templates.filter(row => row.isDefault === true) : native!.templates.filter(row => same(row.id, input.taskTemplateId))
      if (chosen.length !== 1 || chosen[0].isMilepost === true) fail('明确选择当前可创建的普通任务类型；默认类型必须唯一，里程碑使用独立业务。', 'INVALID_INPUT')
      const name = String(input.name)
      if (!name.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(name)) fail('任务名称不能为空或含控制字符。', 'INVALID_INPUT')
      nativeMembers = input.memberIds == null ? [id(session.identity.userId)] : (input.memberIds as string[])
      const all = [...nativeMembers, ...(input.responsibilityId == null ? [] : [id(input.responsibilityId)])]
      if (all.some(key => !native!.users.some(user => same(user.id, key)))) fail('执行人和负责人必须属于当前公司成员。', 'RESOURCE_FORBIDDEN')
      request = { body: { [input.resultId == null ? 'objectiveId' : 'keyResultId']: input.resultId ?? input.objectiveId, taskTemplateId: id(chosen[0].id), name, memberIds: nativeMembers.join(','), ...(input.responsibilityId != null && { responsibilityId: input.responsibilityId }) } }
    } else if (action.startsWith('link-')) {
      let relationId: string, type: string
      const project = async (projectId: unknown) => {
        if (action === 'link-task' && input.projectId == null) {
          const op = catalog.operations.find(op => op.method === 'GET' && op.route === '/task/v1/kanbanCrud')!
          await checkAccess(ctx, op, { query: { id: id(projectId) } }, session, options.transport)
        }
        const active = asObject(await call('projects', { query: { kanbanGroupId: 'all' } }))
        if (!rows(active.kanbanList).some(row => same(row.id, projectId))) fail('关联项目不在当前公司可见活动项目中。', 'RESOURCE_FORBIDDEN')
        const value = asObject(await call('project', { query: { id: id(projectId) } }))
        if (!same(value.id, projectId) || value.coverId !== null) fail('关联资源必须是当前身份可见的普通项目，不能混用模板。', 'RESOURCE_FORBIDDEN')
        return value
      }
      if (action === 'link-task') {
        const task = asObject(await call('task', { query: { id: input.taskId, module: input.projectId == null ? 'common' : 'project', siteId: input.projectId ?? 'common' } }))
        if (!same(task.id, input.taskId) || task.isDisplay === false) fail('关联任务不可见或详情不一致。', 'RESOURCE_FORBIDDEN')
        const projectId = asObject(task.from).projectId
        if (input.projectId != null && !same(projectId, input.projectId)) fail('任务实际项目与传入项目不同。', 'INVALID_INPUT')
        if (projectId != null) { await project(projectId); type = 'kanbanItem' } else { skipped.push('projects', 'project'); type = 'todo' }
        relationId = String(input.taskId); expectedResource = { type, id: relationId, taskId: relationId }
      } else {
        await project(input.projectId); relationId = id(input.projectId); type = 'plan'
        if (action === 'link-module') {
          const module = rows(await call('modules', { query: { kanbanId: input.projectId } })).find(row => same(row.id, input.moduleId))
          if (!module || module.type !== 'datasheet' || !asObject(module.datasheetInfo).datasheetId) fail('关联数据必须是此项目中实际可见的数据表模块。', 'RESOURCE_FORBIDDEN')
          relationId = id(input.moduleId); type = 'planModule'
        }
        expectedResource = { type, id: relationId }
      }
      if (before.actions.some(row => row.type === type && (expectedResource!.taskId ? same(asObject(row.task).id, relationId) : same(row.relationId, relationId)))) fail('此资源已有相同关联；不重复新增。', 'INVALID_INPUT')
      request = { body: { [input.resultId == null ? 'objectiveId' : 'keyResultId']: input.resultId ?? input.objectiveId, [input.resultId == null ? 'keyActionList' : 'relationList']: [{ relationId, type }] } }
    } else if (action === 'unlink') request = { query: { id: id(selected!.id) } }
    else if (action === 'contribution') {
      if (input.resultId == null && before.owner.progressType !== 'manual') fail('当前目标不是手动进度，UI 不显示贡献值编辑。', 'RESOURCE_FORBIDDEN')
      const value = input.value
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100 || Math.abs(Math.round(value * 100) - value * 100) > 1e-8) fail('贡献值必须是可精确表达且最多两位小数的数值。', 'INVALID_INPUT')
      request = { body: { id: id(selected!.id), contribute: input.value } }
    } else {
      const group = before.actions.filter(row => category(row) === category(selected!)).sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder))
      if (group.some(row => typeof row.displayOrder !== 'number' || !Number.isFinite(row.displayOrder))) fail('行动缺少可验证排序值。')
      const remaining = group.filter(row => row !== selected), next = input.beforeActionId == null ? undefined : remaining.find(row => same(row.id, input.beforeActionId))
      if (input.beforeActionId != null && !next) fail('排序邻居必须属于同一类型的当前行动列表。', 'INVALID_INPUT')
      const at = next ? remaining.indexOf(next) : remaining.length; remaining.splice(at, 0, selected!)
      expectedOrder = remaining.map(row => id(row.id)); const front = remaining[at - 1], behind = remaining[at + 1]
      request = { body: { moveId: id(selected!.id), ...(front && { frontId: id(front.id) }), ...(behind && { behindId: id(behind.id) }) } }
    }
    const fresh = context(await call('preflight', query), input)
    if (version(fresh) !== contextVersion) fail('依赖读取期间行动或权限已变化，未发送写入。', 'CONTEXT_CONFLICT')
    const change = input.resultId == null ? 'objectiveChanged' : 'resultChanged'; skipped.push(input.resultId == null ? 'resultChanged' : 'objectiveChanged')
    await call(change, request)
    const after = context(await call('verified', query), input), oldIds = new Set(before.actions.map(row => id(row.id)))
    if (action === 'task-create') {
      const added = after.actions.filter(row => !oldIds.has(id(row.id)))
      if (added.length !== 1 || added[0].type !== 'task' || asObject(added[0].task).name !== input.name || typeof asObject(added[0].task).id !== 'string' || before.actions.some(row => !after.actions.some(item => same(item.id, row.id)))) fail('原生行动任务未能从独立读回的前后 ID 集合唯一确定，勿重放创建。', 'BUSINESS_ASSERTION_FAILED')
      resources.actionId = id(added[0].id); resources.taskId = String(asObject(added[0].task).id)
      const members = rows(asObject(added[0].task).members).map(user => id(user.id)).sort()
      if (JSON.stringify(members) !== JSON.stringify([...nativeMembers!].sort())) fail('新任务执行人未独立读回一致。', 'BUSINESS_ASSERTION_FAILED')
      if (input.responsibilityId != null && !same(asObject(added[0].task).responsibilityId, input.responsibilityId)) fail('新任务负责人未独立读回一致。', 'BUSINESS_ASSERTION_FAILED')
      const task = asObject(await call('verifiedTask', { query: { id: resources.taskId, module: 'common', siteId: 'common' } }))
      if (!same(task.id, resources.taskId) || task.isDisplay === false || task.name !== input.name) fail('新任务未能通过 Task HTTP 接口独立核对。', 'BUSINESS_ASSERTION_FAILED')
    } else if (expectedResource) {
      const added = after.actions.filter(row => !oldIds.has(id(row.id))), target = added.filter(row => row.type === expectedResource!.type && (expectedResource!.taskId ? same(asObject(row.task).id, expectedResource!.taskId) : same(row.relationId, expectedResource!.id)))
      if (added.length !== 1 || target.length !== 1 || before.actions.some(row => !after.actions.some(item => same(item.id, row.id)))) fail('关联新增资源或原有关联未独立读回一致，勿重复新增。', 'BUSINESS_ASSERTION_FAILED')
      resources.actionId = id(target[0].id)
    } else if (action === 'unlink') {
      if (after.actions.some(row => same(row.id, selected!.id)) || before.actions.some(row => row !== selected && !after.actions.some(item => same(item.id, row.id)))) fail('取消关联后当前或其他关联状态不符。', 'BUSINESS_ASSERTION_FAILED')
    } else if (action === 'contribution') {
      const actual = after.actions.find(row => same(row.id, selected!.id))
      if (!actual || actual.contribute !== input.value || after.actions.length !== before.actions.length) fail('贡献值独立读回不一致。', 'BUSINESS_ASSERTION_FAILED')
    } else {
      const order = after.actions.filter(row => category(row) === category(selected!)).sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder)).map(row => id(row.id))
      if (JSON.stringify(order) !== JSON.stringify(expectedOrder)) fail('行动顺序独立读回不一致。', 'BUSINESS_ASSERTION_FAILED')
    }
    return { command: flow.command, resources, completedSteps: completed, skippedSteps: skipped, result: describe(after) }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '目标行动业务执行失败。', 5)
    throw new RsqError(failure.code, failure.message, failure.exit, { ...failure.details, workflow: flow.id, failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown' : changed ? 'partial' : 'not-started', retry: 'manual-after-readback', automaticRollback: false })
  }
}
