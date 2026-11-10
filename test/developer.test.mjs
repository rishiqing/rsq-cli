import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, readdir, rm, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context } from '../dist/core.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { validateDeveloperWorkflow } from '../dist/developer.js'
import { privateOutput } from '../dist/private-output.js'
const ctx = context('production', 'fixture'), session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, cookies: { version: 'tough-cookie@6.0.0', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, enableLooseMode: false, allowSpecialUseDomain: true, prefixSecurity: 'silent', cookies: [] }, identity: { userId: '81', teamId: '7' } }
const original = 'fixture-developer-key-aaaaaaaaaaaaaaaa', replacement = 'fixture-developer-key-bbbbbbbbbbbbbbbb', digest = value => createHash('sha256').update(value).digest('hex')
const flow = suffix => { const found = workflows.workflows.find(f => f.command === 'organization developer ' + suffix); assert.ok(found); return found }
const run = (suffix, input, f, options = {}) => executeWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, ...options })
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  const calls = []; let key = original, keyReads = 0, stateReads = 0
  return { calls, async transport(url, init) {
    const path = url.pathname; calls.push({ path, method: init.method, body: init.body, query: Object.fromEntries(url.searchParams) })
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) { stateReads++; return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq', appModule: options.changedApp && stateReads > 2 ? 1 : 0, ...(!options.missingTrial && { isTrial: options.trial ?? false }), isFree: options.free ?? false }) }
    if (path.endsWith('/getOpenapiKey')) { keyReads++; if (options.failedReadback && key === replacement) throw Error('Fixture timeout'); if (options.keyChanged && keyReads > 1) key = replacement; return json({ openapiKey: key }) }
    if (path.endsWith('/generateOpenapiKey')) { assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { appModule: 0 }); key = replacement; await options.onRotate?.(); if (options.failedWrite) throw Error('Fixture unknown write response'); return json({ openapiKey: key }) }
    throw Error('Unexpected fixture path ' + path)
  } }
}
const directory = async fn => { const path = await mkdtemp(join(tmpdir(), 'rsq-private-output-')); try { return await fn(path) } finally { await rm(path, { recursive: true, force: true }) } }
test('developer discovery binds current user/application without reading or initializing a key', async () => {
  for (const name of ['context', 'token inspect', 'token save', 'token rotate']) validateDeveloperWorkflow(flow(name))
  const f = fixture(), result = await run('context', {}, f)
  assert.equal(result.result.scope, 'current-user-and-app-module'); assert.equal(result.result.companyWideKey, false); assert.equal(result.result.appModule, 0)
  assert.ok(!f.calls.some(c => c.path.includes('OpenapiKey')))
  const inspected = await run('token inspect', {}, f); assert.equal(inspected.result.fingerprint, digest(original)); assert.equal(inspected.result.getMayInitialize, true)
  assert.ok(!JSON.stringify(inspected).includes(original)); assert.equal(inspected.result.secretExposed, false)
})
test('developer save creates a private complete new file and returns only its fingerprint', async () => directory(async dir => {
  const path = join(dir, 'api-key'), f = fixture(), result = await run('token save', { secretOutput: path }, f)
  assert.equal(await readFile(path, 'utf8'), original + '\n'); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(result.result.output.atomic, true)
  assert.ok(!JSON.stringify(result).includes(original)); assert.deepEqual(await readdir(dir), ['api-key']); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0)
}))
test('rotation requires confirmation, exact current fingerprint and a fresh private output path', async () => directory(async dir => {
  const input = { secretOutput: join(dir, 'new-key'), expectedFingerprint: digest(original) }, f = fixture()
  await assert.rejects(run('token rotate', input, f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const mismatch = fixture(); await assert.rejects(run('token rotate', { ...input, expectedFingerprint: '0'.repeat(64) }, mismatch, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.ok(!mismatch.calls.some(c => c.method === 'POST'))
  const changed = fixture({ keyChanged: true }); await assert.rejects(run('token rotate', input, changed, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.ok(!changed.calls.some(c => c.method === 'POST'))
  const changedApp = fixture({ changedApp: true }); await assert.rejects(run('token rotate', input, changedApp, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.ok(!changedApp.calls.some(c => c.method === 'POST'))
  const result = await run('token rotate', input, f, { approved: true }); assert.equal(result.result.rotated, true); assert.equal(result.result.previousFingerprint, digest(original)); assert.equal(result.result.fingerprint, digest(replacement)); assert.equal(await readFile(input.secretOutput, 'utf8'), replacement + '\n'); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
}))
test('a readback timeout preserves the new key and an unknown write response is never replayed', async () => directory(async dir => {
  const input = { secretOutput: join(dir, 'saved'), expectedFingerprint: digest(original) }, failedReadback = fixture({ failedReadback: true })
  await assert.rejects(run('token rotate', input, failedReadback, { approved: true }), error => { assert.equal(error.details.rotated, true); assert.equal(error.details.secretOutput, input.secretOutput); assert.ok(!JSON.stringify(error.details).includes(replacement)); return true })
  assert.equal(await readFile(input.secretOutput, 'utf8'), replacement + '\n'); assert.equal(failedReadback.calls.filter(c => c.method === 'POST').length, 1)
  const unknown = fixture({ failedWrite: true }); await assert.rejects(run('token rotate', { ...input, secretOutput: join(dir, 'unknown') }, unknown, { approved: true }), error => { assert.equal(error.details.resultMayBeUnknown, true); assert.equal(error.details.automaticRetry, false); return true }); assert.equal(unknown.calls.filter(c => c.method === 'POST').length, 1)
}))
test('a publication race retains the 0600 recovery copy without replacing the competing file', async () => directory(async dir => {
  const path = join(dir, 'raced'), f = fixture({ onRotate: () => writeFile(path, 'competing file', { mode: 0o600 }) })
  let recovery
  await assert.rejects(run('token rotate', { secretOutput: path, expectedFingerprint: digest(original) }, f, { approved: true }), error => { assert.equal(error.code, 'SECRET_OUTPUT_FAILED'); recovery = error.details.cause.recoveryFile; assert.ok(!JSON.stringify(error.details).includes(replacement)); return true })
  assert.equal(await readFile(path, 'utf8'), 'competing file'); assert.equal(await readFile(recovery, 'utf8'), replacement + '\n'); assert.equal((await stat(recovery)).mode & 0o777, 0o600); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
}))
test('existing files, symlinks and unsafe directories fail before any key is fetched or rotated', async () => directory(async dir => {
  const existing = join(dir, 'old'), alias = join(dir, 'alias'); await writeFile(existing, 'leave intact', { mode: 0o600 }); await symlink(existing, alias)
  for (const path of [existing, alias]) { const f = fixture(); await assert.rejects(run('token save', { secretOutput: path }, f), { code: 'OUTPUT_EXISTS' }); assert.ok(!f.calls.some(c => c.path.includes('OpenapiKey'))) }
  await chmod(dir, 0o777); await assert.rejects(privateOutput(join(dir, 'bad')), { code: 'UNSAFE_OUTPUT' }); await chmod(dir, 0o700)
  assert.equal(await readFile(existing, 'utf8'), 'leave intact')
}))
test('current public free/trial restrictions, company expiry and capacity run before developer key access', async () => {
  for (const [options, code] of [[{ trial: true }, 'FEATURE_DISABLED'], [{ free: true }, 'FEATURE_DISABLED'], [{ missingTrial: true }, 'CONTEXT_MISSING'], [{ expired: true }, 'COMPANY_EXPIRED'], [{ over: true }, 'COMPANY_OVER_CAPACITY']]) { const f = fixture(options); await assert.rejects(run('token inspect', {}, f), { code }); assert.ok(!f.calls.some(c => c.path.includes('OpenapiKey'))) }
})
test('offline plans need no directory or network; raw secret routes cannot bypass the business adapter', async () => {
  const f = fixture(); const plan = await run('token rotate', { secretOutput: '/does-not-exist/key', expectedFingerprint: digest(original) }, f, { dryRun: true }); assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
  const raw = catalog.operations.find(op => op.route.endsWith('/getOpenapiKey')); await assert.rejects(executeOperation(ctx, raw, { query: { appModule: 0 } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
  const bad = structuredClone(flow('context')); bad.steps[0].input = { arbitrary: true }; assert.throws(() => validateDeveloperWorkflow(bad), { code: 'INVALID_CONTRACT' })
  await assert.rejects(run('context', { appModule: 1 }, f), { code: 'INVALID_INPUT' })
})
