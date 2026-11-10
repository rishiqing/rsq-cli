import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation, type Operation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'

type Target = Operation | Workflow
type AccessPlan = { mode: 'business' | 'recovery'; features: string[]; permissions: string[]; conditionalFeatures: string[] }
const moduleFeatures: Record<string, string> = { workflow: 'WORKFLOW', appraisal: 'PERFORMANCE', okr: 'OKR', action: 'OKR', execution: 'EXECUTION',
  replay: 'REPLAY', project: 'PLAN', datasheet: 'PLAN', deliverable: 'PLAN', doc: 'KNOWLEDGE', file: 'CLOUD_LIB',
  'enterprise-statistics': 'TEAM_STATISTICS', 'plan-statistics-v2': 'PLAN',minder: 'MIND_MAP', archive: 'ARCHIVE', ai: 'AI_EMPLOYEE', automation: 'PLAN' }
const moduleTypeFeatures: Record<string, string> = { workflow: 'PLAN_WORKFLOW', datasheet: 'PLAN_DATASHEET', 'doc-module': 'PLAN_DOC',
  statistics: 'PLAN_STATISTICS', 'plan-overview': 'PLAN_OVERVIEW', 'risk-module': 'PLAN_RISK', alteration: 'PLAN_ALTERATION', deliverable: 'PLAN_DELIVERABLE' }
const recoveryRoutes = new Set(['/task/login/authAjax', '/task/v1/team', '/task/v1/team/switchUser', '/task/v1/team/fetchUserSiblings',
  '/task/authority/v3/authorities/company/current', '/task/v1/authority/currentCompanyAuthorities', '/task/v1/department/list',
  '/task/ordercenter/v2/member/state', '/task/ordercenter/v2/member/state/independent', '/task/ordercenter/v2/function/available'])

/** One rule function is used by Schema, offline plans and the public dispatcher. */
export function accessPlan(target: Target, input: JsonObject = {}): AccessPlan {
  const command = target.command, route = 'route' in target ? target.route : '', root = command.split(' ')[0]
  const recovery = route ? recoveryRoutes.has(route) : /^organization (?:list|context|create|switch|update|access inspect|lifecycle context)$/.test(command)
  const features = new Set<string>(), permissions = new Set<string>(), conditionalFeatures: string[] = []
  const add = (...values: string[]) => values.forEach(value => features.add(value))
  if (!recovery) {
    if (moduleFeatures[root]) add(moduleFeatures[root])
    if (/^(?:project )?workflow datasheet /.test(command)) { add('PLAN', 'PLAN_DATASHEET'); if (root === 'project') add('PLAN_WORKFLOW') }
    if (/^project workflow instance task /.test(command)) add('PLAN_WORKFLOW')
    if (/^project workflow (?:instances |instance children )/.test(command)) add('PLAN_WORKFLOW')
    if (/^doc group (?:create|rename|move|remove)$/.test(command)) permissions.add('editCorpusGroup')
    if (command.startsWith('okr performance ')) add('PERFORMANCE', 'OKR_PERFORMANCE')
    if (command.startsWith('okr statistics ')) add('OKR_STATISTICS')
    if (/^ai conversation (create|resolve)$/.test(command) && input.source === 'project_create') add('PLAN')
    const roleCommand = /^organization roles? (company|project|knowledge|cloud|archive) (.+)$/.exec(command)
    const roleRoute = /^\/task\/authority\/v3\/(role|authorities)\/(company|kanban|corpus|lib|archive)(?:\/batch)?$/.exec(route)
    if (roleCommand || roleRoute) {
      const module = roleCommand?.[1] ?? ({ kanban: 'project', corpus: 'knowledge', lib: 'cloud' }[roleRoute![2]!] ?? roleRoute![2]!)
      const feature = { project: 'PLAN', knowledge: 'KNOWLEDGE', cloud: 'CLOUD_LIB', archive: 'ARCHIVE' }[module]
      if (feature) add(feature)
      permissions.add('viewAuthorityManage')
      if (roleCommand && /^(create|rename|remove)$/.test(roleCommand[2]!)) {
        add('TEAM_AUTH_MANAGE')
        permissions.add(({ create: 'createCustomRole', rename: 'editCustomRole', remove: 'removeCustomRole' } as Record<string, string>)[roleCommand[2]!]!)
      }
      if (roleCommand?.[2]?.startsWith('permissions ') && roleCommand[2] !== 'permissions get') conditionalFeatures.push('TEAM_AUTH_MANAGE；公司创建者修改创建者范围按当前 UI 例外核对；普通权限另需 editCustomRole，范围核对 editDataManage')
    }
    if (/^\/task\/v1\/archive(?:Group|Bag|File)(?:\/|$)/.test(route)) add('ARCHIVE')
    if (command === 'task archive' || route === '/task/api/v3/task/archive') add('ARCHIVE')
    if (/^archive group (create|rename|remove)$/.test(command) || route === '/task/v1/archiveGroup' && 'method' in target && !['GET', 'HEAD', 'OPTIONS'].includes(target.method)) permissions.add('editArchiveBagGroup')
    if (command === 'file library create' || route === '/task/v1/folder' && 'method' in target && target.method === 'POST' && !Object.hasOwn(asObject(input.body), 'parentFolderId')) permissions.add('createLib')
    if (command === 'file library join' || route === '/task/v1/folder/join') permissions.add('joinTeamLib')
    if (command === 'file library owner transfer') permissions.add('editLibMemberCreatorRole')
    if (/^replay collection (configuration|settings set|rule )/.test(command)) permissions.add('replayManage')
    if (root === 'replay' && target.effect !== 'read' && (/^replay template /.test(command) || /^replay collection (add|rename|remove)$/.test(command)
      || route.startsWith('/task/review/replay/collect') && !['/task/review/replay/collect/sort', '/task/review/replay/collect/star'].includes(route) && 'method' in target && !['GET', 'HEAD', 'OPTIONS'].includes(target.method))) permissions.add('replayManage')
    if (command.startsWith('replay collection order ')) permissions.add('replayManage')
    if (command.startsWith('replay push-rule ') || route.startsWith('/task/replay-intelligence/replay/push/rule')) {
      // The selected application has its own authority endpoint. The workflow
      // also verifies replayIntelligence and the server whitelist before reading
      // a rule containing a Webhook credential.
      if (input.application !== 'okr') permissions.add('replayManage')
      conditionalFeatures.push('replayManage、replayIntelligence 及实际服务白名单；预览和试发调用 AI 并记账，启用和试发会发送群消息')
    }
    if (route.startsWith('/task/minder/')) add('MIND_MAP')
    if (/^project (?:template )?task type /.test(command) || root === 'task-template' || command.startsWith('task template ') || command.startsWith('task field ') || command.startsWith('company task-type ') || command.startsWith('project template task-type ') || command.startsWith('project template task field ') || route.startsWith('/task/api/v3/template')) add('PLAN', 'TASK_TYPE')
    if (['project task create', 'project template task create'].includes(command)) {
      conditionalFeatures.push('显式选择 templateId 要求 TASK_TYPE；未开通时省略该参数，由当前项目默认普通类型创建')
      if (input.templateId !== undefined) add('TASK_TYPE')
    }
    if (root === 'milestone') add('PLAN')
    if (command.startsWith('project risk ') || route.startsWith('/task/v3/kanban/risk')) add('PLAN', 'PLAN_RISK')
    if (command.startsWith('project alteration ') || route.startsWith('/task/v3/kanban/alteration/') || route.startsWith('/task/workflow/alteration/')) add('PLAN', 'PLAN_ALTERATION')
    if (command.startsWith('project alteration flow ') || asObject(input.body).workflowModuleSubType === 'alterationWorkflow') add('PLAN', 'PLAN_WORKFLOW', 'PLAN_ALTERATION')
    if (command.startsWith('task attachment ') || command.startsWith('task audit ')) add('PLAN', 'TASK_TYPE')
    if (command === 'project card tasks archive-completed' || route === '/task/api/v3/projectTask/batchArchive') add('PLAN', 'ARCHIVE')
    if (root === 'task' && input.projectId != null) add('PLAN')
    if (/^okr actions link (project|module)$/.test(command) || command === 'okr actions link task' && input.projectId != null) add('PLAN')
    if (command === 'okr actions link module') add('PLAN_DATASHEET')
    if ((['okr actions task create', 'replay relations task create', 'replay topic okr task create'].includes(command) || /^replay topic next-action create(?:-batch)?$/.test(command)) && input.taskTemplateId != null) add('PLAN', 'TASK_TYPE')
    if (command.startsWith('replay topic next-action fields ')) add('PLAN', 'TASK_TYPE')
    if (command.startsWith('notification okr ') || route.startsWith('/task/v3/objective/notification/')) add('OKR')
    if (command.startsWith('notification workflow ') || route.startsWith('/task/v3/workflow/notification/')) add('WORKFLOW')
    if (command.startsWith('notification project ') || route.startsWith('/task/v3/plan/notification/')) add('PLAN')
    if (command === 'notification settings apply-company' || route === '/task/v3/notification/saveForEveryone') permissions.add('editAllMemberNotifySettings')
    if (/^contact department (create|update|remove|move)$/.test(command) || route.startsWith('/task/v1/department') && 'method' in target && target.method !== 'GET' && !['/task/v1/department/batchChangeDepartment','/task/v1/department/changeStaffInfo','/task/v1/department/handover'].includes(route)) permissions.add('editDept')
    if (command === 'contact member departments set' || route === '/task/v1/department/batchChangeDepartment' || route === '/task/v1/department/changeStaffInfo') permissions.add('editStaffInfo')
    if (/^contact group (create|rename|remove|move)$/.test(command) || /^\/task\/v1\/staffGroupCrud/.test(route) && 'method' in target && target.method !== 'GET' || route === '/task/v1/staffGroup/sort') permissions.add('editStaffGroup')
    if (/^contact group member (add|remove)$/.test(command) || ['/task/v1/staffGroup/addStaffs','/task/v1/staffGroup/removeStaffs'].includes(route)) permissions.add('editStaffGroupMember')
    if (/^project group (create|rename|remove|move)$/.test(command) || route === '/task/v1/kanbanGroup/sort' || route === '/task/v1/kanbanGroup' && 'method' in target && target.method !== 'GET') permissions.add('editKanbanGroup')
    if (command === 'doc space create' || route === '/task/v1/corpus' && 'method' in target && target.method === 'POST') permissions.add('createCorpus')
    if (root === 'doc' && input.scope === 'company' || route === '/task/v1/corpus/templateSummary' && 'method' in target && target.method === 'POST' && asObject(input.body).type === 'company') permissions.add('editNoteTemp')
    if (command === 'project template create') permissions.add('editKanbanGroup')
    if (command === 'project template save' || route === '/task/v3/templateCover/generate') permissions.add('editKanbanTemp')
    if (command.startsWith('statistics company ') && !command.startsWith('statistics company usage ') || route.startsWith('/task/api/statistics/')) add('TEAM_STATISTICS')
    if (command.startsWith('statistics company usage ') || route === '/task/v1/team/useStatistical') permissions.add('viewTeamStatistics')
    if (command.startsWith('statistics company okr ')) add('OKR')
    if (command.startsWith('statistics company workflow ')) add('WORKFLOW')
    if (command.startsWith('cooperation workflow ')) conditionalFeatures.push('独立流程 WORKFLOW，或项目 PLAN + PLAN_WORKFLOW；从当前功能真值表核对，均不可用时停止队列请求')
    if (command.startsWith('statistics project ') || route.startsWith('/task/v5/kanban/stats/')) add('PLAN', 'PLAN_STATISTICS')
    if (command.startsWith('statistics project drilldown ')) {
      if (input.collectionId !== undefined) add('PLAN_COLLECTION')
      if (command.endsWith('risks list')) add('PLAN_RISK')
      if (command.endsWith('workflows list')) add('PLAN_WORKFLOW')
      if (command.endsWith('records list')) add('PLAN_DATASHEET')
    }
    if (command.startsWith('project collection ') || /\/kanbanCollection(?:Kanban)?(?:\/|$)|\/projectCollection\//.test(route)) add('PLAN', 'PLAN_COLLECTION')
    if (root === 'datasheet' || root === 'form-field' || route.startsWith('/task/mt/')) add('PLAN', 'PLAN_DATASHEET')
    if (root === 'deliverable' || command.startsWith('project template deliverable ') || route.startsWith('/task/files/project/') || route.startsWith('/task/files/deliverable/') || route.startsWith('/task/project/plan/deliverable/') || route.startsWith('/task/api/deliverable/')) add('PLAN', 'PLAN_DELIVERABLE')
    if (root === 'workflow' && /statistics|statistic/.test(command)) add('FLOW_STATISTICS')
    if (root === 'appraisal' && (/salary/.test(route) || command.startsWith('appraisal salary '))) add('PERFORMANCE_SALARY')
    if (root === 'okr' && /^okr indicator\b/.test(command) || /^\/task\/okr\/(?:indicator(?:\/|$)|import\/(?:optional\/)?indicator(?:\/|$))/.test(route)) add('OKR_INDICATOR')
    if (command === 'okr preferences update') {
      conditionalFeatures.push('isIndicatorHorizontal 需要 OKR_INDICATOR')
      if (input.isIndicatorHorizontal !== undefined) add('OKR_INDICATOR')
    }
    if (root === 'okr' && /^okr (?:planning|work-plans)\b/.test(command)) add('OKR_WORK')
    if (root === 'okr' && /^okr (?:kanban|publicity)\b/.test(command)) add('OKR_PUBLICITY')
    if (command === 'appraisal setup') add('PERFORMANCE')
    if (command === 'okr setup' || route === '/task/v1/okr/list') add('OKR')
    if (route === '/task/v1/performance/list') add('PERFORMANCE')
    const body = { ...asObject(input.body), ...asObject('defaults' in target ? target.defaults?.body : undefined) }
    if ((command.startsWith('project ') && /\bmodule (?:create|add)$/.test(command)) || (route === '/task/v1/kanbanChildCrud' && 'method' in target && target.method === 'POST')) {
      conditionalFeatures.push('module type → PLAN_WORKFLOW / PLAN_DATASHEET / PLAN_DOC / PLAN_STATISTICS / PLAN_OVERVIEW / PLAN_RISK / PLAN_ALTERATION / PLAN_DELIVERABLE')
      const type = input.type ?? body.type
      if (typeof type === 'string' && moduleTypeFeatures[type]) add(moduleTypeFeatures[type])
    }
    // A project can also enable modules in its initial creation request.
    // Checking only the later "add module" endpoint would leave a bypass.
    if (root === 'project') {
      conditionalFeatures.push('openModuleList → 逐个检查各项目模块功能，创建与修改使用同一限制')
      for (const type of Array.isArray(body.openModuleList) ? body.openModuleList : []) if (typeof type === 'string' && moduleTypeFeatures[type]) add(moduleTypeFeatures[type])
    }
    if (/^replay collection (configuration|settings set|rule )/.test(command)) permissions.add('replayManage')
    if (root === 'replay' && input.application === 'okr') add('OKR')
    // The same POST creates template projects or ordinary projects. Applying
    // a template must require ordinary-project creation permission even though
    // its preceding template reads and personal template creation are allowed.
    const createsProject = (method: string, path: string, headers: unknown) => method === 'POST' && path === '/task/v1/kanbanCrud'
      && !Object.entries(asObject(headers)).some(([key, value]) => key.toLowerCase() === 'plan-type' && value === 'template')
    if ('route' in target) {
      const headers = { ...asObject(input.headers), ...asObject(target.defaults?.headers) }
      if (createsProject(target.method, target.route, headers)) permissions.add('createKanban')
      else if (target.method === 'POST' && target.route === '/task/v1/kanbanCrud') permissions.add('editKanbanGroup')
    } else for (const step of target.steps) {
      const op = catalog.operations.find(op => op.id === step.operationId)
      if (op && createsProject(op.method, op.route, step.input.headers)) permissions.add('createKanban')
    }
  }
  return { mode: recovery ? 'recovery' : 'business', features: [...features].sort(), permissions: [...permissions].sort(), conditionalFeatures }
}
export function accessDescription(target: Target, input?: JsonObject) {
  return { ...accessPlan(target, input), fresh: '每次命令从当前身份读取订单、功能真值表和公司权限；不使用另一 profile 或磁盘缓存。',
    restrictions: ['公司或应用已到期', '当前人数超过可用人数，-1 为不限', '功能为 disable 或 update', '公司权限显式拒绝'],
    recovery: 'rsq organization access inspect；登录、当前身份、公司目录、切换公司和公司管理保留入口。--yes 不会跳过权益限制。',
    coverage: '模块和已核对子功能规则已接入；各业务按钮、字段类型和数量限制继续逐项复核，不能据此声称全部 UI 限制完成。' }
}
function operation(route: string): Operation {
  const matches = catalog.operations.filter(op => op.route === route && op.method === 'GET' && op.review === 'reviewed')
  if (matches.length !== 1) throw new RsqError('INVALID_CONTRACT', '权益检查缺少已核对的唯一 HTTP 契约。', 6)
  return matches[0]
}
/** All server timestamps without a zone are in Asia/Shanghai, never host TZ. */
export function deadlineEpoch(value: unknown): number {
  if (typeof value !== 'string') throw new RsqError('ENTITLEMENT_UNAVAILABLE', '订单缺少有效到期时间，无法确认业务可用性。', 4)
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) throw new RsqError('ENTITLEMENT_UNAVAILABLE', '订单到期时间格式无效，未执行业务请求。', 4)
  const normalized = value.replace(' ', 'T') + (match[8] ? '' : '+08:00'), time = Date.parse(normalized)
  const calendar = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))
  if (!Number.isFinite(time) || calendar.getUTCFullYear() !== +match[1] || calendar.getUTCMonth() !== +match[2] - 1 || calendar.getUTCDate() !== +match[3]
    || +match[4] > 23 || +match[5] > 59 || +match[6] > 59) throw new RsqError('ENTITLEMENT_UNAVAILABLE', '订单到期时间无效，未执行业务请求。', 4)
  return time
}
export function validateCompanyState(state: JsonObject, now = Date.now()) {
  const deadline = deadlineEpoch(state.deadLine), count = state.usersCount, limit = state.userLimit
  if (!Number.isSafeInteger(count) || Number(count) < 0 || !Number.isSafeInteger(limit) || Number(limit) < -1 || typeof state.vt !== 'string' || !state.vt
    || typeof state.mainApp !== 'string' || !state.mainApp) throw new RsqError('ENTITLEMENT_UNAVAILABLE', '订单人数或版本信息无效，未执行业务请求。', 4)
  if (now > deadline) throw new RsqError('COMPANY_EXPIRED', '公司或当前应用已到期，请联系管理员续费后重试。', 4, { deadLine: state.deadLine, mainApp: state.mainApp })
  if (Number(limit) !== -1 && Number(count) > Number(limit)) throw new RsqError('COMPANY_OVER_CAPACITY', '当前使用人数超过可用名额，请联系管理员调整人数或套餐。', 4, { usersCount: count, userLimit: limit, mainApp: state.mainApp })
}
const companyPermissions: Record<string, string> = { PLAN: 'useKanban', TEAM_STATISTICS: 'useEnterpriseStatistics', WORKFLOW: 'useFlow', OKR: 'useObjective',
  PERFORMANCE: 'usePerformance', KNOWLEDGE: 'useCorpus', REPLAY: 'useReplay', EXECUTION: 'useExecution' }
export function validateFeatures(features: string[], payload: unknown, permissions: JsonObject) {
  if (!Array.isArray(payload)) throw new RsqError('ENTITLEMENT_UNAVAILABLE', '功能真值表无效，未执行业务请求。', 4)
  const values = new Map<string, string>()
  for (const row of payload) {
    const item = asObject(row)
    if (typeof item.funcName !== 'string' || !item.funcName || !['enable', 'disable', 'update'].includes(String(item.status)) || values.has(item.funcName)) throw new RsqError('ENTITLEMENT_UNAVAILABLE', '功能真值表存在无效或重复条目。', 4)
    values.set(item.funcName, String(item.status))
  }
  for (const feature of features) {
    // Matches createFuncAvailableMap: missing entries default to enable except
    // PLAN_PROJECT_REPORT, whose shipped UI default is disable.
    const state = values.get(feature) ?? (feature === 'PLAN_PROJECT_REPORT' ? 'disable' : 'enable')
    if (state !== 'enable') throw new RsqError(state === 'update' ? 'FEATURE_UPGRADE_REQUIRED' : 'FEATURE_DISABLED', '当前公司或应用未开通此功能。', 4, { feature, status: state })
    const field = companyPermissions[feature] ?? feature
    if (Object.hasOwn(permissions, field) && permissions[field] !== true) throw new RsqError('FEATURE_FORBIDDEN', '当前用户的公司权限不允许使用此功能。', 4, { feature, permission: field })
  }
}
export function validatePermissions(required: string[], permissions: JsonObject) {
  for (const permission of required) if (permissions[permission] !== true) throw new RsqError('FEATURE_FORBIDDEN', '当前用户的公司权限不允许执行此操作。', 4, { permission })
}
export async function readAccessContext(ctx: Context, supplied: Session | null, transport?: Transport) {
  const session = requireSession(supplied), identity = asObject(await runOperation(ctx, operation('/task/login/authAjax'), {}, session, { transport }))
  const teamId = asObject(identity.team).id ?? identity.teamId
  if (String(identity.id) !== session.identity.userId || (teamId == null ? undefined : String(teamId)) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED', '服务端公司与当前 profile 不一致，请重新登录或明确切换公司。', 3)
  const state = asObject(await runOperation(ctx, operation('/task/ordercenter/v2/member/state/independent'), {}, session, { transport }))
  return { session, state }
}
export async function checkAccess(ctx: Context, target: Target, input: JsonObject, supplied: Session | null, transport?: Transport) {
  const plan = accessPlan(target, input)
  if (plan.mode === 'recovery') return
  const { session, state } = await readAccessContext(ctx, supplied, transport)
  validateCompanyState(state)
  if (!plan.features.length && !plan.permissions.length) return
  const functions = await runOperation(ctx, operation('/task/ordercenter/v2/function/available'), { query: { vt: state.vt } }, session, { transport })
  const permissions = asObject(await runOperation(ctx, operation('/task/authority/v3/authorities/company/current'), {}, session, { transport }))
  validateFeatures(plan.features, functions, permissions)
  validatePermissions(plan.permissions, permissions)
}
export async function inspectAccess(ctx: Context, supplied: Session | null, transport?: Transport) {
  const { session, state } = await readAccessContext(ctx, supplied, transport)
  const functions = await runOperation(ctx, operation('/task/ordercenter/v2/function/available'), { query: { vt: state.vt } }, session, { transport })
  const permissions = asObject(await runOperation(ctx, operation('/task/authority/v3/authorities/company/current'), {}, session, { transport }))
  return describeAccessContext(session.identity, state, functions, permissions)
}
export function describeAccessContext(identity: unknown, state: JsonObject, functions: unknown, permissions: JsonObject) {
  let restriction: unknown = null
  try { validateCompanyState(state); validateFeatures([], functions, permissions) } catch (error) {
    if (!(error instanceof RsqError)) throw error
    restriction = { code: error.code, message: error.message, ...error.details }
  }
  return { identity, checkedAt: new Date().toISOString(), state, functions, permissions, available: restriction === null, availabilityScope: 'current-company-order', restriction }
}
