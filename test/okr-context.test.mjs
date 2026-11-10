import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId, teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, ...options })
const cycles = { currentCycleList: [{ id: '1001', isArchived: false }], futureCycleList: [], pastCycleList: [] }
const scopes = [{ id: 'person', canSelect: true, optionalUserList: [{ id: userId }], optionalDeptList: [] }]
const objective = { id: '2001', name: 'parent', cycle: { id: '1001' }, type: { id: userId, type: 'person' }, responsibleUser: { id: userId }, editControl: { edit: true, advance: true }, krList: [], allowManualUpdateProgress: true, progressType: 'auto', isSyncIndicator: false, progressStart: 0, progressTarget: 100 }
test('objective and planning creation resolve allowed identities and independently verify business ownership', async () => {
  for (const prefix of ['okr objectives', 'okr planning objectives']) {
    let writes = 0, calls = 0
    const input = { cycleId: '1001', type: 'person', name: 'created', scope: 'about' }
    const transport = async (url, init) => {
      calls++
      if (url.pathname.endsWith('/cycle/list')) return json(cycles)
      if (url.pathname.endsWith('/type/scope/list')) return json(scopes)
      if (init.method === 'POST') { writes++; const body = JSON.parse(init.body); assert.equal(body.responsibleUserId, userId); assert.equal(body.typeDataId, userId); return json({ id: '2001' }) }
      return json({ ...objective, name: 'created', scope: 'about' })
    }
    await run(prefix + ' create', input, transport, { dryRun: true }); assert.equal(calls, 0)
    const output = await run(prefix + ' create', input, transport); assert.equal(output.resources.objectiveId, '2001'); assert.equal(writes, 1)
    await assert.rejects(run(prefix + ' create', { ...input, responsibleUserId: '9999' }, transport), { code: 'FORBIDDEN' }); assert.equal(writes, 1)
    await assert.rejects(run(prefix + ' create', { ...input, cycleId: '9999' }, transport), { code: 'CONTEXT_MISSING' }); assert.equal(writes, 1)
  }
  assert.equal(catalog.operations.find(op => op.method === 'GET' && op.route === '/task/okr/objective').effect, 'write')
  assert.equal(catalog.operations.find(op => op.method === 'GET' && op.route === '/task/okr/objective/sidebar').effect, 'write')
})
test('OKR listing uses an explicit cursor and preserves organization/role filters', async () => {
  let queries = 0
  const transport = async url => {
    if (url.pathname.endsWith('/cycle/list')) return json(cycles)
    queries++; assert.equal(url.searchParams.get('frontId'), '999'); assert.equal(url.searchParams.get('dataId'), userId); assert.equal(url.searchParams.get('filterPersonType'), 'participant'); assert.equal(url.searchParams.get('max'), '1')
    return json([{ id: '2001' }])
  }
  const output = await run('okr planning objectives list', { cycleId: '1001', range: 'person', rangeId: userId, role: 'participant', after: '999', limit: 1 }, transport)
  assert.equal(output.result.context, 'planning'); assert.deepEqual(output.result.pagination, { kind: 'cursor', limit: 1, next: '2001', total: null })
  await assert.rejects(run('okr objectives list', { cycleId: '1001', range: 'dept' }, transport), { code: 'INVALID_INPUT' }); assert.equal(queries, 1)
})
test('new KR is identified by membership difference, preserving long IDs and zero values', async () => {
  let writes = 0, reads = 0
  const old = { id: '9007199254740995', name: 'old', krType: 'normal' }, added = { id: '8001', name: 'new', krType: 'normal', progressStart: 0, progressTarget: 8, progressCurrent: 0, unit: '项', editControl: { advance: true, directObjectiveEdit: null } }
  const transport = async (url, init) => {
    if (init.method === 'POST') { writes++; assert.deepEqual(JSON.parse(init.body), { objectiveId: '2001', name: 'new', progressStart: 0, progressTarget: 8, progressCurrent: 0, unit: '项' }); return json({ ...objective, krList: [old, added] }) }
    reads++; return json({ ...objective, krList: reads === 1 ? [old] : [old, added] })
  }
  const output = await run('okr objectives results add', { objectiveId: '2001', name: 'new', start: 0, target: 8, unit: '项' }, transport)
  assert.equal(output.resources.resultId, '8001'); assert.equal(output.result.resultId, '8001'); assert.equal(writes, 1)
})
test('KR operations reject another parent, sub-objective IDs, denied permissions and external progress sync', async () => {
  let writes = 0
  for (const resource of [
    { ...objective, krList: [] },
    { ...objective, krList: [{ id: '3001', krType: 'subObjective', editControl: { advance: true } }] },
    { ...objective, krList: [{ id: '3001', krType: 'normal', editControl: { advance: false } }] },
    { ...objective, krList: [{ id: '3001', krType: 'normal', progressType: 'fromDS', editControl: { advance: true } }] },
  ]) await assert.rejects(run('okr objectives results progress set', { objectiveId: '2001', resultId: '3001', current: 0 }, async (url, init) => { if (init.method !== 'GET') writes++; return json(resource) }))
  assert.equal(writes, 0)
})
test('objective deletion requires confirmation and distinguishes approval from actual removal', async () => {
  let calls = 0, deletes = 0
  const transport = async (url, init) => {
    calls++
    if (init.method === 'DELETE') { deletes++; return json({ ...objective, approvalStatus: { status: 'uncommitted' } }) }
    return json(url.pathname.endsWith('/selector/list') ? [{ id: '2001' }] : objective)
  }
  await assert.rejects(run('okr objectives remove', { objectiveId: '2001' }, transport), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(calls, 0)
  await assert.rejects(run('okr objectives remove', { objectiveId: '2001' }, transport, { approved: true }), error => error.code === 'APPROVAL_REQUIRED' && error.details.failedStep === 'deleted')
  assert.equal(deletes, 1)
  let after = false
  const removed = await run('okr objectives remove', { objectiveId: '2001' }, async (url, init) => {
    if (init.method === 'DELETE') { after = true; return json(null) }
    return json(url.pathname.endsWith('/selector/list') ? after ? [] : [{ id: '2001' }] : objective)
  }, { approved: true }); assert.equal(removed.result.deleted, true)
})
test('progress readback failure retains completed writes and never replays the update', async () => {
  let writes = 0
  await assert.rejects(run('okr objectives progress set', { objectiveId: '2001', percent: 0 }, async (url, init) => {
    if (init.method === 'PUT') { writes++; assert.equal(JSON.parse(init.body).progressCurrent, 0); assert.equal(JSON.parse(init.body).progressManual, undefined) }
    return json({ ...objective, progressManual: 90 })
  }), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.completedSteps.includes('changed'))
  assert.equal(writes, 1)
})
test('manual percentages use the current numeric range, preserving start and target', async () => {
  let reads = 0
  const output = await run('okr objectives progress set', { objectiveId: '2001', percent: 25 }, async (url, init) => {
    if (init.method === 'PUT') {
      assert.deepEqual(JSON.parse(init.body), { id: '2001', progressType: 'manual', progressCurrent: 8 })
      return json({ id: '2001' })
    }
    reads++; return json({ ...objective, progressStart: 5, progressTarget: 17, ...(reads > 1 && { progressType: 'manual', progressCurrent: 8, progressManual: 25 }) })
  })
  assert.equal(output.result.progressCurrent, 8); assert.equal(output.result.progressManual, 25)
})
