import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'

const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const denied = (message: string): never => { throw new RsqError('FORBIDDEN', message, 4) }
const missing = (message: string): never => { throw new RsqError('CONTEXT_MISSING', message, 5) }
const assertion = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const data = (value: unknown) => asObject(asObject(value).data)
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : missing('项目变更需要实际 HTTP 返回的有界列表。')
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : missing('变更上下文缺少精确资源 ID。')
const ids = (value: unknown) => rows(value).map(row => id(row.id)).sort()
const allowed = (resource: JsonObject, name: string) => { if (asObject(resource.editControl)[name] !== true) denied('当前 UI 未授予 ' + name + ' 权限。') }
function target(input: JsonObject, results: JsonObject, optional = false) {
  const project = asObject(results.project)
  if (!same(project.id, input.projectId) || !Object.hasOwn(project, 'coverId') || project.coverId !== null) denied('项目变更要求当前实际普通项目；不能把模板项目当作普通项目操作。')
  const modules = rows(results.modules), selected = modules.filter(row => row.type === 'alteration' && (input.moduleId == null || same(row.id, input.moduleId)))
  if (selected.length > 1) invalid('变更模块不唯一，请显式提供 moduleId。')
  if (!optional && selected.length !== 1) denied('所选项目没有可见的变更模块。')
  if (results.module !== undefined && (!same(asObject(results.module).id, selected[0]?.id) || asObject(results.module).type !== 'alteration')) denied('变更模块详情与当前项目目录不符。')
  return { project, module: results.module === undefined ? selected[0] : asObject(results.module), modules }
}
function configuration(results: JsonObject, key = 'configuration') {
  const result = data(results[key]); id(result.id); rows(result.manualApplicationList); rows(result.configList)
  return result
}
function applications(results: JsonObject) {
  const result = rows(asObject(results.applications).data)
  if (new Set(ids(result)).size !== result.length) missing('变更流程目录包含重复应用。')
  return result
}
function application(results: JsonObject, selected: unknown) {
  const found = applications(results).filter(row => same(row.id, selected))
  if (found.length !== 1) denied('流程应用必须来自当前公司的实际变更流程目录。')
  return found[0]
}
function selectedConfiguration(input: JsonObject, results: JsonObject) {
  const found = rows(configuration(results).configList).filter(row => same(row.id, input.configId))
  if (found.length !== 1) denied('配置 ID 不属于当前项目变更模块。')
  return found[0]
}
function members(value: unknown, results: JsonObject, current?: unknown) {
  if (!Array.isArray(value) || value.length > 10000 || new Set(value).size !== value.length) invalid('成员须为无重复的当前公司成员 ID 数组；[] 表示 UI 的任何人。')
  const directory = new Set(companyDirectoryUsers(results.directory).map(row => id(row.id)))
  const selected = (value as unknown[]).map(id)
  if (selected.some(key => !directory.has(key))) denied('变更配置成员必须来自当前公司目录。')
  const occupied = new Set(rows(configuration(results).configList).filter(row => !same(row.id, current)).flatMap(row => ids(row.userList)))
  if (selected.some(key => occupied.has(key))) invalid('同一成员不能同时出现在其他一键变更配置中，停用配置也须遵守当前 UI 选择限制。')
  return selected
}
export function prepareProjectAlteration(action: string, input: JsonObject, results: JsonObject): JsonObject | null {
  const { project, module, modules } = target(input, results, ['context', 'module-open', 'module-detail', 'templates', 'applications'].includes(action))
  const context = asObject(results.alterationContext)
  results.alterationContext = { ...context, projectId: input.projectId, ...(module && { moduleId: id(module.id) }) }
  if (action === 'module-detail') return module ? { query: { id: id(module.id) } } : null
  if (action === 'context') return module ? { query: { alterationModuleId: id(module.id) } } : null
  if (action === 'module-open') {
    allowed(project, 'createKanbanChild')
    return module ? null : { body: { kanbanId: input.projectId } }
  }
  if (action === 'module-close') {
    allowed(module, 'removeKanbanChild')
    if (modules.length < 2) invalid('关闭变更模块前须保留至少一个其他可见模块。')
    return { body: { kanbanId: input.projectId } }
  }
  if (action === 'applications') return module ? {} : null
  if (action === 'templates' || action === 'headers') return {}
  if (action === 'configuration' || action === 'configuration-readback') return { query: { alterationModuleId: id(module.id) } }
  if (['manual-set', 'config-create', 'config-update', 'config-remove'].includes(action)) {
    allowed(module, 'configAlterationModule')
    const config = configuration(results)
    if (action === 'manual-set') {
      if (!Array.isArray(input.applicationIds) || new Set(input.applicationIds).size !== input.applicationIds.length) invalid('手动流程目录须为无重复 ID 数组；[] 恢复 UI 的全部变更流程。')
      const selected = (input.applicationIds as unknown[]).map(id)
      for (const key of selected) application(results, key)
      results.alterationContext = { ...asObject(results.alterationContext), manualIds: [...selected].sort() }
      return { body: { alterationId: id(config.id), flowApplicationIds: selected.join(',') } }
    }
    if (action === 'config-create') {
      application(results, input.applicationId)
      const memberIds = members(input.memberIds, results)
      results.alterationContext = { ...asObject(results.alterationContext), beforeIds: ids(config.configList), expected: { flowApplicationId: input.applicationId, isEffect: true, type: 'task', memberIds } }
      return { body: { alterationId: id(config.id), type: 'task', flowApplicationId: input.applicationId } }
    }
    const selected = selectedConfiguration(input, results)
    if (action === 'config-remove') {
      results.alterationContext = { ...asObject(results.alterationContext), expectedIds: ids(config.configList).filter(key => key !== id(selected.id)) }
      return { query: { alterationConfigId: id(selected.id) } }
    }
    const patch = asObject(input.patch), body: JsonObject = { alterationConfigId: id(selected.id) }, expected: JsonObject = {}
    if (!Object.keys(patch).length) invalid('请提供至少一项实际配置修改。')
    if (patch.applicationId !== undefined) { application(results, patch.applicationId); body.flowApplicationId = patch.applicationId; expected.flowApplicationId = patch.applicationId }
    if (patch.enabled !== undefined) { body.isEffect = patch.enabled; expected.isEffect = patch.enabled }
    if (patch.memberIds !== undefined) { const selectedMembers = members(patch.memberIds, results, selected.id); body.userIds = selectedMembers.join(','); expected.memberIds = selectedMembers }
    results.alterationContext = { ...asObject(results.alterationContext), expected, configId: id(selected.id) }
    return { body }
  }
  if (action === 'config-create-members') {
    const created = data(results.created), expected = asObject(asObject(results.alterationContext).expected)
    allowed(module, 'configAlterationModule')
    const refreshed = { ...results, configuration: results.postCreateConfiguration }
    selectedConfiguration({ configId: id(created.id) }, refreshed)
    const selectedMembers = members(expected.memberIds, refreshed, created.id)
    return { body: { alterationConfigId: id(created.id), userIds: selectedMembers.join(',') } }
  }
  if (action === 'list') {
    const body: JsonObject = { projectId: input.projectId, pageNum: input.page ?? 1, pageSize: input.pageSize ?? 30 }
    if ((input.sortKey === undefined) !== (input.sortValue === undefined)) invalid('排序字段与方向须一起提供。')
    if (input.sortKey !== undefined) {
      if (!rows(asObject(results.headers).data).some(row => row.id === input.sortKey) || ['40', '41'].includes(String(input.sortKey))) invalid('排序字段必须来自当前变更表头的基础字段。')
      body.sortKey = input.sortKey; body.sortValue = input.sortValue
    }
    if (input.filter !== undefined) body.filter = input.filter
    if (input.fieldFilter !== undefined) body.fieldFilter = input.fieldFilter
    return { body }
  }
  if (action === 'flow-create') {
    allowed(module, 'configAlterationModule'); allowed(project, 'createKanbanChild')
    results.alterationContext = { ...asObject(results.alterationContext), beforeModuleIds: ids(modules) }
    return { body: { kanbanId: input.projectId, name: input.name, type: 'workflow', mode: 'general', workflowModuleSubType: 'alterationWorkflow' } }
  }
  if (action === 'flow-copy') {
    allowed(module, 'configAlterationModule'); allowed(project, 'createKanbanChild')
    if (!rows(results.templates).some(row => same(row.moduleId, input.templateModuleId))) denied('变更模板模块须从当前专用目录发现，不能用普通流程模板替代。')
    results.alterationContext = { ...asObject(results.alterationContext), beforeModuleIds: ids(modules) }
    return { body: { id: input.templateModuleId, kanbanId: input.projectId, name: input.name } }
  }
  if (action === 'created-flow-detail') {
    const before = new Set(asObject(results.alterationContext).beforeModuleIds as string[])
    const found = rows(results.verifiedModules).filter(row => !before.has(id(row.id)) && row.type === 'workflow' && row.name === input.name)
    if (found.length !== 1) missing('未能通过 HTTP 唯一确认新变更流程模块；不要重复创建，请核对已完成步骤和资源 ID。')
    return { query: { id: id(found[0].id) } }
  }
  if (action === 'launch-application') {
    const choices = applications(results), manual = rows(configuration(results).manualApplicationList), selected = manual.length ? manual : choices
    allowed(module, 'manualStartAlteration')
    if (!selected.some(row => same(row.id, input.applicationId))) denied('只能发起当前模块手动目录允许的变更流程；空手动目录按 UI 表示全部。')
    application(results, input.applicationId)
    return { query: { id: input.applicationId } }
  }
  if (action === 'launch') {
    const selected = data(results.application)
    if (!same(selected.id, input.applicationId)) missing('变更流程详情与选择的应用不符。')
    allowed(selected, 'initProcess')
    return { body: { applicationId: input.applicationId, name: input.name, alterationProjectId: input.projectId } }
  }
  if (action === 'verify-instance') return { query: { processInfoId: id(data(results.started).id) } }
  throw new RsqError('INVALID_CONTRACT', '未知项目变更适配：' + action, 6)
}
export function verifyProjectAlteration(input: JsonObject, results: JsonObject, step: string) {
  const context = asObject(results.alterationContext)
  if (step === 'verifiedModules') {
    const found = rows(results.verifiedModules).filter(row => row.type === 'alteration')
    if (results.closed !== undefined ? found.length !== 0 : results.opened !== undefined && found.length !== 1) assertion('变更模块启停与独立目录不一致。')
    if (context.beforeModuleIds !== undefined) {
      const before = new Set(context.beforeModuleIds as string[])
      if (rows(results.verifiedModules).filter(row => !before.has(id(row.id)) && row.type === 'workflow' && row.name === input.name).length !== 1) assertion('变更流程复制或创建已受理，但 HTTP 尚未发现唯一新模块；只轮询目录，不重发写入。')
    }
  }
  if (step === 'verifiedConfiguration') {
    const actual = configuration(results, step), expected = asObject(context.expected), all = rows(actual.configList)
    if (context.manualIds !== undefined && !isDeepStrictEqual(ids(actual.manualApplicationList), context.manualIds)) assertion('手动变更流程目录保存后读回不一致。')
    if (context.expectedIds !== undefined && !isDeepStrictEqual(ids(actual.configList), context.expectedIds)) assertion('删除变更配置后实际目录或其他配置不一致。')
    if (Object.keys(expected).length) {
      const targetId = context.configId ?? data(results.created).id, found = all.filter(row => same(row.id, targetId))
      if (found.length !== 1) assertion('变更配置未出现在当前模块独立目录中。')
      const actual = found[0]
      for (const key of ['isEffect', 'type']) if (expected[key] !== undefined && actual[key] !== expected[key]) assertion('变更配置的开关或类型未持久化。')
      if (expected.flowApplicationId !== undefined && !same(actual.flowApplicationId, expected.flowApplicationId)) assertion('变更配置关联的流程应用读回不一致。')
      if (expected.memberIds !== undefined && !isDeepStrictEqual(ids(actual.userList), [...expected.memberIds as string[]].sort())) assertion('变更配置成员清空或赋值未持久化。')
      if (context.beforeIds !== undefined && !isDeepStrictEqual(ids(all).filter(key => key !== id(targetId)), context.beforeIds)) assertion('创建配置影响了其他配置目录。')
    }
  }
  if (step === 'createdFlow') {
    const module = asObject(results.createdFlow)
    if (module.name !== input.name || module.type !== 'workflow') assertion('新变更流程模块的实际名称或类型不符。')
    id(module.flowApplicationId)
  }
  if (step === 'createdApplication') {
    const actual = data(results.createdApplication), source = asObject(results.createdFlow)
    if (!same(actual.id, source.flowApplicationId) || !applications(results).some(row => same(row.id, actual.id))) assertion('新模块没有对应当前公司真实的变更流程应用。')
  }
  if (step === 'verifiedInstance') {
    const actual = data(results.verifiedInstance)
    if (!same(actual.id, data(results.started).id) || !same(actual.flowAppId, input.applicationId) || actual.name !== input.name) assertion('新变更实例的实际身份、流程应用或名称不符。')
    if (!rows(data(results.verifiedInstances).list).some(row => same(row.id, actual.id))) assertion('新实例未出现在所属项目的独立变更列表中。')
  }
}
export function describeProjectAlteration(input: JsonObject, results: JsonObject) {
  const context = asObject(results.alterationContext), configurationValue = results.verifiedConfiguration ?? results.configuration
  const config = configurationValue === undefined ? undefined : configuration(results, results.verifiedConfiguration === undefined ? 'configuration' : 'verifiedConfiguration')
  const listing = results.instances === undefined ? undefined : data(results.instances)
  return { projectId: id(input.projectId), ...(context.moduleId !== undefined && { moduleId: context.moduleId }),
    ...(results.module !== undefined && { permissions: asObject(results.module).editControl }),
    ...(config && { configuration: config, manualSelection: rows(config.manualApplicationList).length ? 'explicit-applications' : 'all-current-alteration-applications', emptyMemberSelection: 'UI-anyone; confirm effective launch using actual server canStartAlteration' }),
    ...(results.applications !== undefined && { applications: applications(results) }),
    ...(results.templates !== undefined && { templates: rows(results.templates) }),
    ...(listing && { records: rows(listing.list), requestedPage: input.page ?? 1, pageSize: input.pageSize ?? 30, nextPage: rows(listing.list).length === (input.pageSize ?? 30) ? Number(input.page ?? 1) + 1 : null, serviceTotal: listing.total, total: null, totalLimitation: 'Current service computes total after slicing; it is not the total number of project alterations.' }),
    ...(results.createdFlow !== undefined && { flow: asObject(results.createdFlow), applicationId: id(asObject(results.createdFlow).flowApplicationId) }),
    ...(results.verifiedInstance !== undefined && { instance: data(results.verifiedInstance) }),
    ...(results.verifiedModules !== undefined && { modules: rows(results.verifiedModules) }),
    ...(results.headers !== undefined && { columns: rows(asObject(results.headers).data) }) }
}
