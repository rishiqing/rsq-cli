import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { describeAccessContext } from './access.js'

const rows = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '应用初始化缺少预期列表。', 5)
  return value.map(asObject)
}
function identity(input: JsonObject, results: JsonObject, supplied: Session | null) {
  const session = requireSession(supplied), user = asObject(results.identity), team = asObject(user.team)
  if (String(user.id) !== session.identity.userId || (user.team === null ? undefined : String(team.id)) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED', '当前 profile 与服务端公司身份不一致。', 3)
  if (input.teamId !== undefined && input.teamId !== session.identity.teamId) throw new RsqError('ORGANIZATION_MISMATCH', '指定公司与当前 profile 不一致；未发送应用同步或初始化请求。', 4)
  return session.identity
}
function visible(input: JsonObject, results: JsonObject, supplied: Session | null) {
  const user = identity(input, results, supplied), range = asObject(results.synchronized)
  if (range.rangeRadio === 'all' || rows(range.range).some(item => String(item.id) === user.userId)) return
  if (range.rangeRadio !== 'part') throw new RsqError('CONTEXT_MISSING', '应用可见范围无效。', 5)
  const deptIds = new Set(rows(range.rangeDept).map(dept => String(dept.id)))
  let found = false
  const visit = (nodes: JsonObject[], selected = false) => {
    for (const node of nodes) {
      const included = selected || deptIds.has(String(node.id))
      if (included && rows(node.userList ?? []).some(member => String(member.id) === user.userId)) found = true
      visit(rows(node.childList ?? []), included)
    }
  }
  visit(rows(results.departments))
  if (!found) throw new RsqError('FORBIDDEN', '当前成员不在应用可见范围内；请由管理员调整，CLI 不会扩大范围。', 4)
}
export function prepareApplication(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject | null {
  if (kind === 'application-identity' || kind === 'application-sync') { identity(input, results, supplied); return {} }
  if (kind === 'application-visible') { visible(input, results, supplied); return {} }
  if (kind === 'application-performance-init') {
    visible(input, results, supplied)
    const state = asObject(asObject(results.before).data).hasInit
    if (typeof state !== 'boolean') throw new RsqError('CONTEXT_MISSING', '绩效初始化状态无效，未发送初始化写入。', 5)
    return state ? null : {}
  }
  if (kind === 'application-okr-init') {
    const user = identity(input, results, supplied)
    if (!rows(results.members).some(member => String(member.id) === user.userId)) throw new RsqError('FORBIDDEN', '当前成员不在 OKR 可见范围内，未发送初始化写入。', 4)
    return {}
  }
  throw new RsqError('INVALID_CONTRACT', '未知的应用上下文适配。')
}
export function verifyApplication(results: JsonObject, step: string) {
  if (step === 'performanceReady' && asObject(asObject(results[step]).data).hasInit !== true) throw new RsqError('BUSINESS_ASSERTION_FAILED', '绩效初始化后未读回完成状态。', 5)
  if (step === 'okrReady') {
    const cycles = asObject(results[step]), lists = ['currentCycleList', 'pastCycleList', 'futureCycleList'].map(key => rows(cycles[key]))
    if (!lists.some(list => list.length)) throw new RsqError('BUSINESS_ASSERTION_FAILED', 'OKR 初始化后未发现可用周期。', 5)
  }
}
export function describeApplicationAccess(results: JsonObject) {
  const user = asObject(results.identity), team = asObject(user.team)
  return describeAccessContext({ userId: String(user.id), ...(user.team !== null && { teamId: String(team.id) }) }, asObject(results.state), results.functions, asObject(results.permissions))
}
