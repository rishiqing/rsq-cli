import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { catalog } from '../dist/operations.js'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
import { businessScope } from '../dist/business.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const tree = [{ id: 7, name: 'Fixture', parentId: null, displayOrder: 1, type: 'top', userList: [{ id: 1 }], childList: [] }]
const cycles = { currentCycleList: [{ id: 11 }], futureCycleList: [], pastCycleList: [] }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
function service({ report = { data: [{ id: 1, type: 'person', number: 1 }], ext: { pageNum: 1, pageSize: 20, total: 1 } }, analysis = { list: [{ userInfo: { id: 1 }, stepCount: { value: 1, detailId: 'fresh-only' } }], total: 1, pageNum: 1, pageSize: 20 } } = {}) {
  const calls = []
  return { calls, transport: async (url, init) => {
    calls.push({ url, init }); const path = url.pathname
    if (path === '/task/v1/department/list') return json(tree)
    if (path === '/task/v1/staffGroupCrud/list') return json([{ id: 21, name: 'Fixture', displayOrder: 1, userCount: 0, users: [] }])
    if (path === '/task/workflow/application/list') { assert.equal(url.searchParams.get('statisticsFrom'), 'team'); return json({ code: 200, data: [{ id: 31, name: 'Fixture' }] }) }
    if (path === '/task/workflow/teamStatistics/execute') return json(analysis)
    if (path === '/task/workflow/teamStatistics/executeDetail') { assert.equal(url.searchParams.get('id'), 'fresh-only'); assert.equal(url.searchParams.get('statisticsFrom'), 'team'); return json({}) }
    if (path === '/task/workflow/teamStatistics/totalInfo') { assert.equal(url.searchParams.get('id'), 'fresh-only'); assert.equal(url.searchParams.get('statisticsFrom'), 'team'); return json({ noAuthNum: '0' }) }
    if (path === '/task/okr/cycle/list') return json(cycles)
    if (path === '/task/okr/statistics/reportForms') return json({ code: 200, msg: 'ok', ...report })
    if (path === '/task/okr/statistics/reportForms/item') return json({ code: 200, msg: 'ok', data: [], ext: {} })
    throw Error('Unexpected route ' + path)
  } }
}
const run = (suffix, input, mock, identity = session) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === 'statistics company ' + suffix), input, identity, { transport: mock.transport })
test('company OKR and workflow commands expose distinct module entitlements and validated adapters', () => {
  assert.deepEqual(auditWorkflows(workflows, catalog, businessScope), [])
  for (const [suffix, names] of [['okr people analyze', ['TEAM_STATISTICS', 'OKR']], ['workflow people analyze', ['TEAM_STATISTICS', 'WORKFLOW']]]) {
    const flow = workflows.workflows.find(flow => flow.command === 'statistics company ' + suffix)
    for (const name of names) assert.ok(workflowSchema(flow).access.features.includes(name))
    assert.equal(flow.effect, 'read')
  }
})
test('company workflow analysis validates all selected company resources before the HTTP query', async () => {
  for (const filter of ['userIds', 'deptIds', 'groupIds', 'applicationIds']) {
    const mock = service()
    await assert.rejects(run('workflow people analyze', { [filter]: ['999'] }, mock), { code: 'FORBIDDEN' })
    assert.equal(mock.calls.length, 3)
  }
  for (const input of [{ startDate: '2026-01-01' }, { startDate: '2026-02-30', endDate: '2026-03-01' }, { startDate: '2026-03-01', endDate: '2026-02-01' }, { sortKey: 'stepCount' }]) {
    const mock = service(); await assert.rejects(run('workflow people analyze', input, mock), { code: 'INVALID_INPUT' }); assert.equal(mock.calls.length, 3)
  }
  const mock = service()
  const out = await run('workflow people analyze', { userIds: ['1'], deptIds: ['7'], groupIds: ['21'], applicationIds: ['31'], pageNum: 2, pageSize: 3, startDate: '2026-01-01', endDate: '2026-12-31', sortKey: 'stepCount', sortValue: 'desc' }, mock)
  const query = mock.calls.at(-1).url.searchParams
  assert.equal(query.get('statisticsFrom'), 'team'); assert.equal(query.get('userIds'), '1'); assert.equal(query.get('applicationIds'), '31'); assert.equal(query.get('pageNum'), '2')
  assert.equal(out.result.requestedPage, 2); assert.equal(out.result.page.pageNum, 1)
})
test('workflow drilldown obtains a fresh detail ID from the selected actual row and metric', async () => {
  const mock = service(), out = await run('workflow tasks list', { userId: '1', metric: 'stepCount' }, mock)
  assert.equal(mock.calls.length, 6); assert.equal(out.result.permissions.noAuthNum, '0')
  for (const input of [{ userId: '2', metric: 'stepCount' }, { userId: '1', metric: 'finishedStepCount' }]) {
    const missing = service(); await assert.rejects(run('workflow tasks list', input, missing), { code: 'CONTEXT_MISSING' }); assert.equal(missing.calls.length, 4)
  }
})
test('company OKR report keeps one-based pagination and requires an actual company cycle and department', async () => {
  const mock = service(), out = await run('okr people analyze', { cycleId: '11', deptId: '7', pageNum: 2, pageSize: 3 }, mock)
  const query = mock.calls.at(-1).url.searchParams
  assert.equal(query.get('objectiveType'), 'person'); assert.equal(query.get('deptId'), '7'); assert.equal(query.get('pageNum'), '2'); assert.equal(out.result.ext.total, 1)
  for (const [input, code] of [[{ cycleId: '99' }, 'CONTEXT_MISSING'], [{ cycleId: '11', deptId: '99' }, 'FORBIDDEN']]) {
    const missing = service(); await assert.rejects(run('okr people analyze', input, missing), { code }); assert.equal(missing.calls.length, 2)
  }
})
test('company OKR drilldown discovers exact rows including nested departments and carries the selected metric', async () => {
  const mock = service({ report: { data: [{ id: 7, type: 'dept', children: [{ id: 8, type: 'dept' }] }], ext: {} } })
  await run('okr departments details list', { cycleId: '11', rowId: '8', metric: 'align', deptType: 'deptAndChildDept', detailName: 'Fixture' }, mock)
  const query = mock.calls.at(-1).url.searchParams
  assert.equal(query.get('objectiveTypeDataId'), '8'); assert.equal(query.get('id'), 'report_objAlignNum'); assert.equal(query.get('name'), 'Fixture'); assert.equal(query.get('deptType'), 'deptAndChildDept')
  const missing = service()
  await assert.rejects(run('okr people details list', { cycleId: '11', rowId: '999', metric: 'number' }, missing), { code: 'CONTEXT_MISSING' }); assert.equal(missing.calls.length, 3)
})
test('company OKR report rows may have null or omitted type from the actual converter; explicit mismatches and guessed rows fail', async () => {
  for (const type of [null, undefined]) {
    const mock = service({ report: { data: [{ id: 7, type, children: [{ id: 8, type }] }], ext: {} } })
    await run('okr departments details list', { cycleId: '11', rowId: '8', metric: 'number' }, mock)
    const query = mock.calls.at(-1).url.searchParams
    assert.equal(query.get('objectiveType'), 'dept'); assert.equal(query.get('objectiveTypeDataId'), '8')
  }
  for (const report of [{ data: [{ id: 7, type: 'person' }], ext: {} }, { data: [{ id: 8, type: null }], ext: {} }]) {
    const mock = service({ report }); await assert.rejects(run('okr departments details list', { cycleId: '11', rowId: '7', metric: 'number' }, mock), { code: 'CONTEXT_MISSING' }); assert.equal(mock.calls.length, 3)
  }
})
test('company OKR uses the WeCom client header only for the actual WeCom identity', async () => {
  for (const [userFrom, expected] of [['qywx', 'qywx'], ['dingtalk', null]]) {
    const mock = service(); await run('okr people analyze', { cycleId: '11', name: 'Fixture' }, mock, { ...session, identity: { ...session.identity, userFrom } })
    assert.equal(mock.calls.at(-1).init.headers.get('client'), expected)
  }
})
test('company statistics offline dry-run lists context steps and sends no requests', async () => {
  const flow = workflows.workflows.find(flow => flow.command === 'statistics company workflow tasks list')
  const out = await runWorkflow(ctx, flow, { userId: '1', metric: 'stepCount' }, null, { dryRun: true, transport: () => { throw Error('Offline request') } })
  assert.equal(out.dryRun, true); assert.equal(out.steps.length, 6); assert.equal(out.steps.find(s => s.id === 'details').context, 'build-from-fetched-context')
})

test('company statistics masks backend-hidden rows and refuses their drilldown before HTTP', async () => {
  const report = { data: [{ id: 1, type: 'person', name: 'hidden-customer-name', editControl: { view: false }, children: [{ id: 2, name: 'hidden-child' }] }], ext: { pageNum: 1, pageSize: 20, total: 1 } }
  const mock = service({ report }), result = await run('okr people analyze', { cycleId: '11' }, mock)
  assert.deepEqual(result.result.data, [{ hidden: true, reason: 'view-permission-denied' }]); assert.ok(!JSON.stringify(result).includes('hidden-customer-name'))
  const denied = service({ report }); await assert.rejects(run('okr people details list', { cycleId: '11', rowId: '1', metric: 'number' }, denied), { code: 'FORBIDDEN' }); assert.ok(!denied.calls.some(row => row.url.pathname.endsWith('/item')))
})
