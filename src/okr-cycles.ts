import { createHash } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'

const fail = (message: string, code = 'CONTEXT_MISSING'): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : 5) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('目标周期没有返回完整有界列表。')
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('目标周期 ID 不精确。')
export function cycleDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(value)) return fail('周期日期须为 YYYY-MM-DD。', 'INVALID_INPUT')
  const text = value.replaceAll('.', '-'), time = new Date(text + 'T00:00:00Z')
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 10) !== text) return fail('周期日期不存在。', 'INVALID_INPUT')
  return text
}
export function cycleItems(active: unknown, archived: unknown): JsonObject[] {
  const data = asObject(active), a = ['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(key => rows(data[key])), b = rows(asObject(archived).archiveCycleList), seen = new Set()
  for (const [list, isArchived] of [[a, false], [b, true]] as const) for (const row of list) {
    const key = id(row.id)
    if (seen.has(key) || row.isArchived !== isArchived || typeof row.name !== 'string' || !row.name) fail('周期列表重复或归档状态与来源不一致。')
    seen.add(key); cycleDate(row.startDate); cycleDate(row.endDate)
  }
  return [...a, ...b]
}
const snapshot = (row: JsonObject) => ({ id: id(row.id), name: row.name, type: row.type, startDate: cycleDate(row.startDate), endDate: cycleDate(row.endDate), isArchived: row.isArchived, isSyncDingTodo: row.isSyncDingTodo })
const version = (row: JsonObject) => createHash('sha256').update(JSON.stringify(snapshot(row))).digest('hex')
function dateRange(row: JsonObject) {
  const start = cycleDate(row.startDate), end = cycleDate(row.endDate)
  if (start > end) fail('周期结束日期早于开始日期。', 'INVALID_INPUT')
  const span = { month: 1, doubleMonth: 2, quarter: 3, semiannual: 6, year: 12 }[String(row.type)]
  if (row.type !== 'custom') {
    if (!span) fail('未知目标周期类型。', 'INVALID_INPUT')
    const [, month, day] = start.split('-').map(Number), last = new Date(start + 'T00:00:00Z')
    last.setUTCMonth(last.getUTCMonth() + span!);last.setUTCDate(0)
    const expected = last.toISOString().slice(0, 10)
    if (day !== 1 || (month - 1) % span! !== 0 || end !== expected) fail('标准周期须覆盖对应自然月、双月、季度、半年或全年；任意区间请使用 custom。', 'INVALID_INPUT')
  }
  return { startDate: start.replaceAll('-', '.'), endDate: end.replaceAll('-', '.') }
}
export function prepareOkrCycle(kind: string, input: JsonObject, results: JsonObject): JsonObject {
  const action = kind.slice('okr-cycle-'.length), available = cycleItems(results.cycles, results.archived), state: JsonObject = {}
  if (action === 'default-set') {
    const ids = input.cycleIds as string[]
    if (!ids.length || ids.some(key => !available.some(row => same(row.id, key) && row.isArchived === false))) fail('个人默认周期必须明确选择当前公司未归档周期。', 'INVALID_INPUT')
    results.cycleContext = { action, expectedIds: [...ids].sort() }; return { body: { ids: ids.join(',') } }
  }
  if (asObject(results.cycleAuthority).editCycle !== true) throw new RsqError('RESOURCE_FORBIDDEN', '当前账号没有 UI 的目标周期管理权限。', 4, { permission: 'editCycle' })
  let selected: JsonObject | undefined
  if (action !== 'create') {
    selected = available.find(row => same(row.id, input.cycleId))
    if (!selected) fail('周期不属于当前公司可见周期。', 'INVALID_INPUT')
    if (input.expectedVersion != null && input.expectedVersion !== version(selected!)) throw new RsqError('CONTEXT_CONFLICT', '周期已变化，请重新读取后决定操作。', 5)
    if (!['remove', 'impact'].includes(action) && selected!.isArchived !== (action === 'restore')) fail(action === 'restore' ? '只能还原已归档周期。' : '此操作要求未归档周期。', 'INVALID_INPUT')
    state.selectedId = id(selected!.id)
  }
  if (action === 'create' || action === 'change') {
    const patch = action === 'create' ? input : asObject(input.patch), combined = { ...selected, ...patch }
    if (typeof combined.name !== 'string' || !combined.name.trim() || combined.name.length > 200 || /[\x00-\x1f\x7f]/.test(combined.name)) fail('周期名称须为 1–200 个非空字符。', 'INVALID_INPUT')
    if (available.some(row => row.name === combined.name && !same(row.id, selected?.id))) fail('当前公司已有同名周期，包括已归档周期。', 'INVALID_INPUT')
    const dates = dateRange(combined), body: JsonObject = { ...(selected && { id: id(selected.id) }), name: combined.name, type: combined.type, ...dates }
    state.beforeIds = available.map(row => id(row.id)); state.expected = { name: combined.name, type: combined.type, startDate: cycleDate(dates.startDate), endDate: cycleDate(dates.endDate) }
    if (selected && typeof selected.isSyncDingTodo === 'boolean') asObject(state.expected).isSyncDingTodo = selected.isSyncDingTodo
    results.cycleContext = { ...state, action }; return { body }
  }
  if (action === 'impact') return { query: { cycleId: input.cycleId } }
  if (action === 'remove') {
    const count = asObject(results.cycleImpact)
    if (typeof count.hasObj !== 'boolean') fail('删除前目标影响检查缺失。')
    if (count.hasObj && input.deleteObjectives !== true) throw new RsqError('CONTENT_CONFIRMATION_REQUIRED', '删除周期将删除其目标及关联业务，请明确设置 deleteObjectives 后再确认。', 2, { cycleId: input.cycleId, impact: count })
    state.impact = { hasObjectives: count.hasObj, count: count.num, description: count.content }
    results.cycleContext = { ...state, action }; return { query: { id: input.cycleId } }
  }
  if (!['archive', 'restore'].includes(action)) throw new RsqError('INVALID_CONTRACT', '未登记的目标周期业务。', 6)
  results.cycleContext = { ...state, action }; return { body: { id: input.cycleId } }
}
export function verifyOkrCycle(input: JsonObject, results: JsonObject) {
  const state = asObject(results.cycleContext)
  if (state.action === 'default-set') {
    const value = results.verifiedDefault, selected = Array.isArray(value) ? rows(value) : [asObject(value)]
    if (JSON.stringify(selected.map(row => id(row.id)).sort()) !== JSON.stringify(state.expectedIds)) fail('个人默认周期独立读回不一致。', 'BUSINESS_ASSERTION_FAILED')
    return
  }
  const available = cycleItems(results.verifiedCycles, results.verifiedArchived)
  if (state.action === 'create') {
    const added = available.filter(row => !(state.beforeIds as string[]).includes(id(row.id)) && row.name === asObject(state.expected).name)
    if (added.length !== 1) fail('新建周期后无法唯一确认资源 ID，请先按名称核对，勿重复创建。', 'BUSINESS_ASSERTION_FAILED')
    state.selectedId = id(added[0].id)
  }
  const row = available.find(row => same(row.id, state.selectedId))
  if (state.action === 'remove') { if (row) fail('删除周期后仍在当前或归档列表中。', 'BUSINESS_ASSERTION_FAILED'); return }
  if (!row || row.isArchived !== (state.action === 'archive')) fail('周期独立读回归档状态不一致。', 'BUSINESS_ASSERTION_FAILED')
  if (['create', 'change'].includes(String(state.action))) for (const [key, value] of Object.entries(asObject(state.expected))) if (snapshot(row!)[key as keyof ReturnType<typeof snapshot>] !== value) fail('周期独立读回不一致：' + key, 'BUSINESS_ASSERTION_FAILED')
  results.cycleContext = state
}
export function describeOkrCycles(input: JsonObject, results: JsonObject) {
  const available = cycleItems(results.verifiedCycles ?? results.cycles, results.verifiedArchived ?? results.archived), state = asObject(results.cycleContext)
  const selected = available.find(row => same(row.id, state.selectedId ?? input.cycleId)), defaults = results.verifiedDefault ?? results.defaults
  return { items: available.map(row => ({ ...snapshot(row), contextVersion: version(row) })), canManage: asObject(results.cycleAuthority).editCycle === true,
    ...(selected && { cycle: { ...snapshot(selected), contextVersion: version(selected) } }), ...(state.action === 'remove' && { removedCycleId: state.selectedId, impact: state.impact }),
    ...(defaults !== undefined && { personalDefaults: (Array.isArray(defaults) ? rows(defaults) : [asObject(defaults)]).map(snapshot) }),
    completeness: 'current-company-cycle-catalogue', concurrency: 'fresh-http-context-without-server-compare-and-swap' }
}
