import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareExecution, verifyExecution } from '../dist/execution-context.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '9223372036854775801', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const input = { type: 'user', startDate: '2026-11-01', endDate: '2026-11-30' }
const view = { id: 'view-1', name: '本月', viewType: 'list', group: 'custom', sort: 'custom', dateRangeType: 'month', isSelected: true, canUpdate: false, canDelete: false }
const condition = { name: '状态', type: 'selector', key: 'status', operator: [], selector: [{ name: '未完成', value: 'false', selected: true }, { name: '已完成', value: 'true', selected: false }] }
const group = { id: 'custom-1', name: 'first', groupType: 'custom', isUngroup: false }, second = { id: 'custom-2', name: 'second', groupType: 'custom', isUngroup: false }
const context = () => ({ departments: [], staffGroups: [], mode: { mode: 'taskOnly', canUpdate: true }, views: [structuredClone(view)], selectedFilters: { filter: [structuredClone(condition)] }, filters: { filter: [structuredClone(condition)] }, groups: { effectiveMode: 'taskOnly', editControl: { editGroup: true, dragTask: true }, groupList: [structuredClone(group), structuredClone(second)] } })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = command => workflows.workflows.find(flow => flow.command === command)
const run = (command, data, transport, approved = true) => runWorkflow(ctx, flow(command), data, session, { transport, approved })
test('execution uses visible organization context and never sends mode overrides or loses saved filters', async () => {
  const requests = []
  const transport = async (url, init) => {
    requests.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body), query: Object.fromEntries(url.searchParams) })
    if (url.pathname.endsWith('/department/list') || url.pathname.endsWith('/staffGroupCrud/list')) return json([])
    if (url.pathname.endsWith('/displayMode')) return json({ mode: 'taskOnly' })
    if (url.pathname.endsWith('/view/list')) return json([view])
    if (url.pathname.endsWith('/filter/selected')) return json({ filter: [condition] })
    if (url.pathname.endsWith('/group/list')) return json(context().groups)
    return json({ effectiveMode: 'taskOnly', list: [{ id: 'task-1' }, { id: 'todo-1', processInfoId: '801' }], hasMore: true })
  }
  const result = await run('execution items list', { ...input, groupId: 'custom-1', max: 2, lastId: 'cursor-1' }, transport)
  const query = requests.find(request => request.path.endsWith('/view/list')).query
  assert.equal(query.typeId, session.identity.userId)
  const body = requests.at(-1).body
  assert.equal(body.typeId, session.identity.userId); assert.equal(body.mode, undefined); assert.equal(body.subView, undefined)
  assert.deepEqual(body.filter, [condition]); assert.equal(body.lastId, 'cursor-1'); assert.equal(body.max, 2)
  assert.equal(result.result.hasMore, true); assert.equal(result.result.list[1].processInfoId, '801')
})
test('foreign scopes and invalid dates stop before the scope or business HTTP request', async () => {
  const result = context()
  assert.throws(() => prepareExecution('execution-scope', { ...input, typeId: '999' }, result, session), { code: 'FORBIDDEN' })
  let calls = 0
  await assert.rejects(run('execution items list', { ...input, startDate: '2026-02-30' }, async () => { calls++; throw Error('No HTTP') }), { code: 'INVALID_INPUT' })
  assert.equal(calls, 0)
  result.departments = [{ id: '81', userList: [{ id: '101' }], childList: [] }]
  assert.deepEqual(prepareExecution('execution-scope', { ...input, typeId: '101' }, result, session), { query: { type: 'user', typeId: '101' } })
  result.staffGroups = [{ id: '91' }]
  assert.deepEqual(prepareExecution('execution-scope', { ...input, type: 'group', typeId: '91' }, result, session).query, { type: 'group', typeId: '91' })
})
test('mixed execution mode and default groups cannot bypass UI restrictions even if API permissions are permissive', () => {
  const results = context()
  results.mode.mode = 'taskAndWorkflowTodo'; results.groups.effectiveMode = 'taskAndWorkflowTodo'
  assert.throws(() => prepareExecution('execution-group-create', { ...input, name: 'x' }, results, session), { code: 'FORBIDDEN' })
  results.mode.mode = 'taskOnly'; results.groups.effectiveMode = 'taskOnly'; results.groups.groupList[0].isUngroup = true
  assert.throws(() => prepareExecution('execution-group-rename', { ...input, groupId: group.id, name: 'x' }, results, session), { code: 'FORBIDDEN' })
  results.groups.groupList[0].isUngroup = false; results.groups.editControl.editGroup = false
  assert.throws(() => prepareExecution('execution-group-remove', { ...input, groupId: group.id }, results, session), { code: 'FORBIDDEN' })
})
test('view updates follow current UI settings semantics, validate dynamic filters and preserve omitted filters', () => {
  const results = context()
  const prepared = prepareExecution('execution-view-update', { ...input, patch: { isSelected: true, sort: 'titleAsc' } }, results, session)
  assert.deepEqual(prepared.body, { id: view.id, isSelected: true, sort: 'titleAsc' })
  const changed = prepareExecution('execution-view-update', { ...input, patch: { filter: [{ key: 'status', values: ['已完成'] }] } }, results, session)
  assert.equal(changed.body.filter[0].selector[1].selected, true); assert.equal(changed.body.filter[0].selector[0].selected, false)
  assert.throws(() => prepareExecution('execution-view-update', { ...input, patch: { filter: [{ key: 'status', values: ['missing'] }] } }, results, session), { code: 'INVALID_INPUT' })
  const cleared = prepareExecution('execution-view-update', { ...input, patch: { filter: [] } }, results, session)
  assert.equal(cleared.body.filter.length, 1)
  assert.ok(cleared.body.filter[0].selector.every(option => option.selected === false))
  assert.equal(cleared.body.filter[0].contentValue, '')
  assert.throws(() => prepareExecution('execution-view-update', { ...input, patch: { viewType: 'quad' } }, results, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareExecution('execution-view-update', { ...input, expectedVersion: '0'.repeat(64), patch: { sort: 'titleAsc' } }, results, session), { code: 'CONTEXT_CONFLICT' })
  assert.throws(() => prepareExecution('execution-view-update', { ...input, patch: { group: 'user' } }, results, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareExecution('execution-view-update', { ...input, startDate: '2026-11-01', endDate: '2026-11-01', patch: { group: 'date' } }, results, session), { code: 'INVALID_INPUT' })
})
test('field sorting uses primaryId while field selection resolves business ids and independently checks order', () => {
  const results = context()
  results.fields = [{ name: '基础', list: [{ id: 'name', key: '1', name: '名称', primaryId: '9223372036854775802' }, { id: 'date', key: '2', name: '日期', primaryId: '9223372036854775803' }] }]
  results.selectedFields = results.fields[0].list
  const request = prepareExecution('execution-fields-set', { ...input, fields: ['名称', 'date'] }, results, session)
  assert.equal(request.body.list[0].primaryId, undefined); assert.equal(request.body.list[0].id, 'name')
  assert.throws(() => prepareExecution('execution-fields-order', { ...input, moveId: 'name', nextId: '9223372036854775803' }, results, session), { code: 'CONTEXT_MISSING' })
  const sorted = prepareExecution('execution-fields-order', { ...input, moveId: '9223372036854775803', nextId: '9223372036854775802' }, results, session)
  assert.equal(sorted.body.moveId, '9223372036854775803')
  results.verifiedFields = [...results.selectedFields].reverse()
  verifyExecution(input, results, 'verifiedFields')
  results.verifiedFields.reverse()
  assert.throws(() => verifyExecution(input, results, 'verifiedFields'), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('workflow todos cannot be moved as tasks and move anchors must be in the destination context', () => {
 const results = context(), args = { ...input, itemId: 'todo-1', sourceGroupId: group.id, destinationGroupId: second.id }
 results.sourceItems = { list: [{ id: 'todo-1', processInfoId: '801' }] }; results.targetItems = { list: [] }
 assert.throws(() => prepareExecution('execution-item-move', args, results, session), { code: 'INVALID_INPUT' })
 delete results.sourceItems.list[0].processInfoId
 assert.throws(() => prepareExecution('execution-item-move', { ...args, nextId: 'foreign-task' }, results, session), { code: 'CONTEXT_MISSING' })
 const request = prepareExecution('execution-item-move', args, results, session)
 assert.deepEqual(request.body, { moveId: 'todo-1', srcExecutionGroupId: group.id, destExecutionGroupId: second.id })
})
test('company mode changes assert actual team and permission, require confirmation, and dry-run is offline', async () => {
 const results = { mode: { mode: 'taskOnly', canUpdate: true } }
 assert.throws(() => prepareExecution('execution-mode-set', { teamId: '8', mode: 'taskOnly' }, results, session), { code: 'FORBIDDEN' })
 results.mode.canUpdate = false
 assert.throws(() => prepareExecution('execution-mode-set', { teamId: '7', mode: 'taskOnly' }, results, session), { code: 'FORBIDDEN' })
 await assert.rejects(run('execution company mode set', { teamId: '7', mode: 'taskOnly' }, async () => { throw Error('No HTTP') }, false), { code: 'CONFIRMATION_REQUIRED' })
 const offline = await runWorkflow(ctx, flow('execution company mode set'), { teamId: '7', mode: 'taskOnly' }, null, { dryRun: true, transport: async () => { throw Error('offline') } })
 assert.equal(offline.dryRun, true)
})

test('grouped item queries resolve a unique group or request an explicit choice before querying items', () => {
 const results = context()
 assert.throws(() => prepareExecution('execution-items', input, results, session), { code: 'AMBIGUOUS_CONTEXT' })
 results.groups.groupList.pop()
 assert.equal(prepareExecution('execution-items', input, results, session).body.groupId, group.id)
})
