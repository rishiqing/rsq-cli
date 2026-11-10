import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  let items = options.items ?? Array.from({ length: 65 }, (_, index) => ({ id: String(9007199254741999n - BigInt(index)), type: 'commentTask', selfId: 'task-1', isRead: false, title: '本人通知', companyToken: 'must-not-leak', avatar: 'https://private.invalid/?signature=secret' }))
  let settings = { task: { commentTask: 1 }, briefing: { commentBriefing: 2 }, system: { hiddenSetting: 1 }, dailyAlert: { mobile: true, miniprogram: false, qywx: false, dingTalk: false, lark: false } }
  const calls = []
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    calls.push({ method: init.method, path: url.pathname + url.search, body })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '隔离公司', status: { teamLevel: options.level ?? 'enterprise' } }, oauth: { userFrom: options.origin ?? 'password' } })
    if (url.pathname.endsWith('/state/independent')) return json({ mainApp: options.mainApp ?? 'rsq', vt: '7', deadLine: options.expired ? '2000-01-01 23:59:59' : '2100-01-01 23:59:59', usersCount: options.overCapacity ? 11 : 1, userLimit: 10 })
    if (url.pathname.endsWith('/function/available')) return json([{ funcName: 'WORKFLOW', status: 'disable' }])
    if (url.pathname.endsWith('/company/current')) return json({ editAllMemberNotifySettings: options.companyPermission ?? true })
    if (init.method === 'GET') {
      if (url.pathname.endsWith('/option')) return json(settings)
      if (url.pathname.endsWith('/unReadCount')) return json({ numCount: items.filter(item => !item.isRead).length, redBool: false })
      const cursor = url.searchParams.get('frontId'), start = cursor ? items.findIndex(item => item.id === cursor) + 1 : 0
      return json(items.slice(start, start + Number(url.searchParams.get('max'))))
    }
    if (options.networkFailure) throw Error('unknown outcome')
    if (url.pathname.endsWith('/setToRead')) { if (!options.ignoreWrite) items.find(item => item.id === body.id).isRead = true }
    else if (url.pathname.endsWith('/setAllToRead')) { if (!options.ignoreWrite) items.forEach(item => { item.isRead = true }) }
    else if (url.pathname.endsWith('/clear')) { if (!options.ignoreWrite) items = items.filter(item => !item.isRead) }
    else if (url.pathname.endsWith('/updateOptionModule')) { if (!options.ignoreWrite) settings[body.module][body.name] = body.mode }
    else if (url.pathname.endsWith('/reset')) { settings = { task: { commentTask: 1 }, dailyAlert: { mobile: true } }; return json(settings) }
    return new Response(null)
  }
  return { transport, calls }
}
const flow = command => workflows.workflows.find(flow => flow.command === command)
const run = (command, input, f, options = {}) => runWorkflow(ctx, flow(command), input, session, { approved: true, transport: f.transport, ...options })
test('notifications use actual cursor pages, preserve long IDs and business routing, and strip invitation credentials', async () => {
  const f = fixture(), first = await run('notification list', { max: 2 }, f)
  assert.equal(first.result.nextCursor, '9007199254741998')
  assert.equal(first.result.items[0].selfId, 'task-1')
  assert.equal(first.result.mayHaveMore, true)
  assert.ok(!JSON.stringify(first).includes('must-not-leak'))
  assert.ok(!JSON.stringify(first).includes('signature'))
  const second = await run('notification list', { max: 2, cursor: first.result.nextCursor }, f)
  assert.equal(second.result.items[0].id, '9007199254741997')
  const read = await run('notification read', { id: first.result.items[0].id, max: 2 }, f)
  assert.equal(read.result.items[0].isRead, true)
  await assert.rejects(run('notification read', { id: '999' }, f), { code: 'FORBIDDEN' })
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
  await assert.rejects(run('notification read', { id: '9007199254741999' }, fixture({ ignoreWrite: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('notification bulk operations write once and independently verify beyond the first page', async () => {
  const f = fixture(), read = await run('notification read-all', {}, f)
  assert.equal(read.result.items.length, 65)
  assert.equal(read.result.verifiedAllPages, true)
  assert.equal(f.calls.filter(call => call.path.startsWith('/task/v1/notification/list')).length, 3)
  assert.deepEqual(f.calls.find(call => call.method === 'POST').body, { type: 'normal' })
  const clear = await run('notification clear-read', {}, f)
  assert.equal(clear.result.items.length, 0)
  assert.equal(clear.result.clearedRead, true)
  await assert.rejects(run('notification read-all', {}, fixture({ ignoreWrite: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
  const uncertain = fixture({ networkFailure: true })
  await assert.rejects(run('notification read-all', {}, uncertain), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown')
  assert.equal(uncertain.calls.length, 1)
  await assert.rejects(run('notification workflow read-all', { type: 'confirm' }, fixture()), { code: 'INVALID_INPUT' })
})
test('notification settings follow visible UI keys and actual platform, retaining shared modern replay settings', async () => {
  const f = fixture(), inspected = await run('notification settings inspect', {}, f)
  assert.ok(inspected.result.options.some(option => option.name === 'commentBriefing'))
  assert.ok(!inspected.result.options.some(option => option.name === 'hiddenSetting' || option.name === 'qywx'))
  const changed = await run('notification settings set', { group: 'briefing', name: 'commentBriefing', value: 5 }, f)
  assert.equal(changed.result.settings.briefing.commentBriefing, 5)
  assert.deepEqual(f.calls.find(call => call.method === 'PUT').body, { module: 'briefing', name: 'commentBriefing', mode: 5 })
  await assert.rejects(run('notification settings set', { group: 'dailyAlert', name: 'qywx', value: 1 }, f), { code: 'FORBIDDEN' })
  await assert.rejects(run('notification settings set', { group: 'task', name: 'commentTask', value: 0 }, f), { code: 'INVALID_INPUT' })
  await run('notification settings set', { group: 'dailyAlert', name: 'qywx', value: 1 }, fixture({ origin: 'qywx' }))
  await assert.rejects(run('notification settings set', { group: 'task', name: 'commentTask', value: 2 }, fixture({ ignoreWrite: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
  await run('notification settings reset', {}, f)
})
test('company-wide settings require explicit company, UI edition and role; public dispatch also enforces subscription state', async () => {
  for (const [options, code] of [[{ level: 'basic' },'FEATURE_UPGRADE_REQUIRED'], [{ mainApp: 'okr' },'FEATURE_UPGRADE_REQUIRED'], [{ companyPermission: false },'FORBIDDEN']]) {
    const f = fixture(options)
    await assert.rejects(run('notification settings apply-company', { companyId: '7' }, f), { code })
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0)
  }
  const valid = await run('notification settings apply-company', { companyId: '7' }, fixture())
  assert.equal(valid.result.acknowledged, true); assert.equal(valid.result.independentMemberReadback, false)
  for (const [options, code] of [[{ expired: true },'COMPANY_EXPIRED'], [{ overCapacity: true },'COMPANY_OVER_CAPACITY']]) {
    const f = fixture(options)
    await assert.rejects(executeWorkflow(ctx, flow('notification read-all'), {}, session, { approved: true, transport: f.transport }), { code })
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0)
  }
  await assert.rejects(executeWorkflow(ctx, flow('notification workflow list'), {}, session, { transport: fixture().transport }), { code: 'FEATURE_DISABLED' })
  const offline = { transport: async () => { throw Error('offline') } }
  assert.equal((await run('notification clear-read', {}, offline, { dryRun: true })).steps[1].collectPages.limit, 100)
  await assert.rejects(run('notification clear-read', {}, offline, { approved: false }), { code: 'CONFIRMATION_REQUIRED' })
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/v1/notification/setToRead')
  await assert.rejects(executeOperation(ctx, op, { body: { id: '1' } }, session, { approved: true, transport: offline.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
