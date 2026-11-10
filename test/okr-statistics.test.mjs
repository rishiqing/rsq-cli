import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { maskOkrStatistics } from '../dist/okr-statistics.js'
const base = '/task/okr/statistics', ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const statisticsJson = value => json({ code: 200, msg: '成功', ...(Array.isArray(value) ? { data: value, ext: null } : value) })
const flow = suffix => { const value = workflows.workflows.find(row => row.command === 'okr statistics ' + suffix); assert.ok(value, suffix); return value }
const run = (suffix, input, f, opts = {}) => runWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, ...opts })
function fixture(options = {}) {
  const calls = [], people = Array.from({ length: options.count ?? 101 }, (_, index) => ({ id: 1000 + index, name: '统计成员' + index, number: 1, averageProgress: '25%' }))
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams); calls.push({ path, query, headers: new Headers(init.headers), method: init.method })
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'OKR', status: 'enable' }, { funcName: 'OKR_STATISTICS', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return json({ useObjective: true })
    if (path === '/task/okr/objective/sidebar') return json({ editControl: { statisticsVisible: !options.noMenu }, cycleList: [], focusList: [] })
    if (path === '/task/okr/cycle/list') return json({ currentCycleList: [{ id: 41, name: '当前周期', isArchived: false }], futureCycleList: [], pastCycleList: [] })
    if (path === '/task/v1/department/list') return json([{ id: '7', name: '公司', parentId: null, type: 'top', displayOrder: 1, userList: [], childList: [{ id: '8', name: '部门', type: 'common', parentId: '7', displayOrder: 1, childList: [], userList: [] }] }])
    if (path === base + '/data') return statisticsJson([{ code: 'overview', name: '概览', data: [{ id: 'overview_objectiveNum', code: 'objectiveNum', key: '目标数', value: '1', percent: 1 }] }])
    if (path === base + '/data/item') return statisticsJson([{ id: 201, name: '范围外名称不应泄漏', editControl: { view: false }, keyResultList: [{ name: '隐藏的子内容' }] }, { id: 202, name: '可见目标', editControl: { view: true } }])
    if (path === base + '/reportForms') {
      if (query.objectiveType === 'dept') return statisticsJson({ data: [{ id: 7, name: '公司', children: [{ id: 8, name: '部门' }] }], ext: { pageNum: 1, pageSize: 20, total: 0, pages: 0 } })
      const page = Number(query.pageNum), limit = Number(query.pageSize), total = options.drift && page > 1 ? people.length + 1 : people.length
      const items = options.duplicatePage && page > 1 ? people.slice(0, 1) : people.slice((page - 1) * limit, page * limit)
      return statisticsJson({ data: items, ext: { pageNum: options.wrongPage ? 1 : page, pageSize: limit, total, pages: Math.ceil(total / limit) } })
    }
    if (path === base + '/reportForms/item') return statisticsJson({ data: [{ objectiveId: 201, name: '来源无权查看', editControl: { view: false } }, { objectiveId: 202, name: '可见明细', editControl: { view: true } }], ext: null })
    if (path === base + '/overview' || path === base + '/overviewAll') return statisticsJson([{ name: '目标数', key: 'totalNum', value: 10 }])
    throw Error('Unexpected statistics fixture request ' + path)
  }
  return { calls, transport }
}
test('OKR statistics exposes seven schema-backed commands with live menu and cycle context', async () => {
  const actual = workflows.workflows.filter(row => row.executor === 'okr-statistics'); assert.equal(actual.length, 7)
  for (const item of actual) assert.ok(item.resultSchema)
  const f = fixture(), context = await run('context', {}, f)
  assert.equal(context.result.cycles[0].id, '41'); assert.ok(context.result.departments.some(row => row.id === '8'))
  const recent = await run('overview recent', {}, f); assert.equal(recent.result.sourceObjectiveLimit, 500); assert.match(recent.result.note, /不是公司历史全量/)
  assert.equal((await run('overview get', { cycleId: '41' }, f)).result.items[0].value, 10)
})
test('chart drilldown requires an exact actual point and masks server-hidden rows recursively', async () => {
  const f = fixture(), charts = await run('charts get', { cycleId: '41', objectiveType: 'all' }, f)
  assert.deepEqual(charts.result.drilldownIds, ['overview_objectiveNum'])
  await assert.rejects(run('chart details', { cycleId: '41', pointId: 'guessed_metric' }, f), { code: 'INVALID_INPUT' }); assert.equal(f.calls.filter(row => row.path.endsWith('/data/item')).length, 0)
  const detail = await run('chart details', { cycleId: '41', pointId: 'overview_objectiveNum' }, f)
  assert.deepEqual(detail.result.items[0], { hidden: true, reason: 'view-permission-denied' }); assert.equal(detail.result.items[1].name, '可见目标')
  assert.ok(!JSON.stringify(detail).includes('范围外名称')); assert.ok(!JSON.stringify(detail).includes('隐藏的子内容'))
  assert.deepEqual(maskOkrStatistics({ list: [{ editControl: { view: false }, name: '不能输出' }] }), { list: [{ hidden: true, reason: 'view-permission-denied' }] })
  for (const row of [{ editControl: {} }, { editControl: { view: null } }, { isMask: true }]) assert.deepEqual(maskOkrStatistics({ ...row, name: '不能输出' }), { hidden: true, reason: 'view-permission-denied' })
  assert.deepEqual(maskOkrStatistics({ editControl: null, name: 'UI 默认可见' }), { editControl: null, name: 'UI 默认可见' })
})
test('person reports use actual page metadata while department trees refuse fake pagination', async () => {
  const f = fixture(), report = await run('report get', { cycleId: '41', objectiveType: 'person', page: 2, limit: 100, departmentId: '8' }, f)
  assert.equal(report.result.items.length, 1); assert.deepEqual(report.result.pagination, { requestedPage: 2, pageSize: 100, total: 101, totalPages: 2, nextPage: null })
  assert.equal(f.calls.find(row => row.path.endsWith('/reportForms')).query.deptId, '8')
  const tree = await run('report get', { cycleId: '41', objectiveType: 'dept', deptType: 'deptAndChildDeptUser' }, f)
  assert.equal(tree.result.pagination, null); assert.equal(tree.result.items[0].children[0].id, 8)
  await assert.rejects(run('report get', { cycleId: '41', objectiveType: 'dept', page: 1 }, f), { code: 'INVALID_INPUT' })
  await assert.rejects(run('report get', { cycleId: '41', objectiveType: 'person', departmentId: '999' }, f), { code: 'INVALID_INPUT' })
  await assert.rejects(run('report get', { cycleId: '41', objectiveType: 'person', deptType: 'dept' }, f), { code: 'INVALID_INPUT' })
})
test('report drilldown proves an actual source row beyond the first page and keeps detail sort distinct', async () => {
  const f = fixture(), detail = await run('report details', { cycleId: '41', objectiveType: 'person', rowId: '1100', metric: 'report_objNum', sortKey: 'progress', sortValue: 'desc' }, f)
  const sources = f.calls.filter(row => row.path.endsWith('/reportForms')); assert.equal(sources.length, 2); assert.ok(sources.every(row => row.query.sortKey == null))
  assert.equal(f.calls.find(row => row.path.endsWith('/reportForms/item')).query.objectiveTypeDataId, '1100'); assert.equal(detail.result.items[0].hidden, true)
  const invalid = fixture(); await assert.rejects(run('report details', { cycleId: '41', objectiveType: 'person', rowId: '81', metric: 'report_objNum' }, invalid), { code: 'INVALID_INPUT' }); assert.ok(!invalid.calls.some(row => row.path.endsWith('/reportForms/item')))
  const dept = fixture(); await run('report details', { cycleId: '41', objectiveType: 'dept', rowId: '8', metric: 'report_krNum', deptType: 'deptUser' }, dept)
  assert.equal(dept.calls.find(row => row.path.endsWith('/reportForms/item')).query.deptType, 'deptUser')
})
test('statistics rejects drifting, repeated and wrong-page source results before downstream requests', async () => {
  for (const options of [{ drift: true }, { duplicatePage: true }, { wrongPage: true }]) {
    const f = fixture(options)
    await assert.rejects(run('report details', { cycleId: '41', objectiveType: 'person', rowId: '1100', metric: 'report_objNum' }, f), error => ['CONTEXT_MISSING', 'CONTEXT_CONFLICT'].includes(error.code))
    assert.ok(!f.calls.some(row => row.path.endsWith('/reportForms/item')))
  }
})
test('qywx report client header derives from identity and cannot be forged through input', async () => {
  const f = fixture()
  await runWorkflow(ctx, flow('report details'), { cycleId: '41', objectiveType: 'person', rowId: '1000', metric: 'report_objNum' }, { ...session, method: 'wecom' }, { transport: f.transport })
  assert.ok(f.calls.filter(row => row.path.includes('/reportForms')).every(row => row.headers.get('client') === 'qywx'))
  const invalid = fixture(); await assert.rejects(run('report get', { cycleId: '41', objectiveType: 'person', headers: { client: 'qywx' } }, invalid), { code: 'INVALID_INPUT' }); assert.equal(invalid.calls.length, 0)
})
test('statistics offline planning validates sort pair and rejects protocol tampering and raw transport', async () => {
  const f = fixture(); await run('chart details', { cycleId: '41', pointId: 'offline-metric' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('chart details', { cycleId: '41', pointId: 'offline-metric', sortKey: 'progress' }, f, { dryRun: true }), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  const edited = structuredClone(flow('charts get')); edited.okrStatisticsAction = 'invented'
  await assert.rejects(runWorkflow(ctx, edited, { cycleId: '41' }, session, { dryRun: true }), { code: 'INVALID_CONTRACT' })
  const op = catalog.operations.find(op => op.route === base + '/data')
  await assert.rejects(executeOperation(ctx, op, { query: { cycleId: '41', objectiveType: 'all' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
test('statistics enforces both UI feature and actual sidebar role plus expiry and capacity', async () => {
  for (const [options, code] of [[{ disabled: true }, 'FEATURE_DISABLED'], [{ noMenu: true }, 'FORBIDDEN'], [{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY']]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('charts get'), { cycleId: '41' }, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(row => row.path.startsWith(base)))
  }
  const foreign = fixture(); await assert.rejects(run('charts get', { cycleId: '999' }, foreign), { code: 'INVALID_INPUT' }); assert.ok(!foreign.calls.some(row => row.path.startsWith(base)))
})
