import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const missing = (message: string): never => { throw new RsqError('CONTEXT_MISSING', message, 5) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const unwrap = (value: unknown) => asObject(value).data
function id(value: unknown): string {
  if ((typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return String(value)
  return missing('流程统计上下文含无效或不精确的 ID。')
}
function list(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length > 10000) return missing('流程统计上下文缺少有界列表。')
  return value.map(asObject)
}
function identity(results: JsonObject, supplied: Session | null) {
  const session = requireSession(supplied), user = asObject(results.user)
  if (!same(user.id, session.identity.userId) || !same(asObject(user.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '流程统计上下文与当前账号或公司不一致。', 3)
  return session
}
function application(input: JsonObject, results: JsonObject) {
  const source = asObject(unwrap(results.source))
  if (!same(source.id, input.applicationId)) return missing('流程应用详情与所选应用不一致。')
  if (asObject(source.editControl).enterStatistics !== true) throw new RsqError('FORBIDDEN', '当前流程不允许进入统计页：enterStatistics。', 4)
  return source
}
function steps(results: JsonObject) {
  const rows = list(unwrap(results.steps)), ids = rows.map(row => id(row.id))
  if (new Set(ids).size !== ids.length) return missing('流程统计步骤目录包含重复 ID。')
  return rows
}
function users(results: JsonObject) {
  const directory = companyDirectoryUsers(results.directory), range = asObject(results.range)
  if (!['all', 'part'].includes(String(range.rangeRadio))) return missing('流程成员可见范围类型未知。')
  if (range.rangeRadio === 'all') return directory
  const members = new Set(list(range.range).map(row => id(row.id))), departments = new Set(list(range.rangeDept).map(row => id(row.id)))
  const found = new Set<string>()
  function visit(nodes: JsonObject[], inherited = false, depth = 0) {
    if (depth > 50 || found.size > 10000) return missing('流程成员可见部门树超出遍历界限。')
    for (const node of nodes) {
      const selected = inherited || departments.has(id(node.id))
      if (departments.has(id(node.id))) found.add(id(node.id))
      if (selected) for (const user of list(node.userList)) members.add(id(user.id))
      visit(list(node.childList), selected, depth + 1)
    }
  }
  // UI expands explicitly visible departments, including descendant members.
  visit(list(results.directory))
  if ([...departments].some(key => !found.has(key)) || [...members].some(key => !directory.some(user => id(user.id) === key))) return missing('流程可见范围不在当前公司目录中；先刷新上下文。')
  return directory.filter(user => members.has(id(user.id)))
}
const efficiencyKeys = ['name', 'minTime', 'maxTime', 'avgTime', 'delayRate', 'oneShotRate']
const executeKeys = ['assignee', 'stepCount', 'delayRate', 'delayDuration', 'delayCommitRate', 'delayCommitDuration']
export function validateWorkflowStatisticsInput(input: JsonObject) {
  if ((input.startDate === undefined) !== (input.endDate === undefined)) invalid('流程统计开始和结束日期须成对提供。')
  for (const key of ['startDate', 'endDate']) if (input[key] !== undefined) {
    const text = String(input[key]), date = new Date(text + 'T00:00:00.000Z')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) invalid('流程统计日期必须是有效 YYYY-MM-DD 日期。')
  }
  if (input.startDate !== undefined && String(input.startDate) > String(input.endDate)) invalid('流程统计开始日期不能晚于结束日期。')
  if ((input.sortKey === undefined) !== (input.sortValue === undefined)) invalid('流程统计排序字段与方向须成对提供。')
}
export function prepareWorkflowStatistics(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject {
  identity(results, supplied)
  validateWorkflowStatisticsInput(input)
  if (kind === 'workflow-statistics-applications') return { query: { statisticsFrom: 'workflow' } }
  if (kind === 'workflow-statistics-source') {
    if (!list(unwrap(results.applications)).some(row => same(row.id, input.applicationId))) throw new RsqError('FORBIDDEN', '所选流程应用不在当前公司独立流程目录中。', 4)
    return { query: { id: input.applicationId } }
  }
  application(input, results)
  if (kind === 'workflow-statistics-steps') return { query: { applicationId: input.applicationId, isContainAutoStep: false } }
  steps(results); const available = users(results)
  if (input.efficiencyUserId !== undefined && !available.some(user => same(user.id, input.efficiencyUserId))) throw new RsqError('FORBIDDEN', '执行人不在流程应用的实际可见范围内。', 4)
  if (input.stepId !== undefined && !steps(results).some(step => same(step.id, input.stepId))) throw new RsqError('FORBIDDEN', '步骤不属于所选流程应用的当前步骤目录。', 4)
  if (kind === 'workflow-statistics-indicator') return { query: { applicationId: input.applicationId } }
  if (!['workflow-statistics-efficiency', 'workflow-statistics-execute'].includes(kind)) throw new RsqError('INVALID_CONTRACT', '未知流程统计上下文适配。', 6)
  const keys = kind.endsWith('-efficiency') ? efficiencyKeys : executeKeys
  if (input.sortKey !== undefined && !keys.includes(String(input.sortKey))) invalid('排序字段不属于当前流程统计表。')
  const query: JsonObject = { applicationId: input.applicationId, pageNum: input.pageNum ?? 1, pageSize: input.pageSize ?? 50 }
  for (const key of ['sortKey', 'sortValue', 'efficiencyUserId', 'stepId']) if (input[key] !== undefined) query[key] = input[key]
  for (const key of ['startDate', 'endDate']) if (input[key] !== undefined) query[key] = String(input[key]).replaceAll('-', '.')
  results.prepared = { kind: kind.endsWith('-efficiency') ? 'efficiency' : 'execute', query }
  return { query }
}
function page(input: JsonObject, results: JsonObject) {
  const report = asObject(unwrap(results.report)), prepared = asObject(results.prepared), query = asObject(prepared.query), rows = list(report.list)
  const text = String(report.total)
  if (!/^(0|[1-9][0-9]*)$/.test(text) || typeof report.total === 'number' && !Number.isSafeInteger(report.total)) return missing('流程统计总数无效或丢失精度。')
  const total = BigInt(text), requestedPage = Number(query.pageNum), pageSize = Number(query.pageSize)
  if (report.pageSize !== pageSize || !Number.isSafeInteger(report.pageNum) || Number(report.pageNum) < 0 || rows.length > pageSize || BigInt(rows.length) > total) return missing('流程统计分页结果与请求不一致。')
  if (prepared.kind === 'efficiency') {
    const seen = new Set<string>(), available = steps(results)
    for (const row of rows) {
      const key = id(row.id)
      if (seen.has(key) || !available.some(step => same(step.id, key))) return missing('效率统计出现不属于当前应用或重复的步骤。')
      seen.add(key)
    }
  }
  const totalPages = (total + BigInt(pageSize) - 1n) / BigInt(pageSize)
  return { kind: prepared.kind, rows, total: report.total, requestedPage, pageSize, servicePageNum: report.pageNum,
    totalPages: totalPages <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totalPages) : String(totalPages),
    nextPage: BigInt(requestedPage) < totalPages && requestedPage < 1000000 ? requestedPage + 1 : null,
    pageNumMeaning: '服务端 pageNum 实际保存总页数；使用 requestedPage/nextPage 翻页。',
    dateBasis: prepared.kind === 'efficiency' ? 'process.date_created' : 'process_info_step.start_time',
    ...(prepared.kind === 'execute' && { assigneeMeaning: 'assignee 是显示名，不能据此推断成员 ID 或与同名成员合并。' }),
    query: { ...input, applicationId: id(input.applicationId) } }
}
export function describeWorkflowStatistics(input: JsonObject, results: JsonObject, supplied: Session | null) {
  const session = identity(results, supplied), source = application(input, results)
  return { application: { id: id(source.id), name: source.name, enterStatistics: true }, identity: session.identity,
    steps: steps(results).map(row => ({ id: id(row.id), name: row.name })),
    executors: users(results).map(user => ({ id: id(user.id), showName: user.showName })),
    indicators: { ...asObject(unwrap(results.indicators)), avgTimeUnit: 'milliseconds', delayRateUnit: 'percent', filters: 'all-visible-processes-no-date-or-member-filter' },
    ...(results.report !== undefined && { report: page(input, results) }),
    semantics: ['四项指标是全应用范围，不随效率/执行表的日期与人员筛选变化。', '效率和执行表按不同日期字段筛选；百分比和中文时长保留服务端原值，- 不视为零。', '上下文 GET 会保存应用偏好并可能初始化或同步流程成员；不自动重放。', '当前应用表没有专用明细下钻 HTTP；公司级统计使用 statistics company workflow 命令的真实明细。'] }
}
