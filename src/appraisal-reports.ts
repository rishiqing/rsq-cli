import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { appraisalAssessmentSteps } from './appraisal-assessments.js'

export type AppraisalReportAction = 'report-context' | 'report-list' | 'report-inspect'
type Route = [string, string, string]
const route = '/task/performance/appraisal/report'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
function check(value: unknown, message: string): asserts value { if (!value) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('报表资源 ID 必须是精确正整数。')
const list = (value: unknown): unknown[] => { check(Array.isArray(value) && value.length <= 10000, '绩效报表未返回有界列表。'); return value }
const fixed = ['object', 'dept', 'leader', 'total']
const periods = { month: 'monthly', quarter: 'quarter', halfYear: 'semester', year: 'yearly' } as const
const totals = ['averageScoreWithScoreCycle', 'averageScoreAllCycle', 'cumulativeScore']
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) invalid('报表日期须为 YYYY-MM-DD。')
  const parsed = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid('报表日期不是有效日历日期。')
  return value as string
}
function range(input: JsonObject) {
  const periodType = String(input.periodType ?? 'month') as keyof typeof periods
  if (!Object.hasOwn(periods, periodType)) invalid('请选择月、季度、半年或年报表。')
  if ((input.startDate == null) !== (input.endDate == null)) invalid('报表开始和结束日期必须成对提供。')
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1
  const size = { month: 1, quarter: 3, halfYear: 6, year: 12 }[periodType], count = { month: 12, quarter: 4, halfYear: 4, year: 3 }[periodType]
  const current = year * 12 + Math.floor(month / size) * size, first = current - (count - 1) * size
  const startDate = input.startDate == null ? `${Math.floor(first / 12)}-${String(first % 12 + 1).padStart(2, '0')}-01` : date(input.startDate)
  const endDate = input.endDate == null ? new Date(Date.UTC(year, Math.floor(month / size) * size + size, 0)).toISOString().slice(0, 10) : date(input.endDate)
  if (startDate > endDate) invalid('报表开始日期不能晚于结束日期。')
  if ((Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + Number(endDate.slice(5, 7)) - Number(startDate.slice(5, 7)) > 1200) invalid('单次报表最多跨 1200 个月，请拆分日期窗口。')
  return { periodType, startDate, endDate }
}
const person = (value: unknown) => { const row = asObject(value); check(typeof row.showName === 'string', '报表成员缺少名称。'); return { id: id(row.id), name: row.showName } }
function page(value: unknown, requestedPage: number, pageSize: number) {
  const raw = asObject(value), columns = list(raw.column)
  check(columns.every(key => typeof key === 'string' && key.length && key.length <= 200) && columns.length <= 1204 && new Set(columns).size === columns.length && isDeepStrictEqual(columns.slice(0, 4), fixed), '报表列缺失、重复或固定列语义不符。')
  const rows = list(raw.tableData).map(value => {
    const cells = list(value).map(asObject), byKey = Object.fromEntries(cells.map(cell => [String(cell.key), cell.value]))
    check(cells.length === columns.length && new Set(cells.map(cell => cell.key)).size === cells.length && columns.every(key => Object.hasOwn(byKey, String(key))), '报表单元格与当前列不符。')
    const departments = list(byKey.dept).map(value => { const dept = asObject(value); check(typeof dept.name === 'string', '报表部门缺少名称。'); return { id: dept.id == null ? null : id(dept.id), name: dept.name } })
    check(byKey.total == null || typeof byKey.total === 'string', '报表合计值不是服务端字符串。')
    return { user: person(byKey.object), departments, leader: byKey.leader == null ? null : person(byKey.leader), total: byKey.total ?? null,
      periods: (columns as string[]).slice(4).map(period => { const cell = asObject(byKey[period]); check(typeof cell.score === 'string' && (cell.level == null || typeof cell.level === 'string'), '报表周期缺少实际分数或等级。'); return { period, score: cell.score, level: cell.level ?? null, appraisalId: cell.detailId == null ? null : id(cell.detailId) } }) }
  })
  check(rows.length <= pageSize && new Set(rows.map(row => row.user.id)).size === rows.length, '报表当前页超过页大小或重复成员。')
  const paging = asObject(raw.page)
  check(Number.isSafeInteger(paging.totalNum) && Number(paging.totalNum) >= 0 && paging.max === pageSize && paging.offset === requestedPage + 1, '报表分页元信息不是已核对的下一页语义。')
  const levels = list(raw.cutlines); check(levels.every(value => typeof value === 'string'), '报表等级图例不是字符串列表。')
  return { columns: columns as string[], rows, levels: levels as string[], reportedUnfilteredTotal: Number(paging.totalNum), reportedNextPage: Number(paging.offset) }
}
export function appraisalReportSteps(action: AppraisalReportAction): Route[] {
  const steps: Route[] = [['reportContext', 'GET', route]]
  if (action !== 'report-context') steps.push(['report', 'GET', route])
  if (action === 'report-list') steps.push(['nextReportPage', 'GET', route])
  if (action === 'report-inspect') steps.push(...appraisalAssessmentSteps('assessment-inspect'))
  return steps
}
export async function runAppraisalReport(action: AppraisalReportAction, input: JsonObject, context: {
  call: (step: string, args?: JsonObject) => Promise<unknown>; role: JsonObject; inspect: (appraisalId: string) => Promise<unknown>; resources: Record<string, unknown>;
}) {
  const { call, role, resources } = context
  if (asObject(role.authorities).performanceReportView !== true) throw new RsqError('RESOURCE_FORBIDDEN', '当前绩效角色没有报表查看权限。', 4, { permission: 'performanceReportView' })
  const period = range(input), total = String(input.total ?? totals[0]); if (!totals.includes(total)) invalid('报表合计方式无效。')
  const query = { columnType: periods[period.periodType], startDate: period.startDate.replaceAll('-', '.'), endDate: period.endDate.replaceAll('-', '.'), total }
  // Discover through the report's real department-management scope. A company
  // address book or template-member list is not evidence of report visibility.
  const discovered: ReturnType<typeof page>['rows'] = [], seen = new Set<string>()
  let columns: string[] = [], exhausted = false
  for (let index = 1; index <= 100; index++) {
    const current = page(await call('reportContext', { query: { ...query, offset: index, max: 100 } }), index, 100)
    if (!columns.length) columns = current.columns
    check(isDeepStrictEqual(columns, current.columns), '报表发现分页期间列发生变化，请重新读取。')
    for (const row of current.rows) { check(!seen.has(row.user.id), '报表发现分页成员重复，可能发生并发排序变化。'); seen.add(row.user.id); discovered.push(row) }
    if (current.rows.length < 100) { exhausted = true; break }
  }
  if (!exhausted) throw new RsqError('PAGINATION_LIMIT', '报表上下文超过 100 页，未将截断结果用于筛选或下钻。请缩小可管理范围。', 5)
  const users = discovered.map(row => row.user), departments = [...new Map(discovered.flatMap(row => row.departments).filter(dept => dept.id != null).map(dept => [dept.id, dept])).values()]
  const common = { context: 'appraisal-reports', period, totalStrategy: total, scoreSemantics: { blank: 'no-assessment', dash: 'unfinished-or-score-hidden-by-permission', numbers: 'server-calculated-not-recomputed', legends: 'current-page-only' },
    filterSemantics: 'member-and-department-intersection; department-includes-descendants-by-server-department-code',
    limitations: ['reported-total-is-before-filtering', 'paging-is-not-a-snapshot', 'period-score-order-has-server-null-comparator-limitations', 'level-order-may-initialize-company-preferences'], relatedCommands: ['appraisal reports context', 'appraisal reports list', 'appraisal reports inspect', 'appraisal assessments inspect'] }
  if (action === 'report-context') return { ...common, users, departments, columns, sortKeys: ['leader', 'total', ...columns.slice(4).flatMap(column => [column + '-score', column + '-level'])], totalStrategies: totals, discoveredUsers: users.length, complete: true }
  const filters: JsonObject = {}
  for (const [key, param, available] of [['userIds', 'filterUser', users], ['departmentIds', 'filterDept', departments]] as const) if (input[key] != null) {
    if (!Array.isArray(input[key]) || !input[key].length || input[key].some(value => !available.some(row => row.id === value))) invalid('报表筛选必须来自当前报表可见上下文：' + key)
    filters[param] = (input[key] as unknown[]).join(',')
  }
  if (action === 'report-inspect') {
    const targetUser = id(input.userId), targetPeriod = String(input.period)
    if (!users.some(user => user.id === targetUser) || !columns.slice(4).includes(targetPeriod)) invalid('下钻对象及周期必须来自当前报表上下文。')
    const selected = page(await call('report', { query: { ...query, filterUser: targetUser, offset: 1, max: 100 } }), 1, 100)
    check(isDeepStrictEqual(columns, selected.columns) && selected.rows.length === 1 && selected.rows[0].user.id === targetUser, '筛选后的报表对象不符或已变化。')
    const cell = selected.rows[0].periods.find(cell => cell.period === targetPeriod)!
    if (cell.appraisalId == null) throw new RsqError('RESOURCE_NOT_FOUND', '该对象在此报表周期没有可下钻的考核。', 4)
    resources.appraisalId = cell.appraisalId
    const detail = asObject(await context.inspect(cell.appraisalId))
    check(id(asObject(asObject(detail.assessment).object).id) === targetUser, '报表下钻考核对象与所选单元格不符。')
    return { ...common, cell, user: selected.rows[0].user, ...detail, independentlyVerified: true }
  }
  const number = (value: unknown, fallback: number, maximum: number) => { const result = value ?? fallback; if (!Number.isSafeInteger(result) || Number(result) < 1 || Number(result) > maximum) invalid('报表页码或页大小无效。'); return Number(result) }
  const requestedPage = number(input.page, 1, 1000000), pageSize = number(input.pageSize, 20, 100)
  if ((input.sortKey == null) !== (input.direction == null)) invalid('报表排序字段和方向必须成对提供。')
  if (input.sortKey != null) {
    const allowed = ['leader', 'total', ...columns.slice(4).flatMap(column => [column + '-score', column + '-level'])]
    if (!allowed.includes(String(input.sortKey)) || !['asc', 'desc'].includes(String(input.direction))) invalid('报表排序字段必须来自实际列与 score/level 维度。')
    filters.sortKey = input.sortKey; filters.sortValue = input.direction
  }
  const request = { ...query, ...filters, offset: requestedPage, max: pageSize }, current = page(await call('report', { query: request }), requestedPage, pageSize)
  check(isDeepStrictEqual(columns, current.columns), '报表列在发现与查询之间发生变化。')
  let next: number | null = null
  if (current.rows.length === pageSize) {
    const following = page(await call('nextReportPage', { query: { ...request, offset: requestedPage + 1 } }), requestedPage + 1, pageSize)
    check(isDeepStrictEqual(columns, following.columns) && !following.rows.some(row => current.rows.some(previous => previous.user.id === row.user.id)), '报表页边界出现重复成员或列变化，请重新读取。')
    if (following.rows.length) next = requestedPage + 1
  }
  for (const row of current.rows) {
    check(seen.has(row.user.id), '报表查询返回不在发现范围内的成员。')
    if (Array.isArray(input.userIds)) check(input.userIds.includes(row.user.id), '后端没有应用报表成员筛选。')
  }
  return { ...common, columns, items: current.rows, levels: current.levels, filters: { userIds: input.userIds ?? [], departmentIds: input.departmentIds ?? [] }, sort: input.sortKey == null ? null : { key: input.sortKey, direction: input.direction },
    pagination: { kind: 'page', page: requestedPage, pageSize, next, total: null, reportedUnfilteredTotal: current.reportedUnfilteredTotal, reportedNextPage: current.reportedNextPage, nextObserved: true } }
}
