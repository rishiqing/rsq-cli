import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { operationOutput, catalog } from '../dist/operations.js'

const ctx = { environment: 'production', profile: 'isolated-company' }
const token = marker => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, marker })).toString('base64url') + '.signature'
const original = { version: 1, method: 'password', identity: { userId: '101', username: 'old-user', teamId: '201' }, accessToken: token('old'), expiresAt: Date.now() + 3600000,
  cookies: { version: 'tough-cookie@6.0.0', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, enableLooseMode: false, allowSpecialUseDomain: true, prefixSecurity: 'silent', cookies: [{ key: 'JSESSIONID', value: 'shared-source-session', domain: 'www.rishiqing.com', path: '/task', secure: true, hostOnly: true, creation: new Date().toISOString(), lastAccessed: new Date().toISOString() }] } }
const flow = action => workflows.workflows.find(flow => flow.command === 'organization ' + action)
const json = (body, cookies = []) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(body), { headers })
}
function service({ action = 'switch', failAt, mismatch, permission = true, corruptReadback = false } = {}) {
  const calls = [], stored = [], nextToken = token('new'), companyId = '9007199254740993', userId = '9007199254740995'
  let selected = false, created = false, identities = 0, patch = {}
  const before = [{ id: 101, name: 'existing', team: { id: 201, name: 'Original' } }, { id: userId, name: 'isolated', team: { id: companyId, name: 'Isolated' } }]
  const transport = async (url, init) => {
    const method = init.method, headers = init.headers
    calls.push({ method, path: url.pathname, body: init.body, headers: new Headers(headers) })
    const index = calls.length
    if (index === failAt) throw Error('connection lost')
    // No use of the original saved browser session, including on the first GET.
    assert.ok(!String(headers.get('cookie')).includes('shared-source-session'))
    if (url.pathname === '/task/login/authAjax') {
      identities++
      const exchange = selected && identities === 2
      if (exchange) {
        assert.equal(headers.get('token'), null)
        assert.equal(headers.get('username'), null)
        assert.ok(headers.get('cookie').includes('remember=new-cookie'))
        assert.ok(!headers.get('cookie').includes('JSESSIONID='))
      } else {
        assert.equal(headers.get('cookie'), null)
        assert.equal(headers.get('token'), selected ? nextToken : original.accessToken)
      }
      const next = selected
      return json({ success: true, id: next ? userId : 101, username: next ? 'new-user' : 'old-user', token: next ? nextToken : original.accessToken,
        team: { id: next ? mismatch ?? companyId : 201, name: next ? 'Isolated' : 'Original', introduction: '', industry: '', size: '', region: 'preserved', logo: 'existing-logo',
          ...patch, ...(corruptReadback && identities > 1 ? { region: 'unexpected-reset' } : {}) } },
      identities === 1 ? ['JSESSIONID=private-new-session; Path=/task; Secure; HttpOnly', 'remember=old-cookie; Path=/task; Secure; HttpOnly'] : [])
    }
    if (url.pathname === '/task/v1/team/fetchUserSiblings') {
      // The post-write account-membership proof uses the original token too.
      assert.equal(headers.get('token'), original.accessToken)
      return json(action === 'create' && !created ? before.slice(0, 1) : before)
    }
    if (url.pathname === '/task/authority/v3/authorities/company/current') return json({ editTeamInfo: permission })
    if (url.pathname === '/task/v1/team/switchUser' || method === 'POST' && url.pathname === '/task/v1/team') {
      assert.equal(headers.get('token'), original.accessToken)
      assert.ok(headers.get('cookie').includes('private-new-session'))
      const body = JSON.parse(init.body)
      if (method === 'PUT') assert.equal(body.userId, userId)
      else { assert.deepEqual(body, { name: 'Isolated', canTel: false }); created = true }
      selected = true
      const response = method === 'POST' ? json({ id: companyId, name: 'Isolated' }) : new Response(null)
      response.headers.append('set-cookie', 'remember=new-cookie; Path=/task; Secure; HttpOnly')
      response.headers.append('set-cookie', 'JSESSIONID=; Path=/task; Max-Age=0')
      return response
    }
    if (url.pathname === '/task/v1/team' && method === 'PUT') {
      patch = JSON.parse(init.body)
      return json({ id: 201, name: 'Original', ...patch })
    }
    throw Error('Unexpected route')
  }
  return { transport, calls, stored, companyId, nextToken, storeSession: async (context, session) => stored.push({ context, session }) }
}
test('organization switch exchanges the response cookie without the old token, independently verifies and atomically saves the new identity', async () => {
  const fixture = service()
  const originalCopy = structuredClone(original)
  const result = await runWorkflow(ctx, flow('switch'), { teamId: fixture.companyId, fromTeamId: '201' }, original, fixture)
  assert.equal(fixture.calls.length, 6)
  assert.equal(fixture.stored.length, 1)
  assert.equal(fixture.stored[0].session.identity.teamId, fixture.companyId)
  assert.equal(fixture.stored[0].session.identity.userId, '9007199254740995')
  assert.equal(fixture.stored[0].session.accessToken, fixture.nextToken)
  assert.equal(result.result.localSessionUpdated, true)
  assert.equal(result.result.accountDefaultChanged, true)
  assert.ok(!JSON.stringify(result).includes(fixture.nextToken))
  assert.ok(!JSON.stringify(result).includes('new-cookie'))
  assert.deepEqual(original, originalCopy)
})
test('company creation preserves the original account membership and saves only the independently verified new team session', async () => {
  const fixture = service({ action: 'create' })
  const result = await runWorkflow(ctx, flow('create'), { name: 'Isolated', fromTeamId: '201' }, original, { ...fixture, approved: true })
  assert.equal(result.resources.teamId, fixture.companyId)
  assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(fixture.stored[0].context.profile, ctx.profile)
})
test('company writes check confirmation, source identity and target directory before sending a write', async () => {
  const fixture = service()
  await assert.rejects(runWorkflow(ctx, flow('create'), { name: 'Isolated' }, original, fixture), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(fixture.calls.length, 0)
  await assert.rejects(runWorkflow(ctx, flow('switch'), { teamId: fixture.companyId, fromTeamId: '202' }, original, fixture), { code: 'ORGANIZATION_MISMATCH' })
  await assert.rejects(runWorkflow(ctx, flow('switch'), { teamId: '404' }, original, fixture), { code: 'ORGANIZATION_NOT_FOUND' })
  assert.ok(fixture.calls.every(call => call.method === 'GET'))
  assert.equal(fixture.stored.length, 0)
})
test('wrong exchanged identity and a lost write never overwrite the saved profile or replay writes', async () => {
  for (const options of [{ mismatch: '999' }, { failAt: 3 }]) {
    const fixture = service(options)
    await assert.rejects(runWorkflow(ctx, flow('switch'), { teamId: fixture.companyId }, original, fixture), error => {
      assert.equal(error.code, options.mismatch ? 'IDENTITY_CHANGED' : 'NETWORK_ERROR')
      assert.equal(error.details.localSessionUpdated, false)
      assert.equal(error.details.serverAccountDefaultMayHaveChanged, true)
      if (!options.mismatch) assert.equal(error.details.writeOutcome, 'unknown')
      assert.equal(error.details.resources.teamId, fixture.companyId)
      assert.ok(!JSON.stringify(error.details).includes(original.accessToken))
      return true
    })
    assert.equal(fixture.calls.filter(call => call.method === 'PUT').length, 1)
    assert.equal(fixture.stored.length, 0)
  }
})
test('organization session persistence failure identifies the completed server transition without exposing credentials', async () => {
  const fixture = service()
  await assert.rejects(runWorkflow(ctx, flow('switch'), { teamId: fixture.companyId }, original, { ...fixture, storeSession: async () => { throw Error('disk full with private path') } }), error => {
    assert.equal(error.code, 'SESSION_STORE_FAILED')
    assert.equal(error.details.failedStep, 'saveSession')
    assert.equal(error.details.localSessionUpdated, false)
    assert.ok(error.details.completedSteps.includes('verified'))
    assert.ok(!JSON.stringify(error).includes('private path'))
    return true
  })
})
test('company settings use the exact token-bound team, actual edit permission and explicit clearing, preserving other fields', async () => {
  const fixture = service({ action: 'update' })
  const result = await runWorkflow(ctx, flow('update'), { teamId: '201', patch: { introduction: '' } }, original, { ...fixture, approved: true })
  assert.equal(result.result.organization.region, 'preserved')
  assert.deepEqual(JSON.parse(fixture.calls.find(call => call.method === 'PUT').body), { introduction: '' })
  assert.equal(fixture.stored.length, 0)
  for (const [permission, corruptReadback, expected] of [[false, false, 'FORBIDDEN'], [true, true, 'BUSINESS_ASSERTION_FAILED']]) {
    const failed = service({ action: 'update', permission, corruptReadback })
    await assert.rejects(runWorkflow(ctx, flow('update'), { teamId: '201', patch: { introduction: '' } }, original, { ...failed, approved: true }), { code: expected })
    if (!permission) assert.ok(failed.calls.every(call => call.method === 'GET'))
  }
})
test('organization context and compatibility identity output do not reveal the authAjax token', async () => {
  const fixture = service()
  const result = await runWorkflow(ctx, flow('context'), {}, original, fixture)
  assert.equal(result.result.identity.teamId, '201')
  assert.ok(!JSON.stringify(result).includes(original.accessToken))
  const op = catalog.operations.find(op => op.command === 'identity inspect')
  assert.equal(operationOutput(op, { success: true, id: 101, token: 'secret', session: 'secret' }).token, undefined)
})
test('organization dry-run is offline, exposes the cookie-only exchange and refuses invalid executor routes', async () => {
  let called = false
  const result = await runWorkflow(ctx, flow('create'), { name: 'Isolated' }, null, { dryRun: true, transport: async () => { called = true }, storeSession: async () => { called = true } })
  assert.equal(called, false)
  assert.equal(result.dryRun, true)
  assert.equal(workflowSchema(flow('switch')).context.find(step => step.id === 'exchanged').authentication, 'cookie')
  const invalid = structuredClone(flow('switch')); invalid.steps[3].authentication = undefined
  await assert.rejects(runWorkflow(ctx, invalid, { teamId: '201' }, original, { dryRun: true }), { code: 'INVALID_CONTRACT' })
})
