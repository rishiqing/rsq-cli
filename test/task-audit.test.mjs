import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { validateTaskAuditWorkflow } from '../dist/task-audit.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const base = '/task/api/v3/task/template/field', target = { taskId: 'task-1', projectId: '7001', fieldId: '9007199254740993123', stage: 'confirm' }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = command => { const item = workflows.workflows.find(flow => flow.command === 'task audit ' + command); assert.ok(item); return item }
const run = (command, input, f, options = {}) => runWorkflow(ctx, flow(command), { ...target, ...input }, session, { transport: f.transport, approved: true, ...options })
function fixture(options = {}) {
  const calls = [], task = { id: 'task-1', from: { projectId: 7001 }, isClose: false }
  const audit = { id: '9007199254740993125', name: '一级审核', status: options.active ? 'doing' : '', userType: options.optional ? 'memberOptional' : 'specified', nodeType: 'and', editControl: { canChangeMember: true }, users: [{ id: 81, showName: '本人', status: options.active ? 'doing' : '' }] }
  const config = { enable: true, auditStatus: options.active ? 'doing' : 'pending', auditMode: options.complex ? 1 : 0, simpleList: [audit], complexList: [{ id: '205', audits: [audit] }], actionList: [], signatureRequirement: options.signature ? 'always' : null, contentRequirement: 'always', autoActionOnReject: options.deleteTask ? 'deleteTask' : null }
  const field = { id: target.fieldId, type: 31, name: '审核', audits: { confirm: config, completion: config }, editControl: { canSubmitConfirm: true, canSubmitCompletion: true, canAgreeConfirm: true, canAgreeCompletion: true, canRefuseConfirm: true, canRefuseCompletion: true, canReverseConfirm: true, canReverseCompletion: true, ...options.buttons } }
  const tree = [{ id: 7, name: 'Fixture', type: 'top', parentId: null, displayOrder: 1, userList: [{ id: 81 }, { id: 82 }], childList: [] }]
  return { calls, task, field, config, audit, transport: async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method: init.method, query, body })
    if (path.endsWith('/authAjax')) return json({ id: options.identityChanged ? 82 : 81, username: 'fixture', team: { id: 7, name: 'fixture' }, success: true, token: 'private' })
    if (path.endsWith('/member/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 3 : 1, userLimit: 2, vt: 'enterprise', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'PLAN', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'TASK_TYPE', status: 'enable' }])
    if (path.endsWith('/authorities/company/current')) return json({ useKanban: true })
    if (path.endsWith('/kanbanCrud')) return json({ id: options.foreignProject ? 7002 : 7001 })
    if (path.endsWith('/task/editcontrol')) return json({ taskId: 'task-1', module: query.module, siteId: query.siteId, editControl: { removeTask: !options.noRemove } })
    if (path.endsWith('/task/template')) return json({ templateFields: [field] })
    if (path.endsWith('/department/list')) return json(tree)
    if (path.endsWith('/getComplexId')) return json({ complexId: options.foreignCondition ? '206' : '205' })
    if (path === '/task/v1/folder/file') return json({ id: '9007199254740993127', name: 'signature.png', size: 68, creatorId: options.foreignSignature ? 82 : 81 })
    if (path.endsWith('/signature/getFront')) return json({ fileId: '9007199254740993127', realPath: 'https://example.invalid/private-signature' })
    if (path === base + '/audit/submit/check') return json({ canSubmit: !options.missingRequired, message: options.missingRequired ? '请填写说明' : null })
    if (path === base + '/audit/submit') {
      if (options.timeout) throw Error('unknown write result')
      if (!options.ignoreWrite) { config.auditStatus = 'doing'; audit.status = 'doing'; audit.users.forEach(user => { user.status = 'doing' }) }
      return new Response(null, { status: 204 })
    }
    if (path === base + '/auditUser') { if (!options.ignoreWrite) audit.users = body.userIds.split(',').filter(Boolean).map(id => ({ id, status: '' })); return new Response(null, { status: 204 }) }
    if (path === base + '/audit') {
      assert.equal(body.auditId, audit.id); assert.equal(body.taskId, task.id)
      if (options.timeout) throw Error('unknown write result')
      if (!options.ignoreWrite) {
        config.auditStatus = body.action === 'agree' ? 'passed' : body.action === 'refuse' ? 'reject' : 'pending'
        audit.status = body.action === 'agree' ? 'passed' : body.action === 'refuse' ? 'reject' : 'doing'
        audit.users[0].status = body.action === 'agree' ? 'finished' : body.action === 'refuse' ? 'refused' : 'doing'
        config.actionList.push({ id: '901', status: audit.users[0].status, userVO: { id: 81 }, explanation: body.content, fileVO: body.signatureFileId ? { id: body.signatureFileId } : null })
      }
      return new Response(null, { status: 204 })
    }
    if (path === '/task/api/v3/task') return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(task)
    if (path.endsWith('/recycleBin/list')) return json([{ id: '501', resourceId: task.id, userId: 81, type: 5 }])
    throw Error('unexpected ' + init.method + ' ' + path)
  } }
}
test('task audit inspect exposes exact dynamic nodes and rejects task/project/identity mismatches', async () => {
  const f = fixture(), result = (await run('inspect', {}, f)).result
  assert.equal(result.nodes[0].id, f.audit.id); assert.equal(result.fieldId, target.fieldId); assert.match(result.contextVersion, /^[a-f0-9]{64}$/)
  for (const options of [{ identityChanged: true }, { foreignProject: true }]) { const wrong = fixture(options); await assert.rejects(run('submit', {}, wrong)); assert.ok(!wrong.calls.some(call => call.method === 'PUT')) }
  const hidden = fixture(); hidden.field.isHidden = true; await assert.rejects(run('inspect', {}, hidden), { code: 'RESOURCE_NOT_VISIBLE' })
})
test('submission checks current UI buttons and required fields before a single write, then independently verifies state', async () => {
  const f = fixture(); const result = (await run('submit', {}, f)).result
  assert.equal(result.status, 'doing'); assert.equal(f.calls.filter(call => call.path === base + '/audit/submit').length, 1)
  assert.deepEqual(f.calls.find(call => call.path === base + '/audit/submit').body, { taskId: 'task-1', taskTemplateFieldId: target.fieldId, stepType: 'confirm' })
  for (const options of [{ missingRequired: true }, { buttons: { canSubmitConfirm: false } }]) { const denied = fixture(options); await assert.rejects(run('submit', {}, denied)); assert.ok(!denied.calls.some(call => call.method === 'PUT')) }
  const completion = fixture({ complex: true }); delete completion.config.enable; await run('submit', { stage: 'completion' }, completion)
  assert.ok(completion.calls.some(call => call.path.endsWith('/getComplexId'))); assert.ok(!completion.calls.some(call => call.path.endsWith('/submit/check')))
  const branch = fixture({ complex: true, foreignCondition: true }); await assert.rejects(run('submit', { stage: 'completion' }, branch)); assert.ok(!branch.calls.some(call => call.method === 'PUT'))
})
test('optional reviewer changes use the actual condition branch, node permissions and current company members', async () => {
  const f = fixture({ optional: true, complex: true }); await run('reviewers set', { stage: 'completion', nodeId: f.audit.id, userIds: ['82'] }, f)
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/auditUser')).body, { auditId: f.audit.id, userIds: '82' })
  for (const input of [{ nodeId: '404', userIds: ['81'] }, { nodeId: f.audit.id, userIds: ['99'] }]) { const denied = fixture({ optional: true }); await assert.rejects(run('reviewers set', input, denied)); assert.ok(!denied.calls.some(call => call.method === 'PUT')) }
  const denied = fixture({ optional: true }); denied.audit.editControl.canChangeMember = false
  await assert.rejects(run('reviewers set', { nodeId: denied.audit.id, userIds: [] }, denied), { code: 'RESOURCE_FORBIDDEN' })
  const empty = fixture({ optional: true }); empty.audit.users = []; await assert.rejects(run('submit', {}, empty), { code: 'INVALID_INPUT' })
})
test('agree/refuse/reverse derive the active node and reject stale or unauthorized actor context', async () => {
  for (const [action, expected] of [['agree', 'passed'], ['refuse', 'reject'], ['reverse', 'pending']]) {
    const f = fixture({ active: true }); const result = (await run('act', { action, nodeId: f.audit.id, ...(action !== 'reverse' && { content: '当前意见' }) }, f)).result
    assert.equal(result.status, expected); assert.ok(!f.calls.some(call => call.method === 'DELETE'))
  }
  const f = fixture({ active: true }); await assert.rejects(run('act', { action: 'agree', nodeId: '404' }, f), { code: 'CONTEXT_CONFLICT' }); assert.ok(!f.calls.some(call => call.method === 'PUT'))
  const denied = fixture({ active: true }); denied.audit.users[0].id = 82
  await assert.rejects(run('act', { action: 'agree' }, denied), { code: 'RESOURCE_FORBIDDEN' })
  const button = fixture({ active: true, buttons: { canAgreeConfirm: false } }); await assert.rejects(run('act', { action: 'agree' }, button), { code: 'RESOURCE_FORBIDDEN' })
})
test('signature-required decisions require explicit consent and only fetch the current user signature', async () => {
  const missing = fixture({ active: true, signature: true }); await assert.rejects(run('act', { action: 'agree' }, missing), { code: 'INVALID_INPUT' }); assert.ok(!missing.calls.some(call => call.method === 'PUT'))
  const f = fixture({ active: true, signature: true }); const output = await run('act', { action: 'agree', useLastSignature: true }, f)
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/signature/getFront')).query, { fromWhere: 'task' })
  assert.equal(f.calls.find(call => call.path === base + '/audit').body.signatureFileId, '9007199254740993127')
  assert.ok(!JSON.stringify(output).includes('private-signature'))
})
test('configured delete after confirmation refusal requires deletion permission and verifies both writes', async () => {
  const f = fixture({ active: true, deleteTask: true }); const result = await run('act', { action: 'refuse' }, f)
  assert.equal(result.result.taskRemoved, true); assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1)
  const denied = fixture({ active: true, deleteTask: true, noRemove: true }); await assert.rejects(run('act', { action: 'refuse' }, denied), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!denied.calls.some(call => call.method === 'PUT'))
  const unapproved = fixture({ active: true, deleteTask: true }); await assert.rejects(run('act', { action: 'refuse' }, unapproved, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(unapproved.calls.length, 0)
})
test('stale context, ignored writes and network uncertainty fail without replay or automatic rollback', async () => {
  const stale = fixture(); await assert.rejects(run('submit', { expectedVersion: '0'.repeat(64) }, stale), { code: 'CONTEXT_CONFLICT' }); assert.ok(!stale.calls.some(call => call.method === 'PUT'))
  const ignored = fixture({ ignoreWrite: true }); await assert.rejects(run('submit', {}, ignored), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.writeOutcome === 'partially-completed-check-current-state')
  const timeout = fixture({ timeout: true }); await assert.rejects(run('submit', {}, timeout), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown-do-not-retry' && error.details.resources.taskId === 'task-1')
  assert.equal(timeout.calls.filter(call => call.method === 'PUT').length, 1)
  const plan = fixture(); const output = await run('submit', {}, plan, { dryRun: true }); assert.equal(plan.calls.length, 0); assert.ok(output.steps.every(step => step.context === 'resolve-from-verified-http-context'))
})
test('public dispatch blocks expiry, overcapacity, unavailable features and raw protocol bypasses', async () => {
  for (const [option, code] of [['expired', 'COMPANY_EXPIRED'], ['overCapacity', 'COMPANY_OVER_CAPACITY'], ['disabled', 'FEATURE_DISABLED']]) {
    const f = fixture({ [option]: true }); await assert.rejects(executeWorkflow(ctx, flow('submit'), target, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(call => call.path === '/task/api/v3/task'))
  }
  const raw = catalog.operations.find(op => op.method === 'PUT' && op.route === base + '/auditUser'), f = fixture()
  await assert.rejects(executeOperation(ctx, raw, { body: { auditId: f.audit.id, userIds: '81' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
  const tampered = structuredClone(flow('submit')); tampered.steps.at(-1).operationId = raw.id; assert.throws(() => validateTaskAuditWorkflow(tampered), { code: 'INVALID_CONTRACT' })
})

test('task approval refuses a signature file created by another company identity before the audit write', async () => {
  const f = fixture({ active: true, signature: true, foreignSignature: true })
  await assert.rejects(run('act', { action: 'agree', useLastSignature: true }, f), { code: 'FORBIDDEN' })
  assert.ok(!f.calls.some(call => call.method === 'PUT'))
})
