import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { companyDirectoryUsers, companyDirectoryDepartments } from './contact.js'
import { requireSession, type Session } from './session.js'
import { appraisalAssessmentSteps, runAppraisalAssessment } from './appraisal-assessments.js'
import type { Workflow } from './workflows.js'

export const okrPerformanceActions = ['context', 'list', 'inspect'] as const
export type OkrPerformanceAction = typeof okrPerformanceActions[number]
type Route = [string, string, string]
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('绩效入口缺少精确的资源 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('绩效入口未返回有界列表。')
export function okrPerformanceSteps(action: OkrPerformanceAction): Route[] {
  const base: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['preference', 'GET', '/task/okr/preference'], ['directory', 'GET', '/task/v1/department/list'], ['initialized', 'GET', '/task/performance/init'], ['role', 'GET', '/task/performance/authority/role'], ['members', 'GET', '/task/performance/member/select'], ['viewAuth', 'GET', '/task/performance/view/auth']]
  if (action === 'context') return base
  return [...base, ['personal', 'GET', '/task/performance/appraisals/my'], ['person', 'GET', '/task/performance/appraisals/user'], ['department', 'GET', '/task/performance/appraisals/all'], ...(action === 'inspect' ? appraisalAssessmentSteps('assessment-inspect') : [])]
}
export function validateOkrPerformanceWorkflow(flow: Workflow) {
  if (!okrPerformanceActions.includes(flow.okrPerformanceAction!)) fail('未知 OKR 绩效操作。', 'INVALID_CONTRACT')
  const expected = okrPerformanceSteps(flow.okrPerformanceAction!)
  if (flow.executor !== 'okr-performance' || expected.length !== flow.steps.length || expected.some(([name, method, route], i) => {
    const step = flow.steps[i], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || name === 'members' && asObject(op.defaults?.query).type !== 'my' || Object.keys(step.input).length || step.prepare || step.verify || step.resources || step.transfer || step.authentication || step.readback || step.collectPages || step.forEach || step.waitBeforeMs || step.expectAbsent
  })) fail('OKR 绩效入口步骤与已核对协议不一致。', 'INVALID_CONTRACT')
}
export async function runOkrPerformance(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateOkrPerformanceWorkflow(flow)
  const session = requireSession(supplied), completed: string[] = [], action = flow.okrPerformanceAction!
  let phase = 'identity'
  const call = async (name: string, args: JsonObject = {}, envelope = false): Promise<unknown> => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) fail('未声明 OKR 绩效 HTTP 步骤。', 'INVALID_CONTRACT')
    phase = name; const result = await runOperation(ctx, op, args, session, options); completed.push(name)
    if (name === 'identity' || name === 'directory' || name === 'preference') return result
    const data = asObject(result)
    if (data.code !== 200 || !Object.hasOwn(data, 'data')) fail('绩效返回信封不完整。')
    return envelope ? result : data.data
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources: {}, result })
  try {
    const who = asObject(await call('identity'))
    if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('当前用户或公司与 profile 不一致。', 'IDENTITY_CHANGED')
    const preference = asObject(await call('preference'))
    if (preference.performanceOpenFlag !== true) fail('公司未开启 OKR 内绩效入口。', 'FEATURE_DISABLED')
    const directory = await call('directory'), users = companyDirectoryUsers(directory), departments = companyDirectoryDepartments(directory)
    const scope = String(input.scope ?? 'my'), target = scope === 'my' ? session.identity.userId : id(input.targetId)
    if (scope === 'my' && input.targetId != null) fail('本人入口不接受 targetId。', 'INVALID_INPUT')
    if (!['my', 'person', 'dept'].includes(scope)) fail('入口类型须为 my、person 或 dept。', 'INVALID_INPUT')
    if (!(scope === 'dept' ? departments : users).some(row => id(row.id) === target)) fail('目标不属于当前公司的实时通讯录。', 'FORBIDDEN')
    if (asObject(await call('initialized')).hasInit !== true) fail('当前公司尚未初始化绩效。', 'APPLICATION_NOT_INITIALIZED')
    const role = asObject(await call('role')), authority = asObject(role.authorities), members = rows(await call('members'))
    if (scope === 'my') {
      if (authority.performanceAppraisalMyData !== true) fail('当前角色不能查看本人绩效。', 'FORBIDDEN')
    } else {
      if (asObject(await call('viewAuth', { query: { type: scope, dataId: target } })).canViewPerformance !== true) fail('OKR 绩效入口没有目标人员或部门的查看权限。', 'FORBIDDEN')
      if (scope === 'dept' && authority.performanceAppraisalAllDataManage !== true && authority.performanceAppraisalDeptDataManage !== true) fail('当前角色没有部门考核管理权限。', 'FORBIDDEN')
    }
    const common = { scope, targetId: target, companyId: session.identity.teamId }
    if (action === 'context') return done({ ...common, authorized: true, performanceOpenFlag: true, managedMemberCount: members.length, context: 'okr-embedded-performance', availableTargets: { users: users.map(row => ({ id: id(row.id), name: row.name })), departments }, relatedCommands: ['okr performance list', 'okr performance get', 'appraisal context inspect', 'contact directory inspect'], semantics: '当前 UI 按人员或部门嵌入绩效；不是新增目标到绩效的绑定关系。' })
    const limit = Number(input.limit ?? 20), offset = Number(input.offset ?? 0), type = input.type ?? 'all'
    const listing = async (start: number, max: number) => {
      const response = asObject(await call(scope === 'my' ? 'personal' : scope === 'person' ? 'person' : 'department', { query: { type, offset: start, max, ...(scope === 'person' && { userId: target }), ...(scope === 'dept' && { deptId: target }) } }, true))
      const items = rows(response.data)
      if (items.length > max) fail('绩效列表超过请求窗口，不能推算下一页。')
      return { items, statistics: response.ext ?? null }
    }
    if (action === 'list') {
      const data = await listing(offset, limit)
      return done({ ...common, ...data, pagination: { offset, limit, total: null, nextOffset: data.items.length === limit ? offset + data.items.length : null, nextOffsetIsProbe: data.items.length === limit, windowEndReached: data.items.length < limit, complete: offset === 0 && data.items.length < limit } })
    }
    const targetAppraisal = id(input.appraisalId), seen = new Set<string>(); let selected: JsonObject | undefined
    for (let page = 0; page < 200; page++) {
      const { items } = await listing(page * 100, 100)
      for (const item of items) { const key = id(item.id); if (seen.has(key)) fail('绩效来源分页重复或变化。', 'CONTEXT_CONFLICT'); seen.add(key); if (key === targetAppraisal) selected = item }
      if (selected || items.length < 100) break
      if (page === 199) fail('绩效来源超过 200 页；未查询任意 ID 详情。', 'CONTEXT_LIMIT')
    }
    if (!selected) fail('考核不属于此 OKR 入口的实际来源列表。', 'FORBIDDEN')
    const graph = await runAppraisalAssessment('assessment-inspect', { appraisalId: targetAppraisal }, { call, role, userId: session.identity.userId, resources: {}, templateDetail: () => fail('此入口不构造绩效模板。', 'INVALID_CONTRACT') })
    return done({ ...common, source: selected, ...(graph as JsonObject), independentlyScoped: true })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', 'OKR 绩效业务未完成。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, cause: original.details, automaticRetry: false })
  }
}
