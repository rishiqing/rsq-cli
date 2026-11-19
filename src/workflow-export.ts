import { lstat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { asObject, parseJson, RsqError, type JsonObject } from './core.js'
import { saveNewOutput } from './operations.js'
import { textWorkbook } from './xlsx.js'
import { describeWorkflowResource, matchesWorkflowName, workflowResources } from './workflow-resources.js'
import { readWorkflowDetail, readWorkflowStepForm, visibleInstances } from './workflow-reads.js'
import { requireUsage, usageData, usageDate, usageError, usageId, usageList, usageRows, type UsageRuntime } from './usage-runtime.js'

async function pathInfo(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RsqError('INVALID_OUTPUT', '无法访问输出路径。', 2)
  }
}

async function outputDestination(output: unknown) {
  const path = resolve(output === undefined ? '.' : String(output))
  const existing = await pathInfo(path)
  if (existing?.isDirectory()) return { directory: path }
  if (existing) throw new RsqError('OUTPUT_EXISTS', '输出路径已存在，请指定另一个文件。', 2)
  if (extname(path).toLowerCase() !== '.xlsx' || !(await pathInfo(dirname(path)))?.isDirectory()) {
    throw new RsqError('INVALID_OUTPUT', '输出需为已有目录，或已有目录下的新 .xlsx 文件。', 2)
  }
  return { file: path }
}

async function saveWorkbook(bytes: Uint8Array, destination: Awaited<ReturnType<typeof outputDestination>>, title: string) {
  if (destination.file) return (await saveNewOutput(bytes, destination.file)).output
  let filename = title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 60) || '流程'
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)) filename = '_' + filename
  for (let counter = 1; ; counter++) {
    const path = join(destination.directory!, filename + (counter === 1 ? '' : ' (' + counter + ')') + '.xlsx')
    try { return (await saveNewOutput(bytes, path)).output } catch (error) {
      if (!(error instanceof RsqError) || error.code !== 'OUTPUT_EXISTS') throw error
    }
  }
}

function cell(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function fieldText(field: JsonObject) {
  const value = field.value
  const type = Number(field.type)
  if ([3, 4, 21].includes(type) && typeof value === 'string' && Array.isArray(field.selector)) {
    const labels = new Map(field.selector.map(option => {
      const row = asObject(option)
      return [String(row.value), String(row.name ?? row.value)]
    }))
    return value.split(',').map(id => labels.get(id) ?? id).join('、')
  }
  if (type === 6) return ''
  if (type === 15 && value) {
    try {
      const content = asObject(typeof value === 'string' ? parseJson(value) : value)
      if (Array.isArray(content.ops)) return content.ops.map(entry => {
        const insert = asObject(entry).insert
        return typeof insert === 'string' ? insert : '[嵌入内容]'
      }).join('')
    } catch { /* Preserve the original value if the service returns another rich text format. */ }
  }
  return cell(value)
}

function textParts(value: string): string[] {
  if (value.length <= 32767) return [value]
  const parts: string[] = []
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 32767, value.length)
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--
    parts.push(value.slice(offset, end))
    offset = end
  }
  return parts
}

function matchesFilters(detail: JsonObject, input: JsonObject) {
  const status = input.status
  if (status === 'doing' && detail.status !== 'doing' || status === 'finished' && !['finished', 'suspended'].includes(String(detail.status))) return false
  if (input.createdBetween === undefined) return true
  const [from, to] = (input.createdBetween as string[]).map(usageDate)
  if (from > to) usageError('INVALID_INPUT', '创建日期开始不能晚于结束。')
  const created = String(detail.dateCreated ?? '').slice(0, 10)
  return created >= from && created <= to
}

export async function exportWorkflow(r: UsageRuntime, input: JsonObject) {
  const destination = await outputDestination(input.output)
  const lookup = await workflowResources(r), matches = await lookup.find(input)
  const exact = typeof input.name === 'string' ? matches.filter(item => matchesWorkflowName(input.name as string, item)) : matches
  const candidates = exact.length ? exact : matches
  if (!candidates.length) usageError('NOT_FOUND', '没有找到当前账号可访问的流程。')
  if (candidates.length > 1) usageError('AMBIGUOUS_TARGET', '找到多个匹配流程，请选择具体候选。', {
    candidates: candidates.slice(0, 20).map(describeWorkflowResource), total: candidates.length,
  })
  const resource = candidates[0], { scope } = resource, { applicationId } = scope
  const application = usageData(await r.call('GET', '/task/workflow/application', { query: { id: applicationId } }, 'applicationExportPermission'))
  const subtype = application.workflowModuleSubType
  requireUsage(String(application.id) === applicationId && (scope.kind === 'project' ? subtype == null || subtype === 'projectWorkflow' : subtype == null),
    '实际应用与流程导出目标不一致。')
  if (asObject(application.editControl).exportFlow !== true) {
    usageError('FORBIDDEN', '当前身份没有这个流程应用的导出权限。', { applicationId, permission: 'exportFlow' })
  }
  r.resources.applicationId = applicationId
  if (scope.kind === 'project') r.resources.projectId = scope.projectId
  if (resource.kind === 'instance') r.resources.processId = resource.id
  let formId: string | undefined, formName: string | undefined
  if (input.formId !== undefined || input.formName !== undefined) {
    const forms = usageList(await r.call('GET', '/task/workflow/form/list', { query: { applicationId } }, 'exportForm'))
      .filter(form => input.formId !== undefined ? String(form.id) === input.formId : String(form.name).trim() === String(input.formName).trim())
    if (!forms.length) usageError('NOT_FOUND', '该流程应用没有匹配的可见表单。')
    if (forms.length > 1) usageError('AMBIGUOUS_TARGET', '该流程应用存在同名表单，请选择具体表单。', {
      candidates: forms.map(form => ({ formId: usageId(form.id), name: form.name })),
    })
    formId = usageId(forms[0].id)
    formName = String(forms[0].name ?? '')
  }
  const instanceRows: string[][] = [['应用', '项目', '实例 ID', '编号', '流程名称', '状态', '创建时间']]
  const stepRows: string[][] = [['实例 ID', '步骤 ID', '步骤名称', '状态', '开始时间', '结束时间']]
  const fieldRows: string[][] = [['实例 ID', '步骤 ID', '表单', '字段 ID', '字段名称', '值', '分段']]
  const witnesses = new Set<string>()
  let records = 0
  async function collect(processId: string) {
    if (witnesses.has(processId)) usageError('CONTEXT_CONFLICT', '可见实例列表在导出期间变化，请重试。')
    witnesses.add(processId)
    const detail = await readWorkflowDetail(r, scope, processId)
    if (!matchesFilters(detail, input)) return
    let includesForm = false
    for (const summary of usageRows(detail.processInfoStepList ?? [])) {
      const { step, form } = await readWorkflowStepForm(r, scope, processId, summary, formId)
      if (formId !== undefined && !form) continue
      const stepId = usageId(step.id)
      stepRows.push([processId, stepId, cell(step.name ?? summary.name), cell(step.statusName ?? step.status), cell(step.startTime), cell(step.overTime)])
      if (!form) continue
      includesForm = true
      records++
      for (const field of form.fields) {
        const parts = textParts(fieldText(field))
        for (const [index, value] of parts.entries()) {
          fieldRows.push([processId, stepId, cell(form.name ?? formName), cell(field.id), cell(field.name), value,
            parts.length > 1 ? String(index + 1) + '/' + parts.length : ''])
        }
      }
    }
    if (formId === undefined || includesForm) {
      instanceRows.push([cell(application.name), resource.projectName ?? '', processId, cell(detail.number), cell(detail.name), cell(detail.statusName ?? detail.status), cell(detail.dateCreated)])
    }
  }
  if (resource.kind === 'instance') await collect(resource.id)
  else {
    const limit = 100
    for (let offset = 0; ; offset += limit) {
      const { items } = await visibleInstances(r, applicationId, input, limit, offset)
      for (const item of items) await collect(usageId(item.id))
      if (items.length < limit) break
    }
  }
  if (instanceRows.length === 1) usageError('NO_RECORDS', '所选范围没有可导出的可见记录。')
  const sheets = [{ name: '流程实例', rows: instanceRows }, { name: '步骤', rows: stepRows }, { name: '表单数据', rows: fieldRows }]
  const bytes = textWorkbook(sheets)
  const output = await saveWorkbook(bytes, destination, [resource.name, formName].filter(Boolean).join('-'))
  return { output, fileFormat: 'xlsx', bytes: bytes.length, target: describeWorkflowResource(resource), scope,
    instances: instanceRows.length - 1, steps: stepRows.length - 1, records, ...(formId && { formId }) }
}
