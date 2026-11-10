import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows, workflowSchema } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', identity: { userId, teamId: '7', username: 'fixture' }, accessToken: 'private-token', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value))
function state(patch = {}) {
  const model = { user: { success: true, id: userId, username: 'fixture', token: 'never-expose-token', team: { id: '7', name: 'company' }, personRealName: '原姓名', professional: '工程师', birth: '2000.02.29', hasAvatar: false, avatar: 'https://private.example/secret-avatar', email: 'private@example.com', phoneNumber: 'private-phone', oauth: { secret: 'private-oauth' }, setting: { showTipBox: true, fullPopup: false, themeSkin: 'skin_0', navigationBarStatus: 'sidebar', docViewMode: 'normal', showChildDeptUsers: true, isEnableWaterMark: true, fixedNavigationBar: true, futureUnmanagedPreference: { enabled: true }, expireAlertFlag: false } }, calls: [], ...patch }
  model.transport = async (url, init) => {
    const call = { method: init.method, path: url.pathname, body: init.body == null ? undefined : JSON.parse(init.body) }; model.calls.push(call)
    if (model.hook) { const response = await model.hook(call, model); if (response) return response }
    if (call.path === '/task/login/authAjax') return json(model.user)
    if (call.path.endsWith('/changeUserInfo')) { for (const key of ['personRealName', 'professional', 'birth']) if (Object.hasOwn(call.body, key)) model.user[key] = call.body[key]; return new Response('') }
    if (call.path.endsWith('/changeUserVariable')) { Object.assign(model.user.setting, call.body); return new Response('') }
    if (call.path.endsWith('/getTeamStatus')) return json({ vt: 1, usersCount: 1, userLimit: 5, deadLine: '2099.01.01' })
    throw Error('Unexpected request ' + call.path)
  }
  return model
}
const flow = command => structuredClone(workflows.workflows.find(flow => flow.command === command))
const run = (command, input, model, options = {}) => runWorkflow(ctx, flow(command), input, session, { approved: true, transport: model.transport, ...options })
const writes = model => model.calls.filter(call => call.method !== 'GET')
test('profile and preferences discovery returns precise identities and whitelisted fields without session or OAuth payloads', async () => {
  for (const command of ['identity profile get', 'identity preferences get', 'contact display get']) {
    const model = state(), result = await run(command, {}, model)
    assert.equal(result.result.identity.userId, userId); assert.equal(result.result.profile.birthday, '2000-02-29')
    assert.equal(result.result.scope.name, 'account'); assert.equal(result.result.scope.position, 'current-company-user')
    assert.equal(result.result.scope.showChildDeptUsers, 'personal-display-only')
    assert.doesNotMatch(JSON.stringify(result), /never-expose-token|private-oauth|private-phone|private@example|secret-avatar/)
    assert.equal(writes(model).length, 0)
  }
})
test('profile update sends only the changed explicit fields and verifies independent readback including omitted settings', async () => {
  const model = state(), result = await run('identity profile update', { name: '新姓名', birthday: '2004-02-29' }, model)
  assert.deepEqual(writes(model)[0].body, { personRealName: '新姓名', birth: '2004.02.29' })
  assert.equal(result.result.profile.name, '新姓名'); assert.equal(result.result.profile.position, '工程师'); assert.equal(result.result.verified, true)
  assert.equal(model.calls.filter(call => call.path.endsWith('authAjax')).length, 3); assert.equal(writes(model).length, 1)
  assert.equal(model.user.setting.isEnableWaterMark, true)
})
test('profile clearing retains actual JSON null birthday and empty position, and a repeated unchanged patch makes no write', async () => {
  const model = state(), result = await run('identity profile update', { position: null, birthday: null }, model)
  assert.deepEqual(writes(model)[0].body, { professional: '', birth: null }); assert.equal(result.result.profile.position, null); assert.equal(result.result.profile.birthday, null)
  const second = await run('identity profile update', { position: null, birthday: null }, model)
  assert.equal(second.result.changed, false); assert.deepEqual(second.skippedSteps, ['changed']); assert.equal(writes(model).length, 1)
})
test('preferences preserve false as JSON boolean and do not replace unmodified personal or company settings', async () => {
  const model = state(), before = structuredClone(model.user), input = { showTipBox: false, fullPopup: true, navigationBarStatus: 'topbar', themeSkin: 'skin_9' }
  const result = await run('identity preferences update', input, model)
  assert.deepEqual(writes(model)[0].body, input); assert.equal(writes(model).length, 1)
  assert.equal(result.result.preferences.showTipBox, false); assert.deepEqual(model.user.setting.futureUnmanagedPreference, before.setting.futureUnmanagedPreference)
  assert.equal(model.user.professional, before.professional); assert.equal(model.user.birth, before.birth); assert.equal(model.user.setting.showChildDeptUsers, true)
  const back = await run('identity preferences update', { fullPopup: false }, model)
  assert.equal(back.result.preferences.fullPopup, false); assert.deepEqual(writes(model)[1].body, { fullPopup: false })
})
test('known server document-width persistence defect blocks the whole patch before any write, including mixed preferences', async () => {
  const model = state()
  await assert.rejects(run('identity preferences update', { showTipBox: false, docViewMode: 'wide' }, model), { code: 'PERSISTENCE_UNSUPPORTED' })
  assert.equal(writes(model).length, 0); assert.equal(model.user.setting.showTipBox, true)
  const unchanged = await run('identity preferences update', { docViewMode: 'normal' }, model)
  assert.equal(unchanged.result.changed, false); assert.equal(unchanged.result.persistence.docViewMode.writable, false)
})
test('contact display preference has its own personal-display command, and cannot change organization visibility', async () => {
  const model = state(), result = await run('contact display update', { showChildDeptUsers: false }, model)
  assert.deepEqual(writes(model)[0].body, { showChildDeptUsers: false }); assert.equal(result.result.preferences.showChildDeptUsers, false)
  for (const [command, input] of [['contact display update', { showChildDeptUsers: false, visibility: 'all' }], ['identity preferences update', { isEnableWaterMark: false }], ['identity preferences update', { showChildDeptUsers: false }]]) {
    const rejected = state(); await assert.rejects(run(command, input, rejected), { code: 'INVALID_INPUT' }); assert.equal(rejected.calls.length, 0)
  }
})
test('invalid dates, unsupported birthday years, control characters and empty names are never written', async () => {
  for (const input of [{ birthday: '2025-02-29' }, { birthday: '2000-13-01' }, { birthday: '2099-01-01' }, { birthday: '1800-01-01' }, { name: '  ' }, { name: 'line\nname' }, { position: 'bad\u0000position' }]) {
    const model = state(); await assert.rejects(run('identity profile update', input, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0)
  }
})
test('identity mismatches, missing exact IDs and incomplete response context fail before a write', async () => {
  for (const mutate of [m => m.user.id = Number(userId), m => m.user.team.id = '8', m => m.user.username = 'someone-else', m => delete m.user.professional, m => delete m.user.setting.fullPopup]) {
    const model = state(); mutate(model)
    await assert.rejects(run('identity profile update', { position: 'next' }, model), error => ['CONTEXT_MISSING', 'IDENTITY_CHANGED'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
})
test('preflight changes to another field or future preference stop overwrite; computed expiry flags do not create false conflicts', async () => {
  for (const mutate of [m => m.user.professional = 'concurrent', m => m.user.setting.futureUnmanagedPreference.enabled = false]) {
    const model = state({ hook(call, model) { if (model.calls.filter(c => c.path.endsWith('authAjax')).length === 2) mutate(model) } })
    await assert.rejects(run('identity preferences update', { fullPopup: true }, model), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(model).length, 0)
  }
  const model = state({ hook(call, model) { model.user.setting.expireAlertFlag = !model.user.setting.expireAlertFlag } })
  await run('identity preferences update', { fullPopup: true }, model); assert.equal(writes(model).length, 1)
})
test('accepted write followed by response drift reports failure without replay and without private identity data', async () => {
  const model = state({ hook(call, model) { if (call.path.endsWith('authAjax') && writes(model).length) model.user.personRealName = 'concurrent' } })
  await assert.rejects(run('identity preferences update', { fullPopup: true }, model), error => {
    assert.doesNotMatch(JSON.stringify(error.details), /never-expose-token|private-phone|private-oauth|secret-avatar/)
    return error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.userId === userId && error.details.completedSteps.includes('changed')
  }); assert.equal(writes(model).length, 1)
})
test('timed-out write is not automatically retried and reports known identity resources', async () => {
  const model = state({ hook(call) { if (call.method === 'POST') throw Error('network timeout') } })
  await assert.rejects(run('identity preferences update', { fullPopup: true }, model), error => error.details.resources.userId === userId && error.details.failedStep === 'changed')
  assert.equal(writes(model).length, 1)
})
test('dry-run is offline with pending contexts, requires no live session, and reports account-wide effect in Schema', async () => {
  const model = state(), result = await runWorkflow(ctx, flow('identity profile update'), { position: 'draft' }, null, { dryRun: true, transport: model.transport })
  assert.equal(model.calls.length, 0); assert.match(JSON.stringify(result), /preflight/)
  assert.equal(workflowSchema(flow('identity profile update')).confirmation, 'required')
  const unapproved = state(); await assert.rejects(run('identity profile update', { position: 'next' }, unapproved, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(unapproved.calls.length, 0)
})
test('raw writes require reviewed business context rather than accepting arbitrary settings or unverified profile mutations', async () => {
  for (const suffix of ['changeUserInfo', 'changeUserVariable']) {
    const op = catalog.operations.find(op => op.route.endsWith('/' + suffix)), model = state()
    await assert.rejects(executeOperation(ctx, op, { body: suffix === 'changeUserInfo' ? { professional: 'next' } : { showChildDeptUsers: false } }, session, { approved: true, transport: model.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(model.calls.length, 0)
  }
})
