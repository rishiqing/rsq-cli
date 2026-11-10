import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows, workflowSchema } from '../dist/workflows.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801', bagId = '81', targetBagId = '82', taskId = 'fixture-task-uuid'
const session = { version: 1, method: 'password', identity: { userId, teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value))
const bag = id => ({ id, name: 'bag-' + id, teamId: '7', creatorId: userId, archiveGroupId: null, userRoles: [{ userId, role: { id: '8', type: 'archiveCreator' } }], editControl: { allowArchiving: true, moveArchiveFile: true, removeArchiveFile: true, resetArchiveFile: true } })
const record = (id, resourceId = taskId, type = 1) => ({ id, resourceId, type, name: 'task', userId, dateCreated: '2026.11.08 10:00:00' })
const task = () => ({ id: taskId, name: 'task', from: { type: 'todo', projectId: null }, members: [{ id: userId, name: 'self' }], participants: [], progress: 5, isDone: false, rrule: null, forbidEdit: false })
function state(patch = {}) {
  const model = { bags: [bag(bagId), bag(targetBagId)], records: { [bagId]: [record('601'), record('602', 'other-task', 5)], [targetBagId]: [record('603', 'file-uuid', 10)] }, task: task(), calls: [], pending: false, pendingReads: 0, nextId: 610, restoreParent: true, archivePermission: true, ...patch }
  model.transport = async (url, init) => {
    const call = { path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams), body: init.body == null ? undefined : JSON.parse(init.body) }; model.calls.push(call)
    if (model.hook) { const response = await model.hook(call, model); if (response) return response }
    if (call.path.endsWith('/archiveBag/list')) return json(model.bags)
    if (call.path.endsWith('/archiveFile/list')) {
      if (model.pending && ++model.pendingReads >= 2) { model.records[bagId].unshift(record(String(model.nextId++))); model.pending = false }
      return json(model.records[call.query.id].slice(0, Number(call.query.max)))
    }
    if (call.path === '/task/api/v3/task') return json(model.task)
    if (call.path === '/task/v1/kanbanCrud') return json({ id: call.query.id, name: 'project', coverId: null, teamId: '7' })
    if (call.path === '/task/api/v3/task/editcontrol') return json({ taskId, module: call.query.module, siteId: call.query.siteId, editControl: { archiveTask: model.archivePermission } })
    if (call.path === '/task/api/v3/task/archive') { assert.equal(call.body.taskId, taskId); assert.equal(call.body.bagId, bagId); model.pending = true; return new Response('') }
    if (call.path.endsWith('/archiveFile/batchMove')) {
      for (const id of call.body.ids.split(',')) {
        const source = Object.keys(model.records).find(bag => model.records[bag].some(row => row.id === id)), row = model.records[source].find(row => row.id === id)
        model.records[source] = model.records[source].filter(row => row.id !== id); model.records[call.body.archiveBagId].unshift(row)
      }
      return new Response('')
    }
    if (call.path === '/task/v1/archiveFile' && call.method === 'DELETE') { for (const id of call.query.id.split(',')) for (const bag of Object.keys(model.records)) model.records[bag] = model.records[bag].filter(row => row.id !== id); return new Response('') }
    if (call.path === '/task/v1/archiveFile' && call.method === 'POST') {
      assert.deepEqual(Object.keys(call.body), ['id'])
      if (model.restoreParent) for (const bag of Object.keys(model.records)) model.records[bag] = model.records[bag].filter(row => row.id !== call.body.id)
      return json({ hasParent: model.restoreParent })
    }
    throw Error('Unexpected request ' + call.path)
  }
  return model
}
const definition = command => workflows.workflows.find(flow => flow.command === command)
const run = (command, input, model, options = {}) => { const flow = structuredClone(definition(command)); for (const step of flow.steps) if (step.readback) step.readback.delayMs = 50; return runWorkflow(ctx, flow, { bagId, ...input }, session, { transport: model.transport, approved: true, ...options }) }
const writes = model => model.calls.filter(call => !['GET', 'HEAD'].includes(call.method))
test('archive resource schema and offline plans expose context and confirmation without network', async () => {
  const model = state(), result = await run('task archive', { taskId }, model, { dryRun: true })
  assert.equal(result.dryRun, true); assert.equal(result.effect, 'destructive'); assert.equal(model.calls.length, 0)
  assert.ok(workflowSchema(definition('task archive')).access.features.includes('ARCHIVE'))
  assert.equal(definition('archive task restore').inputSchema.properties.type, undefined)
})
test('resource move uses record IDs, verifies both bags and preserves source resources and other records', async () => {
  const model = state(), originalTask = structuredClone(model.task)
  const result = await run('archive items move', { itemIds: ['601'], targetBagId }, model)
  assert.deepEqual(writes(model)[0].body, { ids: '601', archiveBagId: targetBagId })
  assert.deepEqual(model.records[bagId].map(row => row.id), ['602']); assert.deepEqual(model.records[targetBagId].map(row => row.id), ['601', '603'])
  assert.deepEqual(model.task, originalTask); assert.equal(result.result.sourceResourcesDestroyed, false)
  assert.deepEqual(result.result.movedRecordIds, ['601'])
})
test('record identity, actual target membership and two independent permissions are mandatory', async () => {
  for (const [patch, input, code] of [[{}, { itemIds: [taskId], targetBagId }, 'INVALID_INPUT'], [{}, { itemIds: ['999'], targetBagId }, 'CONTEXT_MISSING'], [{}, { itemIds: ['601'], targetBagId: '999' }, 'FORBIDDEN']]) {
    const model = state(patch); await assert.rejects(run('archive items move', input, model), { code }); assert.equal(writes(model).length, 0)
  }
  for (const [index, key] of [[0, 'moveArchiveFile'], [1, 'allowArchiving']]) {
    const model = state(); model.bags[index].editControl[key] = false
    await assert.rejects(run('archive items move', { itemIds: ['601'], targetBagId }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 0)
  }
})
test('same-bag move skips mutation and stale selected records stop before a write', async () => {
  const model = state(), result = await run('archive items move', { itemIds: ['601'], targetBagId: bagId }, model)
  assert.ok(result.skippedSteps.includes('changed')); assert.equal(writes(model).length, 0)
  let reads = 0
  model.hook = call => { if (call.path.endsWith('/archiveFile/list') && ++reads === 3) model.records[bagId][0].name = 'concurrent' }
  await assert.rejects(run('archive items move', { itemIds: ['601'], targetBagId }, model), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(model).length, 0)
})
test('record removal hides only selected records and leaves the source task and other records intact', async () => {
  const model = state(), before = structuredClone(model.task)
  const result = await run('archive items remove', { itemIds: ['601'] }, model)
  assert.deepEqual(writes(model)[0].query, { id: '601' }); assert.deepEqual(result.result.hiddenRecordIds, ['601'])
  assert.equal(model.records[bagId][0].id, '602'); assert.deepEqual(model.task, before)
  await assert.rejects(run('archive items remove', { itemIds: ['602'] }, model, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(writes(model).length, 1)
})
test('lost acknowledgement after a partial batch reports every known ID without replay or rollback', async () => {
  const model = state({ hook(call, model) { if (call.path.endsWith('/batchMove')) { model.records[targetBagId].push(model.records[bagId].shift()); throw Error('network failed after first record') } } })
  await assert.rejects(run('archive items move', { itemIds: ['601', '602'], targetBagId }, model), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown' && error.details.resources.archiveRecordIds === '601,602' && error.details.resources.targetBagId === targetBagId)
  assert.equal(writes(model).length, 1); assert.deepEqual(model.records[bagId].map(row => row.id), ['602']); assert.equal(model.records[targetBagId].at(-1).id, '601')
})
test('task archiving checks task and bag permissions and only repeats reads for asynchronous record creation', async () => {
  const model = state(); model.records[bagId] = [record('602', 'other-task', 5)]
  const result = await run('task archive', { taskId }, model)
  assert.equal(writes(model).length, 1); assert.equal(writes(model)[0].body.module, 'common')
  assert.ok(model.pendingReads >= 2); assert.equal(result.resources.archiveRecordId, '610'); assert.equal(result.result.record.resourceId, taskId)
  assert.equal(model.calls.at(-1).query.module, 'archive'); assert.equal(model.calls.at(-1).query.siteId, bagId)
})
test('task archive refuses stale source, wrong project, denied task or target bag and existing archive', async () => {
  for (const mode of ['task-denied', 'bag-denied', 'project-omitted', 'already-archived', 'source-conflict', 'template-project', 'unknown-project-kind', 'foreign-project-company']) {
    const model = state(); if (mode !== 'already-archived') model.records[bagId] = []
    const suppliedProject = ['template-project', 'unknown-project-kind', 'foreign-project-company'].includes(mode)
    if (mode === 'task-denied') model.archivePermission = false
    if (mode === 'bag-denied') model.bags[0].editControl.allowArchiving = false
    if (mode === 'project-omitted') model.task.from.projectId = '700'
    if (mode === 'source-conflict') { let reads = 0; model.hook = call => { if (call.path === '/task/api/v3/task' && ++reads === 2) model.task.name = 'concurrent' } }
    if (suppliedProject) {
      model.task.from.projectId = '700'
      model.hook = call => call.path === '/task/v1/kanbanCrud' ? json({ id: '700', ...(mode !== 'unknown-project-kind' && { coverId: mode === 'template-project' ? '900' : null }), teamId: mode === 'foreign-project-company' ? '8' : '7' }) : undefined
    }
    await assert.rejects(run('task archive', { taskId, ...(suppliedProject ? { projectId: '700' } : {}) }, model), error => ['FORBIDDEN', 'INVALID_INPUT', 'CONTEXT_CONFLICT'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
})
test('project task archive preserves and uses the actual project context rather than common', async () => {
  const model = state(); model.records[bagId] = []; model.task.from.projectId = '700'
  await run('task archive', { taskId, projectId: '700' }, model)
  assert.equal(writes(model)[0].body.module, 'project'); assert.equal(writes(model)[0].body.siteId, '700')
})
test('missing asynchronous archive record retains source identifiers and never repeats the accepted write', async () => {
  const model = state({ hook(call, model) { if (call.path.endsWith('/archiveFile/list') && model.pending) return json(model.records[bagId]) } }); model.records[bagId] = []
  await assert.rejects(run('task archive', { taskId }, model), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.taskId === taskId && error.details.resources.bagId === bagId)
  assert.equal(writes(model).length, 1); assert.equal(model.calls.filter(call => call.path.endsWith('/archiveFile/list')).length, 6)
})
test('task restore derives source UUID from its actual archive record and independently reads the original scene', async () => {
  for (const { type, projectId } of [{ type: 1 }, { type: 5, projectId: '700' }, { type: 5 }]) {
    const model = state(); model.records[bagId][0].type = type
    if (projectId) model.task.from.projectId = projectId
    const result = await run('archive task restore', { itemId: '601' }, model)
    assert.deepEqual(writes(model)[0].body, { id: '601' }); assert.equal(result.resources.taskId, taskId); assert.equal(result.result.restored, true)
    const source = model.calls.findLast(call => call.path === '/task/api/v3/task')
    assert.equal(source.query.id, taskId); assert.equal(source.query.module, projectId ? 'project' : 'common')
    assert.deepEqual(model.records[bagId].map(row => row.id), ['602'])
  }
})
test('restore rejects wrong type or UI denial; missing parent is a reported continuation need, never invented success', async () => {
  const wrong = state(); wrong.records[bagId][0].type = 10
  await assert.rejects(run('archive task restore', { itemId: '601' }, wrong), { code: 'INVALID_INPUT' }); assert.equal(writes(wrong).length, 0)
  const denied = state(); denied.bags[0].editControl.resetArchiveFile = false
  await assert.rejects(run('archive task restore', { itemId: '601' }, denied), { code: 'FORBIDDEN' }); assert.equal(writes(denied).length, 0)
  const missing = state({ restoreParent: false })
  await assert.rejects(run('archive task restore', { itemId: '601' }, missing), error => error.code === 'RESTORE_TARGET_REQUIRED' && error.details.resources.taskId === taskId && error.details.completedSteps.includes('changed'))
  assert.equal(writes(missing).length, 1); assert.equal(missing.records[bagId][0].id, '601')
})
