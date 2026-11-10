import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { companyDirectoryDepartments } from './contact.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'
export const okrStatisticsActions = ['context', 'charts', 'chart-detail', 'report', 'report-detail', 'overview', 'recent'] as const
export type OkrStatisticsAction = typeof okrStatisticsActions[number]
type Route = [string, string, string]
const base = '/task/okr/statistics'
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, 5) }
const id = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('OKR 统计缺少精确上下文 ID。')
const rows = (value: unknown) => Array.isArray(value) && value.length <= 20000 ? value.map(asObject) : fail('OKR 统计服务未返回有界数组。')
function integer(value: unknown) { const result = Number(value); if (value == null || !Number.isSafeInteger(result) || result < 0) fail('统计分页缺少精确非负整数。'); return result }
/** Match the UI mask rather than exposing the backend's hidden-row payload. */
export function hiddenOkrStatisticsRow(row: JsonObject) {
  return row.isMask === true || row.editControl != null && !asObject(row.editControl).view
}
export function maskOkrStatistics(value: unknown, depth = 0): unknown {
  if (depth > 64) fail('统计响应嵌套超过 64 层。')
  if (Array.isArray(value)) return value.map(row => maskOkrStatistics(row, depth + 1))
  if (value && typeof value === 'object') {
    const row = asObject(value)
    if (hiddenOkrStatisticsRow(row)) return { hidden: true, reason: 'view-permission-denied' }
    return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, maskOkrStatistics(child, depth + 1)]))
  }
  return value
}
export function okrStatisticsSteps(action: OkrStatisticsAction): Route[] {
  const start: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['sidebar', 'GET', '/task/okr/objective/sidebar'], ['cycles', 'GET', '/task/okr/cycle/list'], ['directory', 'GET', '/task/v1/department/list']]
  if (action === 'context') return start
  if (action === 'charts' || action === 'chart-detail') return [...start, ['charts', 'GET', base + '/data'], ...(action === 'chart-detail' ? [['detail', 'GET', base + '/data/item']] as Route[] : [])]
  if (action === 'report' || action === 'report-detail') return [...start, ['report', 'GET', base + '/reportForms'], ...(action === 'report-detail' ? [['detail', 'GET', base + '/reportForms/item']] as Route[] : [])]
  return [...start, ['overview', 'GET', base + (action === 'recent' ? '/overviewAll' : '/overview')]]
}
export function validateOkrStatisticsWorkflow(flow: Workflow) {
  if (!okrStatisticsActions.includes(flow.okrStatisticsAction!)) fail('未知 OKR 统计业务操作。', 'INVALID_CONTRACT')
  const expected = okrStatisticsSteps(flow.okrStatisticsAction!)
  if (flow.executor !== 'okr-statistics' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.collectPages || step.resources || step.transfer || step.authentication || step.readback || step.waitBeforeMs || step.expectAbsent
  })) fail('OKR 统计编排与已核对 HTTP 协议不一致。', 'INVALID_CONTRACT')
}
export async function runOkrStatistics(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateOkrStatisticsWorkflow(flow)
  const session = requireSession(supplied), action = flow.okrStatisticsAction!, completed: string[] = []
  let phase = 'identity'
  const call = async (name: string, args: JsonObject = {}) => {
    const operation = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!operation) fail('未声明 OKR 统计 HTTP 步骤。', 'INVALID_CONTRACT')
    phase = name; const result = await runOperation(ctx, operation, args, session, options); completed.push(name); return result
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources: {}, result })
  try {
    const identity = asObject(await call('identity'))
    if (id(identity.id) !== session.identity.userId || id(asObject(identity.team).id) !== session.identity.teamId) fail('统计身份与当前 profile 不一致。', 'IDENTITY_CHANGED')
    const sidebar = asObject(await call('sidebar'))
    if (asObject(sidebar.editControl).statisticsVisible !== true) fail('当前 OKR 角色没有统计菜单可见权限。', 'FORBIDDEN')
    const cycleData = asObject(await call('cycles')), cycles = ['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(key => rows(cycleData[key])), seen = new Set<string>()
    for (const cycle of cycles) { const key = id(cycle.id); if (seen.has(key)) fail('统计周期目录有重复 ID。'); seen.add(key) }
    const departments = companyDirectoryDepartments(await call('directory', { query: { cliContext: 'fresh' } }))
    if (action === 'context') return done({ cycles: cycles.map(row => ({ id: id(row.id), name: row.name, startDate: row.startDate, endDate: row.endDate, isArchived: row.isArchived })), departments, permissions: { statisticsVisible: true }, objectiveTypes: ['all', 'company', 'dept', 'person'], departmentReportTypes: ['dept', 'deptAndChildDept', 'deptUser', 'deptAndChildDeptUser'], chartDrilldown: 'use an exact point.id from charts get', reportDrilldown: 'use an exact row.id from report get; company directory IDs are not a substitute for an actual report row' })
    if (action === 'recent') return done({ items: maskOkrStatistics(rows(asObject(await call('overview')).data)), scope: 'latest-objectives-in-valid-cycles', sourceObjectiveLimit: 500, note: '服务端最多读取最近 500 个目标；此结果不是公司历史全量总数。' })
    const cycle = cycles.find(row => id(row.id) === input.cycleId)
    if (!cycle) fail('周期不属于当前公司实际可见周期目录。', 'INVALID_INPUT')
    if (action === 'overview') return done({ cycleId: input.cycleId, items: maskOkrStatistics(rows(asObject(await call('overview', { query: { cycleId: input.cycleId } })).data)) })
    const objectiveType = String(input.objectiveType ?? 'all'), common = { cycleId: input.cycleId, objectiveType }, sort = input.sortKey == null ? {} : { sortKey: input.sortKey, sortValue: input.sortValue }, headers = session.method === 'wecom' || session.identity.userFrom?.startsWith('qywx') ? { client: 'qywx' } : {}
    if (action === 'charts' || action === 'chart-detail') {
      const charts = rows(asObject(await call('charts', { query: common })).data), pointIds = new Set<string>(), codes = new Set<string>()
      for (const chart of charts) {
        if (typeof chart.code !== 'string' || codes.has(chart.code)) fail('统计图表 code 缺失或重复。')
        codes.add(chart.code)
        for (const point of rows(chart.data ?? [])) if (typeof point.id === 'string' && point.id) pointIds.add(point.id)
      }
      if (action === 'charts') return done({ ...common, charts: maskOkrStatistics(charts), drilldownIds: [...pointIds] })
      if (!pointIds.has(String(input.pointId))) fail('下钻项必须是当前周期/类型实际图表返回的 point.id。', 'INVALID_INPUT')
      const result = rows(asObject(await call('detail', { query: { ...common, id: input.pointId, ...sort, ...(input.name != null && { name: input.name }) } })).data)
      return done({ ...common, pointId: input.pointId, items: maskOkrStatistics(result), paginated: false, completeServerResult: true })
    }
    if (objectiveType === 'person' && input.deptType != null || objectiveType === 'dept' && input.departmentId != null) fail('人员报表用 departmentId；部门树报表用 deptType，两种筛选不能混用。', 'INVALID_INPUT')
    if (input.departmentId != null && !departments.some(row => id(row.id) === input.departmentId)) fail('部门筛选不在当前公司实际目录中。', 'INVALID_INPUT')
    if (objectiveType === 'dept' && (input.page != null || input.limit != null)) fail('部门报表返回树，服务端不对它分页；不能传人员页码。', 'INVALID_INPUT')
    const reportQuery = { ...common, ...(objectiveType === 'dept' ? { deptType: input.deptType ?? 'dept' } : {}), ...(input.departmentId != null && { deptId: input.departmentId }), ...(input.name != null && { name: input.name }), ...(action === 'report' && sort) }
    const report = async (page: number, limit: number) => {
      const value = asObject(await call('report', { query: { ...reportQuery, ...(objectiveType === 'person' && { pageNum: page, pageSize: limit }) }, ...(Object.keys(headers).length && { headers }) })), items = rows(value.data)
      if (objectiveType === 'dept') return { items, paging: null }
      const ext = asObject(value.ext), total = integer(ext.total), pages = integer(ext.pages)
      if (integer(ext.pageNum) !== page || integer(ext.pageSize) !== limit || pages !== Math.ceil(total / limit) || items.length > limit || items.length > total) fail('人员统计分页回执与实际请求不一致。')
      return { items, paging: { requestedPage: page, pageSize: limit, total, totalPages: pages, nextPage: page < pages ? page + 1 : null } }
    }
    if (action === 'report') {
      const result = await report(Number(input.page ?? 1), Number(input.limit ?? 20))
      return done({ ...common, ...(objectiveType === 'dept' && { deptType: reportQuery.deptType }), items: maskOkrStatistics(result.items), pagination: result.paging, shape: objectiveType === 'dept' ? 'department-tree-without-pagination' : 'person-page' })
    }
    const reportRows: JsonObject[] = [], ids = new Set<string>(); let expectedTotal: number | undefined
    for (let page = 1; page <= 200; page++) {
      const result = await report(page, 100), pending = [...result.items]
      if (result.paging && expectedTotal != null && expectedTotal !== result.paging.total) fail('来源报表在完整分页时发生变化。', 'CONTEXT_CONFLICT')
      if (result.paging) expectedTotal = result.paging.total
      while (pending.length) {
        const row = pending.shift()!, key = id(row.id)
        if (ids.has(key) || ids.size >= 20000) fail('报表目录重复或超过 20000 项。')
        ids.add(key); reportRows.push(row); pending.push(...rows(row.children ?? []))
      }
      if (!result.paging?.nextPage) { if (expectedTotal != null && ids.size !== expectedTotal) fail('来源人员报表分页未完整覆盖实际总条数。'); break }
      if (page === 200) fail('人员报表超过 200 页上限，未调用下钻接口。', 'CONTEXT_LIMIT')
    }
    const selected = reportRows.find(row => id(row.id) === input.rowId)
    if (!selected) fail('下钻对象必须属于同一报表筛选下的真实 row.id。', 'INVALID_INPUT')
    if (hiddenOkrStatisticsRow(selected)) fail('当前来源报表行没有预览权限。', 'FORBIDDEN')
    const detail = asObject(await call('detail', { query: { ...common, objectiveTypeDataId: input.rowId, id: input.metric, ...(objectiveType === 'dept' && { deptType: reportQuery.deptType }), ...sort, ...(input.detailName != null && { name: input.detailName }) }, ...(Object.keys(headers).length && { headers }) }))
    return done({ ...common, rowId: input.rowId, metric: input.metric, items: maskOkrStatistics(rows(detail.data)), paginated: false, completeServerResult: true })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', 'OKR 统计业务未完成。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, cause: original.details, automaticRetry: false, businessMutation: false })
  }
}
