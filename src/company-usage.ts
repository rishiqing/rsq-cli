import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('使用统计包含不精确的身份或部门 ID。')
function identity(results: JsonObject, session: Session | null) {
  const expected = requireSession(session).identity, user = asObject(results.user)
  if (id(user.id) !== expected.userId || id(asObject(user.team).id) !== expected.teamId || user.username !== expected.username) fail('使用统计身份或公司已变化。', 'IDENTITY_CHANGED')
  return expected
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) fail('统计日期须为 YYYY-MM-DD。', 'INVALID_INPUT')
  const parsed = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('统计日期不是有效日历日期。', 'INVALID_INPUT')
  return value
}
function range(input: JsonObject) {
  if ((input.startDate == null) !== (input.endDate == null) || input.days != null && input.startDate != null) fail('开始和结束日期须成对提供，且不能与 days 混用。', 'INVALID_INPUT')
  const endDate = input.endDate == null ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : date(input.endDate)
  const startDate = input.startDate == null ? new Date(new Date(endDate + 'T00:00:00Z').getTime() - (Number(input.days ?? 7) - 1) * 86400000).toISOString().slice(0, 10) : date(input.startDate)
  if (startDate > endDate) fail('统计开始日期不能晚于结束日期。', 'INVALID_INPUT')
  return { startDate, endDate }
}
export function prepareCompanyUsage(input: JsonObject, results: JsonObject, session: Session | null) {
  identity(results, session)
  const period = range(input), query: JsonObject = { pageIndex: input.page ?? 1, pageSize: input.pageSize ?? 10, sort: String(input.sortBy ?? 'loginCount') + '_' + String(input.direction ?? 'desc'), startDate: period.startDate.replaceAll('-', '.'), endDate: period.endDate.replaceAll('-', '.') }
  for (const [key, name, available] of [
    ['userIds', 'filterUserIds', companyDirectoryUsers(results.directory)],
    ['departmentIds', 'filterDepartmentIds', companyDirectoryUnits(results.directory)],
  ] as const) if (input[key] != null) {
    if (!Array.isArray(input[key]) || !input[key].length || input[key].some(value => !available.some(row => id(row.id) === value))) fail('使用统计筛选必须来自当前公司实际目录。', 'FORBIDDEN')
    query[name] = input[key].join(',')
  }
  results.prepared = { query, period }
  return { query }
}
export function verifyCompanyUsage(results: JsonObject, session: Session | null) { identity(results, session) }
const metrics = ['loginCount', 'taskCreatedCount', 'taskFinishedCount', 'noteCreatedCount'] as const
export function describeCompanyUsage(input: JsonObject, results: JsonObject, session: Session | null) {
  const who = identity(results, session), common = { context: 'company-usage-statistics', companyId: who.teamId, timeZone: 'Asia/Shanghai', dateBoundaries: 'server-between-start-and-day-after-end-inclusive',
    filterSemantics: { combination: 'union-of-members-and-direct-department-members', descendants: 'not-expanded', source: 'current-company-directory' },
    metrics: { loginCount: 'logins', taskCreatedCount: 'created-tasks', taskFinishedCount: 'distinct-completed-schedule-tasks', noteCreatedCount: 'created-notes' },
    limitations: ['totalPage-is-not-a-record-count', 'task-and-note-sort-may-omit-userId-server-does-not-set-it', 'no-name-to-id-inference', 'server-date-query-uses-inclusive-between-after-end-plus-one-day'] }
  if (results.statistics == null) return { ...common, people: companyDirectoryUsers(results.directory).map(user => ({ id: id(user.id), name: user.name })), departments: companyDirectoryUnits(results.directory), options: { days: [7, 30], defaultDays: 7, sortBy: ['loginCount', 'taskCreatedCount', 'noteCreatedCount'], direction: ['asc', 'desc'] }, relatedCommands: ['statistics company usage list'] }
  const raw = asObject(results.statistics), pages = raw.totalPage
  if (!Number.isSafeInteger(pages) || Number(pages) < 0 || !Array.isArray(raw.data)) fail('使用统计缺少实际页数和数据数组。')
  const seen = new Set<string>(), items = raw.data.map(value => {
    const row = asObject(value), userId = row.userId == null ? null : id(row.userId)
    if (typeof row.name !== 'string' || metrics.some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) < 0) || row.departmentList != null && !Array.isArray(row.departmentList)) fail('使用统计行缺少有效计数或成员信息。')
    if (userId != null) { if (seen.has(userId)) fail('使用统计返回重复成员。'); seen.add(userId) }
    return { userId, name: row.name, ...Object.fromEntries(metrics.map(key => [key, row[key]])), departments: row.departmentList == null ? null : row.departmentList.map(value => { const dept = asObject(value); if (typeof dept.name !== 'string') fail('统计部门缺少名称。'); return { id: id(dept.id), name: dept.name } }) }
  })
  const page = Number(input.page ?? 1), pageSize = Number(input.pageSize ?? 10)
  if (items.length > pageSize) fail('使用统计返回行数超过请求页大小。')
  return { ...common, items, period: asObject(results.prepared).period, filters: { userIds: input.userIds ?? [], departmentIds: input.departmentIds ?? [] }, sort: { by: input.sortBy ?? 'loginCount', direction: input.direction ?? 'desc' },
    pagination: { kind: 'page', page, pageSize, reportedPages: pages, total: null, next: items.length && page < Number(pages) ? page + 1 : null },
    ...(items.some(row => row.userId == null) && { warnings: ['server-omitted-userId-for-sorted-rows-do-not-infer-from-display-name'] }) }
}
