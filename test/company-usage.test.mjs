import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows, workflowSchema } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { accessPlan } from '../dist/access.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801', deptId = '9223372036854775802'
const session = { version: 1, method: 'password', identity: { userId, teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value)), definition = suffix => workflows.workflows.find(flow => flow.command === 'statistics company usage ' + suffix)
const row = extra => ({ userId, name: 'member', loginCount: 2, taskCreatedCount: 0, taskFinishedCount: 1, noteCreatedCount: 0, departmentList: [{ id: deptId, name: 'dept', token: 'must-not-output' }], token: 'must-not-output', ...extra })
function fixture() {
  const model = { calls: [], result: { totalPage: 2, data: [row()] }, user: { id: userId, username: 'fixture', token: 'must-not-output', team: { id: '7', name: 'company' } }, state: { vt: 'fixture', mainApp: 'TEAM', deadLine: '2099-01-01 23:59:59', usersCount: 1, userLimit: 5 }, features: [{ funcName: 'TEAM_STATISTICS', status: 'disable' }], permissions: { viewTeamStatistics: true }, tree: [{ id: '70', type: 'top', name: 'company', parentId: null, displayOrder: 0, userList: [], childList: [{ id: deptId, type: 'common', name: 'dept', parentId: '70', displayOrder: 1, userList: [{ id: userId, name: 'member', token: 'must-not-output', avatar: 'must-not-output' }], childList: [] }] }] }
  model.user.success = true
  model.transport = async (url, init) => {
    const call = { path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams) }; model.calls.push(call)
    if (model.hook) { const value = await model.hook(call); if (value) return value }
    if (call.path.endsWith('/authAjax')) return json(model.user)
    if (call.path.endsWith('/member/state/independent')) return json(model.state)
    if (call.path.endsWith('/function/available')) return json(model.features)
    if (call.path.endsWith('/authorities/company/current')) return json(model.permissions)
    if (call.path.endsWith('/department/list')) return json(model.tree)
    if (call.path.endsWith('/useStatistical')) return json(model.result)
    throw Error('Unexpected usage HTTP ' + call.path)
  }
  return model
}
const run = (suffix, input, model) => runWorkflow(ctx, definition(suffix), input, session, { transport: model.transport })
const reads = model => model.calls.filter(call => call.path.endsWith('/useStatistical'))
test('company usage context distinguishes management permission from enterprise analysis feature and removes private fields', async () => {
  const model = fixture(), flow = definition('context'), plan = accessPlan(flow)
  assert.deepEqual(plan.features, []); assert.deepEqual(plan.permissions, ['viewTeamStatistics'])
  const result = await executeWorkflow(ctx, flow, {}, session, { transport: model.transport })
  assert.equal(result.result.people[0].id, userId); assert.equal(result.result.departments[1].id, deptId)
  assert.equal(result.result.filterSemantics.combination, 'union-of-members-and-direct-department-members'); assert.equal(result.result.filterSemantics.descendants, 'not-expanded')
  assert.doesNotMatch(JSON.stringify(result), /must-not-output/); assert.equal(reads(model).length, 0)
  assert.deepEqual(workflowSchema(definition('list')).access.permissions, ['viewTeamStatistics'])
})
test('company usage uses exact dated query, union filter IDs, real sorting and page counts without fake totals', async () => {
  const model = fixture(), result = await run('list', { startDate: '2024-02-29', endDate: '2024-03-01', page: 1, pageSize: 1, sortBy: 'noteCreatedCount', direction: 'asc', userIds: [userId], departmentIds: [deptId] }, model)
  assert.deepEqual(reads(model)[0].query, { pageIndex: '1', pageSize: '1', sort: 'noteCreatedCount_asc', startDate: '2024.02.29', endDate: '2024.03.01', filterUserIds: userId, filterDepartmentIds: deptId })
  assert.equal(result.result.items[0].userId, userId); assert.equal(result.result.items[0].taskCreatedCount, 0)
  assert.deepEqual(result.result.pagination, { kind: 'page', page: 1, pageSize: 1, reportedPages: 2, total: null, next: 2 })
  assert.equal(result.result.dateBoundaries, 'server-between-start-and-day-after-end-inclusive'); assert.doesNotMatch(JSON.stringify(result), /must-not-output/)
  const numeric = fixture(); numeric.tree[0].childList[0].userList.push({ id: 22, name: 'numeric-id-member' })
  assert.equal((await run('context', {}, numeric)).result.people[1].id, '22')
  await run('list', { userIds: ['22'] }, numeric); assert.equal(reads(numeric)[0].query.filterUserIds, '22')
})
test('default and 30 day usage ranges include Shanghai today across month and UTC date boundaries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T16:30:00Z') })
  for (const [input, start] of [[{}, '2026.10.26'], [{ days: 30 }, '2026.10.03']]) {
    const model = fixture(); await run('list', input, model)
    assert.equal(reads(model)[0].query.startDate, start); assert.equal(reads(model)[0].query.endDate, '2026.11.01'); assert.equal(reads(model)[0].query.sort, 'loginCount_desc')
  }
})
test('invalid dates, ambiguous periods and cross-company filters stop before the statistics query', async () => {
  for (const input of [{ startDate: '2025-02-29', endDate: '2025-03-01' }, { startDate: '2024-02-01' }, { startDate: '2024-03-02', endDate: '2024-03-01' }, { days: 7, startDate: '2024-01-01', endDate: '2024-01-02' }, { userIds: ['999'] }, { departmentIds: ['999'] }, { userIds: [] }, { departmentIds: [deptId, deptId] }]) {
    const model = fixture(); await assert.rejects(run('list', input, model), error => ['INVALID_INPUT', 'FORBIDDEN'].includes(error.code)); assert.equal(reads(model).length, 0)
  }
})
test('missing server member IDs remain null, names are not matched, and empty pages retain unknown totals', async () => {
  const model = fixture(); model.result = { totalPage: 1, data: [row({ userId: null, name: 'duplicate-display-name' })] }
  const sorted = await run('list', { sortBy: 'taskCreatedCount' }, model)
  assert.equal(sorted.result.items[0].userId, null); assert.ok(sorted.result.warnings.includes('server-omitted-userId-for-sorted-rows-do-not-infer-from-display-name'))
  model.result = { totalPage: 0, data: [] }
  const empty = await run('list', { page: 10 }, model); assert.equal(empty.result.pagination.next, null); assert.equal(empty.result.pagination.total, null); assert.equal(empty.result.pagination.reportedPages, 0)
})
test('invalid response counts, IDs, duplicate members and oversized pages are not synthesized into success', async () => {
  for (const data of [[row({ loginCount: -1 })], [row({ userId: 1.5 })], [row(), row()], [row({ departmentList: [{ id: deptId }] })], [row({ taskFinishedCount: null })]]) {
    const model = fixture(); model.result.data = data
    await assert.rejects(run('list', { pageSize: 1 }, model), error => ['CONTEXT_MISSING', 'RESPONSE_SCHEMA_MISMATCH'].includes(error.code)); assert.equal(reads(model).length, 1)
  }
  const lossless = fixture(); lossless.hook = call => call.path.endsWith('/useStatistical') ? new Response(JSON.stringify(lossless.result).replace('"userId":"' + userId + '"', '"userId":' + userId)) : undefined
  assert.equal((await run('list', {}, lossless)).result.items[0].userId, userId)
})
test('usage public dispatch enforces current permission, expiry and overcapacity without requiring the unrelated analysis feature', async () => {
  for (const mode of ['permission', 'expired', 'overcapacity']) {
    const model = fixture()
    if (mode === 'permission') model.permissions.viewTeamStatistics = false
    if (mode === 'expired') model.state.deadLine = '2000-01-01 00:00:00'
    if (mode === 'overcapacity') model.state.usersCount = 6
    await assert.rejects(executeWorkflow(ctx, definition('list'), {}, session, { transport: model.transport }), error => ['FEATURE_FORBIDDEN', 'COMPANY_EXPIRED', 'COMPANY_OVER_CAPACITY'].includes(error.code)); assert.equal(reads(model).length, 0)
  }
  const allowed = fixture(); assert.equal((await executeWorkflow(ctx, definition('list'), {}, session, { transport: allowed.transport })).result.items.length, 1)
})
test('usage workflow is offline discoverable, stops identity changes and prevents raw endpoint bypass', async () => {
  const model = fixture(); model.user.id = '22'
  await assert.rejects(run('list', {}, model), { code: 'IDENTITY_CHANGED' }); assert.equal(reads(model).length, 0)
  const transport = () => { throw Error('No HTTP permitted') }
  assert.equal((await executeWorkflow(ctx, definition('list'), { days: 7 }, null, { dryRun: true, transport })).dryRun, true)
  const op = catalog.operations.find(op => op.route === '/task/v1/team/useStatistical')
  await assert.rejects(executeOperation(ctx, op, { query: { pageIndex: 1, pageSize: 10, startDate: '2026.01.01', endDate: '2026.01.07', sort: 'loginCount_desc' } }, session, { transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
