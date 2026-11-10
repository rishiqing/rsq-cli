import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar(), base = '/task/agent/v1/market'
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const flow = command => { const value = workflows.workflows.find(row => row.command === command); assert.ok(value, command); return value }
const run = (command, input, f, opts = {}) => runWorkflow(ctx, flow(command), input, session, { transport: f.transport, approved: true, ...opts })
const json = data => new Response(JSON.stringify({ code: 200, msg: 'success', data }), { headers: { 'content-type': 'application/json' } })
const raw = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  const calls = [], subscriptions = Array.from({ length: options.subscriptions ?? 0 }, (_, index) => ({ subscriptionId: 'subscription-' + index, agentId: 'agent-' + index, status: 'subscribed', subscribedAt: '2026-01-01T00:00:00.000Z', callCount: 0 }))
  let getCount = 0
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query, body })
    if (path.endsWith('/authAjax')) return raw({ id: 81, token: 'fixture', username: 'fixture', success: true, team: { id: options.wrongIdentity ? 8 : 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return raw({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return raw([{ funcName: 'AI_EMPLOYEE', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'PLAN', status: options.noPlan ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return raw({})
    const agentId = path.match(/\/agents\/([^/]+)/)?.[1], active = subscriptions.find(row => row.agentId === agentId)
    const status = () => active ? { subscribed: true, ...active } : { subscribed: false }
    if (method === 'GET' && (path === base + '/agents' || path === base + '/subscriptions')) {
      const page = Number(query.page), limit = Number(query.limit), items = path.endsWith('/subscriptions') ? subscriptions : [{ id: 'agent-new', name: '测试员工', subscribed: false }]
      return json({ items: options.duplicatePages ? Array.from({ length: 100 }, (_, index) => subscriptions[index]) : items.slice((page - 1) * limit, page * limit), total: options.totalDrift && page > 1 ? items.length + 1 : items.length, page, limit, totalPages: Math.ceil(items.length / limit) })
    }
    if (path.includes('/builtin-agents/')) return json({ subscribed: false, presetType: 'document_extractor_to_project_json' })
    if (path.endsWith('/subscription-status')) return json(options.wrongStatusAgent && active ? { ...status(), agentId: 'foreign-agent' } : status())
    if (agentId && method === 'GET') return json({ id: agentId, name: '测试员工', price: options.priceDrift && ++getCount === 2 ? '¥10/月' : '免费', subscribed: Boolean(active) })
    if (path.endsWith('/subscriptions') && method === 'POST') {
      if (options.timeout) throw Error('transport timeout')
      const row = { subscriptionId: 'subscription-new', agentId, status: 'subscribed', subscribedAt: '2026-01-01T00:00:00.000Z', callCount: 0 }; subscriptions.push(row)
      return json(options.badReceipt ? { ...row, status: 'bad-status' } : row)
    }
    if (path.startsWith(base + '/subscriptions/') && method === 'DELETE') {
      const id = path.split('/').at(-1), index = subscriptions.findIndex(row => row.subscriptionId === id); assert.ok(index >= 0)
      const [row] = subscriptions.splice(index, 1)
      if (options.loseUnrelated) subscriptions.shift()
      return json({ ...row, status: 'cancelled', subscribed: false })
    }
    if (path.startsWith(base + '/agent-conversations')) return json({ conversationId: 'conversation-created', reused: path.endsWith('/resolve') })
    throw Error('Unexpected AI fixture request ' + method + ' ' + path)
  }
  return { calls, subscriptions, transport }
}
const writes = f => f.calls.filter(call => call.method !== 'GET')
test('AI market has nine distinct executable workflows and read-only GET contracts', async () => {
  const actual = workflows.workflows.filter(row => row.executor === 'ai-market'); assert.equal(actual.length, 9)
  for (const item of actual) { assert.ok(item.resultSchema); assert.ok(item.steps.length) }
  for (const op of catalog.operations.filter(op => op.route.startsWith(base) && op.method === 'GET')) { assert.equal(op.effect, 'read'); assert.equal(op.idempotency, 'safe') }
  const f = fixture(), listed = await run('ai market list', { keyword: '测试', page: 1, limit: 10 }, f)
  assert.equal(listed.result.items[0].id, 'agent-new'); assert.equal(listed.result.totalPages, 1)
  assert.equal((await run('ai subscriptions preset-status', { presetType: 'document_extractor_to_project_json' }, f)).result.subscribed, false)
})
test('AI offline plan, confirmation, and transport guards prevent all HTTP before consent', async () => {
  const f = fixture(), input = { agentId: 'agent-new' }
  await run('ai subscriptions subscribe', input, f, { approved: false, dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('ai subscriptions subscribe', input, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const op = catalog.operations.find(op => op.route === base + '/agents' && op.method === 'GET')
  await assert.rejects(executeOperation(ctx, op, {}, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
  const edited = structuredClone(flow('ai market get')); edited.aiMarketAction = 'invented-action'
  await assert.rejects(runWorkflow(ctx, edited, input, session, { dryRun: true, transport: f.transport }), { code: 'INVALID_CONTRACT' })
})
test('AI subscribe verifies price and full enterprise directory including later pages', async () => {
  const f = fixture({ subscriptions: 101 }), context = await run('ai market get', { agentId: 'agent-new' }, f)
  const result = await run('ai subscriptions subscribe', { agentId: 'agent-new', expectedVersion: context.result.contextVersion }, f)
  assert.equal(result.result.verification, 'independent-status-and-directory'); assert.equal(result.result.enterpriseWide, true); assert.equal(f.subscriptions.length, 102)
  assert.ok(f.calls.some(call => call.query.page === '2')); assert.equal(writes(f).length, 1)
  await run('ai subscriptions subscribe', { agentId: 'agent-new' }, f); assert.equal(writes(f).length, 1)
  await run('ai subscriptions cancel', { agentId: 'agent-new', subscriptionId: 'subscription-new' }, f); assert.equal(f.subscriptions.length, 101)
  assert.equal(writes(f).length, 2)
})
test('AI cancellation proves current enterprise association and preserves unrelated subscriptions', async () => {
  const f = fixture({ subscriptions: 101 })
  await assert.rejects(run('ai subscriptions cancel', { agentId: 'agent-100', subscriptionId: 'foreign-subscription' }, f), { code: 'INVALID_INPUT' }); assert.equal(writes(f).length, 0)
  await run('ai subscriptions cancel', { agentId: 'agent-100', subscriptionId: 'subscription-100' }, f); assert.equal(f.subscriptions.length, 100); assert.ok(f.subscriptions.some(row => row.subscriptionId === 'subscription-0'))
  const lost = fixture({ subscriptions: 2, loseUnrelated: true })
  await assert.rejects(run('ai subscriptions cancel', { agentId: 'agent-1', subscriptionId: 'subscription-1' }, lost), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(lost).length, 1)
})
test('AI write preflight rejects price drift, invalid status, and incomplete or drifting pagination', async () => {
  for (const [options, code] of [[{ priceDrift: true }, 'CONTEXT_CONFLICT'], [{ subscriptions: 101, duplicatePages: true }, 'CONTEXT_MISSING'], [{ subscriptions: 101, totalDrift: true }, 'CONTEXT_CONFLICT']]) {
    const f = fixture(options); await assert.rejects(run('ai subscriptions subscribe', { agentId: 'agent-new' }, f), { code }); assert.equal(writes(f).length, 0)
  }
  const invalid = fixture({ subscriptions: 1, wrongStatusAgent: true })
  await assert.rejects(run('ai subscriptions status', { agentId: 'agent-0' }, invalid), { code: 'CONTEXT_MISSING' })
  const stale = fixture()
  await assert.rejects(run('ai subscriptions subscribe', { agentId: 'agent-new', expectedVersion: '0'.repeat(64) }, stale), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(stale).length, 0)
})
test('AI failure retains server-assigned resource IDs and never replays writes', async () => {
  const f = fixture({ badReceipt: true })
  await assert.rejects(run('ai subscriptions subscribe', { agentId: 'agent-new' }, f), error => { assert.equal(error.details.resources.subscriptionId, 'subscription-new'); assert.equal(error.details.rollback, 'not-attempted'); return true })
  assert.equal(writes(f).length, 1)
  const timeout = fixture({ timeout: true })
  await assert.rejects(run('ai subscriptions subscribe', { agentId: 'agent-new' }, timeout), error => error.details.writeOutcome === 'unknown-do-not-replay'); assert.equal(writes(timeout).length, 1)
})
test('AI HTTP conversations enforce source subscription and distinguish receipt from model execution', async () => {
  const f = fixture()
  await assert.rejects(run('ai conversation create', { agentId: 'agent-new', source: 'market_agent_in_address_book' }, f), { code: 'FORBIDDEN' }); assert.equal(writes(f).length, 0)
  const created = await run('ai conversation create', { agentId: 'agent-new', source: 'market_agent_test' }, f)
  assert.equal(created.result.executionStarted, false); assert.equal(created.result.verification, 'server-receipt')
  const active = fixture({ subscriptions: 1 }), resolved = await run('ai conversation resolve', { agentId: 'agent-0', source: 'market_agent_in_address_book' }, active)
  assert.equal(resolved.result.reused, true)
  await assert.rejects(run('ai conversation resolve', { agentId: 'agent-0', source: 'market_agent_test' }, active, { approved: false }), { code: 'CONFIRMATION_REQUIRED' })
})
test('public AI dispatcher enforces menu entitlement, expiry, capacity, identity, and project feature', async () => {
  for (const options of [{ disabled: true }, { expired: true }, { overCapacity: true }]) {
    const f = fixture(options)
    await assert.rejects(executeWorkflow(ctx, flow('ai market list'), {}, session, { transport: f.transport }), error => ['FEATURE_DISABLED', 'COMPANY_EXPIRED', 'COMPANY_OVER_CAPACITY'].includes(error.code))
    assert.equal(f.calls.filter(call => call.path.startsWith(base)).length, 0)
  }
  const wrong = fixture({ wrongIdentity: true }); await assert.rejects(run('ai market list', {}, wrong), { code: 'IDENTITY_CHANGED' }); assert.equal(wrong.calls.length, 1)
  const noPlan = fixture({ noPlan: true, subscriptions: 1 })
  await assert.rejects(executeWorkflow(ctx, flow('ai conversation create'), { agentId: 'agent-0', source: 'project_create' }, session, { transport: noPlan.transport, approved: true }), { code: 'FEATURE_DISABLED' }); assert.equal(writes(noPlan).length, 0)
})
