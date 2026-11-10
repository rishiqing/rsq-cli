import { CookieJar } from 'tough-cookie'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { sessionFromIdentityResponse } from './auth.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, saveSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'
import { organizationLifecycleActions, runOrganizationLifecycle, validateOrganizationLifecycleWorkflow, type OrganizationLifecycleAction } from './organization-lifecycle.js'

export type OrganizationAction = 'list' | 'context' | 'create' | 'switch' | 'update' | OrganizationLifecycleAction
export type OrganizationStore = (ctx: Context, session: Session) => Promise<void>
const authentication = '/task/login/authAjax', siblings = '/task/v1/team/fetchUserSiblings', company = '/task/v1/team'
const validId = (value: unknown): string | undefined => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
const sameIdentity = (a: Session, b: Session) => a.identity.userId === b.identity.userId && a.identity.teamId === b.identity.teamId
function rows(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.some(item => !validId(asObject(item).id) || asObject(item).team !== null && !validId(asObject(asObject(item).team).id))) {
    throw new RsqError('CONTEXT_MISSING', '组织目录缺少用户或公司标识。', 5)
  }
  const result = value as JsonObject[]
  if (new Set(result.map(item => validId(item.id))).size !== result.length) throw new RsqError('AMBIGUOUS_ORGANIZATION', '组织目录包含重复身份，请重新核对。', 5)
  return result
}
function organization(payload: unknown) {
  const data = asObject(asObject(payload).team)
  if (!validId(data.id)) return null
  const keys = ['id', 'name', 'introduction', 'region', 'industry', 'size', 'logo', 'dateCreated', 'status', 'freeze']
  const creator = asObject(data.creator)
  return { ...Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])),
    ...(validId(creator.id) && { creator: { id: creator.id, ...(typeof creator.name === 'string' && { name: creator.name }) } }) }
}
const expectedSteps = (action: OrganizationAction): [string, string, string, 'cookie'?][] => {
  const identity: [string, string, string] = ['identity', 'GET', authentication]
  if (action === 'context') return [identity]
  if (action === 'list') return [identity, ['before', 'GET', siblings]]
  if (action === 'update') return [identity, ['permissions', 'GET', '/task/authority/v3/authorities/company/current'], ['changed', 'PUT', company], ['verified', 'GET', authentication]]
  return [identity, ['before', 'GET', siblings], ['changed', action === 'create' ? 'POST' : 'PUT', action === 'create' ? company : company + '/switchUser'],
    ['exchanged', 'GET', authentication, 'cookie'], ['after', 'GET', siblings], ['verified', 'GET', authentication]]
}
export function validateOrganizationWorkflow(flow: Workflow) {
  if (organizationLifecycleActions.includes(flow.organizationAction as OrganizationLifecycleAction)) return validateOrganizationLifecycleWorkflow(flow)
  if (flow.executor !== 'organization' || !['list', 'context', 'create', 'switch', 'update'].includes(flow.organizationAction ?? '')) throw new RsqError('INVALID_CONTRACT', '组织业务执行器无效。')
  const action = flow.organizationAction!, expected = expectedSteps(action)
  if (flow.steps.length !== expected.length || expected.some(([id, method, route, auth], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== id || op?.method !== method || op.route !== route || step.authentication !== auth || step.prepare || step.forEach || step.transfer
  })) throw new RsqError('INVALID_CONTRACT', '组织会话步骤与已核对的登录协议不一致。')
}

/** Keep token/cookie exchange private; only a fully verified session is saved. */
export async function runOrganization(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null,
  options: { approved?: boolean; transport?: Transport; storeSession?: OrganizationStore } = {}) {
  if (organizationLifecycleActions.includes(flow.organizationAction as OrganizationLifecycleAction)) return runOrganizationLifecycle(ctx, flow, input, supplied, options)
  validateOrganizationWorkflow(flow)
  const original = requireSession(supplied), action = flow.organizationAction!, jar = new CookieJar()
  const completed: string[] = [], resources: Record<string, string> = {}
  let phase = 'identity', responseReceived = false, writeStarted = false, saved = false, current = original
  const transport: Transport = async (url, init) => {
    const response = await (options.transport ?? request)(url, init)
    // runOperation already restricts every URL to the current identity's origin.
    for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href, { ignoreError: true })
    if (action === 'create' && phase === 'changed' && response.ok) {
      // Retain an assigned ID even if the normal response validation fails.
      try {
        const value = asObject(parseJson(await response.clone().text()))
        if (value.name === input.name && validId(value.id)) resources.teamId = validId(value.id)!
      } catch { /* Never replay a possibly successful creation. */ }
    }
    return response
  }
  const execute = async (id: string, args: JsonObject, source = current) => {
    phase = id; responseReceived = false
    const step = flow.steps.find(step => step.id === id)!, op = catalog.operations.find(op => op.id === step.operationId)!
    if (op.effect !== 'read' && ['changed'].includes(id)) writeStarted = true
    const value = await runOperation(ctx, step.authentication === 'cookie' ? { ...op, auth: 'cookie' } : op, args,
      { ...source, cookies: jar.serializeSync() }, { transport, approved: options.approved })
    responseReceived = true; completed.push(id)
    return value
  }
  try {
    const identity = await execute('identity', {})
    current = sessionFromIdentityResponse(original.method, identity, jar)
    if (!sameIdentity(current, original)) throw new RsqError('IDENTITY_CHANGED', '服务端身份与当前 profile 不一致，请重新登录。', 3)
    const requestedSource = input.fromTeamId ?? (action === 'update' ? input.teamId : undefined)
    if (requestedSource !== undefined && requestedSource !== current.identity.teamId) throw new RsqError('ORGANIZATION_MISMATCH', '指定公司与当前 profile 的服务端身份不一致；未发送公司写入请求。', 4)
    if (action === 'context') return { command: flow.command, completedSteps: completed, resources,
      result: { identity: current.identity, organization: organization(identity) } }
    if (action === 'update') {
      const permissions = asObject(await execute('permissions', {}))
      if (permissions.editTeamInfo !== true) throw new RsqError('FORBIDDEN', '当前用户没有修改公司资料的权限。', 4)
      const patch = asObject(input.patch), before = asObject(asObject(identity).team)
      if (!Object.keys(patch).every(key => ['name', 'introduction', 'region', 'industry', 'size'].includes(key))) throw new RsqError('INVALID_INPUT', '公司资料补丁包含不支持的属性。', 2)
      resources.teamId = current.identity.teamId!
      await execute('changed', { body: patch })
      const verified = await execute('verified', {}), next = sessionFromIdentityResponse(original.method, verified, jar)
      if (!sameIdentity(next, current)) throw new RsqError('IDENTITY_CHANGED', '修改后的身份或组织发生变化。', 3)
      const after = asObject(asObject(verified).team)
      for (const key of ['name', 'introduction', 'region', 'industry', 'size', 'logo']) {
        const expected = Object.hasOwn(patch, key) ? patch[key] : before[key]
        if (!isDeepStrictEqual(after[key], expected)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '公司资料读回与补丁或应保留的字段不一致。', 5, { field: key })
      }
      return { command: flow.command, completedSteps: completed, resources, result: { identity: next.identity, organization: organization(verified) } }
    }
    const before = rows(await execute('before', {}))
    if (!before.some(item => validId(item.id) === current.identity.userId && validId(asObject(item.team).id) === current.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '组织目录缺少当前 profile 的准确身份。', 3)
    if (action === 'list') return { command: flow.command, completedSteps: completed, resources,
      result: before.map(item => ({ userId: validId(item.id)!, name: item.name,
        organization: item.team === null ? null : { id: validId(asObject(item.team).id), name: asObject(item.team).name }, current: validId(item.id) === current.identity.userId })) }
    let targetUser: string | undefined, targetTeam: string
    if (action === 'switch') {
      targetTeam = String(input.teamId)
      const candidates = before.filter(item => validId(asObject(item.team).id) === targetTeam)
      if (candidates.length !== 1) throw new RsqError(candidates.length ? 'AMBIGUOUS_ORGANIZATION' : 'ORGANIZATION_NOT_FOUND', '目标公司必须唯一存在于当前账号的组织目录中。', 4)
      targetUser = validId(candidates[0].id)!
      resources.teamId = targetTeam; resources.userId = targetUser
      // Explicit switching also restores the account default when a different
      // profile changed it; do not infer this shared server state from a token.
      await execute('changed', { body: { userId: targetUser } })
    } else {
      const created = asObject(await execute('changed', { body: { name: input.name, canTel: input.canTel ?? false,
        ...(input.phoneNumber !== undefined && { phoneNumber: input.phoneNumber }), ...(input.verificationCode !== undefined && { verificationCode: input.verificationCode }) } }))
      targetTeam = validId(created.id)!
      if (!targetTeam || created.name !== input.name || before.some(item => validId(asObject(item.team).id) === targetTeam)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '创建结果不是本次新建的公司；请核对目录后恢复。', 5)
      resources.teamId = targetTeam
    }
    const exchanged = await execute('exchanged', {})
    const next = sessionFromIdentityResponse(original.method, exchanged, jar)
    if (next.identity.teamId !== targetTeam || targetUser && next.identity.userId !== targetUser) throw new RsqError('IDENTITY_CHANGED', '新 Cookie 兑换出的用户或公司不匹配，未覆盖本地 profile。', 3)
    if (action === 'create' && original.identity.teamId && before.some(item => validId(item.id) === next.identity.userId)) throw new RsqError('IDENTITY_CHANGED', '新公司复用了已有组织用户，需先人工核对结果。', 3)
    resources.userId = next.identity.userId
    // Read with the original token, proving the new identity belongs to the
    // same account rather than trusting a label returned by the new session.
    const after = rows(await execute('after', {}, original))
    if (!after.some(item => validId(item.id) === next.identity.userId && validId(asObject(item.team).id) === targetTeam)
      || before.some(item => !(action === 'create' && !original.identity.teamId && validId(item.id) === original.identity.userId)
        && !after.some(candidate => validId(candidate.id) === validId(item.id) && validId(asObject(candidate.team).id) === validId(asObject(item.team).id)))) {
      throw new RsqError('BUSINESS_ASSERTION_FAILED', '切换后账号目录与原有组织归属不一致，未覆盖本地会话。', 5)
    }
    current = next
    const verified = await execute('verified', {}), confirmed = sessionFromIdentityResponse(original.method, verified, jar)
    if (!sameIdentity(confirmed, next)) throw new RsqError('IDENTITY_CHANGED', '新 token 独立核对失败，未覆盖本地会话。', 3)
    phase = 'saveSession'
    try { await (options.storeSession ?? saveSession)(ctx, confirmed) } catch { throw new RsqError('SESSION_STORE_FAILED', '新会话已核对，但本地保存失败；请核对目录后重新切换，不要重复创建公司。', 3) }
    saved = true; completed.push(phase)
    return { command: flow.command, completedSteps: completed, resources, result: { profile: ctx.profile, identity: confirmed.identity,
      organization: organization(verified), localSessionUpdated: true, accountDefaultChanged: true } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('ORGANIZATION_FAILED', '组织操作未能完成。', 5)
    const uncertain = writeStarted && !responseReceived && ['NETWORK_ERROR', 'TIMEOUT', 'UNEXPECTED_RESPONSE', 'RESPONSE_SCHEMA_MISMATCH', 'HTTP_ERROR', 'BUSINESS_ERROR'].includes(failure.code)
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: phase, completedSteps: completed, resources,
      localSessionUpdated: saved, serverAccountDefaultMayHaveChanged: writeStarted && action !== 'update', writeOutcome: uncertain ? 'unknown' : writeStarted ? 'check-completed-steps' : 'not-started',
      retry: 'manual-after-readback', automaticRollback: false, ...(failure.details && { cause: failure.details }) })
  }
}
