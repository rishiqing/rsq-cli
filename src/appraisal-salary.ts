import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import { salaryCheck as check, salaryInvalid as invalid, salaryId as id, salaryRows as rows, salaryName as name, salaryPeriod, salaryFields, salaryGrid, salaryValue, salaryFormula, type SalaryField } from './appraisal-salary-data.js'
import { salaryImportPlan } from './appraisal-salary-import.js'
import { saveSalaryCells } from './appraisal-salary-mutation.js'

export type AppraisalSalaryAction = 'salary-context' | 'salary-reports' | 'salary-inspect' | 'salary-create' | 'salary-configure' | 'salary-remove' |
  'salary-fields' | 'salary-field-create' | 'salary-field-configure' | 'salary-field-show' | 'salary-field-move' | 'salary-field-remove' | 'salary-cells' | 'salary-cells-set' | 'salary-cells-previous' | 'salary-cells-copy' | 'salary-import-preview' | 'salary-import-save'
type Route = [string, string, string]
export function appraisalSalarySteps(action: AppraisalSalaryAction): Route[] {
  const step = (id: string, method: string, path: string): Route => [id, method, '/task/performance' + path]
  const base: Route[] = [step('reports', 'GET', '/salaryReport/list')]
  if (['salary-context', 'salary-create', 'salary-configure'].includes(action)) base.push(['directory', 'GET', '/task/v1/department/list'])
  if (action === 'salary-context' || action === 'salary-reports') return base
  if (action === 'salary-create') return [...base, step('createdReport', 'POST', '/salaryReport'), step('verifiedReports', 'GET', '/salaryReport/list'), step('verifiedReport', 'GET', '/salaryReport'), step('verifiedFields', 'GET', '/salaryField')]
  base.push(step('report', 'GET', '/salaryReport'))
  if (action === 'salary-configure') return [...base, step('freshReport', 'GET', '/salaryReport'), step('changed', 'PUT', '/salaryReport'), step('verifiedReport', 'GET', '/salaryReport'), step('verifiedReports', 'GET', '/salaryReport/list')]
  if (action === 'salary-remove') return [...base, step('freshReport', 'GET', '/salaryReport'), step('changed', 'DELETE', '/salaryReport'), step('verifiedReports', 'GET', '/salaryReport/list')]
  base.push(step('fields', 'GET', '/salaryField'))
  if (action === 'salary-fields') return base
  if (action.startsWith('salary-field-')) {
    if (action === 'salary-field-move') base.push(step('nameHeader', 'GET', '/salaryReport/data'))
    base.push(step('freshFields', 'GET', '/salaryField'))
    const method = action === 'salary-field-create' ? 'POST' : action === 'salary-field-remove' ? 'DELETE' : 'PUT', suffix = action === 'salary-field-move' ? '/sort' : action === 'salary-field-show' ? '/show' : ''
    return [...base, step(action === 'salary-field-create' ? 'createdField' : 'changed', method, '/salaryField' + suffix), step('verifiedFields', 'GET', '/salaryField')]
  }
  base.push(step('sheet', 'GET', '/salaryReport/data'))
  if (action === 'salary-inspect' || action === 'salary-cells' || action === 'salary-import-preview') return base
  if (action === 'salary-cells-previous' || action === 'salary-cells-copy') base.push(step('previousSheet', 'GET', '/salaryReport/data'), step('previousValues', 'PUT', '/salaryReport/data/sync'))
  if (action === 'salary-cells-previous') return base
  return [...base, step('freshReport', 'GET', '/salaryReport'), step('freshFields', 'GET', '/salaryField'), step('freshSheet', 'GET', '/salaryReport/data'), step('changed', 'PUT', '/salaryReport/data'), step('verifiedSheet', 'GET', '/salaryReport/data'), step('verifiedFields', 'GET', '/salaryField')]
}
type Report = { id: string; name: string; userIds: string[]; departmentIds: string[] }
const reportList = (value: unknown) => { const list = rows(value).map(row => { check(typeof row.name === 'string', '薪酬报表缺少名称。'); return { id: id(row.id), name: row.name } }); check(new Set(list.map(row => row.id)).size === list.length, '薪酬报表列表重复。'); return list }
function reportDetail(value: unknown, target: string, listing: { id: string; name: string }): Report {
  const row = asObject(value); check(id(row.id) === target && row.name === listing.name, '薪酬报表详情与本公司列表不符。')
  const userIds = rows(row.users).map(row => id(row.id)), departmentIds = rows(row.depts).map(row => id(row.id))
  check(new Set(userIds).size === userIds.length && new Set(departmentIds).size === departmentIds.length, '薪酬报表对象配置重复。')
  return { id: target, name: String(row.name), userIds: userIds.sort(), departmentIds: departmentIds.sort() }
}
const publicFields = (fields: SalaryField[]) => fields.map(field => ({ ...field, expression: field.type === 'formula' ? field.formula?.text.replace(/\$_field_([1-9][0-9]*)_\$/g, (_, id: string) => '{{' + id + '}}') ?? null : null,
  editableCells: field.type === 'num' && field.isShow, definitionEditable: !field.isSystem, inactiveFormulaRetained: field.type !== 'formula' && field.formula != null }))
const config = (field: SalaryField) => ({ name: field.name, type: field.type, formula: field.type === 'formula' ? field.formula && { text: field.formula.text, factors: field.formula.factors } : null })
export async function runAppraisalSalary(action: AppraisalSalaryAction, input: JsonObject, context: {
  call: (step: string, args?: JsonObject) => Promise<unknown>; role: JsonObject; resources: Record<string, unknown>;
}) {
  const { call, role, resources } = context
  if (asObject(role.authorities).performanceManageSalaryData !== true) throw new RsqError('RESOURCE_FORBIDDEN', '当前绩效角色没有管理薪酬报表权限。', 4, { permission: 'performanceManageSalaryData' })
  const beforeList = reportList(await call('reports')), period = salaryPeriod(input)
  const common = { context: 'appraisal-salary', period, limitations: ['report-list-may-initialize-company-example-report', 'field-settings-are-report-scoped', 'no-server-cas-or-write-retry', 'formula-values-are-calculated-by-server', 'body-row-and-column-coordinates-are-not-resource-ids'], relatedCommands: ['appraisal salary context', 'appraisal salary reports inspect', 'appraisal salary fields list', 'appraisal salary cells get'] }
  let directory: unknown
  if (['salary-context', 'salary-create', 'salary-configure'].includes(action)) directory = await call('directory', { query: { cliContext: 'fresh' } })
  if (action === 'salary-context') return { ...common, reports: beforeList, users: companyDirectoryUsers(directory).map(row => ({ id: id(row.id), name: row.name })), departments: companyDirectoryUnits(directory), periodTypes: ['month', 'quarter', 'halfYear', 'year'] }
  if (action === 'salary-reports') return { ...common, reports: beforeList }
  function selection(key: 'userIds' | 'departmentIds', value: unknown): string[] {
    const available = key === 'userIds' ? companyDirectoryUsers(directory) : companyDirectoryUnits(directory)
    if (!Array.isArray(value) || value.length > 10000) invalid('薪酬对象须为有界 ID 数组，空数组显式清空。')
    const ids = (value as unknown[]).map(id)
    if (new Set(ids).size !== ids.length || ids.some(value => !available.some(row => id(row.id) === value))) invalid('薪酬选择必须来自当前公司实际成员及部门。')
    return ids.sort()
  }
  const wire = (report: Report) => ({ id: report.id, name: report.name, userIds: report.userIds.join(','), deptIds: report.departmentIds.join(',') })
  if (action === 'salary-create') {
    const proposed: Report = { id: '', name: name(input.name), userIds: selection('userIds', input.userIds ?? []), departmentIds: selection('departmentIds', input.departmentIds ?? []) }
    if (beforeList.some(report => report.name === proposed.name)) throw new RsqError('ALREADY_EXISTS', '本公司已有同名薪酬报表。', 2)
    const { id: unused, ...body } = wire(proposed), created = asObject(await call('createdReport', { body })), target = id(created.id); resources.salaryReportId = target
    const afterList = reportList(await call('verifiedReports')), listing = afterList.find(report => report.id === target)
    check(listing?.name === proposed.name && !beforeList.some(report => report.id === target) && isDeepStrictEqual(afterList.filter(report => report.id !== target).sort((a, b) => a.id.localeCompare(b.id)), [...beforeList].sort((a, b) => a.id.localeCompare(b.id))), '新增薪酬报表未出现，或其他报表发生变化。')
    const actual = reportDetail(await call('verifiedReport', { query: { id: target } }), target, listing!)
    check(isDeepStrictEqual(actual, { ...proposed, id: target }), '新增薪酬报表的选择范围与请求不符。')
    return { ...common, report: actual, fields: publicFields(salaryFields(await call('verifiedFields', { query: { id: target } }))), independentlyVerified: true }
  }
  const target = id(input.reportId), listing = beforeList.find(report => report.id === target)
  if (!listing) throw new RsqError('RESOURCE_FORBIDDEN', '薪酬报表不在当前公司实际列表中。', 4)
  resources.salaryReportId = target
  const query = { id: target }, before = reportDetail(await call('report', { query }), target, listing)
  const freshReport = async () => check(isDeepStrictEqual(reportDetail(await call('freshReport', { query }), target, listing), before), '薪酬报表配置在读取后发生变化；未覆盖。')
  if (action === 'salary-configure' || action === 'salary-remove') {
    const patch = asObject(input.patch), proposed = { ...before }
    if (action === 'salary-configure') {
      if (!Object.keys(patch).length || Object.keys(patch).some(key => !['name', 'userIds', 'departmentIds'].includes(key))) invalid('请提供薪酬名称或对象范围的明确补丁。')
      if (patch.name != null) proposed.name = name(patch.name)
      for (const key of ['userIds', 'departmentIds'] as const) if (Object.hasOwn(patch, key)) proposed[key] = selection(key, patch[key])
      if (beforeList.some(report => report.id !== target && report.name === proposed.name)) throw new RsqError('ALREADY_EXISTS', '本公司已有同名薪酬报表。', 2)
    }
    await freshReport()
    const changed = action === 'salary-remove' || !isDeepStrictEqual(before, proposed)
    if (changed) await call('changed', action === 'salary-remove' ? { query } : { body: wire(proposed) })
    if (action === 'salary-configure') check(isDeepStrictEqual(reportDetail(await call('verifiedReport', { query }), target, { ...listing, name: proposed.name }), proposed), '薪酬报表补丁未完整保存，或省略对象被清空。')
    const afterList = reportList(await call('verifiedReports'))
    check(action === 'salary-remove' ? !afterList.some(report => report.id === target) : afterList.some(report => report.id === target && report.name === proposed.name), '薪酬报表目录未体现变更。')
    check(isDeepStrictEqual(afterList.filter(report => report.id !== target), beforeList.filter(report => report.id !== target)), '无关薪酬报表目录发生变化。')
    return { ...common, report: proposed, removed: action === 'salary-remove', changed, independentlyVerified: true, ...(action === 'salary-remove' && { deletionSemantics: 'report-hidden-not-proof-of-physical-data-erasure' }) }
  }
  const fields = salaryFields(await call('fields', { query })), gridQuery = { ...query, period: period.code }
  const freshFields = async () => check(isDeepStrictEqual(salaryFields(await call('freshFields', { query })), fields), '薪酬字段在读取后发生变化；未覆盖。')
  if (action === 'salary-fields') return { ...common, report: before, fields: publicFields(fields), types: { custom: ['num', 'formula'], expressions: '{{fieldId}} with server formula language' } }
  if (action.startsWith('salary-field-')) {
    const fieldId = action === 'salary-field-create' ? null : id(input.fieldId), field = fields.find(field => field.id === fieldId) ?? null
    if (fieldId && !field) throw new RsqError('RESOURCE_FORBIDDEN', '字段不属于当前报表可维护列表。', 4)
    if (fieldId) resources.salaryFieldId = fieldId
    if (field?.isSystem && ['salary-field-configure', 'salary-field-remove'].includes(action)) throw new RsqError('RESOURCE_FORBIDDEN', '当前 UI 不允许编辑或删除系统薪酬字段。', 4)
    const patch = action === 'salary-field-create' ? input : asObject(input.patch)
    let body: JsonObject = {}, expected: ReturnType<typeof config> | null = null, order: string[] | null = null
    const dependencies = field == null ? [] : fields.filter(other => other.id !== field.id && other.type === 'formula' && other.formula?.factors.includes(`$_field_${field.id}_$`)).map(other => ({ id: other.id, name: other.name }))
    if (action === 'salary-field-create' || action === 'salary-field-configure') {
      if (action === 'salary-field-configure' && (!Object.keys(patch).length || Object.keys(patch).some(key => !['name', 'type', 'expression'].includes(key)))) invalid('请提供名称、类型或公式的明确字段补丁。')
      const nextName = patch.name == null ? field!.name : name(patch.name), nextType = String(patch.type ?? field?.type)
      if (!['num', 'formula'].includes(nextType)) invalid('当前自定义薪酬字段只支持 num 和 formula。')
      if (fields.some(other => other.id !== fieldId && other.name === nextName)) throw new RsqError('ALREADY_EXISTS', '本报表已有同名字段。', 2)
      let formula: JsonObject | null = null, formulaText = ''
      if (nextType === 'formula') {
        if (field && field.formula == null) throw new RsqError('PERSISTENCE_UNSUPPORTED', '当前字段更新链路只更新已有公式记录，不能将无公式记录的数字字段转成公式；请新建公式字段。', 5)
        const built = patch.expression == null && field?.type === 'formula' ? { text: field.formula!.text, factors: field.formula!.factors, onlyText: field.from ?? '' } : salaryFormula(patch.expression, fields, field)
        formula = { text: built.text, factors: built.factors, ...(field?.formula && { id: field.formula.id }) }; formulaText = built.onlyText
      } else if (patch.expression != null) invalid('数字字段不能带公式。')
      expected = { name: nextName, type: nextType, formula: formula == null ? null : { text: String(formula.text), factors: formula.factors as string[] } }
      body = { ...(fieldId ? { id: fieldId } : { salaryId: target }), name: nextName, type: nextType, formulaText, formula }
    } else if (action === 'salary-field-show') {
      if (typeof input.isShow !== 'boolean') invalid('字段显示开关须为布尔值。'); body = { id: fieldId, isShow: input.isShow }
    } else if (action === 'salary-field-remove') {
      if (dependencies.length && input.allowDependentErrors !== true) throw new RsqError('DEPENDENCY_EXISTS', '其他公式仍引用此字段；先维护依赖，或明确允许这些公式出错。', 2, { dependencies })
    } else if (action === 'salary-field-move') {
      const anchor = input.beforeFieldId == null ? null : id(input.beforeFieldId)
      if (anchor === fieldId || anchor && !fields.some(other => other.id === anchor)) invalid('字段排序锚点必须来自同一报表，且不能是自身。')
      order = fields.filter(other => other.id !== fieldId).map(other => other.id)
      const index = anchor == null ? order.length : order.indexOf(anchor); order.splice(index, 0, fieldId!)
      const grid = salaryGrid(await call('nameHeader', { query: gridQuery }), fields), first = grid.columns.find(column => column.type === 'name')!
      body = { id: fieldId, frontId: index > 0 ? order[index - 1] : first.id, ...(index + 1 < order.length && { behindId: order[index + 1] }) }
    }
    await freshFields()
    let changed = true, createdId: string | null = null
    if (action === 'salary-field-configure') changed = !isDeepStrictEqual(config(field!), expected)
    if (action === 'salary-field-show') changed = field!.isShow !== input.isShow
    if (action === 'salary-field-move') changed = !isDeepStrictEqual(fields.map(field => field.id), order)
    if (changed) {
      const result = await call(action === 'salary-field-create' ? 'createdField' : 'changed', action === 'salary-field-remove' ? { query: { id: fieldId } } : { body })
      if (action === 'salary-field-create') { createdId = id(asObject(result).id); resources.salaryFieldId = createdId }
    }
    const after = salaryFields(await call('verifiedFields', { query })), actualId = createdId ?? fieldId, actual = after.find(field => field.id === actualId)
    if (action === 'salary-field-remove') check(!actual, '薪酬字段仍在当前报表中。')
    else {
      check(actual, '薪酬字段未出现在独立读取的报表字段中。')
      if (expected) check(isDeepStrictEqual(config(actual), expected), '字段名称、类型或公式没有完整保存。')
      if (action === 'salary-field-show') check(actual.isShow === input.isShow, '字段显示状态没有保存。')
    }
    if (order) {
      check(isDeepStrictEqual(after.map(field => field.id), order), '薪酬字段顺序未保存。')
      check(isDeepStrictEqual(after.map(({ displayOrder, ...field }) => field).sort((a, b) => a.id.localeCompare(b.id)), fields.map(({ displayOrder, ...field }) => field).sort((a, b) => a.id.localeCompare(b.id))), '排序改动了字段定义。')
    } else check(isDeepStrictEqual(after.filter(field => field.id !== actualId), fields.filter(field => field.id !== actualId)), '未选中的薪酬字段发生变化。')
    if (action === 'salary-field-create') check(!fields.some(field => field.id === createdId), '服务返回了已有字段 ID。')
    return { ...common, report: before, fields: publicFields(after), field: actual ?? null, changed, removed: action === 'salary-field-remove', dependencies, independentlyVerified: true }
  }
  const grid = salaryGrid(await call('sheet', { query: gridQuery }), fields)
  if (action === 'salary-inspect' || action === 'salary-cells') return { ...common, report: before, fields: publicFields(fields), ...grid }
  if (action === 'salary-import-preview' || action === 'salary-import-save') {
    const plan = await salaryImportPlan(String(input.file), input, fields, grid)
    const result = { ...common, report: before, rows: plan.rows, columns: plan.columns, values: plan.values.map(({ id, ...row }) => ({ ...row, fieldId: id })), emptyCellSemantics: 'skip-not-clear', processing: 'validated-public-ids; independent-http-save-and-readback', rounding: 'two-decimal-half-up' }
    if (action === 'salary-import-preview') return { ...result, saved: false }
    const saved = await saveSalaryCells(plan.values, grid, fields, { call, resources, query, period, freshReport })
    return { ...result, saved: true, ...saved.grid, changed: saved.changed, batches: saved.batches, independentlyVerified: true }
  }
  let values: JsonObject[]
  if (action === 'salary-cells-previous' || action === 'salary-cells-copy') {
    const fieldId = id(input.fieldId), field = fields.find(field => field.id === fieldId && field.type === 'num' && field.isShow)
    if (!field) invalid('上周期复制只支持当前可见的数字字段。')
    const previous = salaryGrid(await call('previousSheet', { query: { ...gridQuery, period: period.previousCode } }), fields)
    values = previous.rows.filter(row => row.cells[fieldId] != null).map(row => ({ userId: row.userId, id: fieldId, value: salaryValue(String(row.cells[fieldId])) }))
    // Q2–Q4 uses String.replace on the entire period in the deployed sync
    // implementation and can corrupt the year. Use the independently read,
    // correctly computed previous quarter instead of sending that request.
    if (period.kind !== 'quarter') {
      const preview = rows(await call('previousValues', { body: { id: target, period: period.code, periodType: period.apiType, data: { id: fieldId } } })).map(row => ({ userId: id(row.userId), id: fieldId, value: salaryValue(String(row.value)) }))
      const ordered = (rows: JsonObject[]) => [...rows].sort((a, b) => String(a.userId).localeCompare(String(b.userId)))
      check(isDeepStrictEqual(ordered(preview), ordered(values)), '上周期接口与独立 HTTP 读回不一致；未复制。')
    }
    if (action === 'salary-cells-previous') return { ...common, report: before, fieldId, previousPeriod: period.previousCode, values, saved: false, quarterSyncWorkaround: period.kind === 'quarter' }
  } else values = rows(input.values).map(row => ({ userId: id(row.userId), id: id(row.fieldId), value: salaryValue(row.value) }))
  if (action === 'salary-cells-set' && values.length > 1000) invalid('单次赋值最多 1000 个单元格；Excel 导入及上周期复制会显式分批。')
  const saved = await saveSalaryCells(values, grid, fields, { call, resources, query, period, freshReport })
  return { ...common, report: before, fields: publicFields(fields), ...saved.grid, changed: saved.changed, batches: saved.batches, independentlyVerified: true, ...(action === 'salary-cells-copy' && { previousPeriod: period.previousCode, quarterSyncWorkaround: period.kind === 'quarter' }) }
}
