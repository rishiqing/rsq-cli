import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { context } from '../dist/core.js'
import { catalog } from '../dist/operations.js'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { validateStatisticsDrilldownWorkflow } from '../dist/statistics-drilldown.js'

const ctx = context('production', 'statistics-fixture'), jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const target = { projectId: '7001', dashboardId: 'dash-1', chartId: 'chart-1' }, selected = { ...target, selector: '/data/0' }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), envelope = value => json({ success: true, code: 200, data: value })
const flow = action => { const found = workflows.workflows.find(flow => flow.command === 'statistics project drilldown ' + (action === 'discover' ? 'discover' : action + ' list')); assert.ok(found); return found }
const run = (action, input, f, options = {}) => executeWorkflow(ctx, flow(action), input, session, { approved: true, transport: f.transport, ...options })
const code = expected => error => error.code === expected
function pack() {
  const ids = ['recA', 'recB', 'recC', 'recHidden'], fields = [{ id: 'fldTitle', name: '标题', type: 3, attr: {} }, { id: 'fldZero', name: '数字', type: 1, attr: {} }, { id: 'fldSecret', name: '隐藏', type: 3, attr: {} }]
  return { datasheet: { id: 'dstOwned', revision: 11, permissions: null }, datasheetPermission: { dstId: 'dstOwned', roleId: -1, permissionMode: 'custom', editRecordScope: 'partial', viewRecordScope: 'partial', fieldEditMode: 'custom', viewAccessScope: 'all', canCreateRecord: false, canDeleteRecord: false,
    fieldPermissions: { newAddFiled: { canView: true, canEdit: false, canAdd: false }, fields: [{ fieldId: 'fldSecret', canView: false, canEdit: false, canAdd: false }] }, matchRecordMap: Object.fromEntries(ids.map(id => [id, { canView: id !== 'recHidden' }])) },
    snapshot: { datasheetId: 'dstOwned', meta: { fieldMap: Object.fromEntries(fields.map(field => [field.id, field])), views: [{ id: 'viwOwned', columns: fields.map(field => ({ fieldId: field.id })), rows: ids.map(recordId => ({ recordId })) }] },
      recordMap: Object.fromEntries(ids.map(id => [id, { id, data: { fldTitle: [{ type: 1, text: id === 'recHidden' ? 'must-not-leak' : id }], fldZero: 0, fldSecret: [{ type: 1, text: 'must-not-leak' }] }, recordMeta: {} }])) } }
}
function fixture(options = {}) {
  const calls = [], data = pack(); let reads = 0, packReads = 0
  const kind = options.kind ?? 'risks', creationType = { tasks: 'taskCompletion', risks: 'riskStatusDistribution', workflows: 'workflowStepDelay', records: 'customDatasheet' }[kind]
  const nativeIds = kind === 'tasks' ? ['09ab-1', '09ab-2', '09ab-3'] : ['8001', '8002', '8003']
  const workflowRows = ['9007199254740993', '8102', '8103'].map((id, index) => ({ processInfoId: id, processInfoName: '流程', applicationId: '8201', applicationName: '应用', processInfoStepId: String(8301 + index), processInfoStepName: '步骤', statisticsValue: 0, status: '进行中', remainingDuration: '1天' }))
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, query, method: init.method, body })
    if (path.endsWith('/authAjax')) return json({ success: true, id: '81', username: 'fixture', token: 'fixture', team: { id: options.identity ? '8' : '7', name: 'fixture' } })
    if (path.endsWith('/member/state/independent')) return json({ vt: 'fixture', mainApp: 'rsq', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: 1, userLimit: options.capacity ? 0 : 2 })
    if (path.endsWith('/function/available')) return json(options.disabled ? [{ funcName: 'PLAN_STATISTICS', status: 'disable' }] : [])
    if (path.endsWith('/authorities/company/current')) return json({ useKanban: true })
    if (path === '/task/v1/kanbanCrud') return json({ id: options.projectMismatch ? '7999' : '7001', coverId: options.template ? '1' : null })
    if (path.endsWith('/kanbanChildCrud/list')) return json([{ id: '7101', name: 'stats', type: 'stats' }, { id: '7102', name: 'risk', type: 'risk-module' }, { id: '7103', name: 'table', type: 'datasheet', datasheetInfo: { datasheetId: 'dstOwned', mainProjectId: '7001' } }])
    if (path.endsWith('/kanbanCollection/list')) return json(options.invisibleCollection ? [] : [{ id: '7201', name: '项目集' }])
    if (path === '/task/v3/kanbanCollection') return json({ id: '7201', name: '项目集', members: [] })
    if (path.endsWith('/collection/project/list')) return json([{ kanbanId: '7001', name: '项目' }])
    if (path.endsWith('/stats/dashboard/list')) return json(options.otherDashboard ? [] : [{ id: 'dash-1', name: '仪表盘' }])
    if (path.endsWith('/stats/chart/list')) return json(options.otherChart ? [] : [{ id: 'chart-1', name: '图表' }])
    if (path.endsWith('/stats/chart')) {
      ++reads
      const metric = options.randomMetrics ? 'stt-' + reads : 'count0'
      return json({ id: 'chart-1', name: options.drift && reads > 1 ? 'changed' : '图表', creationType, chartType: 'bar',
        dataSource: { type: kind === 'workflows' ? 'workflow' : 'task', projectId: options.collection ? null : options.wrongSource ? '7999' : '7001', projectCollectionId: options.collection ? '7201' : null, isAll: true, list: [] },
        graphData: { fields: { rows: ['status'], columns: [], values: [metric], valueInCols: true }, meta: [{ field: metric, name: '数量' }], data: [{ status: 'open', [metric]: options.valueDrift && reads > 1 ? 4 : 3, detailId: 'cache-' + reads }] } })
    }
    if (path.endsWith('/risk/detail/list') || path.endsWith('/statistics/detail/task/list')) {
      if (options.detailTimeout) throw new Error('detail transport failed')
      assert.match(query.id, /^cache-/)
      const start = query.startId ? nativeIds.indexOf(query.startId) + 1 : 0, ids = options.empty ? [] : nativeIds.slice(start, start + Number(query.max))
      const list = ids.map(id => kind === 'tasks' ? { task: { id, name: '任务' }, ext: [] } : { id, name: '风险', kanbanChildId: '7102' })
      return json({ id: query.id, name: '明细', list: options.nullList ? null : list })
    }
    if (path.endsWith('/risk/detail/totalInfo')) return json({ totalValue: '3' })
    if (path.endsWith('/statistics/detail/totalInfo')) return json({ totalValue: '3', noAuthorityCount: 0 })
    if (path === '/task/v3/kanban/risk') {
      if (options.deniedNative) return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 })
      return json({ id: query.id, name: options.staleNative ? 'changed' : '风险', kanbanCardId: '7301', kanbanChildId: options.foreignResource ? '7199' : '7102', status: 0, progressList: [], note: {} })
    }
    if (path === '/task/api/v3/task') return json({ id: query.id, name: options.staleNative ? 'changed' : '任务', from: { projectId: options.foreignResource ? '7999' : '7001' } })
    if (path.endsWith('/projectStatistics/statisticsDetail')) {
      assert.deepEqual(Object.keys(query).sort(), ['dataType', 'id']); return envelope(options.cacheExpired ? {} : { name: 'stepDelay', extName: '步骤延期', list: options.empty ? null : workflowRows, type: 'step', totalInfo: '0个步骤没有查看权限，总计3个步骤' })
    }
    if (path.endsWith('/process/info/details')) return envelope({ id: query.processInfoId, flowAppId: '8201', belongToProjectId: options.foreignResource ? '7999' : '7001' })
    if (path.endsWith('/process/info/step')) return envelope({ id: options.wrongStep ? '8399' : query.stepInfoId, processInfoId: workflowRows.find(row => row.processInfoStepId === query.stepInfoId).processInfoId, applicationId: '8201' })
    if (/\/loom\/detail\/.+\/recordIds$/.test(path)) {
      assert.equal(new Headers(init.headers).get('token'), 'fixture')
      assert.match(new Headers(init.headers).get('cookie'), /JSESSIONID=fixture/)
      return envelope({ datasheetId: options.foreignTable ? 'dstForeign' : 'dstOwned', recordIds: options.duplicates ? ['recA', 'recA'] : ['recA', 'recC', 'recHidden'] })
    }
    if (path.endsWith('/dataPack')) { if (++packReads === 2 && options.revisionDrift) data.datasheet.revision++; if (options.partialViews) Object.assign(data.datasheetPermission, { viewAccessScope: 'partial', viewPermissions: [{ id: 'viwOwned', canManage: true }] }); return envelope(data) }
    if (path.endsWith('/records')) { assert.equal(init.method, 'POST'); const result = { revision: options.nativeRevision ? 99 : 11, recordMap: Object.fromEntries(body.map(id => [id, data.snapshot.recordMap[id]])) }; return envelope(result) }
    throw Error('Unexpected request ' + path)
  }
  return { transport, calls, data }
}

test('discovery binds actual project and collection and exposes selectors without cache identifiers', async () => {
  for (const collection of [false, true]) {
    const f = fixture({ collection }), input = collection ? { collectionId: '7201', dashboardId: target.dashboardId, chartId: target.chartId } : target
    const { result } = await run('discover', input, f)
    assert.equal(result.kind, 'risks'); assert.deepEqual(result.cells, [{ selector: '/data/0', values: { status: 'open', count0: 3 } }]); assert.equal(JSON.stringify(result).includes('cache-'), false)
    assert.equal(result.proof.detailCacheIsAuthorization, false); assert.match(result.contextVersion, /^[a-f0-9]{64}$/)
  }
})
test('risk native rights, module binding, total and cursor preserve exact consecutive page semantics', async () => {
  const f = fixture(), first = (await run('risks', { ...selected, limit: 2 }, f)).result
  assert.deepEqual(first.items.map(row => row.id), ['8001', '8002']); assert.equal(first.pagination.hasMore, true)
  const second = (await run('risks', { ...selected, limit: 2, cursor: first.pagination.nextCursor }, f)).result
  assert.deepEqual(second.items.map(row => row.id), ['8003']); assert.equal(second.pagination.hasMore, false)
  assert.equal(f.calls.filter(call => call.path === '/task/v3/kanban/risk').length, 3)
  assert.equal(f.calls.find(call => call.query.startId)?.query.startId, '8002'); assert.equal(first.proof.sourceRecheckedAfterRead, true)
})
test('workflow complete permission-filtered HTTP list is paged locally and keeps step fields and long IDs', async () => {
  const f = fixture({ kind: 'workflows' }), first = (await run('workflows', { ...selected, limit: 2, dataType: 'other' }, f)).result
  assert.equal(first.items[0].processInfoId, '9007199254740993'); assert.equal(first.items[0].processInfoStepName, '步骤')
  assert.equal(first.pagination.mode, 'local-over-complete-permission-filtered-http-result'); assert.equal(first.pagination.visibleTotal, 3)
  const second = (await run('workflows', { ...selected, limit: 2, dataType: 'other', cursor: first.pagination.nextCursor }, f)).result
  assert.deepEqual(second.items.map(row => row.processInfoStepId), ['8303']); assert.equal(second.permissions.totalInfo.includes('0个步骤'), true)
  assert.ok(f.calls.filter(call => call.path.endsWith('/statisticsDetail')).every(call => call.query.max === undefined && call.query.startId === undefined))
})
test('task chart detail reads permissions and verifies actual native task source for each visible page', async () => {
  const f = fixture({ kind: 'tasks' }), first = (await run('tasks', { ...selected, limit: 2 }, f)).result
  const second = (await run('tasks', { ...selected, limit: 2, cursor: first.pagination.nextCursor }, f)).result
  assert.deepEqual([...first.items, ...second.items].map(row => row.task.id), ['09ab-1', '09ab-2', '09ab-3'])
  assert.equal(f.calls.filter(call => call.path === '/task/api/v3/task').length, 3); assert.equal(first.proof.nativeResourcesReadBack, true)
})
test('datasheet chart cache selects a subset and cannot grant hidden row or field visibility', async () => {
  const f = fixture({ kind: 'records' }), first = (await run('records', { ...selected, limit: 1 }, f)).result
  assert.deepEqual(first.records.map(row => row.id), ['recA']); assert.equal(first.records[0].cells.fldZero.value, 0)
  assert.deepEqual(first.selection, { requestedTotal: 3, visibleTotal: 2, unavailableTotal: 1 }); assert.equal(JSON.stringify(first).includes('must-not-leak'), false)
  const second = (await run('records', { ...selected, limit: 1, cursor: first.pagination.nextCursor }, f)).result
  assert.deepEqual(second.records.map(row => row.id), ['recC']); assert.equal(second.pagination.hasMore, false)
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/records')).map(call => call.body), [['recA'], ['recC']])
})
test('project templates, foreign source, hidden dashboard/chart and invisible collection stop before details', async () => {
  for (const options of [{ template: true }, { projectMismatch: true }, { wrongSource: true }, { otherDashboard: true }, { otherChart: true }]) {
    const f = fixture(options); await assert.rejects(run('risks', selected, f)); assert.equal(f.calls.some(call => call.path.includes('/risk/detail/')), false)
  }
  const f = fixture({ collection: true, invisibleCollection: true }); await assert.rejects(run('discover', { collectionId: '7201', dashboardId: target.dashboardId, chartId: target.chartId }, f), code('FORBIDDEN'))
})
test('native risk/task/workflow resource belonging elsewhere is never returned as successful chart data', async () => {
  for (const kind of ['risks', 'tasks', 'workflows']) await assert.rejects(run(kind, selected, fixture({ kind, foreignResource: true })), code('FORBIDDEN'))
  await assert.rejects(run('workflows', selected, fixture({ kind: 'workflows', wrongStep: true })), code('FORBIDDEN'))
  await assert.rejects(run('risks', selected, fixture({ deniedNative: true })))
})
test('changed chart context and borrowed cursor are rejected before cache detail requests', async () => {
  const f = fixture(), discovered = (await run('discover', target, f)).result
  const changed = fixture({ drift: true }); await run('discover', target, changed)
  await assert.rejects(run('risks', { ...selected, contextVersion: discovered.contextVersion }, changed), code('CONTEXT_CONFLICT'))
  assert.equal(changed.calls.some(call => call.path.includes('/risk/detail/')), false)
  const first = (await run('risks', { ...selected, limit: 1 }, f)).result
  await assert.rejects(run('risks', { ...selected, cursor: first.pagination.nextCursor, selector: '/data/1' }, f), code('CONTEXT_MISSING'))
})
test('post-read chart drift fails verification instead of claiming an atomic snapshot', async () => {
  const f = fixture({ drift: true }); await assert.rejects(run('risks', selected, f), code('CONTEXT_CONFLICT'))
  assert.ok(f.calls.some(call => call.path === '/task/v3/kanban/risk'))
})
test('expired workflow cache is distinct from valid empty statistics and empty results prove no native resources', async () => {
  await assert.rejects(run('workflows', selected, fixture({ kind: 'workflows', cacheExpired: true })), code('STATISTICS_EXPIRED'))
  for (const kind of ['tasks', 'risks', 'workflows']) {
    const f = fixture({ kind, empty: true, nullList: true }), result = (await run(kind, selected, f)).result
    assert.deepEqual(result.items, []); assert.equal(result.proof.nativeResourcesReadBack, false); assert.equal(result.pagination.nextCursor, null)
  }
})
test('datasheet duplicates, foreign table, hidden field, partial view and revision changes stop safely', async () => {
  for (const options of [{ duplicates: true }, { foreignTable: true }, { nativeRevision: true }, { revisionDrift: true }, { partialViews: true }]) await assert.rejects(run('records', selected, fixture({ kind: 'records', ...options })))
  await assert.rejects(run('records', { ...selected, fieldIds: ['fldSecret'] }, fixture({ kind: 'records' })), code('INVALID_INPUT'))
})
test('selector, business type, datatype and invalid limits do not become guessed cache protocol', async () => {
  for (const input of [{ ...selected, selector: '/data/9' }, { ...selected, limit: 0 }, { ...selected, limit: 101 }, { ...selected, dataType: 'other' }]) {
    const f = fixture(); await assert.rejects(run('risks', input, f)); assert.equal(f.calls.some(call => call.path.includes('/risk/detail/')), false)
  }
  await assert.rejects(run('tasks', selected, fixture()), code('CONTEXT_MISMATCH'))
})
test('company expiry, capacity and disabled statistics block business HTTP before module or chart access', async () => {
  for (const options of [{ expired: true }, { capacity: true }, { disabled: true }]) {
    const f = fixture(options); await assert.rejects(run('discover', target, f)); assert.equal(f.calls.some(call => call.path.endsWith('/stats/chart') || call.path.endsWith('/kanbanCrud')), false)
  }
})
test('five commands support zero-network offline plans and four cache transports require business context', async () => {
  let sent = 0
  for (const action of ['discover', 'tasks', 'risks', 'workflows', 'records']) {
    const result = await runWorkflow(ctx, flow(action), action === 'discover' ? target : selected, null, { dryRun: true, transport: async () => { sent++; throw Error('network') } })
    assert.equal(result.dryRun, true); assert.equal(workflowSchema(flow(action)).command, flow(action).command)
  }
  for (const route of ['/task/v3/kanban/risk/detail/list', '/task/v3/kanban/risk/detail/totalInfo', '/task/workflow/projectStatistics/statisticsDetail', '/task/mt/loom/detail/{detailId}/recordIds']) {
    const operation = catalog.operations.find(operation => operation.route === route)
    await assert.rejects(executeOperation(ctx, operation, route.includes('/loom/') ? { path: { detailId: 'cache-review' } } : { query: { id: 'cache-review', ...(route.endsWith('/detail/list') && { max: 20 }) } }, session, { transport: async () => { sent++; throw Error('network') } }), code('BUSINESS_CONTEXT_REQUIRED'))
  }
  assert.equal(sent, 0)
})
test('executor rejects metadata that omits binding, changes routes, or labels context reads as pure reads', () => {
  for (const mutate of [item => item.steps.shift(), item => item.effect = 'read', item => item.steps[1].operationId = item.steps[0].operationId, item => item.steps[1].prepare = 'unknown']) {
    const changed = structuredClone(flow('risks')); mutate(changed); assert.throws(() => validateStatisticsDrilldownWorkflow(changed), code('INVALID_CONTRACT'))
  }
})
test('HTTP failure retains actual parent resources and never sends business mutations or changesets', async () => {
  const f = fixture({ detailTimeout: true })
  await assert.rejects(run('risks', selected, f), error => error.details?.automaticReplay === false && error.details.resources.projectId === '7001')
  assert.equal(f.calls.some(call => call.method !== 'GET'), false)
})
test('collection drilldowns use actual kanbanId rows and independently check each business resource', async () => {
  for (const kind of ['tasks', 'risks', 'workflows']) {
    const f = fixture({ kind, collection: true }), result = (await run(kind, { collectionId: '7201', dashboardId: target.dashboardId, chartId: target.chartId, selector: '/data/0', limit: 100 }, f)).result
    assert.equal(result.items.length, 3); assert.equal(result.collectionId, '7201'); assert.equal(result.proof.sourceRecheckedAfterRead, true)
  }
})
test('changed native task/risk attributes are conflicts rather than stale successful result semantics', async () => {
  for (const kind of ['tasks', 'risks']) await assert.rejects(run(kind, selected, fixture({ kind, staleNative: true })), code('CONTEXT_CONFLICT'))
})
test('workflow permission-result changes and datasheet field changes invalidate existing cursors', async () => {
  const options = { kind: 'workflows' }, f = fixture(options), first = (await run('workflows', { ...selected, limit: 1 }, f)).result
  options.empty = true
  await assert.rejects(run('workflows', { ...selected, limit: 1, cursor: first.pagination.nextCursor }, f), code('CONTEXT_CONFLICT'))
  const table = fixture({ kind: 'records' }), page = (await run('records', { ...selected, limit: 1, fieldIds: ['fldTitle'] }, table)).result
  await assert.rejects(run('records', { ...selected, limit: 1, fieldIds: ['fldZero'], cursor: page.pagination.nextCursor }, table), code('CONTEXT_CONFLICT'))
})
test('datasheet chart metric columns may be freshly allocated while real aggregate changes still invalidate context', async () => {
  const f = fixture({ kind: 'records', randomMetrics: true }), discovery = (await run('discover', target, f)).result
  const first = (await run('records', { ...selected, contextVersion: discovery.contextVersion, limit: 1 }, f)).result
  assert.equal(first.records.length, 1); assert.ok(first.pagination.nextCursor)
  const second = (await run('records', { ...selected, cursor: first.pagination.nextCursor, limit: 1 }, f)).result
  assert.equal(second.records.length, 1); assert.notEqual(first.records[0].id, second.records[0].id)
  const changed = fixture({ kind: 'records', randomMetrics: true, valueDrift: true }), before = (await run('discover', target, changed)).result
  await assert.rejects(run('records', { ...selected, contextVersion: before.contextVersion }, changed), code('CONTEXT_CONFLICT'))
})
