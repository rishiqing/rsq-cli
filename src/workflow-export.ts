import { asObject, type JsonObject } from './core.js'
import { describeWorkflowResource, matchesWorkflowName, workflowResources } from './workflow-resources.js'
import { workflowInstanceFilters } from './workflow-reads.js'
import { requireUsage, usageData, usageError, usageId, usageList, usageRows, type UsageRuntime } from './usage-runtime.js'

function selectedKeys(rows: unknown, selectAll = false) {
  return usageRows(rows ?? []).filter(row => selectAll || row.isChecked === true).map(row => {
    const key = row.exportFieldName
    requireUsage(typeof key === 'string' && key.length > 0 && !key.includes(','), '网页导出字段配置不完整。')
    return key
  })
}

function stepsForForm(steps: JsonObject[], formId: string): Set<string> {
  const ids = new Set<string>(), remaining = [...steps]
  while (remaining.length) {
    const step = remaining.pop()!
    if (String(step.formId) === formId) ids.add(usageId(step.id))
    if (step.children != null) remaining.push(...usageRows(step.children))
  }
  return ids
}

export async function exportWorkflow(r: UsageRuntime, input: JsonObject) {
  if (input.processId !== undefined || input.kind === 'instance') {
    usageError('EXPORT_SCOPE_UNSUPPORTED', '网页导出按流程应用和筛选条件受理，请指定应用，可用 --instance-name 筛选流程标题。')
  }
  const exportFilterList = workflowInstanceFilters({ ...input, name: input.instanceName })
  const lookup = await workflowResources(r), matches = await lookup.find(input)
  const exact = typeof input.name === 'string' ? matches.filter(item => matchesWorkflowName(input.name as string, item)) : matches
  const candidates = exact.length ? exact : matches
  if (!candidates.length) usageError('NOT_FOUND', '没有找到当前账号可访问的流程。')
  if (candidates.length > 1) usageError('AMBIGUOUS_TARGET', '找到多个匹配流程，请选择具体候选。', {
    candidates: candidates.slice(0, 20).map(describeWorkflowResource), total: candidates.length,
  })
  const resource = candidates[0], { scope } = resource, { applicationId } = scope
  if (resource.kind === 'instance') {
    usageError('EXPORT_SCOPE_UNSUPPORTED', '请用 --application-id 指定所属应用，可用 --instance-name 筛选流程标题。', { applicationId })
  }

  const application = usageData(await r.call('GET', '/task/workflow/application', { query: { id: applicationId } }, 'applicationExportPermission'))
  const subtype = application.workflowModuleSubType
  requireUsage(String(application.id) === applicationId && (scope.kind === 'project' ? subtype == null || subtype === 'projectWorkflow' : subtype == null),
    '实际应用与流程导出目标不一致。')
  if (asObject(application.editControl).exportFlow !== true) {
    usageError('FORBIDDEN', '当前身份没有这个流程应用的导出权限。', { applicationId, permission: 'exportFlow' })
  }
  r.resources.applicationId = applicationId
  if (scope.kind === 'project') r.resources.projectId = scope.projectId

  let formId: string | undefined, formSteps: Set<string> | undefined
  if (input.formId !== undefined || input.formName !== undefined) {
    const forms = usageList(await r.call('GET', '/task/workflow/form/list', { query: { applicationId } }, 'exportForm'))
      .filter(form => input.formId !== undefined ? String(form.id) === input.formId : String(form.name).trim() === String(input.formName).trim())
    if (!forms.length) usageError('NOT_FOUND', '该流程应用没有匹配的可见表单。')
    if (forms.length > 1) usageError('AMBIGUOUS_TARGET', '该流程应用存在同名表单，请选择具体表单。', {
      candidates: forms.map(form => ({ formId: usageId(form.id), name: form.name })),
    })
    formId = usageId(forms[0].id)
    const steps = usageList(await r.call('GET', '/task/workflow/step/info/recursive/tree/list', { query: { applicationId } }, 'exportFormSteps'))
    formSteps = stepsForForm(steps, formId)
  }

  const settings = usageData(await r.call('GET', '/task/workflow/process/info/export/record/list', { query: { applicationId } }, 'exportFields'))
  const headerKeys = selectedKeys(settings.processMessage)
  const stepKeysList: { stepInfoId: string; keysList: string[] }[] = []
  for (const group of usageRows(settings.formMessage ?? [])) {
    const stepInfoId = usageId(group.stepInfoId)
    if (formSteps && !formSteps.has(stepInfoId)) continue
    const keysList = [...selectedKeys(group.fieldList, !!formSteps), ...selectedKeys(group.stepList, !!formSteps)]
    if (!keysList.length) continue
    headerKeys.push(...keysList)
    stepKeysList.push({ stepInfoId, keysList })
  }
  if (formSteps && !stepKeysList.length) usageError('NO_EXPORT_FIELDS', '该表单没有可导出的步骤或字段。', { formId })
  if (!headerKeys.length) usageError('NO_EXPORT_FIELDS', '网页导出尚未选择字段。请在网页勾选导出列，或通过 --form-name 指定表单。')

  const registration = usageData(await r.call('POST', '/task/workflow/process/info/export/record/url/add', {
    body: { applicationId, headerKeys: headerKeys.join(','), stepKeysList, exportFilterList, fieldFilter: null },
  }, 'prepareExport'))
  const exportId = registration.exportId
  requireUsage(typeof exportId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(exportId), '服务没有返回有效的导出受理标识。')
  r.resources.exportId = exportId
  await r.call('GET', '/task/workflow/excel/export/application/process/list', { query: { exportId } }, 'startExport')
  return { status: 'accepted', exportId, receiver: 'export watch', target: describeWorkflowResource(resource), scope, ...(formId && { formId }) }
}
