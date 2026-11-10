import test from 'node:test'
import assert from 'node:assert/strict'
import { context } from '../dist/core.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { validateProjectImportWorkflow } from '../dist/project-import.js'
const ctx = context('production', 'fixture')
const session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, cookies: { version: 'tough-cookie@6.0.0', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] }, identity: { userId: '81', teamId: '7', username: 'fixture' } }
const root = '/task/agent/v1/project-create/tasks', taskId = 'a'.repeat(24), response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }), envelope = data => response({ code: 200, msg: 'success', data })
const flow = command => { const result = workflows.workflows.find(flow => flow.command === command); assert.ok(result, command); return result }
const run = (suffix, input, fixture, options = {}) => executeWorkflow(ctx, flow('project import ' + suffix), input, session, { transport: fixture.transport, ...options })
function fixture(options = {}) {
  const calls = [], row = { taskId, enterpriseId: options.foreignTeam ? 8 : 7, userId: options.foreignUser ? 82 : 81, conversationId: 'fixture-conversation', mode: options.wrongMode ? 'standard' : 'quick', source: options.source ?? 'local_upload', status: options.status ?? 'generating', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...(options.status === 'created' && { createdProjectId: '999', projectName: 'not-proof-of-project' }) }
  const transport = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams) })
    assert.equal(init.method, 'GET')
    if (url.pathname.endsWith('/authAjax')) return response({ id: 81, username: 'fixture', token: 'fixture', success: true, team: { id: options.identityChanged ? 8 : 7, name: '公司' } })
    if (url.pathname.endsWith('/state/independent')) return response({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (url.pathname.endsWith('/function/available')) return response([{ funcName: 'PLAN', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'AI_EMPLOYEE', status: 'disable' }])
    if (url.pathname.endsWith('/company/current')) return response({})
    assert.equal(new Headers(init.headers).get('token'), 'fixture')
    if (url.pathname === root) {
      assert.equal(url.searchParams.get('mode'), 'quick')
      if (options.businessError) return response({ code: 403, msg: 'forbidden', data: [] })
      return envelope(options.empty ? [] : options.duplicate ? [row, row] : options.unordered ? [{ ...row, taskId: 'b'.repeat(24), updatedAt: '2026-01-01T00:00:00.000Z' }, row] : [row])
    }
    if (url.pathname === root + '/active') return envelope(options.empty || options.noActive || row.status !== 'generating' ? null : options.activeMismatch ? { ...row, taskId: 'b'.repeat(24) } : row)
    if (url.pathname === root + '/' + taskId) {
      if (options.network) throw Error('fixture timeout')
      const detail = { ...row, ...(options.drift && { status: 'failed', updatedAt: '2026-01-03T00:00:00.000Z' }) }
      if (options.preview) { row.projectJsonItemId = 'preview-1'; detail.projectJsonItemId = row.projectJsonItemId; detail.projectJsonItem = { id: options.previewWrongId ? 'preview-other' : row.projectJsonItemId, type: 'project_json', status: 'completed', partial: !!options.previewPartial, validation: { valid: !options.previewInvalid, normalizedAt: '2026-01-02T00:00:00.000Z' }, project: { name: '预览', plans: [{ name: '模块', cards: [{ name: '卡片', tasks: [{ name: '任务' }] }] }] } } }
      return envelope(detail)
    }
    throw Error('Unexpected project import request ' + url.pathname)
  }
  if (options.preview) row.projectJsonItemId = 'preview-1'
  return { calls, row, transport }
}
test('project import discovers both HTTP modes and does not require unrelated paid AI employee feature', async () => {
  for (const f of workflows.workflows.filter(flow => flow.executor === 'project-import')) validateProjectImportWorkflow(f)
  const f = fixture(), result = await run('context', { mode: 'quick' }, f)
  assert.deepEqual(result.result.modes, ['quick', 'standard']); assert.equal(result.result.tasks.length, 1); assert.equal(result.result.activeTask.taskId, taskId); assert.equal(result.result.businessResultVerified, false)
  assert.ok(f.calls.every(call => call.method === 'GET'))
  const empty = await run('active', { mode: 'quick' }, fixture({ empty: true })); assert.equal(empty.result.task, null)
  const list = await run('tasks list', { mode: 'quick' }, fixture()); assert.equal(list.result.complete, true); assert.equal(list.result.total, 1)
})
test('project import keeps created task records separate from real project completion and normalizes current historical aliases', async () => {
  const created = await run('task inspect', { mode: 'quick', taskId }, fixture({ status: 'created', source: 'rishiqing_upload' }))
  assert.equal(created.result.status, 'created'); assert.equal(created.result.createdProjectId, '999'); assert.equal(created.result.businessResultVerified, false); assert.equal(created.result.statusAuthority, 'client-writable-task-record'); assert.equal(created.result.source, 'local_upload')
  const hosted = await run('task inspect', { mode: 'quick', taskId }, fixture({ source: 'wps_current_sheet' })); assert.equal(hosted.result.source, 'host_current_document')
  const failed = await run('tasks list', { mode: 'quick' }, fixture({ status: 'failed' })); assert.equal(failed.result.items[0].status, 'failed')
})
test('project import verifies persisted previews and recomputes module/card/task counts from the body', async () => {
  const f = fixture({ preview: true, status: 'preview_ready' }); f.row.stats = { moduleCount: 999, cardCount: 999, taskCount: 999 }
  const result = await run('task inspect', { mode: 'quick', taskId }, f)
  assert.deepEqual(result.result.previewCounts, { moduleCount: 1, cardCount: 1, taskCount: 1 }); assert.equal(result.result.previewPersisted, true); assert.equal(result.result.businessResultVerified, false)
  for (const flag of ['previewWrongId', 'previewInvalid', 'previewPartial']) await assert.rejects(run('task inspect', { mode: 'quick', taskId }, fixture({ preview: true, [flag]: true })), { code: 'PREVIEW_INVALID' })
})
test('project import enforces owner/company/mode directory before detail reads and rejects duplicate or reordered results', async () => {
  for (const flag of ['foreignTeam', 'foreignUser']) { const f = fixture({ [flag]: true }); await assert.rejects(run('task inspect', { mode: 'quick', taskId }, f), { code: 'FORBIDDEN' }); assert.ok(!f.calls.some(call => call.path === root + '/' + taskId)) }
  await assert.rejects(run('tasks list', { mode: 'quick' }, fixture({ wrongMode: true })), { code: 'CONTEXT_MISSING' })
  for (const flag of ['duplicate', 'unordered']) await assert.rejects(run('tasks list', { mode: 'quick' }, fixture({ [flag]: true })), { code: 'CONTEXT_CONFLICT' })
  const absent = fixture({ empty: true }); await assert.rejects(run('task inspect', { mode: 'quick', taskId }, absent), { code: 'FORBIDDEN' }); assert.ok(!absent.calls.some(call => call.path === root + '/' + taskId))
})
test('project import detects active/detail context drift and never changes records or retries on failure', async () => {
  for (const flag of ['noActive', 'activeMismatch']) await assert.rejects(run('active', { mode: 'quick' }, fixture({ [flag]: true })), { code: 'CONTEXT_CONFLICT' })
  await assert.rejects(run('task inspect', { mode: 'quick', taskId }, fixture({ drift: true })), { code: 'CONTEXT_CONFLICT' })
  const f = fixture({ network: true }); await assert.rejects(run('task inspect', { mode: 'quick', taskId }, f), error => { assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.taskWritesAttempted, false); return true }); assert.equal(f.calls.filter(call => call.path === root + '/' + taskId).length, 1)
  await assert.rejects(run('tasks list', { mode: 'quick' }, fixture({ businessError: true })))
})
test('project import schemas, offline plans, expiry and limits stop invalid or unavailable requests', async () => {
  const f = fixture(); await assert.rejects(run('task inspect', { mode: 'quick', taskId: '../other' }, f), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('tasks list', {}, f), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0)
  const plan = await run('task inspect', { mode: 'quick', taskId }, f, { dryRun: true }); assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
  for (const flag of ['expired', 'over', 'disabled', 'identityChanged']) { const denied = fixture({ [flag]: true }); await assert.rejects(run('tasks list', { mode: 'quick' }, denied)); assert.ok(!denied.calls.some(call => call.path.startsWith(root))) }
  for (const op of catalog.operations.filter(op => op.route.startsWith(root) && op.review === 'reviewed')) { const raw = fixture(); await assert.rejects(executeOperation(ctx, op, op.route.endsWith('/{taskId}') ? { path: { taskId } } : { query: { mode: 'quick' } }, session, { transport: raw.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(raw.calls.length, 0) }
})
