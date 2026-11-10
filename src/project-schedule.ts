import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'
import { dependencyGraph, runProjectDependencies, type DependencyAction } from './project-dependencies.js'

export type ProjectScheduleAction = 'context' | 'tasks-list' | 'settings-get' | 'settings-set' | 'baseline-list' | 'baseline-inspect' | 'baseline-create' | 'baseline-rename' | 'baseline-remove' | DependencyAction
type Route = [string, string, string]
const child = '/task/v3/kanbanChild', depend = '/task/api/v3/task/depend'
export const scheduleId = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '项目排期缺少精确的资源 ID。')
export const taskKey = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : fail('CONTEXT_MISSING', '任务或依赖缺少合法的精确 ID。')
export function fail(code: string, message: string): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : code === 'INVALID_CONTRACT' ? 6 : 5) }
export function ensure(value: unknown, message: string): asserts value { if (!value) fail('BUSINESS_ASSERTION_FAILED', message) }
export function scheduleRows(value: unknown, limit = 10000): JsonObject[] { ensure(Array.isArray(value) && value.length <= limit, '排期 HTTP 未返回完整的有界列表。'); return value.map(asObject) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const get = (id: string, route: string): Route => [id, 'GET', route]
export function projectScheduleSteps(action: ProjectScheduleAction, template: boolean): Route[] {
  const base: Route[] = [get('identity', '/task/login/authAjax'), ...(template ? [get('template', '/task/v4/template')] : []), get('project', '/task/v1/kanbanCrud'), get('modules', '/task/v1/kanbanChildCrud/list'), get('module', '/task/v1/kanbanChildCrud')]
  const settings = get('settings', child + '/gantt/info'), baselines = get('baselines', child + '/baseline/list'), cards = get('cards', '/task/v1/kanbanCardCrud/list'), graph = get('dependencies', depend + '/list'), task = get('task', '/task/api/v3/task')
  const tasks: Route[] = [cards, ['tasks', 'PUT', '/task/api/v3/projectTask/taskList'], get('subtasks', '/task/api/v3/task/subs')]
  if (action === 'context') return [...base, settings, baselines, cards, graph]
  if (action === 'tasks-list') return [...base, cards, ['tasks', 'PUT', '/task/api/v3/projectTask/taskList']]
  if (action === 'settings-get') return [...base, settings]
  if (action === 'settings-set') return [...base, settings, ['changed', 'PUT', child + '/gantt/info'], get('verifiedSettings', child + '/gantt/info')]
  if (action === 'baseline-list') return [...base, baselines]
  const snapshot = get('snapshot', child + '/baseline/tasks')
  if (action === 'baseline-inspect') return [...base, baselines, snapshot, task]
  if (action === 'baseline-create') return [...base, baselines, ...tasks, ['changed', 'POST', child + '/baseline'], get('verifiedBaselines', child + '/baseline/list'), snapshot]
  if (action === 'baseline-rename') return [...base, baselines, snapshot, ['changed', 'PUT', child + '/baseline'], get('verifiedBaselines', child + '/baseline/list'), get('verifiedSnapshot', child + '/baseline/tasks')]
  if (action === 'baseline-remove') return [...base, baselines, snapshot, ['changed', 'DELETE', child + '/baseline'], get('verifiedBaselines', child + '/baseline/list'), get('absentSnapshot', child + '/baseline/tasks')]
  const common = [...base, graph, get('taskDependencies', depend + '/listByTask'), task]
  if (action === 'dependency-list') return common
  const mutation: Route = action === 'dependency-task-update' ? ['changed', 'PUT', '/task/api/v3/task'] : action === 'dependency-replace' ? ['changed', 'POST', '/task/api/v3/task/depends'] : ['changed', action === 'dependency-create' ? 'POST' : action === 'dependency-update' ? 'PUT' : 'DELETE', depend]
  if (!['dependency-task-update', 'dependency-create', 'dependency-update', 'dependency-remove', 'dependency-replace'].includes(action)) fail('INVALID_CONTRACT', '未知项目排期业务。')
  return [...common, ...(action === 'dependency-task-update' ? [get('permissions', '/task/api/v3/task/editcontrol')] : []), mutation, get('verifiedDependencies', depend + '/list'), get('verifiedTaskDependencies', depend + '/listByTask'), get('verifiedTask', '/task/api/v3/task')]
}
export function validateProjectScheduleWorkflow(flow: Workflow) {
  const expected = projectScheduleSteps(flow.projectScheduleAction!, flow.projectScheduleTemplate === true)
  if (flow.executor !== 'project-schedule' || flow.steps.length !== expected.length || expected.some(([id, method, route], index) => {
    const step = flow.steps[index], operation = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== id || operation?.method !== method || operation.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.transfer || step.resources || step.authentication || step.readback || step.collectPages || step.expectAbsent
  })) fail('INVALID_CONTRACT', '项目排期步骤与核对过的 HTTP 契约不一致。')
}
export type ScheduleCall = (step: string, args?: JsonObject) => Promise<unknown>
export type ScheduleScope = { projectId: string; moduleId: string; coverId?: string; template: boolean }
export function scheduleTask(value: unknown, target: string, scope: ScheduleScope) {
  const row = asObject(value), from = asObject(row.from)
  ensure(taskKey(row.id) === target && same(from.projectId, scope.projectId) && same(from.planId, scope.moduleId) && from.planType === 'task', '任务实际归属不是当前项目的任务模块；不能用关联卡片或其他模块任务替代。')
  return row
}
export const taskDates = (row: JsonObject) => ({ realStartDate: row.realStartDate ?? null, realEndDate: row.realEndDate ?? null, isAllDay: row.isAllDay ?? null })
function settings(value: unknown) {
  const row = asObject(value)
  ensure(['day', 'week', 'month', 'doubleMonth', 'quarter', 'semiannual', 'year'].includes(String(row.mode)) && typeof row.isOpenView === 'boolean' && typeof row.isOpenKeyPath === 'boolean', '甘特设置的粒度或布尔值不符合当前 UI。')
  return { mode: row.mode, isOpenView: row.isOpenView, isOpenKeyPath: row.isOpenKeyPath }
}
function baselines(value: unknown) {
  const rows = scheduleRows(value), seen = new Set<string>()
  for (const row of rows) { const id = scheduleId(row.id); ensure(!seen.has(id) && typeof row.name === 'string' && typeof row.createTime === 'string' && typeof row.dateCreated === 'string', '基线目录缺少身份、名称或原始创建时间，或含重复 ID。'); seen.add(id) }
  return rows
}
function snapshot(value: unknown) {
  const rows = scheduleRows(value), seen = new Set<string>()
  for (const row of rows) { const id = taskKey(row.id); ensure(!seen.has(id), '基线快照存在重复任务。'); seen.add(id); for (const key of ['startDate', 'endDate', 'fullStartDate', 'fullEndDate', 'realStartDate', 'realEndDate']) ensure(row[key] == null || typeof row[key] === 'string', '基线日期不是原始字符串或 null。') }
  return rows
}
function byId(rows: JsonObject[], target: unknown) {
  const found = rows.filter(row => same(row.id, target))
  if (found.length !== 1) fail('FORBIDDEN', '基线必须来自当前实际模块的完整目录，不能跨模块猜 ID。')
  return found[0]
}
export async function runProjectSchedule(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateProjectScheduleWorkflow(flow)
  const session = requireSession(supplied), action = flow.projectScheduleAction!, template = flow.projectScheduleTemplate === true, completed: string[] = [], resources: Record<string, unknown> = {}
  let phase = 'identity', pending = false
  const headers = template ? { 'Plan-Type': 'template' } : undefined
  const call: ScheduleCall = async (key, args = {}) => {
    const step = flow.steps.find(step => step.id === key), operation = catalog.operations.find(op => op.id === step?.operationId)
    if (!operation) fail('INVALID_CONTRACT', '项目排期请求了未声明的步骤。')
    phase = key; pending = false
    const transport: Transport = async (url, init) => {
      pending = operation.effect !== 'read'
      const response = await (options.transport ?? request)(url, init)
      if (response.ok && operation.method === 'POST' && key === 'changed') try {
        const row = asObject(parseJson(await response.clone().text()))
        if (row.id != null) resources[action === 'baseline-create' ? 'baselineId' : 'dependencyId'] = String(row.id)
      } catch { /* Preserve creation receipts even if later schema validation fails. */ }
      return response
    }
    // Plan-Type is part of the legacy project/template protocol. Task 3.0
    // uses the task's independently verified project/module context instead.
    const value = await runOperation(ctx, operation, { ...args, ...(template && !operation.route.startsWith('/task/api/') && operation.route !== '/task/v4/template' && operation.route !== '/task/login/authAjax' ? { headers } : {}) }, session, { ...options, transport })
    pending = false; completed.push(key); return value
  }
  const result = (value: unknown) => ({ workflow: flow.id, completedSteps: completed, resources, result: value })
  try {
    const identity = asObject(await call('identity'))
    if (!same(identity.id, session.identity.userId) || !same(asObject(identity.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '排期上下文与 profile 的公司或用户不一致。', 3)
    const cover = template ? asObject(await call('template', { query: { id: input.coverId } })) : null
    if (cover) ensure(same(cover.id, input.coverId), '模板封面身份不匹配。')
    const projectId = scheduleId(cover ? cover.templateKanbanId : input.projectId)
    const loadProject = async () => {
      const project = asObject(await call('project', { query: { id: projectId, isDefault: false } }))
      ensure(same(project.id, projectId) && Object.hasOwn(project, 'coverId') && (template ? same(project.coverId, input.coverId) : project.coverId === null), '普通项目与项目模板必须使用各自的实际资源上下文。')
      return project
    }
    let project = await loadProject()
    const modules = scheduleRows(await call('modules', { query: { kanbanId: projectId } })), matches = modules.filter(row => row.type === 'task' && (input.moduleId == null || same(row.id, input.moduleId)))
    if (matches.length !== 1) throw new RsqError('INVALID_INPUT', '请从当前项目 task 模块中显式选择唯一 moduleId。', 2, { modules: modules.filter(row => row.type === 'task').map(row => ({ id: scheduleId(row.id), name: row.name })) })
    const moduleId = scheduleId(matches[0].id), scope: ScheduleScope = { projectId, moduleId, template, ...(template && { coverId: scheduleId(input.coverId) }) }
    Object.assign(resources, scope)
    const detail = asObject(await call('module', { query: { id: moduleId } }))
    ensure(same(detail.id, moduleId) && detail.type === 'task', '模块详情与已证明的父级成员关系不一致。')
    const authorize = async () => {
      project = await loadProject()
      const fresh = scheduleRows(await call('modules', { query: { kanbanId: projectId } }))
      ensure(fresh.some(row => same(row.id, moduleId) && row.type === 'task'), '写前模块已移出当前项目。')
      let freshCover: JsonObject | null = null
      if (template) {
        freshCover = asObject(await call('template', { query: { id: input.coverId } }))
        ensure(same(freshCover.id, input.coverId) && same(freshCover.templateKanbanId, projectId), '写前模板封面与目标项目关联发生变化。')
        if (freshCover.withEdit !== true) fail('FORBIDDEN', '当前模板封面未授予 withEdit，不能编辑系统模板或他人的模板。')
      }
      return { project, templateCoverFresh: freshCover }
    }
    const base = { ...scope, module: { id: moduleId, name: detail.name, type: 'task' } }
    const loadBaselines = async (step = 'baselines') => baselines(await call(step, { query: { kanbanChildId: moduleId } }))
    const loadCards = async () => {
      const rows = scheduleRows(await call('cards', { query: { kanbanChildId: moduleId } }))
      const seen = new Set<string>()
      for (const row of rows) { const id = scheduleId(row.id); ensure(!seen.has(id) && (row.kanbanChildId == null || same(row.kanbanChildId, moduleId)), '卡片重复或实际属于其他模块。'); seen.add(id) }
      return rows
    }
    if (action.startsWith('dependency-')) return result(await runProjectDependencies(action as DependencyAction, input, scope, call, authorize, resources, session))
    if (action === 'context') return result({ ...base, settings: settings(await call('settings', { query: { kanbanChildId: moduleId } })), baselines: await loadBaselines(), cards: (await loadCards()).map(row => ({ id: scheduleId(row.id), name: row.name })), dependencies: dependencyGraph(await call('dependencies', { query: { planId: moduleId } })), permissions: { editBaseline: asObject(project.editControl).editKanbanGanttBaseline === true, editTemplate: cover ? cover.withEdit === true : null }, relatedCommands: [(template ? 'project template ' : 'project ') + 'schedule tasks list', 'task subtask list'] })
    if (action === 'settings-get' || action === 'settings-set') {
      const before = settings(await call('settings', { query: { kanbanChildId: moduleId } }))
      if (action === 'settings-get') return result({ ...base, settings: before })
      const patch = asObject(input.settings)
      const changed = settings(await call('changed', { body: { kanbanChildId: moduleId, ...patch } }))
      const actual = settings(await call('verifiedSettings', { query: { kanbanChildId: moduleId } })), want = { ...before, ...patch }
      ensure(isDeepStrictEqual(changed, want) && isDeepStrictEqual(actual, want), '甘特设置未独立持久化，或省略的个人设置被覆盖。')
      return result({ ...base, settings: actual })
    }
    const taskPage = async (cardId: string, offset: number, max: number) => scheduleRows(await call('tasks', { body: { key: cardId, planId: moduleId, planViewId: null, showView: 'schedule', groupType: 'card', sortType: null, filter: [], isNeedTemplateField: true, offset, max } }), max)
    if (action === 'tasks-list') {
      const cards = await loadCards(), cardId = input.cardId == null && cards.length === 1 ? scheduleId(cards[0].id) : scheduleId(input.cardId)
      if (!cards.some(row => same(row.id, cardId))) fail('FORBIDDEN', 'cardId 必须来自当前模块卡片目录。')
      const offset = Number(input.offset ?? 0), max = Number(input.max ?? 100), rows = await taskPage(cardId, offset, max)
      ensure(new Set(rows.map(row => taskKey(row.id))).size === rows.length, '同一任务页面出现重复 ID。')
      return result({ ...base, cardId, items: rows, page: { offset, max, nextOffset: rows.length === max ? offset + max : null, total: null }, childCommand: 'task subtask list' })
    }
    const before = await loadBaselines()
    if (action === 'baseline-list') return result({ ...base, items: before })
    const target = action === 'baseline-create' ? null : byId(before, input.baselineId)
    const oldSnapshot = target ? snapshot(await call('snapshot', { query: { baselineId: scheduleId(target.id) } })) : null
    if (action === 'baseline-inspect') {
      const comparisons: JsonObject[] = []
      for (const historic of oldSnapshot!) {
        let current: JsonObject | null = null
        try { current = scheduleTask(await call('task', { query: { id: taskKey(historic.id), module: 'project', siteId: projectId } }), taskKey(historic.id), scope) }
        catch (error) { if (!(error instanceof RsqError) || error.code !== 'NOT_FOUND') throw error }
        comparisons.push({ taskId: historic.id, snapshot: historic, current: current ? taskDates(current) : null, missing: !current, changed: current ? !isDeepStrictEqual(taskDates(historic), taskDates(current)) : null })
      }
      return result({ ...base, baseline: target, tasks: comparisons, dateSemantics: '保留服务端原始日期和上海日历语义；不把历史字符串改成 UTC。' })
    }
    await authorize()
    if (asObject(project.editControl).editKanbanGanttBaseline !== true) fail('FORBIDDEN', 'UI 没有授予 editKanbanGanttBaseline，不能创建、改名或删除基线。')
    // Baseline rows contain only dated visible tasks. Enumerate the same
    // module/card hierarchy over HTTP before capture; never accept an empty
    // snapshot as proof that dated tasks were captured.
    const expectedTasks = new Map<string, JsonObject>()
    if (action === 'baseline-create') {
      const cards = await loadCards(), queue: JsonObject[] = []
      for (const card of cards) for (let offset = 0; ; offset += 200) {
        if (offset >= 10000) fail('CONTEXT_LIMIT', '模块任务超过已核对分页上限，未创建基线。')
        const page = await taskPage(scheduleId(card.id), offset, 200)
        for (const row of page) if (!expectedTasks.has(taskKey(row.id))) { expectedTasks.set(taskKey(row.id), row); queue.push(row) }
        if (page.length < 200) break
      }
      for (let i = 0; i < queue.length; i++) {
        if (queue.length > 1000) fail('CONTEXT_LIMIT', '单次基线快照最多核对 1000 个可见任务，未发送创建。')
        const row = queue[i]
        if (row.hasSubTask === true) for (const sub of scheduleRows(await call('subtasks', { query: { taskId: taskKey(row.id), planId: moduleId, showView: 'schedule', isNeedTemplateField: true } }))) {
          const key = taskKey(sub.id)
          ensure(!expectedTasks.has(key), '子任务层级出现重复或循环，未创建基线。'); expectedTasks.set(key, sub); queue.push(sub)
        }
      }
    } else {
      const fresh = await loadBaselines()
      ensure(isDeepStrictEqual(fresh, before), '基线目录在写前发生变化，请重新读取。')
    }
    const response = await call('changed', action === 'baseline-create' ? { body: { kanbanChildId: moduleId, name: input.name } } : action === 'baseline-rename' ? { body: { id: input.baselineId, name: input.name } } : { query: { id: input.baselineId } })
    const baselineId = action === 'baseline-create' ? scheduleId(asObject(response).id) : scheduleId(input.baselineId)
    resources.baselineId = baselineId
    const actual = await loadBaselines('verifiedBaselines'), other = (rows: JsonObject[]) => rows.filter(row => !same(row.id, baselineId)).sort((a, b) => scheduleId(a.id).localeCompare(scheduleId(b.id)))
    ensure(isDeepStrictEqual(other(actual), other(before)), '其他基线目录发生变化；不自动覆盖并发写入。')
    if (action === 'baseline-remove') {
      ensure(!actual.some(row => same(row.id, baselineId)), '删除后的基线仍在当前模块目录。')
      try { await call('absentSnapshot', { query: { baselineId } }); fail('BUSINESS_ASSERTION_FAILED', '基线快照删除后仍可读取。') }
      catch (error) { if (!(error instanceof RsqError) || error.code !== 'NOT_FOUND') throw error }
      return result({ ...base, baselineId, deleted: true })
    }
    const verified = byId(actual, baselineId)
    ensure(verified.name === input.name, '基线名称未独立持久化。')
    const currentSnapshot = snapshot(await call(action === 'baseline-create' ? 'snapshot' : 'verifiedSnapshot', { query: { baselineId } }))
    if (action === 'baseline-rename') ensure(isDeepStrictEqual(currentSnapshot, oldSnapshot), '基线改名改变了历史快照。')
    else {
      const dated = [...expectedTasks.values()].filter(row => row.realStartDate || row.realEndDate), captured = new Map(currentSnapshot.map(row => [taskKey(row.id), row]))
      ensure(dated.every(row => captured.has(taskKey(row.id)) && isDeepStrictEqual(taskDates(captured.get(taskKey(row.id))!), taskDates(row))), '基线没有完整保存 HTTP 可见任务日期；创建可能已完成，请按 baselineId 核对，禁止重放。')
      ensure(currentSnapshot.every(row => expectedTasks.has(taskKey(row.id))), '基线快照包含当前 HTTP 模块上下文以外的任务。')
    }
    return result({ ...base, baseline: verified, tasks: currentSnapshot })
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('REQUEST_FAILED', '项目排期请求未能完成。', 5)
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown-do-not-retry' : 'check-completed-steps', automaticRollback: false, retry: 'manual-after-readback', ...(failure.details && { cause: failure.details }) })
  }
}
