import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { catalog } from '../dist/operations.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
import { businessScope } from '../dist/business.js'
import { RsqError } from '../dist/core.js'
import { executeOperation } from '../dist/dispatch.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const tree = [{ id: 7, name: 'Fixture', parentId: null, displayOrder: 1, type: 'top', userList: [{ id: 1 }], childList: [] }]
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const run = (suffix, input, transport, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === 'cooperation ' + suffix), input, session, { transport, ...options })
test('cooperation four task lists use the current contracts and explicitly disclose preference writes', async () => {
  assert.deepEqual(auditWorkflows(workflows, catalog, businessScope), [])
  for (const [name, route] of [['executing', 'members'], ['participating', 'participants'], ['created', 'creator'], ['approvals', 'approvals']]) {
    const flow = workflows.workflows.find(flow => flow.command === 'cooperation tasks ' + name + ' list')
    assert.equal(flow.effect, 'write')
    const transport = async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(url.pathname, '/task/api/v3/cooperation/' + route)
      assert.equal(url.searchParams.get(route === 'approvals' ? 'approved' : 'finish'), '0')
      assert.equal(url.searchParams.has(route === 'approvals' ? 'finish' : 'approved'), false)
      assert.equal(url.searchParams.get('sort'), 'createLatest'); assert.equal(url.searchParams.get('max'), '20')
      assert.equal(url.searchParams.get('startId'), '90071992547409931234')
      return json([{ id: '90071992547409931233', name: 'Fixture' }])
    }
    const out = await run('tasks ' + name + ' list', { cursor: '90071992547409931234' }, transport)
    assert.equal(out.result.nextCursor, '90071992547409931233'); assert.equal(out.result.completeness, 'single-page')
    assert.deepEqual(out.result.sideEffects, ['personal-view-filter-preference-saved'])
  }
})
test('cooperation approval status follows current domain semantics and rejects obsolete inbox filters', async () => {
  for (const [status, expected] of [['unreviewed', '1'], ['reviewed', '2']]) await run('tasks approvals list', { status }, async url => { assert.equal(url.searchParams.get('approved'), expected); return json([]) })
  await assert.rejects(run('tasks approvals list', { status: 'inbox' }, () => { throw Error('No request') }), { code: 'INVALID_INPUT' })
  await assert.rejects(run('tasks executing list', { cursor: 'same' }, async () => json([{ id: 'same' }])), { code: 'RESPONSE_SCHEMA_MISMATCH' })
})
function workflowService(features = [], permissions = {}) {
  const calls = []
  return { calls, transport: async (url, init) => {
    calls.push({ url, init })
    if (url.pathname === '/task/ordercenter/v2/member/state/independent') return json({ vt: 'basic', deadLine: '2100-01-01 00:00:00', usersCount: 1, userLimit: 10, mainApp: 'independent' })
    if (url.pathname === '/task/ordercenter/v2/function/available') return json(features)
    if (url.pathname === '/task/authority/v3/authorities/company/current') return json(permissions)
    if (url.pathname === '/task/v1/department/list') return json(tree)
    if (url.pathname === '/task/workflow/process/info/task/list') {
      const body = JSON.parse(init.body); assert.equal(body.from, 'cooperation'); assert.equal(body.todoUserId, undefined)
      return json({ code: 200, data: { applicationTypes: [{ id: 31, name: 'Fixture' }], pageInfo: { list: [], total: 0, pageNum: body.pageNum, pageSize: body.pageSize } } })
    }
    throw Error('Unexpected route ' + url.pathname)
  } }
}
test('cooperation workflows permit standalone or embedded flows and stop when neither is available', async () => {
  const embedded = workflowService([{ funcName: 'WORKFLOW', status: 'disable' }, { funcName: 'PLAN', status: 'enable' }, { funcName: 'PLAN_WORKFLOW', status: 'enable' }], { useKanban: true })
  const out = await run('workflow context', { queue: 'participant' }, embedded.transport)
  assert.equal(out.result.context.includesProjectWorkflows, true); assert.equal(out.result.queue, 'participant'); assert.equal(out.result.members[0].id, '1')
  const disabled = workflowService([{ funcName: 'WORKFLOW', status: 'disable' }, { funcName: 'PLAN_WORKFLOW', status: 'disable' }])
  await assert.rejects(run('workflow list', {}, disabled.transport), { code: 'FEATURE_DISABLED' }); assert.equal(disabled.calls.length, 4)
  const malformed = workflowService(null)
  await assert.rejects(run('workflow list', {}, malformed.transport), { code: 'RESPONSE_SCHEMA_MISMATCH' })
})
test('cooperation workflow filters use discovered applications and actual company users with fixed self queue', async () => {
  const mock = workflowService()
  const out = await run('workflow list', { queue: 'finished', applicationIds: ['31'], userIds: ['1'], pageNum: 2, pageSize: 3, operate: 'passed', sortKey: 'name', sortValue: 'asc' }, mock.transport)
  const body = JSON.parse(mock.calls.at(-1).init.body)
  assert.equal(body.typeIds, '31'); assert.equal(body.userIds, '1'); assert.equal(body.pageNum, 2); assert.equal(body.from, 'cooperation'); assert.equal(out.result.page.pageSize, 3)
  for (const [input, code] of [[{ applicationIds: ['999'] }, 'FORBIDDEN'], [{ userIds: ['999'] }, 'FORBIDDEN'], [{ queue: 'my', operate: 'todo' }, 'INVALID_INPUT'], [{ queue: 'finished', operate: 'pending' }, 'INVALID_INPUT']]) {
    const invalid = workflowService(); await assert.rejects(run('workflow list', input, invalid.transport), { code }); assert.equal(invalid.calls.length, 5)
  }
})
test('raw workflow queue cannot impersonate another person by supplying statistics todoUserId', async () => {
  const op = catalog.operations.find(op => op.route === '/task/workflow/process/info/task/list' && op.method === 'POST')
  await assert.rejects(executeOperation(ctx, op, { body: { todoType: 'pending', from: 'cooperation', todoUserId: '999' } }, session, { transport: () => { throw Error('No request') } }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
test('cooperation preference-writing GET is not replayed after transport failure and dry-run stays offline', async () => {
  let calls = 0
  await assert.rejects(run('tasks executing list', {}, async () => { calls++; throw new RsqError('NETWORK_ERROR', 'connection lost') }), error => error.details?.writeOutcome === 'unknown')
  assert.equal(calls, 1)
  const out = await run('tasks executing list', {}, () => { throw Error('No request') }, { dryRun: true }); assert.equal(out.dryRun, true)
})
