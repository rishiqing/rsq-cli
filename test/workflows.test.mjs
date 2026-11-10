import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { type as ot } from 'ot-json1'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { normalizeCell, prepareDatasheet } from '../dist/datasheet.js'

const ctx = { environment: 'production', profile: 'fixture' }
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Secure; HttpOnly; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture-token', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = command => workflows.workflows.find(f => f.command === command)
const run = (command, input, transport, options = {}) => runWorkflow(ctx, flow(command), command.startsWith('datasheet ') ? { projectId: '7001', ...input } : input, session, { transport, ...options })

test('project templates preserve cover/project identity and template headers throughout CRUD and application', async () => {
  let template, project; const calls = []
  const transport = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, path: url.pathname, template: init.headers.get('Plan-Type'), body })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true,id: 1,username: 'fixture',token: 'fixture',team: { id: 7,name: '公司' } })
    if (url.pathname.endsWith('/company/current')) return json({ editKanbanGroup: true,editKanbanTemp: true })
    if (url.pathname === '/task/v3/kanbanGroup/list') return json([])
    if (url.pathname === '/task/v1/department/list') return json([{ id: 100,name: '公司',type: 'top',parentId: null,displayOrder: 0,leaderList: [],userList: [{ id: 1,showName: '自己' }],childList: [] }])
    if (url.pathname === '/task/v4/template' && init.method === 'GET') return json(template)
    if (url.pathname === '/task/v4/template/detailList') return json(url.searchParams.get('id') === 'my' && template ? [template] : [])
    assert.equal(url.pathname, '/task/v1/kanbanCrud')
    if (init.method === 'POST' && init.headers.get('Plan-Type') === 'template') {
      assert.equal(body.templateKanbanId, undefined)
      template = { id: '8001', templateKanbanId: '7001', name: body.name, description: '',withEdit: true,needLevelUp: false }
      return json({ id: '7001', coverId: '8001' })
    }
    if (init.method === 'PUT') {
      assert.equal(init.headers.get('Plan-Type'), 'template'); assert.equal(body.id, '7001')
      Object.assign(template, body); template.id = '8001'
      return json({ id: '7001' })
    }
    if (init.method === 'POST') {
      assert.equal(init.headers.get('Plan-Type'), null); assert.equal(body.templateKanbanId, '7001')
      project = { id: '9001', name: body.name,coverId: null }; return json(project)
    }
    if (init.method === 'GET') {
      assert.equal(url.searchParams.get('id'), '9001'); assert.equal(url.searchParams.get('isDefault'), 'false')
      return json(project)
    }
    assert.equal(init.method, 'DELETE'); assert.equal(init.headers.get('Plan-Type'), 'template'); assert.equal(url.searchParams.get('id'), '7001')
    template = null; return new Response('')
  }
  const created = await run('project template create', { name: 'fixture template', attribute: 'person' }, transport)
  assert.deepEqual(created.resources, { templateKanbanId: '7001', coverId: '8001' })
  const updated = await run('project template update', { coverId: '8001', name: 'changed', description: '' }, transport)
  assert.equal(updated.result.name, 'changed'); assert.equal(updated.result.description, '')
  const applied = await run('project template apply', { coverId: '8001', name: 'ordinary', attribute: 'person' }, transport)
  assert.equal(applied.resources.projectId, '9001')
  assert.equal((await run('project template delete', { coverId: '8001' }, transport, { approved: true })).result.deleted, true)
  assert.equal(calls.filter(c => c.method === 'POST').length, 2)
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1)
})

test('workflows validate and confirm before requests; dry-run remains offline without revealing values', async () => {
  let calls = 0; const transport = async () => { calls++; throw Error('unexpected') }
  const preview = await run('project template create', { name: 'private name', attribute: 'person' }, transport, { dryRun: true })
  assert.ok(preview.steps.some(step => step.id === 'created')); assert.ok(preview.steps.some(step => step.id === 'verifiedCatalogue')); assert.ok(!JSON.stringify(preview).includes('private name'))
  await assert.rejects(run('project template delete', { coverId: '8001' }, transport), { code: 'CONFIRMATION_REQUIRED' })
  await assert.rejects(run('project template update', { coverId: '8001' }, transport), { code: 'INVALID_INPUT' })
  await assert.rejects(run('project template create', { name: '', attribute: 'person' }, transport), { code: 'INVALID_INPUT' })
  assert.equal(calls, 0)
  assert.equal(workflowSchema(flow('datasheet record update')).context.find(step => step.id === 'commit').prepare, 'record-update')
})

test('partial success preserves created resource IDs; unknown writes are never replayed', async () => {
  let calls = 0,posts = 0
  const context = url => url.pathname.endsWith('/authAjax') ? { success: true,id: 1,username: 'fixture',token: 'fixture',team: { id: 7,name: '公司' } } : { editKanbanGroup: true }
  await assert.rejects(run('project template create', { name: 'fixture', attribute: 'person' }, async (url,init) => {
    calls++
    if (init.method === 'POST') { posts++;return json({ id: '7001', coverId: '8001' }) }
    if (url.pathname !== '/task/v4/template') return json(context(url))
    return new Response(null, { status: 403 })
  }), error => {
    assert.equal(error.code, 'FORBIDDEN'); assert.deepEqual(error.details.completedSteps, ['identity','company','created'])
    assert.equal(error.details.resources.coverId, '8001'); assert.equal(error.details.failedStep, 'template'); return true
  })
  assert.equal(calls, 4);assert.equal(posts,1)
  calls = 0;posts = 0
  await assert.rejects(run('project template create', { name: 'fixture', attribute: 'person' }, async (url,init) => { calls++;if (init.method !== 'POST') return json(context(url));posts++;throw Error('fixture-token') }), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.writeOutcome, 'unknown'); assert.ok(!JSON.stringify(error).includes('fixture-token')); return true
  })
  assert.equal(calls, 3);assert.equal(posts,1)
  const brokenOutput = { ...flow('project template categories list'), output: { $result: '/absent' } }
  await assert.rejects(runWorkflow(ctx, brokenOutput, {}, session, { transport: async () => json([]) }), error => {
    assert.equal(error.details.failedStep, 'output'); assert.deepEqual(error.details.completedSteps, ['categories']); return true
  })
})

function dataPack() {
  return { success: true, code: 200, data: { datasheet: { id: 'dstFixture', revision: 4, permissions: { rowCreatable: true, rowRemovable: true, cellEditable: true, viewRenamable: true, descriptionEditable: true, viewFilterable: true, columnSortable: true, fieldGroupable: true } },
    snapshot: { datasheetId: 'dstFixture', meta: { fieldMap: {
      fldText: { id: 'fldText', name: '标题', type: 3, attr: null }, fldSelect: { id: 'fldSelect', name: '状态', type: 7, attr: { optionList: [{ id: 'optOpen', name: '未完成' }, { id: 'optDone', name: '已完成' }] } },
      fldFormula: { id: 'fldFormula', name: '公式', type: 16, attr: {} }, fldNumber: { id: 'fldNumber', name: '数字', type: 1, attr: {} },
    }, views: [{ id: 'viwFixture', name: '表格', rows: [{ recordId: 'recFixture' }], columns: [{ fieldId: 'fldText' }, { fieldId: 'fldSelect' }] }] },
    recordMap: { recFixture: { id: 'recFixture', data: { fldText: [{ type: 1, text: 'old' }], fldSelect: ['optOpen'] }, recordMeta: {} } } }, datasheetPermission: { permissionMode: 'custom', fieldEditMode: 'manageFields', viewRecordScope: 'all', editRecordScope: 'all', viewAccessScope: 'all', canCreateRecord: true, canDeleteRecord: true } } }
}
function dataServer(pack = dataPack(), { conflict = false, unchanged = false } = {}) {
  const calls = [], commits = []
  return { pack, calls, commits, transport: async (url, init) => {
    calls.push(init.method)
    if (url.pathname.endsWith('/authAjax')) return json({ success: true, id: 1, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (url.pathname === '/task/v1/kanbanCrud') return json({ id: '7001', name: '项目', coverId: null })
    if (url.pathname === '/task/v1/kanbanChildCrud/list') return json([{ id: '7101', name: '数据表', type: 'datasheet', datasheetInfo: { datasheetId: 'dstFixture', mainProjectId: '7001' } }])
    assert.equal(init.headers.get('cookie'), 'JSESSIONID=fixture'); assert.equal(init.headers.get('token'), 'fixture-token')
    if (init.method === 'GET') return json(pack)
    assert.equal(url.pathname, '/task/mt/resource/apply/changesets')
    const body = JSON.parse(init.body); assert.equal(body.roomId, 'dstFixture'); assert.equal(body.changesets.length, 1)
    const change = body.changesets[0]; commits.push(change)
    assert.equal(change.baseRevision, pack.data.datasheet.revision); assert.equal(change.resourceType, 0)
    if (conflict) return new Response(null, { status: 409 })
    if (!unchanged) {
      for (const op of change.operations) pack.data.snapshot = ot.apply(pack.data.snapshot, op.actions)
      pack.data.datasheet.revision++
    }
    return json({ success: true, data: {} })
  } }
}

test('HTTP data table updates resolve options and text encoding, then verify revision and content', async () => {
  const server = dataServer()
  const result = await run('datasheet record update', { datasheetId: 'dstFixture', recordId: 'recFixture', values: { 标题: '中文', 状态: '已完成', 数字: 0 } }, server.transport)
  assert.equal(result.result.revision, 5); assert.deepEqual(server.calls, ['GET', 'GET', 'GET', 'GET', 'POST', 'GET'])
  assert.deepEqual(server.pack.data.snapshot.recordMap.recFixture.data, { fldText: [{ type: 1, text: '中文' }], fldSelect: ['optDone'], fldNumber: 0 })
  assert.equal(server.commits[0].operations[0].cmd, 'SetRecords')
  await run('datasheet record update', { datasheetId: 'dstFixture', recordId: 'recFixture', values: { 标题: null } }, server.transport)
  assert.equal(Object.hasOwn(server.pack.data.snapshot.recordMap.recFixture.data, 'fldText'), false)
})

test('data table record create/delete maintains all view rows and HTTP final assertions', async () => {
  const server = dataServer()
  const created = await run('datasheet record create', { datasheetId: 'dstFixture', viewId: 'viwFixture', values: { 标题: 'created' } }, server.transport)
  const recordId = created.resources.recordId
  assert.match(recordId, /^rec/); assert.ok(server.pack.data.snapshot.recordMap[recordId]); assert.ok(server.pack.data.snapshot.meta.views[0].rows.some(row => row.recordId === recordId))
  await run('datasheet record delete', { datasheetId: 'dstFixture', recordId }, server.transport, { approved: true })
  assert.equal(Object.hasOwn(server.pack.data.snapshot.recordMap, recordId), false)
  assert.equal(server.pack.data.snapshot.meta.views[0].rows.some(row => row.recordId === recordId), false)
})

test('stale versions, read-only fields, denied rows and ambiguous field names stop data table writes', async () => {
  for (const [mutate, input, code] of [
    [() => {}, { expectedRevision: 3, values: { 标题: 'new' } }, 'CONTEXT_STALE'],
    [() => {}, { values: { 公式: 1 } }, 'INVALID_FIELD_VALUE'],
    [p => { p.data.datasheet.permissions.cellEditable = false }, { values: { 标题: 'new' } }, 'FORBIDDEN'],
    [p => { p.data.datasheetPermission.matchRecordMap = { recFixture: { canView: true, canEdit: false } } }, { values: { 标题: 'new' } }, 'FORBIDDEN'],
    [p => { p.data.snapshot.meta.fieldMap.fldDuplicate = { id: 'fldDuplicate', name: '标题', type: 3 } }, { values: { 标题: 'new' } }, 'AMBIGUOUS_CONTEXT'],
    [() => {}, { values: { 标题: 'old' } }, 'NO_CHANGES'],
  ]) {
    const server = dataServer(); mutate(server.pack)
    await assert.rejects(run('datasheet record update', { datasheetId: 'dstFixture', recordId: 'recFixture', ...input }, server.transport), { code })
    assert.deepEqual(server.calls, ['GET', 'GET', 'GET', 'GET'])
  }
  assert.deepEqual(normalizeCell({ id: 'f', type: 9 }, '2026-11-07T01:00:00+08:00'), Date.parse('2026-11-07T01:00:00+08:00'))
  assert.throws(() => normalizeCell({ id: 'f', type: 9 }, '2026-11-07'), { code: 'INVALID_FIELD_VALUE' })
  assert.throws(() => normalizeCell({ id: 'f', type: 7, attr: { optionList: [] } }, 'unknown'), { code: 'CONTEXT_NOT_FOUND' })
})

test('data table version conflicts and unobserved commits preserve IDs and never retry', async () => {
  for (const [config, code, expected] of [[{ conflict: true }, 'HTTP_ERROR', ['GET', 'GET', 'GET', 'GET', 'POST']], [{ unchanged: true }, 'BUSINESS_ASSERTION_FAILED', ['GET', 'GET', 'GET', 'GET', 'POST', 'GET']]]) {
    const server = dataServer(dataPack(), config)
    await assert.rejects(run('datasheet record update', { datasheetId: 'dstFixture', recordId: 'recFixture', values: { 标题: 'new' } }, server.transport), error => {
      assert.equal(error.code, code); assert.ok(error.details.resources.messageId); assert.equal(error.details.resources.recordId, 'recFixture'); return true
    })
    assert.deepEqual(server.calls, expected); assert.equal(server.commits.length, 1)
  }
  const results = { context: dataPack() }
  results.context.data.snapshot.datasheetId = 'dstOther'
  assert.throws(() => prepareDatasheet('record-update', { datasheetId: 'dstFixture', recordId: 'recFixture', values: { 标题: 'new' } }, results), { code: 'CONTEXT_MISMATCH' })
})
