import { asObject, RsqError, type JsonObject } from './core.js'
import { workflowScopeFeatures } from './access.js'
import { catalog, type Schema } from './operations.js'
import type { Workflow } from './workflows.js'

const projectPrefix = 'project workflow '
const projectCatalogue = 'project workflow modules list'
const projectCapability = 'project/workflow'
export const todoWorkflowCommand = 'todo workflow inspect'
const projectResource: Schema = { type: 'string', pattern: '^[1-9][0-9]*$', description: '普通项目 ID，来自 project list 或项目链接。' }
const scopedApplications = new Set([
  'configuration inspect', 'configuration graph inspect', 'configuration graph apply', 'configuration deploy',
  'form describe', 'form clone', 'form define', 'form replace', 'form remove',
  'form field add', 'form field configure', 'form field remove', 'step insert', 'step configure', 'step remove', 'instance start',
])
const scopedInstances = new Set(['instance inspect', 'instance fill', 'instance act', 'instance close', 'instance reopen', 'instance transfer'])
const standaloneApplications = new Set(['application clone', 'application rename', 'application remove', 'form records list'])

const scopeSteps: Workflow['steps'] = [
  { id: 'scopeProject', operationId: 'rsq.project-workflow-cover', description: '核对当前用户可见的普通项目及项目 ID。', input: { query: { id: { $input: '/projectId' }, isDefault: false } } },
  { id: 'scopeModules', operationId: 'rsq.0049502086e1', description: '从项目模块目录核对流程应用与实际模块的关联。', input: { query: { kanbanId: { $input: '/projectId' } } } },
]
const instanceScopeSteps: Workflow['steps'] = [
  { id: 'scopeApplication', operationId: 'rsq.38741e60b872', description: '核对实际流程应用和当前身份的查看范围。',
    input: { query: { id: { $result: '/process/data/flowAppId' } } } },
  { id: 'scopeInstance', operationId: 'rsq.bcae04df8eb2', description: '在应用的可见实例列表核对实例归属，有查看全部实例权限时使用该权限。',
    input: {}, prepare: 'workflow-scope-instance-visibility' },
]

/** Compile the project variants from the same operation steps and schemas as the standalone commands. */
export function scopeWorkflowContracts(definitions: Workflow[]): Workflow[] {
  const inherited = (command: string) => command.startsWith('workflow ') &&
    (scopedApplications.has(command.slice(9)) || scopedInstances.has(command.slice(9)))
  const projectCommand = (command: string) => inherited(command) || command === 'workflow form records list' ? 'project ' + command : command
  return definitions.flatMap<Workflow>(flow => {
    if (flow.command === projectCatalogue) return [{ ...flow, workflowScope: 'project', steps: scopeSteps }]
    if (!flow.command.startsWith('workflow ') || !inherited(flow.command) && !standaloneApplications.has(flow.command.slice(9))) return [flow]
    const standalone: Workflow = { ...flow, workflowScope: 'standalone', description: '独立流程。' + flow.description,
      relatedCommands: [...new Set([...(flow.relatedCommands ?? []), projectCommand(flow.command) !== flow.command ? projectCommand(flow.command) : 'project module catalogue'])] }
    if (!inherited(flow.command)) return [standalone]
    const command = projectCommand(flow.command)
    const steps = scopedInstances.has(flow.command.slice(9)) ? [flow.steps[0], ...instanceScopeSteps, ...flow.steps.slice(1)] : flow.steps
    const project: Workflow = {
      ...flow, id: flow.id.replace(/^closure\.workflow\./, 'closure.project.workflow.'), command,
      workflowScope: 'project', description: '项目流程模块。' + flow.description,
      inputSchema: { ...flow.inputSchema, properties: { projectId: projectResource, ...flow.inputSchema.properties }, required: ['projectId', ...flow.inputSchema.required ?? []] },
      parameters: [{ option: 'project-id', name: 'projectId', schema: projectResource }, ...flow.parameters],
      steps: [...scopeSteps, ...steps], capabilities: [projectCapability],
      examples: ['rsq schema "' + command + '"', 'rsq ' + command + ' --project-id 123 --input request.json' + (flow.effect === 'destructive' ? ' --yes' : '')],
      relatedCommands: [...new Set([projectCatalogue, ...(flow.relatedCommands ?? []).map(projectCommand), flow.command])],
    }
    return [standalone, project]
  })
}

export function workflowScopeSchema(flow: Workflow) {
  if (flow.workflowScope === 'automatic') return {
    kind: 'automatic', requiredFeaturesByScope: workflowScopeFeatures, context: '按实际资源归属解析项目流程或独立流程，再核对当前账号的权限。',
  }
  if (flow.workflowScope === 'project' || flow.usageProject || flow.workflowTaskProject || flow.workflowDatasheetProject) return {
    kind: 'project', requiredFeatures: flow.workflowTaskProject || flow.workflowDatasheetProject ? ['PLAN'] : workflowScopeFeatures.project,
    discover: projectCatalogue, findByName: 'workflow find',
    context: '先确定普通项目 projectId，从该项目的流程模块取得 applicationId。实例命令核对 processId 的实际项目和应用归属。',
  }
  if (flow.command.startsWith('workflow ')) return {
    kind: 'standalone', requiredFeatures: workflowScopeFeatures.standalone, projectDiscovery: projectCatalogue, findByName: 'workflow find',
    context: '从独立流程应用取得 applicationId 或 processId。项目内的同类操作使用 project workflow。',
  }
}

export function validateWorkflowScope(flow: Workflow) {
  if (flow.workflowScope === 'automatic' && flow.executor !== 'arms-usage') {
    throw new RsqError('INVALID_CONTRACT', '自动流程归属需要使用核对实际资源的执行器。', 6)
  }
  if (flow.workflowScope !== 'project') return
  if (!flow.command.startsWith(projectPrefix) || flow.executor || !flow.inputSchema.required?.includes('projectId') ||
      scopeSteps.some((expected, index) => JSON.stringify(expected) !== JSON.stringify(flow.steps[index]))) {
    throw new RsqError('INVALID_CONTRACT', '项目流程命令必须先核对普通项目和实际模块目录。', 6)
  }
  if (flow.command === projectCatalogue) return
  const anchor = flow.steps[scopeSteps.length], op = catalog.operations.find(entry => entry.id === anchor?.operationId)
  const application = scopedApplications.has(flow.command.slice(projectPrefix.length))
  if (op?.method !== 'GET' || (application
    ? anchor.id !== 'source' || op.route !== '/task/workflow/application'
    : anchor.id !== 'process' || op.route !== '/task/workflow/process/info/details')) {
    throw new RsqError('INVALID_CONTRACT', '项目流程必须使用当前应用或实例详情绑定后续步骤。', 6)
  }
  if (!application && instanceScopeSteps.some((expected, index) => JSON.stringify(expected) !== JSON.stringify(flow.steps[scopeSteps.length + 1 + index]))) {
    throw new RsqError('INVALID_CONTRACT', '项目流程实例必须核对实际应用和可见范围。', 6)
  }
}

type ProjectModule = { id: string; name: string; applicationId: string | null }
const positiveId = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined

export function todoWorkflowTarget(process: unknown, step?: unknown) {
  const processId = positiveId(process), stepId = positiveId(step)
  if (!processId || step != null && !stepId) return undefined
  return { command: todoWorkflowCommand, processId, ...(stepId && { stepId }) }
}

function mismatch(message: string, details?: JsonObject): never {
  throw new RsqError('WORKFLOW_SCOPE_MISMATCH', message, 4, details)
}

export function projectWorkflowModules(value: unknown, projectId: string): ProjectModule[] {
  if (!Array.isArray(value)) throw new RsqError('RESPONSE_SCHEMA_MISMATCH', '项目模块目录格式无效。', 5)
  return value.map(asObject).filter(module => module.type === 'workflow' && module.workflowModuleSubType !== 'alterationWorkflow').map(module => {
    const id = positiveId(module.id), applicationId = positiveId(module.flowApplicationId)
    if (!id || typeof module.name !== 'string' || module.kanbanId != null && positiveId(module.kanbanId) !== projectId || module.flowApplicationId != null && !applicationId) {
      mismatch('项目返回的流程模块归属或资源标识不一致。', { projectId })
    }
    return { id, name: module.name, applicationId: applicationId ?? null }
  })
}

function bindProjectApplication(results: JsonObject, projectId: string, applicationId: string) {
  const matches = projectWorkflowModules(results.scopeModules, projectId).filter(module => module.applicationId === applicationId)
  if (matches.length !== 1) throw new RsqError('FORBIDDEN', '指定应用没有唯一对应的项目流程模块，请从该项目重新发现。', 4, { projectId, applicationId, command: projectCatalogue })
  results.workflowBinding = { kind: 'project', projectId, moduleId: matches[0].id, applicationId }
}

export function verifyWorkflowScope(flow: Workflow, step: string, input: JsonObject, results: JsonObject) {
  const project = flow.workflowScope === 'project', projectId = String(input.projectId)
  if (step === 'scopeProject') {
    const value = asObject(results.scopeProject)
    if (positiveId(value.id) !== projectId || value.coverId !== null) mismatch('请选择可见的普通项目。', { projectId, command: projectCatalogue })
  }
  if (step === 'scopeModules' && input.applicationId !== undefined) bindProjectApplication(results, projectId, String(input.applicationId))
  if (step === 'form' && input.formId !== undefined && positiveId(asObject(asObject(results.form).data).id) !== input.formId) {
    mismatch('读取的表单 ID 与已核对的表单不一致。')
  }
  if (step === 'source') {
    const source = asObject(asObject(results.source).data), subtype = source.workflowModuleSubType
    if (positiveId(source.id) !== input.applicationId) mismatch('已读取的流程应用与请求不一致。')
    if (project ? subtype != null && subtype !== 'projectWorkflow' : subtype != null) {
      mismatch('此命令与流程应用所属入口不一致。', { applicationId: input.applicationId, command: subtype === 'alterationWorkflow' ? 'project alteration context inspect' : projectCatalogue })
    }
  }
  if (step === 'scopeApplication') {
    const source = asObject(asObject(results.scopeApplication).data), planned = asObject(results.workflowBinding)
    if (positiveId(source.id) !== planned.applicationId || source.workflowModuleSubType != null && source.workflowModuleSubType !== 'projectWorkflow') {
      mismatch('实例应用与当前项目流程模块不一致。', { projectId, command: projectCatalogue })
    }
  }
  if (step === 'scopeInstance') {
    const visible = asObject(results.scopeInstance).data, binding = asObject(results.workflowBinding)
    if (!Array.isArray(visible) || !visible.some(item => positiveId(asObject(item).id) === input.processId && positiveId(asObject(item).flowAppId) === binding.applicationId)) {
      throw new RsqError('FORBIDDEN', '当前用户的可见实例列表未包含此流程实例。', 4, { projectId, processId: input.processId })
    }
  }
  if (step !== 'process' && step !== 'verifiedProcess') return
  const process = asObject(asObject(results[step]).data), owner = positiveId(process.belongToProjectId)
  const applicationId = positiveId(process.flowAppId)
  if (!project) {
    if (owner) mismatch('此实例属于项目流程，请使用项目流程命令并带上所属项目 ID。', { projectId: owner, processId: positiveId(process.id), command: 'project ' + flow.command })
    return
  }
  const processId = positiveId(process.id)
  if (!processId || input.processId && input.processId !== processId || !applicationId || owner && owner !== projectId || input.applicationId && input.applicationId !== applicationId ||
      results.workflowBinding && asObject(results.workflowBinding).applicationId !== applicationId) {
    mismatch('流程实例与选定项目或流程应用不一致。', { projectId, command: projectCatalogue })
  }
  bindProjectApplication(results, projectId, applicationId)
  if (step === 'process' && input.stepId !== undefined &&
      !(Array.isArray(process.processInfoStepList) && process.processInfoStepList.some(value => positiveId(asObject(value).id) === input.stepId))) {
    throw new RsqError('FORBIDDEN', '请选择当前流程实例中可见的实际步骤。', 4, { projectId, processId: input.processId })
  }
}

export function prepareWorkflowInstanceVisibility(results: JsonObject): JsonObject | null {
  const application = asObject(asObject(results.scopeApplication).data), process = asObject(asObject(results.process).data)
  if (asObject(application.editControl).viewAllProcess === true) return null
  const filter = typeof process.name === 'string' && process.name.trim() ? [{ key: 'name', include: true, value: process.name }] : []
  const day = typeof process.dateCreated === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/.exec(process.dateCreated) : null
  if (day) {
    const date = day.slice(1).join('.')
    filter.push({ key: 'dateCreated', include: true, value: date + '-' + date })
  }
  return { body: { flowApplicationId: asObject(results.workflowBinding).applicationId, max: 200, offset: 0, filter } }
}

export function describeProjectWorkflowModules(input: JsonObject, results: JsonObject) {
  const projectId = String(input.projectId)
  return { projectId, modules: projectWorkflowModules(results.scopeModules, projectId).map(module => ({ ...module,
    ...(module.applicationId && { target: { command: 'project workflow instances context', projectId, applicationId: module.applicationId } }),
  })) }
}
