import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { fingerprint } from './fingerprint.js'
import { privateOutput } from './private-output.js'
import type { Workflow } from './workflows.js'

export const aiConfigActions = ['context', 'account-list', 'account-inspect', 'account-create', 'account-edit', 'account-remove', 'account-default', 'account-validate', 'key-permissions', 'key-list', 'key-create', 'key-revoke'] as const
export type AiConfigAction = typeof aiConfigActions[number]
type Route = [string, string, string]
const root = '/task/agent/v1', accountRoot = root + '/accounts', keyRoot = root + '/api-keys'
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? value : fail('AI 资源 ID 不是实际目录中的 MongoDB ID。')
const numericId = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : fail('AI 上下文缺少精确组织或用户 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('AI 配置目录未返回数组。')
function data(value: unknown): unknown { const envelope = asObject(value); if (envelope.code !== 200) fail('AI 配置未返回成功业务回执。', 'BUSINESS_ERROR'); return envelope.data }
const pick = (value: JsonObject, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const publicAccount = (value: JsonObject): JsonObject => ({ ...pick(value, ['_id', 'platformType', 'accountName', 'userId', 'isDefault', 'isActive', 'shareScope', 'allowedUserIds', 'createdAt', 'updatedAt']), credentialsConfigured: Object.fromEntries(['accessToken', 'apiKey', 'baseURL'].map(key => [key, Boolean(asObject(value.credentials)[key])])), metadata: pick(asObject(value.metadata), ['description', 'createdBy', 'platformVersion', 'lastValidated']) })
const publicKey = (value: JsonObject) => pick(value, ['_id', 'name', 'userId', 'permissions', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'lastUsedAt'])
const keyView = (value: JsonObject) => ({ ...publicKey(value), contextVersion: fingerprint(publicKey(value)) })
export function aiConfigSteps(action: AiConfigAction): Route[] {
  const identity: Route = ['identity', 'GET', '/task/login/authAjax'], accounts: Route = ['accounts', 'GET', accountRoot], keys: Route = ['keys', 'GET', keyRoot], permissions: Route = ['permissions', 'GET', keyRoot + '/permissions'], account: Route = ['account', 'GET', accountRoot + '/{accountId}']
  if (action === 'context') return [identity, permissions, accounts, keys]
  if (action === 'account-list') return [identity, accounts]
  if (action === 'key-permissions') return [identity, permissions]
  if (action === 'key-list') return [identity, keys]
  if (action === 'key-create') return [identity, permissions, keys, ['changed', 'POST', keyRoot], ['verified', 'GET', keyRoot]]
  if (action === 'key-revoke') return [identity, keys, ['changed', 'DELETE', keyRoot + '/{id}'], ['verified', 'GET', keyRoot]]
  const members: Route = ['members', 'GET', '/task/v1/department/list']
  if (action === 'account-create') return [identity, accounts, members, ['changed', 'POST', accountRoot], ['verified', 'GET', accountRoot + '/{accountId}'], ['verifiedAccounts', 'GET', accountRoot]]
  if (action === 'account-inspect') return [identity, accounts, account]
  if (action === 'account-validate') return [identity, accounts, account, ['changed', 'POST', accountRoot + '/{accountId}/validate'], ['verified', 'GET', accountRoot + '/{accountId}']]
  return [identity, accounts, account, ...(action === 'account-edit' ? [members] : []), ['preflight', 'GET', accountRoot + '/{accountId}'], ['changed', action === 'account-remove' ? 'DELETE' : action === 'account-default' ? 'POST' : 'PUT', accountRoot + '/{accountId}' + (action === 'account-default' ? '/set-default' : '')], ...(action === 'account-remove' ? [] : [['verified', 'GET', accountRoot + '/{accountId}'] as Route]), ['verifiedAccounts', 'GET', accountRoot]]
}
export function validateAiConfigWorkflow(flow: Workflow) {
  if (!aiConfigActions.includes(flow.aiConfigAction!)) fail('未知 AI 配置操作。', 'INVALID_CONTRACT')
  const expected = aiConfigSteps(flow.aiConfigAction!)
  if (flow.executor !== 'ai-config' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(row => row.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.resources || step.transfer || step.authentication || step.forEach || step.collectPages || step.readback || step.expectAbsent || step.waitBeforeMs
  })) fail('AI 配置业务步骤与已核对协议不符。', 'INVALID_CONTRACT')
}
export async function runAiConfig(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateAiConfigWorkflow(flow)
  const session = requireSession(supplied), action = flow.aiConfigAction!, completed: string[] = [], resources: JsonObject = {}
  let phase = 'output-preflight', writeAttempted = false, responseReceived = false, output: Awaited<ReturnType<typeof privateOutput>> | undefined, stored: JsonObject | undefined, secretFingerprint: string | undefined, outputFailure: unknown
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId); if (!op) fail('未声明 AI 配置步骤。', 'INVALID_CONTRACT')
    phase = name
    const transport: Transport = async (url, init) => {
      if (name === 'changed') { writeAttempted = true; responseReceived = false }
      const response = await (options.transport ?? request)(url, init)
      if (name === 'changed') {
        responseReceived = true
        if (response.ok) {
          // Capture a one-time key before generic response validation/readback.
          // Only its private file and fingerprint survive in public diagnostics.
          let receipt: JsonObject = {}
          try { receipt = asObject(data(parseJson(await response.clone().text()))) } catch { /* report schema failure below without repeating the write */ }
          const rawId = action === 'key-create' ? asObject(receipt.apiKey)._id : receipt._id
          if (typeof rawId === 'string' && /^[a-f0-9]{24}$/.test(rawId)) resources[action === 'key-create' ? 'keyId' : 'accountId'] = rawId
          if (action === 'key-create' && typeof receipt.secretKey === 'string' && /^sk_live_[a-f0-9]{48}$/.test(receipt.secretKey)) {
            // A local publication failure is not a network error. Retain it
            // across the generic transport wrapper together with recovery info.
            try { stored = await output!.commit(receipt.secretKey); secretFingerprint = createHash('sha256').update(receipt.secretKey).digest('hex') } catch (error) { outputFailure = error }
          }
        }
      }
      return response
    }
    const result = await runOperation(ctx, op, args, session, { ...options, transport }); if (outputFailure) { phase = 'secret-output'; throw outputFailure }; completed.push(name); return result
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources, result: { companyId: session.identity.teamId, ...result } })
  const checkAccount = (value: unknown) => { const row = asObject(value); id(row._id); if (numericId(row.enterpriseId) !== session.identity.teamId || !['coze', 'n8n', 'dify', 'builtin'].includes(String(row.platformType)) || !['enterprise', 'user'].includes(String(row.shareScope)) || typeof row.isDefault !== 'boolean' || typeof row.isActive !== 'boolean') fail('平台账号与当前企业或实际类型不符。'); if (row.shareScope === 'user' && numericId(row.userId) !== session.identity.userId && !(row.allowedUserIds as unknown[] | undefined)?.some(value => numericId(value) === session.identity.userId)) fail('平台账号不在当前账号可见范围。', 'FORBIDDEN'); return row }
  const checkKeys = (value: unknown) => { const list = rows(value), seen = new Set<string>(); for (const row of list) { const keyId = id(row._id); if (seen.has(keyId) || numericId(row.enterpriseId) !== session.identity.teamId || !['active', 'revoked'].includes(String(row.status)) || !Array.isArray(row.permissions)) fail('API Key 目录归属、状态或条目不一致。'); seen.add(keyId) }; return list }
  const page = (value: unknown, index: number, limit: number): JsonObject & { items: JsonObject[] } => { const p = asObject(data(value)), items = rows(p.items).map(checkAccount); if (!Number.isSafeInteger(p.total) || Number(p.total) < 0 || p.page !== index || p.limit !== limit || p.totalPages !== Math.ceil(Number(p.total) / limit) || items.length !== Math.min(limit, Math.max(0, Number(p.total) - (index - 1) * limit))) fail('平台账号分页与总数不一致。'); return { ...p, items } }
  const allAccounts = async (name: string) => { const list: JsonObject[] = [], seen = new Set<string>(); let total: unknown; for (let index = 1; index <= 100; index++) { const p = page(await call(name, { query: { page: index, limit: 100 } }), index, 100); if (total !== undefined && p.total !== total) fail('平台账号目录在分页期间变化。', 'CONTEXT_CONFLICT'); total = p.total; for (const row of p.items) { const key = id(row._id); if (seen.has(key)) fail('平台账号跨页重复。', 'CONTEXT_CONFLICT'); seen.add(key); list.push(row) }; if (list.length === total) return list }; return fail('平台账号目录超过安全分页边界，未开始写入。') }
  const accountVersion = (row: JsonObject) => fingerprint(row), own = (row: JsonObject) => { if (numericId(row.userId) !== session.identity.userId) fail('仅平台账号创建者可以维护或删除该账号。', 'FORBIDDEN') }
  const verifyFields = (row: JsonObject, expected: JsonObject) => { for (const [key, value] of Object.entries(expected)) if (!['credentials', 'metadata'].includes(key) && !isDeepStrictEqual(row[key], value)) fail('平台账号独立读回与提交字段不符。', 'VERIFICATION_FAILED'); for (const [key, value] of Object.entries(asObject(expected.metadata))) if (!isDeepStrictEqual(asObject(row.metadata)[key], value)) fail('平台账号元信息未独立读回。', 'VERIFICATION_FAILED') }
  try {
    if (action === 'key-create') output = await privateOutput(String(input.secretOutput))
    const who = asObject(await call('identity')); if (numericId(who.id) !== session.identity.userId || numericId(asObject(who.team).id) !== session.identity.teamId) fail('AI 配置用户或公司与当前 profile 不一致。', 'IDENTITY_CHANGED')
    if (['context', 'key-permissions', 'key-create'].includes(action)) {
      const permissions = rows(data(await call('permissions'))), codes = permissions.map(row => row.code)
      if (codes.some(code => typeof code !== 'string') || new Set(codes).size !== codes.length) fail('AI 权限目录缺少唯一业务代码。')
      if (action === 'key-permissions') return done({ permissions })
      if (action === 'context') { const accounts = await allAccounts('accounts'), keys = checkKeys(data(await call('keys'))); return done({ accounts: accounts.map(publicAccount), keys: keys.map(keyView), permissions, complete: true, accountMutationsRequireCreator: true, credentialEditsSupported: false, defaultScope: 'all-enterprise-accounts-of-the-same-platform-including-invisible-accounts', apiKeyScope: 'enterprise', relatedCommands: ['ai account inspect', 'ai account create', 'ai api-key create'] }) }
      const requested = input.permissions as string[]
      if (!requested.every(code => codes.includes(code))) fail('创建权限必须来自当前实际权限目录，不能猜测后端隐藏代码。', 'INVALID_INPUT')
    }
    if (action.startsWith('key-')) {
      const before = checkKeys(data(await call('keys')))
      if (action === 'key-list') return done({ items: before.map(keyView), complete: true })
      if (action === 'key-revoke') { const target = before.find(row => row._id === input.keyId); if (!target) fail('API Key 不在当前企业实际目录。', 'FORBIDDEN'); if (target.status !== 'active') fail('API Key 已撤销，未重复提交。', 'INVALID_INPUT'); if (input.contextVersion && input.contextVersion !== fingerprint(publicKey(target))) fail('API Key 状态已变化。', 'CONTEXT_CONFLICT'); resources.keyId = input.keyId }
      const body = action === 'key-create' ? { name: input.name, permissions: input.permissions, ...(input.expiresIn ? { expiresIn: input.expiresIn } : {}) } : undefined
      const receipt = data(await call('changed', body ? { body } : { path: { id: input.keyId } }))
      if (action === 'key-create' && (!stored || !secretFingerprint || id(asObject(asObject(receipt).apiKey)._id) !== resources.keyId)) fail('API Key 回执不完整；先核对已有私有文件和企业目录，不能重复创建。', 'VERIFICATION_FAILED')
      const after = checkKeys(data(await call('verified'))), target = after.find(row => row._id === resources.keyId)
      if (!target || target.status !== (action === 'key-create' ? 'active' : 'revoked')) fail('API Key 创建或撤销状态未独立读回。', 'VERIFICATION_FAILED')
      if (action === 'key-create' && (target.name !== input.name || !isDeepStrictEqual(target.permissions, input.permissions) || numericId(target.userId) !== session.identity.userId || Boolean(target.expiresAt) !== Boolean(input.expiresIn))) fail('API Key 独立读回与创建上下文不符。', 'VERIFICATION_FAILED')
      if (action === 'key-create') {
        if (target.keyHash !== secretFingerprint) fail('独立目录中的密钥哈希与已保存一次性密钥不符。', 'VERIFICATION_FAILED')
        if (input.expiresIn) { const createdAt = Date.parse(String(target.createdAt)), expiresAt = Date.parse(String(target.expiresAt)); if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || Math.abs(expiresAt - createdAt - Number(input.expiresIn) * 86400000) > 1000) fail('API Key 独立读回的有效期与所选天数不符。', 'VERIFICATION_FAILED') }
      }
      for (const row of before) if (row._id !== resources.keyId && !isDeepStrictEqual(publicKey(row), publicKey(after.find(value => value._id === row._id) ?? {}))) fail('无关 API Key 在操作期间变化。', 'CONTEXT_CONFLICT')
      return done({ key: publicKey(target), contextVersion: fingerprint(publicKey(target)), verified: true, secretExposed: false, ...(stored && { output: stored, fingerprint: secretFingerprint }) })
    }
    if (action === 'account-list') { const index = Number(input.page ?? 1), limit = Number(input.limit ?? 20), result = page(await call('accounts', { query: { page: index, limit, ...(input.platformType ? { platformType: input.platformType } : {}), ...(input.activeOnly !== undefined && { activeOnly: String(input.activeOnly) }) } }), index, limit); return done({ ...result, items: result.items.map(publicAccount), complete: index === 1 && result.total === result.items.length }) }
    const before = await allAccounts('accounts')
    let target: JsonObject | undefined
    if (action !== 'account-create') {
      target = before.find(row => row._id === input.accountId); if (!target) fail('平台账号不在当前可见目录，未按任意 ID 请求详情。', 'FORBIDDEN')
      const detail = checkAccount(data(await call('account', { path: { accountId: input.accountId } })))
      if (detail._id !== input.accountId || accountVersion(detail) !== accountVersion(target)) fail('平台账号详情与实际目录不一致。', 'CONTEXT_CONFLICT')
      target = detail; resources.accountId = input.accountId
      if (input.contextVersion && input.contextVersion !== accountVersion(target)) fail('平台账号上下文已变化。', 'CONTEXT_CONFLICT')
      if (action === 'account-inspect') return done({ account: publicAccount(target), contextVersion: accountVersion(target) })
      if (action !== 'account-validate') own(target)
    }
    let expected: JsonObject = {}
    if (action === 'account-create' || action === 'account-edit') {
      const members = new Set<string>(); let count = 0
      const walk = (tree: JsonObject[], depth = 0) => { if (depth > 100) fail('通讯录树深度异常。'); for (const row of tree) { if (++count > 100000) fail('通讯录超过上下文边界。'); for (const member of rows(row.userList ?? [])) members.add(numericId(member.id)); walk(rows(row.childList ?? []), depth + 1) } }; walk(rows(await call('members', { query: { cliContext: 'fresh' } })))
      expected = structuredClone(asObject(input.account))
      if (Array.isArray(expected.allowedUserIds) && !expected.allowedUserIds.every(value => members.has(numericId(value)))) fail('指定成员必须来自当前实际通讯录。', 'INVALID_INPUT')
      if (action === 'account-create') { expected = { isDefault: false, isActive: true, shareScope: 'enterprise', ...expected }; if (before.some(row => row.platformType === expected.platformType && row.accountName === expected.accountName)) fail('当前平台已有同名账号，未重复创建。', 'INVALID_INPUT') }
    }
    if (action === 'account-default') { if (target!.isDefault) fail('该账号已经是默认账号，未重复提交。', 'INVALID_INPUT'); expected = { isDefault: true } }
    if (target && action !== 'account-validate') { const latest = checkAccount(data(await call('preflight', { path: { accountId: input.accountId } }))); if (accountVersion(latest) !== accountVersion(target)) fail('平台账号在提交前变化。', 'CONTEXT_CONFLICT') }
    const args = action === 'account-create' ? { body: expected } : { path: { accountId: input.accountId }, ...(action === 'account-edit' && { body: expected }) }
    const receipt = data(await call('changed', args))
    if (action === 'account-create') { const created = checkAccount(receipt); resources.accountId = id(created._id); own(created); verifyFields(created, expected) }
    if (action === 'account-validate') {
      const validation = asObject(receipt); if (typeof validation.valid !== 'boolean') fail('凭证验证没有返回明确结果。', 'VERIFICATION_FAILED')
      const after = checkAccount(data(await call('verified', { path: { accountId: input.accountId } }))); if (after._id !== input.accountId) fail('凭证验证读回了其他账号。', 'VERIFICATION_FAILED')
      if (!validation.valid) fail('平台服务未接受该账号凭证；未重试，凭证原文不输出。', 'CREDENTIALS_INVALID')
      if (!asObject(after.metadata).lastValidated || asObject(after.metadata).lastValidated === asObject(target!.metadata).lastValidated) fail('凭证验证成功未独立读回新的验证记录。', 'VERIFICATION_FAILED')
      return done({ valid: true, account: publicAccount(after), verified: true })
    }
    let verified: JsonObject | undefined
    if (action !== 'account-remove') { verified = checkAccount(data(await call('verified', { path: { accountId: resources.accountId } }))); if (verified._id !== resources.accountId) fail('平台账号独立读回目标不符。', 'VERIFICATION_FAILED'); verifyFields(verified, expected); if (target) { const previous = publicAccount(target), actual = publicAccount(verified), projected: JsonObject = { ...previous, ...expected, metadata: { ...asObject(previous.metadata), ...asObject(expected.metadata) } }; delete projected.updatedAt; delete actual.updatedAt; if (!isDeepStrictEqual(projected, actual)) fail('账号维护意外改变了未指定字段或凭证状态。', 'VERIFICATION_FAILED') } }
    const after = await allAccounts('verifiedAccounts')
    if (action === 'account-remove' ? after.some(row => row._id === resources.accountId) : !after.some(row => row._id === resources.accountId && accountVersion(row) === accountVersion(verified!))) fail('平台账号目录没有反映独立维护结果。', 'VERIFICATION_FAILED')
    const defaultChanged = expected.isDefault === true, platform = verified?.platformType ?? target?.platformType
    for (const row of before) if (row._id !== resources.accountId) { const current = after.find(value => value._id === row._id); if (!current) fail('无关平台账号缺失。', 'CONTEXT_CONFLICT'); const prior = publicAccount(row), fresh = publicAccount(current); delete prior.updatedAt; delete fresh.updatedAt; if (defaultChanged && row.platformType === platform) { prior.isDefault = false; if (current.isDefault !== false) fail('同平台默认账号未取消。', 'VERIFICATION_FAILED') }; if (!isDeepStrictEqual(prior, fresh)) fail('无关平台账号发生非预期变化。', 'CONTEXT_CONFLICT') }
    return done({ ...(verified ? { account: publicAccount(verified), contextVersion: accountVersion(verified) } : { removed: true }), verified: true, visibleDirectoryComplete: true, defaultMayAffectInvisibleAccounts: defaultChanged })
  } catch (error) {
    const failure = outputFailure ?? error, original = failure instanceof RsqError ? failure : new RsqError('WORKFLOW_FAILED', 'AI 配置未完成。', 5)
    throw new RsqError(original.code, original.message, original.exit, { command: flow.command, failedStep: phase, completedSteps: completed, resources, writeAttempted, resultMayBeUnknown: writeAttempted && !responseReceived, ...(stored && { secretOutput: stored.path, secretSaved: true }), automaticRetry: false, automaticRollback: false, ...(original.details && { cause: original.details }) })
  } finally { await output?.close() }
}
