import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'

const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.parse('2035-01-01T00:00:00Z') }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const period = '2026年01月', dates = { startDate: '2026-01-01', endDate: '2026-01-31' }
function fixture(options = {}) {
  const calls = [], rows = options.rows ?? [
    { id: '81', name: '同名', dept: '71', score: '0.00', level: 'B', detail: '301' },
    { id: '82', name: '同名', dept: '72', score: '-', level: '-', detail: '302' },
    { id: '9007199254740993', name: '长 ID', dept: '71', score: ' ', level: null, detail: null },
  ]
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams); calls.push({ path, method: init.method, query })
    assert.equal(init.method, 'GET')
    const response = data => json({ code: 200, data })
    if (path === '/task/login/authAjax') return json({ success: true, id: 81, username: 'fixture', team: { id: 7, name: '公司' }, token: 'fixture' })
    if (path.endsWith('/init')) return response({ hasInit: options.initialized !== false })
    if (path.endsWith('/authority/role')) return response({ id: 1, authorities: { performanceReportView: options.allowed !== false } })
    if (path.endsWith('/appraisal/report')) {
      if (options.timeout) throw Error('read timeout')
      let selected = [...rows]
      if (query.filterUser && !options.ignoreUser) selected = selected.filter(row => query.filterUser.split(',').includes(row.id))
      if (query.filterDept) selected = selected.filter(row => query.filterDept.split(',').includes(row.dept))
      if (query.sortValue === 'desc') selected.reverse()
      const max = Number(query.max), offset = Number(query.offset)
      const chosen = selected.slice((offset - 1) * max, offset * max)
      const dynamic = options.columns ?? [period]
      const data = { column: ['object', 'dept', 'leader', 'total', ...dynamic], tableData: chosen.map(row => [
        { key: 'object', value: { id: row.id, showName: row.name, avatar: 'https://private.invalid/avatar' } },
        { key: 'dept', value: [{ id: row.dept, name: '部门 ' + row.dept }] }, { key: 'leader', value: null }, { key: 'total', value: row.score.trim() || '-' },
        ...dynamic.map(key => ({ key, value: { score: row.score, detailId: row.detail, level: row.level } })),
      ]), cutlines: ['B'], page: { totalNum: rows.length, max, offset: offset + 1 } }
      if (options.missingColumns) data.column = data.column.slice(1)
      if (options.wrongPage) data.page.offset = offset
      if (options.duplicateCells && data.tableData.length) data.tableData[0][1] = data.tableData[0][0]
      if (options.repeatNext && max === 1 && offset > 1 && data.tableData.length) data.tableData[0] = data.tableData[0].map(cell => cell.key === 'object' ? { ...cell, value: { id: '81', showName: '同名' } } : cell)
      return response(data)
    }
    if (path.endsWith('/appraisal')) return response({ id: Number(query.id), object: { id: options.wrongObject ? 82 : Number(query.id) === 301 ? 81 : 82 }, type: 'monthly', time: { period } })
    if (path.endsWith('/v2/content')) return response({ id: 501, dimensions: [{ id: 601, type: 'quantitative', indicators: [] }], raters: [] })
    if (path.endsWith('/content/flowInfo')) return response({ flowInfo: [] })
    if (path.endsWith('/preference/dimension/dictionaries')) { assert.equal(query.contentId, '501'); assert.equal(query.isLaunched, 'true'); return response({ 601: [{ key: 'name', name: '指标名称' }] }) }
    if (path.endsWith('/appraisal/reviews')) return response({ reviewList: [] })
    if (path.endsWith('/appraisal/rule')) return response({ fullScore: '100' })
    throw Error('Unexpected request ' + path)
  }
  return { calls, transport }
}
const run = (suffix, input, f, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === 'appraisal reports ' + suffix), input, session, { transport: f.transport, ...options })

test('report scope comes from real report rows and preserves same-name identities, long IDs and dynamic sort columns', async () => {
  const f = fixture(), result = (await run('context', dates, f)).result
  assert.deepEqual(result.users.map(user => user.id), ['81', '82', '9007199254740993'])
  assert.deepEqual(result.departments.map(dept => dept.id), ['71', '72'])
  assert.deepEqual(result.sortKeys, ['leader', 'total', period + '-score', period + '-level'])
  assert.ok(result.filterSemantics.startsWith('member-and-department-intersection'))
  assert.ok(!JSON.stringify(result).includes('avatar'))
  assert.ok(f.calls.every(call => !call.path.includes('/department/') && !call.path.includes('/member/select')))
})
test('report paging observes the next page rather than trusting the unfiltered total or response offset as the current page', async () => {
  const f = fixture(), result = (await run('list', { ...dates, userIds: ['81', '82'], pageSize: 1 }, f)).result
  assert.equal(result.pagination.page, 1); assert.equal(result.pagination.next, 2); assert.equal(result.pagination.reportedNextPage, 2)
  assert.equal(result.pagination.total, null); assert.equal(result.pagination.reportedUnfilteredTotal, 3)
  const next = (await run('list', { ...dates, userIds: ['81', '82'], pageSize: 1, page: 2 }, f)).result
  assert.equal(next.items[0].user.id, '82'); assert.equal(next.pagination.next, null)
  assert.ok(f.calls.some(call => call.query.offset === '3'))
})
test('member and department filters intersect; zero, hidden scores and no-assessment blanks remain distinct', async () => {
  const f = fixture(), all = (await run('list', dates, f)).result
  assert.deepEqual(all.items.map(row => row.periods[0].score), ['0.00', '-', ' '])
  assert.deepEqual(all.items.map(row => row.periods[0].appraisalId), ['301', '302', null])
  const empty = (await run('list', { ...dates, userIds: ['81'], departmentIds: ['72'] }, f)).result
  assert.deepEqual(empty.items, []); assert.equal(empty.pagination.next, null); assert.equal(empty.pagination.total, null)
  const sorted = (await run('list', { ...dates, sortKey: period + '-level', direction: 'desc', total: 'cumulativeScore' }, f)).result
  assert.equal(sorted.items[0].user.id, '9007199254740993')
  assert.ok(f.calls.some(call => call.query.sortKey === period + '-level' && call.query.sortValue === 'desc' && call.query.total === 'cumulativeScore'))
})
test('an unassigned synthetic department keeps null in rows and is never offered as a filterable resource', async () => {
  const f = fixture({ rows: [{ id: '81', name: '未分配成员', dept: null, score: ' ', level: null, detail: null }] })
  const context = (await run('context', dates, f)).result; assert.deepEqual(context.departments, [])
  const result = (await run('list', dates, f)).result; assert.equal(result.items[0].departments[0].id, null)
  await assert.rejects(run('list', { ...dates, departmentIds: ['999'] }, f), { code: 'INVALID_INPUT' })
})
test('four report granularities use current UI date windows in Shanghai and actual server enum values', async () => {
  const NativeDate = globalThis.Date
  globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-12-31T16:01:00Z'])) } static now() { return NativeDate.parse('2026-12-31T16:01:00Z') } }
  try {
    for (const [periodType, type, start, end] of [['month', 'monthly', '2026.02.01', '2027.01.31'], ['quarter', 'quarter', '2026.04.01', '2027.03.31'], ['halfYear', 'semester', '2025.07.01', '2027.06.30'], ['year', 'yearly', '2025.01.01', '2027.12.31']]) {
      const f = fixture(); await run('context', { periodType }, f)
      const query = f.calls.find(call => call.path.endsWith('/appraisal/report')).query
      assert.equal(query.columnType, type); assert.equal(query.startDate, start); assert.equal(query.endDate, end)
    }
  } finally { globalThis.Date = NativeDate }
})
test('drilldown resolves a real cell and independently reads its assessment, HTTP content, flow and dictionaries', async () => {
  const f = fixture(), result = (await run('inspect', { ...dates, userId: '81', period }, f)).result
  assert.equal(result.cell.appraisalId, '301'); assert.equal(result.assessment.id, 301); assert.equal(result.content.id, 501); assert.equal(result.fields[601][0].key, 'name'); assert.equal(result.independentlyVerified, true)
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/appraisal')).map(call => call.query.id), ['301'])
  const wrong = fixture({ wrongObject: true }); await assert.rejects(run('inspect', { ...dates, userId: '81', period }, wrong), { code: 'BUSINESS_ASSERTION_FAILED' })
  const blank = fixture(); await assert.rejects(run('inspect', { ...dates, userId: '9007199254740993', period }, blank), { code: 'RESOURCE_NOT_FOUND' }); assert.ok(!blank.calls.some(call => call.path.endsWith('/v2/content')))
})
test('report permissions and app initialization stop before any report request', async () => {
  for (const options of [{ allowed: false }, { initialized: false }]) {
    const f = fixture(options); await assert.rejects(run('context', {}, f), { code: options.allowed === false ? 'RESOURCE_FORBIDDEN' : 'APPLICATION_NOT_INITIALIZED' }); assert.ok(!f.calls.some(call => call.path.endsWith('/appraisal/report')))
  }
})
test('bad dates, invented filter IDs, period columns and sorting never reach the requested query or detail', async () => {
  for (const input of [{ startDate: '2026-02-29', endDate: '2026-03-01' }, { ...dates, userIds: ['999'] }, { ...dates, departmentIds: ['999'] }, { ...dates, sortKey: 'invented-score', direction: 'asc' }, { ...dates, sortKey: 'leader' }]) {
    const f = fixture(); await assert.rejects(run('list', input, f), { code: 'INVALID_INPUT' })
    assert.ok(!f.calls.some(call => call.query.filterUser || call.query.filterDept || call.query.sortKey))
  }
  const f = fixture(); await assert.rejects(run('inspect', { ...dates, userId: '81', period: 'invented' }, f), { code: 'INVALID_INPUT' }); assert.ok(!f.calls.some(call => call.path.endsWith('/appraisal')))
})
test('invalid page metadata, duplicate cells and concurrent page overlap fail instead of fabricating completeness', async () => {
  for (const options of [{ missingColumns: true }, { wrongPage: true }, { duplicateCells: true }, { repeatNext: true }]) {
    const f = fixture(options); await assert.rejects(run('list', { ...dates, pageSize: 1 }, f), { code: 'BUSINESS_ASSERTION_FAILED' })
  }
  const ignored = fixture({ ignoreUser: true }); await assert.rejects(run('list', { ...dates, userIds: ['81'] }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('report context crosses actual pages without using pre-filter total as an end marker', async () => {
  const f = fixture({ rows: Array.from({ length: 101 }, (_, index) => ({ id: String(1000 + index), name: '成员', dept: '71', score: ' ', level: null, detail: null })) })
  const result = (await run('context', dates, f)).result
  assert.equal(result.users.length, 101); assert.equal(result.complete, true)
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/appraisal/report')).map(call => call.query.offset), ['1', '2'])
})
test('dry-run is offline and raw report calls require business context; timeout is not retried', async () => {
  const f = fixture(), dry = await run('inspect', { ...dates, userId: '81', period }, f, { dryRun: true })
  assert.equal(dry.dryRun, true); assert.equal(f.calls.length, 0); assert.ok(dry.steps.some(step => step.id === 'fields' && step.context === 'resolve-from-verified-http-context'))
  const raw = catalog.operations.find(op => op.route === '/task/performance/appraisal/report' && op.method === 'GET')
  await assert.rejects(executeOperation(ctx, raw, { query: { columnType: 'monthly', startDate: '2026.01.01', endDate: '2026.01.31', total: 'cumulativeScore', max: 10, offset: 1 } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  const failed = fixture({ timeout: true }); await assert.rejects(run('list', dates, failed)); assert.equal(failed.calls.filter(call => call.path.endsWith('/appraisal/report')).length, 1)
})
