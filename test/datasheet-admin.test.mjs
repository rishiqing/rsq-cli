import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { executeWorkflow } from '../dist/dispatch.js'
import { validateDatasheetAdminWorkflow } from '../dist/datasheet-admin.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), envelope = data => json({ success: true, code: 200, ...(data !== undefined && { data }) })
const route = '/task/v1/kanbanChildCrud', target = { projectId: '7001', datasheetId: 'dstSource' }
const permissions = { editKanbanChild: true, copyKanbanChild: true, moveKanbanChild: true, removeKanbanChild: true, dataManage: true }
function fixture(options = {}) {
  let nextModule = 7103, nextRole = 702, copyReads = 0, queued
  const calls = [], projects = new Map(['7001', '7002'].map(id => [id, { id, name: '项目' + id, coverId: options.template ? '301' : null, editControl: { createKanbanChild: !options.cannotCreate } }]))
  const modules = new Map([['7101', { id: '7101', kanbanId: '7001', name: '源表', type: 'datasheet', editControl: { ...permissions, ...options.permissions }, datasheetInfo: { datasheetId: 'dstSource', viewId: 'viwGrid', mainProjectId: options.shared ? '7002' : '7001' } }],
    ['7102', { id: '7102', kanbanId: '7001', name: '任务', type: 'task' }], ['7201', { id: '7201', kanbanId: '7002', name: '任务', type: 'task' }]])
  const meta = { fieldMap: { fldTitle: { id: 'fldTitle', name: '标题', type: 3, attr: { defaultValue: '' } }, fldStatus: { id: 'fldStatus', name: '状态', type: 7, attr: { optionList: [{ id: 'optA', name: '待办', color: 1 }], defaultValue: [] } } },
    views: [{ id: 'viwGrid', name: '表格', type: 1, columns: [{ fieldId: 'fldTitle' }, { fieldId: 'fldStatus' }], rows: [{ recordId: 'recSource' }] }, { id: 'viwBoard', name: '另一个视图', type: 1, columns: [{ fieldId: 'fldTitle' }], rows: [{ recordId: 'recSource' }] }] }
  const defaultPermission = roleId => ({ dstId: 'dstSource', roleId, permissionMode: 'custom', canCreateRecord: true, canDeleteRecord: true, editRecordScope: 'all', viewRecordScope: 'all', recordEditFilterInfo: null, recordViewFilterInfo: null, fieldEditMode: 'manageFields', fieldPermissions: null, manageView: true, viewAccessScope: 'all', viewPermissions: null, members: [] })
  const packs = new Map([['dstSource', { datasheet: { id: 'dstSource', name: '源表', revision: 8, permissions: null }, datasheetPermission: defaultPermission(-1),
    snapshot: { datasheetId: 'dstSource', meta, recordMap: { recSource: { id: 'recSource', data: { fldTitle: [{ type: 1, text: '内容' }], fldStatus: ['optA'] }, recordMeta: { projectInfo: [{ id: '7001', name: '源项目' }] } } } } }]])
  const roleRows = new Map([[701, { roleId: 701, name: '原角色', datasheetId: 'dstSource' }]]), rolePermissions = new Map([[-1, defaultPermission(-1)], [701, { ...defaultPermission(701), members: [{ id: 81, showName: '本人' }] }]])
  const shared = { dstId: 'dstSource', isOpen: false, sharedScope: 'all', memberIds: [81] }
  const finishCopy = () => {
    if (!queued) return
    const newId = String(nextModule++), tableId = 'dstCopy' + newId, copy = structuredClone(packs.get('dstSource'))
    copy.datasheetPermission.dstId = tableId; copy.datasheet.id = tableId; copy.datasheet.name = queued.name; copy.snapshot.datasheetId = tableId
    for (const record of Object.values(copy.snapshot.recordMap)) record.recordMeta = {}
    if (options.badCopy) copy.snapshot.recordMap.recSource.data.fldTitle = '丢失的内容'
    packs.set(tableId, copy); modules.set(newId, { id: newId, kanbanId: queued.kanbanId, name: queued.name, type: 'datasheet', editControl: { ...permissions }, datasheetInfo: { datasheetId: tableId, viewId: 'viwGrid', mainProjectId: queued.kanbanId } }); queued = null
  }
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, q = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query: q, body })
    if (path.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', token: 'fixture', success: true, team: { id: options.otherTeam ? 8 : 7, name: '公司' } })
    if (path.endsWith('/member/state/independent')) return json({ mainApp: 'rsq', vt: 'fixture', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 3 : 1, userLimit: 2 })
    if (path.endsWith('/function/available')) return json([{ funcName: 'PLAN', status: 'enable' }, { funcName: 'PLAN_DATASHEET', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/authorities/company/current')) return json({})
    if (path === '/task/v1/kanbanCrud') return json(projects.get(q.id))
    if (path === route + '/list') {
      if (queued && !options.copyPending && ++copyReads >= 2) finishCopy()
      return json([...modules.values()].filter(module => module.kanbanId === q.kanbanId))
    }
    if (path === route && method === 'POST') {
      const moduleId = String(nextModule++), datasheetId = body.datasheetId ?? 'dstNew' + moduleId
      if (!body.datasheetId) { const value = structuredClone(packs.get('dstSource')); value.datasheetPermission.dstId = datasheetId; value.datasheet.id = datasheetId; value.datasheet.name = body.name; value.snapshot.datasheetId = datasheetId; value.snapshot.recordMap = {}; for (const view of value.snapshot.meta.views) view.rows = []; packs.set(datasheetId, value) }
      const row = { id: moduleId, kanbanId: body.kanbanId, name: body.name, type: 'datasheet', editControl: { ...permissions }, datasheetInfo: { datasheetId, viewId: 'viwGrid', mainProjectId: body.datasheetId ? '7001' : body.kanbanId } }; modules.set(moduleId, row)
      if (options.unknownCreate) return json({ id: moduleId, type: 'datasheet', name: 123 })
      return json(row)
    }
    if (path === route && method === 'PUT') { const row = modules.get(body.id); row.name = body.name; if (row.datasheetInfo.mainProjectId === row.kanbanId) packs.get(row.datasheetInfo.datasheetId).datasheet.name = body.name; return json(row) }
    if (path === route && method === 'DELETE') { const row = modules.get(q.id); modules.delete(q.id); if (row.datasheetInfo.mainProjectId === row.kanbanId) packs.delete(row.datasheetInfo.datasheetId); return new Response(null) }
    if (path === '/task/v4/kanbanChild/copy') { queued = body; if (options.copyTimeout) { finishCopy(); throw Error('lost acknowledgement') } return json({ type: 'ws' }) }
    if (path === '/task/v1/kanbanChild/move') { const row = modules.get(body.id); row.kanbanId = body.kanbanId; row.datasheetInfo.mainProjectId = body.kanbanId; return json(row) }
    if (path === '/task/v1/kanbanChild/datasheet/creatableShareList') return json(shared.isOpen ? [{ datasheetId: 'dstSource', name: '源表' }] : [])
    const packMatch = /^\/task\/mt\/datasheet\/([^/]+)\/dataPack$/.exec(path)
    if (packMatch) { assert.ok(packs.has(packMatch[1])); return envelope(packs.get(packMatch[1])) }
    if (path === '/task/v1/department/list') { assert.equal(q.cliContext, 'fresh'); return json([{ id: 900, name: '公司', type: 'top', parentId: null, displayOrder: 0, leaderList: [], childList: [], userList: [{ id: 81, showName: '本人' }, { id: 82, showName: '同事' }] }]) }
    if (path === '/task/mt/permission/role') {
      const roleId = +(body?.roleId ?? q.roleId)
      assert.ok(roleRows.has(roleId))
      if (method === 'PUT') roleRows.get(roleId).name = body.name
      else { roleRows.delete(roleId); rolePermissions.delete(roleId) }
      return envelope()
    }
    if (path === '/task/mt/permission/dstSource/roleList') return envelope([{ roleId: -1, name: '全员权限' }, ...roleRows.values()])
    if (path === '/task/mt/permission/dstSource/role') { const row = { roleId: nextRole++, name: body.name, datasheetId: 'dstSource' }; roleRows.set(row.roleId, row); rolePermissions.set(row.roleId, defaultPermission(row.roleId)); return envelope(row) }
    if (path === '/task/mt/permission/dstSource/spareUserList') return envelope([{ id: 82, showName: '同事' }])
    if (path === '/task/mt/permission/dstSource/permission') {
      const roleId = +(body?.roleId ?? q.roleId), current = rolePermissions.get(roleId); assert.ok(current)
      if (method === 'PUT') {
        if (options.permissionTimeout) throw Error('unknown permission outcome')
        const patch = structuredClone(body); delete patch.memberIds
        // Current service initializes defaults on mode changes; the UI then
        // sends nested restrictions without repeating the mode property.
        if (patch.fieldEditMode === 'custom') patch.fieldPermissions = { newAddFiled: { canView: true, canEdit: true, canAdd: true }, fields: meta.views[0].columns.map((column, index) => ({ fieldId: column.fieldId, name: meta.fieldMap[column.fieldId].name, disable: index === 0, canView: true, canEdit: true, canAdd: true })) }
        if (patch.viewAccessScope === 'partial') patch.viewPermissions = meta.views.map(view => ({ id: view.id, name: view.name, canManage: true }))
        if (options.ignoredNested) { delete patch.fieldPermissions; delete patch.viewPermissions }
        Object.assign(current, patch)
        if (body.memberIds) current.members = body.memberIds.map(id => ({ id, showName: id === 81 ? '本人' : '同事' }))
      }
      if (options.readOnlyBug || current.permissionMode === 'readOnly') return envelope({ ...current, permissionMode: 'readOnly', roleId: -1, members: [], canCreateRecord: false, canDeleteRecord: false, editRecordScope: 'none', viewRecordScope: 'all', fieldEditMode: 'readOnly', manageView: false, viewAccessScope: 'all' })
      return envelope(current)
    }
    if (path === '/task/mt/permission/dstSource/sharedData') { if (method === 'PUT' && !options.ignoreShare) Object.assign(shared, body); return envelope(shared) }
    throw Error('unexpected ' + method + ' ' + path)
  }
  return { calls, transport, modules, packs, projects, roleRows, rolePermissions, shared }
}
const flow = command => { const value = workflows.workflows.find(flow => flow.command === command); assert.ok(value, command); return value }
const run = (command, input, fixture, options = {}) => runWorkflow(ctx, flow(command), input, session, { transport: fixture.transport, approved: true, ...options })

test('table lifecycle distinguishes module and datasheet IDs and verifies copy data and both project associations through HTTP', async () => {
  const f = fixture(), inspected = (await run('datasheet table inspect', target, f)).result
  assert.equal(inspected.module.id, '7101'); assert.equal(inspected.table.datasheetId, 'dstSource')
  const created = await run('datasheet table create', { projectId: '7002', name: '新表' }, f)
  assert.notEqual(created.resources.datasheetId, created.resources.moduleId); assert.equal(created.result.table.recordIds.length, 0)
  await run('datasheet table rename', { ...target, name: '源表更名' }, f)
  assert.equal(f.packs.get('dstSource').datasheet.name, '源表更名')
  const copied = await run('datasheet table copy', { ...target, destinationProjectId: '7002', name: '完整副本' }, f)
  assert.notEqual(copied.resources.destinationDatasheetId, 'dstSource'); assert.equal(copied.result.table.recordIds.length, 1)
  assert.equal(f.calls.filter(call => call.path === '/task/v4/kanbanChild/copy').length, 1)
  await run('datasheet table move', { projectId: '7002', datasheetId: copied.resources.destinationDatasheetId, destinationProjectId: '7001' }, f)
  assert.equal(f.modules.get(copied.resources.destinationModuleId).kanbanId, '7001')
  await run('datasheet table remove', { projectId: '7001', datasheetId: copied.resources.destinationDatasheetId }, f)
  assert.ok(!f.packs.has(copied.resources.destinationDatasheetId)); assert.ok(f.packs.has('dstSource'))
})
test('roles preserve sparse false values and members, resolve nested field/view contexts, and independently verify permission settings', async () => {
  const f = fixture(), created = await run('datasheet role create', { ...target, name: '新角色' }, f), roleId = +created.resources.roleId
  await run('datasheet role rename', { ...target, roleId, name: '更名角色' }, f)
  const out = await run('datasheet role configure', { ...target, roleId: 701, patch: { canCreateRecord: false, manageView: false } }, f)
  assert.equal(out.result.permission.canCreateRecord, false); assert.equal(out.result.permission.canDeleteRecord, true); assert.deepEqual(out.result.permission.members.map(user => user.id), [81])
  const patch = { memberIds: ['82'], editRecordScope: 'partial', recordEditFilterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fldStatus', fieldType: 7, operator: 'is', value: ['optA'] }] },
    fieldEditMode: 'custom', fieldPermissions: { newAddFiled: { canView: true, canEdit: false, canAdd: false }, fields: [{ fieldId: 'fldStatus', canView: false, canEdit: false, canAdd: false }] },
    viewAccessScope: 'partial', viewPermissions: [{ id: 'viwBoard', canManage: false }] }
  const configured = await run('datasheet role configure', { ...target, roleId, patch }, f)
  assert.equal(configured.result.permission.fieldPermissions.fields.find(field => field.fieldId === 'fldStatus').canView, false)
  assert.equal(configured.result.permission.viewPermissions.find(view => view.id === 'viwBoard').canManage, false)
  assert.deepEqual(configured.result.permission.members.map(user => user.id), [82])
  const writes = f.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/permission')), sent = writes.at(-1).body
  assert.deepEqual(writes.at(-2).body.memberIds, [82]); assert.equal(sent.fieldPermissions.fields[0].name, '标题'); assert.equal(sent.fieldPermissions.fields[0].disable, true)
  assert.ok(!Object.hasOwn(sent, 'fieldEditMode') && !Object.hasOwn(sent, 'viewAccessScope'))
  await run('datasheet role configure', { ...target, roleId, patch: { memberIds: [] } }, f); assert.deepEqual(f.rolePermissions.get(roleId).members, [])
  await run('datasheet role configure', { ...target, roleId, patch: { permissionMode: 'readOnly' } }, f)
  const recovered = await run('datasheet role configure', { ...target, roleId, patch: { permissionMode: 'custom', memberIds: [] } }, f)
  assert.equal(recovered.result.permission.canDeleteRecord, true)
  assert.equal(recovered.result.permission.fieldPermissions.fields.find(field => field.fieldId === 'fldStatus').canView, false)
  await run('datasheet role remove', { ...target, roleId }, f); assert.ok(!f.roleRows.has(roleId))
})
test('UI dataManage, ordinary main-project ownership and role membership are required even when raw endpoints would allow writes', async () => {
  for (const options of [{ permissions: { dataManage: false } }, { shared: true }, { template: true }, { otherTeam: true }]) {
    const f = fixture(options)
    await assert.rejects(run('datasheet role create', { ...target, name: '不能创建' }, f))
    assert.ok(!f.calls.some(call => call.method !== 'GET' || call.path.startsWith('/task/mt/permission/')))
  }
  const f = fixture()
  for (const input of [{ roleId: 999, name: '跨表' }, { roleId: -1, name: '全员' }]) await assert.rejects(run('datasheet role rename', { ...target, ...input }, f), { code: 'INVALID_INPUT' })
  const count = f.calls.filter(call => call.method === 'PUT').length
  for (const patch of [{ memberIds: ['9007199254740993123'] }, { fieldPermissions: { newAddFiled: { canView: true, canEdit: true, canAdd: true }, fields: [] } }, { viewPermissions: [] },
    { editRecordScope: 'partial', recordEditFilterInfo: { conjunction: 'and', conditions: [{ fieldId: 'creator', operator: 'contains', value: ['999'] }] } },
    { fieldEditMode: 'custom', fieldPermissions: { newAddFiled: { canView: true, canEdit: true, canAdd: true }, fields: [{ fieldId: 'foreign', canView: true }] } },
    { viewAccessScope: 'partial', viewPermissions: [{ id: 'foreign', canManage: false }] },
    { editRecordScope: 'partial', recordEditFilterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fldStatus', fieldType: 7, operator: 'is', value: ['foreign'] }] } }]) await assert.rejects(run('datasheet role configure', { ...target, roleId: 701, patch }, f), { code: 'INVALID_INPUT' })
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, count)
  await run('datasheet role configure', { ...target, roleId: 701, patch: { fieldEditMode: 'custom', viewAccessScope: 'partial' } }, f)
  assert.equal(f.rolePermissions.get(701).fieldPermissions.fields[0].canView, true)
  assert.ok(f.rolePermissions.get(701).viewPermissions.every(view => view.canManage))
})
test('sharing keeps the main table while separate project references can be created, renamed and removed', async () => {
  const f = fixture(); await assert.rejects(run('datasheet table link', { ...target, destinationProjectId: '7002', name: '引用' }, f), { code: 'RESOURCE_FORBIDDEN' })
  await run('datasheet sharing configure', { ...target, patch: { isOpen: true, sharedScope: 'partial', memberIds: ['81'] } }, f)
  const reference = await run('datasheet table link', { ...target, destinationProjectId: '7002', name: '引用' }, f)
  assert.equal(reference.resources.destinationDatasheetId, 'dstSource'); assert.notEqual(reference.resources.destinationModuleId, '7101')
  const input = { projectId: '7002', datasheetId: 'dstSource' }
  await run('datasheet table rename', { ...input, name: '引用别名' }, f); assert.equal(f.packs.get('dstSource').datasheet.name, '源表')
  await assert.rejects(run('datasheet role create', { ...input, name: '不能管理主权限' }, f))
  const removed = await run('datasheet table remove', input, f); assert.equal(removed.result.scope, 'shared-project-reference-only'); assert.ok(f.packs.has('dstSource'))
  await run('datasheet sharing configure', { ...target, patch: { isOpen: false, memberIds: [] } }, f)
  assert.equal(f.shared.isOpen, false); assert.equal(f.shared.sharedScope, 'partial'); assert.deepEqual(f.shared.memberIds, [])
  const denied = fixture(); await assert.rejects(run('datasheet sharing configure', { ...target, patch: { memberIds: ['999'] } }, denied), { code: 'INVALID_INPUT' }); assert.ok(denied.calls.every(call => call.method === 'GET'))
})
test('ignored nested permissions, stale copies and unknown writes fail with checkpoints and never replay mutations', async () => {
  const ignored = fixture({ ignoredNested: true })
  await assert.rejects(run('datasheet role configure', { ...target, roleId: 701, patch: { viewAccessScope: 'partial', viewPermissions: [{ id: 'viwBoard', canManage: false }] } }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(ignored.calls.filter(call => call.method === 'PUT').length, 2)
  const readonly = fixture({ readOnlyBug: true }); await assert.rejects(run('datasheet role configure', { ...target, roleId: 701, patch: { permissionMode: 'custom' } }, readonly), { code: 'CONTEXT_REQUIRED' }); assert.ok(readonly.calls.every(call => call.method === 'GET'))
  const unknown = fixture({ unknownCreate: true }); await assert.rejects(run('datasheet table create', { projectId: '7002', name: '已创建' }, unknown), error => error.code === 'RESPONSE_SCHEMA_MISMATCH' && !!error.details.resources.moduleId && error.details.writeOutcome === 'unknown-do-not-retry'); assert.equal(unknown.calls.filter(call => call.method === 'POST').length, 1)
  for (const [option, code] of [['copyTimeout', 'NETWORK_ERROR'], ['copyPending', 'WRITE_PENDING'], ['badCopy', 'BUSINESS_ASSERTION_FAILED']]) {
    const f = fixture({ [option]: true }); await assert.rejects(run('datasheet table copy', { ...target, destinationProjectId: '7002', name: '副本' }, f), { code }); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  }
  const timeout = fixture({ permissionTimeout: true }); await assert.rejects(run('datasheet role configure', { ...target, roleId: 701, patch: { manageView: false } }, timeout), error => error.code === 'NETWORK_ERROR' && error.details.resources.roleId === '701' && error.details.writeOutcome === 'unknown-do-not-retry')
})
test('dry-run stays offline, confirmation and entitlement gates precede business access, and altered declarations cannot execute', async () => {
  const f = fixture(), input = { ...target, roleId: 701, patch: { canCreateRecord: false } }
  const plan = await run('datasheet role configure', input, f, { dryRun: true }); assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
  await assert.rejects(run('datasheet role configure', input, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  for (const [option, code] of [['expired', 'COMPANY_EXPIRED'], ['overCapacity', 'COMPANY_OVER_CAPACITY'], ['disabled', 'FEATURE_DISABLED']]) {
    const f = fixture({ [option]: true }); await assert.rejects(executeWorkflow(ctx, flow('datasheet table create'), { projectId: '7002', name: '受限' }, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(call => call.path === '/task/v1/kanbanCrud' || call.method === 'POST'))
  }
  const altered = structuredClone(flow('datasheet role configure')); altered.steps.find(step => step.id === 'changed').prepare = 'fake'; assert.throws(() => validateDatasheetAdminWorkflow(altered), { code: 'INVALID_CONTRACT' })
})
