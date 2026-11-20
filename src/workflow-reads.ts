import type { JsonObject } from './core.js'
import type { WorkflowScope } from './workflow-resources.js'
import { requireUsage, usageData, usageDate, usageError, usageId, usageList, usageRows, type UsageRuntime } from './usage-runtime.js'

export function workflowInstanceFilters(input: JsonObject) {
  const filter: JsonObject[] = []
  if (input.name !== undefined) filter.push({ key: 'name', include: true, value: String(input.name).trim() })
  if (input.status && input.status !== 'all') filter.push({ key: 'isFinished', include: true, value: input.status === 'doing' ? '3' : '2' })
  if (input.createdBetween !== undefined) {
    const dates = input.createdBetween as string[], start = usageDate(dates[0]), end = usageDate(dates[1])
    if (start > end) usageError('INVALID_INPUT', '创建日期开始不能晚于结束。')
    filter.push({ key: 'dateCreated', include: true, value: start.replaceAll('-', '.') + '-' + end.replaceAll('-', '.') })
  }
  return filter
}

export async function visibleInstances(r: UsageRuntime, applicationId: string, input: JsonObject, limit: number, offset: number) {
  const filter = workflowInstanceFilters(input)
  const items = usageList(await r.call('POST', '/task/workflow/process/info/sheet/list', { body: { flowApplicationId: applicationId, max: limit, offset, filter } }))
  requireUsage(items.length <= limit && items.every(row => String(row.flowAppId) === applicationId), '表格实例结果超出当前应用或分页窗口。')
  return { items, filter }
}

export async function readWorkflowDetail(r: UsageRuntime, scope: WorkflowScope, processId: string) {
  const detail = usageData(await r.call('GET', '/task/workflow/process/info/details', { query: { processInfoId: processId } }, 'visibleProcess'))
  const owner = detail.belongToProjectId
  const ownerMatches = scope.kind === 'project' ? owner == null || String(owner) === scope.projectId : owner == null || String(owner) === '0'
  requireUsage(String(detail.id) === processId && String(detail.flowAppId) === scope.applicationId && ownerMatches,
    '实例与已核对的流程应用或项目不一致。')
  return detail
}

export async function readWorkflowStepForm(r: UsageRuntime, scope: WorkflowScope, processId: string, summary: JsonObject, formId?: string) {
  const stepId = usageId(summary.id)
  const step = usageData(await r.call('GET', '/task/workflow/process/info/step', { query: { stepInfoId: stepId } }, 'visibleStep'))
  requireUsage(String(step.id) === stepId && String(step.processInfoId) === processId && String(step.applicationId) === scope.applicationId,
    '实际步骤与实例或应用的归属不一致。')
  const stepFormId = step.formId == null ? undefined : String(step.formId)
  if (!stepFormId || stepFormId === '0' || formId !== undefined && stepFormId !== formId) return { step }
  const form = usageData(await r.call('GET', '/task/workflow/process/info/step/list/auditsAndForms',
    { query: { stepInfoId: stepId, isRefresh: false } }, 'visibleForm'))
  if (form.formId == null && (form.fields == null || Array.isArray(form.fields) && !form.fields.length)) return { step }
  requireUsage(String(form.formId) === stepFormId, '读取期间实际步骤的表单发生变化。')
  const fields = usageRows(form.fields ?? []).filter(field => field.isHidden !== true)
  return { step, form: { id: stepFormId, name: form.formName, fields } }
}
