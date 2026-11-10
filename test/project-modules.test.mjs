import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, approved = false) => runWorkflow(ctx, workflows.workflows.find(f => f.command === command), input, session, { transport, approved })

test('ordinary projects and templates each resolve, create, rename and delete modules in their own parent context', async () => {
  const modules = new Map(), calls = []; let sequence = 8000
  const transport = async (url, init) => {
    const template = init.headers.get('Plan-Type') === 'template', body = init.body && JSON.parse(init.body)
    calls.push({ method: init.method, path: url.pathname, template })
    if (url.pathname === '/task/v4/template') return json({ id: 6001, templateKanbanId: 7001, name: 'template', withEdit: true })
    if (url.pathname.endsWith('/list')) return json([...modules.values()].filter(m => String(m.kanbanId) === url.searchParams.get('kanbanId')))
    if (init.method === 'POST') {
      assert.equal(String(body.kanbanId), template ? '7001' : '9001'); assert.equal(body.content, 'empty')
      const item = { id: ++sequence, kanbanId: Number(body.kanbanId), type: body.type, name: body.name, flowApplicationId: body.type === 'workflow' ? 1234 : null }
      modules.set(String(item.id), item); return json(item)
    }
    const key = body ? String(body.id) : url.searchParams.get('id'), item = modules.get(key)
    if (init.method === 'GET') { const { kanbanId, ...detail } = item; return json(detail) }
    if (init.method === 'PUT') { item.name = body.name; return json(item) }
    assert.equal(init.method, 'DELETE'); modules.delete(key); return new Response('')
  }
  for (const template of [false, true]) for (const type of ['task', 'workflow', 'datasheet']) {
    const prefix = template ? 'project template module ' : 'project module ', parent = template ? { coverId: '6001' } : { projectId: '9001' }
    const created = await run(prefix + 'create', { ...parent, name: 'fixture', type }, transport)
    const moduleId = created.resources.moduleId
    assert.equal(created.result.type, type)
    const renamed = await run(prefix + 'rename', { ...parent, moduleId, name: 'renamed' }, transport)
    assert.equal(renamed.result.name, 'renamed')
    assert.equal((await run(prefix + 'catalogue', parent, transport)).result.length, 1)
    const deleted = await run(prefix + 'delete', { ...parent, moduleId }, transport, true)
    assert.equal(deleted.result.deleted, true)
  }
  assert.equal(modules.size, 0)
  assert.equal(calls.filter(c => c.method === 'POST').length, 6)
  assert.equal(calls.filter(c => c.method === 'DELETE' && c.template).length, 3)
})

test('module operations stop at a mismatched parent and destructive confirmation occurs before any HTTP', async () => {
  const methods = [], transport = async (_url, init) => { methods.push(init.method); return json([{ id: 8001, kanbanId: 9999, name: 'foreign', type: 'task' }].filter(item => String(item.kanbanId) === '9001')) }
  await assert.rejects(run('project module delete', { projectId: '9001', moduleId: '8001' }, transport), { code: 'CONFIRMATION_REQUIRED' })
  assert.deepEqual(methods, [])
  await assert.rejects(run('project module rename', { projectId: '9001', moduleId: '8001', name: 'after' }, transport), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.deepEqual(methods, ['GET'])
})
