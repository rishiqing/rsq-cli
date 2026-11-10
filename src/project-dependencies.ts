import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { asObject, RsqError, type JsonObject } from './core.js'
import { ensure, fail, scheduleRows, scheduleTask, taskDates, taskKey, type ScheduleCall, type ScheduleScope } from './project-schedule.js'
import { prepareTaskBusiness, verifyTaskBusiness } from './task-business.js'
import type { Session } from './session.js'

export type DependencyAction = 'dependency-list' | 'dependency-create' | 'dependency-update' | 'dependency-remove' | 'dependency-replace' | 'dependency-task-update'
type Edge = { id?: string; fromId: string; toId: string; type: string; gap: number }
const types = ['start_to_start', 'start_to_end', 'end_to_start', 'end_to_end']
const pair = (edge: Edge) => edge.fromId + '/' + edge.toId
const semantic = (edges: Edge[]) => edges.map(({ fromId, toId, type, gap }) => ({ fromId, toId, type, gap })).sort((a, b) => pair(a).localeCompare(pair(b)))
export function dependencyGraph(value: unknown): Edge[] {
  const ids = new Set<string>(), pairs = new Set<string>()
  const result = scheduleRows(value, 2000).map(row => {
    const edge = { id: taskKey(row.id), fromId: taskKey(row.fromId), toId: taskKey(row.toId), type: String(row.type), gap: Number(row.gap) }
    ensure(types.includes(edge.type) && typeof row.gap === 'number' && Number.isInteger(edge.gap) && edge.gap >= -2147483648 && edge.gap <= 2147483647 && edge.fromId !== edge.toId && !ids.has(edge.id) && !pairs.has(pair(edge)), '依赖图含重复、自引用或无效的约束；不能将它当作完整上下文。')
    ids.add(edge.id); pairs.add(pair(edge)); return edge
  })
  assertDag(result); return result
}
export function assertDag(edges: Edge[]) {
  const degree = new Map<string, number>(), next = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.fromId === edge.toId) fail('INVALID_INPUT', '任务不能依赖自身。')
    degree.set(edge.fromId, degree.get(edge.fromId) ?? 0); degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1)
    next.set(edge.fromId, [...(next.get(edge.fromId) ?? []), edge.toId])
  }
  const queue = [...degree].filter(([, n]) => n === 0).map(([key]) => key)
  for (let i = 0; i < queue.length; i++) for (const key of next.get(queue[i]) ?? []) { const value = degree.get(key)! - 1; degree.set(key, value); if (!value) queue.push(key) }
  if (queue.length !== degree.size) fail('DEPENDENCY_CYCLE', '依赖变更将产生环，未发送写入。')
}
function connected(edges: Edge[], seeds: string[]) {
  const found = new Set(seeds), queue = [...seeds], neighbors = new Map<string, string[]>()
  for (const edge of edges) { neighbors.set(edge.fromId, [...(neighbors.get(edge.fromId) ?? []), edge.toId]); neighbors.set(edge.toId, [...(neighbors.get(edge.toId) ?? []), edge.fromId]) }
  for (let i = 0; i < queue.length; i++) for (const key of neighbors.get(queue[i]) ?? []) if (!found.has(key)) { found.add(key); queue.push(key) }
  if (found.size > 500) fail('CONTEXT_LIMIT', '依赖连通图超过 500 个任务，停止而不使用截断上下文。')
  return [...found].sort()
}
function downstream(edges: Edge[], seeds: string[]) {
  const found = new Set(seeds)
  for (let n = 0; n <= edges.length; n++) { const size = found.size; for (const edge of edges) if (found.has(edge.fromId)) found.add(edge.toId); if (size === found.size) break }
  return edges.filter(edge => found.has(edge.fromId))
}
function day(value: unknown) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}(?:$|[T ])/.test(value)) fail('CONTEXT_MISSING', '任务日期不符合当前甘特的日历格式。')
  const text = (value as string).slice(0, 10), instant = Date.parse(text + 'T00:00:00Z')
  ensure(Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === text, '任务日期不是有效日历日期。')
  return instant / 86400000
}
export function dependencyDates(edges: Edge[], tasks: Map<string, JsonObject>) {
  return edges.map(edge => {
    const pre = tasks.get(edge.fromId), post = tasks.get(edge.toId)
    ensure(pre && post, '约束日期核对缺少实际任务。')
    const startPre = edge.type.startsWith('start_'), startPost = edge.type.endsWith('_start')
    const a = day(pre[startPre ? 'realStartDate' : 'realEndDate']), b = day(post[startPost ? 'realStartDate' : 'realEndDate'])
    const minimumDays = edge.gap + (edge.type === 'end_to_start' ? 1 : edge.type === 'start_to_end' ? -1 : 0)
    return { dependencyId: edge.id ?? null, fromId: edge.fromId, toId: edge.toId, type: edge.type, gap: edge.gap, minimumDays, observedDays: a == null || b == null ? null : b - a, status: a == null || b == null ? 'not-applicable-missing-date' : b - a >= minimumDays ? 'satisfied' : 'pending' }
  })
}
export async function runProjectDependencies(action: DependencyAction, input: JsonObject, scope: ScheduleScope, call: ScheduleCall, authorize: () => Promise<JsonObject>, resources: Record<string, unknown>, session: Session) {
  const load = async (step = 'dependencies') => dependencyGraph(await call(step, { query: { planId: scope.moduleId } }))
  const readTasks = async (keys: string[], step = 'task') => {
    const found = new Map<string, JsonObject>()
    for (const key of keys) found.set(key, scheduleTask(await call(step, { query: { id: key, module: 'project', siteId: scope.projectId } }), key, scope))
    return found
  }
  const taskRelations = async (keys: string[], graph: Edge[], step = 'taskDependencies') => {
    for (const key of keys) {
      const rows = dependencyGraph(await call(step, { query: { taskId: key } })), expected = graph.filter(edge => edge.fromId === key || edge.toId === key)
      ensure(isDeepStrictEqual(semantic(rows), semantic(expected)), '任务前后置目录与模块完整图不一致；上下文可能已经变化。')
    }
  }
  const before = await load()
  if (action === 'dependency-list') {
    const seeds = input.taskId == null ? [...new Set(before.flatMap(edge => [edge.fromId, edge.toId]))] : [taskKey(input.taskId)], keys = connected(before, seeds)
    const tasks = await readTasks(keys)
    if (input.taskId != null) await taskRelations(seeds, before)
    return { ...scope, items: input.taskId == null ? before : before.filter(edge => edge.fromId === input.taskId || edge.toId === input.taskId), tasks: [...tasks.values()].map(row => ({ id: row.id, name: row.name, ...taskDates(row), forbidEdit: row.forbidEdit === true })), constraints: dependencyDates(before.filter(edge => tasks.has(edge.fromId) && tasks.has(edge.toId)), tasks), dateSemantics: '按甘特当前日历日核对；结束到开始额外加一天，开始到结束减一天。未设日期不会由 CLI 补造。' }
  }
  let source: Edge | undefined, proposed: Edge[], affected: string[], changedFrom: string[]
  let body: JsonObject
  if (action === 'dependency-task-update') {
    const taskId = taskKey(input.taskId)
    proposed = before; affected = [taskId]; changedFrom = input.dates == null ? [] : [taskId]; body = { id: taskId, module: 'project', siteId: scope.projectId }
    resources.taskId = taskId
  } else if (action === 'dependency-replace') {
    const taskId = taskKey(input.taskId), direction = String(input.direction)
    if (!['pre', 'post'].includes(direction)) fail('INVALID_INPUT', '批量替换须选择 pre 或 post。')
    const old = before.filter(edge => direction === 'pre' ? edge.toId === taskId : edge.fromId === taskId)
    const links = scheduleRows(input.links, 100), seen = new Set<string>()
    const replacements = links.map(row => {
      const other = taskKey(row.taskId)
      if (other === taskId || seen.has(other)) fail('INVALID_INPUT', '批量依赖不能重复或依赖自身。')
      seen.add(other)
      const existing = old.find(edge => direction === 'pre' ? edge.fromId === other : edge.toId === other)
      return { ...(existing?.id && { id: existing.id }), fromId: direction === 'pre' ? other : taskId, toId: direction === 'pre' ? taskId : other, type: String(row.type ?? existing?.type ?? 'end_to_start'), gap: Number(row.gap ?? existing?.gap ?? 0) }
    })
    proposed = [...before.filter(edge => !old.includes(edge)), ...replacements]
    affected = [...new Set([taskId, ...old.flatMap(edge => [edge.fromId, edge.toId]), ...replacements.flatMap(edge => [edge.fromId, edge.toId])])]
    changedFrom = [...new Set(replacements.map(edge => edge.fromId))]
    body = { taskId, type: direction, list: replacements.map(({ fromId, toId, type, gap }) => ({ fromId, toId, type, gap })) }
  } else if (action === 'dependency-create') {
    const edge: Edge = { fromId: taskKey(input.fromTaskId), toId: taskKey(input.toTaskId), type: String(input.type ?? 'end_to_start'), gap: Number(input.gap ?? 0) }
    if (before.some(row => pair(row) === pair(edge))) fail('DEPENDENCY_EXISTS', '这两个任务已有依赖，请通过目录中的 dependencyId 更新。')
    proposed = [...before, edge]; affected = [edge.fromId, edge.toId]; changedFrom = [edge.fromId]; body = edge
  } else {
    source = before.find(edge => edge.id === input.dependencyId)
    if (!source) fail('FORBIDDEN', '依赖 ID 不在当前模块完整目录中，不能跨项目操作。')
    body = { id: source.id, ...(input.type != null && { type: input.type }), ...(input.gap != null && { gap: input.gap }) }
    proposed = action === 'dependency-remove' ? before.filter(edge => edge !== source) : before.map(edge => edge === source ? { ...edge, ...body } as Edge : edge)
    affected = [source.fromId, source.toId]; changedFrom = action === 'dependency-remove' ? [] : [source.fromId]
    resources.dependencyId = source.id
  }
  ensure(proposed.length <= 2000 && proposed.every(edge => types.includes(edge.type) && Number.isInteger(edge.gap)), '构造的依赖参数不符合当前契约。')
  const pairs = proposed.map(pair)
  if (new Set(pairs).size !== pairs.length) fail('INVALID_INPUT', '不能提交重复依赖。')
  assertDag(proposed)
  const keys = connected([...before, ...proposed], affected), tasks = await readTasks(keys)
  // The current UI exposes dependence editing without a separate dependency
  // editControl flag. It still uses actual task/module context; do not invent
  // a date-edit permission or grant access through unrelated linked cards.
  if (affected.some(key => tasks.get(key)?.forbidEdit === true)) fail('FORBIDDEN', '当前任务处于只读状态，不能编辑依赖。')
  await taskRelations(affected, before)
  const targetProof = await authorize()
  ensure(isDeepStrictEqual(await load(), before), '依赖图在写前发生变化，请重新读取；没有原子 CAS。')
  let taskExpected: JsonObject | null = null
  if (action === 'dependency-task-update') {
    const taskId = taskKey(input.taskId), permissions = asObject(await call('permissions', { query: { taskId, module: 'project', siteId: scope.projectId } })), fresh = (await readTasks([taskId])).get(taskId)!, observed = tasks.get(taskId)!
    ensure(isDeepStrictEqual(taskDates(fresh), taskDates(observed)) && fresh.progress === observed.progress, '任务日期或进度在写前发生变化，未发送更新。')
    const context: JsonObject = { task: fresh, ...targetProof, permissions }, target: JsonObject = { ...input, projectId: scope.projectId }
    if (input.dates != null) Object.assign(body, asObject(prepareTaskBusiness('task-business-dates', target, context, session)?.body))
    if (input.progress != null) Object.assign(body, asObject(prepareTaskBusiness('task-business-update', { ...target, patch: { progress: input.progress } }, context, session)?.body))
    taskExpected = Object.fromEntries(Object.entries(body).filter(([key]) => !['id', 'module', 'siteId'].includes(key)))
    for (const key of ['progress', 'name', 'isDone', 'isClose']) if (!Object.hasOwn(taskExpected, key) && Object.hasOwn(fresh, key)) taskExpected[key] = fresh[key]
  }
  const response = await call('changed', action === 'dependency-remove' ? { query: { id: source!.id } } : { body })
  const after = await load('verifiedDependencies')
  ensure(isDeepStrictEqual(semantic(after), semantic(proposed)), '依赖结果与请求不符，或其他约束被覆盖；禁止自动重放。')
  if (action === 'dependency-create') {
    const created = asObject(response), edge = after.find(row => row.fromId === body.fromId && row.toId === body.toId)
    ensure(edge && taskKey(created.id) === edge.id, '创建回执未能与独立依赖目录中的 ID 对应。'); resources.dependencyId = edge.id
  }
  if (action === 'dependency-update') ensure(after.some(edge => edge.id === source!.id && edge.fromId === source!.fromId && edge.toId === source!.toId), '更新意外改变了依赖身份或两端任务。')
  await taskRelations(affected, after, 'verifiedTaskDependencies')
  const relevant = downstream(after, changedFrom)
  let actual = await readTasks(keys, 'verifiedTask'), checks = dependencyDates(relevant, actual)
  // Only HTTP reads are polled. A timeout never repeats the mutation and never
  // equates a stored edge with completion of asynchronous task-date updates.
  for (let attempt = 0; checks.some(row => row.status === 'pending') && attempt < 5; attempt++) {
    await delay(200 * (attempt + 1))
    actual = await readTasks(keys, 'verifiedTask'); checks = dependencyDates(relevant, actual)
  }
  ensure(isDeepStrictEqual(semantic(await load('verifiedDependencies')), semantic(after)), '日期读回期间依赖图发生变化，不能声称已完成当前约束。')
  if (checks.some(row => row.status === 'pending')) throw new RsqError('ASYNC_READBACK_PENDING', '依赖已保存，HTTP 观察期内任务日期尚未满足约束；请先读取核对，勿重放写入。', 5, { dependencyIds: after.filter(edge => relevant.includes(edge)).map(edge => edge.id), constraints: checks })
  if (taskExpected) verifyTaskBusiness(input, { verifiedTask: actual.get(taskKey(input.taskId)), taskBusiness: { expected: taskExpected } }, 'verifiedTask')
  return { ...scope, items: after, ...(action === 'dependency-remove' && { dependencyId: source!.id, deleted: true }), tasks: [...actual.values()].map(row => ({ id: row.id, name: row.name, before: taskDates(tasks.get(taskKey(row.id))!), after: taskDates(row), changed: !isDeepStrictEqual(taskDates(row), taskDates(tasks.get(taskKey(row.id))!)) })), constraints: checks, observation: 'HTTP 已独立核对依赖和可计算日期约束；缺失日期保留不适用状态，没有协作推送或后台事件完成令牌。' }
}
