import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { context } from '../dist/core.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { automationKinds, validateAutomationWorkflow } from '../dist/automation.js'
const ctx = context('production', 'fixture'), jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.parse('2100-01-01'), identity: { userId: '81', teamId: '7', username: 'fixture' }, cookies: jar.serializeSync() }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), envelope = data => json({ code: 200, success: true, data })
const base = '/task/automation/rules', ruleId = 'rule0123456789', actionId = 'action0123456789'
const definition = (kind = 0) => ({ id: ruleId, name: '协议通知', module: kind, isRunning: false, trigger: { id: 'trigger0123456789', type: kind === 6 ? 'urgeDelayedTask' : 'taskCreated', planIdList: [11], taskSelector: { conditions: [], conjunction: 'and' }, timing: { type: 'none' } }, actions: [{ id: actionId, type: kind === 6 ? 'urgeTask' : 'taskNotify', ...(kind !== 6 && { senderType: 'editor', editorId: 81, senderList: [{ type: 'person', id: 81 }], message: { titleDelta: { ops: [{ insert: '协议通知' }] }, contentDelta: { ops: [{ insert: '协议正文' }] }, jumpTarget: 'task' } }) }] })
const flow = suffix => { const found = workflows.workflows.find(f => f.command === 'automation ' + suffix); assert.ok(found); return found }
const input = (extra = {}) => ({ projectId: '9', kind: 'create-task-notification', ruleId, ...extra }), run = (suffix, args, f, options = {}) => executeWorkflow(ctx, flow(suffix), args, session, { transport: f.transport, ...options }).catch(error => { error.message += ' [fixture details: ' + JSON.stringify(error.details) + ']'; throw error })
function fixture(options = {}) {
  const calls = [], mutations = [], stored = new Map(), logs = [], kind = options.kind ?? 0; let reads = 0, next = 1
  if (!options.empty) stored.set(ruleId, definition(kind))
  if (options.webhook) Object.assign(stored.get(ruleId).actions[0], { senderType: 'webhook', webhookUrl: 'https://fixture.invalid/hook?secret=fixture-only-url', secret: 'fixture-only-signing-secret' })
  return { calls, mutations, stored, async transport(url, init) {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, method, query, body, headers: Object.fromEntries(init.headers) })
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json(options.disabled ? [{ funcName: options.disabled, status: 'disable' }] : [])
    if (path.endsWith('/company/current')) return json({ useKanban: true })
    if (path === '/task/v1/kanbanCrud') return json({ id: options.wrongProject ? 10 : 9, name: '独立项目', coverId: options.template ? 50 : null, editControl: { automationConfig: !options.noConfig, automationRun: !options.noRun } })
    if (path === '/task/v1/kanbanChildCrud/list') return json([{ id: 11, name: '任务', type: 'task' }, { id: 12, name: '数据', type: 'datasheet', datasheetInfo: { datasheetId: 'dstFixture' } }])
    if (path === '/task/v1/department/list') return json([{ id: '7', name: '公司', type: 'top', parentId: null, displayOrder: 1, childList: [], userList: [{ id: 81, name: '本人' }, { id: 82, name: '同事' }] }])
    if (path === '/task/authority/v3/role/kanban') return json({ defaultRoles: [], customRoles: [] })
    if (path === '/task/api/v3/template/systemField/list' || path === '/task/v1/kanbanLabel/list' || path === '/task/v3/kanbanGroup/list') return json([])
    if (path === '/task/api/v3/template/settingList') { assert.equal(query.id, '9'); assert.equal(query.projectId, undefined); return json([]) }
    if (path === '/task/v3/templateCover/list') return json({ custom: [], normal: [] })
    if (path === '/task/v1/kanbanCardCrud/list') return json([{ id: 21, name: '卡片', kanbanChildId: 11, editControl: {} }])
    if (path === '/task/mt/loom/datasheet/dstFixture/fields') return envelope({ fields: [{ id: 'fldDate', name: '日期', type: 'DateTime', operator: [], field: {} }] })
    if (path.startsWith(base)) {
      assert.match(init.headers.get('cookie'), /(?:^|; )vt=7(?:;|$)/); assert.equal(init.headers.get('token'), 'fixture')
      if (path === base + '/count') return envelope(Object.fromEntries([...new Set([...stored.values()].map(row => row.module))].map(module => [module, [...stored.values()].filter(row => row.module === module && row.isRunning).length])))
      if (path === base + '/logs') return envelope(logs)
      if (path === base && method === 'GET') { reads++; if (options.empty && !stored.size && reads === 1) stored.set(ruleId, definition(kind)); if (options.concurrent && reads === 2) stored.get(ruleId).name = '并发修改'; const result = [...stored.values()].filter(row => row.module === Number(query.workflowType)); return envelope(result) }
      mutations.push(calls.at(-1))
      if (method === 'POST' && [base, base + '/copy'].includes(path)) { const row = definition(kind); row.id = 'rule' + String(next++).padStart(10, '0'); stored.set(row.id, row); if (options.unknown) throw Error('Fixture unknown result'); return envelope(row) }
      if (path === base && method === 'PUT') { Object.assign(stored.get(body.id), { trigger: body.trigger, actions: body.actions }); if (options.wrongRecipient) stored.get(body.id).actions[0].senderList[0].id = 82; return envelope(stored.get(body.id)) }
      if (path === base + '/status') { stored.get(body.ruleId).isRunning = body.isRunning; return new Response(null, { status: 204 }) }
      if (path === base + '/urge') { if (!options.pending) logs.push({ logId: 'log0123456789', isSuccess: !options.failedExecution, message: options.failedExecution ? '额度不足' : '成功', executedAt: Date.now() }); return new Response(null, { status: 204 }) }
      if (method === 'DELETE') { stored.delete(path.split('/').at(-1)); return new Response(null, { status: 204 }) }
    }
    throw Error('Unexpected automation fixture path ' + path)
  } }
}
test('automation discovery has named kinds, runtime permissions and counts without initializing rule lists', async () => {
  assert.equal(automationKinds.length, 31)
  for (const suffix of ['context', 'resources', 'rules list', 'rule inspect', 'rule create', 'rule copy', 'rule configure', 'rule remove', 'rule state set', 'rule logs', 'rule run']) validateAutomationWorkflow(flow(suffix))
  const f = fixture(), result = await run('context', { projectId: '9' }, f); assert.equal(result.result.permissions.configure, true); assert.equal(result.result.listMayCreateDefault, true); assert.equal(f.calls.filter(row => row.path === base).length, 0)
  const res = await run('resources', { projectId: '9', datasheetId: 'dstFixture' }, f); assert.equal(res.result.context.fields[0].id, 'fldDate'); assert.equal(res.result.context.cards[0].cards[0].id, 21)
  const blocked = fixture(); await assert.rejects(run('resources', { projectId: '9', datasheetId: 'foreign' }, blocked), { code: 'FORBIDDEN' }); assert.ok(!blocked.calls.some(row => row.path.includes('/loom/')))
})
test('rules use actual scoped sources; first GET initialization is distinct from explicit creation and copying', async () => {
  const f = fixture({ empty: true }), first = await run('rules list', { projectId: '9', kind: 'create-task-notification' }, f); assert.equal(first.result.rules.length, 1); assert.equal(f.mutations.length, 0)
  const created = await run('rule create', { projectId: '9', kind: 'create-task-notification' }, f); assert.notEqual(created.result.rule.id, ruleId); assert.equal(created.result.rule.isRunning, false)
  const copied = await run('rule copy', input(), f); assert.equal(copied.result.rule.isRunning, false); assert.equal(f.mutations.length, 2)
  await assert.rejects(run('rule inspect', input({ ruleId: 'ruleXXXXXXXXXX' }), f), { code: 'FORBIDDEN' })
})
test('configuration, activation, deactivation and deletion are independently read back and require confirmation', async () => {
  const f = fixture(), configuration = structuredClone(definition()); delete configuration.id; delete configuration.name; delete configuration.module; delete configuration.isRunning; delete configuration.trigger.id
  configuration.actions[0].message.titleDelta = { ops: [{ insert: '更新协议通知' }] }
  await assert.rejects(run('rule configure', input({ configuration }), f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const configured = await run('rule configure', input({ configuration }), f, { approved: true }); assert.equal(configured.result.rule.actions[0].message.titleDelta.ops[0].insert, '更新协议通知')
  assert.equal((await run('rule state set', input({ running: true }), f, { approved: true })).result.rule.isRunning, true)
  assert.equal((await run('rule state set', input({ running: false }), f, { approved: true })).result.rule.isRunning, false)
  assert.equal((await run('rule remove', input(), f, { approved: true })).result.removed, true)
  assert.deepEqual(f.mutations.map(row => row.method), ['PUT', 'PUT', 'PUT', 'DELETE'])
})
test('configuration readback compares nested recipient IDs instead of discarding every id field', async () => {
  const f = fixture({ wrongRecipient: true }), row = definition(), configuration = { trigger: row.trigger, actions: row.actions }
  await assert.rejects(run('rule configure', input({ configuration }), f, { approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(f.mutations.length, 1)
})
test('retained Webhook secrets are preserved internally and never returned by discovery or config results', async () => {
  const f = fixture({ webhook: true }), inspected = await run('rule inspect', input(), f), row = definition(), action = { ...row.actions[0], senderType: 'webhook' }
  const result = await run('rule configure', input({ configuration: { trigger: row.trigger, actions: [action] } }), f, { approved: true })
  assert.equal(f.mutations.at(-1).body.actions[0].secret, 'fixture-only-signing-secret'); assert.equal(f.mutations.at(-1).body.actions[0].webhookUrl, 'https://fixture.invalid/hook?secret=fixture-only-url')
  for (const value of [inspected, result]) { assert.ok(!JSON.stringify(value).includes('fixture-only-signing-secret')); assert.ok(!JSON.stringify(value).includes('fixture-only-url')); assert.equal(value.result.rule.actions[0].secretConfigured, true) }
})
test('writes stop before rule initialization on missing UI permissions; expiry, capacity and context conflicts stop dispatch', async () => {
  for (const [options, suffix, args, code] of [[{ noConfig: true }, 'rule create', { projectId: '9', kind: 'create-task-notification' }, 'FORBIDDEN'], [{ noRun: true, kind: 6 }, 'rule run', input({ kind: 'urge-delayed-task' }), 'FORBIDDEN'], [{ expired: true }, 'rule create', { projectId: '9', kind: 'create-task-notification' }, 'COMPANY_EXPIRED'], [{ over: true }, 'rule create', { projectId: '9', kind: 'create-task-notification' }, 'COMPANY_OVER_CAPACITY'], [{ template: true }, 'rule create', { projectId: '9', kind: 'create-task-notification' }, 'BUSINESS_ASSERTION_FAILED'], [{ concurrent: true }, 'rule copy', input(), 'CONTEXT_CONFLICT']]) { const f = fixture(options); await assert.rejects(run(suffix, args, f, { approved: true }), { code }); assert.equal(f.mutations.length, 0); if (options.noConfig || options.noRun) assert.equal(f.calls.filter(row => row.path === base).length, 0) }
  const mismatch = fixture(); await assert.rejects(run('rule copy', input({ contextVersion: '0'.repeat(64) }), mismatch), { code: 'CONTEXT_CONFLICT' }); assert.equal(mismatch.mutations.length, 0)
})
test('manual execution reports real new log failure and pending rather than treating 204 as success', async () => {
  for (const [options, state] of [[{}, 'succeeded'], [{ pending: true }, 'pending']]) { const f = fixture({ ...options, kind: 6 }), result = await run('rule run', input({ kind: 'urge-delayed-task' }), f, { approved: true }); assert.equal(result.result.executionStatus, state); assert.equal(f.mutations.length, 1) }
  const failed = fixture({ kind: 6, failedExecution: true }); await assert.rejects(run('rule run', input({ kind: 'urge-delayed-task' }), failed, { approved: true }), { code: 'BUSINESS_EXECUTION_FAILED' }); assert.equal(failed.mutations.length, 1)
  const ordinary = fixture(); await assert.rejects(run('rule run', input(), ordinary, { approved: true }), { code: 'INVALID_INPUT' }); assert.equal(ordinary.mutations.length, 0)
})
test('unknown creation outcomes preserve step/resource context and never resend a POST', async () => {
  const f = fixture({ unknown: true }); await assert.rejects(run('rule create', { projectId: '9', kind: 'create-task-notification' }, f), error => { assert.equal(error.details.resultMayBeUnknown, true); assert.equal(error.details.automaticRetry, false); assert.equal(error.details.resources.projectId, '9'); return true }); assert.equal(f.mutations.length, 1)
})
test('offline plans validate pure UI rules with zero HTTP and reject invalid record-date reminders', async () => {
  const f = fixture(), row = definition(); const plan = await run('rule configure', input({ configuration: { trigger: row.trigger, actions: row.actions } }), f, { dryRun: true }); assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
  const invalid = { trigger: { type: 'recordDate', datasheetId: 'dstFixture', datasheetSelector: {}, timing: { type: 'daily', time: '09:00' }, options: { dateFieldId: 'fldDate', calculationType: 'dueDateMinusCurrentDate', reminderPoints: [{ direction: 'before', value: 1, unit: 'day' }, { direction: 'before', value: 1, unit: 'day' }] } }, actions: [{ type: 'urgeTask' }] }
  await assert.rejects(run('rule configure', input({ configuration: invalid }), f, { dryRun: true }), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  const raw = catalog.operations.find(row => row.method === 'GET' && row.route === base); await assert.rejects(executeOperation(ctx, raw, { query: { workflowType: 0, projectId: 9, mainApp: 'rsq' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
