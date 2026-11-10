import test from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { taskLabels, validateLabelPatch } from '../dist/task-personal-labels.js'

const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const original = { id: 701, name: '原有标签', color: 14, type: 'todo' }
function fixture(options = {}) {
  const calls = [], library = structuredClone(options.library ?? [original]), foreign = { id: 702, name: '他人的已选标签', color: 7, type: 'todo' }, project = { id: 701, name: '项目标签同号', color: 3, type: 'project' }
  let authReads = 0, listReads = 0
  const task = { id: 'task-1', name: '原有任务', note: '保留正文', from: options.project ? { projectId: '7001' } : {}, labelList: [foreign, project] }
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    if (url.pathname.endsWith('/login/authAjax')) return json({ success: true, username: 'fixture', token: 'fixture-token', id: options.identityChanged && ++authReads > 1 ? 82 : 81, team: { id: 7, name: 'fixture' } })
    if (url.pathname.endsWith('/todoLabel/userLabels')) {
      listReads++
      if (options.drift && listReads === 2) library.push({ id: 703, name: '同时新增', color: 4, type: 'todo' })
      return json(library)
    }
    if (url.pathname.endsWith('/todoLabel/list')) return json([...library, foreign, project])
    if (url.pathname.endsWith('/kanbanLabel/list')) return json([project, foreign])
    if (url.pathname.endsWith('/kanbanCrud')) return json({ id: '7001', coverId: options.readonlyTemplate ? '8001' : null })
    if (url.pathname.endsWith('/v4/template')) return json({ id: '8001', name: 'fixture-template', templateKanbanId: '7001', withEdit: false })
    if (url.pathname.endsWith('/task/editcontrol')) return json({ taskId: 'task-1', module: url.searchParams.get('module'), siteId: url.searchParams.get('siteId'), editControl: { selectTaskLabel: options.denied !== true } })
    if (url.pathname.endsWith('/api/v3/task')) {
      if (init.method === 'PUT') {
        if (!options.skipWrite) task.labelList = [
          ...body.todoLabelIds.split(',').filter(Boolean).map(id => ({ id, type: options.wrongType ? 'project' : 'todo' })),
          ...body.kanbanLabelIds.split(',').filter(Boolean).map(id => ({ id, type: 'project' })),
        ]
      }
      return json(task)
    }
    if (url.pathname.endsWith('/todoLabel')) {
      if (options.timeout) throw new Error('connection lost after request')
      if (init.method === 'POST') { const created = { id: 704, ...body, type: 'todo' }; if (!options.skipWrite) library.push(created); return json(created) }
      if (init.method === 'PUT') { const target = library.find(row => String(row.id) === body.id); if (!options.skipWrite) Object.assign(target, body); return json(target) }
      if (init.method === 'DELETE') {
        const at = library.findIndex(row => String(row.id) === url.searchParams.get('id')); if (at >= 0 && !options.skipWrite) library.splice(at, 1)
        return json({ success: true })
      }
    }
    throw Error('Unexpected label HTTP ' + init.method + url.pathname)
  }
  return { calls, library, task, transport }
}
const run = (command, input, f, extra = {}) => runWorkflow(ctx, workflows.workflows.find(row => row.command === command), input, session, { approved: true, transport: f.transport, ...extra })
const writes = f => f.calls.filter(row => row.method !== 'GET')

test('personal library create, sparse configure and remove preserve every unrelated label and use the correct wire forms', async () => {
  const f = fixture()
  const initial = await run('task label personal list', {}, f)
  assert.deepEqual(initial.result, [original])
  const created = await run('task label personal create', { name: '新标签', color: 16 }, f)
  assert.equal(created.resources.labelId, '704')
  await run('task label personal configure', { labelId: '704', patch: { name: '只改名称' } }, f)
  assert.deepEqual(f.library.find(row => String(row.id) === '704'), { id: '704', name: '只改名称', color: 16, type: 'todo' })
  await run('task label personal remove', { labelId: '704' }, f)
  assert.deepEqual(f.library, [original])
  assert.ok(f.calls.filter(row => row.path.endsWith('/userLabels')).every(row => Object.keys(row.query).length === 0))
  assert.deepEqual(writes(f).map(row => [row.method, row.query, row.body]), [['POST', {}, { name: '新标签', color: 16 }], ['PUT', {}, { id: '704', name: '只改名称' }], ['DELETE', { id: '704' }, undefined]])
})
test('an already-selected foreign personal label is selectable, but grants no library maintenance permission', async () => {
  const f = fixture()
  for (const command of ['task label personal configure', 'task label personal remove']) await assert.rejects(run(command, { labelId: '702', ...(command.endsWith('configure') && { patch: { name: 'foreign' } }) }, f), { code: 'FORBIDDEN' })
  assert.equal(writes(f).length, 0)
  const catalogue = await run('task label catalogue', { taskId: 'task-1' }, f)
  assert.equal(catalogue.result.length, 3)
  await run('task label set', { taskId: 'task-1', labels: [{ id: '702', type: 'todo' }] }, f)
  assert.deepEqual(writes(f)[0].body, { id: 'task-1', module: 'common', siteId: 'common', kanbanLabelIds: '', todoLabelIds: '702' })
})
test('association verification distinguishes equal numeric IDs from different label sources', async () => {
  for (const project of [false, true]) {
    const f = fixture({ project })
    await run('task label set', { taskId: 'task-1', labels: [{ id: '701', type: 'todo' }, { id: '701', type: 'project' }] }, f)
    assert.equal(f.task.name, '原有任务'); assert.equal(f.task.note, '保留正文')
    assert.ok(f.calls.some(row => row.path.endsWith('/todoLabel/list') && row.query.todoId === 'task-1'))
    const wrong = fixture({ project, wrongType: true })
    await assert.rejects(run('task label set', { taskId: 'task-1', labels: [{ id: '701', type: 'todo' }] }, wrong), { code: 'BUSINESS_ASSERTION_FAILED' })
    assert.equal(writes(wrong).length, 1)
    await run('task label set', { taskId: 'task-1', labels: [] }, f)
    assert.deepEqual(f.task.labelList, [])
  }
})
test('own library changes, identity switches and malformed catalogues stop before any write', async () => {
  for (const [options, code] of [[{ drift: true }, 'CONTEXT_CONFLICT'], [{ identityChanged: true }, 'IDENTITY_CHANGED'], [{ library: [original, original] }, 'CONTEXT_MISSING'], [{ library: [{ ...original, type: 'project' }] }, 'CONTEXT_MISSING']]) {
    const f = fixture(options)
    await assert.rejects(run('task label personal create', { name: '不应写', color: 1 }, f), { code })
    assert.equal(writes(f).length, 0)
  }
  assert.throws(() => taskLabels(Array.from({ length: 10001 }, () => original), true), { code: 'CONTEXT_MISSING' })
})
test('all label naming and color limits are local, including UTF-16 emoji length and offline dry-run', async () => {
  assert.doesNotThrow(() => validateLabelPatch({ name: '😀'.repeat(40), color: 16 }))
  for (const input of [{ name: '😀'.repeat(41), color: 1 }, { name: ' ', color: 1 }, { name: 'a', color: 0 }, { name: 'a', color: 17 }]) {
    const f = fixture()
    await assert.rejects(run('task label personal create', input, f, { dryRun: true }), { code: 'INVALID_INPUT' })
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  const plan = await run('task label personal create', { name: '😀'.repeat(40), color: 16 }, f, { dryRun: true })
  assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
})
test('read-only actual templates and task label permission denial cannot be bypassed with the common scene', async () => {
  for (const options of [{ project: true, readonlyTemplate: true }, { denied: true }]) {
    const f = fixture(options)
    await assert.rejects(run('task label set', { taskId: 'task-1', labels: [] }, f), { code: 'FORBIDDEN' })
    assert.equal(writes(f).length, 0)
  }
})
test('lost writes and misleading receipts fail once, preserving the completed step and resource ID', async () => {
  for (const options of [{ skipWrite: true }, { timeout: true }]) {
    const f = fixture(options)
    await assert.rejects(run('task label personal create', { name: '一次', color: 1 }, f), error => {
      assert.ok(error.details.failedStep)
      if (options.skipWrite) assert.equal(error.details.resources.labelId, '704')
      return true
    })
    assert.equal(writes(f).length, 1)
  }
})
test('guarded native personal labels cannot bypass the business context, with dry-run remaining offline', async () => {
  for (const op of catalog.operations.filter(row => row.route === '/task/v1/todoLabel' || row.route === '/task/v1/todoLabel/userLabels')) {
    const input = op.method === 'GET' ? {} : op.method === 'DELETE' ? { query: { id: '701' } } : { body: { ...(op.method === 'PUT' && { id: '701' }), name: '原有标签', color: 14 } }
    const f = fixture()
    await assert.rejects(executeOperation(ctx, op, input, session, { approved: true, transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
    await executeOperation(ctx, op, input, session, { approved: true, transport: f.transport, dryRun: true })
    assert.equal(f.calls.length, 0)
  }
})
