import { hiddenOkrStatisticsRow, maskOkrStatistics } from './okr-statistics.js'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

const items = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '统计服务未返回预期列表，停止构造查询。', 5)
  return value.map(asObject)
}
function reportRows(value: unknown, seen = new Set<string>()): JsonObject[] {
  return items(value).flatMap(row => {
    const id = String(row.id)
    if (!/^[1-9][0-9]*$/.test(id) || typeof row.id === 'number' && !Number.isSafeInteger(row.id) || seen.has(id) || seen.size >= 10000) throw new RsqError('CONTEXT_MISSING', '统计行 ID 无效、重复或超过遍历上限。', 5)
    seen.add(id)
    return [row, ...(row.children == null ? [] : reportRows(row.children, seen))]
  })
}
function selectedIds(value: unknown, available: JsonObject[], label: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.some(id => !available.some(row => String(row.id) === id))) throw new RsqError('FORBIDDEN', label + '包含不属于当前公司上下文的 ID。', 4)
  return value.join(',')
}
function companyQuery(input: JsonObject, results: JsonObject) {
  const query: JsonObject = {}
  for (const [key, available, label] of [
    ['userIds', companyDirectoryUsers(results.directory), '成员筛选'],
    ['deptIds', companyDirectoryUnits(results.directory), '部门筛选'],
    ['groupIds', items(results.groups), '小组筛选'],
    ['applicationIds', items(asObject(results.applications).data), '流程应用筛选'],
  ] as const) {
    const selected = selectedIds(input[key], available, label)
    if (selected !== undefined) query[key] = selected
  }
  if ((input.startDate == null) !== (input.endDate == null)) throw new RsqError('INVALID_INPUT', '统计开始和结束日期须成对提供。', 2)
  for (const key of ['startDate', 'endDate']) if (input[key] != null) {
    const value = String(input[key]), date = new Date(value + 'T00:00:00.000Z')
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RsqError('INVALID_INPUT', '统计日期必须是有效的 YYYY-MM-DD 日期。', 2)
  }
  if (input.startDate != null && String(input.startDate) > String(input.endDate)) throw new RsqError('INVALID_INPUT', '统计结束日期不能早于开始日期。', 2)
  for (const key of ['startDate', 'endDate', 'sortKey', 'sortValue']) if (input[key] !== undefined) query[key] = input[key]
  if ((input.sortKey == null) !== (input.sortValue == null)) throw new RsqError('INVALID_INPUT', '排序字段和方向须成对提供。', 2)
  return { ...query, pageNum: input.pageNum ?? 1, pageSize: input.pageSize ?? 20, statisticsFrom: 'team' }
}
function okrQuery(input: JsonObject, results: JsonObject) {
  const cycles = asObject(results.cycles)
  if (!['currentCycleList', 'pastCycleList', 'futureCycleList'].flatMap(key => items(cycles[key])).some(row => String(row.id) === input.cycleId)) throw new RsqError('CONTEXT_MISSING', '所选周期不在当前公司的实际周期列表中。', 2)
  const query: JsonObject = { cycleId: input.cycleId, objectiveType: input.objectiveType }
  if (input.objectiveType === 'person') {
    Object.assign(query, { pageNum: input.pageNum ?? 1, pageSize: input.pageSize ?? 20 })
    if (input.deptId !== undefined) {
      if (!companyDirectoryUnits(results.directory).some(row => row.id === input.deptId)) throw new RsqError('FORBIDDEN', '部门筛选不属于当前公司。', 4)
      query.deptId = input.deptId
    }
  } else query.deptType = input.deptType ?? 'dept'
  for (const key of ['name', 'sortKey', 'sortValue']) if (input[key] !== undefined) query[key] = input[key]
  if ((input.sortKey == null) !== (input.sortValue == null)) throw new RsqError('INVALID_INPUT', '排序字段和方向须成对提供。', 2)
  return query
}

// ChartBizService.initChart rebuilds collections even when they were omitted.
// Preserve the current UI's full configuration when applying a CLI patch.
export const chartMutableFields = ['name', 'dataSource', 'creationType', 'chartType', 'chartStyle', 'sort', 'dimension', 'statsValue', 'filter',
  'isCumulative', 'isSplitMultiValue', 'isAutoFillDate', 'sortList', 'startDate', 'endDate', 'pageSize', 'chartComponentConfig', 'limitCount', 'range', 'yoyType'] as const
const nullableFields = new Set(['chartStyle', 'sort', 'dimension', 'filter', 'startDate', 'endDate', 'chartComponentConfig'])
function sourceForWrite(value: unknown) {
  const source = { ...asObject(value) }
  for (const key of ['projectId', 'projectCollectionId']) if (source[key] === null) delete source[key]
  if (Array.isArray(source.list)) source.list = source.list.map(item => {
    const entry = asObject(item), id = Number(entry.id)
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new RsqError('CONTEXT_UNSUPPORTED', '图表服务要求来源列表 ID 为 32 位整数，当前 ID 无法无损提交。', 5)
    return { ...entry, id }
  })
  return source
}
export function prepareStatistics(action: string, input: JsonObject, results: JsonObject, supplied: Session | null = null): JsonObject {
  if (action === 'statistics-chart-create') {
    const body: JsonObject = { sort: 'valueDefault', ...input }
    // Built-in charts initialize their own dimensions and metric defaults.
    // Custom charts must retain the caller's actual persisted sort.
    results.prepared = { mode: action, expected: { name: body.name, creationType: body.creationType,
      ...(['custom', 'customDatasheet'].includes(String(body.creationType)) ? { sort: body.sort } : {}) } }
    return { body }
  }
  const typed = /^(statistics-company-okr-(?:analyze|detail))-(person|dept)$/.exec(action)
  if (typed) return prepareStatistics(typed[1]!, { ...input, objectiveType: typed[2] }, results, supplied)
  if (action === 'statistics-company-workflow-analyze') return { query: companyQuery(input, results) }
  if (action === 'statistics-company-workflow-detail') {
    const row = items(asObject(results.analysis).list).find(row => String(asObject(row.userInfo).id) === input.userId)
    const detailId = asObject(row?.[String(input.metric)]).detailId
    if (typeof detailId !== 'string' || !detailId) throw new RsqError('CONTEXT_MISSING', '本页未返回所选成员与指标的下钻 ID；请使用相同筛选、页码及有效指标。', 2)
    results.prepared = { detailId, metric: input.metric, userId: input.userId }
    return { query: { id: detailId, statisticsFrom: 'team' } }
  }
  if (action === 'statistics-company-okr-analyze' || action === 'statistics-company-okr-detail') {
    const session = requireSession(supplied), headers = session.method === 'wecom' || session.identity.userFrom?.startsWith('qywx') ? { client: 'qywx' } : {}
    const query = okrQuery(input, results)
    if (action === 'statistics-company-okr-detail') {
      // StatisticsReportConverter does not set ReportVO.type. Like the UI,
      // use the explicitly requested report context and an actual fresh row.
      const selected = reportRows(asObject(results.analysis).data).find(row => String(row.id) === input.rowId && (row.type == null || row.type === input.objectiveType))
      if (!selected) throw new RsqError('CONTEXT_MISSING', '目标行不在本次报表结果中；请保留同一周期、范围和页码。', 2)
      if (hiddenOkrStatisticsRow(selected)) throw new RsqError('FORBIDDEN', '来源统计行没有查看权限，未请求明细。', 4)
      if (input.metric === 'kr' && input.objectiveType !== 'person') throw new RsqError('INVALID_INPUT', 'KR 数下钻仅适用于人员报表。', 2)
      const metric = { number: 'report_objNum', align: 'report_objAlignNum', unalign: 'report_objUnAlignNum', kr: 'report_krNum' }[String(input.metric)]
      if (!metric) throw new RsqError('INVALID_INPUT', '该指标没有报表下钻操作。', 2)
      return { headers, query: { cycleId: input.cycleId, objectiveType: input.objectiveType, objectiveTypeDataId: input.rowId, id: metric,
        ...(input.objectiveType === 'dept' && { deptType: query.deptType }), ...(input.detailName !== undefined && { name: input.detailName }) } }
    }
    return { headers, query }
  }
  if (action === 'statistics-chart-update') {
    const before = asObject(results.before), patch = asObject(input.patch)
    if (!before.id || String(before.id) !== String(input.id)) throw new RsqError('CONTEXT_MISMATCH', '图表详情与操作目标不同。', 5)
    if (!before.creationType || !before.dataSource) throw new RsqError('CONTEXT_MISSING', '图表缺少来源或配置上下文，停止修改。', 5)
    const body: JsonObject = { id: input.id }
    for (const key of chartMutableFields) if (before[key] !== undefined && (before[key] !== null || nullableFields.has(key))) body[key] = before[key]
    Object.assign(body, patch)
    if (patch.dimension && typeof patch.dimension === 'object') body.dimension = { ...asObject(before.dimension), ...asObject(patch.dimension) }
    if (body.dataSource) body.dataSource = sourceForWrite(body.dataSource)
    if (body.dimension === null) body.dimension = { category: [], group: null }
    results.prepared = { mode: action, expected: Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'id')), resources: { chartId: String(input.id) } }
    return { body }
  }
  if (action === 'statistics-chart-layout') {
    if (!Array.isArray(results.before) || !Array.isArray(input.positions)) throw new RsqError('CONTEXT_MISSING', '缺少仪表盘图表列表或布局。', 5)
    const available = new Set(results.before.map(item => String(asObject(item).id))), seen = new Set<string>()
    for (const position of input.positions) {
      const id = String(asObject(position).i)
      if (!available.has(id)) throw new RsqError('CONTEXT_MISMATCH', '布局包含不属于此仪表盘的图表，未发送写入。', 5)
      if (seen.has(id)) throw new RsqError('INVALID_INPUT', '布局中同一图表不能出现多次。', 2)
      seen.add(id)
    }
    results.prepared = { mode: action, expected: input.positions, resources: { dashboardId: String(input.dashboardId) } }
    return { body: { dashboardId: input.dashboardId, positionArray: input.positions } }
  }
  throw new RsqError('INVALID_CONTRACT', '不支持此统计上下文适配。')
}
function matches(actual: unknown, expected: unknown, key = ''): boolean {
  if (expected && typeof expected === 'object') {
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => matches(actual[index], item))
    return Boolean(actual && typeof actual === 'object' && !Array.isArray(actual)) && Object.entries(expected).every(([child, value]) => matches(asObject(actual)[child], value, child))
  }
  if (['startDate', 'endDate'].includes(key) && expected === '') return actual === null || actual === ''
  if (['id', 'fieldId', 'projectId', 'projectCollectionId'].includes(key) && expected !== null && actual !== null) return String(actual) === String(expected)
  return actual === expected
}
export function verifyStatistics(results: JsonObject) {
  const prepared = asObject(results.prepared)
  if (prepared.mode === 'statistics-chart-create') {
    if (String(asObject(results.verified).id) !== String(asObject(results.created).id) || !matches(results.verified, prepared.expected)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '新建图表读回的身份、名称、类型或排序与预期不同，请核对已提交结果。', 5)
  } else if (prepared.mode === 'statistics-chart-update') {
    if (!matches(results.verify, prepared.expected)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '图表读回配置与预期不同，请核对已提交结果。', 5)
  } else if (prepared.mode === 'statistics-chart-layout') {
    if (!Array.isArray(results.verify) || !Array.isArray(prepared.expected) || !prepared.expected.every(position => {
      const { i, ...expected } = asObject(position)
      const chart = (results.verify as unknown[]).find(item => String(asObject(item).id) === String(i))
      return chart && matches(asObject(chart).position, expected)
    })) throw new RsqError('BUSINESS_ASSERTION_FAILED', '图表布局读回与预期不同，请核对已提交结果。', 5)
  } else throw new RsqError('INVALID_CONTRACT', '缺少统计写入断言上下文。')
}

export function describeCompanyOkrStatistics(results: JsonObject) {
  return maskOkrStatistics(results.details == null ? results.analysis : { report: results.analysis, details: results.details })
}
