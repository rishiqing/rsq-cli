import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { xlsxFixture } from '../scripts/xlsx-fixture.mjs'
import { context } from '../dist/core.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { workflows } from '../dist/workflows.js'
import { projectImportRows, readProjectImportWorkbook } from '../dist/project-import-workbook.js'
import { validateProjectExcelWorkflow } from '../dist/project-excel-import.js'

const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const ctx = context('production', 'fixture'), session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' } }
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const command = action => workflows.workflows.find(row => row.command === 'project import excel ' + action)
const run = async (action, input, f, options = {}) => { try { return await executeWorkflow(ctx, command(action), input, session, { transport: f.transport, approved: true, ...options }) } catch (error) { error.message += ' ' + JSON.stringify(error.details); throw error } }
const basic = [['任务标题*', '所属任务模块*', '所属卡片*', '父任务标题'], ['root', 'Tasks', 'Card', ''], ['child', '', '', 'root']]
const cells = values => values.flatMap((row, r) => row.map((value, c) => ({ row: r + 1, column: c + 1, value: value ?? '', formula: false, type: 'inlineStr' })))
async function files(fn, values = basic) {
  const dir = await mkdtemp(join(tmpdir(), 'rsq-excel-import-test-')), file = join(dir, 'input.xlsx'), receipt = join(dir, 'receipt.json')
  try { await writeFile(file, xlsxFixture(values), { mode: 0o600 }); return await fn({ dir, file, receipt }) } finally { await rm(dir, { recursive: true, force: true }) }
}
function fixture(options = {}) {
  const calls = [], uploads = [], state = { submitted: false, projects: 0, directories: 0, quotas: 0 }, moduleId = options.longId ? '9007199254740993' : '101'
  const root = { id: 'created-root', name: 'root', cardId: '201', hasSubTask: true }, child = { id: 'created-child', name: 'child', cardId: '201', hasSubTask: false }, old = { id: 'old-task', name: 'old', cardId: '201', hasSubTask: false }
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams), method = init.method
    calls.push({ path, query, method });
    if (path.endsWith('/authAjax')) return response({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.foreignIdentity ? 8 : 7, name: 'company' } })
    if (path.endsWith('/state/independent')) return response({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return response([{ funcName: 'PLAN', status: options.featureDisabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return response({ useKanban: true })
    if (path === '/task/v1/kanbanCrud') { state.projects++; return response({ id: '9001', coverId: options.template ? '6001' : null, editControl: { importKanban: !options.denied && !(options.permissionDrift && state.projects > 1) } }) }
    if (path === '/task/v1/kanbanChildCrud/list') return response([{ id: moduleId, type: 'task', name: 'Tasks' }, ...(options.duplicateModule ? [{ id: '102', type: 'task', name: 'Tasks' }] : [])])
    if (path === '/task/v1/kanbanChildCrud') return response({ id: moduleId, name: 'Tasks', type: 'task', kanbanId: options.foreignModule ? '9002' : '9001' })
    if (path === '/task/v1/kanban/remainingNum') { assert.equal(method, 'POST'); state.quotas++; return response({ remainingNum: options.quotaDrift && state.quotas > 1 ? 0 : options.quota ?? 50 }) }
    if (path === '/task/v1/department/list') {
      state.directories++
      if (options.mutateFile && state.directories > 1) await writeFile(options.mutateFile, xlsxFixture([['任务标题*'], ['replaced']]))
      return response([{ id: '7', type: 'top', parentId: null, name: 'company', displayOrder: 1, leaderList: [], userList: [{ id: '81', showName: options.memberDrift && state.directories > 1 ? 'renamed' : 'Me' }, ...(options.duplicateMember ? [{ id: '82', showName: 'Me' }] : [])], childList: [] }])
    }
    if (path === '/task/v1/kanbanCardCrud/list') return response([{ id: '201', name: 'Card', editControl: {} }])
    if (path === '/task/api/v3/projectTask/taskList') {
      assert.equal(method, 'PUT'); const body = JSON.parse(init.body); assert.equal(body.planId, moduleId); assert.equal(body.key, '201'); assert.equal(body.max, 200)
      if (!state.submitted || options.pending) return response([old])
      return response([...(options.oldChanged ? [] : [old]), root, ...(options.ambiguous ? [{ ...root, id: 'duplicate-root', hasSubTask: false }] : []), ...(options.unexpected ? [{ id: 'unrelated', name: 'another', cardId: '201' }] : [])])
    }
    if (path === '/task/api/v3/task/subs') { assert.equal(query.taskId, root.id); return response(options.partial ? [] : [child]) }
    if (path === '/task/v4/kanban/uploadTemplate') {
      assert.equal(method, 'POST'); assert.ok(init.body instanceof FormData); assert.equal(init.body.get('id'), moduleId)
      uploads.push(new Uint8Array(await init.body.get('fileData').arrayBuffer())); state.submitted = true
      if (options.network) throw Error('outcome unknown')
      return response({ type: 'ws' })
    }
    if (path === '/task/api/v3/task') {
      const task = query.id === root.id ? root : child
      return response({ ...task, from: { projectId: '9001', planId: moduleId, planType: 'task' }, taskId: task === root ? null : options.parentMismatch ? 'foreign-root' : root.id,
        isDone: false, priorityV2: options.wrongPriority ? 2 : 3, note: options.note ?? '', members: [{ id: '81' }], participants: [{ id: '81' }], responsibilityId: '81', labelList: [{ name: 'tag' }], realStartDate: '2097-01-01T01:30:00.000Z', realEndDate: '2097-01-02T02:45:59.000Z' })
    }
    throw Error('Unexpected Excel HTTP ' + method + path)
  }
  return { calls, uploads, state, transport, moduleId }
}
const input = (f, file) => ({ projectId: '9001', moduleId: f.moduleId, file })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('Excel parser resolves current header aliases, hierarchy and precise date/priority semantics', () => {
  const parsed = projectImportRows(cells([['任务标题', '所属计划*', '所属卡片', '父任务标题', '任务开始时间', '任务结束时间', '优先级', '是否完成', '标签'], ['root', 'Tasks', 'Card', '', '2028.02.29 09:30', '2028-03-01 10:45', '最高', '是', 'alpha；beta'], ['child', '', '', 'root'], ['grandchild', '', '', 'child']]))
  assert.equal(parsed.rows[0].start.date, '2028-02-29'); assert.equal(parsed.rows[0].priority, 1); assert.equal(parsed.rows[0].done, true); assert.deepEqual(parsed.rows[0].labels, ['alpha', 'beta']); assert.equal(parsed.rows[2].module, 'Tasks'); assert.equal(parsed.rows[2].card, 'Card')
})
test('Excel parser refuses ambiguous parents, cycles, ordering loss, overwritten or silently discarded columns', () => {
  const invalid = [
    [['任务标题*', '任务标题'], ['x', 'y']], [['任务标题*', '所属任务模块*', '所属卡片*', 'unknown'], ['x', 'Tasks', 'Card', 'data']],
    [...basic, ['root', 'Other', 'Card', '']], [...basic, ['grandchild', '', '', 'child'], ['child', '', '', 'root']],
    [basic[0], ['a', '', '', 'b'], ['b', '', '', 'a']], [basic[0], ['a', '', '', 'missing']], [basic[0], ['a', 'Tasks', 'Card', ''], ['a', 'Tasks', 'Card', '']],
    [basic[0], ['grandchild', '', '', 'child'], ['child', '', '', 'root'], ['root', 'Tasks', 'Card', '']],
    [['任务标题*', '所属任务模块*', '所属卡片*', '任务开始时间'], ['x', 'Tasks', 'Card', '2027-02-29']],
    [['任务标题*', '所属任务模块*', '所属卡片*', '负责人'], ['x', 'Tasks', 'Card', 'Me;Other']],
    [['任务标题*', '所属任务模块*', '所属卡片*', '标签'], ['x', 'Tasks', 'Card', 'a;b；c']],
  ]
  for (const values of invalid) assert.throws(() => projectImportRows(cells(values)), { code: 'INVALID_WORKBOOK' })
  const formula = cells(basic); formula[4].formula = true; assert.throws(() => projectImportRows(formula), { code: 'INVALID_WORKBOOK' })
  assert.throws(() => projectImportRows(cells([basic[0], ['a', 'Tasks', 'Card', ''], ...Array.from({ length: 10000 }, (_, i) => ['t' + i, 'Tasks', 'Card', ''])])), { code: 'INVALID_WORKBOOK' })
  assert.throws(() => projectImportRows(cells([['任务标题*', '所属任务模块*', '所属卡片*', '任务详情'], ['x', 'Tasks', 'Card', 'x'.repeat(4194305)]])), { code: 'INVALID_WORKBOOK' })
})
test('Excel inspection preserves the original workbook hash and exact long module IDs, reporting quota without uploading', async () => files(async ({ file }) => {
  const f = fixture({ longId: true }), result = await run('inspect', input(f, file), f), parsed = await readProjectImportWorkbook(file)
  assert.equal(result.result.fileSha256, sha(await readFile(file))); assert.equal(parsed.rows.length, 2); assert.equal(result.result.moduleId, f.moduleId); assert.equal(result.result.visibleExistingTasks, 1); assert.equal(result.result.remainingImports, 50); assert.equal(f.uploads.length, 0)
}))
test('Excel import verifies only new IDs, parent linkage and independent scoped details; receipt can be used without reupload', async () => files(async ({ file, receipt }) => {
  const f = fixture(), preview = await run('inspect', input(f, file), f), original = await readFile(file)
  const applied = await run('apply', { ...input(f, file), expectedFileSha256: preview.result.fileSha256, expectedContextVersion: preview.result.contextVersion, receipt, waitSeconds: 0 }, f)
  assert.equal(applied.result.verified, true); assert.deepEqual(new Set(applied.result.taskIds), new Set(['created-root', 'created-child'])); assert.equal(f.uploads.length, 1); assert.deepEqual(Buffer.from(f.uploads[0]), original); assert.equal((await stat(receipt)).mode & 0o777, 0o600)
  const verified = await run('verify', { receipt, waitSeconds: 0 }, f); assert.equal(verified.result.verified, true); assert.equal(f.uploads.length, 1); assert.equal(JSON.parse(await readFile(receipt)).submission, 'accepted')
}))
test('Excel import validates explicit members, labels, note and Beijing time values using independent readbacks', async () => files(async ({ file, receipt }) => {
  const values = [basic[0].concat(['负责人', '执行人', '参与人', '标签', '任务详情', '任务开始时间', '任务结束时间']), ['root', 'Tasks', 'Card', '', 'Me', 'Me', 'Me', 'tag', 'body', '2097-01-01 09:30', '2097-01-02 10:45'], ['child', '', '', 'root']]
  await writeFile(file, xlsxFixture(values)); const f = fixture({ note: 'body' }), hash = sha(await readFile(file))
  const result = await run('apply', { ...input(f, file), expectedFileSha256: hash, receipt, waitSeconds: 0 }, f); assert.equal(result.result.verified, true)
}))
test('Excel import never uploads before permission, identity, feature, subscription, context, quota and hash checks', async () => files(async ({ dir, file }) => {
  for (const [i, options] of [{ denied: true }, { foreignIdentity: true }, { template: true }, { foreignModule: true }, { featureDisabled: true }, { expired: true }, { over: true }, { quota: 0 }, { quota: -1 }, { quotaDrift: true }, { permissionDrift: true }, { duplicateModule: true }, {}].entries()) {
    const f = fixture(options), args = { ...input(f, file), expectedFileSha256: i === 12 ? '0'.repeat(64) : sha(await readFile(file)), receipt: join(dir, 'receipt-' + i), waitSeconds: 0 }
    await assert.rejects(run('apply', args, f)); assert.equal(f.uploads.length, 0, JSON.stringify(options))
  }
  const f = fixture(); await assert.rejects(run('apply', { ...input(f, file), expectedFileSha256: sha(await readFile(file)), receipt: join(dir, 'no-approval') }, f, { approved: false })); assert.equal(f.calls.length, 0)
}))
test('Excel member ambiguity and stale name maps stop uploads, preserving a not-sent receipt', async () => files(async ({ dir, file }) => {
  await writeFile(file, xlsxFixture([basic[0].concat(['负责人']), ['root', 'Tasks', 'Card', '', 'Me']]))
  for (const [i, options] of [{ duplicateMember: true }, { memberDrift: true }].entries()) {
    const f = fixture(options), receipt = join(dir, 'members-' + i)
    await assert.rejects(run('apply', { ...input(f, file), expectedFileSha256: sha(await readFile(file)), receipt }, f), error => ['AMBIGUOUS_MEMBER', 'CONTEXT_CONFLICT'].includes(error.code)); assert.equal(f.uploads.length, 0)
    if (i === 1) { assert.equal(JSON.parse(await readFile(receipt)).submission, 'not-sent'); await assert.rejects(run('verify', { receipt }, f), { code: 'INVALID_RECEIPT' }) }
  }
}))
test('Excel uploads the inspected byte snapshot even when the source file changes during preflight', async () => files(async ({ file, receipt }) => {
  const original = await readFile(file), f = fixture({ mutateFile: file })
  await run('apply', { ...input(f, file), expectedFileSha256: sha(original), receipt, waitSeconds: 0 }, f)
  assert.deepEqual(Buffer.from(f.uploads[0]), original); assert.notDeepEqual(await readFile(file), original)
}))
test('Excel uncertain upload is attempted once and remains recoverable with HTTP-only verify', async () => files(async ({ file, receipt }) => {
  const f = fixture({ network: true })
  await assert.rejects(run('apply', { ...input(f, file), expectedFileSha256: sha(await readFile(file)), receipt, waitSeconds: 0 }, f), error => error.details.uploadOutcomeUnknown === true && error.details.automaticRetry === false)
  assert.equal(f.uploads.length, 1); assert.equal(JSON.parse(await readFile(receipt)).submission, 'unknown')
  const result = await run('verify', { receipt, waitSeconds: 0 }, f); assert.equal(result.result.verified, true); assert.equal(f.uploads.length, 1); assert.equal(result.result.submission, 'unknown')
}))
test('Excel partial results, original-task changes, collisions and incorrect fields cannot produce successful closure', async () => files(async ({ dir, file }) => {
  for (const [i, options] of [{ pending: true }, { partial: true }, { oldChanged: true }, { ambiguous: true }, { unexpected: true }, { wrongPriority: true }, { parentMismatch: true }].entries()) {
    const f = fixture(options)
    await assert.rejects(run('apply', { ...input(f, file), expectedFileSha256: sha(await readFile(file)), receipt: join(dir, 'failure-' + i), waitSeconds: 0 }, f), error => ['ASYNC_READBACK_PENDING', 'CONTEXT_CONFLICT', 'AMBIGUOUS_CONTEXT', 'VERIFICATION_FAILED'].includes(error.code))
    assert.equal(f.uploads.length, 1)
  }
}))
test('Excel receipts never overwrite files and malformed, foreign or world-readable receipts are rejected before business HTTP', async () => files(async ({ file, receipt }) => {
  const f = fixture(); await writeFile(receipt, 'preserve', { mode: 0o600 })
  await assert.rejects(run('apply', { ...input(f, file), expectedFileSha256: sha(await readFile(file)), receipt }, f), { code: 'RECEIPT_WRITE_FAILED' }); assert.equal(await readFile(receipt, 'utf8'), 'preserve'); assert.equal(f.uploads.length, 0)
  for (const value of [null, {}, { version: 1, type: 'project-excel-import', rows: [null] }]) { const empty = fixture(); await writeFile(receipt, JSON.stringify(value)); await assert.rejects(run('verify', { receipt }, empty), { code: 'INVALID_RECEIPT' }); assert.ok(empty.calls.every(call => ['/task/login/authAjax', '/task/ordercenter/v2/member/state/independent', '/task/ordercenter/v2/function/available', '/task/authority/v3/authorities/company/current'].includes(call.path))) }
  await rm(receipt); await run('apply', { ...input(f, file), expectedFileSha256: sha(await readFile(file)), receipt, waitSeconds: 0 }, f)
  const saved = JSON.parse(await readFile(receipt)); saved.profile = 'different'; await writeFile(receipt, JSON.stringify(saved)); const empty = fixture(); await assert.rejects(run('verify', { receipt }, empty), { code: 'INVALID_RECEIPT' }); assert.equal(empty.uploads.length, 0)
  await chmod(receipt, 0o644); await assert.rejects(run('verify', { receipt }, empty), { code: 'INVALID_RECEIPT' })
}))
test('Excel schema is a fixed executable HTTP contract and offline dry-run never reads files or sends requests', async () => {
  for (const action of ['inspect', 'apply', 'verify']) {
    const flow = command(action); assert.ok(flow); validateProjectExcelWorkflow(flow)
    const invalid = structuredClone(flow); invalid.steps[0].input = { query: { x: true } }; assert.throws(() => validateProjectExcelWorkflow(invalid), { code: 'INVALID_CONTRACT' })
  }
  const f = fixture(); await run('apply', { projectId: '9001', file: '/missing.xlsx', expectedFileSha256: '0'.repeat(64), receipt: '/missing.json' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  for (const route of ['/task/v4/kanban/uploadTemplate', '/task/v1/kanban/remainingNum']) { const op = catalog.operations.find(row => row.route === route); const raw = fixture(); await assert.rejects(executeOperation(ctx, op, route.endsWith('remainingNum') ? {} : { body: { id: '101' }, files: { fileData: '/missing.xlsx' } }, session, { transport: raw.transport, approved: true }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(raw.calls.length, 0) }
})
