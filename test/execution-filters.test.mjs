import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows } from '../dist/workflows.js'
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const input = { type: 'user', startDate: '2026-11-09', endDate: '2026-11-09', groupId: '2', filters: [{ key: 'name', contentValue: '专属测试任务', operators: ['包含'] }] }
const definitions = [{ key: 'name', name: '任务名称', type: 'content', operator: [{ name: '包含', value: '1', selected: true }] }, { key: 'isDone', name: '是否完成', type: 'radio', selector: [{ name: '完成', value: 'true', selected: true }] }]
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function fixture() {
  const calls = [], transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method: init.method, body })
    if (url.pathname.endsWith('/department/list') || url.pathname.endsWith('/staffGroupCrud/list')) return json([])
    if (url.pathname.endsWith('/displayMode')) return json({ mode: 'taskAndWorkflowTodo' })
    if (url.pathname.endsWith('/view/list')) return json([{ id: 'view-1', isSelected: true, viewType: 'list', group: 'priority', sort: 'titleAsc' }])
    if (url.pathname.endsWith('/filter/selected')) return json({ filter: [definitions[1]] })
    if (url.pathname.endsWith('/view/filter')) return json({ filter: definitions })
    if (url.pathname.endsWith('/group/list')) return json({ effectiveMode: 'taskAndWorkflowTodo', groupList: [{ id: '2', priorityV2: 2 }] })
    if (url.pathname.endsWith('/item/list')) return json({ effectiveMode: 'taskAndWorkflowTodo', list: [{ id: 'task-1', name: '专属测试任务' }], hasMore: false })
    throw Error('Unexpected request ' + url.pathname)
  }
  return { calls, transport }
}
test('execution query filters resolve actual operator names, replace saved filters and stay on cursor requests without a view write', async () => {
  const flow = workflows.workflows.find(flow => flow.command === 'execution items list'), f = fixture()
  for (const lastId of [undefined, 'task-0']) {
    const result = await runWorkflow({ environment: 'production', profile: 'fixture' }, flow, { ...input, ...(lastId && { lastId }) }, session, { transport: f.transport })
    assert.equal(result.result.list[0].name, '专属测试任务')
    const request = f.calls.at(-1).body, name = request.filter.find(filter => filter.key === 'name')
    assert.equal(name.contentValue, '专属测试任务'); assert.equal(name.operator[0].value, '1'); assert.equal(name.operator[0].selected, true)
    assert.equal(request.filter.find(filter => filter.key === 'isDone').selector[0].selected, false)
    assert.equal(request.lastId, lastId)
  }
  assert.ok(!f.calls.some(call => call.path.endsWith('/view') && call.method === 'PUT'))
  assert.equal(definitions[1].selector[0].selected, true, 'Discovery metadata must not be mutated')
})
test('unknown and missing text operators fail before item queries instead of silently broadening the result', async () => {
  const flow = workflows.workflows.find(flow => flow.command === 'execution items list')
  for (const operators of [[], ['unknown']]) {
    const f = fixture()
    await assert.rejects(runWorkflow({ environment: 'production', profile: 'fixture' }, flow, { ...input, filters: [{ key: 'name', contentValue: '专属测试任务', operators }] }, session, { transport: f.transport }), { code: 'INVALID_INPUT' })
    assert.ok(!f.calls.some(call => call.path.endsWith('/item/list')))
  }
})
