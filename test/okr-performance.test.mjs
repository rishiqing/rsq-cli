import test from 'node:test'
import assert from 'node:assert/strict'
import { context } from '../dist/core.js'
import { executeWorkflow } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { validateOkrPerformanceWorkflow } from '../dist/okr-performance.js'
const ctx = context('production', 'fixture'), session = { version: 1, method: 'password', token: 'fixture', cookies: [], identity: { userId: '81', teamId: '7' } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const response = (data, ext = null) => json({ code: 200, msg: 'ok', data, ext })
const flow = suffix => { const value = workflows.workflows.find(row => row.command === 'okr performance ' + suffix); assert.ok(value); return value }
const run = (suffix, input, f, extra = {}) => executeWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, ...extra })
function fixture(options = {}) {
  const calls = [], records = options.many ? Array.from({ length: 101 }, (_, index) => ({ id: 201 + index })) : [{ id: 301, stage: 'finished' }]
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams); calls.push({ path, query, method: init.method })
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json(['OKR', 'PERFORMANCE', 'OKR_PERFORMANCE'].map(funcName => ({ funcName, status: options.feature === funcName ? 'disable' : 'enable' })))
    if (path.endsWith('/company/current')) return json({ useObjective: true })
    if (path === '/task/okr/preference') return json({ performanceOpenFlag: !options.closed })
    if (path === '/task/v1/department/list') return json([{ id: '7', name: '公司', type: 'top', parentId: null, displayOrder: 1, childList: [], userList: [{ id: 81, name: '本人' }, { id: 82, name: '同事' }] }])
    if (path === '/task/performance/init') return response({ hasInit: !options.uninitialized })
    if (path === '/task/performance/authority/role') return response({ id: 1, authorities: { performanceAppraisalMyData: !options.noPersonal, performanceAppraisalAllDataManage: !options.noManage, performanceAppraisalDeptDataManage: false } })
    if (path === '/task/performance/member/select') return response([{ id: 81 }, { id: 82 }])
    if (path === '/task/performance/view/auth') return response({ canViewPerformance: !options.denied })
    if (['/task/performance/appraisals/my', '/task/performance/appraisals/user', '/task/performance/appraisals/all'].includes(path)) return response(records.slice(Number(query.offset), Number(query.offset) + Number(query.max)), { all: records.length })
    if (path === '/task/performance/appraisal') return response({ id: options.wrongAssessment ? 999 : 301, object: { id: 81 }, stage: 'finished', contentId: 501 })
    if (path === '/task/performance/v2/content') return response({ id: 501, appraisalId: 301, dimensions: [{ id: 601, type: 'quantitative', indicators: [{ id: 701, name: '指标' }] }], raters: [] })
    if (path === '/task/performance/content/flowInfo') return response({ flowInfo: [], button: {} })
    if (path === '/task/performance/preference/dimension/dictionaries') return response({ 601: [] })
    if (path === '/task/performance/appraisal/reviews') return response({})
    if (path === '/task/performance/appraisal/rule') return response({})
    throw Error('Unexpected fixture path ' + path)
  }
  return { calls, transport }
}
test('OKR embedded performance has distinct discovery, source list and full detail commands', async () => {
  for (const suffix of ['context', 'list', 'get']) validateOkrPerformanceWorkflow(flow(suffix))
  const f = fixture(), own = await run('context', {}, f); assert.equal(own.result.targetId, '81'); assert.equal(own.result.authorized, true)
  assert.equal(f.calls.filter(row => row.path.endsWith('/view/auth')).length, 0)
  const person = await run('list', { scope: 'person', targetId: '82' }, f)
  assert.equal(person.result.items[0].id, 301); assert.deepEqual(f.calls.find(row => row.path.endsWith('/view/auth')).query, { type: 'person', dataId: '82' })
  assert.equal(f.calls.find(row => row.path.endsWith('/appraisals/user')).query.userId, '82')
  assert.equal(person.result.pagination.total, null)
  const dept = await run('list', { scope: 'dept', targetId: '7' }, f); assert.equal(dept.result.scope, 'dept'); assert.equal(f.calls.find(row => row.path.endsWith('/appraisals/all')).query.deptId, '7')
})
test('a guessed appraisal ID is rejected before requesting full content; an actual second-page source works', async () => {
  const f = fixture({ many: true }), result = await run('get', { appraisalId: '301' }, f)
  assert.equal(result.result.assessment.id, 301); assert.equal(result.result.content.id, 501); assert.equal(result.result.independentlyScoped, true)
  assert.deepEqual(f.calls.filter(row => row.path.endsWith('/appraisals/my')).map(row => row.query.offset), ['0', '100'])
  const denied = fixture(); await assert.rejects(run('get', { appraisalId: '999' }, denied), { code: 'FORBIDDEN' }); assert.equal(denied.calls.filter(row => row.path.endsWith('/appraisal')).length, 0)
  const wrong = fixture({ wrongAssessment: true }); await assert.rejects(run('get', { appraisalId: '301' }, wrong), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('current company, menu, target authorization, role, expiry and capacity are enforced before source data', async () => {
  for (const [options, input, code] of [
    [{ closed: true }, {}, 'FEATURE_DISABLED'], [{ uninitialized: true }, {}, 'APPLICATION_NOT_INITIALIZED'],
    [{ denied: true }, { scope: 'person', targetId: '82' }, 'FORBIDDEN'], [{ noManage: true }, { scope: 'dept', targetId: '7' }, 'FORBIDDEN'],
    [{ noPersonal: true }, {}, 'FORBIDDEN'], [{}, { scope: 'person', targetId: '999' }, 'FORBIDDEN'],
    [{ expired: true }, {}, 'COMPANY_EXPIRED'], [{ over: true }, {}, 'COMPANY_OVER_CAPACITY'],
    [{ feature: 'OKR_PERFORMANCE' }, {}, 'FEATURE_DISABLED'],
  ]) { const f = fixture(options); await assert.rejects(run('list', input, f), { code }); assert.ok(!f.calls.some(row => row.path.includes('/appraisals/'))) }
})
test('window pagination never claims a full collection from a later page or invents a total', async () => {
  const f = fixture({ many: true }), page = await run('list', { offset: 100, limit: 1 }, f)
  assert.equal(page.result.pagination.complete, false); assert.equal(page.result.pagination.nextOffsetIsProbe, true); assert.equal(page.result.pagination.total, null)
  const end = await run('list', { offset: 101, limit: 1 }, f); assert.equal(end.result.pagination.windowEndReached, true); assert.equal(end.result.pagination.complete, false)
})
test('offline plans send no HTTP and malformed source steps cannot substitute an arbitrary transport', async () => {
  const f = fixture(); await run('get', { appraisalId: '301' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  const bad = structuredClone(flow('get')); bad.steps[0].waitBeforeMs = 1; assert.throws(() => validateOkrPerformanceWorkflow(bad), { code: 'INVALID_CONTRACT' })
  await assert.rejects(run('list', { scope: 'my', targetId: '81' }, fixture()), { code: 'INVALID_INPUT' })
})
