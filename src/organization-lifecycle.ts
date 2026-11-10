import { CookieJar } from 'tough-cookie'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { sessionFromIdentityResponse } from './auth.js'
import { validateCompanyState } from './access.js'
import { companyDirectoryUsers } from './contact.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, saveSession, type Session } from './session.js'
import type { OrganizationStore } from './organization.js'
import type { Workflow } from './workflows.js'

export const organizationLifecycleActions = ['lifecycle-context', 'transfer', 'remove'] as const
export type OrganizationLifecycleAction = typeof organizationLifecycleActions[number]
const auth = '/task/login/authAjax', siblings = '/task/v1/team/fetchUserSiblings', team = '/task/v1/team'
type Route = [string, string, string]
const fail = (code: string, message: string, exit = 5): never => { throw new RsqError(code, message, exit) }
function id(value: unknown): string {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return fail('CONTEXT_MISSING', '公司生命周期上下文缺少精确的用户或公司 ID。')
}
function directory(value: unknown) {
  if (!Array.isArray(value)) fail('CONTEXT_MISSING', '账号组织目录缺失。')
  const result = (value as unknown[]).map(item => {
    const row = asObject(item)
    return { userId: id(row.id), teamId: row.team === null ? null : id(asObject(row.team).id) }
  })
  if (new Set(result.map(item => item.userId)).size !== result.length) fail('CONTEXT_MISSING', '账号组织目录存在重复用户。')
  return result.sort((a, b) => a.userId.localeCompare(b.userId))
}
export function organizationLifecycleSteps(action: OrganizationLifecycleAction): Route[] {
  const base: Route[] = [['identity', 'GET', auth], ['state', 'GET', '/task/ordercenter/v2/member/state/independent'],
    ['before', 'GET', siblings], ['members', 'GET', '/task/v1/department/list']]
  return action === 'lifecycle-context' ? base : [...base, ['changed', action === 'transfer' ? 'POST' : 'DELETE', action === 'transfer' ? team + '/transfer' : team],
    ['verified', 'GET', auth], ['after', 'GET', siblings]]
}
export function validateOrganizationLifecycleWorkflow(flow: Workflow) {
  const action = flow.organizationAction as OrganizationLifecycleAction
  if (!organizationLifecycleActions.includes(action)) fail('INVALID_CONTRACT', '未知公司生命周期操作。', 6)
  const expected = organizationLifecycleSteps(action)
  if (flow.executor !== 'organization' || flow.steps.length !== expected.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.authentication || step.prepare || step.verify || step.resources || step.forEach || step.transfer || step.readback || step.collectPages || step.expectAbsent || step.waitBeforeMs
  })) fail('INVALID_CONTRACT', '公司生命周期步骤与当前协议不一致。', 6)
}
type Snapshot = { userId: string; teamId: string; name: string; creatorId: string; creator: boolean; native: boolean; state: JsonObject; members: string[]; organizations: ReturnType<typeof directory> }
export async function runOrganizationLifecycle(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null,
  options: { approved?: boolean; transport?: Transport; storeSession?: OrganizationStore } = {}) {
  validateOrganizationLifecycleWorkflow(flow)
  const session = requireSession(supplied), action = flow.organizationAction as OrganizationLifecycleAction, jar = new CookieJar()
  const completed: string[] = [], resources: Record<string, string> = {}
  let phase = 'identity', writeAttempted = false, writeAcknowledged = false, writeResponseReceived = false, localSessionUpdated = false
  const transport: Transport = async (url, init) => {
    const response = await (options.transport ?? request)(url, init)
    if (phase === 'changed') writeResponseReceived = true
    for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href, { ignoreError: true })
    return response
  }
  const call = async (name: string, args: JsonObject = {}, selected = session) => {
    phase = name
    const step = flow.steps.find(step => step.id === name), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) fail('INVALID_CONTRACT', '未声明公司生命周期步骤。', 6)
    if (name === 'changed') writeAttempted = true
    const response = await runOperation(ctx, op!, args, { ...selected, cookies: jar.serializeSync() }, { transport, approved: options.approved })
    if (name === 'changed') writeAcknowledged = true
    completed.push(name)
    return response
  }
  const snapshot = async (): Promise<Snapshot> => {
    const who = asObject(await call('identity')), company = asObject(who.team)
    const userId = id(who.id), teamId = id(company.id)
    if (userId !== session.identity.userId || teamId !== session.identity.teamId) fail('IDENTITY_CHANGED', '当前 profile 的用户或公司已变化；未发送公司写请求。', 3)
    if (input.teamId !== teamId) fail('ORGANIZATION_MISMATCH', '必须明确指定与当前 profile 一致的公司；不会隐式切换公司。', 4)
    if (typeof company.name !== 'string' || !company.name.trim()) fail('CONTEXT_MISSING', '公司未返回可确认的准确名称。')
    const companyName = company.name as string
    const creatorId = id(asObject(company.creator).id), creator = creatorId === userId && asObject(who.userRole).type === 'teamCreator'
    const state = asObject(await call('state')), organizations = directory(await call('before'))
    if (organizations.filter(row => row.userId === userId && row.teamId === teamId).length !== 1) fail('IDENTITY_CHANGED', '账号目录缺少当前准确的公司身份。', 3)
    const members = companyDirectoryUsers(await call('members')).map(member => id(member.id)).sort()
    if (!members.includes(userId)) fail('CONTEXT_MISSING', '当前通讯录缺少本人的公司身份。')
    const userFrom = asObject(who.oauth).userFrom
    // The current company UI only offers deletion in the native Rishiqing
    // application, and hides it for ISV identities even with the creator role.
    const native = session.method === 'password' && !['qywx', 'dingtalk', 'lark', 'wps', 'wps-isv'].includes(String(userFrom)) && state.mainApp === 'rsq'
    return { userId, teamId, name: companyName, creatorId, creator, native, state, members, organizations }
  }
  try {
    const before = await snapshot()
    resources.teamId = before.teamId; resources.userId = before.userId
    let restriction: JsonObject | null = null
    try { validateCompanyState(before.state) } catch (error) {
      if (!(error instanceof RsqError)) throw error
      restriction = { code: error.code, message: error.message }
    }
    if (action === 'lifecycle-context') return { command: flow.command, completedSteps: completed, resources, result: {
      company: { id: before.teamId, name: before.name, creatorId: before.creatorId }, currentUserId: before.userId,
      visibleMemberIds: before.members, orderUserCount: before.state.usersCount, visibleMembersAreCompleteCompanyRoster: false,
      canTransfer: before.creator && !restriction, canRemove: before.creator && before.native && !restriction,
      restriction, removalRequires: ['current-native-company-creator', 'exact-company-id-and-name', '--yes', 'server-membership-eligibility'],
      transferRequires: ['current-company-creator', 'another-visible-current-company-member', 'exact-company-id-and-name', '--yes'],
      removalSideEffects: '公司和全部成员归属被删除；个人资源按服务端退出规则处理；当前 profile 核对后改为原用户的个人身份。不会自动选择其他公司。',
      membershipNote: 'authAjax 的 teamLevel 在当前后端恒为 ultimate，不能据此推断真实套餐或可注销性；服务端仍可因有效会员拒绝注销。',
    } }
    validateCompanyState(before.state)
    if (!before.creator) fail('FORBIDDEN', '只有当前公司创建者可以转让或注销公司，管理员权限不能替代。', 4)
    if (typeof input.expectedName !== 'string' || input.expectedName !== before.name) fail('COMPANY_NAME_MISMATCH', '确认名称必须与当前公司的完整名称逐字一致；未发送公司写请求。', 4)
    if (action === 'remove' && !before.native) fail('FORBIDDEN', '当前平台身份或应用的 UI 不支持注销公司。', 4)
    if (action === 'transfer') {
      const target = id(input.userId)
      if (target === before.userId) fail('INVALID_INPUT', '请选择另一名当前公司成员接任创建者。', 2)
      if (!before.members.includes(target)) fail('FORBIDDEN', '接任成员不在当前公司实时可见通讯录中；不能猜测其他用户 ID。', 4)
      resources.targetUserId = target
    }
    // Re-read immediately before the irreversible request. This detects stale
    // context but is not a server-side compare-and-swap guarantee.
    const fresh = await snapshot()
    if (!isDeepStrictEqual(fresh, before)) fail('CONTEXT_CONFLICT', '公司名称、创建者、套餐、成员或账号目录在写前变化；请重新检查。', 4)
    await call('changed', action === 'transfer' ? { body: { teamName: before.name, userId: resources.targetUserId } } : { query: { teamName: before.name } })
    const verified = asObject(await call('verified')), next = sessionFromIdentityResponse(session.method, verified, jar)
    if (next.identity.userId !== before.userId || next.identity.username !== session.identity.username) fail('IDENTITY_CHANGED', '公司操作后的服务端用户发生意外变化；未覆盖本地 profile。', 3)
    const after = directory(await call('after', {}, next))
    if (action === 'transfer') {
      if (next.identity.teamId !== before.teamId || asObject(verified.team).name !== before.name || id(asObject(asObject(verified.team).creator).id) !== resources.targetUserId
        || asObject(verified.userRole).type === 'teamCreator' || !isDeepStrictEqual(after, before.organizations)) fail('VERIFICATION_FAILED', '转让后创建者、原创建者角色或账号目录读回不一致。')
    } else {
      const expected = before.organizations.map(row => row.userId === before.userId ? { ...row, teamId: null } : row)
      if (next.identity.teamId !== undefined || verified.team !== null || after.some(row => row.teamId === before.teamId) || !isDeepStrictEqual(after, expected)) fail('VERIFICATION_FAILED', '注销后个人身份或其他公司归属不符合预期；不会切换其他公司掩盖结果。')
    }
    // Independently verify the newly returned token before saving it. Old
    // browser Cookies never determine the profile selected by this command.
    const confirmed = sessionFromIdentityResponse(session.method, await call('verified', {}, next), jar)
    if (!isDeepStrictEqual(confirmed.identity, next.identity)) fail('IDENTITY_CHANGED', '操作后的新 token 独立核对失败；未覆盖本地 profile。', 3)
    phase = 'saveSession'
    try { await (options.storeSession ?? saveSession)(ctx, confirmed) } catch { fail('SESSION_STORE_FAILED', '公司操作已读回，但本地会话保存失败；请重新登录恢复，不能重复转让或注销。', 3) }
    localSessionUpdated = true; completed.push(phase)
    return { command: flow.command, completedSteps: completed, resources, result: { action, verified: true, localSessionUpdated,
      identity: confirmed.identity, companyRemoved: action === 'remove', otherAccountMembershipsPreserved: true,
      ...(action === 'transfer' ? { creatorId: resources.targetUserId, formerCreatorDemoted: true } : { recoveredAs: 'same-user-personal-identity', accountDefaultExplicitlySwitched: false }) } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('ORGANIZATION_FAILED', '公司生命周期操作未完成。', 5)
    const unknown = writeAttempted && !writeAcknowledged && (!writeResponseReceived || ['UNEXPECTED_RESPONSE', 'RESPONSE_SCHEMA_MISMATCH', 'HTTP_ERROR'].includes(failure.code))
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: phase, completedSteps: completed, resources,
      localSessionUpdated, writeAttempted, writeAcknowledged, writeOutcome: unknown ? 'unknown' : writeAcknowledged ? 'check-completed-steps' : writeAttempted ? 'rejected' : 'not-started',
      automaticRetry: false, automaticRollback: false, retry: 'manual-after-identity-and-directory-readback', ...(failure.details && { cause: failure.details }) })
  }
}
