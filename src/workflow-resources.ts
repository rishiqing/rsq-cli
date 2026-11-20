import { RsqError, type JsonObject } from './core.js'
import { availableFeatureScopes, isFeatureDenial, validateCompanyState, validateFeatures, workflowScopeFeatures } from './access.js'
import { projectWorkflowModules } from './workflow-scope.js'
import { requireUsage, usageData, usageError, usageId, usageList, usageRows, type UsageRuntime } from './usage-runtime.js'

export type WorkflowScope = { kind: 'project'; projectId: string; applicationId: string } | { kind: 'standalone'; applicationId: string }
type WorkflowResource = {
  kind: 'application' | 'instance'; id: string; name: string; scope: WorkflowScope
  label?: string; projectName?: string; applicationName?: string; status?: string; dateCreated?: string
}
const unavailable = (error: unknown) => isFeatureDenial(error) || error instanceof RsqError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)
const normalized = (value: string) => value.trim().normalize('NFC').toLowerCase()
const includes = (value: unknown, name: string) => typeof value === 'string' && normalized(value).includes(normalized(name))

export function workflowCommand(scope: WorkflowScope, operation: string) {
  return (scope.kind === 'project' ? 'project workflow ' : 'workflow ') + operation
}

export function workflowTarget(resource: WorkflowResource) {
  const { scope } = resource
  return {
    command: workflowCommand(scope, resource.kind === 'application' ? 'configuration inspect' : 'instance inspect'),
    ...(scope.kind === 'project' && { projectId: scope.projectId }),
    ...(resource.kind === 'application' ? { applicationId: resource.id } : { processId: resource.id }),
  }
}

export function matchesWorkflowName(query: string, item: WorkflowResource) {
  const key = normalized(query)
  return normalized(item.name) === key || item.label !== undefined && normalized(item.label) === key
}

export async function workflowResources(r: UsageRuntime) {
  const state = usageData(await r.call('GET', '/task/ordercenter/v2/member/state/independent'))
  validateCompanyState(state)
  const features = await r.call('GET', '/task/ordercenter/v2/function/available', { query: { vt: state.vt } })
  const authorities = usageData(await r.call('GET', '/task/authority/v3/authorities/company/current'))
  const scopes = availableFeatureScopes(workflowScopeFeatures, features, authorities)
  let independent: Promise<JsonObject[]> | undefined, projectList: Promise<JsonObject[]> | undefined
  const standalone = () => independent ??= r.call('GET', '/task/workflow/application/list', {}, 'standaloneApplications').then(usageList)
  const projects = () => projectList ??= r.existing('project list', {}).then(out => usageRows(out.projects))
  const bindings = new Map<string, ReturnType<typeof loadProjectModules>>()
  async function loadProjectModules(projectId: string) {
    const value = await r.call('GET', '/task/v1/kanbanChildCrud/list', { query: { kanbanId: projectId } }, 'projectModules')
    return projectWorkflowModules(value, projectId)
  }
  function modules(projectId: string) {
    const cached = bindings.get(projectId)
    if (cached) return cached
    const pending = loadProjectModules(projectId)
    bindings.set(projectId, pending)
    return pending
  }

  async function resolveInstance(processId: string, verifyProject = true) {
    const proof = usageList(await r.call('GET', '/task/workflow/process/info/listByIdsForDataModule',
      { query: { processInfoIds: processId } }, 'processVisibility'))
    if (proof.length !== 1 || String(proof[0].id) !== processId || proof[0].isCanOpen !== true || proof[0].isDeleted !== false) {
      usageError('FORBIDDEN', '当前用户无法打开此流程实例，请核对资源和权限。', { processId })
    }
    const detail = usageData(await r.call('GET', '/task/workflow/process/info/details', { query: { processInfoId: processId } }, 'processScope'))
    requireUsage(String(detail.id) === processId && /^[1-9][0-9]*$/.test(String(detail.flowAppId)), '流程实例与请求不一致。')
    const applicationId = String(detail.flowAppId), owner = detail.belongToProjectId
    const projectId = owner == null || String(owner) === '0' ? null : String(owner)
    requireUsage(!projectId || /^[1-9][0-9]*$/.test(projectId), '流程实例的项目 ID 无效。')
    const scope: WorkflowScope = projectId ? { kind: 'project', projectId, applicationId } : { kind: 'standalone', applicationId }
    validateFeatures(workflowScopeFeatures[scope.kind], features, authorities)
    let projectName: string | undefined
    if (scope.kind === 'project' && verifyProject) {
      const project = (await projects()).find(item => String(item.id) === scope.projectId)
      if (!project || !(await modules(scope.projectId)).some(module => module.applicationId === applicationId)) {
        usageError('FORBIDDEN', '无法核对实例所属的当前项目流程模块。', { processId })
      }
      projectName = typeof project.name === 'string' ? project.name : undefined
    }
    if (scope.kind === 'standalone' && !(await standalone()).some(app => String(app.id) === applicationId)) {
      usageError('CONTEXT_MISSING', '服务端未返回可核对的流程归属。', { processId })
    }
    const result: WorkflowResource = { kind: 'instance', id: processId, name: String(detail.name ?? ''), scope, projectName,
      applicationName: typeof detail.flowAppName === 'string' ? detail.flowAppName : undefined,
      status: typeof detail.statusName === 'string' ? detail.statusName : typeof detail.status === 'string' ? detail.status : undefined,
      dateCreated: typeof detail.dateCreated === 'string' ? detail.dateCreated : undefined,
    }
    return { resource: result, detail }
  }

  async function applications(input: JsonObject) {
    const selector = usageList(await r.call('GET', '/task/workflow/application/appListForSelector', {}, 'applicationSelector'))
    const name = String(input.name ?? '').trim(), applicationId = input.applicationId
    const candidates = selector.filter(item => applicationId === undefined ? includes(item.name, name) : String(item.id) === applicationId)
    if (!candidates.length) return []
    const independent = new Map(scopes.has('standalone') ? (await standalone()).map(app => [String(app.id), app] as const) : [])
    const result = new Map<string, WorkflowResource>()
    for (const row of candidates) {
      const actual = independent.get(String(row.id))
      if (actual && typeof actual.name === 'string' && (applicationId !== undefined || includes(actual.name, name))) {
        const id = usageId(actual.id)
        result.set('standalone:' + id, { kind: 'application', id, name: actual.name, scope: { kind: 'standalone', applicationId: id } })
      }
    }
    const embedded = candidates.filter(row => !independent.has(String(row.id)))
    if (scopes.has('project') && embedded.length) for (const project of await projects()) {
      if (typeof project.name !== 'string' || !project.name.trim()) continue
      // The picker supplies a display label. Only the actual module proves ownership.
      const prefix = project.name + '-'
      const possible = embedded.filter(row => typeof row.name === 'string' && row.name.startsWith(prefix))
      if (!possible.length) continue
      const projectId = usageId(project.id)
      try {
        const associated = await modules(projectId)
        for (const row of possible) {
          const id = usageId(row.id)
          if (!associated.some(module => module.applicationId === id)) continue
          result.set(projectId + ':' + id, { kind: 'application', id, name: String(row.name).slice(prefix.length), label: String(row.name),
            projectName: project.name, scope: { kind: 'project', projectId, applicationId: id } })
        }
      } catch (error) { if (!unavailable(error)) throw error }
    }
    return [...result.values()]
  }

  async function searchInstances(name: string) {
    const seen = new Set<string>()
    const items: WorkflowResource[] = []
    const pageSize = 100
    let expectedTotal: number | undefined
    for (let pageNum = 1; ; pageNum++) {
      const page = usageData(await r.call('GET', '/task/workflow/process/info/search',
        { query: { processInfoName: name, pageNum, pageSize } }, 'instanceSearch'))
      const rows = usageRows(page.list ?? [])
      const unpaged = page.pageNum === 0 && page.pageSize === 0 && page.pages === 0 && page.total === 0 && page.size === rows.length
      const total = Number(page.total)
      const paged = page.pageNum === pageNum && page.pageSize === pageSize && Number.isSafeInteger(total) && total >= 0 &&
        page.pages === Math.ceil(total / pageSize) && rows.length === Math.min(pageSize, Math.max(0, total - (pageNum - 1) * pageSize))
      requireUsage(unpaged || paged, '流程搜索缺少可信的分页信息，请用流程链接或 ID 定位。')
      if (pageNum > 1 && (unpaged || expectedTotal !== total)) usageError('CONTEXT_CONFLICT', '流程搜索结果在分页期间变化，请重试。')
      expectedTotal = total
      for (const row of rows) {
        const id = usageId(row.id)
        if (seen.has(id)) usageError('CONTEXT_CONFLICT', '流程搜索结果在分页期间变化，请重试。')
        seen.add(id)
        if (!includes(row.name, name)) continue
        try {
          const { resource } = await resolveInstance(id)
          if (includes(resource.name, name)) items.push(resource)
        } catch (error) { if (!unavailable(error)) throw error }
      }
      if (unpaged || rows.length === 0 || Number(page.pages) <= pageNum) return items
    }
  }

  async function find(input: JsonObject) {
    if (input.processId !== undefined) return [(await resolveInstance(usageId(input.processId))).resource]
    if (input.applicationId !== undefined) return applications(input)
    const name = String(input.name).trim()
    const apps = input.kind === 'instance' ? [] : await applications(input)
    const instances = input.kind === 'application' ? [] : await searchInstances(name)
    return [...apps, ...instances].sort((left, right) => Number(matchesWorkflowName(name, right)) - Number(matchesWorkflowName(name, left)) ||
      (left.label ?? left.name).localeCompare(right.label ?? right.name, 'zh-CN') || left.id.localeCompare(right.id))
  }
  return { find, resolveInstance }
}

export function describeWorkflowResource(resource: WorkflowResource) {
  const operations = resource.kind === 'application' ? ['form records list', 'instance start'] : ['instance fill', 'instance act']
  return {
    ...resource, target: workflowTarget(resource),
    ...(resource.kind === 'application' && { exportTarget: { command: 'workflow export', applicationId: resource.id } }),
    relatedCommands: operations.map(operation => workflowCommand(resource.scope, operation)),
  }
}
