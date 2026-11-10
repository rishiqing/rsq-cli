import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { prepareProjectCollection, verifyProjectCollection } from '../dist/project-collection.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', accessToken: 'fixture-token', identity: { userId, teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const run = (suffix, input, transport, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === 'project collection ' + suffix), input, session, { transport, ...options })
const collection = { id: '7001', name: 'fixture', color: '1', members: [{ userId, role: 'creator' }] }
const directory = [{ id: '10', name: 'company', type: 'top', parentId: null, displayOrder: 1, userList: [{ id: userId, showName: 'self' }, { id: '2', showName: 'member' }], childList: [] }]
test('collection creation preserves creator and long IDs, validates membership readback, and stays offline for dry-run', async () => {
  let calls = 0
  const transport = async (url, init) => {
    calls++
    if (url.pathname === '/task/v1/department/list') return json(directory)
    assert.equal(url.pathname, '/task/v3/kanbanCollection')
    if (init.method === 'POST') {
      const body = JSON.parse(init.body)
      assert.equal(body.memberIds, userId + ',2'); assert.equal(body.color, '13')
      return json({ ...collection, color: '13' })
    }
    return json({ ...collection, color: '13', members: [...collection.members, { userId: '2', role: 'common' }] })
  }
  assert.equal((await run('create', { name: 'fixture', color: '13', memberIds: '2,2' }, transport, { dryRun: true })).dryRun, true)
  assert.equal(calls, 0)
  const result = await run('create', { name: 'fixture', color: '13', memberIds: '2,2' }, transport)
  assert.equal(result.resources.collectionId, '7001'); assert.equal(calls, 3)
  calls = 0
  await assert.rejects(run('create', { name: 'fixture', memberIds: '2' }, async (url, init) => { calls++; return json(url.pathname === '/task/v1/department/list' ? directory : collection) }), error => {
    assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.details.resources.collectionId, '7001')
    assert.equal(error.details.failedStep, 'verified'); return true
  })
  assert.equal(calls, 3)
})
test('collection membership enforces creator, retains omitted properties, and rejects another collection before mutation', async () => {
  const before = structuredClone(collection), results = { before, preflight: before, directory }
  assert.deepEqual(prepareProjectCollection('collection-update', { collectionId: '7001', patch: { color: '2' } }, results, session), { body: { id: '7001', color: '2' } })
  assert.deepEqual(before, collection)
  assert.equal(prepareProjectCollection('collection-members', { collectionId: '7001', memberIds: '2' }, results, session).body.memberIds, userId + ',2')
  assert.throws(() => prepareProjectCollection('collection-update', { collectionId: '7001', patch: { name: 'other' } }, { before: { ...collection, members: [{ userId: '3', role: 'creator' }] } }, session), { code: 'FORBIDDEN' })
  let calls = 0
  await assert.rejects(run('delete', { collectionId: '9999' }, async () => { calls++; return json([collection]) }, { approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(run('delete', { collectionId: '7001' }, async () => { calls++; return json([]) }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(calls, 0)
})
test('project association skips duplicate writes and verifies removal preserves the source project', async () => {
  const paths = [], projects = [{ kanbanId: '9001', name: 'project' }]
  const transport = async (url, init) => {
    paths.push(init.method + ' ' + url.pathname)
    if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
    if (url.pathname.endsWith('/collection/project/list')) return json(projects)
    if (url.pathname.endsWith('/selectKanbanList')) return json([{ id: '9001', name: 'project' }])
    if (url.pathname.endsWith('/removeKanban')) { assert.equal(url.searchParams.get('kanbanId'), '9001'); projects.length = 0; return new Response('') }
    if (url.pathname.endsWith('/kanbanCrud')) { assert.equal(init.method, 'GET'); return json({ id: '9001', name: 'project' }) }
    throw Error('Unexpected request')
  }
  const added = await run('project add', { collectionId: '7001', projectId: '9001' }, transport)
  assert.ok(added.skippedSteps.includes('added')); assert.ok(!paths.some(path => path.startsWith('POST')))
  const removed = await run('project remove', { collectionId: '7001', projectId: '9001' }, transport, { approved: true })
  assert.equal(removed.result.project.id, '9001'); assert.equal(projects.length, 0)
  assert.equal(paths.filter(path => path.startsWith('DELETE')).length, 1)
})
test('stage and roadmap adapters separate project and task-module IDs and handle empty contexts over HTTP', async () => {
  const requests = []
  const transport = async (url, init) => {
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
    if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
    if (url.pathname.endsWith('/collection/project/list')) return json([{ kanbanId: '9001', name: 'project' }])
    if (url.pathname.endsWith('/kanbanChildCrud/list')) return json([{ id: '9002', name: 'task', type: 'task' }, { id: '9003', name: 'overview', type: 'overview' }])
    if (url.pathname.endsWith('/card/projectCollection/roadmap')) { assert.equal(url.searchParams.get('planId'), '9002'); return json([{ id: '9004', name: 'stage' }]) }
    if (url.pathname.endsWith('/roadMap/planList')) { assert.equal(url.searchParams.get('mode'), 'milestone'); return json([]) }
    throw Error('Unexpected request')
  }
  const stage = await run('stages get', { collectionId: '7001', projectId: '9001' }, transport)
  assert.equal(stage.result.modules.length, 1); assert.equal(stage.result.modules[0].cards[0].id, '9004')
  const roadmap = await run('roadmap milestones get', { collectionId: '7001', projectId: '9001' }, transport)
  assert.deepEqual(roadmap.result, { plans: [], items: [] }); assert.ok(roadmap.skippedSteps.includes('items'))
  assert.ok(!requests.some(request => request.path.endsWith('/roadmap/milestoneTasks')))
})
test('milestone roadmap cross-checks actual project modules and independently validates returned task dates', async () => {
  const make = (options = {}) => {
    const calls = []
    return { calls, transport: async (url) => {
      calls.push(url.pathname)
      if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
      if (url.pathname.endsWith('/collection/project/list')) return json([{ kanbanId: '9001', name: 'project' }])
      if (url.pathname.endsWith('/kanbanChildCrud/list')) return json([{ id: '9002', name: '任务', type: 'task' }, { id: '9003', name: '文档', type: 'doc' }])
      if (url.pathname.endsWith('/roadMap/planList')) return json([{ id: options.foreignPlan ?? '9002', name: '任务' }])
      if (url.pathname.endsWith('/roadmap/milestoneTasks')) return json(options.items ?? [{ planId: '9002', taskList: [{ id: 'milestone-uuid', name: '交付', startDate: '2026-11-10', endDate: '2026-11-10', isDone: false, isClose: false }] }])
      throw Error('Unexpected ' + url.pathname)
    } }
  }
  const positive = make(), result = (await run('roadmap milestones get', { collectionId: '7001', projectId: '9001' }, positive.transport)).result
  assert.equal(result.items[0].taskList[0].startDate, '2026-11-10')
  for (const foreignPlan of ['9001', '9003', '9999']) {
    const denied = make({ foreignPlan }); await assert.rejects(run('roadmap milestones get', { collectionId: '7001', projectId: '9001' }, denied.transport), { code: 'CONTEXT_MISMATCH' })
    assert.equal(denied.calls.some(path => path.endsWith('/roadmap/milestoneTasks')), false)
  }
  for (const items of [
    [], [{ planId: '9999', taskList: [] }], [{ planId: '9002', taskList: [] }, { planId: '9002', taskList: [] }],
    [{ planId: '9002', taskList: [{ id: 'same', name: 'a', startDate: '2026-11-10' }, { id: 'same', name: 'b', startDate: '2026-11-10' }] }],
    [{ planId: '9002', taskList: [{ id: 'uuid', name: 'bad-date', startDate: '2026-02-30' }] }],
    [{ planId: '9002', taskList: [{ id: 'uuid', name: 'undated', startDate: null, endDate: null }] }],
  ]) {
    const broken = make({ items }); await assert.rejects(run('roadmap milestones get', { collectionId: '7001', projectId: '9001' }, broken.transport), { code: 'BUSINESS_ASSERTION_FAILED' })
  }
})
test('collection baseline membership stops mismatched IDs and a lost write is never replayed', async () => {
  let requests = 0
  await assert.rejects(run('baseline delete', { collectionId: '7001', baselineId: '8002' }, async (url) => {
    requests++; return json(url.pathname.endsWith('/list') ? [collection] : [{ id: '8001', name: 'baseline' }])
  }, { approved: true }), { code: 'CONTEXT_MISSING' })
  assert.equal(requests, 2)
  requests = 0
  await assert.rejects(run('create', { name: 'fixture' }, async url => { requests++; if (url.pathname === '/task/v1/department/list') return json(directory); throw Error('lost response') }), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.writeOutcome, 'unknown'); return true
  })
  assert.equal(requests, 2)
  const args = prepareProjectCollection('collection-workload-statistics', { collectionId: '7001', statsType: 'taskNum', dateType: 'week' }, { directory }, session)
  assert.deepEqual(args.query, { projectCollectionId: '7001', userIds: userId, statsType: 'taskNum', dateType: 'week' })
})
test('collection membership rejects foreign company users and stale snapshots before a write', async () => {
  for (const suffix of ['create', 'members set']) {
    let writes = 0
    const input = { name: 'fixture', collectionId: '7001', memberIds: '3' }
    if (suffix === 'create') delete input.collectionId
    else delete input.name
    await assert.rejects(run(suffix, input, async (url, init) => {
      if (!['GET', 'HEAD'].includes(init.method)) writes++
      if (url.pathname === '/task/v1/department/list') return json(directory)
      return json(url.pathname.endsWith('/list') ? [collection] : collection)
    }), { code: 'FORBIDDEN' })
    assert.equal(writes, 0)
  }
  let reads = 0, writes = 0
  await assert.rejects(run('members set', { collectionId: '7001', memberIds: '2' }, async (url, init) => {
    if (init.method === 'PUT') writes++
    if (url.pathname === '/task/v1/department/list') return json(directory)
    if (url.pathname.endsWith('/list')) return json([collection])
    reads++; return json(reads === 1 ? collection : { ...collection, members: [...collection.members, { userId: '2', role: 'common' }] })
  }), { code: 'CONTEXT_CONFLICT' })
  assert.equal(writes, 0)
})
test('collection settings clear workload users to the real creator default and verify omitted settings', async () => {
  let writes = 0
  const before = { mode: 'day', workloadUsers: [{ id: '2' }] }
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
    if (url.pathname === '/task/v3/kanbanCollection') return json(collection)
    if (url.pathname === '/task/v1/department/list') return json(directory)
    if (init.method === 'PUT') { writes++; assert.deepEqual(JSON.parse(init.body), { collectionId: '7001', workloadUserIds: '' }); return json({ mode: 'day', workloadUsers: [] }) }
    return json(writes ? { mode: 'day', workloadUsers: [{ id: userId }] } : before)
  }
  const cleared = await run('workload settings update', { collectionId: '7001', patch: { workloadUserIds: '' } }, transport)
  assert.equal(cleared.result.workloadUsers[0].id, userId); assert.equal(writes, 1)
  assert.deepEqual(before, { mode: 'day', workloadUsers: [{ id: '2' }] })
  let count = 0
  await assert.rejects(run('schedule settings update', { collectionId: '7001', patch: { mode: 'week' } }, async (url, init) => {
    if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
    if (init.method === 'PUT') { count++; return json({ mode: 'week', isOpenView: false, isOpenKeyPath: true }) }
    return json({ mode: count ? 'week' : 'month', isOpenView: count === 0, isOpenKeyPath: true })
  }), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(count, 1)
})
test('collection workload refuses unknown company users before statistics or task queries', async () => {
  for (const [suffix, input] of [['workload get', { userIds: '3', statsType: 'taskNum', dateType: 'day' }], ['workload tasks list', { userId: '3', statsType: 'taskNum' }], ['workload settings update', { patch: { workloadUserIds: '3' } }]]) {
    const paths = []
    await assert.rejects(run(suffix, { collectionId: '7001', ...input }, async (url, init) => {
      paths.push(init.method + ' ' + url.pathname)
      if (url.pathname === '/task/v1/department/list') return json(directory)
      if (url.pathname.endsWith('/getSetting')) return json({ mode: 'day', workloadUsers: [{ id: userId }] })
      return json(url.pathname.endsWith('/list') ? [collection] : collection)
    }), { code: 'FORBIDDEN' })
    assert.ok(paths.every(path => path.startsWith('GET ') && !path.includes('/task/api/projectCollection/workload')))
  }
})
test('collection readback protects creator roles and unrelated project associations', () => {
  assert.throws(() => verifyProjectCollection({ collectionId: '7001' }, { prepared: { memberIds: [userId], owner: userId }, verified: { ...collection, members: [{ userId, role: 'common' }] } }, 'verified'), { code: 'CONTEXT_MISSING' })
  assert.throws(() => verifyProjectCollection({ collectionId: '7001' }, { prepared: { expectedProjects: ['9001', '9002'] }, verified: [{ kanbanId: '9001' }] }, 'verified'), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.throws(() => prepareProjectCollection('collection-create', { name: '   ' }, { directory }, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareProjectCollection('collection-members', { collectionId: '7001', memberIds: '2' }, { before: { ...collection, members: [collection.members[0], { userId: '2', role: 'creator' }] }, directory }, session), { code: 'CONTEXT_MISSING' })
})
test('collection progress uses participant-scoped HTTP paging and validates paired sorting before requests', async () => {
  let calls = 0
  const transport = async url => {
    calls++
    if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
    if (url.pathname.endsWith('/listProjectCollectionHeader')) return json({ code: 200, data: [{ id: 'projectName', name: '项目' }] })
    assert.equal(url.searchParams.get('projectCollectionId'), '7001'); assert.equal(url.searchParams.get('pageNum'), '2'); assert.equal(url.searchParams.get('pageSize'), '3')
    assert.equal(url.searchParams.get('sortKey'), 'projectName'); assert.equal(url.searchParams.get('sortValue'), 'desc')
    return json({ code: 200, data: { list: [{ id: '9004', name: 'flow', projectName: 'project' }], total: 4 } })
  }
  await assert.rejects(run('progress list', { collectionId: '7001', sortKey: 'projectName' }, transport), { code: 'INVALID_INPUT' })
  assert.equal(calls, 0)
  const result = await run('progress list', { collectionId: '7001', page: 2, pageSize: 3, sortKey: 'projectName', sortOrder: 'desc' }, transport)
  assert.equal(result.result.page.total, 4); assert.equal(result.result.scope, 'current-user-participating-project-flows'); assert.equal(calls, 3)
})
test('collection movement derives neighbours and reports a conflicting readback without another write', async () => {
  const list = [{ ...collection, displayOrder: 100 }, { id: '7002', name: 'two', displayOrder: 200 }, { id: '7003', name: 'three', displayOrder: 300 }]
  let writes = 0
  const transport = async (_url, init) => {
    if (init.method === 'POST') { writes++; assert.deepEqual(JSON.parse(init.body), { id: '7001', frontId: '7002', nextId: '7003' }); return json({ displayOrder: 250 }) }
    return json(list)
  }
  await assert.rejects(run('move', { collectionId: '7001', targetId: '7002', position: 'after' }, transport), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(writes, 1)
  assert.throws(() => prepareProjectCollection('collection-move', { collectionId: '7001', targetId: '7001', position: 'after' }, { visible: list }, session), { code: 'INVALID_INPUT' })
  assert.throws(() => verifyProjectCollection({ collectionId: '7001' }, { prepared: { order: { frontId: '7002', nextId: '7003' } }, verified: [
    { id: '7002', displayOrder: 200 }, { id: '7004', displayOrder: 225 }, { id: '7001', displayOrder: 250 }, { id: '7003', displayOrder: 300 },
  ] }, 'verified'), { code: 'BUSINESS_ASSERTION_FAILED' })
})
