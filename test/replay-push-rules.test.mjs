import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { replayWebhookPlatform } from '../dist/replay-push-rules.js'
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const route = '/task/replay-intelligence/replay/push/rule', firstId = '0123456789abcdef01234567', nextId = '0123456789abcdef01234568'
const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-private-key', secret = 'fixture-private-secret'
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = suffix => { const value = workflows.workflows.find(f => f.command === 'replay push-rule ' + suffix); assert.ok(value, suffix); return value }
const input = { name: '专用规则', webhookUrl: webhook, webhookSecret: secret, collectionIds: ['51'] }
function fixture(options = {}) {
  const calls = [], current = { id: firstId, name: '现有规则', status: 'enabled', webhookUrl: webhook, webhookSecret: secret, webhookRemark: '保留', webhookConfigured: true, replayCollectList: [{ id: 51, name: '日报' }], cycleType: 'day', dataWindow: 'yesterday', pushTime: '09:00', skipHoliday: true, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }
  current.replayCollectList[0] = { ...current.replayCollectList[0], beforeSelectState: false, isSelect: true, isHover: false }
  const rules = [structuredClone(current)]
  return { calls, rules, transport: async (url, init) => {
    const query = Object.fromEntries(url.searchParams), method = init.method, body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method, query, body })
    if (url.pathname === '/task/login/authAjax') return json({ id: 81, token: 'fixture', username: 'fixture', success: true, team: { id: options.foreignIdentity ? 8 : 7, name: '公司' } })
    if (url.pathname.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (url.pathname.endsWith('/function/available')) return json([{ funcName: 'REPLAY', status: 'enable' }])
    if (url.pathname.endsWith('/company/current')) return json({ useReplay: true, replayManage: options.manage !== false, replayIntelligence: options.intelligence !== false })
    if (url.pathname === '/task/okr/role/replay/permission/current') return json({ replayManage: options.okrManage !== false, replayIntelligence: options.okrIntelligence !== false })
    if (url.pathname.endsWith('/intelligence/whitelist')) return json({ inWhitelist: options.whitelist !== false })
    if (url.pathname === '/task/review/replay/config/collect/list') return json([{ id: 51, name: '日报', type: 'day' }, { id: 52, name: '周报', type: 'week' }])
    if (url.pathname === route + '/list') return json({ list: rules.map(rule => Object.fromEntries(Object.entries(rule).filter(([key]) => !['webhookUrl', 'webhookSecret'].includes(key)))) })
    if (url.pathname === route && method === 'GET') {
      const value = structuredClone(rules.find(row => row.id === query.id)); if (options.failedReadback && query.id === nextId) value.pushTime = '12:00'; return json(value)
    }
    if (url.pathname === route && method === 'POST') {
      const value = { ...structuredClone(current), ...body, id: nextId }; rules.push(value)
      if (options.timeout) throw new Error('timeout after accepting write')
      return json(value)
    }
    if (url.pathname === route && method === 'PUT') { const value = rules.find(row => row.id === body.id); Object.assign(value, body); return json(value) }
    if (url.pathname === route && method === 'DELETE') { rules.splice(rules.findIndex(row => row.id === query.id), 1); if (options.dropOther) rules.length = 0; return json({ success: true }) }
    if (url.pathname === route + '/preview') return json({ content: '昨日提交摘要' })
    if (url.pathname === route + '/test-send') return json({ success: options.sendFailed !== true, message: options.sendFailed ? secret + ' ' + webhook : '发送测试成功' })
    throw Error('Unexpected ' + method + ' ' + url.pathname)
  } }
}
const run = (suffix, payload, service, options = {}) => runWorkflow(ctx, flow(suffix), payload, session, { transport: service.transport, ...options })
const mutations = service => service.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method))
test('push-rule UI management, intelligence and whitelist gates run before sensitive directories', async () => {
  for (const options of [{ manage: false }, { intelligence: false }, { whitelist: false }]) {
    const f = fixture(options); await assert.rejects(run('list', {}, f), error => ['FORBIDDEN', 'FEATURE_FORBIDDEN'].includes(error.code))
    assert.equal(f.calls.some(call => call.path === route + '/list' || call.path === '/task/review/replay/config/collect/list'), false)
  }
  const changed = fixture({ foreignIdentity: true }); await assert.rejects(run('list', {}, changed), { code: 'IDENTITY_CHANGED' }); assert.equal(changed.calls.length, 1)
})
test('independent OKR uses its actual authority endpoint rather than the main product permissions', async () => {
  const ok = fixture({ manage: false, intelligence: false }); await run('list', { application: 'okr' }, ok)
  assert.equal(ok.calls.some(call => call.path.endsWith('/company/current')), false)
  const denied = fixture({ okrManage: false }); await assert.rejects(run('list', { application: 'okr' }, denied), { code: 'FORBIDDEN' })
})
test('rule discovery uses Mongo IDs and outputs safe configuration plus a version without Webhook credentials', async () => {
  const f = fixture(), result = (await run('get', { ruleId: firstId }, f)).result, serialized = JSON.stringify(result)
  assert.equal(result.rule.id, firstId); assert.equal(result.rule.webhookPlatform, 'wecom'); assert.equal(result.rule.webhookSecretConfigured, true)
  assert.match(result.rule.version, /^[a-f0-9]{64}$/); assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes('fixture-private-key'), false)
  assert.deepEqual(result.collections, [{ id: '51', name: '日报', type: 'day' }])
})
test('create resolves collection names and numeric IDs, defaults disabled and verifies a separate detail and final directory', async () => {
  const f = fixture(), output = await run('create', input, f, { approved: true }), body = mutations(f)[0].body
  assert.equal(output.resources.ruleId, nextId); assert.equal(output.result.rule.status, 'disabled'); assert.equal(output.result.rules.length, 2)
  assert.deepEqual(body.replayCollectList, [{ id: 51, name: '日报' }]); assert.equal(body.skipHoliday, false); assert.equal(body.pushTime, '09:00')
  assert.equal(f.calls.filter(call => call.method === 'GET' && call.path === route && call.query.id === nextId).length, 1)
  assert.equal(JSON.stringify(output).includes(secret), false)
})
test('explicit patch preserves omitted Webhook credentials and handles false and empty secret without resetting other configuration', async () => {
  const f = fixture(), before = (await run('get', { ruleId: firstId }, f)).result.rule
  const output = await run('update', { ruleId: firstId, expectedVersion: before.version, patch: { enabled: false, skipHoliday: false, name: '重命名' } }, f, { approved: true })
  const saved = mutations(f)[0].body; assert.equal(saved.webhookUrl, webhook); assert.equal(saved.webhookSecret, secret); assert.equal(saved.webhookRemark, '保留'); assert.equal(saved.pushTime, '09:00'); assert.equal(saved.skipHoliday, false); assert.equal(saved.status, 'disabled')
  assert.equal(output.result.rule.status, 'disabled')
  await run('update', { ruleId: firstId, patch: { webhookSecret: '', webhookRemark: '' } }, f, { approved: true }); assert.equal(mutations(f)[1].body.webhookSecret, ''); assert.equal(mutations(f)[1].body.webhookRemark, '')
})
test('invalid, foreign, weekly, duplicate, empty and imprecise collection targets are rejected before mutation', async () => {
  for (const collectionIds of [['999'], ['52'], ['51', '51'], [], ['9223372036854775807']]) {
    const f = fixture(); await assert.rejects(run('create', { ...input, collectionIds }, f, { approved: true })); assert.equal(mutations(f).length, 0)
  }
  const f = fixture(); await assert.rejects(run('get', { ruleId: '0123456789abcdef01234569' }, f), { code: 'FORBIDDEN' }); assert.equal(f.calls.some(call => call.path === route), false)
})
test('an observed version mismatch stops a full replacement rather than silently discarding concurrent changes', async () => {
  const f = fixture(); await assert.rejects(run('update', { ruleId: firstId, expectedVersion: 'a'.repeat(64), patch: { enabled: false } }, f, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.equal(mutations(f).length, 0)
})
test('delete verifies absence while retaining other rules and does not return a deleted rule as current configuration', async () => {
  const f = fixture(); await run('create', input, f, { approved: true }); const result = (await run('remove', { ruleId: nextId }, f, { approved: true })).result
  assert.equal(result.removed, nextId); assert.equal(result.rule, undefined); assert.deepEqual(result.rules.map(row => row.id), [firstId])
  const broken = fixture({ dropOther: true }); await run('create', input, broken, { approved: true }); await assert.rejects(run('remove', { ruleId: nextId }, broken, { approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('preview requires confirmation because it consumes AI credits, and does not save temporary edits or send messages', async () => {
  const f = fixture(); await assert.rejects(run('preview', { ruleId: firstId }, f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const result = (await run('preview', { ruleId: firstId, patch: { name: '临时' } }, f, { approved: true })).result
  assert.equal(result.consumesAiCredits, true); assert.equal(result.sendsMessage, false); assert.equal(result.preview.content, '昨日提交摘要')
  assert.deepEqual(mutations(f).map(row => row.path), [route + '/preview']); assert.equal(f.rules[0].name, '现有规则')
})
test('test-send recognizes HTTP 200 failure and never replays or leaks a credential-bearing error message', async () => {
  const f = fixture({ sendFailed: true }); await assert.rejects(run('test-send', { ruleId: firstId }, f, { approved: true }), error => { assert.equal(error.code, 'BUSINESS_ERROR'); assert.equal(JSON.stringify(error).includes(secret), false); assert.equal(JSON.stringify(error).includes('fixture-private-key'), false); return true })
  assert.deepEqual(mutations(f).map(row => row.path), [route + '/test-send'])
  const ok = fixture(); assert.equal((await run('test-send', { ruleId: firstId }, ok, { approved: true })).result.sendsMessage, true)
})
test('unknown write outcome is not retried, and a failed independent readback retains the known rule ID', async () => {
  const unknown = fixture({ timeout: true }); await assert.rejects(run('create', input, unknown, { approved: true }), { code: 'NETWORK_ERROR' }); assert.equal(mutations(unknown).length, 1)
  const failed = fixture({ failedReadback: true }); await assert.rejects(run('create', input, failed, { approved: true }), error => { assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.details.resources.ruleId, nextId); return true })
})
test('all sensitive transport commands require business context, while dry-run stays offline without credential values', async () => {
  for (const op of catalog.operations.filter(op => op.route.startsWith(route))) {
    const f = fixture(), payload = op.method === 'GET' || op.method === 'DELETE' ? op.route.endsWith('/list') ? {} : { query: { id: firstId } } : { body: { name: 'x', status: 'disabled', webhookUrl: webhook, replayCollectList: [{ id: 51, name: '日报' }], pushTime: '09:00', skipHoliday: false, ...(op.method === 'PUT' && { id: firstId }) } }
    await assert.rejects(executeOperation(ctx, op, payload, session, { transport: f.transport, approved: true }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
  }
  const f = fixture(), plan = await executeWorkflow(ctx, flow('create'), input, session, { dryRun: true, transport: f.transport })
  assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(plan).includes(secret), false); assert.equal(JSON.stringify(plan).includes('fixture-private-key'), false)
})
test('public dispatcher enforces company expiry and capacity before reaching rule storage', async () => {
  for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY']]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('create'), input, session, { approved: true, transport: f.transport }), { code }); assert.equal(f.calls.some(call => call.path.startsWith(route)), false)
  }
})
test('Webhook targets follow the actual four platform gateways and reject an arbitrary URL or authority spoof', () => {
  assert.equal(replayWebhookPlatform(webhook), 'wecom'); assert.equal(replayWebhookPlatform('https://oapi.dingtalk.com/robot/send?access_token=fixture'), 'dingtalk'); assert.equal(replayWebhookPlatform('https://open.feishu.cn/open-apis/bot/v2/hook/fixture'), 'lark'); assert.equal(replayWebhookPlatform('https://xz.wps.cn/api/v1/webhook/send'), 'wps')
  for (const value of ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send', 'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send', 'https://user:pass@qyapi.weixin.qq.com/cgi-bin/webhook/send', 'https://example.com/api', 'https://open.feishu.cn/open-apis/bot/v2/hook/']) assert.throws(() => replayWebhookPlatform(value), { code: 'INVALID_INPUT' })
})
test('declared business result schema rejects a broken result while preserving completed writes and the assigned resource ID', async () => {
  const f = fixture(), broken = structuredClone(flow('create'))
  broken.resultSchema = { type: 'object', required: ['missingProof'] }
  await assert.rejects(runWorkflow(ctx, broken, input, session, { approved: true, transport: f.transport }), error => {
    assert.equal(error.code, 'RESPONSE_SCHEMA_MISMATCH'); assert.equal(error.details.resources.ruleId, nextId); assert.ok(error.details.completedSteps.includes('verified')); return true
  })
  assert.equal(mutations(f).length, 1)
})
