import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { runWorkflow, workflows, workflowSchema } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
import { businessScope } from '../dist/business.js'

const jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const flow = suffix => workflows.workflows.find(flow => flow.command === 'replay statistics ' + suffix)
function service(options = {}) {
  const type = options.type ?? 'day', members = [{ id: 1, name: 'Self' }, { id: '9223372036854775806', name: 'Other writer' }]
  const collection = { id: 21, name: 'Current replay', type }
  const cells = options.cells ?? [{ year: 2026, month: 11, day: 8, status: 'uncommitted', canRemind: true }]
  const calls = []
  return { calls, transport: async (url, init) => {
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method, ...(init.body && { body: JSON.parse(init.body) }) })
    if (url.pathname === '/task/authority/v3/authorities/company/current') return json({ replayStatistics: options.allowed ?? true })
    if (url.pathname === '/task/okr/role/replay/permission/current') return json({ replayStatistics: options.okrAllowed ?? true })
    if (url.pathname === '/task/review/stat/list') return json({ dayList: [], weekList: [], monthList: [], [type + 'List']: [collection] })
    if (url.pathname === '/task/review/replay/collect') return json(collection)
    if (url.pathname === '/task/review/replay/collect/member/list') return json({ userList: url.searchParams.has('deptId') || url.searchParams.has('groupId') ? [members[0]] : members,
      deptList: [{ id: 30, childList: [{ id: 31, childList: [] }] }], groupList: [{ id: 41 }] })
    if (url.pathname === '/task/review/stat/report') {
      const selected = url.searchParams.get('userIds')?.split(',')
      const users = options.reportUsers ?? (selected ? members.filter(user => selected.includes(String(user.id))) : members)
      return json(users.map(user => ({ user, deptList: [], shouldCommitCount: 1, unCommitCount: 1, onTimeCommitCount: 0, supplementCommitCount: 0, timeDataList: cells })))
    }
    if (url.pathname === '/task/review/stat/report/other') return json({ totalData: { timeDataList: [], shouldCommitCount: 1, unCommitCount: 1, onTimeCommitCount: 0, supplementCommitCount: 0 }, remindTimeList: [] })
    if (url.pathname === '/task/review/stat/commit/rank') return json(options.commitRank ?? [{ user: members[0], onTimeCommitPercent: 100 }, { user: members[1], onTimeCommitPercent: 0 }])
    if (url.pathname === '/task/review/stat/like/rank') return json([{ user: members[0], likeCount: 0 }, { user: members[1], likeCount: 0 }])
    if (url.pathname === '/task/review/remind/uncommitted') {
      if (options.timeout) throw new Error('timeout after possible notification submission')
      return json(options.reminderError ? { code: 403, msg: 'permission denied', data: null, ext: null } : { code: 200, msg: 'ok', data: null, ext: null })
    }
    throw Error('Unexpected ' + url.pathname)
  } }
}
const run = (suffix, input, mock, approved = false) => runWorkflow(ctx, flow(suffix), input, session, { transport: mock.transport, approved })

test('replay statistics discovery, Schema and dry-run describe actual context without requests', async () => {
  assert.deepEqual(auditWorkflows(workflows, catalog, businessScope), [])
  const mock = service()
  for (const suffix of ['list', 'context', 'report', 'rankings', 'cell get', 'remind']) {
    assert.equal(workflowSchema(flow(suffix)).executable, true)
    assert.ok(flow(suffix).steps.some(step => step.id === 'companyPermissions'))
  }
  const result = await runWorkflow(ctx, flow('remind'), { collectionId: '21', date: '2026-11-08', userIds: ['1'] }, null, { transport: mock.transport, dryRun: true })
  assert.equal(result.effect, 'destructive'); assert.equal(mock.calls.length, 0)
  await assert.rejects(run('remind', { collectionId: '21', date: '2026-11-08', userIds: ['1'] }, mock), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(mock.calls.length, 0)
})
test('statistics require the selected application permission before querying permissive business HTTP', async () => {
  for (const application of ['rishiqing', 'okr']) {
    const mock = service({ allowed: false, okrAllowed: false })
    await assert.rejects(run('list', { application }, mock), { code: 'FORBIDDEN' })
    assert.equal(mock.calls.length, 1); assert.ok(mock.calls[0].path.includes(application === 'okr' ? '/okr/role/' : '/authority/'))
  }
  const mock = service({ allowed: false, okrAllowed: true })
  assert.equal(String((await run('list', { application: 'okr' }, mock)).result.collections[0].id), '21')
  assert.equal(mock.calls.some(call => call.path.includes('/authority/')), false)
})
test('report preserves fixed pagination, long writer IDs, zero counts and independent full-range totals', async () => {
  const mock = service(), input = { collectionId: '21', year: 2026, month: 11, userIds: ['9223372036854775806'], page: 3, size: 1 }
  const result = (await run('report', input, mock)).result
  assert.equal(result.items[0].user.id, '9223372036854775806'); assert.equal(result.items[0].onTimeCommitCount, 0)
  assert.deepEqual(result.pagination, { page: 3, size: 1, nextPage: 4, total: null, completeness: 'single-page' })
  const report = mock.calls.find(call => call.path.endsWith('/stat/report')), totals = mock.calls.find(call => call.path.endsWith('/stat/report/other'))
  assert.deepEqual(report.query, { replayCollectId: '21', userIds: '9223372036854775806', year: '2026', month: '11', page: '3', size: '1' })
  assert.deepEqual(totals.query, { replayCollectId: '21', userIds: '9223372036854775806', year: '2026', month: '11' })
})
test('statistics selectors reject foreign collections, ambiguous scopes and writers outside filtered membership', async () => {
  for (const input of [{ collectionId: '999', year: 2026 }, { collectionId: '21', year: 2026, deptId: '999' }, { collectionId: '21', year: 2026, groupId: '999' },
    { collectionId: '21', year: 2026, deptId: '31', groupId: '41' }, { collectionId: '21', year: 2026, deptId: '31', userIds: ['9223372036854775806'] },
    { collectionId: '21', year: 2026, userIds: ['123'] }]) {
    const mock = service()
    await assert.rejects(run('report', input, mock), error => ['FORBIDDEN', 'INVALID_INPUT'].includes(error.code))
    assert.equal(mock.calls.some(call => call.path.endsWith('/stat/report')), false)
  }
  const mock = service()
  const result = (await run('context', { collectionId: '21', deptId: '31', userIds: ['1'] }, mock)).result
  assert.deepEqual(result.members.userList.map(user => String(user.id)), ['1'])
})
test('month reports cover a year; week cells use actual cross-year replay periods', async () => {
  const monthly = service({ type: 'month', cells: [{ year: 2026, month: 11, status: 'uncommitted', canRemind: true }] })
  await assert.rejects(run('report', { collectionId: '21', year: 2026, month: 11 }, monthly), { code: 'INVALID_INPUT' })
  const mock = service({ type: 'week', cells: [{ year: 2027, week: 1, status: 'auditedOnTimeCommit', canRemind: false }] })
  const result = (await run('cell get', { collectionId: '21', year: 2026, month: 12, userId: '1', date: '2026-12-31' }, mock)).result
  assert.deepEqual(result.detail.period, { year: 2027, week: 1 }); assert.equal(result.detail.cell.status, 'auditedOnTimeCommit')
  await assert.rejects(run('cell get', { collectionId: '21', year: 2026, month: 12, userId: '999', date: '2026-12-31' }, service()), { code: 'INVALID_INPUT' })
})
test('rankings preserve percentages and ties but reject out-of-scope users and reversed order', async () => {
  const result = (await run('rankings', { collectionId: '21', year: 2026 }, service())).result
  assert.deepEqual(result.commitRank.map(row => row.onTimeCommitPercent), [100, 0]); assert.deepEqual(result.likeRank.map(row => row.likeCount), [0, 0])
  for (const commitRank of [[{ user: { id: 123 }, onTimeCommitPercent: 0 }], [{ user: { id: 1 }, onTimeCommitPercent: 101 }],
    [{ user: { id: 1 }, onTimeCommitPercent: 0 }, { user: { id: '9223372036854775806' }, onTimeCommitPercent: 50 }]]) {
    await assert.rejects(run('rankings', { collectionId: '21', year: 2026 }, service({ commitRank })), { code: 'RESPONSE_SCHEMA_MISMATCH' })
  }
})
test('reminder verifies actual period and explicit recipients, sends once and reports acknowledgement separately from delivery', async () => {
  const mock = service(), result = (await run('remind', { collectionId: '21', date: '2026-11-08', userIds: ['1'] }, mock, true)).result
  const writes = mock.calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].body, { replayCollectId: '21', year: 2026, month: 11, day: 8, userIds: '1' })
  assert.equal(mock.calls.filter(call => call.path.endsWith('/stat/report')).length, 2)
  assert.ok(mock.calls.filter(call => call.path.endsWith('/stat/report')).every(call => call.query.size === '100'))
  assert.equal(result.reminder.acknowledged, true); assert.equal(result.reminder.delivery, 'not-verifiable-no-delivery-receipt-api')
  for (const cell of [{ status: 'committedOnTimeCommit', canRemind: false }, { status: 'uncommitted', canRemind: false }]) {
    const denied = service({ cells: [{ year: 2026, month: 11, day: 8, ...cell }] })
    await assert.rejects(run('remind', { collectionId: '21', date: '2026-11-08', userIds: ['1'] }, denied, true), { code: 'FORBIDDEN' })
    assert.equal(denied.calls.some(call => call.method === 'POST'), false)
  }
})
test('unknown notification outcome retains completed context and never replays a timed-out write', async () => {
  const mock = service({ timeout: true })
  await assert.rejects(run('remind', { collectionId: '21', date: '2026-11-08', userIds: ['1'] }, mock, true), error => {
    assert.equal(error.details.failedStep, 'reminded'); assert.equal(error.details.writeOutcome, 'unknown')
    assert.ok(error.details.completedSteps.includes('report')); return true
  })
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(mock.calls.filter(call => call.path.endsWith('/stat/report')).length, 1)
})
test('a HTTP 200 business-error receipt is never treated as an accepted reminder', async () => {
  const mock = service({ reminderError: true })
  await assert.rejects(run('remind', { collectionId: '21', date: '2026-11-08', userIds: ['1'] }, mock, true), error => {
    assert.equal(error.details.failedStep, 'reminded'); return true
  })
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(mock.calls.filter(call => call.path.endsWith('/stat/report')).length, 1)
})
