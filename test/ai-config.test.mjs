import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context } from '../dist/core.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { validateAiConfigWorkflow } from '../dist/ai-config.js'
const ctx = context('production', 'fixture'), jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const base = '/task/agent/v1', accountId = 'a'.repeat(24), otherId = 'b'.repeat(24), newId = 'c'.repeat(24), keyId = 'd'.repeat(24), newKeyId = 'e'.repeat(24), secret = 'sk_live_' + 'a'.repeat(48)
const object = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }), response = data => object({ code: 200, msg: 'success', data })
const flow = command => { const f = workflows.workflows.find(f => f.command === command); assert.ok(f, command); return f }
const run = (command, input, f, options = {}) => executeWorkflow(ctx, flow(command), input, session, { transport: f.transport, ...options })
const clone = value => structuredClone(value)
function fixture(options = {}) {
  const calls = [], accounts = [{ _id: accountId, enterpriseId: 7, userId: 81, accountName: '本人账号', platformType: 'coze', credentials: { accessToken: 'backend-mask-or-ciphertext', baseURL: 'https://platform.example/private-credential' }, isActive: true, isDefault: false, shareScope: 'user', metadata: { description: '保留说明', lastValidated: '2020-01-01T00:00:00Z' } }, { _id: otherId, enterpriseId: 7, userId: 82, accountName: '共享账号', platformType: 'coze', credentials: { accessToken: 'other-ciphertext' }, isActive: true, isDefault: true, shareScope: 'enterprise', metadata: {} }], keys = [{ _id: keyId, enterpriseId: 7, userId: 82, name: '既有密钥', permissions: ['base:read'], status: 'active', keyHash: 'do-not-disclose-database-hash', prefix: 'secret-prefix', expiresAt: null }]
  let detailReads = 0, keyReads = 0
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query, body }); assert.ok(url.origin === 'https://www.rishiqing.com')
    if (path.endsWith('/authAjax')) return object({ id: 81, username: 'fixture', token: 'fixture', success: true, team: { id: options.identityChanged ? 8 : 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return object({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return object([{ funcName: 'AI_EMPLOYEE', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return object({})
    if (path.endsWith('/department/list')) { assert.equal(query.cliContext, 'fresh'); return object([{ id: 7, name: '公司', type: 'top', parentId: null, displayOrder: 0, childList: [], userList: [{ id: 81 }, { id: 82 }] }]) }
    assert.equal(new Headers(init.headers).get('token'), 'fixture')
    if (path === base + '/api-keys/permissions') return response([{ code: 'base:read', name: '基础读取', group: 'base', description: '基础' }, { code: '*', name: '全部', group: 'all', description: '全部' }])
    if (path === base + '/api-keys' && method === 'GET') { keyReads++; if (options.failedKeyReadback && keyReads > 1) throw Error('fixture timeout'); if (options.keysDrift && keyReads > 1) keys[0].status = 'revoked'; return response(keys) }
    if (path === base + '/api-keys' && method === 'POST') {
      if (options.unknownWrite) throw Error('fixture timeout')
      const row = { _id: newKeyId, enterpriseId: 7, userId: 81, name: body.name, permissions: body.permissions, status: 'active', expiresAt: body.expiresIn ? new Date(Date.now() + (options.wrongExpiry ? 90 : body.expiresIn) * 86400000).toISOString() : null, createdAt: new Date().toISOString(), keyHash: options.wrongKeyHash ? 'wrong-server-hash' : createHash('sha256').update(secret).digest('hex'), prefix: 'new-secret-prefix' }; keys.unshift(row)
      await options.afterKeyCreate?.()
      return response({ apiKey: options.badKeyReceipt ? { ...row, name: null } : row, secretKey: secret })
    }
    if (path === base + '/api-keys/' + keyId && method === 'DELETE') { if (!options.ignoreRevoke) keys.find(row => row._id === keyId).status = 'revoked'; return object({ code: 200, msg: 'success' }) }
    if (path === base + '/accounts' && method === 'GET') {
      const items = accounts.filter(row => (!query.platformType || row.platformType === query.platformType) && (query.activeOnly !== 'true' || row.isActive)), page = Number(query.page ?? 1), limit = Number(query.limit ?? 20)
      return response({ items: clone(items.slice((page - 1) * limit, page * limit)), total: options.badPagination ? items.length + 1 : items.length, page, limit, totalPages: Math.ceil(items.length / limit) })
    }
    if (path === base + '/accounts' && method === 'POST') { if (options.unknownWrite) throw Error('fixture timeout'); const row = { ...body, _id: newId, enterpriseId: 7, userId: 81, credentials: { accessToken: 'new-ciphertext' } }; if (row.isDefault) for (const account of accounts) if (account.platformType === row.platformType) account.isDefault = false; accounts.push(row); return response(row) }
    const match = path.match(/\/accounts\/([a-f0-9]{24})(?:\/(set-default|validate))?$/)
    if (match) {
      const row = accounts.find(row => row._id === match[1]); assert.ok(row)
      if (method === 'GET') { detailReads++; if (options.staleAccount && detailReads >= 2) row.accountName = '并发修改'; return response(row) }
      if (method === 'DELETE') { if (!options.ignoreDelete) accounts.splice(accounts.indexOf(row), 1); return response(null) }
      if (match[2] === 'validate') { if (options.invalidCredentials) return response({ valid: false, message: secret }); if (!options.ignoreValidation) row.metadata.lastValidated = new Date().toISOString(); return response({ valid: true }) }
      if (method === 'POST' && match[2] === 'set-default' || method === 'PUT' && body.isDefault) for (const current of accounts) if (current.platformType === row.platformType) current.isDefault = false
      if (method === 'PUT') { if (options.unknownWrite) throw Error('fixture timeout'); const { metadata, ...fields } = body; Object.assign(row, fields); if (metadata) row.metadata = { ...row.metadata, ...metadata }; if (options.wrongWrite) row.isActive = true; if (options.loseUnrelated) accounts.splice(accounts.findIndex(a => a._id === otherId), 1) }
      else row.isDefault = true
      return response(row)
    }
    throw Error('Unexpected AI config request ' + method + ' ' + path)
  }
  return { calls, accounts, keys, transport }
}
const temporary = async fn => { const dir = await mkdtemp(join(tmpdir(), 'rsq-ai-secret-')); try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) } }
test('AI configuration discovery masks credentials, hashes and prefixes and checks actual visible sources', async () => {
  for (const f of workflows.workflows.filter(f => f.executor === 'ai-config')) validateAiConfigWorkflow(f)
  const f = fixture(), result = await run('ai config context', {}, f), text = JSON.stringify(result)
  for (const excluded of ['backend-mask-or-ciphertext', 'other-ciphertext', 'do-not-disclose-database-hash', 'secret-prefix', '/private-credential']) assert.ok(!text.includes(excluded), excluded)
  assert.equal(result.result.keys[0].contextVersion.length, 64); assert.equal(result.result.credentialEditsSupported, false); assert.equal(result.result.accountMutationsRequireCreator, true)
  assert.ok(f.calls.every(c => c.method === 'GET'))
  const inspect = await run('ai account inspect', { accountId }, f); assert.equal(inspect.result.contextVersion.length, 64)
  const foreign = fixture(); await assert.rejects(run('ai account inspect', { accountId: newId }, foreign), { code: 'FORBIDDEN' }); assert.ok(!foreign.calls.some(c => c.path.endsWith('/' + newId)))
})
test('AI account create/edit/default/remove independently verify exact fields and preserve unrelated accounts', async () => {
  const f = fixture(), created = await run('ai account create', { account: { platformType: 'coze', accountName: '唯一自有账号', credentials: { accessToken: 'fixture-new-credential' }, shareScope: 'user', allowedUserIds: [82] } }, f, { approved: true })
  assert.equal(created.resources.accountId, newId); assert.equal(created.result.verified, true); assert.ok(!JSON.stringify(created).includes('fixture-new-credential'))
  const inspected = await run('ai account inspect', { accountId: newId }, f)
  const edited = await run('ai account edit', { accountId: newId, contextVersion: inspected.result.contextVersion, account: { accountName: '改名', isActive: false, metadata: { description: '' }, allowedUserIds: [] } }, f, { approved: true })
  assert.equal(edited.result.account.isActive, false); assert.equal(edited.result.account.metadata.description, ''); assert.deepEqual(edited.result.account.allowedUserIds, [])
  await run('ai account default set', { accountId: newId }, f, { approved: true }); assert.equal(f.accounts.find(row => row._id === otherId).isDefault, false)
  const removed = await run('ai account remove', { accountId: newId }, f, { approved: true }); assert.equal(removed.result.removed, true); assert.deepEqual(f.accounts.map(row => row._id), [accountId, otherId])
})
test('AI account contracts reject credential edits, hidden platform creation, unknown members and noncreator writes', async () => {
  const f = fixture()
  await assert.rejects(run('ai account edit', { accountId, account: { credentials: { accessToken: 'must-not-be-ignored' } } }, f, { approved: true }), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('ai account create', { account: { platformType: 'n8n', accountName: 'n8n', credentials: { accessToken: 'fixture' } } }, f, { approved: true }), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('ai account edit', { accountId, account: { allowedUserIds: [999] } }, f, { approved: true }), { code: 'INVALID_INPUT' }); assert.ok(!f.calls.some(c => c.method === 'PUT'))
  const other = fixture(); await assert.rejects(run('ai account remove', { accountId: otherId }, other, { approved: true }), { code: 'FORBIDDEN' }); assert.ok(other.calls.every(c => c.method === 'GET'))
})
test('AI account pagination and concurrent preflight/readback errors cannot become false success', async () => {
  const filtered = fixture(); const list = await run('ai account list', { page: 1, limit: 1, activeOnly: false, platformType: 'coze' }, filtered); assert.equal(list.result.complete, false); assert.equal(filtered.calls.find(c => c.path === base + '/accounts').query.activeOnly, 'false')
  await assert.rejects(run('ai account list', {}, fixture({ badPagination: true })), { code: 'CONTEXT_MISSING' })
  const stale = fixture({ staleAccount: true }); await assert.rejects(run('ai account edit', { accountId, account: { isActive: false } }, stale, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.ok(!stale.calls.some(c => c.method === 'PUT'))
  await assert.rejects(run('ai account edit', { accountId, account: { isActive: false } }, fixture({ wrongWrite: true }), { approved: true }), { code: 'VERIFICATION_FAILED' })
  await assert.rejects(run('ai account edit', { accountId, account: { isActive: false } }, fixture({ loseUnrelated: true }), { approved: true }), { code: 'CONTEXT_CONFLICT' })
  await assert.rejects(run('ai account remove', { accountId }, fixture({ ignoreDelete: true }), { approved: true }), { code: 'VERIFICATION_FAILED' })
})
test('AI credential validation distinguishes HTTP receipts from valid credentials and a new verification record', async () => {
  assert.equal((await run('ai account validate', { accountId }, fixture())).result.valid, true)
  await assert.rejects(run('ai account validate', { accountId }, fixture({ invalidCredentials: true })), error => { assert.equal(error.code, 'CREDENTIALS_INVALID'); assert.ok(!JSON.stringify(error).includes(secret)); return true })
  await assert.rejects(run('ai account validate', { accountId }, fixture({ ignoreValidation: true })), { code: 'VERIFICATION_FAILED' })
})
test('AI API Key creation privately saves its one-time secret and verifies permissions, expiry and revocation', async () => temporary(async dir => {
  const f = fixture(), path = join(dir, 'new-key'), created = await run('ai api-key create', { name: '自有密钥', permissions: ['base:read'], expiresIn: 30, secretOutput: path }, f, { approved: true })
  assert.equal(await readFile(path, 'utf8'), secret + '\n'); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(created.result.fingerprint, createHash('sha256').update(secret).digest('hex')); assert.equal(created.result.verified, true)
  for (const excluded of [secret, 'new-database-hash', 'new-secret-prefix']) assert.ok(!JSON.stringify(created).includes(excluded))
  const listed = await run('ai api-key list', {}, f), existing = listed.result.items.find(row => row._id === keyId)
  await run('ai api-key revoke', { keyId, contextVersion: existing.contextVersion }, f, { approved: true }); assert.equal(f.keys.find(row => row._id === keyId).status, 'revoked'); assert.equal(f.keys.find(row => row._id === newKeyId).status, 'active')
}))
test('AI key permission, expiry, output preflight and post-write failures preserve the issued file without replay', async () => temporary(async dir => {
  const input = { name: '自有密钥', permissions: ['base:read'], secretOutput: join(dir, 'saved') }, f = fixture()
  await assert.rejects(run('ai api-key create', { ...input, expiresIn: -1 }, f, { approved: true }), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  const unknown = fixture(); await assert.rejects(run('ai api-key create', { ...input, permissions: ['account:read'] }, unknown, { approved: true }), { code: 'INVALID_INPUT' }); assert.ok(unknown.calls.every(c => c.method === 'GET')); assert.deepEqual(await readdir(dir), [])
  const failed = fixture({ failedKeyReadback: true }); await assert.rejects(run('ai api-key create', input, failed, { approved: true }), error => { assert.equal(error.details.secretSaved, true); assert.equal(error.details.resources.keyId, newKeyId); return true }); assert.equal(await readFile(input.secretOutput, 'utf8'), secret + '\n'); assert.equal(failed.calls.filter(c => c.method === 'POST').length, 1)
  const existing = fixture(); await assert.rejects(run('ai api-key create', input, existing, { approved: true }), { code: 'OUTPUT_EXISTS' }); assert.ok(existing.calls.every(c => c.method === 'GET'))
  const malformed = fixture({ badKeyReceipt: true }), malformedPath = join(dir, 'malformed'); await assert.rejects(run('ai api-key create', { ...input, secretOutput: malformedPath }, malformed, { approved: true }), error => { assert.equal(error.details.secretSaved, true); return true }); assert.equal(await readFile(malformedPath, 'utf8'), secret + '\n')
  const responseLost = fixture({ unknownWrite: true }); await assert.rejects(run('ai api-key create', { ...input, secretOutput: join(dir, 'unknown') }, responseLost, { approved: true }), error => { assert.equal(error.details.resultMayBeUnknown, true); assert.equal(error.details.automaticRetry, false); return true }); assert.equal(responseLost.calls.filter(c => c.method === 'POST').length, 1)
}))
test('AI key readback checks the actual saved secret hash and exact server validity duration', async () => temporary(async dir => {
  for (const [index, options] of [{ wrongKeyHash: true }, { wrongExpiry: true }].entries()) {
    const f = fixture(options), path = join(dir, 'mismatch-' + index)
    await assert.rejects(run('ai api-key create', { name: '自有', permissions: ['base:read'], expiresIn: 30, secretOutput: path }, f, { approved: true }), error => { assert.equal(error.code, 'VERIFICATION_FAILED'); assert.equal(error.details.secretSaved, true); return true })
    assert.equal(await readFile(path, 'utf8'), secret + '\n'); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
  }
}))
test('AI one-time key publication races retain a private recovery copy and do not overwrite another file', async () => temporary(async dir => {
  const path = join(dir, 'raced'), f = fixture({ afterKeyCreate: () => writeFile(path, 'competing', { mode: 0o600 }) }); let recovery
  await assert.rejects(run('ai api-key create', { name: '自有密钥', permissions: ['base:read'], secretOutput: path }, f, { approved: true }), error => { recovery = error.details.cause.recoveryFile; assert.ok(!JSON.stringify(error).includes(secret)); return true })
  assert.equal(await readFile(path, 'utf8'), 'competing'); assert.equal(await readFile(recovery, 'utf8'), secret + '\n'); assert.equal((await stat(recovery)).mode & 0o777, 0o600)
}))
test('AI configuration obeys confirmation, feature, expiry/capacity, dry-run and raw transport guards', async () => {
  const f = fixture(); await assert.rejects(run('ai account remove', { accountId }, f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  for (const options of [{ disabled: true }, { expired: true }, { over: true }]) { const blocked = fixture(options); await assert.rejects(run('ai config context', {}, blocked)); assert.ok(!blocked.calls.some(c => c.path.startsWith(base))) }
  const wrong = fixture({ identityChanged: true }); await assert.rejects(run('ai config context', {}, wrong), { code: 'IDENTITY_CHANGED' }); assert.ok(!wrong.calls.some(c => c.path.startsWith(base)))
  const offline = fixture(), plan = await run('ai account create', { account: { platformType: 'coze', accountName: '自有', credentials: { accessToken: secret } } }, offline, { dryRun: true }); assert.equal(plan.dryRun, true); assert.equal(offline.calls.length, 0); assert.ok(!JSON.stringify(plan).includes(secret))
  for (const op of catalog.operations.filter(op => op.route.startsWith(base + '/accounts') || op.route.startsWith(base + '/api-keys'))) { const input = op.inputSchema.properties.path ? { path: Object.fromEntries(Object.keys(op.inputSchema.properties.path.properties).map(key => [key, accountId])) } : {}; if (op.inputSchema.properties.body) continue; await assert.rejects(executeOperation(ctx, op, input, session, { approved: true, transport: offline.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }) }; assert.equal(offline.calls.length, 0)
})
