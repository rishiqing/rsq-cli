import { randomUUID } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'
import type { Operation } from './operations.js'
import { usageData, usageDate, usageList, usageRows } from './usage-runtime.js'

const appraisalContext = ['initialized', 'role']
const adapters: Record<string, { route: string | RegExp; context: string[] }> = {
  'okr-report': { route: /^\/task\/okr\/export\/statistics\/(?:reportForms(?:\/item)?|data\/item)$/, context: ['sidebar', 'cycles'] },
  'okr-cycles': { route: '/task/okr/export/objective', context: ['cycles'] },
  'indicator-data': { route: '/task/okr/export/indicator/data', context: ['sidebar', 'indicatorOptions'] },
  'indicator-records': { route: '/task/okr/indicator/database/export', context: ['sidebar'] },
  action: { route: '/task/okr/action/task/export', context: ['views'] },
  'ai-usage': { route: '/task/okr/export/ai/record', context: [] },
  'appraisal-entry': { route: '/task/performance/appraisal/export/entryDownload', context: appraisalContext },
  'appraisal-template': { route: '/task/performance/template/indicator/export', context: appraisalContext },
  'appraisal-assessments': { route: '/task/performance/v4/appraisal/export', context: appraisalContext },
  appraisal: { route: /^\/task\/performance\/content\/(?:monthlyAppraisalData|departmentAppraisalData)\/detailExport$/, context: appraisalContext },
  'appraisal-report': { route: '/task/performance/appraisal/report/export', context: appraisalContext },
  'appraisal-salary-list': { route: '/task/performance/salaryReport/list', context: appraisalContext },
  'appraisal-salary': { route: /^\/task\/performance\/salaryReport\/(?:template\/)?export$/, context: [...appraisalContext, 'salaryReports'] },
  replay: { route: /^\/task\/review\/(?:replay\/collect|stat\/report)\/export$/, context: ['replayCollection'] },
  'project-task-fields': { route: /^\/task\/(?:api\/v3\/template\/projectUsed|v3\/taskTemplate\/kanban(?:Child|Card|Collection)UsedTaskTemplate)$/, context: [] },
  'project-task-filter': { route: '/task/v1/kanbanExport/setFilterCondition', context: ['project', 'fields'] },
  'project-tasks': { route: /^\/task\/v4\/kanban(?:Child|Collection|Card)?\/exportExcel$/, context: ['fields'] },
  gantt: { route: '/task/api/v3/projectTask/gantt/excelExport', context: ['project', 'modules'] },
  'company-statistics': { route: '/task/api/statistics/list/export', context: [] },
  'team-statistics': { route: '/task/workflow/teamStatistics/exportExecute', context: [] },
  'statistics-detail': { route: /^\/task\/(?:api\/statistics\/detail\/export|workflow\/teamStatistics\/exportDetail)$/, context: ['statisticsDetail'] },
}

export function isWebExportAdapter(name: string, op: Operation | undefined, steps: Set<string>) {
  if (!name.startsWith('web-export-') || !op) return false
  const rule = adapters[name.slice('web-export-'.length)]
  return !!rule && (typeof rule.route === 'string' ? rule.route === op.route : rule.route.test(op.route)) && rule.context.every(id => steps.has(id))
}
function denied(message: string): never { throw new RsqError('FORBIDDEN', message, 4) }
function invalid(message: string): never { throw new RsqError('INVALID_INPUT', message, 2) }
const matches = (rows: JsonObject[], value: unknown) => rows.some(row => row.id != null && String(row.id) === value)
function validateExportDates(input: JsonObject) {
  if (input.startDate == null && input.endDate == null) return
  if (input.startDate == null || input.endDate == null) invalid('开始和结束日期必须同时指定。')
  if (usageDate(String(input.startDate).replaceAll('.', '-')) > usageDate(String(input.endDate).replaceAll('.', '-'))) invalid('开始日期不能晚于结束日期。')
}

function projectScope(input: JsonObject, results: JsonObject, checkExportPermission: boolean) {
  if (input.collectionId !== undefined) {
    if (String(usageData(results.collection).id) !== input.collectionId) denied('项目集不在当前可见范围。')
    return String(input.collectionId)
  }
  const project = usageData(results.project)
  if (String(project.id) !== input.projectId || project.coverId !== null) denied('导出范围须绑定当前普通项目。')
  if (checkExportPermission && asObject(project.editControl).exportKanban !== true) denied('项目角色没有导出项目任务权限。')
  if (input.moduleId !== undefined && !usageList(results.modules).some(module => String(module.id) === input.moduleId && module.type === 'task')) {
    denied('此任务模块不属于所选普通项目。')
  }
  if (input.cardId !== undefined && !matches(usageList(results.cards), input.cardId)) denied('此卡片不属于选定任务模块。')
  return String(input.cardId ?? input.moduleId ?? input.projectId)
}

function taskExportQuery(input: JsonObject, results: JsonObject) {
  const id = projectScope(input, results, true)
  const fields = usageList(results.fields).flatMap(row => usageRows(row.fieldList ?? []))
  const selected = input.fieldIds === undefined
    ? fields.filter(field => field.isSelected === true).map(field => String(field.id))
    : String(input.fieldIds).split(',')
  if (selected.some(id => !/^[1-9][0-9]*$/.test(id) || !matches(fields, id))) {
    invalid('导出字段须从该范围的网页字段目录选择。')
  }
  return { id, fieldIds: [...new Set(selected)].join(',') }
}

export function prepareWebExport(name: string, input: JsonObject, results: JsonObject, args: JsonObject): JsonObject | null {
  const kind = name.slice('web-export-'.length)
  validateExportDates(input)
  const query = asObject(args.query), body = asObject(args.body)
  if (kind === 'project-task-fields' || kind === 'gantt') {
    projectScope(input, results, kind !== 'gantt')
    return args
  }
  if (kind === 'project-task-filter') {
    if (input.filters === undefined) return null
    const { id } = taskExportQuery(input, results)
    return { body: { id, filter: input.filters } }
  }
  if (kind === 'project-tasks') {
    const project = taskExportQuery(input, results)
    return { query: { ...project, ...(input.collectionId !== undefined && { sessionKey: randomUUID() }) } }
  }
  if (kind === 'company-statistics') {
    const byGroup = body.projectOrProjectGroupType === 'projectGroup'
    if (byGroup ? body.projectIds !== undefined || body.planIds !== undefined : body.projectGroupIds !== undefined) {
      invalid('根据统计范围分别选择项目、任务模块或项目分组。')
    }
    if (body.statisticsType === 'plan-hour' && body.hourFilterOption === undefined) body.hourFilterOption = 'planHours'
    return { body: { ...body, projectOrProjectGroupType: byGroup ? 'projectGroup' : 'project' } }
  }
  if (kind === 'team-statistics') return { query }
  if (kind === 'statistics-detail') {
    if (!Object.keys(usageData(results.statisticsDetail)).length) {
      throw new RsqError('STATISTICS_EXPIRED', '当前下钻明细已失效。请重新读取统计，再选取对应的下钻项。', 5)
    }
    return { query }
  }
  const sidebar = asObject(usageData(results.sidebar).editControl)
  if (kind === 'okr-report' || kind === 'okr-cycles') {
    if (kind === 'okr-report' && sidebar.statisticsVisible !== true) denied('当前 OKR 角色没有统计菜单可见权限。')
    const cycles = usageData(results.cycles)
    const available = ['currentCycleList', 'pastCycleList', 'futureCycleList'].flatMap(key => usageRows(cycles[key] ?? []))
    for (const selected of String(input.cycleIds ?? input.cycleId).split(',')) {
      if (!matches(available, selected)) denied('周期不在当前公司可见目录。')
    }
    if (input.objectiveType === 'dept' && input.pointId === undefined) {
      if (input.departmentId != null) invalid('人员报表使用 departmentId，部门报表使用 deptType。')
      query.deptType ??= 'dept'
    } else if (input.deptType != null) invalid('deptType 适用于部门报表。')
    return { query }
  }
  if (kind.startsWith('indicator-')) {
    if (sidebar.viewIndicator !== true) denied('当前 OKR 角色没有指标模块权限。')
    if (kind === 'indicator-data' && String(query.indicatorIds).split(',').some(id => !matches(usageList(results.indicatorOptions), id))) {
      denied('选定指标不在当前账号可导出的指标目录。')
    }
    return { query }
  }
  if (kind === 'action') {
    const list = usageList(results.views).filter(view => input.viewId === undefined ? view.isSelected === true : String(view.id) === input.viewId)
    if (list.length !== 1) invalid('从 action view list 选择一个属于当前行动范围的 viewId。')
    if (input.range === 'temp' && list[0].viewType === 'all') invalid('当前视图没有临时任务导出入口。')
    query.viewId = String(list[0].id)
    if (input.type === 'my') query.filterMyType ??= 'executive'
    if (input.type === 'dept') query.filterDeptType ??= 'dept'
    return { query }
  }
  if (kind === 'ai-usage') return { query }
  if (kind.startsWith('appraisal')) {
    if (usageData(results.initialized).hasInit !== true) denied('当前公司未初始化绩效。')
    const permissions = asObject(usageData(results.role).authorities)
    if (kind === 'appraisal-template' && permissions.performanceAppraisalTempManage !== true) denied('当前绩效角色没有模板管理权限。')
    if (kind === 'appraisal-assessments' && permissions.performanceAppraisalDeptDataManage !== true && permissions.performanceAppraisalAllDataManage !== true) denied('当前绩效角色没有考核管理权限。')
    if (kind === 'appraisal-report') {
      if (permissions.performanceReportView !== true) denied('当前绩效角色没有报表查看权限。')
      for (const key of ['startDate', 'endDate']) body[key] = String(body[key]).replaceAll('-', '.')
      body.max ??= 20
      body.offset ??= 1
    }
    if (kind.startsWith('appraisal-salary')) {
      if (permissions.performanceManageSalaryData !== true) denied('当前绩效角色没有薪酬报表权限。')
      if (kind === 'appraisal-salary' && !matches(usageList(results.salaryReports), input.salaryReportId)) denied('报表不在当前公司的薪酬报表目录。')
    }
    return args
  }
  if (kind === 'replay') {
    if (String(usageData(results.replayCollection).id) !== input.collectionId) denied('复盘集与当前导出范围不一致。')
    return args
  }
  throw new RsqError('INVALID_CONTRACT', '未知的网页导出步骤。', 6)
}
