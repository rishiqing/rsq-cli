import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { cookieJar, requireSession, sessionOrigin, type Session } from './session.js'
import { fingerprint } from './fingerprint.js'
import { AutomationRuleSchema } from './automation-schema/index.js'
import { WorkflowType } from './automation-schema/enums.js'
import { validateFeatures } from './access.js'
import type { Workflow } from './workflows.js'
export const automationKinds = Object.entries(WorkflowType).filter(([, value]) => typeof value === 'number').map(([name, value]) => ({ name: name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()), value: Number(value) }))
export const automationActions = ['context', 'resources', 'list', 'inspect', 'create', 'copy', 'configure', 'remove', 'state', 'logs', 'run'] as const
export type AutomationAction = typeof automationActions[number]
type Route = [string, string, string]
type Call = (step: string, input?: JsonObject) => Promise<unknown>
const base = '/task/automation/rules', same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
function fail(code: string, message: string): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
function ensure(value: unknown, message: string): asserts value { if (!value) fail('BUSINESS_ASSERTION_FAILED', message) }
const id = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : fail('CONTEXT_MISSING', '自动化当前服务只接受安全整数资源 ID。')
const key = (value: unknown, prefix = 'rule') => typeof value === 'string' && new RegExp('^' + prefix + '[A-Za-z0-9_-]{10}$').test(value) ? value : fail('CONTEXT_MISSING', '自动化返回了不符合实际前缀与长度的资源 ID。')
const rows = (value: unknown) => { ensure(Array.isArray(value) && value.length <= 10000, '自动化上下文未返回完整的有界列表。'); return value.map(asObject) }
function data(value: unknown) { const result = asObject(value); if (Object.hasOwn(result, 'code')) { ensure(result.code === 200 && Object.hasOwn(result, 'data'), '自动化 HTTP 业务信封不是成功。'); return result.data }; return value }
const secretKey = /^(?:secret|webhookUrl|accessToken|apiKey|token|secretKey)$/i
export function maskAutomation(value: unknown): unknown { if (Array.isArray(value)) return value.map(maskAutomation); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([k, v]) => secretKey.test(k) ? [k + 'Configured', typeof v === 'string' && v.length > 0] : [k, maskAutomation(v)])) }
function rules(value: unknown, kind: number) { const result = rows(data(value)), seen = new Set<string>(); for (const row of result) { const resource = key(row.id); ensure(!seen.has(resource) && row.module === kind && typeof row.name === 'string' && typeof row.isRunning === 'boolean', '规则目录有重复 ID 或不属于所选业务类型。'); seen.add(resource) }; return result }
function unique(list: JsonObject[], target: unknown) { const found = list.filter(row => same(row.id, target)); if (found.length !== 1) fail('FORBIDDEN', '规则必须来自当前项目和类型的实际目录，不能猜规则 ID。'); return found[0] }
export function automationSteps(action: AutomationAction): Route[] {
  const scope: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['state', 'GET', '/task/ordercenter/v2/member/state/independent'], ['project', 'GET', '/task/v1/kanbanCrud'], ['modules', 'GET', '/task/v1/kanbanChildCrud/list'], ['counts', 'GET', base + '/count']]
  const resource: Route[] = [['functions', 'GET', '/task/ordercenter/v2/function/available'], ['companyPermissions', 'GET', '/task/authority/v3/authorities/company/current'], ['members', 'GET', '/task/v1/department/list'], ['roles', 'GET', '/task/authority/v3/role/kanban'], ['applications', 'GET', '/task/workflow/application/listByProjectId'], ['fields', 'GET', '/task/mt/loom/datasheet/{datasheetId}/fields'], ['taskFields', 'GET', '/task/api/v3/template/systemField/list'], ['taskTemplates', 'GET', '/task/api/v3/template/settingList'], ['labels', 'GET', '/task/v1/kanbanLabel/list'], ['cards', 'GET', '/task/v1/kanbanCardCrud/list'], ['processRoles', 'GET', '/task/workflow/application/member/identities'], ['keyNodes', 'GET', '/task/workflow/form/keyNode/field/list'], ['templates', 'GET', '/task/v3/templateCover/list'], ['groups', 'GET', '/task/v3/kanbanGroup/list']]
  if (action === 'context') return scope
  if (action === 'resources') return [...scope, ...resource]
  const list: Route = ['rules', 'GET', base]
  if (['list', 'inspect'].includes(action)) return [...scope, list]
  const logs: Route = ['logs', 'GET', base + '/logs']
  if (action === 'logs') return [...scope, list, logs]
  const mutation: Route = ['changed', action === 'remove' ? 'DELETE' : ['configure', 'state'].includes(action) ? 'PUT' : 'POST', base + (({ remove: '/{ruleId}', state: '/status', copy: '/copy', run: '/urge' } as Record<string, string>)[action] ?? '')]
  return [...scope, list, ...(['configure', 'state', 'run'].includes(action) ? resource : []), ...(action === 'run' ? [logs] : []), mutation, ['verified', 'GET', base], ...(action === 'run' ? [['verifiedLogs', 'GET', base + '/logs'] as Route] : [])]
}
export function validateAutomationWorkflow(flow: Workflow) {
  if (!automationActions.includes(flow.automationAction!)) fail('INVALID_CONTRACT', '未知自动化操作。')
  const expected = automationSteps(flow.automationAction!)
  if (flow.executor !== 'automation' || expected.length !== flow.steps.length || expected.some(([name, method, route], i) => { const step = flow.steps[i], op = catalog.operations.find(op => op.id === step.operationId); return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.authentication || step.resources || step.transfer || step.forEach || step.readback || step.collectPages || step.waitBeforeMs || step.expectAbsent })) fail('INVALID_CONTRACT', '自动化步骤与已核对的当前 HTTP 协议不符。')
}
export function validateAutomationInput(input: JsonObject) {
  if (!Object.hasOwn(input, 'configuration')) return
  const config = structuredClone(asObject(input.configuration)), actions = rows(config.actions)
  // A retained action can resolve its existing Webhook URL only after the real
  // directory is read. This marker is validation-only and is never transmitted.
  for (const action of actions) if (action.senderType === 'webhook' && action.id && !action.webhookUrl && !action.robotId) action.webhookUrl = 'resolve-existing-secret-after-http'
  config.actions = actions
  const check = AutomationRuleSchema.safeParse(config)
  if (!check.success) throw new RsqError('INVALID_INPUT', '自动化配置不符合当前 UI 校验。', 2, { issues: check.error.issues.map(issue => ({ path: issue.path, message: issue.message })) })
}
async function resourceContext(call: Call, projectId: string, modules: JsonObject[], input: JsonObject, vt: unknown) {
  const functions = await call('functions', { query: { vt } }), company = asObject(await call('companyPermissions'))
  if (input.datasheetId != null) validateFeatures(['PLAN_DATASHEET'], functions, company)
  if (input.applicationId != null) validateFeatures(['PLAN_WORKFLOW'], functions, company)
  let workflowAvailable = true
  try { validateFeatures(['PLAN_WORKFLOW'], functions, company) } catch { workflowAvailable = false }
  // Current automation UI sends projectId here, but the actual task DTO binds
  // id. Use the server's real parameter to retain project-local templates.
  const members = rows(await call('members')), roles = asObject(await call('roles')), applications = workflowAvailable && modules.some(row => row.type === 'workflow') ? rows(data(await call('applications', { query: { projectId } }))).filter(row => row.mode === 0) : [], taskFields = rows(await call('taskFields')), taskTemplates = await call('taskTemplates', { query: { id: projectId } }), labels = rows(await call('labels', { query: { kanbanId: projectId } })), templates = await call('templates'), groups = await call('groups')
  const result: JsonObject = { members, roles, applications, taskFields, taskTemplates, labels, templates, groups, modules }
  if (input.datasheetId != null) {
    const linked = modules.filter(row => row.type === 'datasheet' && asObject(row.datasheetInfo).datasheetId === input.datasheetId); if (linked.length !== 1) fail('FORBIDDEN', '数据表必须来自当前项目实际模块。')
    result.datasheetId = input.datasheetId; result.fields = rows(asObject(data(await call('fields', { path: { datasheetId: input.datasheetId } }))).fields)
  }
  if (input.applicationId != null) {
    if (!applications.some(row => same(row.id, input.applicationId))) fail('FORBIDDEN', '流程应用必须来自当前项目实际可用目录。')
    result.applicationId = id(input.applicationId); result.processRoles = data(await call('processRoles', { query: { id: input.applicationId } })); result.keyNodes = rows(data(await call('keyNodes', { query: { applicationId: input.applicationId } })))
  }
  const cards = []
  for (const module of modules.filter(row => row.type === 'task')) cards.push({ moduleId: id(module.id), cards: rows(await call('cards', { query: { kanbanChildId: id(module.id) } })) })
  result.cards = cards
  return result
}
function checkReferences(config: JsonObject, resources: JsonObject, projectId: string) {
  const trigger = asObject(config.trigger), modules = rows(resources.modules), actions = rows(config.actions)
  if (Array.isArray(trigger.planIdList)) for (const plan of trigger.planIdList) if (plan !== 'all' && !modules.some(row => row.type === 'task' && same(row.id, plan))) fail('FORBIDDEN', '触发器的计划 ID 不属于当前项目任务模块。')
  if (trigger.datasheetId != null && trigger.datasheetId !== resources.datasheetId || trigger.applicationId != null && !same(trigger.applicationId, resources.applicationId)) fail('FORBIDDEN', '触发器数据表或流程不是已独立读取的当前项目资源。')
  const memberIds = new Set<string>(), departmentIds = new Set<string>()
  const walk = (tree: JsonObject[]) => { for (const row of tree) { departmentIds.add(id(row.id)); for (const person of rows(row.userList ?? [])) memberIds.add(id(person.id)); walk(rows(row.childList ?? [])) } }; walk(rows(resources.members))
  const member = (value: unknown) => { const row = asObject(value); if (row.type === 'person' && !memberIds.has(id(row.id))) fail('FORBIDDEN', '自动化人员不在当前实际可见通讯录。') }
  const fields = rows(resources.fields ?? []), field = (value: unknown) => { if (value != null && !fields.some(row => same(row.id, value))) fail('INVALID_INPUT', '数据字段不属于所选数据表当前字段目录。') }
  if (trigger.datasheetId != null) { const options = asObject(trigger.options); field(options.dateFieldId); field(asObject(options.changeCondition).fieldId) }
  for (const action of actions) {
    for (const value of ['createMember', 'editorId'].filter(k => action[k] != null)) if (value === 'createMember') member(action[value]); else if (!memberIds.has(id(action[value]))) fail('FORBIDDEN', '自动化指定发送人不在当前实际通讯录。')
    for (const name of ['senderList', 'taskMembers', 'projectMembers', 'processMembers']) if (Array.isArray(action[name])) for (const value of action[name] as unknown[]) member(value)
    if (action.type === 'updateDatasheetField') field(asObject(action.condition).fieldId ?? asObject(action.condition).filterType)
    // Cross-project targets need their own complete permissions and dictionaries;
    // do not turn a source project authorization into a destination grant.
    if (action.projectId != null && !same(action.projectId, projectId)) fail('CONTEXT_MISSING', '跨项目动作尚需目标项目上下文，当前不能复用来源项目授权。')
    if (action.type === 'taskMove') { const plans = (resources.cards as JsonObject[]).filter(row => same(row.moduleId, action.planId)); if (plans.length !== 1 || !rows(plans[0].cards).some(row => same(row.id, action.cardId))) fail('FORBIDDEN', '任务移动的目标计划/卡片不属于实际项目目录。') }
  }
  const timing = asObject(trigger.timing)
  if (timing.time != null && (typeof timing.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timing.time))) fail('INVALID_INPUT', '自动化执行时间须为 24 小时制 HH:mm。')
}
export async function runAutomation(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateAutomationWorkflow(flow); validateAutomationInput(input)
  let session = requireSession(supplied), phase = 'identity', writeAttempted = false, accepted = false
  const action = flow.automationAction!, completed: string[] = [], resources: JsonObject = { projectId: id(input.projectId) }, projectId = String(resources.projectId), kind = automationKinds.find(row => row.name === input.kind)
  const call: Call = async (name, args = {}) => { phase = name; const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId); if (!op) fail('INVALID_CONTRACT', '未声明自动化步骤。'); if (name === 'changed') writeAttempted = true; const result = await runOperation(ctx, op, args, session, options); completed.push(name); return result }
  const result = (value: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources, result: value })
  try {
    const who = asObject(await call('identity')); if (!same(who.id, session.identity.userId) || !same(asObject(who.team).id, session.identity.teamId)) fail('IDENTITY_CHANGED', '自动化公司与 profile 不一致。')
    const state = asObject(await call('state')); ensure(typeof state.vt === 'string' && typeof state.mainApp === 'string', '实际应用版本与 mainApp 缺失。')
    const jar = cookieJar(session); await jar.setCookie('vt=' + encodeURIComponent(state.vt) + '; Path=/; Secure', sessionOrigin(ctx, session.method)); session = { ...session, cookies: jar.serializeSync() }
    const loadProject = async () => { const row = asObject(await call('project', { query: { id: projectId, isDefault: false } })); ensure(same(row.id, projectId) && row.coverId === null, '自动化目标必须是实际普通项目；模板不能借项目权限直接运行。'); return row }
    let project = await loadProject(), modules = rows(await call('modules', { query: { kanbanId: projectId } })), counts = asObject(data(await call('counts', { query: { projectId: Number(projectId) } })))
    for (const [k, value] of Object.entries(counts)) ensure(automationKinds.some(row => String(row.value) === k) && Number.isSafeInteger(value) && Number(value) >= 0, '规则计数不符合真实类型或非负整数。')
    const baseResult = { companyId: session.identity.teamId, projectId, permissions: { configure: asObject(project.editControl).automationConfig === true, run: asObject(project.editControl).automationRun === true }, kinds: automationKinds, activeCounts: counts, modules: maskAutomation(modules), listMayCreateDefault: true }
    if (action === 'context') return result({ ...baseResult, relatedCommands: ['automation resources', 'automation rules list', 'automation rule inspect', 'automation rule create', 'automation rule configure', 'automation rule state set', 'automation rule logs', 'automation rule run'] })
    if (action === 'resources') return result({ ...baseResult, context: maskAutomation(await resourceContext(call, projectId, modules, input, state.vt)) })
    if (!kind) fail('INVALID_INPUT', '请选择 Schema 返回的自动化业务类型。')
    resources.kind = kind.name
    if (!['list', 'inspect', 'logs'].includes(action) && asObject(project.editControl)[action === 'run' ? 'automationRun' : 'automationConfig'] !== true) fail('FORBIDDEN', '当前项目未授予此自动化操作权限，未读取或初始化规则。')
    const query = { workflowType: kind.value, projectId: Number(projectId), mainApp: state.mainApp }, initial = rules(await call('rules', { query }), kind.value)
    const version = fingerprint(initial)
    if (action === 'list') return result({ ...baseResult, kind: kind.name, rules: maskAutomation(initial), contextVersion: version, complete: true })
    let current = ['create'].includes(action) ? undefined : unique(initial, input.ruleId)
    if (current) resources.ruleId = key(current.id)
    if (action === 'inspect') return result({ ...baseResult, kind: kind.name, rule: maskAutomation(current), contextVersion: fingerprint(current) })
    const logRows = async (name = 'logs') => { const list = rows(data(await call(name, { query: { ruleId: resources.ruleId } }))), seen = new Set(); for (const row of list) { const id = key(row.logId, 'log'); ensure(!seen.has(id) && typeof row.isSuccess === 'boolean' && (row.executedAt === null || Number.isSafeInteger(row.executedAt)), '自动化日志缺少真实状态、ID 或执行时间。'); seen.add(id) }; return list }
    if (action === 'logs') return result({ ...baseResult, kind: kind.name, ruleId: resources.ruleId, logs: (await logRows()).map(row => ({ ...row, message: String(row.message ?? '').replace(/https?:\/\/\S+/g, '[redacted-url]') })), logLimit: '服务端最近记录，不宣称完整执行历史' })
    project = await loadProject()
    const permission = action === 'run' ? 'automationRun' : 'automationConfig'
    if (asObject(project.editControl)[permission] !== true) fail('FORBIDDEN', '当前项目未授予所需自动化权限：' + permission)
    if (input.contextVersion != null && input.contextVersion !== fingerprint(current ?? initial)) fail('CONTEXT_CONFLICT', '自动化上下文已变化；请先重新读取，不自动覆盖。')
    let body: JsonObject = {}, expected: JsonObject | undefined, oldLogs: JsonObject[] = []
    if (action === 'create') body = { workflowType: kind.value, projectId: Number(projectId), mainApp: state.mainApp }
    else if (action === 'copy' || action === 'run') body = { ruleId: resources.ruleId }
    else if (action === 'state') body = { ruleId: resources.ruleId, isRunning: input.running }
    if (['configure', 'state', 'run'].includes(action) && (action !== 'state' || input.running === true)) {
      expected = structuredClone(action === 'configure' ? asObject(input.configuration) : current!)
      if (action === 'configure') {
        ensure(asObject(expected.trigger).type === asObject(current!.trigger).type, '业务类型的触发器不能替换为其他类型。')
        expected.trigger = { ...asObject(expected.trigger), ...(asObject(current!.trigger).id ? { id: asObject(current!.trigger).id } : {}) }
        const existing = rows(current!.actions), incoming = rows(expected.actions), seen = new Set()
        for (const item of incoming) if (item.id) { key(item.id, 'action'); ensure(!seen.has(item.id), '动作 ID 不能重复。'); seen.add(item.id); const previous = unique(existing, item.id); for (const name of ['webhookUrl', 'secret']) if (!Object.hasOwn(item, name) && previous[name] !== undefined) item[name] = previous[name] }
      }
      const valid = AutomationRuleSchema.safeParse(expected); if (!valid.success) fail('INVALID_INPUT', '实际配置仍不满足当前 UI 的触发器与动作约束。')
      const trigger = asObject(expected.trigger), dictionary = await resourceContext(call, projectId, modules, { datasheetId: trigger.datasheetId, applicationId: trigger.applicationId }, state.vt)
      checkReferences(expected, dictionary, projectId)
      if (action === 'configure') body = { id: resources.ruleId, trigger: expected.trigger, actions: expected.actions }
    }
    // A second real directory read detects changes before dispatch. This is not
    // server-side CAS; no automatic write replay or conflict overwrite follows.
    const fresh = rules(await call('rules', { query }), kind.value)
    if (current && !isDeepStrictEqual(unique(fresh, current.id), current) || !current && fingerprint(fresh) !== version) fail('CONTEXT_CONFLICT', '规则在写前已变化，请重新读取。')
    if (action === 'run') { if (![WorkflowType.UrgeDelayedTask, WorkflowType.UrgeProcessTodo].includes(kind.value)) fail('INVALID_INPUT', '仅当前 UI 的两类一键催办可手动运行。'); oldLogs = await logRows() }
    const changed = await call('changed', action === 'remove' ? { path: { ruleId: resources.ruleId } } : { body }); accepted = true
    if (['create', 'copy'].includes(action)) { const created = asObject(data(changed)); resources.ruleId = key(created.id); ensure(!initial.some(row => row.id === created.id) && created.module === kind.value && created.isRunning === false, '新建/复制未返回本类型新的停用规则。'); current = created }
    const after = rules(await call('verified', { query }), kind.value)
    const unaffected = (list: JsonObject[]) => list.filter(row => row.id !== resources.ruleId).map(row => [row.id, fingerprint(row)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ensure(isDeepStrictEqual(unaffected(initial), unaffected(after)), '独立读回发现其他规则变化；不自动恢复或覆盖。')
    if (action === 'remove') { ensure(!after.some(row => row.id === resources.ruleId), '规则删除后仍出现在原项目类型目录。'); return result({ ...baseResult, kind: kind.name, ruleId: resources.ruleId, removed: true, verified: true }) }
    const verified = unique(after, resources.ruleId)
    if (['create', 'copy'].includes(action)) ensure(isDeepStrictEqual(verified, current), '新规则响应和独立目录读回不一致。')
    if (action === 'state') ensure(verified.isRunning === input.running, '启停状态与请求不符。')
    if (action === 'configure') {
      const withoutRuntimeId = (value: unknown) => Object.fromEntries(Object.entries(asObject(value)).filter(([k]) => k !== 'id'))
      ensure(isDeepStrictEqual(withoutRuntimeId(verified.trigger), withoutRuntimeId(expected!.trigger)) && isDeepStrictEqual(rows(verified.actions).map(withoutRuntimeId), rows(expected!.actions).map(withoutRuntimeId)), '配置与独立读回不一致。')
    }
    let execution: JsonObject = {}
    if (action === 'run') { const logs = (await logRows('verifiedLogs')).filter(row => !oldLogs.some(old => old.logId === row.logId)); if (logs.some(row => row.isSuccess === false)) fail('BUSINESS_EXECUTION_FAILED', '催办请求已受理，但独立新日志报告执行失败；可能已扣费或部分发送，不能自动重放。'); execution = { accepted: true, executionStatus: logs.length ? 'succeeded' : 'pending', observedLogIds: logs.map(row => row.logId), chargedOrNotified: 'consult-execution-logs-and-recipient-readback', automaticRetry: false } }
    return result({ ...baseResult, kind: kind.name, rule: maskAutomation(verified), contextVersion: fingerprint(verified), verified: true, ...execution })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '自动化操作未完成。', 5)
    throw new RsqError(original.code, error instanceof RsqError ? original.message.replace(/https?:\/\/\S+/g, '[redacted-url]') : '自动化操作未完成。', original.exit, { failedStep: phase, completedSteps: completed, resources, writeAttempted, accepted, ...(writeAttempted && !accepted ? { resultMayBeUnknown: true } : {}), ...(original.code === 'INVALID_INPUT' ? { validation: original.details?.issues } : {}), automaticRetry: false })
  }
}
