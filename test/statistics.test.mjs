import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { catalog, runOperation } from '../dist/operations.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
import { businessScope } from '../dist/business.js'

const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture-token', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, options = {}) => runWorkflow(ctx, workflows.workflows.find(f => f.command === command), input, session, { transport, ...options })
const base = '/task/v5/kanban/stats/chart'

test('creating custom charts supplies the UI sort default and checks the persisted sort without replay', async () => {
  const flow = workflows.workflows.find(f => f.command === 'statistics project chart create')
  assert.equal(flow.inputSchema.properties.sort.default, 'valueDefault')
  for (const creationType of ['custom', 'customDatasheet']) for (const sort of [undefined, 'valueDesc']) {
    const input = { dashboardId: 'dash-1', name: 'current chart', creationType, chartType: 'number',
      dataSource: { projectId: '7001', isAll: true, list: [] }, position: { x: 0, y: 0, w: 6, h: 4 }, ...(sort === undefined ? {} : { sort }) }
    let stored, writes = 0, reads = 0, corrupt = false
    const transport = async (url, init) => {
      assert.equal(url.pathname, base)
      if (init.method === 'POST') {
        writes++; stored = JSON.parse(init.body); assert.equal(stored.sort, sort ?? 'valueDefault')
        return json({ id: 'chart-1', ...stored })
      }
      reads++; assert.equal(url.searchParams.get('id'), 'chart-1')
      // Independent persistent-read shape, including unrelated server fields.
      return json({ id: 'chart-1', name: input.name, creationType, sort: corrupt ? 'valueAsc' : sort ?? 'valueDefault', graphData: { dataList: [] } })
    }
    assert.equal((await run(flow.command, input, transport)).result.sort, sort ?? 'valueDefault')
    corrupt = true
    await assert.rejects(run(flow.command, input, transport), error => {
      assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.details.resources.chartId, 'chart-1')
      assert.equal(error.details.failedStep, 'verified'); return true
    })
    assert.equal(writes, 2); assert.equal(reads, 2)
  }
})

test('raw custom chart transport requires a non-null sort while the business command accepts omission', async () => {
  const operation = catalog.operations.find(o => o.route === base && o.method === 'POST')
  let sent = 0
  const transport = async () => { sent++; return json({}) }
  for (const creationType of ['custom', 'customDatasheet']) for (const sort of [undefined, null]) {
    const input = { dashboardId: 'dash-1', name: 'current chart', creationType,
      dataSource: { projectId: '7001', isAll: true, list: [] }, position: { x: 0, y: 0, w: 6, h: 4 }, ...(sort === undefined ? {} : { sort }) }
    await assert.rejects(runOperation(ctx, operation, { body: input }, session, { transport }), { code: 'INVALID_INPUT' })
    if (sort === null) await assert.rejects(run('statistics project chart create', input, transport), { code: 'INVALID_INPUT' })
  }
  assert.equal(sent, 0)
})

test('statistics commands expose read PUTs, discovery side effects, and consistent workflow contracts', async () => {
  assert.deepEqual(auditWorkflows(workflows, catalog, businessScope), [])
  for (const route of ['/task/v4/kanban/statistics/open', '/task/v4/kanban/statistics/close']) assert.equal(catalog.operations.find(o => o.route === route).review, 'reviewed')
  assert.equal(workflows.workflows.find(f => f.command === 'statistics company person analyze').effect, 'read')
  assert.equal(workflows.workflows.find(f => f.command === 'statistics project dashboards list').effect, 'write')
  let sent = 0
  await assert.rejects(run('statistics company person analyze', { max: 101 }, async () => { sent++; return json({}) }), { code: 'INVALID_INPUT' })
  await assert.rejects(run('statistics company person analyze', { max: 20, startDate: '11/07/2026' }, async () => { sent++; return json({}) }), { code: 'INVALID_INPUT' })
  await assert.rejects(run('statistics project dashboards list', { kanbanChildId: '1', projectCollectionId: '2' }, async () => { sent++; return json([]) }), { code: 'INVALID_INPUT' })
  assert.equal(sent, 0)
})

test('custom chart patches preserve dimensions, metrics, filters and sorting in the full HTTP request', async () => {
  // Independently shaped like ChartVOConverter output, including nullable
  // nested owner/group fields. The write implementation replaces collections.
  let chart = { id: 'chart-1', name: 'before', creationType: 'custom', chartType: 'bar', chartStyle: 'grouped', isInternal: false,
    dataSource: { type: 'task', projectId: 7001, projectCollectionId: null, isAll: true, list: [] },
    dimension: { category: [{ type: 'member', fieldId: null, dateFormat: null }], group: null },
    statsValue: [{ name: '任务量', valueType: 'taskNum', calType: 'count', fieldId: null, filter: null, group: null, color: 1 }],
    filter: { conjunction: 'and', conditions: [] }, sort: 'valueDesc', sortList: [{ id: 'member', name: '执行人' }], isCumulative: false }
  const saved = structuredClone(chart), calls = []
  const transport = async (url, init) => {
    calls.push(init.method); assert.equal(url.pathname, base)
    if (init.method === 'GET') return json(chart)
    const body = JSON.parse(init.body)
    assert.equal(body.id, 'chart-1'); assert.equal(body.name, 'after')
    assert.deepEqual(body.dimension, saved.dimension); assert.deepEqual(body.statsValue, saved.statsValue)
    assert.deepEqual(body.filter, saved.filter); assert.deepEqual(body.sortList, saved.sortList)
    assert.equal(body.dataSource.projectCollectionId, undefined)
    chart = { ...body, dataSource: { ...body.dataSource, projectCollectionId: null } }
    return json(chart)
  }
  const changed = await run('statistics project chart update', { id: 'chart-1', patch: { name: 'after' } }, transport)
  assert.equal(changed.result.name, 'after'); assert.deepEqual(calls, ['GET', 'PUT', 'GET'])
  assert.deepEqual(changed.resources, { chartId: 'chart-1' })
})

test('chart layouts reject foreign/duplicate charts and verify positions after one write', async () => {
  let charts = [{ id: 'chart-1', name: 'own', position: { x: 0, y: 0, w: 6, h: 4 } }], calls = []
  const transport = async (url, init) => {
    calls.push(init.method)
    if (init.method === 'GET') { assert.equal(url.searchParams.get('dashboardId'), 'dashboard-1'); return json(charts) }
    assert.equal(url.pathname, base + '/position')
    const body = JSON.parse(init.body); assert.equal(body.dashboardId, 'dashboard-1')
    charts = body.positionArray.map(({ i, ...position }) => ({ id: i, name: 'own', position }))
    return new Response('')
  }
  const position = { i: 'chart-1', x: 6, y: 0, w: 6, h: 4 }
  for (const [positions, code] of [[[{ ...position, i: 'foreign' }], 'CONTEXT_MISMATCH'], [[position, position], 'INVALID_INPUT']]) {
    calls = []; await assert.rejects(run('statistics project chart layout update', { dashboardId: 'dashboard-1', positions }, transport), { code }); assert.deepEqual(calls, ['GET'])
  }
  calls = []
  const changed = await run('statistics project chart layout update', { dashboardId: 'dashboard-1', positions: [position] }, transport)
  assert.deepEqual(changed.result[0].position, { x: 6, y: 0, w: 6, h: 4 }); assert.deepEqual(calls, ['GET', 'PUT', 'GET'])
})

test('dashboard updates require scope membership, preserve false/empty patches, and assert readback', async () => {
  let dashboards = [{ id: 'dash-1', name: 'before', theme: 'default', isDefault: true }], calls = []
  const transport = async (_url, init) => {
    calls.push(init.method)
    if (init.method === 'GET') return json(dashboards)
    assert.equal(init.method, 'PUT'); const body = JSON.parse(init.body); assert.equal(body.isDefault, false)
    dashboards[0] = { ...dashboards[0], ...body }; return json(dashboards[0])
  }
  await assert.rejects(run('statistics project dashboard update', { kanbanChildId: '7', id: 'foreign', patch: { name: 'after' } }, transport), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.deepEqual(calls, ['GET']); calls = []
  const updated = await run('statistics project dashboard update', { kanbanChildId: '7', id: 'dash-1', patch: { name: 'after', isDefault: false } }, transport)
  assert.equal(updated.result.name, 'after'); assert.equal(updated.result.isDefault, false); assert.deepEqual(calls, ['GET', 'PUT', 'GET'])
})

test('statistics unknown writes and unsuccessful readbacks report partial progress without replay', async () => {
  let requests = 0
  await assert.rejects(run('statistics project dashboard create', { kanbanChildId: '7', name: 'created' }, async (_url, init) => {
    requests++
    if (init.method === 'POST') return json({ id: 'dash-1', name: 'created' })
    return json([])
  }), error => {
    assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.details.resources.dashboardId, 'dash-1')
    assert.deepEqual(error.details.completedSteps, ['created', 'verified']); return true
  })
  assert.equal(requests, 2)
  requests = 0
  await assert.rejects(run('statistics project dashboard create', { kanbanChildId: '7', name: 'created' }, async () => { requests++; throw Error('fixture-token') }), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.writeOutcome, 'unknown'); return true
  })
  assert.equal(requests, 1)
  requests = 0
  await assert.rejects(run('statistics project dashboard create', { kanbanChildId: '7', name: 'created' }, async () => { requests++; return new Response('upstream failed', { status: 500 }) }), error => {
    assert.equal(error.code, 'HTTP_ERROR'); assert.equal(error.details.writeOutcome, 'unknown'); return true
  })
  assert.equal(requests, 1)
})

test('nested Grails numeric owners use exact JSON integer tokens without changing text fields', async () => {
  const op = catalog.operations.find(o => o.route === base && o.method === 'POST')
  let sent = 0
  const input = { body: { dashboardId: 'dash-1', name: '9007199254740993', creationType: 'taskCompletion', dataSource: { projectId: '9007199254740993', isAll: true, list: [] }, position: { x: 0, y: 0, w: 6, h: 4 } } }
  const transport = async (_url, init) => {
    sent++; assert.ok(init.body.includes('"projectId":9007199254740993')); assert.ok(init.body.includes('"name":"9007199254740993"'))
    return json({ id: 'chart-1', name: '9007199254740993' })
  }
  await runOperation(ctx, op, input, session, { transport })
  const tooLarge = structuredClone(input); tooLarge.body.dataSource.projectId = '9223372036854775808'
  await assert.rejects(runOperation(ctx, op, tooLarge, session, { transport }), { code: 'INVALID_INPUT' })
  assert.equal(sent, 1)
})
