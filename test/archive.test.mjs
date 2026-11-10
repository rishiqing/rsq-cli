import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const userId = '9223372036854775801', bagId = '81', ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', identity: { userId, teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const roleList = [{ id: '8', name: 'creator', type: 'archiveCreator' }, { id: '9', name: 'write', type: 'archiveWrite' }, { id: '10', name: 'read', type: 'archiveRead' }]
const member = (userId, roleId = '9') => ({ userId, role: roleList.find(role => role.id === roleId) })
const controls = { renameArchiveBag: true, selectArchiveBagGroup: true, addArchiveBagMember: true, removeArchiveBagMember: true, editArchiveBagMemberRole: true, quitArchiveBag: true, removeArchiveBag: true }
const bag = (id = bagId, patch = {}) => ({ id, name: 'bag-' + id, teamId: '7', creatorId: userId, archiveGroupId: null, userRoles: [member(userId, '8')], editControl: { ...controls }, archiveType: 'archiveBag', ...patch })
const directory = [{ id: '20', type: 'top', parentId: null, name: 'company', displayOrder: 1, userList: [userId, '2', '3', '4'].map(id => ({ id })), childList: [] }]
function state(patch = {}) {
  const model = { bags: [bag(), bag('82')], groups: [{ id: '71', name: 'parent', parentGroup: null, teamId: '7', archiveType: 'archiveGroup' }, { id: '72', name: 'child', parentGroup: '71', teamId: '7', archiveType: 'archiveGroup' }], items: [], calls: [], nextId: 101, bagReads: 0, groupReads: 0, ...patch }
  const visible = () => model.bags.filter(bag => bag.userRoles.some(row => row.userId === userId))
  const children = id => [...model.groups.filter(row => row.parentGroup === id), ...visible().filter(row => row.archiveGroupId === id)]
  model.transport = async (url, init) => {
    const call = { path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams), body: init.body == null ? undefined : JSON.parse(init.body) }
    if (init.body != null) assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
    model.calls.push(call)
    if (model.hook) { const response = await model.hook(call, model); if (response) return response }
    const target = String(call.body?.id ?? call.query.id ?? '')
    if (call.path.endsWith('/archiveGroup/seachGroupList')) { model.groupReads++; return json(model.groups.map(({ id, name }) => ({ id, name })).sort((a, b) => model.groupReads % 2 ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id))) }
    if (call.path.endsWith('/archiveGroup/listFirst')) return json({ archiveGroupList: model.groups.filter(row => row.parentGroup == null).map(row => ({ ...row, subItems: children(row.id) })), archiveBagList: visible().filter(row => row.archiveGroupId == null) })
    if (call.path.endsWith('/archiveGroup/list')) return json(children(target))
    if (call.path.endsWith('/archiveBag/list')) { model.bagReads++; return json(visible()) }
    if (call.path.endsWith('/archiveBag/listArchiveRole')) return json(roleList)
    if (call.path.endsWith('/department/list')) { assert.equal(call.query.cliContext, 'fresh'); return json(directory) }
    if (call.path.endsWith('/archiveFile/list')) return json(model.ignoreLimit ? model.items : model.items.slice(0, Number(call.query.max)))
    if (call.path.endsWith('/archiveGroup')) {
      if (call.method === 'POST') { const row = { id: String(model.nextId++), name: call.body.name, teamId: '7', parentGroup: call.body.archiveGroupId ?? null, archiveType: 'archiveGroup' }; model.groups.push(row); return json(row) }
      const row = model.groups.find(row => row.id === target); assert.ok(row)
      if (call.method === 'PUT') { row.name = call.body.name; return json(row) }
      model.groups = model.groups.filter(row => row.id !== target); return new Response('')
    }
    if (call.path.endsWith('/archiveBag')) {
      if (call.method === 'POST') { const row = bag(String(model.nextId++), { name: call.body.name, archiveGroupId: call.body.archiveGroupId ?? null }); model.bags.push(row); return json(row) }
      const row = model.bags.find(row => row.id === target); assert.ok(row)
      if (call.method === 'PUT') {
        if (call.body.name !== undefined) row.name = call.body.name
        if (call.body.memberIds !== undefined) row.userRoles = call.body.memberIds.split(',').map(id => row.userRoles.find(member => member.userId === id) ?? member(id))
        return json(row)
      }
      model.bags = model.bags.filter(row => row.id !== target); return new Response('')
    }
    if (call.path.endsWith('/archiveBag/move')) { model.bags.find(row => row.id === call.body.archiveBagId).archiveGroupId = call.body.archiveGroupId || null; return new Response('') }
    if (call.path.endsWith('/archiveBag/updateUserRole')) { const row = model.bags.find(row => row.id === target); row.userRoles = row.userRoles.map(item => item.userId === call.body.memberId ? member(item.userId, call.body.roleId) : item); return new Response('') }
    if (call.path.endsWith('/archiveBag/quit')) { const row = model.bags.find(row => row.id === target); row.userRoles = row.userRoles.filter(item => item.userId !== userId); return new Response('') }
    throw Error('Unexpected request ' + call.path)
  }
  return model
}
const flow = suffix => workflows.workflows.find(flow => flow.command === 'archive ' + suffix)
const run = (suffix, input, model, options = {}) => runWorkflow(ctx, flow(suffix), input, session, { transport: model.transport, approved: true, ...options })
const writes = model => model.calls.filter(call => !['GET', 'HEAD'].includes(call.method))
test('archive schema, lazy hierarchy, actual roles and offline dry-run share the executable contract', async () => {
  const model = state(), dry = await run('bag members set', { bagId, memberIds: [userId] }, model, { dryRun: true })
  model.groups[1].subItems = null
  assert.equal(dry.dryRun, true); assert.equal(model.calls.length, 0)
  assert.ok(workflowSchema(flow('group create')).access.features.includes('ARCHIVE'))
  assert.ok(workflowSchema(flow('group create')).access.permissions.includes('editArchiveBagGroup'))
  const context = (await run('context', {}, model)).result
  assert.equal(context.roles[1].id, '9'); assert.equal(context.bags[0].members[0].userId, userId)
  const root = (await run('groups list', {}, model)).result.root
  assert.equal(root.groups[0].subItems[0].id, '72'); assert.equal(root.ungroupedBags.length, 2)
  assert.equal((await run('group children', { groupId: '71' }, model)).result.children[0].parentGroup, '71')
})
test('archive group create validates actual parent and independently reads root and nested placement', async () => {
  for (const parentId of [null, '71']) {
    const model = state(), result = await run('group create', { name: 'new', parentId }, model)
    assert.equal(result.resources.groupId, '101'); assert.equal(result.result.parentId, parentId)
    assert.equal(model.groups.find(row => row.id === '101').parentGroup, parentId); assert.equal(writes(model).length, 1)
  }
  const model = state(); await assert.rejects(run('group create', { name: 'new', parentId: '999' }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0)
})
test('archive group rename preserves unordered directory and removal refuses visible descendants', async () => {
  const model = state()
  assert.equal((await run('group rename', { groupId: '72', name: 'renamed' }, model)).result.group.name, 'renamed')
  const count = writes(model).length
  await assert.rejects(run('group remove', { groupId: '71' }, model), { code: 'DEPENDENCY_EXISTS' }); assert.equal(writes(model).length, count)
  const result = await run('group remove', { groupId: '72' }, model)
  assert.equal(result.result.removed, true); assert.equal(model.bags.length, 2)
})
test('group preflight detects changed names and bag creation independently verifies self-only membership', async () => {
  const model = state({ hook(call, model) { if (call.path.endsWith('/seachGroupList') && model.groupReads === 1) model.groups[0].name = 'concurrent' } })
  await assert.rejects(run('group rename', { groupId: '71', name: 'new' }, model), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(model).length, 0)
  const fresh = state(), result = await run('bag create', { name: 'private', groupId: '72' }, fresh)
  assert.equal(result.resources.bagId, '101'); assert.equal(result.result.bag.groupId, '72')
  assert.deepEqual(result.result.bag.members, [{ userId, role: { id: '8', type: 'archiveCreator' } }])
})
test('bag rename and group moves preserve all members and encode ungrouped as a JSON empty string', async () => {
  const model = state(); model.bags[0].userRoles.push(member('2', '10'))
  await run('bag rename', { bagId, name: 'renamed' }, model)
  assert.deepEqual(writes(model)[0].body, { id: bagId, name: 'renamed' })
  await run('bag move', { bagId, groupId: '71' }, model)
  await run('bag move', { bagId, groupId: null }, model)
  assert.equal(writes(model).at(-1).body.archiveGroupId, ''); assert.equal(model.bags[0].userRoles[1].role.type, 'archiveRead')
  const count = writes(model).length
  const noop = await run('bag move', { bagId, groupId: null }, model); assert.ok(noop.skippedSteps.includes('changed'))
  await assert.rejects(run('bag move', { bagId, groupId: '999' }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, count)
})
test('member replacement uses the company directory, preserves creator and existing role, and assigns the actual default role', async () => {
  const model = state(); model.bags[0].userRoles.push(member('2', '10'))
  const result = await run('bag members set', { bagId, memberIds: [userId, '2', '3'] }, model)
  assert.deepEqual(result.result.bag.members.map(row => [row.userId, row.role.type]).sort(), [[userId, 'archiveCreator'], ['2', 'archiveRead'], ['3', 'archiveWrite']].sort())
  assert.equal(writes(model)[0].body.memberIds, [userId, '2', '3'].join(',')); assert.equal(writes(model)[0].body.name, undefined)
  await run('bag members set', { bagId, memberIds: [userId, '2'] }, model)
  const count = writes(model).length
  await assert.rejects(run('bag members set', { bagId, memberIds: [userId, '999'] }, model), { code: 'INVALID_INPUT' })
  await assert.rejects(run('bag members set', { bagId, memberIds: ['2'] }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, count)
})
test('add and remove permissions are checked separately; creator and current actor cannot be dropped', async () => {
  const model = state(); model.bags[0].editControl.addArchiveBagMember = false
  await assert.rejects(run('bag members set', { bagId, memberIds: [userId, '2'] }, model), { code: 'FORBIDDEN' })
  model.bags[0].userRoles.push(member('2')); model.bags[0].editControl.removeArchiveBagMember = false
  await assert.rejects(run('bag members set', { bagId, memberIds: [userId] }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 0)
  const otherCreator = state({ bags: [bag(bagId, { creatorId: '2', userRoles: [member('2', '8'), member(userId)] })] })
  await assert.rejects(run('bag members set', { bagId, memberIds: [userId] }, otherCreator), { code: 'INVALID_INPUT' }); assert.equal(writes(otherCreator).length, 0)
})
test('member role set uses actual IDs and protects the creator and unrelated roles', async () => {
  const model = state(); model.bags[0].userRoles.push(member('2'), member('3', '10'))
  const result = await run('bag member role set', { bagId, memberId: '2', roleId: '10' }, model)
  assert.equal(result.result.bag.members.find(row => row.userId === '2').role.type, 'archiveRead')
  assert.equal(result.result.bag.members.find(row => row.userId === '3').role.type, 'archiveRead')
  for (const [memberId, roleId] of [[userId, '10'], ['2', '8'], ['2', '999'], ['4', '10']]) await assert.rejects(run('bag member role set', { bagId, memberId, roleId }, model), { code: 'INVALID_INPUT' })
  assert.equal(writes(model).length, 1)
})
test('leaving protects owner and independently confirms actual non-owner exit', async () => {
  const model = state(); await assert.rejects(run('bag leave', { bagId }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 0)
  model.bags[0].creatorId = '2'; model.bags[0].userRoles = [member('2', '8'), member(userId, '10')]
  const result = await run('bag leave', { bagId }, model)
  assert.equal(result.result.left, true); assert.equal(result.result.removed, false); assert.equal(model.bags[1].userRoles[0].userId, userId)
})
test('bag removal refuses visible items and requires explicit destructive approval', async () => {
  const model = state({ items: [{ id: '601', name: 'visible', type: 'task' }] })
  await assert.rejects(run('bag remove', { bagId }, model), { code: 'DEPENDENCY_EXISTS' }); assert.equal(writes(model).length, 0)
  model.items = []
  await assert.rejects(run('bag remove', { bagId }, model, { approved: false }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal((await run('bag remove', { bagId }, model)).result.removed, true); assert.equal(model.bags.length, 1)
})
test('new resources and failed write outcomes are reported without automatic replay', async () => {
  const model = state({ hook(call, model) { if (call.path.endsWith('/archiveBag') && call.method === 'POST') { model.bags.push(bag('101', { name: call.body.name })); throw Error('connection lost after commit') } } })
  await assert.rejects(run('bag create', { name: 'lost-ack' }, model), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown')
  assert.equal(writes(model).length, 1); assert.equal(model.bags.at(-1).id, '101')
  const readback = state({ hook(call, model) { if (call.path.endsWith('/archiveBag/list') && model.bagReads > 0) throw Error('readback offline') } })
  await assert.rejects(run('bag create', { name: 'saved' }, readback), error => error.details.resources.bagId === '101' && error.details.completedSteps.includes('created'))
  assert.equal(writes(readback).length, 1)
})
test('fresh bag conflicts, UI denial and foreign-company resources stop before writes', async () => {
  for (const patch of [{ teamId: '8' }, { editControl: { ...controls, renameArchiveBag: false } }, { userRoles: [member('2', '8')], creatorId: '2' }]) {
    const model = state({ bags: [bag(bagId, patch)] }); await assert.rejects(run('bag rename', { bagId, name: 'denied' }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 0)
  }
  const conflict = state({ hook(call, model) { if (call.path.endsWith('/archiveBag/list') && model.bagReads === 1) model.bags[0].userRoles.push(member('2')) } })
  await assert.rejects(run('bag rename', { bagId, name: 'stale' }, conflict), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(conflict).length, 0)
})
test('archive resource list reports an actual cap rather than a fake cursor and omits signed paths', async () => {
  const model = state({ items: [{ id: '601', name: 'one', type: 'task', resourceId: 'task-uuid', path: 'https://private.example/signed?secret=fixture', creator: { secret: 'omit' } }] })
  const result = (await run('bag items list', { bagId, limit: 1 }, model)).result
  assert.equal(result.pagination.possiblyTruncated, true); assert.equal(result.pagination.cursorSupported, false)
  assert.equal(result.items[0].resourceId, 'task-uuid'); assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(model.calls.at(-1).query.max, '1'); assert.equal(model.calls.at(-1).query.lastDataId, undefined)
  model.ignoreLimit = true; model.items.push({ id: '602', name: 'department-visible', type: 10, resourceId: '702' })
  const unbounded = (await run('bag items list', { bagId, limit: 1 }, model)).result
  assert.equal(unbounded.items.length, 2); assert.equal(unbounded.pagination.pageSizeEnforced, false); assert.equal(unbounded.pagination.possiblyTruncated, true)
})
test('ambiguous historical bag memberships remain discoverable without authorizing writes or blocking unrelated bags', async () => {
  const model = state(); model.bags[1].userRoles.push(member(userId, '10'))
  const context = (await run('context', {}, model)).result
  assert.equal(context.bags[1].contextStatus, 'ambiguous-membership'); assert.equal(context.bags[1].writable, false)
  assert.equal(context.bags[1].members.length, 2)
  await assert.rejects(run('bag rename', { bagId: '82', name: 'ambiguous' }, model), { code: 'CONTEXT_MISSING' }); assert.equal(writes(model).length, 0)
  await run('bag rename', { bagId, name: 'safe-own-bag' }, model)
  assert.equal(model.bags[1].name, 'bag-82'); assert.equal(model.bags[1].userRoles.length, 2)
})
test('archive filter discovery returns current operators and types without reading source resources', async () => {
  const model = state(), result = (await run('items context', { bagId }, model)).result
  assert.ok(result.operators.some(user => user.id === userId)); assert.ok(result.filters.types.some(type => type.id === 5))
  assert.ok(!result.filters.types.some(type => [11, 15].includes(type.id)))
  assert.equal(result.filters.orderingSelectable, false); assert.equal(result.filters.order, 'id-desc')
  assert.equal(result.filters.dateRange.endInclusive, true)
  assert.equal(model.calls.some(call => call.path.endsWith('/archiveFile/list')), false)
  assert.equal(writes(model).length, 0)
})
test('archive filters preserve exact operator IDs and reject foreign selections from a fresh directory', async () => {
  const model = state({ items: [{ id: '601', type: 1, userId, resourceId: 'own' }] })
  const result = (await run('bag items list', { bagId, types: [1, 5], operatorId: userId }, model)).result
  assert.equal(result.items.length, 1); assert.equal(model.calls.at(-1).query.type, '1,5'); assert.equal(model.calls.at(-1).query.userId, userId)
  assert.equal(model.calls.filter(call => call.path.endsWith('/department/list')).length, 1)
  const foreign = state(); await assert.rejects(run('bag items list', { bagId, operatorId: '999' }, foreign), { code: 'INVALID_INPUT' })
  assert.equal(foreign.calls.some(call => call.path.endsWith('/archiveFile/list')), false)
  const plain = state(); await run('bag items list', { bagId }, plain)
  assert.equal(plain.calls.some(call => call.path.endsWith('/department/list')), false)
})
test('archive whole-day filters use dotted wire dates, leap years and exclude the next-midnight boundary', async () => {
  const model = state({ ignoreLimit: true, items: [
    { id: '603', type: 1, resourceId: 'next-midnight', dateCreated: '2024.03.01 00:00:00' },
    { id: '602', type: 1, resourceId: 'end-of-leap-day', dateCreated: '2024.02.29 23:59:59' },
    { id: '601', type: 1, resourceId: 'start', dateCreated: '2024.02.28 00:00:00' },
  ] })
  const result = (await run('bag items list', { bagId, limit: 2, startDate: '2024-02-28', endDate: '2024-02-29' }, model)).result
  assert.equal(model.calls.at(-1).query.startDate, '2024.02.28'); assert.equal(model.calls.at(-1).query.endDate, '2024.03.01')
  assert.deepEqual(result.items.map(item => item.id), ['602', '601'])
  assert.equal(result.pagination.serverReturned, 3); assert.equal(result.pagination.returned, 2); assert.equal(result.pagination.possiblyTruncated, true)
  const rollover = state(); await run('bag items list', { bagId, startDate: '2026-12-31', endDate: '2026-12-31' }, rollover)
  assert.equal(rollover.calls.at(-1).query.endDate, '2027.01.01'); assert.equal(rollover.calls.at(-1).query.sortType, undefined)
})
test('archive invalid or incomplete date ranges and retired types stop before the resource query', async () => {
  for (const input of [{ startDate: '2025-02-29', endDate: '2025-03-01' }, { startDate: '2024-02-29' }, { endDate: '2024-02-29' }, { startDate: '2026-02-02', endDate: '2026-02-01' }, { startDate: '9999-12-31', endDate: '9999-12-31' }, { types: [11] }, { types: [15] }, { types: [1, 1] }]) {
    const model = state(); await assert.rejects(run('bag items list', { bagId, ...input }, model))
    assert.equal(model.calls.some(call => call.path.endsWith('/archiveFile/list')), false)
  }
})
test('archive filtered responses must prove type, creator and parseable calendar dates', async () => {
  for (const [input, item] of [
    [{ types: [1] }, { type: 5 }],
    [{ operatorId: userId }, { userId: '2' }],
    [{ startDate: '2026-11-08', endDate: '2026-11-08' }, { dateCreated: 'unrecognised' }],
  ]) {
    const model = state({ items: [{ id: '601', resourceId: 'source', ...item }] })
    await assert.rejects(run('bag items list', { bagId, ...input }, model))
    assert.equal(writes(model).length, 0)
  }
})
test('archive entitlement and company-level permissions stop before business HTTP in public dispatch', async () => {
  for (const [patch, features, permission, code] of [[{}, 'disable', true, 'FEATURE_DISABLED'], [{ deadLine: '2000-01-01 00:00:00' }, 'enable', true, 'COMPANY_EXPIRED'], [{ usersCount: 3, userLimit: 2 }, 'enable', true, 'COMPANY_OVER_CAPACITY'], [{}, 'enable', false, 'FEATURE_FORBIDDEN']]) {
    const calls = [], transport = async (url, init) => {
      calls.push(url.pathname)
      if (url.pathname === '/task/login/authAjax') return json({ success: true, id: userId, username: 'fixture', token: session.accessToken, team: { id: '7', name: 'fixture-company' } })
      if (url.pathname === '/task/ordercenter/v2/member/state/independent') return json({ vt: 'fixture', deadLine: '2100-01-01 00:00:00', usersCount: 2, userLimit: 2, mainApp: 'rsq', ...patch })
      if (url.pathname === '/task/ordercenter/v2/function/available') return json([{ funcName: 'ARCHIVE', status: features }])
      if (url.pathname === '/task/authority/v3/authorities/company/current') return json({ editArchiveBagGroup: permission })
      throw Error('Must not reach archive business HTTP')
    }
    await assert.rejects(executeWorkflow(ctx, flow('group create'), { name: 'denied' }, session, { transport, approved: true }), { code })
    assert.equal(calls.some(path => /\/archive(?:Group|Bag|File)/.test(path)), false)
  }
  const raw = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/v1/archiveBag')
  await assert.rejects(executeOperation(ctx, raw, { body: { id: bagId, name: 'bypass' } }, session, { approved: true, transport() { throw Error('No raw context bypass') } }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
