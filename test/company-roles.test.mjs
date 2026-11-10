import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows, workflowSchema } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { accessPlan } from '../dist/access.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', identity: { userId, teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value)), labels = { company: 'company', kanban: 'project', corpus: 'knowledge', lib: 'cloud', archive: 'archive' }
function state() {
  const model = { calls: [], user: { success: true, id: userId, username: 'fixture', team: { id: '7', name: 'company' }, userRole: { id: '81', type: 'teamCreator' }, token: 'private-token' }, state: { vt: 'fixture', mainApp: 'TEAM', deadLine: '2099-01-01 23:59:59', usersCount: 1, userLimit: 5 }, features: [{ funcName: 'TEAM_AUTH_MANAGE', status: 'enable' }], permissions: { viewAuthorityManage: true, createCustomRole: true, editCustomRole: true, removeCustomRole: true, editDataManage: true }, roles: {}, trees: {}, nextId: 100 }
  for (const module of Object.keys(labels)) {
    model.roles[module] = { defaultRoles: [{ id: '81', name: 'creator', type: (module === 'company' ? 'team' : module) + 'Creator' }, { id: '82', name: 'member', type: module + 'Common' }], customRoles: ['company', 'kanban', 'corpus'].includes(module) ? [{ id: '83', name: 'custom', type: 'custom' }] : [] }
    model.trees[module] = [{ name: '资源', group: 'task', authorities: [{ id: '91', name: 'viewResource', description: 'read', status: true }, { id: '92', name: 'editResource', description: 'write', status: false }, ...(module === 'company' ? [{ id: '93', name: 'taskExecutorScope', description: 'range', status: true, scopes: [{ id: '94', name: 'ownScope', description: 'self', status: true }, { id: '95', name: 'teamScope', description: 'all', status: false }] }] : [])] }]
  }
  model.transport = async (url, init) => {
    const call = { method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body == null ? undefined : JSON.parse(init.body) }; model.calls.push(call)
    if (model.hook) { const response = await model.hook(call, model); if (response) return response }
    if (call.path.endsWith('/authAjax')) return json(model.user)
    if (call.path.endsWith('/member/state/independent')) return json(model.state)
    if (call.path.endsWith('/function/available')) return json(model.features)
    if (call.path.endsWith('/authorities/company/current')) return json(model.permissions)
    const role = /\/role\/(company|kanban|corpus|lib|archive)$/.exec(call.path)
    if (role) {
      const list = model.roles[role[1]]
      if (call.method === 'GET') return json(list)
      if (call.method === 'POST') { const added = { id: String(model.nextId++), name: call.body.name, type: 'custom' }; list.customRoles.push(added); return json(added) }
      if (call.method === 'PUT') list.customRoles.find(row => row.id === call.body.id).name = call.body.name
      if (call.method === 'DELETE') list.customRoles = list.customRoles.filter(row => row.id !== call.query.id)
      return new Response('')
    }
    const auth = /\/authorities\/(company|kanban|corpus|lib|archive)(\/batch)?$/.exec(call.path)
    if (auth) {
      if (call.method === 'GET') return json(model.trees[auth[1]])
      const fields = model.trees[auth[1]].flatMap(group => group.authorities)
      if (call.body.scopes) fields.find(field => field.name === call.body.name).scopes = fields.find(field => field.name === call.body.name).scopes.map(scope => ({ ...scope, status: call.body.scopes.find(row => row.name === scope.name).status }))
      else for (const name of call.body.nameList ?? [call.body.name]) fields.find(field => field.name === name).status = call.body.status
      return new Response('')
    }
    throw Error('Unexpected request ' + call.path)
  }
  return model
}
const definition = command => structuredClone(workflows.workflows.find(flow => flow.command === command))
const run = (suffix, input, model, module = 'company', options = {}) => runWorkflow(ctx, definition('organization role ' + labels[module] + ' ' + suffix), { companyId: '7', ...input }, session, { approved: true, transport: model.transport, ...options })
const writes = model => model.calls.filter(call => call.method !== 'GET')
for (const module of Object.keys(labels)) test(module + ' discovery returns actual precise role IDs, current feature checks and permission options', async () => {
  const model = state(), result = await runWorkflow(ctx, definition('organization roles ' + labels[module] + ' list'), { companyId: '7' }, session, { transport: model.transport })
  assert.equal(result.result.module, module); assert.equal(result.result.companyId, '7'); assert.equal(result.result.roles[0].id, '81')
  assert.equal(result.result.customRolesSupported, ['company', 'kanban', 'corpus'].includes(module)); assert.doesNotMatch(JSON.stringify(result), /private-token/)
  const permissions = await run('permissions get', { roleId: '82' }, model, module)
  assert.equal(permissions.result.authorities[0].authorities[0].name, 'viewResource'); assert.equal(writes(model).length, 0)
})
for (const module of ['company', 'kanban', 'corpus']) test(module + ' custom role create/rename/remove uses actual new ID, independent lists and preserves all other roles', async () => {
  const model = state(), initial = structuredClone(model.roles[module]), created = await run('create', { name: 'new-role' }, model, module), roleId = created.resources.roleId
  assert.equal(roleId, '100'); assert.ok(created.result.roles.some(role => role.id === roleId && role.custom))
  await run('rename', { roleId, name: 'renamed' }, model, module)
  assert.equal(model.roles[module].customRoles.find(role => role.id === roleId).name, 'renamed')
  const removed = await run('remove', { roleId }, model, module)
  assert.equal(removed.result.removed, true); assert.equal(removed.result.usageEnumerationSupported, false); assert.equal(removed.result.affectedUsers, 'server-reassigns-all-uses-to-default-role')
  assert.deepEqual(model.roles[module], initial); assert.equal(writes(model).length, 3)
})
for (const module of Object.keys(labels)) test(module + ' single/batch permission booleans persist and omitted flags/scopes remain unchanged', async () => {
  const model = state(), initial = structuredClone(model.trees[module]), result = await run('permissions set', { roleId: '82', name: 'editResource', enabled: true }, model, module)
  assert.equal(result.result.verified, true); assert.deepEqual(writes(model)[0].body, { roleId: '82', name: 'editResource', status: true })
  if (module === 'company') assert.deepEqual(model.trees[module][0].authorities[2], initial[0].authorities[2])
  await run('permissions batch-set', { roleId: '82', names: ['viewResource', 'editResource'], enabled: false }, model, module)
  assert.deepEqual(writes(model)[1].body, { roleId: '82', nameList: ['viewResource', 'editResource'], status: false })
  assert.equal(model.trees[module][0].authorities[0].status, false); assert.equal(model.trees[module][0].authorities[1].status, false)
  const repeat = await run('permissions batch-set', { roleId: '82', names: ['viewResource', 'editResource'], enabled: false }, model, module)
  assert.deepEqual(repeat.skippedSteps, ['changed']); assert.equal(writes(model).length, 2)
})
test('scope selection constructs the full existing scope set and preserves all other permissions', async () => {
  const model = state(), before = structuredClone(model.trees.company)
  await run('permissions set', { roleId: '82', name: 'taskExecutorScope', scope: 'teamScope' }, model)
  assert.deepEqual(writes(model)[0].body, { roleId: '82', name: 'taskExecutorScope', status: true, scopes: [{ name: 'ownScope', status: false }, { name: 'teamScope', status: true }] })
  assert.deepEqual(model.trees.company[0].authorities.slice(0, 2), before[0].authorities.slice(0, 2))
})
test('company creator scope follows UI exemption, while ordinary creator checkboxes remain protected', async () => {
  const model = state(); model.features[0].status = 'disable'
  await executeWorkflow(ctx, definition('organization role company permissions set'), { companyId: '7', roleId: '81', name: 'taskExecutorScope', scope: 'teamScope' }, session, { approved: true, transport: model.transport })
  assert.equal(writes(model).length, 1)
  const denied = state(); await assert.rejects(run('permissions set', { roleId: '81', name: 'editResource', enabled: false }, denied), { code: 'FORBIDDEN' }); assert.equal(writes(denied).length, 0)
})
test('noncreator scopes require both available UI feature and editDataManage; wrong groups and unknown choices are refused', async () => {
  for (const mode of ['feature', 'data-manage', 'group', 'unknown-scope', 'enabled-and-scope']) {
    const model = state(); model.user.userRole.type = 'teamAdmin'
    if (mode === 'feature') model.features[0].status = 'disable'
    if (mode === 'data-manage') model.permissions.editDataManage = false
    if (mode === 'group') model.trees.company[0].group = 'unknown-group'
    await assert.rejects(run('permissions set', { roleId: '82', name: 'taskExecutorScope', scope: mode === 'unknown-scope' ? 'invented' : 'teamScope', ...(mode === 'enabled-and-scope' && { enabled: true }) }, model), error => ['FEATURE_DISABLED', 'FEATURE_FORBIDDEN', 'FORBIDDEN', 'INVALID_INPUT'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
})
test('default roles, unknown IDs and unsupported cloud/archive custom CRUD are rejected', async () => {
  for (const suffix of ['rename', 'remove']) { const model = state(); await assert.rejects(run(suffix, { roleId: '81', ...(suffix === 'rename' && { name: 'new' }) }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 0) }
  for (const module of ['lib', 'archive']) for (const suffix of ['create', 'rename', 'remove']) assert.equal(workflows.workflows.some(flow => flow.command === 'organization role ' + labels[module] + ' ' + suffix), false)
  const missing = state(); await assert.rejects(run('permissions get', { roleId: '900' }, missing), { code: 'FORBIDDEN' }); assert.equal(writes(missing).length, 0)
})
test('all fixed exit permissions are protected and scoped fields cannot be toggled by a generic or batch flag', async () => {
  for (const [module, name] of Object.entries({ company: 'quitTeam', kanban: 'quitKanban', corpus: 'quitCorpus', lib: 'quitLib', archive: 'quitArchiveBag' })) {
    const model = state(); model.trees[module][0].authorities.push({ id: '99', name, status: true })
    await assert.rejects(run('permissions set', { roleId: '82', name, enabled: false }, model, module), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0)
  }
  for (const [suffix, input] of [['permissions set', { name: 'taskExecutorScope', enabled: true }], ['permissions batch-set', { names: ['taskExecutorScope'], enabled: true }], ['permissions set', { name: 'missing', enabled: true }]]) {
    const model = state(); await assert.rejects(run(suffix, { roleId: '82', ...input }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0)
  }
})
test('preflight conflicts and refreshed permission denial stop writes', async () => {
  for (const mode of ['roles', 'tree', 'permission']) {
    const model = state(); let roleReads = 0, treeReads = 0, permissionReads = 0
    model.hook = call => {
      if (call.path.endsWith('/role/company') && ++roleReads === 2 && mode === 'roles') model.roles.company.customRoles[0].name = 'concurrent'
      if (call.path.endsWith('/authorities/company') && ++treeReads === 2 && mode === 'tree') model.trees.company[0].authorities[0].status = false
      if (call.path.endsWith('/authorities/company/current') && ++permissionReads === 2 && mode === 'permission') model.permissions.editCustomRole = false
    }
    await assert.rejects(run('permissions set', { roleId: '82', name: 'editResource', enabled: true }, model), error => ['CONTEXT_CONFLICT', 'FEATURE_FORBIDDEN'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
})
test('an accepted permission write with incomplete readback fails without replay; timeout keeps role identity for recovery', async () => {
  const drift = state({}); drift.hook = (call, model) => { if (call.path.endsWith('/authorities/company') && call.method === 'GET' && writes(model).length) model.trees.company[0].authorities[0].status = false }
  await assert.rejects(run('permissions set', { roleId: '82', name: 'editResource', enabled: true }, drift), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.roleId === '82'); assert.equal(writes(drift).length, 1)
  const timeout = state(); timeout.hook = call => { if (call.method === 'PUT') throw Error('timeout') }
  await assert.rejects(run('permissions set', { roleId: '82', name: 'editResource', enabled: true }, timeout), error => error.details.failedStep === 'changed' && error.details.resources.roleId === '82'); assert.equal(writes(timeout).length, 1)
})
test('public dispatcher enforces feature, expiry, overcapacity and role permissions before company mutation', async () => {
  for (const mode of ['expired', 'overcapacity', 'feature', 'permission']) {
    const model = state(); if (mode === 'expired') model.state.deadLine = '2020-01-01 23:59:59'; if (mode === 'overcapacity') model.state.usersCount = 6; if (mode === 'feature') model.features[0].status = 'disable'; if (mode === 'permission') model.permissions.createCustomRole = false
    await assert.rejects(executeWorkflow(ctx, definition('organization role company create'), { companyId: '7', name: 'new' }, session, { approved: true, transport: model.transport }), error => ['COMPANY_EXPIRED', 'COMPANY_OVER_CAPACITY', 'FEATURE_DISABLED', 'FEATURE_FORBIDDEN'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
  assert.deepEqual(accessPlan(definition('organization roles archive list')).features, ['ARCHIVE'])
})
test('company IDs and confirmation are explicit, raw access is guarded, and dry-run stays offline', async () => {
  const wrong = state(); await assert.rejects(run('create', { companyId: '8', name: 'new' }, wrong), { code: 'INVALID_INPUT' }); assert.equal(writes(wrong).length, 0)
  const unapproved = state(); await assert.rejects(run('create', { name: 'new' }, unapproved, 'company', { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(unapproved.calls.length, 0)
  const dry = state(); await run('permissions set', { roleId: '82', name: 'editResource', enabled: true }, dry, 'company', { dryRun: true }); assert.equal(dry.calls.length, 0)
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/authority/v3/authorities/company')
  await assert.rejects(executeOperation(ctx, op, { body: { roleId: '82', name: 'editResource', status: true } }, session, { approved: true, transport: dry.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(dry.calls.length, 0)
  assert.equal(workflowSchema(definition('organization role company remove')).confirmation, 'required')
})
