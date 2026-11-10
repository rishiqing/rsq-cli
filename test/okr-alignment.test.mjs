import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = suffix => { const result = workflows.workflows.find(flow => flow.command === 'okr alignment ' + suffix); assert.ok(result); return result }
const run = (suffix, input, fixture, options = {}) => runWorkflow(ctx, flow(suffix), { objectiveId: '101', ...input }, session, { transport: fixture.transport, approved: true, ...options })
const ctrl = { disableCancel: false, disableEdit: false }, edge = (id, type = 'objective') => ({ id, okrType: type, name: 'fixture', alignEditControl: { ...ctrl } })
function fixture(options = {}) {
  const calls = [], parents = [edge('102'), edge('103')], children = [edge('201'), edge('202')]
  if (options.fixedParent) parents[0].alignEditControl.disableCancel = true
  let parentsReads = 0
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined, q = Object.fromEntries(url.searchParams)
    calls.push({ path, method, body, query: q })
    if (path.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', team: { id: options.wrongCompany ? 8 : 7, name: 'fixture' }, token: 'private', success: true })
    if (path.endsWith('/member/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 3 : 1, userLimit: 2, vt: 'enterprise', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'OKR', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/authorities/company/current')) return json({})
    if (path.endsWith('/cycle/list')) return json({ currentCycleList: [{ id: '7', isArchived: false, startDate: '2027.01.01', endDate: '2027.12.31' }, { id: '8', isArchived: false, startDate: '2027.01.01', endDate: '2027.01.31' }], futureCycleList: [], pastCycleList: [] })
    if (path.endsWith('/objective/me/align/list')) {
      if (q.objectiveId !== '101') return json(options.indirect ? [edge('999')] : [edge('101')])
      parentsReads++; if (options.drift && parentsReads === 2) parents.push(edge('901'))
      return json(parents)
    }
    if (path.endsWith('/objective/align/me/list')) return json(children)
    if (path.endsWith('/objective') && method === 'GET') return json({ id: '101', name: 'fixture', cycle: { id: '7' }, editControl: { edit: !options.noEdit, view: !options.noView } })
    if (path.endsWith('/select/meAlign/list')) {
      if (options.dense) {
        const first = q.startId ? 1100 : 1000, result = []
        if (first === 1100) return json([{ id: '9007199254740993123', objectiveId: '9007199254740993123', okrType: 'objective' }])
        for (let n = first; n < first + 100; n++) result.push({ id: String(n), objectiveId: String(n), okrType: 'objective' }, { id: String(n), keyResultId: String(n), parentObjective: String(n), okrType: 'keyResult' })
        return json(result)
      }
      const items = options.noCandidates ? [] : [{ id: '104', objectiveId: '104', okrType: 'objective', type: { id: '81', name: 'fixture', type: 'person' } }, ...(!options.noKr && !q.startId ? [{ id: '104', keyResultId: '104', parentObjective: '104', okrType: 'keyResult' }] : [])]
      return json(items)
    }
    if (path.endsWith('/select/alignMe/list')) return json(options.noCandidates ? [] : [{ id: '203', objectiveId: '203', okrType: 'objective', type: { id: '81', name: 'fixture', type: 'person' } }])
    if (options.timeout) throw Error('unknown write outcome')
    if (path.endsWith('/align/batch/list')) { if (!options.ignoreWrite) parents.splice(0, parents.length, ...body.meAlignList.map(row => edge(row.id, row.type))); return json({ id: '101' }) }
    if (path.endsWith('/align/add')) { if (!options.ignoreWrite) children.push(...body.objectiveIds.split(',').map(id => edge(id))); return new Response(null, { status: 204 }) }
    if (path.endsWith('/align/cancel')) { if (!options.ignoreWrite) children.splice(children.findIndex(row => row.id === q.objectiveId), 1); return new Response(null, { status: 204 }) }
    if (path.endsWith('/sort')) {
      const list = path.endsWith('/meAlign/sort') ? parents : children
      const index = list.findIndex(row => row.id === body.moveId && row.okrType === body.moveOkrType), item = list[index]
      if (!options.ignoreWrite) { list.splice(index, 1); const at = body.nextId ? list.findIndex(row => row.id === body.nextId && row.okrType === body.nextOkrType) : list.length; list.splice(at, 0, item) }
      return new Response(null, { status: 204 })
    }
    throw Error('Unexpected ' + method + path)
  }
  return { calls, parents, children, transport }
}
test('parent replacement preserves fixed edges, identifies KR by type plus ID, and verifies full independent readback', async () => {
  const f = fixture({ fixedParent: true }), before = (await run('inspect', {}, f)).result
  const result = (await run('parents set', { expectedVersion: before.contextVersion, parents: [{ id: '102', type: 'objective' }, { id: '104', type: 'objective', cycleId: '7' }, { id: '104', type: 'keyResult', cycleId: '7' }] }, f)).result
  assert.deepEqual(result.parents.map(row => [row.id, row.okrType]), [['102', 'objective'], ['104', 'objective'], ['104', 'keyResult']])
  const denied = fixture({ fixedParent: true }); await assert.rejects(run('parents set', { parents: [] }, denied), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!denied.calls.some(call => call.method === 'PUT'))
})
test('selectors page objectives, retain same numeric KR IDs and use objective cursors, not flattened response length', async () => {
  const f = fixture(), page = (await run('parents candidates', { cycleId: '7', limit: 1 }, f)).result
  assert.equal(page.items.length, 2); assert.equal(page.pagination.next, '104')
  const dense = fixture({ dense: true })
  await run('parents set', { parents: [{ id: '9007199254740993123', type: 'objective', cycleId: '7' }] }, dense)
  assert.equal(dense.calls.filter(call => call.path.endsWith('/select/meAlign/list')).length, 2)
  assert.equal(dense.calls.find(call => call.query.startId).query.startId, '1099')
})
test('new edges must be actual candidates, respect KR policy and parent cycle containment before writes', async () => {
  for (const [options, parent, code] of [[{ noCandidates: true }, { id: '104', type: 'objective', cycleId: '7' }, 'RESOURCE_FORBIDDEN'], [{ noKr: true }, { id: '104', type: 'keyResult', cycleId: '7' }, 'RESOURCE_FORBIDDEN'], [{}, { id: '104', type: 'objective', cycleId: '8' }, 'INVALID_INPUT']]) {
    const f = fixture(options); await assert.rejects(run('parents set', { parents: [parent] }, f), { code }); assert.ok(!f.calls.some(call => call.method === 'PUT'))
  }
  const f = fixture({ noEdit: true }); await assert.rejects(run('children add', { children: [{ id: '203', cycleId: '7' }] }, f), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!f.calls.some(call => call.method === 'POST'))
})
test('child addition, explicit direct cancellation and parent removal preserve unrelated relationships', async () => {
  const f = fixture(); await run('children add', { children: [{ id: '203', cycleId: '7' }] }, f); assert.deepEqual(f.children.map(row => row.id), ['201', '202', '203'])
  await run('children remove', { childId: '203' }, f); assert.deepEqual(f.children.map(row => row.id), ['201', '202'])
  await run('parents remove', { parent: { id: '103', type: 'objective' } }, f); assert.deepEqual(f.parents.map(row => row.id), ['102'])
  const indirect = fixture({ indirect: true }); await assert.rejects(run('children remove', { childId: '201' }, indirect), { code: 'INDIRECT_ALIGNMENT' }); assert.ok(!indirect.calls.some(call => call.method === 'DELETE'))
})
test('ordering computes current neighbors, rejects unknown or self neighbors, and verifies full actual order', async () => {
  const f = fixture(); await run('parents move', { move: { id: '102', type: 'objective' } }, f); assert.deepEqual(f.parents.map(row => row.id), ['103', '102'])
  await run('children move', { move: { id: '202', type: 'objective' }, before: { id: '201', type: 'objective' } }, f); assert.deepEqual(f.children.map(row => row.id), ['202', '201'])
  for (const before of [{ id: '999', type: 'objective' }, { id: '202', type: 'objective' }]) { const denied = fixture(); await assert.rejects(run('children move', { move: { id: '202', type: 'objective' }, before }, denied), { code: 'INVALID_INPUT' }); assert.ok(!denied.calls.some(call => call.method === 'PUT')) }
})
test('identity, visibility, stale or drifting contexts and destructive confirmation are checked before writes', async () => {
  for (const [options, input, code] of [[{ wrongCompany: true }, {}, 'IDENTITY_CHANGED'], [{ noView: true }, {}, 'RESOURCE_FORBIDDEN'], [{}, { expectedVersion: '0'.repeat(64) }, 'CONTEXT_CONFLICT'], [{ drift: true }, {}, 'CONTEXT_CONFLICT']]) { const f = fixture(options); await assert.rejects(run('parents remove', { parent: { id: '103', type: 'objective' }, ...input }, f), { code }); assert.ok(!f.calls.some(call => call.method === 'PUT')) }
  const f = fixture(); await assert.rejects(run('parents set', { parents: [] }, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('ignored and unknown writes do not report success or replay, and dry-run sends no requests', async () => {
  const f = fixture({ ignoreWrite: true }); await assert.rejects(run('parents remove', { parent: { id: '103', type: 'objective' } }, f), { code: 'BUSINESS_ASSERTION_FAILED' })
  const timeout = fixture({ timeout: true }); await assert.rejects(run('children add', { children: [{ id: '203', cycleId: '7' }] }, timeout), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown'); assert.equal(timeout.calls.filter(call => call.method === 'POST').length, 1)
  const offline = fixture(); await run('parents set', { parents: [] }, offline, { dryRun: true }); assert.equal(offline.calls.length, 0)
})
test('public entry enforces expiry/overcapacity/features and prevents raw alignment writes bypassing UI checks', async () => {
  for (const [option, code] of [['expired', 'COMPANY_EXPIRED'], ['overCapacity', 'COMPANY_OVER_CAPACITY'], ['disabled', 'FEATURE_DISABLED']]) { const f = fixture({ [option]: true }); await assert.rejects(executeWorkflow(ctx, flow('children add'), { objectiveId: '101', children: [{ id: '203', cycleId: '7' }] }, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(call => call.path.endsWith('/cycle/list'))) }
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route.endsWith('/objective/align/batch/list')), f = fixture()
  await assert.rejects(executeOperation(ctx, op, { body: { id: '101', meAlignList: [] } }, session, { transport: f.transport, approved: true }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
