import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { prepareTaskTemplate } from '../dist/task-template.js'
import { catalog } from '../dist/operations.js'
import { validateProjectCardBatchWorkflow } from '../dist/project-card-batch.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = name => workflows.workflows.find(flow => flow.command === name)
const project = { id: '7001', coverId: '8001', editControl: { kanbanTaskTypeManager: true } }
const cover = { id: '8001', templateKanbanId: '7001', name: 'system-or-other-owner', withEdit: false }
const input = { projectId: '7001', moduleId: '7101', templateId: '7201', cardId: '7301', name: 'new', patch: { name: 'changed' }, field: { name: 'field', type: 'Content' }, fieldId: '7401', roleId: '7501', available: true, isAvailable: true }
function fixture(options = {}) {
  const requests = []
  const transport = async (url, init) => {
    requests.push({ path: url.pathname, method: init.method })
    if (url.pathname.endsWith('/kanbanCrud')) return json({ ...project, ...(options.ordinary && { coverId: null }) })
    if (url.pathname.endsWith('/v4/template')) return json({ ...cover, ...(options.mismatch && { templateKanbanId: '7002' }) })
    if (url.pathname.endsWith('/template/settingList')) return json([])
    throw Error('Unexpected business request ' + url.pathname)
  }
  return { requests, transport }
}
test('readonly system template inspection is permitted but card/type/field writes require its actual editable cover', async () => {
  const reader = fixture(), result = await runWorkflow(ctx, flow('project template task-type list'), { projectId: '7001' }, session, { transport: reader.transport })
  assert.deepEqual(result.result, []); assert.equal(reader.requests.length, 3)
  for (const command of ['project template card create', 'project template card rename', 'project template card remove', 'project template task-type create', 'project template task-type field add', 'project template task-type remove']) {
    const server = fixture(), allowed = Object.keys(flow(command).inputSchema.properties), args = Object.fromEntries(Object.entries(input).filter(([name]) => allowed.includes(name)))
    await assert.rejects(runWorkflow(ctx, flow(command), args, session, { transport: server.transport, approved: true }))
    assert.deepEqual(server.requests.map(row => row.method), ['GET', 'GET'])
  }
})
test('ordinary projects and mismatched cover resources cannot enter template commands before business reads or writes', async () => {
  for (const options of [{ ordinary: true }, { mismatch: true }]) {
    const server = fixture(options)
    await assert.rejects(runWorkflow(ctx, flow('project template task-type list'), { projectId: '7001' }, session, { transport: server.transport }))
    assert.ok(server.requests.length <= 2); assert.ok(server.requests.every(row => row.method === 'GET'))
  }
  assert.throws(() => prepareTaskTemplate('task-context-list', { projectId: '7001' }, { project }), { code: 'CONTEXT_MISMATCH' })
  assert.throws(() => prepareTaskTemplate('task-context-list', { projectId: '7001' }, { project: { id: '7001' } }), { code: 'CONTEXT_MISSING' })
  const args = prepareTaskTemplate('task-context-list', { projectId: '7001' }, { project, templateBoundary: cover }); assert.deepEqual(args.query, { id: '7001' })
})
test('every shared template card/type command declares its cover boundary and every existing explicit cover write checks withEdit', () => {
  const ops = new Map(catalog.operations.map(op => [op.id, op]))
  for (const command of workflows.workflows.filter(flow => /^project template (task-type|card) /.test(flow.command))) {
    if (command.executor === 'project-card-batch') {
      const altered = structuredClone(command); altered.steps = altered.steps.filter(step => step.id !== 'cover')
      assert.throws(() => validateProjectCardBatchWorkflow(altered), { code: 'INVALID_CONTRACT' })
      continue
    }
    assert.equal(command.steps[1].id, 'templateBoundary'); assert.ok(command.steps[1].assertions.some(row => row.path === '/templateKanbanId'))
  }
  for (const command of workflows.workflows.filter(flow => flow.command.startsWith('project template ') && !flow.executor && !['project template apply', 'project template create', 'project template save'].includes(flow.command))) {
    const mutation = command.steps.some(step => !['GET', 'HEAD', 'OPTIONS'].includes(ops.get(step.operationId).method) && ops.get(step.operationId).effect !== 'read')
    if (!mutation) continue
    for (const step of command.steps.filter(step => ops.get(step.operationId).method === 'GET' && ops.get(step.operationId).route === '/task/v4/template')) assert.ok(step.assertions?.some(row => row.path === '/withEdit' && row.equals === true), command.command)
  }
})
test('template task fields need their own cover context while readonly inspection preserves field edit restrictions', async () => {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method })
    if (url.pathname.endsWith('/kanbanCrud')) return json(project)
    if (url.pathname.endsWith('/v4/template')) return json(cover)
    if (url.pathname.endsWith('/api/v3/task')) return json({ id: 'task-1', from: { projectId: '7001' } })
    if (url.pathname.endsWith('/task/template')) return json({ templateFields: [{ id: '7401', name: 'text', type: 1, value: 'old', editControl: { canEdit: false } }] })
    throw Error('Unexpected request ' + url.pathname)
  }
  const args = { projectId: '7001', taskId: 'task-1' }
  await assert.rejects(runWorkflow(ctx, flow('task field inspect'), args, session, { transport }), { code: 'CONTEXT_MISMATCH' })
  assert.equal(calls.filter(row => row.path.endsWith('/task/template')).length, 0)
  const inspected = await runWorkflow(ctx, flow('project template task field inspect'), args, session, { transport })
  assert.equal(inspected.result.templateFields[0].editControl.canEdit, false)
  const before = calls.length
  await assert.rejects(runWorkflow(ctx, flow('project template task field set'), { ...args, fieldId: '7401', value: 'new' }, session, { transport, approved: true }))
  assert.equal(calls.length - before, 2); assert.ok(calls.every(row => row.method === 'GET'))
})
test('editable template task fields retain per-field permissions and verify a single write independently', async () => {
  for (const canEdit of [false, true]) {
    let value = 'old'; const writes = []
    const transport = async (url, init) => {
      if (url.pathname.endsWith('/kanbanCrud')) return json(project)
      if (url.pathname.endsWith('/v4/template')) return json({ ...cover, withEdit: true })
      if (url.pathname.endsWith('/api/v3/task')) return json({ id: 'task-1', from: { projectId: '7001' } })
      if (url.pathname.endsWith('/task/template')) return json({ templateFields: [{ id: '7401', name: 'text', type: 1, value, editControl: { canEdit } }] })
      if (url.pathname.endsWith('/template/field')) { writes.push(JSON.parse(init.body)); value = writes[0].value; return new Response(null, { status: 200 }) }
      throw Error('Unexpected request ' + url.pathname)
    }
    const promise = runWorkflow(ctx, flow('project template task field set'), { projectId: '7001', taskId: 'task-1', fieldId: '7401', value: 'new' }, session, { transport, approved: true })
    if (!canEdit) { await assert.rejects(promise); assert.equal(writes.length, 0) }
    else { const result = await promise; assert.equal(writes.length, 1); assert.equal(result.result.templateFields[0].value, 'new') }
  }
})
