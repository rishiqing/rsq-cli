import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { checkAccess } from './access.js'
import type { Workflow } from './workflows.js'

export const replayNavigationActions = ['sidebar-context', 'sidebar-reorder', 'sidebar-star', 'configuration-context', 'configuration-reorder'] as const
export type ReplayNavigationAction = typeof replayNavigationActions[number]
type Route = [string, string, string]
const fail = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '复盘排序上下文缺少精确 ID。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function replayNavigationItems(value: unknown, sidebar: boolean): JsonObject[] {
  if (!Array.isArray(value)) return fail('CONTEXT_MISSING', '复盘导航没有返回列表。')
  const items = value.map(raw => {
    const row = asObject(raw), topic = row.type === 'topic' && String(row.id) === '0'
    if ((!topic && !['day', 'week', 'month'].includes(String(row.type))) || typeof row.name !== 'string' || sidebar && typeof row.isStar !== 'boolean' || topic && row.isStar === true) fail('CONTEXT_MISSING', '复盘列表存在未知类型、名称、星标或虚拟目标复盘。')
    return { id: topic ? '0' : id(row.id), name: row.name, type: row.type, ...(sidebar && { isStar: row.isStar }) }
  })
  if (new Set(items.map(row => row.id)).size !== items.length || items.some((row, i) => row.id === '0' && i !== items.length - 1)) fail('CONTEXT_MISSING', '复盘列表存在重复 ID 或虚拟入口位置不明确。')
  if (sidebar) {
    let unstarred = false
    for (const row of items) { if (!row.isStar) unstarred = true; else if (unstarred) fail('CONTEXT_MISSING', '侧栏星标没有排列在非星标之前。') }
  }
  return items
}
export function planReplayNavigation(action: ReplayNavigationAction, input: JsonObject, items: JsonObject[]): { expected: JsonObject[]; body: JsonObject } {
  const selectedId = id(input.collectionId), movable = items.filter(row => row.id !== '0'), target = movable.find(row => row.id === selectedId)
  if (!target) fail('INVALID_INPUT', '目标复盘集不在当前完整目录中；虚拟目标复盘不可排序或星标。')
  if (action.startsWith('sidebar') && movable.length >= 500) fail('CONTEXT_INCOMPLETE', '侧栏 HTTP 最多返回500项；无法证明完整性时不修改顺序或星标。')
  if (action === 'sidebar-star') {
    if (target!.isStar === input.isStar) return { expected: items, body: {} }
    const others = movable.filter(row => row.id !== selectedId), starred = others.filter(row => row.isStar), normal = others.filter(row => !row.isStar), next = { ...target!, isStar: input.isStar }
    return { expected: [...(input.isStar ? [next, ...starred, ...normal] : [...starred, next, ...normal]), ...items.filter(row => row.id === '0')], body: { id: selectedId, isStar: input.isStar } }
  }
  const sidebar = action === 'sidebar-reorder', group = movable.filter(row => !sidebar || row.isStar === target!.isStar), others = group.filter(row => row.id !== selectedId)
  const frontId = input.frontId == null ? null : id(input.frontId), nextId = input.nextId == null ? null : id(input.nextId)
  const index = frontId == null ? 0 : others.findIndex(row => row.id === frontId) + 1
  if (frontId != null && index === 0 || (others[index]?.id ?? null) !== nextId) fail('CONTEXT_CONFLICT', '排序前后节点必须是移除目标后的相邻节点；个人侧栏只允许同一星标分组。')
  const reordered = [...others.slice(0, index), target!, ...others.slice(index)], remainder = movable.filter(row => !group.some(member => member.id === row.id))
  const expected = sidebar ? [...(target!.isStar ? [...reordered, ...remainder] : [...remainder, ...reordered]), ...items.filter(row => row.id === '0')] : [...reordered, ...items.filter(row => row.id === '0')]
  return { expected, body: { moveId: selectedId, ...(frontId && { frontId }), ...(nextId && { nextId }) } }
}
export function replayNavigationSteps(action: ReplayNavigationAction): Route[] {
  const configuration = action.startsWith('configuration'), route = configuration ? '/task/review/replay/config/collect/list' : '/task/review/replay/collect/list'
  return [['identity', 'GET', '/task/login/authAjax'], ...(configuration ? [['permissions', 'GET', '/task/authority/v3/authorities/company/current']] as Route[] : []), ['list', 'GET', route],
    ...(!action.endsWith('context') ? [['changed', 'PUT', '/task/review/replay/collect/' + (configuration ? 'all/sort' : action === 'sidebar-star' ? 'star' : 'sort')], ['verified', 'GET', route]] as Route[] : [])]
}
export function validateReplayNavigationWorkflow(flow: Workflow) {
  if (!replayNavigationActions.includes(flow.replayNavigationAction!) || flow.outputAdapter || Object.keys(flow.output as object).length) fail('INVALID_CONTRACT', '未知复盘导航业务编排。')
  const expected = replayNavigationSteps(flow.replayNavigationAction!)
  if (flow.steps.length !== expected.length || flow.steps.some((step, i) => { const [name, method, route] = expected[i], op = catalog.operations.find(op => op.id === step.operationId); return !op || step.id !== name || op.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.collectPages || step.transfer || step.authentication })) fail('INVALID_CONTRACT', '复盘导航仅使用固定的身份、列表、权限与独立读回。')
}
export async function runReplayNavigation(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateReplayNavigationWorkflow(flow)
  const action = flow.replayNavigationAction!, session = requireSession(supplied), sidebar = action.startsWith('sidebar'), completed: string[] = [], resources: JsonObject = input.collectionId ? { collectionId: input.collectionId } : {}
  let phase = 'identity', pending = false, written = false
  const call = async (name: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === name), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) return fail('INVALID_CONTRACT', '缺少固定复盘导航步骤。')
    phase = name; pending = false
    const transport: Transport = async (url, init) => { if (name === 'changed') pending = true; return (options.transport ?? request)(url, init) }
    const value = await runOperation(ctx, op, args, session, { ...options, transport })
    if (name === 'changed') written = true
    pending = false; completed.push(name); return value
  }
  const identity = async () => { const who = asObject(await call('identity')); if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '复盘导航身份或当前公司与 profile 不同。') }
  const permission = async () => { if (!sidebar && asObject(await call('permissions')).replayManage !== true) fail('FORBIDDEN', '当前 UI 未授予复盘管理页权限。') }
  const read = async (name: string) => replayNavigationItems(await call(name), sidebar)
  try {
    await identity(); await permission()
    const before = await read('list'), version = hash(before), complete = !sidebar || before.filter(row => row.id !== '0').length < 500
    const result = (items: JsonObject[], changed: boolean) => ({ items, contextVersion: hash(items), complete, scope: sidebar ? 'current-user-sidebar' : 'company-configuration-order', changed, verified: true, groups: sidebar ? { starred: items.filter(row => row.isStar), unstarred: items.filter(row => row.id !== '0' && !row.isStar) } : undefined, virtualTopicMovable: false })
    if (action.endsWith('context')) return { workflow: flow.id, completedSteps: completed, resources, result: result(before, false) }
    if (input.expectedContextVersion != null && input.expectedContextVersion !== version) fail('CONTEXT_CONFLICT', '目录版本已过期；先重新查询导航上下文。')
    const { expected, body } = planReplayNavigation(action, input, before)
    if (isDeepStrictEqual(before, expected)) return { workflow: flow.id, completedSteps: completed, resources, result: result(before, false) }
    await checkAccess(ctx, flow, input, session, options.transport); await identity(); await permission()
    if (!isDeepStrictEqual(await read('list'), before)) fail('CONTEXT_CONFLICT', '写前复盘目录、成员可见性、名称、顺序或星标发生变化；未提交。')
    await call('changed', { body })
    const after = await read('verified')
    if (!isDeepStrictEqual(after, expected)) fail('BUSINESS_ASSERTION_FAILED', '排序或星标没有独立读回预期完整列表；保留实际结果，不重放写入。')
    return { workflow: flow.id, completedSteps: completed, resources, result: { ...result(after, true), concurrency: 'fresh-preflight-and-readback; no-atomic-compare-and-swap' } }
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('REPLAY_NAVIGATION_FAILED', '复盘导航操作失败；先核对资源结果，不自动重放。', 5)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...asObject(cause.details), failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown' : written ? 'accepted-needs-verification' : 'not-sent', automaticallyRetried: false })
  }
}
