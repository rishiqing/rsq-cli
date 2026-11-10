import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { cycleDate } from '../dist/okr-cycles.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = suffix => { const value = workflows.workflows.find(flow => flow.command === 'okr cycles ' + suffix); assert.ok(value); return value }, run = (suffix, input, f, options = {}) => runWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, approved: true, ...options })
function fixture(options = {}) {
  const calls = [], cycles = new Map([['101', { id: '101', name: '当前周期', type: 'custom', startDate: '2027.01.01', endDate: '2027.01.31', isArchived: false, isSyncDingTodo: true }], ['102', { id: '102', name: '归档周期', type: 'custom', startDate: '2026.01.01', endDate: '2026.01.31', isArchived: true, isSyncDingTodo: false }]])
  let defaults = ['101']
  const active = () => ({ currentCycleList: [...cycles.values()].filter(row => !row.isArchived), futureCycleList: [], pastCycleList: [], hasArchiveCycle: [...cycles.values()].some(row => row.isArchived) })
  return { calls, cycles, transport: async (url, init) => {
    const path = url.pathname, method = init.method, body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined, q = Object.fromEntries(url.searchParams)
    calls.push({ path, method, body, query: q })
    if (path.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', team: { id: 7, name: 'fixture' }, token: 'private', success: true })
    if (path.endsWith('/member/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 3 : 1, userLimit: 2, vt: 'enterprise', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'OKR', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/authorities/company/current')) return json({})
    if (path.endsWith('/sidebar/editControl')) return json({ editCycle: !options.noManage })
    if (path.endsWith('/cycle/list')) return json(active())
    if (path.endsWith('/cycle/archive/list')) return json({ archiveCycleList: [...cycles.values()].filter(row => row.isArchived) })
    if (path.endsWith('/objective/count')) return json({ hasObj: !!options.hasObjectives, num: options.hasObjectives ? 5 : 0, content: options.hasObjectives ? '包含 5 个目标' : '' })
    if (path.endsWith('/cycle/default')) {
      if (method === 'PUT') { defaults = options.ignoreWrite ? defaults : body.ids.split(','); return json(defaults.map(key => cycles.get(key))) }
      const list = defaults.map(key => cycles.get(key)); return json(options.singleDefault ? list[0] : list)
    }
    if (options.timeout && ['POST', 'PUT', 'DELETE'].includes(method)) throw Error('unknown write outcome')
    if (path.endsWith('/cycle/archive') || path.endsWith('/cycle/archive/revert')) { if (!options.ignoreWrite) cycles.get(body.id).isArchived = path.endsWith('/archive'); return json(active()) }
    if (path.endsWith('/cycle')) {
      if (method === 'POST') { if (!options.ignoreWrite) cycles.set('9007199254740993123', { ...body, id: '9007199254740993123', isArchived: false, isSyncDingTodo: false }); return json(active()) }
      if (method === 'PUT') { if (!options.ignoreWrite) Object.assign(cycles.get(body.id), body); return json(active()) }
      if (method === 'DELETE') { if (!options.ignoreWrite) cycles.delete(q.id); return json(active()) }
    }
    throw Error('unexpected ' + method + ' ' + path)
  } }
}
test('cycle create/change/archive/restore/remove uses actual company context and independent readback', async () => {
  const f = fixture(), created = (await run('create', { name: '隔离周期', type: 'custom', startDate: '2027-03-05', endDate: '2027-03-18' }, f)).result.cycle
  assert.equal(created.id, '9007199254740993123'); assert.equal(created.startDate, '2027-03-05')
  assert.equal(f.calls.find(call => call.method === 'POST').body.startDate, '2027.03.05')
  const changed = (await run('change', { cycleId: '101', expectedVersion: (await run('context', {}, f)).result.items.find(row => row.id === '101').contextVersion, patch: { name: '更名' } }, f)).result.cycle
  assert.equal(changed.isSyncDingTodo, true); assert.equal(changed.startDate, '2027-01-01')
  assert.equal((await run('archive', { cycleId: created.id }, f)).result.cycle.isArchived, true)
  assert.equal((await run('restore', { cycleId: created.id }, f)).result.cycle.isArchived, false)
  const removed = await run('remove', { cycleId: created.id }, f); assert.equal(removed.result.removedCycleId, created.id); assert.ok(!f.cycles.has(created.id))
})
test('cycle UI management permissions, exact company membership and archive state are enforced before writes', async () => {
  const denied = fixture({ noManage: true }); await assert.rejects(run('create', { name: '不能创建', type: 'custom', startDate: '2027-01-01', endDate: '2027-01-02' }, denied), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!denied.calls.some(call => call.method === 'POST'))
  for (const [suffix, input] of [['change', { cycleId: '102', patch: { name: '归档不能直接改' } }], ['archive', { cycleId: '999' }], ['restore', { cycleId: '101' }]]) { const f = fixture(); await assert.rejects(run(suffix, input, f)); assert.ok(!f.calls.some(call => ['PUT', 'DELETE'].includes(call.method))) }
})
test('date conversion validates real calendar days, natural periods, names and stale versions', async () => {
  assert.equal(cycleDate('2028.02.29'), '2028-02-29'); assert.throws(() => cycleDate('2027-02-29'), { code: 'INVALID_INPUT' })
  for (const patch of [{ startDate: '2027-02-01' }, { name: '归档周期' }, { type: 'month', startDate: '2027-01-02', endDate: '2027-01-31' }]) { const f = fixture(); await assert.rejects(run('change', { cycleId: '101', patch }, f)); assert.ok(!f.calls.some(call => call.method === 'PUT')) }
  const f = fixture(); await assert.rejects(run('change', { cycleId: '101', expectedVersion: '0'.repeat(64), patch: { name: '过期' } }, f), { code: 'CONTEXT_CONFLICT' })
  await run('create', { name: '季度', type: 'quarter', startDate: '2028-01-01', endDate: '2028-03-31' }, fixture())
})
test('deletion checks total impact, requires explicit content consent and confirmation, and handles archived resources', async () => {
  const f = fixture({ hasObjectives: true }); assert.equal((await run('impact', { cycleId: '102' }, f)).result.hasObj, true)
  await assert.rejects(run('remove', { cycleId: '102' }, f), { code: 'CONTENT_CONFIRMATION_REQUIRED' }); assert.ok(!f.calls.some(call => call.method === 'DELETE'))
  await run('remove', { cycleId: '102', deleteObjectives: true }, f); assert.ok(!f.cycles.has('102'))
  const offline = fixture(); await assert.rejects(run('remove', { cycleId: '101' }, offline, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(offline.calls.length, 0)
})
test('personal default cycles do not require management permission, only accept current company IDs and verify full sets', async () => {
  const f = fixture({ noManage: true }); assert.equal((await run('default inspect', {}, f)).result.personalDefaults[0].id, '101')
  await run('default set', { cycleIds: ['101'] }, f)
  assert.ok(!f.calls.some(call => call.path === '/task/okr/init'))
  for (const cycleIds of [['102'], ['999'], []]) await assert.rejects(run('default set', { cycleIds }, f))
  const legacy = fixture({ singleDefault: true }); assert.equal((await run('default inspect', {}, legacy)).result.personalDefaults.length, 1)
})
test('unknown or ignored writes report failure without automatic replay and dry-run is offline', async () => {
  const ignored = fixture({ ignoreWrite: true }); await assert.rejects(run('change', { cycleId: '101', patch: { name: '未保存' } }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' })
  const timeout = fixture({ timeout: true }); await assert.rejects(run('archive', { cycleId: '101' }, timeout), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown' && error.details.retry === 'manual-after-readback'); assert.equal(timeout.calls.filter(call => call.method === 'PUT').length, 1)
  const f = fixture(); await run('create', { name: '预览', type: 'custom', startDate: '2027-01-01', endDate: '2027-01-02' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
})
test('public cycle commands enforce expiry/overcapacity/features and prohibit raw writes from bypassing UI limits', async () => {
  for (const [option, code] of [['expired', 'COMPANY_EXPIRED'], ['overCapacity', 'COMPANY_OVER_CAPACITY'], ['disabled', 'FEATURE_DISABLED']]) { const f = fixture({ [option]: true }); await assert.rejects(executeWorkflow(ctx, flow('change'), { cycleId: '101', patch: { name: '不允许' } }, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(call => call.path.endsWith('/cycle/list'))) }
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/okr/cycle'), f = fixture()
  await assert.rejects(executeOperation(ctx, op, { body: { id: '101', name: '绕过' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
