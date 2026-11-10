import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows, workflowSchema } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { accessPlan } from '../dist/access.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', identity: { userId, teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value)), definition = command => structuredClone(workflows.workflows.find(flow => flow.command === command))
const card = (id, extra = {}) => ({ id, cycleId: '1001', type: 'company', typeDataId: '7', responsibleUserId: null, cycleStatus: 'normal', displayOrder: Number(id), objectiveList: [{ id: '5001', name: 'source-objective', token: 'must-not-output', responsibleUser: { id: userId, name: 'member', avatar: 'must-not-output' } }], ...extra })
const board = (id, extra = {}) => ({ id, name: 'board-' + id, type: 'team', isShowKr: true, displayOrder: Number(id), cardList: [], ...extra })
function state() {
  const model = { calls: [], next: 100, canManage: true, boards: [board('10', { cardList: [card('31'), card('32')] }), board('20')], items: [{ id: '41', deptId: '70', name: 'company' }, { id: '42', deptId: '71', name: 'dept' }],
    user: { success: true, username: 'fixture', id: userId, team: { id: '7', name: 'company' }, token: 'must-not-output' }, state: { vt: 'fixture', mainApp: 'TEAM', deadLine: '2099-01-01 23:59:59', usersCount: 1, userLimit: 5 }, features: ['OKR', 'OKR_PUBLICITY', 'OKR_WORK'].map(funcName => ({ funcName, status: 'enable' })), permissions: { useObjective: true },
    tree: [{ id: '70', name: 'company', type: 'top', parentId: null, displayOrder: 0, userList: [{ id: userId, name: 'member' }], childList: [{ id: '71', name: 'dept', type: 'common', parentId: '70', displayOrder: 1, userList: [], childList: [] }, { id: '72', name: 'newdept', type: 'common', parentId: '70', displayOrder: 2, userList: [], childList: [] }] }],
    config: { userId: '8101', isShowKeyResult: false, isHorizontal: false, isShowInitCard: true, isIndicatorHorizontal: true, defaultModule: 'align', defaultCycleId: '1001' },
    cycles: { currentCycleList: [{ id: '1001', name: 'current', isArchived: false }], futureCycleList: [{ id: '1002', name: 'next', isArchived: false }], pastCycleList: [] } }
  const sort = (values, body, nextKey) => { const moving = values.find(row => row.id === body.moveId), rest = values.filter(row => row.id !== body.moveId), index = body[nextKey] ? rest.findIndex(row => row.id === body[nextKey]) : body.frontId ? rest.findIndex(row => row.id === body.frontId) + 1 : 0; values.splice(0, values.length, ...rest.slice(0, index), moving, ...rest.slice(index)); values.forEach((row, i) => { if (row.displayOrder !== undefined) row.displayOrder = i + 1 }) }
  model.transport = async (url, init) => {
    const call = { method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body == null ? undefined : JSON.parse(init.body) }; model.calls.push(call)
    if (model.hook) { const response = await model.hook(call, model); if (response) return response }
    if (call.path.endsWith('/authAjax')) return json(model.user)
    if (call.path.endsWith('/member/state/independent')) return json(model.state)
    if (call.path.endsWith('/function/available')) return json(model.features)
    if (call.path.endsWith('/authorities/company/current')) return json(model.permissions)
    if (call.path.endsWith('/department/list')) return json(model.tree)
    if (call.path.endsWith('/cycle/list')) return json(model.cycles)
    if (call.path.endsWith('/okr/config')) { if (call.method === 'PUT') Object.assign(model.config, call.body); return json(model.config) }
    if (call.path.endsWith('/kanban/list')) return json({ team: { editControl: { manageKanban: model.canManage }, kanbanList: model.boards.map(board => ({ ...board, cardList: null })) }, user: { editControl: { manageKanban: true }, kanbanList: [] } })
    if (call.path.endsWith('/kanban')) {
      if (call.method === 'GET') return json(model.boards.find(row => row.id === call.query.id))
      if (call.method === 'POST') { const created = board(String(model.next++), { ...call.body, isShowKr: false }); model.boards.push(created); return json(created) }
      if (call.method === 'DELETE') { model.boards = model.boards.filter(row => row.id !== call.query.id); return new Response('') }
      const current = model.boards.find(row => row.id === call.body.id); Object.assign(current, call.body); return json(current)
    }
    if (call.path.endsWith('/kanban/sort')) { sort(model.boards, call.body, 'nextId'); return json(model.boards.find(row => row.id === call.body.moveId)) }
    if (call.path.endsWith('/kanbanCard') || call.path.endsWith('/kanbanCard/sort')) {
      const parent = model.boards.find(row => row.id === call.body?.kanbanId || row.cardList.some(card => card.id === (call.body?.id ?? call.body?.moveId ?? call.query.id)))
      if (call.path.endsWith('/sort')) { sort(parent.cardList, call.body, 'behindId'); return json(parent.cardList.find(row => row.id === call.body.moveId)) }
      if (call.method === 'POST') { const created = card(String(model.next++), { cycleId: call.body.cycleId, type: call.body.type ?? null, typeDataId: call.body.typeDataId ?? null, responsibleUserId: call.body.responsibleUserId ?? null }); parent.cardList.push(created); return json(created) }
      if (call.method === 'DELETE') { parent.cardList = parent.cardList.filter(row => row.id !== call.query.id); return new Response('') }
      const current = parent.cardList.find(row => row.id === call.body.id); current.cycleId = call.body.cycleId
      if (call.body.type !== undefined) { current.type = call.body.type || null; current.typeDataId = call.body.type ? call.body.typeDataId ?? null : null }
      if (call.body.responsibleUserId !== undefined) { current.responsibleUserId = call.body.responsibleUserId === '0' ? null : call.body.responsibleUserId; if (current.type === 'person') current.typeDataId = current.responsibleUserId }
      return json(current)
    }
    if (call.path.endsWith('/plan/item/list')) return json(model.items)
    if (call.path.endsWith('/plan/item/sort')) { sort(model.items, call.body, 'nextId'); return new Response('') }
    if (call.path.endsWith('/plan/item')) {
      if (call.method === 'POST') { const created = { id: String(model.next++), deptId: call.body.deptId, name: 'newdept' }; model.items.push(created); return json(created) }
      model.items = model.items.filter(row => row.id !== call.query.id); return new Response('')
    }
    if (/\/objective\/(list|superior\/list)$/.test(call.path)) { model.config.defaultModule = 'objective'; return json([{ id: '5001', name: 'source-objective' }]) }
    throw Error('Unexpected request ' + call.path)
  }
  return model
}
const run = async (command, input, model, options = {}) => { try { return await runWorkflow(ctx, definition(command), input, session, { transport: model.transport, approved: true, ...options }) } catch (error) { if (process.env.RSQ_FIXTURE_TRACE) error.message += ' ' + JSON.stringify(error.details); throw error } }
const writes = model => model.calls.filter(call => call.method !== 'GET')
test('publicity discovery uses real company board, cycle and member contexts without session or avatar data', async () => {
  const model = state(), context = await run('okr publicity context', {}, model), inspected = await run('okr publicity inspect', { boardId: '10' }, model)
  assert.equal(context.result.companyId, '7'); assert.equal(context.result.managesCompanyBoards, true); assert.equal(context.result.people[0].id, userId)
  assert.equal(inspected.result.board.cardList[0].objectives[0].name, 'source-objective'); assert.doesNotMatch(JSON.stringify(inspected), /must-not-output/)
  assert.equal(writes(model).length, 0)
  for (const route of ['/task/okr/kanban/list', '/task/okr/kanban']) assert.equal(catalog.operations.find(op => op.route === route && op.method === 'GET').effect, 'write')
})
test('company publicity create, rename, explicit false, no-op and remove preserve existing boards and source objectives', async () => {
  const model = state(), original = structuredClone(model.boards), created = await run('okr publicity create', { name: 'new' }, model), boardId = created.resources.boardId
  assert.equal(created.result.board.id, boardId); assert.equal(created.result.board.type, 'team'); assert.equal(created.result.verified, true)
  await run('okr publicity rename', { boardId, name: 'renamed' }, model)
  await run('okr publicity key-results set', { boardId, enabled: true }, model)
  await run('okr publicity key-results set', { boardId, enabled: false }, model)
  assert.equal(writes(model).at(-1).body.isShowKr, false)
  const unchanged = await run('okr publicity key-results set', { boardId, enabled: false }, model); assert.deepEqual(unchanged.skippedSteps, ['changed'])
  const removed = await run('okr publicity remove', { boardId }, model); assert.equal(removed.result.removed, true); assert.equal(removed.result.objectivesDeleted, false)
  assert.deepEqual(model.boards, original); assert.equal(writes(model).length, 5)
})
test('publicity card full filters and real null clearing use exact long members and preserve other cards', async () => {
  const model = state(), original = structuredClone(model.boards[0].cardList), created = await run('okr publicity card create', { boardId: '10', selection: { cycleId: '1001', type: 'dept', departmentId: '71', responsibleUserId: userId } }, model), cardId = created.resources.cardId
  assert.deepEqual(writes(model)[0].body, { kanbanId: '10', cycleId: '1001', type: 'dept', typeDataId: '71', responsibleUserId: userId })
  for (const selection of [{ cycleId: '1002', type: 'person', responsibleUserId: userId }, { cycleId: '1001', type: 'person', responsibleUserId: null }, { cycleId: '1001', type: 'all', responsibleUserId: null }]) await run('okr publicity card configure', { boardId: '10', cardId, selection }, model)
  assert.deepEqual(writes(model).at(-1).body, { id: cardId, cycleId: '1001', type: '', responsibleUserId: '0' })
  const removed = await run('okr publicity card remove', { boardId: '10', cardId }, model); assert.equal(removed.result.cardRemoved, true); assert.equal(removed.result.objectivesDeleted, false); assert.deepEqual(model.boards[0].cardList, original)
})
test('board and card ordering use different nextId/behindId and independent complete order', async () => {
  const model = state()
  await run('okr publicity move', { boardId: '20', beforeId: '10' }, model)
  assert.deepEqual(writes(model)[0].body, { moveId: '20', nextId: '10' }); assert.deepEqual(model.boards.map(row => row.id), ['20', '10'])
  await run('okr publicity card move', { boardId: '10', cardId: '32', beforeId: '31' }, model)
  assert.deepEqual(writes(model)[1].body, { moveId: '32', behindId: '31' }); assert.deepEqual(model.boards.find(row => row.id === '10').cardList.map(row => row.id), ['32', '31'])
  const repeat = await run('okr publicity card move', { boardId: '10', cardId: '32', beforeId: '31' }, model); assert.deepEqual(repeat.skippedSteps, ['changed']); assert.equal(writes(model).length, 2)
})
test('cross-board, personal board, missing company board and cross-company filter IDs are refused before writes', async () => {
  for (const [command, input] of [
    ['okr publicity inspect', { boardId: '999' }], ['okr publicity card remove', { boardId: '20', cardId: '31' }],
    ['okr publicity card move', { boardId: '10', cardId: '31', beforeId: '999' }], ['okr publicity move', { boardId: '10', beforeId: '10' }],
    ['okr publicity card create', { boardId: '10', selection: { cycleId: '1001', type: 'dept', departmentId: '999', responsibleUserId: null } }],
    ['okr publicity card create', { boardId: '10', selection: { cycleId: '1001', type: 'company', departmentId: '71', responsibleUserId: null } }],
    ['okr publicity card create', { boardId: '10', selection: { cycleId: '1001', type: 'company', responsibleUserId: '999' } }],
  ]) { const model = state(); await assert.rejects(run(command, input, model), error => ['FORBIDDEN', 'INVALID_INPUT'].includes(error.code)); assert.equal(writes(model).length, 0) }
  const personal = state(); personal.boards[0].type = 'user'; await assert.rejects(run('okr publicity rename', { boardId: '10', name: 'bad' }, personal), { code: 'FORBIDDEN' }); assert.equal(writes(personal).length, 0)
})
test('archived/deleted cycle cards cannot be configured but may be explicitly removed; archived creation is refused', async () => {
  for (const cycleStatus of ['archive', 'delete']) {
    const model = state(); model.boards[0].cardList[0].cycleStatus = cycleStatus
    await assert.rejects(run('okr publicity card configure', { boardId: '10', cardId: '31', selection: { cycleId: '1001', type: 'all', responsibleUserId: null } }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 0)
    await run('okr publicity card remove', { boardId: '10', cardId: '31' }, model); assert.equal(writes(model).length, 1)
  }
  const model = state(); model.cycles.currentCycleList[0].isArchived = true
  await assert.rejects(run('okr publicity card create', { boardId: '10', selection: { cycleId: '1001', type: 'all', responsibleUserId: null } }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0)
})
test('fresh UI manage permission and changing list/configuration prevent blind writes', async () => {
  for (const mode of ['directory', 'permission', 'card']) {
    const model = state(); let reads = 0
    model.hook = call => { if (call.path.endsWith('/kanban/list') && ++reads === 2) { if (mode === 'directory') model.boards[1].name = 'concurrent'; if (mode === 'permission') model.canManage = false; if (mode === 'card') model.boards[0].cardList[0].responsibleUserId = userId } }
    await assert.rejects(run('okr publicity rename', { boardId: '10', name: 'rename' }, model), error => ['CONTEXT_CONFLICT', 'FORBIDDEN'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
})
test('HTTP success with lost selection or unrelated card change is rejected and not replayed', async () => {
  for (const mode of ['lost-filter', 'other-card']) {
    const model = state(); let changed = false
    model.hook = call => { if (call.method === 'PUT' && call.path.endsWith('/kanbanCard')) changed = true; if (changed && call.method === 'GET' && call.path.endsWith('/kanban')) { if (mode === 'lost-filter') model.boards[0].cardList[0].type = 'company'; else model.boards[0].cardList[1].responsibleUserId = userId } }
    await assert.rejects(run('okr publicity card configure', { boardId: '10', cardId: '31', selection: { cycleId: '1001', type: 'all', responsibleUserId: null } }, model), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.boardId === '10' && error.details.resources.cardId === '31'); assert.equal(writes(model).length, 1)
  }
})
test('unknown create response keeps completed steps and never automatically replays POST', async () => {
  const model = state(); model.hook = call => { if (call.method === 'POST' && call.path.endsWith('/kanban')) throw Error('connection lost') }
  await assert.rejects(run('okr publicity create', { name: 'new' }, model), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown' && error.details.retry === 'manual-after-readback'); assert.equal(writes(model).length, 1)
})
test('work plan headers are current-user company configuration, close uses item ID and preserves departments', async () => {
  const model = state(), originalTree = structuredClone(model.tree), originalItems = structuredClone(model.items), context = await run('okr work-plans context', {}, model)
  assert.equal(context.result.configurationScope, 'current-company-user'); assert.equal(context.result.openDepartments[0].id, '41'); assert.equal(context.result.openDepartments[0].deptId, '70')
  const added = await run('okr work-plans department open', { departmentId: '72' }, model), itemId = added.resources.itemId
  await run('okr work-plans department move', { itemId, beforeId: '41' }, model)
  assert.deepEqual(writes(model).at(-1).body, { moveId: itemId, nextId: '41' })
  const closed = await run('okr work-plans department close', { itemId }, model); assert.equal(closed.result.closed, true); assert.equal(closed.result.departmentDeleted, false)
  assert.deepEqual(writes(model).at(-1).query, { id: itemId }); assert.deepEqual(model.items, originalItems); assert.deepEqual(model.tree, originalTree)
})
test('work plan queries preserve type=dept, root department, exact filter and cursor instead of generic my context', async () => {
  for (const suffix of ['list', 'superiors']) {
    const model = state(), result = await run('okr work-plans objectives ' + suffix, { departmentId: '70', cycleId: '1001', filter: 'deptAndChildDeptUser', limit: 1, after: '9007199254740995' }, model)
    assert.deepEqual(model.calls.at(-1).query, { cycleId: '1001', type: 'dept', dataId: '70', filterType: 'deptAndChildDeptUser', max: '1', frontId: '9007199254740995' }); assert.equal(result.result.context, 'okr-work-plans'); assert.equal(result.result.pagination.next, '5001'); assert.equal(result.result.pagination.total, null)
  }
})
test('upper objective trees expose the terminal unaligned group without inventing a null cursor', async () => {
  for (const command of ['okr work-plans objectives superiors', 'okr planning objectives superiors']) {
    const model = state(); model.hook = call => call.path.endsWith('/superior/list') ? json([{ id: null, name: '无上级目标', isUnAlign: true, keyResultList: [] }]) : undefined
    const input = command.startsWith('okr work-plans ') ? { departmentId: '70', cycleId: '1001', limit: 1 } : { cycleId: '1001', limit: 1 }
    const result = await run(command, input, model)
    assert.equal(result.result.pagination.next, null); assert.equal(result.result.pagination.total, null); assert.equal(result.result.pagination.terminalGroup, 'unaligned-objectives-without-resource-id')
  }
})
test('personal OKR view preferences preserve all omitted fields and can restore query side effects', async () => {
  const model = state(), baseline = structuredClone(model.config), before = await run('okr preferences get', {}, model)
  assert.equal(before.result.userId, userId); assert.equal(before.result.preferences.okrUserId, '8101'); assert.equal(before.result.configurationScope, 'current-company-user')
  await run('okr preferences update', { isShowKeyResult: true, isHorizontal: true, isShowInitCard: false, isIndicatorHorizontal: false }, model)
  assert.equal(model.config.defaultCycleId, baseline.defaultCycleId); assert.equal(model.config.defaultModule, baseline.defaultModule)
  assert.equal(writes(model)[0].body.isShowInitCard, false)
  const unchanged = await run('okr preferences update', { isShowInitCard: false }, model); assert.deepEqual(unchanged.skippedSteps, ['changed'])
  await run('okr work-plans objectives list', { departmentId: '70', cycleId: '1001' }, model); assert.equal(model.config.defaultModule, 'objective')
  await run('okr preferences update', { defaultModule: baseline.defaultModule, isShowKeyResult: baseline.isShowKeyResult, isHorizontal: baseline.isHorizontal, isShowInitCard: baseline.isShowInitCard, isIndicatorHorizontal: baseline.isIndicatorHorizontal }, model)
  assert.deepEqual(model.config, baseline)
  const mismatch = state(); mismatch.user.id = '999'; await assert.rejects(run('okr preferences update', { isShowKeyResult: true }, mismatch), { code: 'IDENTITY_CHANGED' }); assert.equal(writes(mismatch).length, 0)
})
test('personal preference conflicts and accepted-but-unpersisted patches fail without blind overwrites', async () => {
  for (const mode of ['preflight', 'readback', 'identity-preflight', 'identity-readback']) {
    const model = state(); let reads = 0, changed = false
    model.hook = call => {
      if (call.path.endsWith('/okr/config') && call.method === 'GET') { reads++; if (mode === 'preflight' && reads === 2) model.config.defaultCycleId = '1002'; if (mode === 'readback' && changed) model.config.isHorizontal = false }
      if (call.path.endsWith('/okr/config') && call.method === 'GET' && (mode === 'identity-preflight' && reads === 2 || mode === 'identity-readback' && changed)) model.config.userId = '8102'
      if (call.path.endsWith('/okr/config') && call.method === 'PUT') changed = true
    }
    const preflight = mode.endsWith('preflight')
    await assert.rejects(run('okr preferences update', { isHorizontal: true }, model), { code: preflight ? 'CONTEXT_CONFLICT' : 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(model).length, preflight ? 0 : 1)
  }
})
test('work plan wrong company, duplicate department, mixed-up tab ID, stale list and invalid ordering are rejected', async () => {
  for (const [command, input] of [
    ['okr work-plans department open', { departmentId: '70' }], ['okr work-plans department open', { departmentId: '999' }], ['okr work-plans department close', { itemId: '70' }],
    ['okr work-plans department move', { itemId: '41', afterId: '41' }], ['okr work-plans objectives list', { departmentId: '41', cycleId: '1001' }], ['okr work-plans objectives list', { departmentId: '70', cycleId: '999' }],
  ]) { const model = state(); await assert.rejects(run(command, input, model), error => ['FORBIDDEN', 'INVALID_INPUT'].includes(error.code)); assert.equal(writes(model).length, 0) }
  const stale = state(); let reads = 0; stale.hook = call => { if (call.path.endsWith('/plan/item/list') && ++reads === 2) stale.items[0].name = 'changed' }
  await assert.rejects(run('okr work-plans department close', { itemId: '41' }, stale), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(stale).length, 0)
})
test('all public view commands have offline dry-run, schema context, confirmation, raw guards and exact feature requirements', async () => {
  const selected = workflows.workflows.filter(flow => flow.command.startsWith('okr publicity ') || flow.command.startsWith('okr work-plans ')); assert.equal(selected.length, 17)
  const offline = state(); offline.transport = () => { throw Error('offline dry-run must not send HTTP') }
  for (const [command, input] of [['okr publicity create', { name: 'offline' }], ['okr publicity card configure', { boardId: '10', cardId: '31', selection: { cycleId: '1001', type: 'all', responsibleUserId: null } }], ['okr work-plans department close', { itemId: '41' }]]) {
    assert.equal((await run(command, input, offline, { dryRun: true })).dryRun, true); assert.ok(workflowSchema(definition(command)).steps.length > 0)
    await assert.rejects(run(command, input, offline, { approved: false }), { code: 'CONFIRMATION_REQUIRED' })
  }
  for (const [route, body] of [['/task/okr/kanban', { name: 'fixture', type: 'team' }], ['/task/okr/kanbanCard', { kanbanId: '10', cycleId: '1001' }], ['/task/okr/plan/item', { deptId: '70' }]]) {
    const op = catalog.operations.find(op => op.route === route && op.method === 'POST')
    await assert.rejects(executeOperation(ctx, op, { body }, session, { transport: offline.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  }
  assert.ok(accessPlan(definition('okr publicity create'), {}).features.includes('OKR_PUBLICITY')); assert.ok(accessPlan(definition('okr work-plans context'), {}).features.includes('OKR_WORK'))
})
test('expiry, overcapacity, unopened modules and feature permissions stop new view business HTTP even with yes', async () => {
  for (const [mode, expected] of [['expired', 'COMPANY_EXPIRED'], ['capacity', 'COMPANY_OVER_CAPACITY'], ['publicity', 'FEATURE_DISABLED'], ['work-plans', 'FEATURE_DISABLED'], ['role', 'FEATURE_FORBIDDEN']]) {
    const model = state(), command = mode === 'work-plans' ? 'okr work-plans context' : 'okr publicity create'
    if (mode === 'expired') model.state.deadLine = '2020-01-01 00:00:00'; if (mode === 'capacity') model.state.usersCount = 6
    if (mode === 'publicity') model.features.find(row => row.funcName === 'OKR_PUBLICITY').status = 'disable'
    if (mode === 'work-plans') model.features.find(row => row.funcName === 'OKR_WORK').status = 'disable'
    if (mode === 'role') model.permissions.useObjective = false
    await assert.rejects(executeWorkflow(ctx, definition(command), command.endsWith('create') ? { name: 'blocked' } : {}, session, { approved: true, transport: model.transport }), { code: expected })
    assert.ok(model.calls.every(call => !/\/okr\//.test(call.path))); assert.equal(writes(model).length, 0)
  }
})
