import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; HttpOnly; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const input = { type: 'my', startDate: '2026.11.01', endDate: '2026.11.07' }
const run = (command, args, transport, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), { ...input, ...args }, session, { transport, ...options })
function fixture() {
  const view = { id: '7001', viewName: 'fixture', isCustom: true, isSelected: true, subView: 'kanban', viewType: 'all', group: 'custom', sort: 'custom', isShowDoneTask: true, isShowSubTask: true }
  const filters = [{ key: 'status', type: 'select', name: '状态', contentValue: null, operator: [{ name: '等于', value: 'equal', selected: true }], selector: [{ name: '完成', value: 'done', selected: false }, { name: '未完成', value: 'doing', selected: true }] }]
  const groups = [{ id: 'custom-7000', name: '未分组', isUngroup: true, displayOrder: 1 }], calls = [], control = { editCard: true, createTask: true, sortTask: true }
  let sequence = 7001
  return { view, filters, groups, calls, control, transport: async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method, body })
    if (url.pathname.endsWith('/view/list')) return json([view])
    if (url.pathname.endsWith('/view/filter')) return json({ filter: filters })
    if (url.pathname.endsWith('/view') && init.method === 'PUT') {
      // Match the service's destructive defaults when the caller omits them.
      Object.assign(view, { ...body, group: body.group ?? 'custom', isShowDoneTask: body.isShowDoneTask ?? false, isShowSubTask: body.isShowSubTask ?? false })
      if (body.name !== undefined) view.viewName = body.name
      if (body.filter) filters.splice(0, filters.length, ...body.filter)
      return json(view)
    }
    if (url.pathname.endsWith('/group/list')) return json({ editControl: control, groupList: groups, temporaryTaskCount: 0 })
    if (url.pathname.endsWith('/group/sort')) { const group = groups.find(group => group.id === body.moveId); group.displayOrder = 100; return json(100) }
    if (url.pathname.endsWith('/group/taskCount/list')) return json({ groupList: groups.map(group => ({ id: group.id, allCount: 0, doneCount: 0 })), temporaryTaskCount: 0 })
    if (url.pathname.endsWith('/group/task/list')) return json([])
    assert.ok(url.pathname.endsWith('/group'))
    if (init.method === 'POST') { const group = { id: 'custom-' + sequence++, name: body.name, ascriptionType: 'person', displayOrder: 10, isUngroup: false }; groups.push(group); return json(group) }
    if (init.method === 'PUT') { const group = groups.find(group => group.id === body.id); group.name = body.name; return json(group) }
    assert.equal(init.method, 'DELETE'); groups.splice(groups.findIndex(group => group.id === url.searchParams.get('id')), 1); return new Response('')
  } }
}
test('action group lifecycle retains business IDs, scope and view context across create, rename, reorder, counts, paging and removal', async () => {
  const server = fixture()
  const created = await run('action group add', { name: 'new' }, server.transport), groupId = created.resources.groupId
  assert.equal(groupId, 'custom-7001')
  await run('action group rename', { groupId, name: 'renamed' }, server.transport)
  await run('action group reorder', { groupId, frontId: 'custom-7000' }, server.transport)
  await run('action group count', { groupIds: [groupId] }, server.transport)
  await run('action group tasks', { groupId, max: 10, offset: 0 }, server.transport)
  const count = server.calls.find(call => call.path.endsWith('/taskCount/list'))
  assert.equal(count.query.groupIds, groupId); assert.equal(count.query.viewId, '7001'); assert.equal(count.query.startDate, input.startDate); assert.equal(count.query.sortType, 'custom')
  const page = server.calls.find(call => call.path.endsWith('/task/list'))
  assert.equal(page.query.offset, '0'); assert.equal(page.query.max, '10'); assert.equal(page.query.filterMyType, 'executive')
  await run('action group remove', { groupId }, server.transport, { approved: true })
  assert.equal(server.groups.length, 1); assert.equal(server.calls.filter(call => call.method === 'POST').length, 1)
})
test('action view patches preserve untouched defaults, resolve filter options and verify readback without mutating the caller', async () => {
  const server = fixture(), patch = { sort: 'name', isShowSubTask: false, filter: [{ key: 'status', selector: [{ value: 'done', selected: true }] }] }, original = structuredClone(patch)
  await run('action view configure', { patch }, server.transport)
  const body = server.calls.find(call => call.method === 'PUT').body
  assert.equal(body.group, 'custom'); assert.equal(body.isShowDoneTask, true); assert.equal(body.isShowSubTask, false)
  assert.equal(body.filter[0].operator[0].selected, true); assert.equal(body.filter[0].selector.find(option => option.value === 'doing').selected, false)
  assert.deepEqual(patch, original)
  const puts = server.calls.filter(call => call.method === 'PUT').length
  await assert.rejects(run('action view configure', { patch: { filter: [{ key: 'status', selector: [{ value: 'unknown', selected: true }] }] } }, server.transport), { code: 'CONTEXT_NOT_FOUND' })
  assert.equal(server.calls.filter(call => call.method === 'PUT').length, puts)
})
test('action invalid dates and missing organization IDs fail offline; permissions, system groups and foreign group references fail before writes', async () => {
  const server = fixture()
  await assert.rejects(run('action group add', { name: 'x', startDate: '2026.02.30' }, server.transport), { code: 'INVALID_INPUT' })
  await assert.rejects(run('action group add', { name: 'x', type: 'dept' }, server.transport), { code: 'INVALID_INPUT' })
  await assert.rejects(run('action group remove', { groupId: 'custom-7001' }, server.transport), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(server.calls.length, 0)
  await assert.rejects(run('action group rename', { groupId: 'custom-7000', name: 'x' }, server.transport), { code: 'FORBIDDEN' })
  await assert.rejects(run('action group add', { name: 'x', nextId: 'custom-9999' }, server.transport), { code: 'CONTEXT_NOT_FOUND' })
  server.control.editCard = false
  await assert.rejects(run('action group add', { name: 'x' }, server.transport), { code: 'FORBIDDEN' })
  assert.equal(server.calls.filter(call => call.method !== 'GET').length, 0)
})
test('action writes with uncertain responses are not replayed, and GET preference updates are visible in Schema and offline preview', async () => {
  const server = fixture()
  await assert.rejects(run('action group add', { name: 'uncertain' }, async (url, init) => init.method === 'POST' ? new Response('', { status: 503 }) : server.transport(url, init)), error => error.details.writeOutcome === 'unknown')
  let requests = 0
  const preview = await run('action workspace inspect', {}, async () => { requests++; throw Error('offline') }, { dryRun: true })
  assert.equal(preview.effect, 'write'); assert.ok(preview.steps.every(step => step.effect === 'write')); assert.equal(requests, 0)
  for (const suffix of ['/view/list', '/view/filter', '/group/list', '/group/taskCount/list', '/group/task/list']) assert.equal(catalog.operations.find(op => op.route === '/task/okr/action' + suffix).effect, 'write')
})
