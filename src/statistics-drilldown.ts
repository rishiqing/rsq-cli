import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { fingerprint } from './fingerprint.js'
import { checkAccess } from './access.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { datasheetRecordsSteps, runDatasheetRecords } from './datasheet-records.js'
import { chartMutableFields } from './statistics.js'
import type { Workflow } from './workflows.js'

export type StatisticsDrilldownAction = 'discover' | 'tasks' | 'risks' | 'workflows' | 'records'
type Route = readonly [string, string, string]
const actions: StatisticsDrilldownAction[] = ['discover', 'tasks', 'risks', 'workflows', 'records']
const chartBase = '/task/v5/kanban/stats/'
const riskTypes = new Set(['riskStatusDistribution', 'riskLevelDistribution', 'riskImpactRangeDistribution', 'riskPrincipalDistribution'])
const workflowTypes = new Set(['workflowOverview', 'workflowProcessInfoStart', 'workflowStepTakeTime', 'workflowStepDelay', 'workflowExecutorEfficiency', 'workflowAuditorEfficiency'])
const invalid = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const numeric = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('CONTEXT_MISSING', '统计上下文缺少精确正整数 ID。')
const opaque = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : invalid('CONTEXT_MISSING', '统计上下文缺少实际资源 ID。')
const rows = (value: unknown, limit = 10000): JsonObject[] => Array.isArray(value) && value.length <= limit ? value.map(asObject) : invalid('CONTEXT_INCOMPLETE', '统计上下文列表缺失或超过遍历上限。')
const data = (value: unknown): unknown => value && typeof value === 'object' && Object.hasOwn(value, 'data') ? asObject(value).data : value
const kindOf = (chart: JsonObject): Exclude<StatisticsDrilldownAction, 'discover'> => riskTypes.has(String(chart.creationType)) ? 'risks' : workflowTypes.has(String(chart.creationType)) ? 'workflows' : chart.creationType === 'customDatasheet' ? 'records' : 'tasks'
function withoutDetailIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDetailIds)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'detailId').map(([key, child]) => [key, withoutDetailIds(child)]))
  return value
}
function graphContext(value: unknown, kind: string): unknown {
  const graph = asObject(withoutDetailIds(value))
  if (kind !== 'records') return graph
  // Loom allocates fresh metric-column IDs on every calculation. Normalize
  // only those declared columns and their references, preserving every value,
  // label and ordering so real source/configuration changes still conflict.
  const columns = asObject(graph.fields).values
  if (!Array.isArray(columns) || columns.some(id => typeof id !== 'string') || new Set(columns).size !== columns.length) invalid('CONTEXT_MISSING', '数据表图表缺少明确且唯一的指标列。')
  const aliases = new Map((columns as string[]).map((id, index) => [id, '$metric' + index]))
  const rewrite = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => rewrite(item, key))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) => [aliases.get(name) ?? name, rewrite(child, name)]))
    return ['valueKey', 'field', 'values'].includes(key) && typeof value === 'string' ? aliases.get(value) ?? value : value
  }
  return rewrite(graph)
}
function chartCells(value: unknown) {
  const found: { selector: string; detailId: string; values: unknown }[] = []
  let nodes = 0
  const visit = (value: unknown, path: string, depth: number) => {
    if (++nodes > 100000 || depth > 30) invalid('CONTEXT_INCOMPLETE', '图表数据过大，未将截断数据当作完整下钻上下文。')
    if (!value || typeof value !== 'object') return
    if (typeof asObject(value).detailId === 'string' && asObject(value).detailId !== '') found.push({ selector: path, detailId: String(asObject(value).detailId), values: withoutDetailIds(value) })
    for (const [key, child] of Object.entries(value)) if (key !== 'detailId') visit(child, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), depth + 1)
  }
  visit(value, '', 0); return found
}
export function statisticsDrilldownSteps(action: StatisticsDrilldownAction): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['project', 'GET', '/task/v1/kanbanCrud'], ['modules', 'GET', '/task/v1/kanbanChildCrud/list'],
    ['collections', 'GET', '/task/v3/kanbanCollection/list'], ['collection', 'GET', '/task/v3/kanbanCollection'], ['collectionProjects', 'GET', '/task/project/collection/project/list'],
    ['dashboards', 'GET', chartBase + 'dashboard/list'], ['charts', 'GET', chartBase + 'chart/list'], ['chart', 'GET', chartBase + 'chart'],
    ...(action === 'tasks' ? [['details', 'GET', '/task/api/statistics/detail/task/list'], ['permissions', 'GET', '/task/api/statistics/detail/totalInfo'], ['nativeTask', 'GET', '/task/api/v3/task']] as Route[] : []),
    ...(action === 'risks' ? [['details', 'GET', '/task/v3/kanban/risk/detail/list'], ['permissions', 'GET', '/task/v3/kanban/risk/detail/totalInfo'], ['nativeRisk', 'GET', '/task/v3/kanban/risk']] as Route[] : []),
    ...(action === 'workflows' ? [['details', 'GET', '/task/workflow/projectStatistics/statisticsDetail'], ['nativeProcess', 'GET', '/task/workflow/process/info/details'], ['nativeStep', 'GET', '/task/workflow/process/info/step']] as Route[] : []),
    ...(action === 'records' ? [['details', 'GET', '/task/mt/loom/detail/{detailId}/recordIds'] as Route, ...datasheetRecordsSteps.map(([name, method, route]): Route => ['table-' + name, method, route])] : [])]
}
export function validateStatisticsDrilldownWorkflow(flow: Workflow) {
  const action = flow.statisticsDrilldownAction
  if (!action || !actions.includes(action) || flow.executor !== 'statistics-drilldown' || flow.effect !== 'write' || flow.command !== 'statistics project drilldown ' + (action === 'discover' ? 'discover' : action + ' list')) invalid('INVALID_CONTRACT', '统计下钻动作、命令和读取副作用不一致。')
  const expected = statisticsDrilldownSteps(action!)
  if (!flow.inputSchema.required?.includes('chartId') || !flow.inputSchema.required?.includes('dashboardId') || flow.steps.length !== expected.length || flow.steps.some((step, index) => {
    const [id, method, route] = expected[index], operation = catalog.operations.find(operation => operation.id === step.operationId)
    return step.id !== id || operation?.method !== method || operation.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.transfer || step.authentication || step.resources || step.assertions || step.expectAbsent || step.collectPages || step.waitBeforeMs || step.readback || step.creationVisibility
  })) invalid('INVALID_CONTRACT', '统计下钻必须保留当前身份、真实项目或项目集、仪表盘、图表和原生资源核对步骤。')
}

export async function runStatisticsDrilldown(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { approved?: boolean; transport?: Transport } = {}) {
  validateStatisticsDrilldownWorkflow(flow)
  const session = requireSession(supplied), action = flow.statisticsDrilldownAction!, completed: string[] = []
  const projectId = input.projectId === undefined ? null : numeric(input.projectId), collectionId = input.collectionId === undefined ? null : numeric(input.collectionId)
  if (Boolean(projectId) === Boolean(collectionId) || action === 'records' && !projectId) invalid('INVALID_INPUT', '必须明确指定一个实际项目或项目集；数据表图表按当前 UI 仅支持实际项目。')
  const dashboardId = opaque(input.dashboardId), chartId = opaque(input.chartId), target: JsonObject = { ...(projectId ? { projectId } : { collectionId }), dashboardId, chartId }, resources: JsonObject = { ...target }
  let phase = 'identity', contextAttempted = false
  const call = async (id: string, args: JsonObject = {}) => {
    phase = id
    const step = flow.steps.find(step => step.id === id)!, operation = catalog.operations.find(operation => operation.id === step.operationId)!
    const value = await runOperation(ctx, operation, args, session, { approved: options.approved, transport: options.transport ?? request })
    completed.push(id); return data(value)
  }
  const readContext = async () => {
    const actor = asObject(await call('identity'))
    if (numeric(actor.id) !== session.identity.userId || numeric(asObject(actor.team).id) !== session.identity.teamId) invalid('IDENTITY_CHANGED', '统计当前身份或公司与 profile 不一致。')
    let projectIds: string[], modules: JsonObject[] = [], owner: JsonObject
    contextAttempted = true
    if (projectId) {
      const project = asObject(await call('project', { query: { id: projectId } }))
      if (numeric(project.id) !== projectId || !Object.hasOwn(project, 'coverId') || project.coverId !== null) invalid('CONTEXT_MISMATCH', '项目统计必须绑定实际普通项目，项目模板不能混用。')
      modules = rows(await call('modules', { query: { kanbanId: projectId } }))
      const stats = modules.filter(module => module.type === 'stats')
      if (stats.length !== 1) invalid('CONTEXT_MISSING', '项目没有唯一可见的新统计模块。')
      owner = { kanbanChildId: numeric(stats[0].id) }; projectIds = [projectId]
    } else {
      if (!rows(await call('collections')).some(item => numeric(item.id) === collectionId)) invalid('FORBIDDEN', '项目集不在当前账号的可见范围。')
      const collection = asObject(await call('collection', { query: { id: collectionId } }))
      if (numeric(collection.id) !== collectionId) invalid('CONTEXT_MISMATCH', '项目集详情与目标不一致。')
      projectIds = rows(await call('collectionProjects', { query: { id: collectionId } }), 1000).map(project => numeric(project.kanbanId))
      if (new Set(projectIds).size !== projectIds.length) invalid('CONTEXT_MISMATCH', '项目集返回重复项目。')
      owner = { projectCollectionId: collectionId }
    }
    if (!rows(await call('dashboards', { query: owner })).some(dashboard => dashboard.id === dashboardId)) invalid('FORBIDDEN', '仪表盘不属于当前目标范围。')
    const listed = rows(await call('charts', { query: { dashboardId } })).find(chart => chart.id === chartId)
    if (!listed) invalid('FORBIDDEN', '图表不属于此仪表盘，未请求其详情。')
    const chart = asObject(await call('chart', { query: { id: chartId } })), source = asObject(chart.dataSource)
    if (chart.id !== chartId || !chart.creationType || projectId && (numeric(source.projectId) !== projectId || source.projectCollectionId != null) || collectionId && (numeric(source.projectCollectionId) !== collectionId || source.projectId != null)) invalid('CONTEXT_MISMATCH', '当前图表、项目及数据源归属不同。')
    if (typeof source.isAll !== 'boolean' || !Array.isArray(source.list)) invalid('CONTEXT_INCOMPLETE', '缺少图表完整来源范围。')
    const sourceIds = rows(source.list).map(item => numeric(item.id))
    if (new Set(sourceIds).size !== sourceIds.length) invalid('CONTEXT_MISMATCH', '图表来源包含重复资源。')
    if (collectionId && !source.isAll) {
      if (sourceIds.some(id => !projectIds.includes(id))) invalid('FORBIDDEN', '图表包含不属于当前可见项目集的来源项目。')
      projectIds = sourceIds
    }
    if (projectId && !source.isAll && sourceIds.some(id => !modules.some(module => numeric(module.id) === id))) invalid('FORBIDDEN', '图表来源模块不属于当前项目。')
    const kind = kindOf(chart), accessCommand = ({ risks: 'project risk get', workflows: 'project workflow instance task inspect', records: 'datasheet describe', tasks: 'statistics project chart get' })[kind]
    await checkAccess(ctx, { ...flow, command: accessCommand }, input, session, options.transport)
    const config = Object.fromEntries(chartMutableFields.filter(key => chart[key] !== undefined).map(key => [key, chart[key]]))
    const contextVersion = fingerprint({ userId: session.identity.userId, teamId: session.identity.teamId, ...target, projectIds, moduleIds: modules.map(module => numeric(module.id)), config, graph: graphContext(chart.graphData, kind) })
    const cells = chartCells(chart.graphData)
    return { chart, kind, contextVersion, cells, projectIds, modules, sourceIds, source }
  }
  try {
    const context = await readContext()
    if (input.contextVersion !== undefined && input.contextVersion !== context.contextVersion) invalid('CONTEXT_CONFLICT', '图表配置、统计值或来源范围已变化，请重新发现下钻单元格。')
    if (action === 'discover') return { workflow: flow.id, resources, completedSteps: completed, result: { ...resources, kind: context.kind, creationType: context.chart.creationType, contextVersion: context.contextVersion,
      fields: asObject(context.chart.graphData).fields, meta: asObject(context.chart.graphData).meta, cells: context.cells.map(({ selector, values }) => ({ selector, values })),
      nextCommand: 'statistics project drilldown ' + context.kind + ' list', proof: { sourceAndDashboardBound: true, detailCacheIsAuthorization: false } } }
    if (context.kind !== action) invalid('CONTEXT_MISMATCH', '下钻命令与当前图表业务类型不同，请使用 discover 返回的 nextCommand。')
    const cell = context.cells.find(cell => cell.selector === input.selector)
    if (!cell) invalid('CONTEXT_MISSING', '所选单元格没有当前有效的下钻上下文。请先 discover，不要提交 detailId。')
    const metric = input.dataType ?? 'numerator', limit = input.limit ?? 30
    if (!['numerator', 'other'].includes(String(metric)) || (action === 'risks' || action === 'records') && metric !== 'numerator' || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) invalid('INVALID_INPUT', '分页数量应为1–100，风险和数据表不支持分子/剩余切换。')
    let cursor: JsonObject = {}
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || input.cursor.length > 5000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) invalid('INVALID_INPUT', '统计分页游标无效。')
      try { cursor = asObject(JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8'))) } catch { invalid('INVALID_INPUT', '统计分页游标无效。') }
      if (cursor.version !== 1 || cursor.contextVersion !== context.contextVersion || cursor.selector !== cell!.selector || cursor.kind !== action || cursor.dataType !== metric || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > 100000) invalid('CONTEXT_CONFLICT', '分页所属图表、筛选、业务类型或统计结果已变化。')
    }
    const next = (fields: JsonObject) => Buffer.from(JSON.stringify({ version: 1, contextVersion: context.contextVersion, selector: cell!.selector, kind: action, dataType: metric, ...fields })).toString('base64url')
    let result: JsonObject
    if (action === 'records') {
      const selected = asObject(await call('details', { path: { detailId: cell!.detailId } })), datasheetId = opaque(selected.datasheetId)
      Object.assign(resources, { datasheetId })
      if (!Array.isArray(selected.recordIds) || selected.recordIds.length > 100000) invalid('CONTEXT_INCOMPLETE', '缺少完整的数据表统计记录集合。')
      const recordIds = (selected.recordIds as unknown[]).map(opaque)
      const inner: Workflow = { ...flow, id: flow.id + '.native-record-selection', command: 'datasheet record list', executor: 'datasheet-records', datasheetRecordsAction: 'list',
        steps: flow.steps.filter(step => step.id.startsWith('table-')).map(step => ({ ...step, id: step.id.slice(6) })) }
      phase = 'native-record-selection'
      const read = await runDatasheetRecords(ctx, inner, { projectId, datasheetId, limit, ...(input.fieldIds !== undefined && { fieldIds: input.fieldIds }), ...(cursor.native !== undefined && { cursor: cursor.native }) }, session,
        { ...options, selection: { recordIds, contextVersion: fingerprint({ chart: context.contextVersion, selector: cell!.selector, dataType: metric }) } })
      completed.push(...read.completedSteps.map(step => 'table-' + step)); Object.assign(resources, read.resources)
      const page = asObject(read.result), pagination = asObject(page.pagination)
      result = { ...page, pagination: { ...pagination, nextCursor: pagination.hasMore ? next({ offset: Number(cursor.offset ?? 0) + Number(pagination.returned), native: pagination.nextCursor }) : null } }
    } else {
      if (cursor.after !== undefined && (typeof cursor.after !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor.after))) invalid('INVALID_INPUT', '统计游标的末项资源 ID 无效。')
      const details = asObject(await call('details', { query: { id: cell!.detailId, ...(action === 'workflows' ? { dataType: metric } : { max: limit, ...(cursor.after !== undefined && { startId: cursor.after }), ...(action === 'tasks' && { dataType: metric }) }) } }))
      if (action === 'workflows' && ![details.name, details.extName, details.type, details.statisticsItemName].some(value => typeof value === 'string' && value)) invalid('STATISTICS_EXPIRED', '流程统计缓存为空或已过期，未把它当成零条成功；请重新发现后调用。')
      const all = details.list == null ? [] : rows(details.list, action === 'workflows' ? 100000 : 100)
      const offset = Number(cursor.offset ?? 0), page = action === 'workflows' ? all.slice(offset, offset + Number(limit)) : all
      if (action !== 'workflows' && page.length > Number(limit)) invalid('BUSINESS_ASSERTION_FAILED', '统计服务返回数量超过本次请求页大小。')
      const pageVersion = action === 'workflows' ? fingerprint(details) : undefined
      if (action === 'workflows' && (cursor.pageVersion !== undefined && cursor.pageVersion !== pageVersion || offset > all.length)) invalid('CONTEXT_CONFLICT', '流程明细的权限过滤结果或内容已变化，请重新分页。')
      const permissions = action === 'workflows' ? { totalInfo: details.totalInfo ?? null } : asObject(await call('permissions', { query: { id: cell!.detailId, ...(action === 'tasks' && { dataType: metric }) } }))
      const pageIds = page.map(row => action === 'tasks' ? opaque(asObject(row.task).id) : action === 'risks' ? numeric(row.id) : numeric(row.processInfoStepId ?? row.processInfoId))
      if (new Set(pageIds).size !== pageIds.length || cursor.after !== undefined && pageIds.includes(String(cursor.after))) invalid('BUSINESS_ASSERTION_FAILED', '当前页重复数据或包含上一页末项，不能证明正确翻页。')
      let allowedRiskModules = context.modules.filter(module => module.type === 'risk-module').map(module => numeric(module.id))
      if (action === 'risks' && collectionId) for (const id of context.projectIds) allowedRiskModules.push(...rows(await call('modules', { query: { kanbanId: id } })).filter(module => module.type === 'risk-module').map(module => numeric(module.id)))
      if (projectId && !context.source.isAll) allowedRiskModules = allowedRiskModules.filter(id => context.sourceIds.includes(id))
      for (const row of page) {
        if (action === 'risks') {
          const native = asObject(await call('nativeRisk', { query: { id: numeric(row.id) } }))
          if (numeric(native.id) !== numeric(row.id) || numeric(native.kanbanChildId) !== numeric(row.kanbanChildId) || !allowedRiskModules.includes(numeric(native.kanbanChildId))) invalid('FORBIDDEN', '风险原生详情与当前来源模块不一致。')
          for (const key of ['name', 'status']) if (row[key] !== undefined && native[key] !== undefined && row[key] !== native[key]) invalid('CONTEXT_CONFLICT', '风险统计缓存与当前原生状态不同，请重新发现。')
        } else if (action === 'tasks') {
          const task = asObject(row.task), native = asObject(await call('nativeTask', { query: { id: opaque(task.id) } })), from = asObject(native.from)
          if (opaque(native.id) !== opaque(task.id) || !context.projectIds.includes(numeric(from.projectId))) invalid('FORBIDDEN', '任务原生详情不属于当前图表来源项目。')
          for (const key of ['name', 'isDone', 'isClose', 'progress']) if (task[key] !== undefined && native[key] !== undefined && task[key] !== native[key]) invalid('CONTEXT_CONFLICT', '任务统计缓存与当前原生状态不同，请重新发现。')
        } else {
          const process = asObject(await call('nativeProcess', { query: { processInfoId: numeric(row.processInfoId) } }))
          if (numeric(process.id) !== numeric(row.processInfoId) || numeric(process.flowAppId) !== numeric(row.applicationId) || !context.projectIds.includes(numeric(process.belongToProjectId))) invalid('FORBIDDEN', '流程原生实例不属于当前来源项目或应用。')
          if (row.processInfoStepId != null) {
            const step = asObject(await call('nativeStep', { query: { stepInfoId: numeric(row.processInfoStepId) } }))
            if (numeric(step.id) !== numeric(row.processInfoStepId) || numeric(step.processInfoId) !== numeric(row.processInfoId) || numeric(step.applicationId) !== numeric(row.applicationId)) invalid('FORBIDDEN', '流程原生步骤与统计行不一致。')
          }
        }
      }
      const hasMore = action === 'workflows' ? offset + page.length < all.length : page.length === Number(limit) && (action !== 'risks' || offset + page.length < Number(permissions.totalValue))
      result = { name: details.name, extName: details.extName, type: details.type, items: page, permissions, pagination: { limit, returned: page.length, hasMore,
        mode: action === 'workflows' ? 'local-over-complete-permission-filtered-http-result' : 'server-start-id', ...(action === 'workflows' && { visibleTotal: all.length }),
        nextCursor: hasMore ? next({ offset: offset + page.length, ...(action === 'workflows' ? { pageVersion } : { after: pageIds.at(-1) }) }) : null },
        proof: { nativeResourcesReadBack: page.length > 0, sourceAndDashboardBound: true, serverPermissionSummaryRead: true, emptyResultDoesNotProveNonemptySuccess: true } }
    }
    const verified = await readContext()
    if (verified.contextVersion !== context.contextVersion || verified.kind !== context.kind) invalid('CONTEXT_CONFLICT', '明细读取期间身份、来源、图表配置或统计值变化，请重新执行。')
    return { workflow: flow.id, resources, completedSteps: completed, result: { ...result!, ...resources, kind: action, selector: cell!.selector, values: cell!.values,
      contextVersion: context.contextVersion, proof: { ...asObject(result!.proof), sourceAndDashboardBound: true, sourceRecheckedAfterRead: true, detailCacheIsAuthorization: false, atomicSnapshot: false } } }
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('UNEXPECTED_ERROR', '统计下钻失败。', 1)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...cause.details, resources: { ...resources, ...asObject(cause.details?.resources) }, completedSteps: completed, failedStep: phase,
      ...(phase === 'native-record-selection' && { innerFailedStep: cause.details?.failedStep, innerCompletedSteps: cause.details?.completedSteps }),
      writeOutcome: contextAttempted ? 'context-reads-may-initialize-module-or-permission-state' : 'business-mutation-not-sent', automaticReplay: false })
  }
}
