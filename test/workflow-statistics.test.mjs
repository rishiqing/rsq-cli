import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'

const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.parse('2035-01-01T00:00:00Z') }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const envelope = data => json({ code: 200, data })
const flow = suffix => workflows.workflows.find(row => row.command === 'workflow statistics ' + suffix)
function fixture(options = {}) {
  const calls = [], rows = [{ id: 201, name: '填报', minTime: '0.0秒', maxTime: '-', avgTime: '-', delayRate: '0.0%', oneShotRate: '-' }, { id: '9223372036854775801', name: '审批', minTime: '-', maxTime: '-', avgTime: '-', delayRate: '-', oneShotRate: '-' }]
  const users = [{ id: 81, showName: '同名' }, { id: 82, showName: '同名' }, { id: 83, showName: '孙部门' }]
  const node = (id, type, userList, childList = [], parentId) => ({ id, name: '部门-' + id, type, userList, childList, parentId: parentId ?? null, displayOrder: 1 })
  const directory = [node(7, 'top', [], [node(11, 'common', [users[0]], [node(12, 'common', [users[2]], [], 11)], 7), node(13, 'common', [users[1]], [], 7)])]
  const transport = async (url, init) => {
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method })
    assert.equal(init.method, 'GET')
    switch (url.pathname) {
      case '/task/login/authAjax': return json({ id: options.wrongIdentity ? 82 : 81, username: 'fixture', team: { id: 7, name: '公司' }, success: true, token: 'fixture' })
      case '/task/ordercenter/v2/member/state/independent': return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
      case '/task/ordercenter/v2/function/available': return json(options.disabled ? [{ funcName: 'FLOW_STATISTICS', status: 'disable' }] : [])
      case '/task/authority/v3/authorities/company/current': return json({ useFlow: true })
      case '/task/workflow/application/list': assert.equal(url.searchParams.get('statisticsFrom'), 'workflow'); return envelope(options.foreignApplication ? [] : [{ id: 101, name: '本公司流程', cover: '1' }])
      case '/task/workflow/application': return envelope({ id: 101, name: '本公司流程', editControl: { enterStatistics: !options.denied } })
      case '/task/workflow/step/info/names': assert.equal(url.searchParams.get('isContainAutoStep'), 'false'); return envelope(rows.map(row => ({ id: row.id, name: row.name })))
      case '/task/v1/department/list': return json(directory)
      case '/task/v1/workflow/list':
        if (options.failRange) throw new TypeError('disconnected')
        return json({ rangeRadio: options.all ? 'all' : 'part', adminRadio: 'all', range: options.directOnly ? [users[1]] : [users[1]], rangeDept: options.directOnly ? [] : [{ id: 11, name: '父部门' }], admin: users })
      case '/task/workflow/statistics/indicator': return envelope({ doingCount: 0, finishedCount: 2, delayRate: 0, avgTime: 5000 })
      case '/task/workflow/statistics/efficiency': {
        const pageNum = Number(url.searchParams.get('pageNum')), pageSize = Number(url.searchParams.get('pageSize'))
        return envelope({ list: options.badStep ? [{ ...rows[0], id: 999 }] : options.overfull ? rows : rows.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: 2, pageNum: 2, pageSize })
      }
      case '/task/workflow/statistics/execute': return envelope({ list: [1, 2].map(stepCount => ({ assignee: '同名', stepCount, delayRate: '0.0%', delayDuration: '-', delayCommitRate: '-', delayCommitDuration: '-' })), total: 2, pageNum: 1, pageSize: 50 })
      default: throw Error('Unexpected HTTP: ' + url.pathname)
    }
  }
  return { transport, calls }
}
const run = (suffix, input, f, options = {}) => runWorkflow(ctx, flow(suffix), { applicationId: '101', ...input }, session, { transport: f.transport, ...options })

test('workflow statistics expands explicitly visible departments and retains four unfiltered indicators with actual units', async () => {
  const f = fixture(), value = (await run('context', {}, f)).result
  assert.deepEqual(value.executors.map(row => row.id).sort(), ['81', '82', '83'])
  assert.equal(value.indicators.avgTime, 5000); assert.equal(value.indicators.avgTimeUnit, 'milliseconds'); assert.equal(value.indicators.delayRate, 0)
  assert.equal(value.indicators.filters, 'all-visible-processes-no-date-or-member-filter')
  assert.equal(value.steps[1].id, '9223372036854775801')
  assert.equal(flow('context').effect, 'write')
  assert.equal(catalog.operations.find(op => op.route === '/task/v1/workflow/list').effect, 'write')
})
test('workflow statistics uses requested page separately from service total-page field, real sorting and calendar dates', async () => {
  const f = fixture(), value = (await run('efficiency list', { efficiencyUserId: '81', pageNum: 1, pageSize: 1, sortKey: 'name', sortValue: 'desc', startDate: '2028-02-29', endDate: '2028-02-29' }, f)).result
  assert.equal(value.report.requestedPage, 1); assert.equal(value.report.servicePageNum, 2); assert.equal(value.report.nextPage, 2)
  assert.equal(value.report.rows[0].minTime, '0.0秒'); assert.equal(value.report.rows[0].maxTime, '-')
  assert.equal(value.report.dateBasis, 'process.date_created')
  const query = f.calls.find(call => call.path.endsWith('/efficiency')).query
  assert.deepEqual(query, { applicationId: '101', pageNum: '1', pageSize: '1', sortKey: 'name', sortValue: 'desc', efficiencyUserId: '81', startDate: '2028.02.29', endDate: '2028.02.29' })
  const last = (await run('efficiency list', { pageNum: 2, pageSize: 1 }, fixture())).result
  assert.equal(last.report.nextPage, null); assert.equal(last.report.rows[0].id, '9223372036854775801')
})
test('workflow execution table preserves same-name rows and only sends actual definition step ID', async () => {
  const f = fixture(), value = (await run('execute list', { stepId: '9223372036854775801' }, f)).result
  assert.equal(value.report.rows.length, 2); assert.equal(value.report.rows[0].stepCount, 1); assert.equal(value.report.rows[1].stepCount, 2)
  assert.equal(value.report.rows[0].assigneeUserId, undefined); assert.equal(value.report.dateBasis, 'process_info_step.start_time')
  assert.equal(f.calls.find(call => call.path.endsWith('/execute')).query.stepId, '9223372036854775801')
})
test('workflow filters require visible members and current application steps before statistics HTTP', async () => {
  for (const [input, options] of [[{ efficiencyUserId: '81' }, { directOnly: true }], [{ efficiencyUserId: '999' }, {}], [{ stepId: '999' }, {}]]) {
    const f = fixture(options)
    await assert.rejects(run(input.stepId ? 'execute list' : 'efficiency list', input, f), { code: 'FORBIDDEN' })
    assert.ok(!f.calls.some(call => call.path.includes('/statistics/')))
  }
  const value = (await run('context', {}, fixture({ directOnly: true }))).result
  assert.deepEqual(value.executors.map(row => row.id), ['82'])
})
test('workflow statistics blocks wrong identity, foreign application and actual enterStatistics denial before data', async () => {
  for (const [options, code] of [[{ wrongIdentity: true }, 'IDENTITY_CHANGED'], [{ foreignApplication: true }, 'FORBIDDEN'], [{ denied: true }, 'FORBIDDEN']]) {
    const f = fixture(options)
    await assert.rejects(run('context', {}, f), { code })
    assert.ok(!f.calls.some(call => call.path.includes('/statistics/') || call.path.endsWith('/info/names')))
    if (options.foreignApplication) assert.ok(!f.calls.some(call => call.path === '/task/workflow/application'))
  }
})
test('workflow statistics rejects invalid date and sort pairs entirely offline, including dry-run', async () => {
  for (const input of [{ startDate: '2026-02-29', endDate: '2026-03-01' }, { startDate: '2026-01-01' }, { startDate: '2026-03-01', endDate: '2026-02-28' }, { sortKey: 'name' }]) {
    const f = fixture()
    await assert.rejects(run('efficiency list', input, f, { dryRun: true }), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  }
  const f = fixture(); await run('efficiency list', { efficiencyUserId: '81' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
})
test('workflow statistics never replays a member-sync GET after network failure and preserves completed steps', async () => {
  const f = fixture({ failRange: true })
  await assert.rejects(run('context', {}, f), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.failedStep, 'range'); assert.equal(error.details.writeOutcome, 'unknown')
    assert.ok(error.details.completedSteps.includes('source')); return true
  })
  assert.equal(f.calls.filter(call => call.path === '/task/v1/workflow/list').length, 1)
})
test('workflow statistics refuses rows from another application and invalid pagination rather than inventing a total', async () => {
  for (const options of [{ badStep: true }, { overfull: true }]) await assert.rejects(run('efficiency list', { pageSize: 1 }, fixture(options)), { code: 'CONTEXT_MISSING' })
})
test('workflow statistics public dispatch enforces expiry, over-capacity and feature gates before application requests', async () => {
  for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY'], [{ disabled: true }, 'FEATURE_DISABLED']]) {
    const f = fixture(options)
    await assert.rejects(executeWorkflow(ctx, flow('context'), { applicationId: '101' }, session, { transport: f.transport }), { code })
    assert.ok(!f.calls.some(call => call.path.startsWith('/task/workflow/')))
  }
  const f = fixture()
  await assert.rejects(executeOperation(ctx, catalog.operations.find(op => op.route === '/task/workflow/statistics/indicator'), { query: { applicationId: '101' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.equal(f.calls.length, 0)
})
