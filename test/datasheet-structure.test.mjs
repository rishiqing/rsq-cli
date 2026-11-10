import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type as ot } from 'ot-json1'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { configureField, fieldContracts } from '../dist/datasheet-fields.js'

const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, approved = false) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), { datasheetId: 'dstFixture', projectId: '7001', ...input }, session, { transport, approved })
function fixture() {
  const pack = { success: true, code: 200, data: { datasheet: { id: 'dstFixture', revision: 10, permissions: Object.fromEntries(['cellEditable', 'rowCreatable', 'rowRemovable', 'fieldCreatable', 'fieldPropertyEditable', 'fieldRenamable', 'fieldRemovable', 'viewCreatable', 'viewRemovable', 'viewRenamable', 'viewFilterable', 'columnSortable', 'fieldGroupable'].map(key => [key, true])) },
    datasheetPermission: { permissionMode: 'custom', viewRecordScope: 'all', editRecordScope: 'all', viewAccessScope: 'all', fieldEditMode: 'manageFields', manageView: true }, snapshot: { datasheetId: 'dstFixture', recordMap: { recFixture: { id: 'recFixture', data: { fldTitle: [{ type: 1, text: 'fixture' }], fldCount: 12 }, recordMeta: {} } }, meta: {
      fieldMap: { fldTitle: { id: 'fldTitle', name: '标题', type: 3, attr: { defaultValue: '' } }, fldCount: { id: 'fldCount', name: '数量', type: 1, attr: { defaultValue: '', precision: 1, rate: 1, unit: '', unitAlign: 3 } } },
      views: [{ id: 'viwFixture', name: '默认表格', type: 1, columns: [{ fieldId: 'fldTitle', statType: 1 }, { fieldId: 'fldCount', statType: 8 }], rows: [{ recordId: 'recFixture' }], frozenColumnCount: 1 }],
    } } } }
  const related = structuredClone(pack); related.data.datasheet.id = related.data.snapshot.datasheetId = 'dstRelated'
  const calls = [], commits = []
  return { pack, related, calls, commits, transport: async (url, init) => {
    calls.push({ method: init.method, path: url.pathname })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true, id: 1, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (url.pathname === '/task/v1/kanbanCrud') return json({ id: '7001', name: '项目', coverId: null })
    if (url.pathname === '/task/v1/kanbanChildCrud/list') return json(['dstFixture', 'dstRelated'].map((datasheetId, index) => ({ id: String(7101 + index), name: '数据表', type: 'datasheet', datasheetInfo: { datasheetId, mainProjectId: '7001' } })))
    if (init.method === 'GET') return json(url.pathname.includes('dstRelated') ? related : pack)
    const body = JSON.parse(init.body), change = body.changesets[0]
    commits.push(change); assert.equal(change.baseRevision, pack.data.datasheet.revision)
    const previous = structuredClone(pack.data.snapshot)
    for (const operation of change.operations) pack.data.snapshot = ot.apply(pack.data.snapshot, operation.actions)
    for (const field of Object.values(pack.data.snapshot.meta.fieldMap)) if (field.type === 15 && !field.attr.nextId) {
      field.attr.nextId = pack.data.snapshot.meta.views[field.attr.viewIdx].rows.length + 1
    }
    for (const record of Object.values(pack.data.snapshot.recordMap)) if (!previous.recordMap[record.id]) {
      record.recordMeta = { ...record.recordMeta, createdAt: Date.now(), createdBy: 1, fieldUpdatedMap: {} }
      for (const field of Object.values(pack.data.snapshot.meta.fieldMap)) if (field.type === 15) {
        record.recordMeta.fieldUpdatedMap[field.id] = { autoNumber: field.attr.nextId++ }
      }
    }
    pack.data.datasheet.revision++
    return json({ success: true, code: 200, data: {} })
  } }
}

test('field definitions, option IDs, defaults and assigned values form one HTTP lifecycle', async () => {
  const server = fixture()
  const created = await run('datasheet field create', { field: { name: '状态', type: 'SingleSelect', attr: { optionList: ['待办', '完成'], defaultValue: ['待办'] } } }, server.transport)
  const fieldId = created.resources.fieldId, field = server.pack.data.snapshot.meta.fieldMap[fieldId]
  assert.equal(field.type, 7); assert.equal(field.attr.defaultValue[0], field.attr.optionList[0].id)
  assert.ok(server.pack.data.snapshot.meta.views[0].columns.some(column => column.fieldId === fieldId))
  await run('datasheet record update', { recordId: 'recFixture', values: { 状态: '完成' } }, server.transport)
  await run('datasheet field configure', { fieldId, field: { name: '阶段', required: true, attr: { optionList: ['待办'], defaultValue: [] } } }, server.transport)
  assert.equal(server.pack.data.snapshot.meta.fieldMap[fieldId].attr.optionList[0].id, field.attr.optionList[0].id)
  assert.equal(server.pack.data.snapshot.recordMap.recFixture.data[fieldId], undefined)
  await assert.rejects(run('datasheet record create', { viewId: 'viwFixture', values: { 标题: 'missing' } }, server.transport), { code: 'INVALID_FIELD_VALUE' })
  await run('datasheet field delete', { fieldId }, server.transport, true)
  assert.equal(server.pack.data.snapshot.meta.fieldMap[fieldId], undefined)
  assert.equal(server.commits.filter(change => change.operations[0].cmd === 'AddFields').length, 1)
})

test('field conversion requires explicit values and deletion resolves view and formula dependencies', async () => {
  const server = fixture(), fieldId = 'fldCount'
  await assert.rejects(run('datasheet field convert', { fieldId, field: { name: '数字转文本', type: 'SingleText' }, conversionValues: {} }, server.transport, true), { code: 'INVALID_FIELD_VALUE' })
  assert.equal(server.commits.length, 0)
  await run('datasheet field convert', { fieldId, field: { name: '数字转文本', type: 'SingleText' }, conversionValues: { recFixture: '12' } }, server.transport, true)
  assert.deepEqual(server.pack.data.snapshot.recordMap.recFixture.data[fieldId], [{ type: 1, text: '12' }])
  const formula = await run('datasheet field create', { field: { name: '引用', type: 'Formula', attr: { expression: '$_fldCount_$' } } }, server.transport)
  await assert.rejects(run('datasheet field delete', { fieldId }, server.transport, true), error => error.code === 'DEPENDENCY_EXISTS' && error.details.cause.fieldIds.includes(formula.resources.fieldId))
  await run('datasheet field delete', { fieldId: formula.resources.fieldId }, server.transport, true)
  const view = server.pack.data.snapshot.meta.views[0]
  view.filterInfo = { conjunction: 'and', conditions: [{ fieldId, fieldType: 3, operator: 'is', conditionId: 'x', useFieldValue: false, value: ['12'] }] }
  view.groupInfo = [{ fieldId }]; view.sortInfo = { rules: [{ fieldId }], keepSort: true }; view.frozenColumnCount = 2
  await run('datasheet field delete', { fieldId }, server.transport, true)
  const final = server.pack.data.snapshot.meta.views[0]
  assert.equal(final.filterInfo, undefined); assert.equal(final.groupInfo, undefined); assert.equal(final.sortInfo, undefined); assert.equal(final.frozenColumnCount, 1)
  await assert.rejects(run('datasheet field delete', { fieldId: 'fldTitle' }, server.transport, true), { code: 'INVALID_FIELD_VALUE' })
})

test('link fields fetch target context and reject missing fields, cycles, bad attributes and denied roles before commit', async () => {
  const server = fixture()
  const created = await run('datasheet field create', { field: { name: '关联', type: 'Link', attr: { linkDatasheetId: 'dstRelated', customFieldIds: ['fldTitle'] } } }, server.transport)
  assert.ok(created.completedSteps.includes('related')); assert.ok(server.calls.some(call => call.path.includes('dstRelated')))
  const commits = server.commits.length
  await assert.rejects(run('datasheet field configure', { fieldId: created.resources.fieldId, field: { attr: { customFieldIds: ['fldAbsent'] } } }, server.transport), { code: 'INVALID_FIELD_VALUE' })
  await assert.rejects(run('datasheet field create', { field: { name: '公式', type: 'Formula', attr: { expression: '$_fldAbsent_$+1' } } }, server.transport), { code: 'INVALID_FIELD_DEFINITION' })
  await assert.rejects(run('datasheet field create', { field: { name: '日期', type: 'DateTime', attr: { timeZone: 'Bad/Zone' } } }, server.transport), { code: 'INVALID_FIELD_DEFINITION' })
  server.pack.data.datasheetPermission.fieldEditMode = 'editAll'
  await assert.rejects(run('datasheet field configure', { fieldId: 'fldCount', field: { name: 'rename' } }, server.transport), { code: 'FORBIDDEN' })
  assert.equal(server.commits.length, commits)
  assert.equal(configureField({ name: '公式常量', type: 'Formula', attr: { expression: '"fldAbsent"' } }, undefined, [], 'dstFixture', 0).type, 16)
  assert.equal(fieldContracts.types.length, 26)
})

test('related fields verify the actual target project and owning module before fetching a pack, then enforce its visible columns', async () => {
  const field = { name: '跨项目关联', type: 'Link', attr: { projectId: 7002, linkDatasheetId: 'dstRelated', customFieldIds: ['fldTitle'] } }
  for (const branch of ['valid', 'template', 'missing-module', 'shared-reference', 'hidden-column', 'partial-view']) {
    const server = fixture(); let targetPacks = 0, targetProjectReads = 0, targetModuleReads = 0
    if (branch === 'hidden-column') Object.assign(server.related.data.datasheetPermission, { fieldEditMode: 'custom', fieldPermissions: { fields: [], newAddFiled: { canView: false, canEdit: false, canAdd: false } } })
    if (branch === 'partial-view') Object.assign(server.related.data.datasheetPermission, { viewAccessScope: 'partial', viewPermissions: [{ id: 'viwFixture', canManage: true }] })
    const transport = async (url, init) => {
      if (url.pathname === '/task/v1/kanbanCrud' && url.searchParams.get('id') === '7002') { targetProjectReads++; return json({ id: '7002', name: '目标项目', coverId: branch === 'template' ? '8001' : null }) }
      if (url.pathname === '/task/v1/kanbanChildCrud/list' && url.searchParams.get('kanbanId') === '7002') {
        targetModuleReads++; return json(branch === 'missing-module' ? [] : [{ id: '7201', name: '目标数据表', type: 'datasheet', datasheetInfo: { datasheetId: 'dstRelated', mainProjectId: branch === 'shared-reference' ? '7003' : '7002' } }])
      }
      if (url.pathname === '/task/mt/datasheet/dstRelated/dataPack') { targetPacks++; assert.equal(targetProjectReads, 1); assert.equal(targetModuleReads, 1); assert.equal(url.searchParams.get('projectId'), '7002') }
      return server.transport(url, init)
    }
    if (branch === 'valid') {
      const result = await run('datasheet field create', { field }, transport)
      assert.equal(result.completedSteps.includes('relatedProject'), true); assert.equal(targetPacks, 1); assert.equal(server.commits.length, 1)
    } else {
      await assert.rejects(run('datasheet field create', { field }, transport), { code: branch === 'hidden-column' ? 'INVALID_FIELD_VALUE' : branch === 'partial-view' ? 'VIEW_CONTEXT_REQUIRED' : 'CONTEXT_MISMATCH' })
      assert.equal(server.commits.length, 0)
      if (['template', 'missing-module', 'shared-reference'].includes(branch)) assert.equal(targetPacks, 0)
    }
  }
})

test('field permission editor disable flags do not revoke a separate explicit cell edit permission', async () => {
  const server = fixture()
  Object.assign(server.pack.data.datasheetPermission, { fieldEditMode: 'custom', fieldPermissions: { fields: [{ fieldId: 'fldCount', canView: true, canEdit: true, canAdd: false, disable: true }], newAddFiled: { canView: false, canEdit: false, canAdd: false } } })
  await run('datasheet record update', { recordId: 'recFixture', values: { 数量: 0 } }, server.transport)
  assert.equal(server.pack.data.snapshot.recordMap.recFixture.data.fldCount, 0)
})

test('grid and kanban views create, preserve copied settings, enforce per-view permissions and retain one view', async () => {
  const server = fixture()
  const select = await run('datasheet field create', { field: { name: '阶段', type: 'SingleSelect', attr: { optionList: ['新建', '完成'] } } }, server.transport)
  const created = await run('datasheet view create', { sourceViewId: 'viwFixture', name: '看板', type: 'Kanban', groupFieldId: select.resources.fieldId }, server.transport)
  const viewId = created.resources.viewId
  const copied = await run('datasheet view copy', { sourceViewId: viewId, name: '看板副本' }, server.transport)
  const view = server.pack.data.snapshot.meta.views.find(view => view.id === copied.resources.viewId)
  assert.equal(view.type, 2); assert.equal(view.style.kanbanFieldId, select.resources.fieldId); assert.deepEqual(view.rows, [{ recordId: 'recFixture' }])
  server.pack.data.datasheetPermission.viewPermissions = [{ id: viewId, canManage: false }]
  await assert.rejects(run('datasheet view delete', { viewId }, server.transport, true), { code: 'FORBIDDEN' })
  server.pack.data.datasheetPermission.viewPermissions = []
  await run('datasheet view delete', { viewId }, server.transport, true)
  await run('datasheet view delete', { viewId: copied.resources.viewId }, server.transport, true)
  await assert.rejects(run('datasheet view delete', { viewId: 'viwFixture' }, server.transport, true), { code: 'INVALID_FIELD_VALUE' })
  assert.equal(server.pack.data.snapshot.meta.views.length, 1)
})

test('null node permissions use the actual role; partial records and custom field add-only rules are respected', async () => {
  const server = fixture()
  server.pack.data.datasheet.permissions = null
  Object.assign(server.pack.data.datasheetPermission, { editRecordScope: 'all', canCreateRecord: true, canDeleteRecord: true })
  await run('datasheet field create', { field: { name: '角色允许', type: 'SingleText' } }, server.transport)
  server.pack.data.datasheet.permissions = null
  Object.assign(server.pack.data.datasheetPermission, { editRecordScope: 'partial', matchRecordMap: { recFixture: { canView: true, canEdit: false } } })
  await assert.rejects(run('datasheet record update', { recordId: 'recFixture', values: { 数量: 99 } }, server.transport), { code: 'FORBIDDEN' })
  const commits = server.commits.length
  server.pack.data.datasheet.permissions = null
  delete server.pack.data.datasheetPermission.matchRecordMap
  Object.assign(server.pack.data.datasheetPermission, { editRecordScope: 'all', fieldEditMode: 'custom', fieldPermissions: { fields: [{ fieldId: 'fldCount', canView: true, canEdit: false, canAdd: true }], newAddFiled: { canView: true, canEdit: false, canAdd: false } } })
  await assert.rejects(run('datasheet record update', { recordId: 'recFixture', values: { 数量: 99 } }, server.transport), { code: 'FORBIDDEN' })
  assert.equal(server.commits.length, commits)
  delete server.pack.data.snapshot.recordMap.recFixture.data.fldCount
  await run('datasheet record update', { recordId: 'recFixture', values: { 数量: 99 } }, server.transport)
  server.pack.data.datasheet.permissions = null
  server.pack.data.datasheetPermission.fieldEditMode = 'readOnly'
  await assert.rejects(run('datasheet record update', { recordId: 'recFixture', values: { 数量: 12 } }, server.transport), { code: 'FORBIDDEN' })
})

test('AutoNumber initialization and server record metadata are verified without masking incorrect definitions or replaying writes', async () => {
  const server = fixture()
  server.pack.data.sharedData = { isOpen: false, sharedScope: 'all' }
  const created = await run('datasheet field create', { field: { name: '序号', type: 'AutoNumber' } }, server.transport)
  const fieldId = created.resources.fieldId
  assert.equal(server.pack.data.snapshot.meta.fieldMap[fieldId].attr.nextId, 2)
  await run('datasheet field configure', { fieldId, field: { desc: 'preserve generated sequence' } }, server.transport)
  const record = await run('datasheet record create', { viewId: 'viwFixture', values: { 标题: 'new' } }, server.transport)
  assert.equal(server.pack.data.snapshot.recordMap[record.resources.recordId].recordMeta.fieldUpdatedMap[fieldId].autoNumber, 2)
  const calls = server.commits.length
  await assert.rejects(run('datasheet field configure', { fieldId, field: { desc: 'detect wrong normalization' } }, async (url, init) => {
    const response = await server.transport(url, init)
    if (init.method === 'POST') server.pack.data.snapshot.meta.fieldMap[fieldId].attr.nextId++
    return response
  }), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.cause.mismatchPaths.some(path => path.join('/') === 'meta/fieldMap/' + fieldId + '/attr/nextId'))
  assert.equal(server.commits.length, calls + 1)
})

test('record creation discovers the shared project association and derives unambiguous filter/group defaults with explicit values taking precedence', async () => {
  const server = fixture(), fields = server.pack.data.snapshot.meta.fieldMap, view = server.pack.data.snapshot.meta.views[0]
  fields.fldStatus = { id: 'fldStatus', name: '阶段', type: 7, attr: { optionList: [{ id: 'optNew', name: '新建', color: 0 }, { id: 'optDone', name: '完成', color: 1 }], defaultValue: [] } }
  view.groupInfo = [{ fieldId: 'fldStatus' }]
  view.filterInfo = { conjunction: 'and', conditions: [{ fieldId: 'fldCount', fieldType: 1, operator: 'is', useFieldValue: false, value: ['0'], conditionId: 'filter-count' }] }
  server.pack.data.sharedData = { isOpen: true }
  const transport = async (url, init) => {
    if (url.pathname === '/task/v1/kanbanCrud') return json({ id: '7001', name: 'current project', coverId: null })
    if (url.pathname === '/task/v1/kanbanChildCrud/list') return json([{ id: '7101', name: 'table module', type: 'datasheet', datasheetInfo: { datasheetId: 'dstFixture', mainProjectId: '7002' } }])
    if (url.pathname.endsWith('/dataPack')) server.pack.data.datasheetPermission.matchRecordMap = Object.fromEntries(Object.keys(server.pack.data.snapshot.recordMap).map(id => [id, { canView: true, canEdit: true }]))
    return server.transport(url, init)
  }
  await assert.rejects(run('datasheet record create', { projectId: undefined, viewId: view.id, values: { 标题: 'requires project' } }, transport), { code: 'INVALID_INPUT' })
  const created = await run('datasheet record create', { projectId: '7001', viewId: view.id, values: { 标题: 'new', 阶段: '完成' }, groupValues: { 阶段: '新建' } }, transport)
  const record = server.pack.data.snapshot.recordMap[created.resources.recordId]
  assert.equal(record.data.fldCount, 0); assert.deepEqual(record.data.fldStatus, ['optDone'])
  assert.deepEqual(record.recordMeta.projectInfo, [{ id: '7001', name: 'current project' }])
  await assert.rejects(run('datasheet record create', { projectId: '7001', viewId: view.id, values: { 标题: 'x' }, groupValues: { 数量: 7 } }, transport), { code: 'INVALID_FIELD_VALUE' })
})
