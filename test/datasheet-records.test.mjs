import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { context } from '../dist/core.js'
import { catalog } from '../dist/operations.js'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { describeDatasheet } from '../dist/datasheet.js'
import { datasheetVisibility, datasheetReadCell } from '../dist/datasheet-visibility.js'
import { datasheetRecordPage } from '../dist/datasheet-records.js'

const ctx = context('production', 'records-fixture'), jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const target = { projectId: '7001', datasheetId: 'dstOwned' }, binding = { projectId: '7001', moduleId: '7101', mainProjectId: '7001', userId: '81', teamId: '7' }
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const envelope = value => response({ success: true, code: 200, data: value })
function pack() {
  const fields = [{ id: 'fldTitle', name: '标题', type: 3, attr: {} }, { id: 'fldZero', name: '数字', type: 1, attr: {} }, { id: 'fldFalse', name: '布尔', type: 10, attr: {} }, { id: 'fldSecret', name: '隐藏字段', type: 3, attr: {} }, { id: 'fldProject', name: '归属', type: 26, attr: { isMulti: false } }]
  return { datasheet: { id: 'dstOwned', revision: 11, permissions: null },
    datasheetPermission: { dstId: 'dstOwned', roleId: -1, permissionMode: 'custom', editRecordScope: 'all', viewRecordScope: 'all', fieldEditMode: 'manageFields', viewAccessScope: 'all', canCreateRecord: true, canDeleteRecord: true },
    snapshot: { datasheetId: 'dstOwned', meta: { fieldMap: Object.fromEntries(fields.map(field => [field.id, field])), views: [
      { id: 'viwVisible', name: '可用视图', columns: fields.map(field => ({ fieldId: field.id })), rows: ['recA', 'recB', 'recC'].map(recordId => ({ recordId })) },
      { id: 'viwHidden', name: '禁止视图', columns: fields.map(field => ({ fieldId: field.id })), rows: ['recA', 'recB', 'recC'].map(recordId => ({ recordId })) },
    ] }, recordMap: Object.fromEntries(['recA', 'recB', 'recC'].map(id => [id, { id, data: { fldTitle: [{ type: 1, text: id }], fldZero: 0, fldFalse: false, fldSecret: [{ type: 1, text: 'must-not-leak' }] }, recordMeta: { projectInfo: [{ id: 7001, name: '项目' }] } }])) } }
}
function fixture(options = {}) {
  const data = pack(), calls = []; let packReads = 0
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    if (url.pathname.endsWith('/authAjax')) return response({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.otherTeam ? 8 : 7, name: '公司' } })
    if (url.pathname.endsWith('/member/state/independent')) return response({ mainApp: 'rsq', vt: 'fixture', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 3 : 1, userLimit: 2 })
    if (url.pathname.endsWith('/function/available')) return response([{ funcName: 'PLAN', status: 'enable' }, { funcName: 'PLAN_DATASHEET', status: options.disabled ? 'disable' : 'enable' }])
    if (url.pathname.endsWith('/authorities/company/current')) return response({})
    if (url.pathname === '/task/v1/kanbanCrud') { assert.equal(init.headers.get('Plan-Type'), 'template'); return response({ id: 7001, coverId: options.template ? 301 : null }) }
    if (url.pathname.endsWith('/kanbanChildCrud/list')) return response(options.noModule ? [] : [{ id: 7101, name: '数据表', type: 'datasheet', datasheetInfo: { datasheetId: 'dstOwned', mainProjectId: options.shared ? 7002 : 7001 } }])
    if (url.pathname.endsWith('/dataPack')) { assert.equal(url.searchParams.get('projectId'), '7001'); if (options.packTimeout) throw Error('lost pack acknowledgement'); if (++packReads === 2) options.refresh?.(data); return envelope(data) }
    if (url.pathname.endsWith('/records')) {
      if (options.timeout) throw Error('lost records response')
      assert.equal(init.method, 'POST'); assert.ok(body.every(id => Object.hasOwn(data.snapshot.recordMap, id)))
      const value = { revision: data.datasheet.revision, recordMap: Object.fromEntries(body.map(id => [id, structuredClone(data.snapshot.recordMap[id])])) }
      options.native?.(value)
      return envelope(value)
    }
    throw Error('unexpected ' + url.pathname)
  }
  return { data, calls, transport }
}
const flow = action => { const item = workflows.workflows.find(flow => flow.command === (action === 'describe' ? 'datasheet describe' : 'datasheet record ' + action)); assert.ok(item); return item }
const run = (action, input, f, options = {}) => executeWorkflow(ctx, flow(action), input, session, { approved: true, transport: f.transport, ...options })
const code = expected => error => error.code === expected

test('existing describe binds identity, actual project and unique module before exposing filtered metadata', async () => {
  const f = fixture(), metadata = (await run('describe', target, f)).result
  assert.equal(metadata.datasheetId, 'dstOwned'); assert.deepEqual(metadata.recordIds, ['recA', 'recB', 'recC'])
  assert.equal(f.calls.some(call => call.path.endsWith('/records')), false)
  assert.ok(f.calls.findIndex(call => call.path.endsWith('/kanbanChildCrud/list')) < f.calls.findIndex(call => call.path.endsWith('/dataPack')))
  for (const options of [{ otherTeam: true }, { template: true }, { noModule: true }]) {
    const other = fixture(options); await assert.rejects(run('describe', target, other)); assert.equal(other.calls.some(call => call.path.endsWith('/dataPack')), false)
  }
})

test('record list/get preserve zero, false, null and project metadata with independent native HTTP readback', async () => {
  const f = fixture(), first = (await run('list', { ...target, limit: 2 }, f)).result
  assert.deepEqual(first.records.map(row => row.id), ['recA', 'recB']); assert.equal(first.pagination.hasMore, true)
  assert.deepEqual(first.records[0].cells.fldZero, { encoding: 'native-stored', value: 0 }); assert.equal(first.records[0].cells.fldFalse.value, false)
  assert.deepEqual(first.records[0].cells.fldProject.value, [{ id: '7001', name: '项目' }]); assert.equal(first.proof.nativeStoredValuesReadBack, true)
  const second = (await run('list', { ...target, limit: 2, cursor: first.pagination.nextCursor }, f)).result
  assert.deepEqual(second.records.map(row => row.id), ['recC']); assert.equal(second.pagination.nextCursor, null)
  const single = (await run('get', { ...target, recordId: 'recB', fieldIds: ['fldZero'] }, f)).result
  assert.deepEqual(Object.keys(single.records[0].cells), ['fldZero']); assert.deepEqual(f.calls.filter(call => call.path.endsWith('/records')).map(call => call.body), [['recA', 'recB'], ['recC'], ['recB']])
})

test('custom field visibility follows UI fallbacks and describes neither hidden columns nor hidden row IDs', async () => {
  const f = fixture(), role = f.data.datasheetPermission
  Object.assign(role, { fieldEditMode: 'custom', viewRecordScope: 'partial', fieldPermissions: { newAddFiled: { canView: true, canEdit: false, canAdd: false }, fields: [{ fieldId: 'fldSecret', canView: false, canEdit: false, canAdd: false }, { fieldId: 'fldZero', canView: false, canAdd: true }] }, matchRecordMap: { recA: { canView: true }, recB: { canView: false }, recC: { canView: true } } })
  const result = (await run('list', target, f)).result
  assert.deepEqual(result.records.map(row => row.id), ['recA', 'recC']); assert.equal(JSON.stringify(result).includes('must-not-leak'), false); assert.equal(result.fields.some(field => field.id === 'fldSecret'), false)
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/records')).body, ['recA', 'recC'])
  const described = describeDatasheet({ context: { data: f.data } })
  assert.equal(JSON.stringify(described).includes('fldSecret'), false); assert.equal(JSON.stringify(described).includes('recB'), false)
  await assert.rejects(run('get', { ...target, recordId: 'recB' }, f), code('RESOURCE_NOT_FOUND'))
  await assert.rejects(run('get', { ...target, recordId: 'recA', fieldIds: ['fldSecret'] }, f), code('INVALID_INPUT'))
})

test('partial row/edit scope and shared projects require explicit complete canView instead of canEdit or residual filter cells', async () => {
  for (const change of [role => { role.viewRecordScope = 'partial' }, role => { role.editRecordScope = 'partial' }, (role, data) => { data.sharedData = { isOpen: true, sharedScope: 'partial' } }]) {
    const f = fixture(); change(f.data.datasheetPermission, f.data)
    await assert.rejects(run('list', target, f), code('CONTEXT_MISSING')); assert.equal(f.calls.some(call => call.path.endsWith('/records')), false)
    f.data.datasheetPermission.matchRecordMap = { recA: { canEdit: true }, recB: { canView: false }, recC: { canView: false } }
    await assert.rejects(run('list', target, f), code('CONTEXT_MISSING'))
  }
  const f = fixture({ shared: true }); f.data.sharedData = { isOpen: false }
  await assert.rejects(run('list', target, f), code('RESOURCE_FORBIDDEN'))
  f.data.sharedData.isOpen = true; f.data.datasheetPermission.matchRecordMap = Object.fromEntries(['recA', 'recB', 'recC'].map(id => [id, { canView: id === 'recB' }]))
  assert.deepEqual((await run('list', target, f)).result.records.map(row => row.id), ['recB'])
})

test('partial views do not expose unfiltered raw row IDs through describe or full-table records', async () => {
  const f = fixture(); Object.assign(f.data.datasheetPermission, { viewAccessScope: 'partial', viewPermissions: [{ id: 'viwVisible', canManage: true }, { id: 'viwHidden', canManage: false }] })
  const described = describeDatasheet({ context: { data: f.data } })
  assert.deepEqual(described.recordIds, []); assert.equal(described.recordIdsComplete, false); assert.deepEqual(described.views.map(view => view.id), ['viwVisible']); assert.deepEqual(described.views[0].rows, [])
  await assert.rejects(run('list', target, f), code('VIEW_CONTEXT_REQUIRED')); assert.equal(f.calls.some(call => call.path.endsWith('/records')), false)
})

test('describe distinguishes intrinsic field writability from effective read-only role restrictions', () => {
  const data = pack(); Object.assign(data.datasheetPermission, { permissionMode: 'readOnly', fieldEditMode: 'readOnly', editRecordScope: 'none' })
  const described = describeDatasheet({ context: { data } })
  assert.equal(described.fields.find(field => field.id === 'fldZero').intrinsicWritable, true)
  assert.equal(described.fields.every(field => field.writable === false && field.role === 'reader'), true)
  data.datasheetPermission.fieldEditMode = 'manageFields'
  assert.throws(() => datasheetVisibility(data), code('CONTEXT_MISSING'))
})

test('cursors bind actual revision, actor, project and field/row permissions; malformed and stale contexts fail', () => {
  const data = pack(), first = datasheetRecordPage(data, { limit: 1 }, binding).result, cursor = first.pagination.nextCursor
  assert.deepEqual(datasheetRecordPage(data, { cursor, limit: 1 }, binding).selected, ['recB'])
  for (const mutate of [p => { p.datasheet.revision++ }, p => { p.datasheetPermission.fieldEditMode = 'readOnly' }, p => { delete p.snapshot.recordMap.recC }]) {
    const changed = structuredClone(data); mutate(changed); assert.throws(() => datasheetRecordPage(changed, { cursor }, binding), code('CONTEXT_CONFLICT'))
  }
  for (const changed of [{ ...binding, userId: '82' }, { ...binding, moduleId: '7102' }]) assert.throws(() => datasheetRecordPage(data, { cursor }, changed), code('CONTEXT_CONFLICT'))
  assert.throws(() => datasheetRecordPage(data, { cursor, fieldIds: ['fldZero'] }, binding), code('CONTEXT_CONFLICT'))
  assert.throws(() => datasheetRecordPage(data, { expectedRevision: 10 }, binding), code('CONTEXT_CONFLICT'))
  for (const value of ['!', 'e30', Buffer.from(JSON.stringify({ version: 1, contextVersion: first.contextVersion, after: 'recA', injected: true })).toString('base64url')]) assert.throws(() => datasheetRecordPage(data, { cursor: value }, binding), code('INVALID_INPUT'))
})

test('native records must independently match the exact selected IDs, revision and stored values', async () => {
  for (const native of [value => { value.revision++ }, value => { value.recordMap.recExtra = { id: 'recExtra', data: {} } }, value => { delete value.recordMap.recA }, value => { value.recordMap.recA.data.fldZero = null }]) {
    const f = fixture({ native }); await assert.rejects(run('list', target, f), code('BUSINESS_ASSERTION_FAILED'))
    assert.equal(f.calls.filter(call => call.path.endsWith('/records')).length, 1)
  }
})

test('permission revocation and value changes during native read stop before returning stale records', async () => {
  for (const refresh of [data => { data.datasheetPermission.fieldEditMode = 'readOnly' }, data => { data.snapshot.recordMap.recA.data.fldZero = 7 }, data => { data.datasheet.revision++ }]) {
    const f = fixture({ refresh }); await assert.rejects(run('list', target, f), code('CONTEXT_CONFLICT'))
    assert.equal(f.calls.filter(call => call.path.endsWith('/records')).length, 1); assert.equal(f.calls.filter(call => call.path.endsWith('/dataPack')).length, 2)
  }
})

test('computed, generated, automatic and project cells use actual metadata and explicit encodings without erasing zero', () => {
  const record = { id: 'recA', data: { fldValue: 0 }, recordMeta: { createdBy: '90071992547409930001', createdAt: Date.parse('2026-11-08T16:30:00Z'), fieldUpdatedMap: { a: { at: 100, by: 81 }, b: { at: 200, by: 82 }, fldValue: { autoNumber: 7, computedValue: [{ value: 0 }, { value: false }, { value: null }] } }, projectInfo: [{ id: 7001, name: '甲' }, { id: 7002, name: '乙' }] } }
  const cell = (type, attr = {}) => datasheetReadCell({ id: 'fldValue', type, attr }, record)
  assert.deepEqual(cell(16).value, [0, false, null]); assert.equal(cell(24).computed, true)
  assert.deepEqual(cell(19).value, ['90071992547409930001']); assert.deepEqual(cell(20).value, ['82']); assert.equal(cell(21).value, record.recordMeta.createdAt); assert.equal(cell(22).value, 200)
  assert.equal(cell(15, { ruleList: [{ rule: 'string', text: 'NO-' }, { rule: 'createTime', format: 11 }, { rule: 'autoNumber', digit: 3 }] }).value, 'NO-20261109007')
  assert.deepEqual(cell(26, { isMulti: true }).value.map(project => project.id), ['7001', '7002']); assert.equal(cell(1).value, 0)
  assert.deepEqual(datasheetReadCell({ id: 'missing', type: 16 }, record), { encoding: 'computed-result-list', value: null, computed: false })
  record.recordMeta.fieldUpdatedMap.fldValue.computedValue = [{ value: null, displayValue: '#ERROR!' }]
  assert.deepEqual(cell(16).displayValues, ['#ERROR!'])
})

test('agent Schema keeps the concrete response contract and command-specific recovery instructions', () => {
  for (const action of ['list', 'get']) {
    const declared = workflowSchema(flow(action))
    assert.ok(declared.resultSchema.required.includes('records')); assert.ok(declared.resultSchema.required.includes('pagination'))
    assert.equal(declared.recovery, flow(action).recovery); assert.match(declared.recovery, /第一页/)
  }
})

test('empty tables skip native POST, still refresh permissions, and do not pretend a nonempty native verification', async () => {
  const f = fixture(); f.data.snapshot.recordMap = {}; for (const view of f.data.snapshot.meta.views) view.rows = []
  const result = (await run('list', target, f)).result
  assert.deepEqual(result.records, []); assert.equal(result.pagination.hasMore, false); assert.equal(result.proof.nativeStoredValuesReadBack, false)
  assert.equal(f.calls.some(call => call.path.endsWith('/records')), false); assert.equal(f.calls.filter(call => call.path.endsWith('/dataPack')).length, 2)
})

test('raw dataPack and unauthorized records transport cannot bypass business context', async () => {
  for (const command of ['form-field fetch-datasheet-pack', 'datasheet record fetch', 'datasheet transport commit']) {
    const operation = catalog.operations.find(op => op.command === command); assert.ok(operation)
    const input = command === 'datasheet transport commit' ? { body: { roomId: 'dstOwned', changesets: [{ baseRevision: 11, messageId: 'msgFixture', resourceId: 'dstOwned', resourceType: 0, operations: [] }] } } : { path: { datasheetId: 'dstOwned' }, ...(command.endsWith('fetch') && { body: ['recA'] }) }
    const f = fixture(); await assert.rejects(executeOperation(ctx, operation, input, session, { transport: f.transport, approved: true }), code('BUSINESS_CONTEXT_REQUIRED')); assert.equal(f.calls.length, 0)
  }
})

test('existing record, field and view writes enforce the same project, row, column and view boundaries', async () => {
  for (const command of ['datasheet record update', 'datasheet field delete', 'datasheet view copy']) {
    const selected = workflows.workflows.find(flow => flow.command === command), options = { ...target, recordId: 'recA', values: { fldZero: 7 }, fieldId: 'fldZero', sourceViewId: 'viwVisible', name: 'copy' }
    const input = Object.fromEntries(Object.keys(selected.inputSchema.properties).filter(key => Object.hasOwn(options, key)).map(key => [key, options[key]]))
    for (const changed of [{ template: true }, { noModule: true }, { otherTeam: true }]) {
      const f = fixture(changed)
      await assert.rejects(executeWorkflow(ctx, selected, input, session, { approved: true, transport: f.transport }))
      assert.equal(f.calls.some(call => call.path.endsWith('/dataPack') || call.path.endsWith('/changesets')), false)
    }
    const tampered = structuredClone(selected); tampered.steps.shift()
    const f = fixture(); await assert.rejects(runWorkflow(ctx, tampered, input, session, { dryRun: true, transport: f.transport }), code('INVALID_CONTRACT')); assert.equal(f.calls.length, 0)
  }
  const f = fixture(); f.data.datasheetPermission.matchRecordMap = { recA: { canView: false, canEdit: true }, recB: { canView: true }, recC: { canView: true } }
  const update = workflows.workflows.find(flow => flow.command === 'datasheet record update')
  await assert.rejects(executeWorkflow(ctx, update, { ...target, recordId: 'recA', values: { fldZero: 7 } }, session, { approved: true, transport: f.transport }), code('RESOURCE_NOT_FOUND'))
  assert.equal(f.calls.some(call => call.path.endsWith('/changesets')), false)
  const deleted = structuredClone(workflows.workflows.find(flow => flow.command === 'datasheet field delete')); deleted.effect = 'read'
  await assert.rejects(runWorkflow(ctx, deleted, { ...target, fieldId: 'fldZero' }, session, { dryRun: true, transport: f.transport }), code('INVALID_CONTRACT'))
})

test('offline dry-run, contract tampering, wrong identity, template and entitlement failures never submit native record IDs', async () => {
  for (const action of ['list', 'get']) { const f = fixture(); assert.equal((await run(action, { ...target, ...(action === 'get' && { recordId: 'recA' }) }, f, { dryRun: true })).dryRun, true); assert.equal(f.calls.length, 0) }
  for (const mutate of [f => { f.effect = 'read' }, f => { f.command = 'invented' }, f => { f.datasheetRecordsAction = 'get' }, f => { f.steps[0].assertions = [] }]) {
    const f = fixture(), command = structuredClone(flow('list')); mutate(command)
    await assert.rejects(runWorkflow(ctx, command, target, session, { dryRun: true, transport: f.transport }), code('INVALID_CONTRACT')); assert.equal(f.calls.length, 0)
  }
  for (const options of [{ otherTeam: true }, { template: true }, { noModule: true }, { expired: true }, { overCapacity: true }, { disabled: true }]) {
    const f = fixture(options); await assert.rejects(run('list', target, f)); assert.equal(f.calls.some(call => call.path.endsWith('/records')), false)
  }
})

test('a failed native read is not retried and reports only known resources and explicit completed context steps', async () => {
  const f = fixture({ timeout: true })
  await assert.rejects(run('list', target, f), error => error.details?.failedStep === 'records' && error.details.automaticReplay === false && error.details.resources.datasheetId === 'dstOwned')
  assert.equal(f.calls.filter(call => call.path.endsWith('/records')).length, 1)
  const unknownPack = fixture({ packTimeout: true })
  await assert.rejects(run('describe', target, unknownPack), error => error.details?.failedStep === 'context' && error.details.writeOutcome === 'dataPack-may-have-initialized-permission-or-computed-values')
  assert.equal(unknownPack.calls.filter(call => call.path.endsWith('/dataPack')).length, 1)
})
