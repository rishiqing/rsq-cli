import { asObject, RsqError, type JsonObject } from './core.js'
import { replayPeriod } from './replay.js'

const fail = (message: string, code = 'CONTEXT_CONFLICT'): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown) => {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return fail('复盘统计上下文缺少有效 ID。', 'CONTEXT_MISSING')
}
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('复盘统计未返回预期列表。', 'CONTEXT_MISSING')
const statuses = new Set(['noNeedWrite', 'committedOnTimeCommit', 'committedSupplementCommit', 'auditedOnTimeCommit', 'auditedSupplementCommit', 'auditedRefused', 'uncommitted',
  'noNeedWriteCommittedOnTimeCommit', 'noNeedWriteCommittedSupplementCommit', 'noNeedWriteAuditedOnTimeCommit', 'noNeedWriteAuditedSupplementCommit', 'noNeedWriteAuditedRefused'])
function permitted(input: JsonObject, results: JsonObject) {
  const permission = results[input.application === 'okr' ? 'okrPermissions' : 'companyPermissions']
  if (asObject(permission).replayStatistics !== true) fail('当前应用未授权复盘统计；不能用可调用的 HTTP 接口绕过页面权限。', 'FORBIDDEN')
}
function cards(results: JsonObject) {
  const value = asObject(results.cards), seen = new Set<string>()
  return (['day', 'week', 'month'] as const).flatMap(type => rows(value[type + 'List']).map(card => {
    const key = id(card.id)
    if (seen.has(key) || card.type !== type) fail('复盘统计目录存在重复 ID 或类型不一致。')
    seen.add(key)
    return card
  }))
}
function collection(input: JsonObject, results: JsonObject) {
  const card = cards(results).find(item => id(item.id) === input.collectionId), current = asObject(results.collection)
  if (!card || id(current.id) !== input.collectionId || current.type !== card.type) fail('所选复盘集不属于当前统计目录，或类型已变化。', 'INVALID_INPUT')
  return current
}
function uniqueMembers(value: unknown) {
  const list = rows(asObject(value).userList), seen = new Set<string>()
  for (const user of list) { const key = id(user.id); if (seen.has(key)) fail('复盘填写人上下文含重复成员。'); seen.add(key) }
  return list
}
function departmentIds(value: unknown, seen = new Set<string>()): Set<string> {
  for (const row of rows(value)) {
    const key = id(row.id)
    if (seen.has(key) || seen.size >= 10000) fail('复盘部门树重复或超过上限。')
    seen.add(key)
    if (row.childList != null) departmentIds(row.childList, seen)
    // Current replay DeptVO uses children; accept the directory's actual shape.
    if (row.children != null) departmentIds(row.children, seen)
  }
  return seen
}
function filter(input: JsonObject, results: JsonObject) {
  if (input.deptId !== undefined && input.groupId !== undefined) fail('部门与小组筛选互斥。', 'INVALID_INPUT')
  const base = asObject(results.members), query: JsonObject = { replayCollectId: input.collectionId }
  if (input.deptId !== undefined) {
    if (!departmentIds(base.deptList).has(String(input.deptId))) fail('部门不在此复盘集实际可选范围内。', 'FORBIDDEN')
    query.deptId = input.deptId
  }
  if (input.groupId !== undefined) {
    if (!rows(base.groupList).some(item => id(item.id) === input.groupId)) fail('小组不在此复盘集实际可选范围内。', 'FORBIDDEN')
    query.groupId = input.groupId
  }
  return query
}
function selectedWriters(input: JsonObject, results: JsonObject) {
  const base = uniqueMembers(results.members), filtered = uniqueMembers(results.filteredMembers ?? results.members)
  if (filtered.some(user => !base.some(item => id(item.id) === id(user.id)))) fail('筛选结果出现当前填写人范围之外的成员。')
  const selected = input.userIds
  if (selected === undefined) return filtered
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(key => typeof key !== 'string' || !filtered.some(user => id(user.id) === key))) return fail('成员筛选不属于本次复盘集、部门或小组的真实填写人。', 'FORBIDDEN')
  return filtered.filter(user => selected.includes(id(user.id)))
}
function query(input: JsonObject, results: JsonObject) {
  const current = collection(input, results), result = filter(input, results)
  const writers = selectedWriters(input, results)
  if (input.userIds !== undefined) result.userIds = writers.map(user => id(user.id)).join(',')
  let year = input.year, month = input.month
  if (input.date !== undefined && year === undefined) {
    replayPeriod(current.type, input.date)
    year = Number(String(input.date).slice(0, 4))
    if (current.type !== 'month') month = Number(String(input.date).slice(5, 7))
  }
  if (!Number.isInteger(year) || Number(year) < 1900 || Number(year) > 9998 || month !== undefined && (!Number.isInteger(month) || Number(month) < 1 || Number(month) > 12)) fail('统计须明确有效年份；月份为 1 至 12。', 'INVALID_INPUT')
  if (current.type === 'month' && month !== undefined) fail('月复盘统计按全年查询，请省略 month。', 'INVALID_INPUT')
  result.year = year
  if (month !== undefined) result.month = month
  results.statQuery = result
  return result
}
function reportRows(input: JsonObject, results: JsonObject, value = results.report) {
  const allowed = new Set(selectedWriters(input, results).map(user => id(user.id))), seen = new Set<string>(), current = collection(input, results)
  return rows(value).map(row => {
    const userId = id(asObject(row.user).id)
    if (!allowed.has(userId) || seen.has(userId)) fail('统计返回了本次填写人筛选之外或重复的成员。')
    seen.add(userId)
    const periods = new Set<string>()
    for (const cell of rows(row.timeDataList)) {
      const key = current.type === 'day' ? [cell.year, cell.month, cell.day] : current.type === 'week' ? [cell.year, cell.week] : [cell.year, cell.month]
      if (key.some(value => !Number.isInteger(value) || Number(value) < 1) || periods.has(key.join('/')) || !statuses.has(String(cell.status))) fail('统计周期或状态不完整、重复或无法识别。', 'RESPONSE_SCHEMA_MISMATCH')
      periods.add(key.join('/'))
    }
    return row
  })
}
function cellFor(input: JsonObject, results: JsonObject, userId: string, value = results.report) {
  const current = collection(input, results), period = replayPeriod(current.type, input.date)
  const row = reportRows(input, results, value).find(row => id(asObject(row.user).id) === userId)
  const cell = row && rows(row.timeDataList).find(cell => Object.entries(period).every(([key, expected]) => cell[key] === expected))
  if (!row || !cell) return fail('本页没有该成员与日期对应的统计单元格；请沿用相同筛选并选择实际页码。', 'INVALID_INPUT')
  return { user: row.user, period, cell }
}
export function prepareReplayStatistics(kind: string, input: JsonObject, results: JsonObject): JsonObject | null {
  permitted(input, results)
  if (kind === 'replay-stat-cards') return {}
  if (kind === 'replay-stat-collection') {
    if (!cards(results).some(item => id(item.id) === input.collectionId)) fail('复盘集不在当前统计目录中。', 'FORBIDDEN')
    return { query: { id: input.collectionId } }
  }
  collection(input, results)
  if (kind === 'replay-stat-members') return { query: { replayCollectId: input.collectionId } }
  if (kind === 'replay-stat-members-filtered') {
    const q = filter(input, results)
    return input.deptId === undefined && input.groupId === undefined ? null : { query: q }
  }
  if (kind === 'replay-stat-report') return { query: { ...query(input, results), page: input.page ?? 1, size: input.size ?? 30 } }
  if (kind === 'replay-stat-reminder-report' || kind === 'replay-stat-verified-report') return { query: { ...query(input, results), page: 1, size: 100 } }
  if (['replay-stat-totals', 'replay-stat-commit-rank', 'replay-stat-like-rank'].includes(kind)) return { query: query(input, results) }
  if (kind === 'replay-stat-remind') {
    const targets = selectedWriters(input, results)
    if (!input.userIds || !targets.length) fail('提醒必须明确选择成员，不支持隐式全员发送。', 'INVALID_INPUT')
    for (const user of targets) {
      const { cell } = cellFor(input, results, id(user.id))
      if (cell.status !== 'uncommitted' || cell.canRemind !== true) fail('所选成员在此周期不满足当前页面的未提交提醒条件。', 'FORBIDDEN')
    }
    return { body: { replayCollectId: input.collectionId, ...replayPeriod(asObject(results.collection).type, input.date), userIds: targets.map(user => id(user.id)).join(',') } }
  }
  return fail('未知复盘统计步骤。', 'INVALID_CONTRACT')
}
export function describeReplayStatistics(input: JsonObject, results: JsonObject) {
  permitted(input, results)
  if (results.collection === undefined) return { application: input.application ?? 'rishiqing', collections: cards(results), completeness: 'current-statistics-catalog' }
  const current = collection(input, results), members = asObject(results.filteredMembers ?? results.members), writers = selectedWriters(input, results)
  const output: JsonObject = { application: input.application ?? 'rishiqing', collection: current, members: { ...members, userList: writers } }
  if (results.report !== undefined) {
    const page = input.page ?? 1, size = input.date !== undefined && input.year === undefined ? 100 : input.size ?? 30, items = reportRows(input, results)
    Object.assign(output, { query: results.statQuery, items, pagination: { page, size, nextPage: items.length === size ? Number(page) + 1 : null, total: null, completeness: 'single-page' } })
    if (input.userId !== undefined) output.detail = cellFor(input, results, String(input.userId))
  }
  if (results.totals !== undefined) {
    const totals = asObject(results.totals)
    if (!Object.keys(asObject(totals.totalData)).length || !Array.isArray(totals.remindTimeList)) fail('复盘统计汇总结构不完整。', 'RESPONSE_SCHEMA_MISMATCH')
    output.totals = totals
  }
  for (const [key, metric] of [['commitRank', 'onTimeCommitPercent'], ['likeRank', 'likeCount']] as const) if (results[key] !== undefined) {
    let previous = Infinity
    const seen = new Set<string>()
    output[key] = rows(results[key]).map(row => {
      const key = id(asObject(row.user).id), value = row[metric]
      if (seen.has(key) || !writers.some(user => id(user.id) === key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > previous || metric === 'onTimeCommitPercent' && value > 100 || metric === 'likeCount' && !Number.isSafeInteger(value)) return fail('排行榜成员、数值或排序与当前上下文不一致。', 'RESPONSE_SCHEMA_MISMATCH')
      seen.add(key); previous = value; return row
    })
  }
  if (Object.hasOwn(results, 'reminded')) {
    const after = reportRows(input, results, results.verifiedReport)
    output.reminder = { acknowledged: true, recipients: writers.map(user => id(user.id)), period: replayPeriod(current.type, input.date), delivery: 'not-verifiable-no-delivery-receipt-api', after }
  }
  return output
}
