import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { dependencyDates, dependencyGraph, assertDag } from '../dist/project-dependencies.js'
import { CookieJar } from 'tough-cookie'

const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.parse('2035-01-01T00:00:00Z') }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const flow = command => workflows.workflows.find(row => row.command === command)
function fixture(options = {}) {
  const calls = [], mutations = [], settings = { mode: 'day', isOpenView: false, isOpenKeyPath: true }, baselineRows = new Map(), snapshots = new Map(), edges = new Map()
  const projectId = options.template ? '9002' : '9001', moduleId = '101', cardId = '201'
  const make = (id, start, end, extra = {}) => ({ id, name: id, cardId: '201', cardIds: [201], hasSubTask: false, forbidEdit: false, from: { projectId, planId: moduleId, planType: 'task' }, realStartDate: start, realEndDate: end, isAllDay: true, ...extra })
  const tasks = new Map([['task-a', make('task-a', '2026-11-08', '2026-11-09')], ['task-b', make('task-b', '2026-11-12', '2026-11-13')], ['task-c', make('task-c', '2026-11-20', '2026-11-21')]])
  const listEdges = () => [...edges.values()].map(row => ({ ...row }))
  let sequence = 500, graphReads = 0, taskReads = 0
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query, body, headers: Object.fromEntries(init.headers) })
    if (path === '/task/login/authAjax') return json({ success: true, id: options.wrongIdentity ? 82 : 81, username: 'fixture', team: { id: 7, name: '公司' }, token: 'fixture' })
    if (path === '/task/ordercenter/v2/member/state/independent') return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path === '/task/ordercenter/v2/function/available') return json([])
    if (path === '/task/authority/v3/authorities/company/current') return json({ useKanban: options.disabled !== true })
    if (path === '/task/v4/template') return json({ id: 6001, name: 'fixture-template', templateKanbanId: projectId, withEdit: options.withEdit !== false, needLevelUp: false })
    if (path.startsWith('/task/v1/') || path.startsWith('/task/v3/kanbanChild')) assert.equal(init.headers.get('Plan-Type'), options.template || path === '/task/v1/kanbanCrud' ? 'template' : null)
    if (path === '/task/v1/kanbanCrud') return json({ id: projectId, coverId: init.headers.get('Plan-Type') === 'template' ? options.wrongKind ? 6002 : options.template ? 6001 : null : null, name: 'fixture', editControl: { editKanbanGanttBaseline: options.canBaseline !== false } })
    if (path === '/task/v1/kanbanChildCrud/list') return json(options.foreignModule ? [] : [{ id: 101, type: options.wrongModuleType ? 'workflow' : 'task', name: 'tasks' }, ...(options.ambiguous ? [{ id: 102, type: 'task', name: 'other' }] : [])])
    if (path === '/task/v1/kanbanChildCrud') return json({ id: options.wrongModuleDetail ? 102 : 101, type: 'task', name: 'tasks' })
    if (path.endsWith('/gantt/info')) {
      if (method === 'PUT') { mutations.push(calls.at(-1)); Object.assign(settings, body); delete settings.kanbanChildId; if (options.dropFalse) settings.isOpenKeyPath = true }
      return json(settings)
    }
    if (path === '/task/v1/kanbanCardCrud/list') return json([{ id: 201, name: 'card', kanbanChildId: 101, editControl: {} }])
    if (path === '/task/api/v3/projectTask/taskList') {
      assert.equal(method, 'PUT'); assert.equal(body.planId, moduleId); assert.equal(body.key, cardId); assert.deepEqual(body.filter, []); assert.equal(body.showView, 'schedule'); assert.equal(body.planViewId, null)
      return json([...tasks.values()].filter(row => !row.taskId).slice(body.offset, body.offset + body.max))
    }
    if (path === '/task/api/v3/task/subs') return json([...tasks.values()].filter(row => row.taskId === query.taskId))
    if (path === '/task/api/v3/task/editcontrol') return json({ taskId: query.taskId, module: 'project', siteId: projectId, editControl: { editTaskDate: options.canDates !== false, editTaskProgress: options.canProgress !== false } })
    if (path === '/task/api/v3/task') {
      if (method === 'PUT') { mutations.push(calls.at(-1)); Object.assign(tasks.get(body.id), body); return json({}) }
      taskReads++
      const task = tasks.get(query.id)
      if (!task) return json({ code: 401002, message: 'missing' }, 404)
      if (options.foreignTask) return json({ ...task, from: { ...task.from, planId: '999' } })
      if (options.settleLater && taskReads > 4) tasks.get('task-b').realStartDate = '2026-11-10'
      return json(task)
    }
    if (path.endsWith('/baseline/list')) return json([...baselineRows.values()])
    if (path.endsWith('/baseline/tasks')) return snapshots.has(query.baselineId) ? json(snapshots.get(query.baselineId)) : json({ code: 401002, message: 'missing' }, 404)
    if (path.endsWith('/baseline')) {
      mutations.push(calls.at(-1))
      if (method === 'POST') {
        const id = String(++sequence), row = { id, name: body.name, createTime: '2026-11-08T12:00:00+08:00', dateCreated: '2026.11.08 12:00' }
        baselineRows.set(id, row); snapshots.set(id, options.omitSnapshot ? [] : [...tasks.values()].map(({ id, realStartDate, realEndDate, isAllDay }) => ({ id, realStartDate, realEndDate, isAllDay })))
        if (options.badReceipt) return json({ id, name: body.name })
        if (options.writeTimeout) throw Error('uncertain response')
        return json(row)
      }
      const id = String(body?.id ?? query.id)
      if (method === 'PUT') { baselineRows.get(id).name = body.name; return json(baselineRows.get(id)) }
      baselineRows.delete(id); if (!options.keepSnapshot) snapshots.delete(id); return json(200)
    }
    if (path.endsWith('/depend/list')) {
      graphReads++
      if (options.staleGraph && graphReads === 2) edges.set('foreign-concurrent', { id: 'foreign-concurrent', fromId: 'task-b', toId: 'task-c', type: 'start_to_start', gap: 0 })
      return json(listEdges())
    }
    if (path.endsWith('/depend/listByTask')) return json(listEdges().filter(row => row.fromId === query.taskId || row.toId === query.taskId))
    if (path.endsWith('/depend') || path.endsWith('/depends')) {
      mutations.push(calls.at(-1))
      if (options.writeTimeout) throw Error('uncertain dependency response')
      if (path.endsWith('/depends')) {
        for (const [id, row] of edges) if (body.type === 'pre' ? row.toId === body.taskId : row.fromId === body.taskId) edges.delete(id)
        for (const row of body.list) { const id = 'edge-' + ++sequence; edges.set(id, { id, ...row }) }
        return json(listEdges().filter(row => row.fromId === body.taskId || row.toId === body.taskId))
      }
      if (method === 'POST') { const id = 'edge-' + ++sequence, row = { id, ...body }; edges.set(id, row); return json(row) }
      if (method === 'PUT') { Object.assign(edges.get(body.id), body); return json(edges.get(body.id)) }
      edges.delete(query.id); return new Response('')
    }
    throw Error('unexpected route ' + path)
  }
  const run = (suffix, input = {}, approved = false) => runWorkflow(ctx, flow((options.template ? 'project template ' : 'project ') + suffix), { ...(options.template ? { coverId: '6001' } : { projectId: '9001' }), ...input }, session, { transport, approved })
  return { run, transport, calls, mutations, tasks, edges, baselineRows, snapshots, settings }
}

test('ordinary project and project template independently resolve parent, module and personal settings, preserving false and omitted preferences', async () => {
  for (const template of [false, true]) {
    const f = fixture({ template })
    const context = (await f.run('schedule context')).result
    assert.equal(context.projectId, template ? '9002' : '9001'); assert.equal(context.template, template)
    assert.deepEqual(context.cards, [{ id: '201', name: 'card' }])
    const updated = (await f.run('gantt settings update', { settings: { mode: 'doubleMonth', isOpenKeyPath: false } })).result
    assert.deepEqual(updated.settings, { mode: 'doubleMonth', isOpenView: false, isOpenKeyPath: false })
    assert.equal(f.mutations.length, 1)
    const page = (await f.run('schedule tasks list', { max: 2, offset: 0 })).result
    assert.equal(page.items.length, 2); assert.equal(page.page.nextOffset, 2); assert.equal(page.page.total, null)
    const last = (await f.run('schedule tasks list', { max: 2, offset: 2 })).result
    assert.equal(last.items.length, 1); assert.equal(last.page.nextOffset, null)
  }
})
test('wrong identity, resource kind, ambiguous modules and mismatching details stop before business writes', async () => {
  for (const options of [{ wrongIdentity: true }, { wrongKind: true }, { ambiguous: true }, { wrongModuleDetail: true }, { foreignModule: true }, { wrongModuleType: true }]) {
    const f = fixture(options)
    await assert.rejects(f.run('gantt settings update', { settings: { mode: 'week' } }))
    assert.equal(f.mutations.length, 0)
  }
  const f = fixture({ dropFalse: true })
  await assert.rejects(f.run('gantt settings update', { settings: { isOpenKeyPath: false } }), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('baseline lifecycle captures root and subtask dates, compares history, renames without rewriting snapshot and independently proves deletion', async () => {
  for (const template of [false, true]) {
    const f = fixture({ template })
    f.tasks.get('task-a').hasSubTask = true
    f.tasks.set('task-child', { ...structuredClone(f.tasks.get('task-a')), id: 'task-child', taskId: 'task-a', hasSubTask: false })
    const created = await f.run('baseline create', { name: 'baseline' }), baselineId = created.resources.baselineId
    assert.equal(created.result.tasks.length, 4)
    const snapshot = structuredClone(f.snapshots.get(baselineId))
    f.tasks.get('task-a').realStartDate = '2026-11-07'
    const inspected = (await f.run('baseline inspect', { baselineId })).result
    assert.equal(inspected.tasks.find(row => row.taskId === 'task-a').changed, true)
    const renamed = await f.run('baseline rename', { baselineId, name: 'renamed' })
    assert.equal(renamed.result.baseline.name, 'renamed'); assert.deepEqual(renamed.result.tasks, snapshot)
    assert.equal((await f.run('baseline remove', { baselineId }, true)).result.deleted, true)
    assert.equal(f.snapshots.size, 0)
  }
})
test('baseline UI permission and template withEdit cannot be bypassed; destructive confirmation occurs before all HTTP', async () => {
  for (const options of [{ canBaseline: false }, { template: true, withEdit: false }]) {
    const f = fixture(options)
    await assert.rejects(f.run('baseline create', { name: 'denied' }), { code: 'FORBIDDEN' }); assert.equal(f.mutations.length, 0)
  }
  const f = fixture()
  await assert.rejects(f.run('baseline remove', { baselineId: '501' }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  await assert.rejects(f.run('baseline inspect', { baselineId: '900' }), { code: 'FORBIDDEN' })
  assert.ok(!f.calls.some(row => row.path.endsWith('/baseline/tasks')))
})
test('baseline bridge omission, invalid creation receipt and lost response preserve the allocated resource without retry', async () => {
  for (const options of [{ omitSnapshot: true }, { badReceipt: true }, { writeTimeout: true }]) {
    const f = fixture(options)
    await assert.rejects(f.run('baseline create', { name: 'bridge' }), error => {
      assert.equal(error.details.resources.baselineId, options.writeTimeout ? undefined : '501')
      assert.equal(error.details.writeOutcome, options.badReceipt || options.writeTimeout ? 'unknown-do-not-retry' : 'check-completed-steps')
      return true
    })
    assert.equal(f.mutations.filter(row => row.method === 'POST').length, 1)
  }
  const f = fixture({ keepSnapshot: true }), created = await f.run('baseline create', { name: 'stale' })
  await assert.rejects(f.run('baseline remove', { baselineId: created.resources.baselineId }, true), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('dependency create, gap/type update, two-direction inspection and remove preserve ordinary/template contexts and task dates', async () => {
  for (const template of [false, true]) {
    const f = fixture({ template })
    const created = await f.run('dependency create', { fromTaskId: 'task-a', toTaskId: 'task-b' }), dependencyId = created.resources.dependencyId
    assert.equal(created.result.constraints[0].status, 'satisfied')
    assert.ok(created.result.tasks.every(row => !row.changed))
    const updated = await f.run('dependency update', { dependencyId, type: 'start_to_start', gap: 2 })
    assert.equal(updated.result.items[0].gap, 2)
    assert.equal((await f.run('dependency list', { taskId: 'task-b' })).result.items[0].id, dependencyId)
    assert.equal((await f.run('dependency remove', { dependencyId }, true)).result.deleted, true)
    assert.equal(f.edges.size, 0)
  }
})
test('dependency replacement preserves the opposite side and existing type/gap; empty means explicit clear', async () => {
  const f = fixture()
  f.edges.set('edge-ab', { id: 'edge-ab', fromId: 'task-a', toId: 'task-b', type: 'start_to_start', gap: -1 })
  f.edges.set('edge-bc', { id: 'edge-bc', fromId: 'task-b', toId: 'task-c', type: 'end_to_end', gap: 0 })
  const result = await f.run('dependency replace', { taskId: 'task-b', direction: 'pre', links: [{ taskId: 'task-a' }] }, true)
  assert.equal(result.result.items.find(row => row.fromId === 'task-a').gap, -1)
  assert.equal(result.result.items.find(row => row.fromId === 'task-a').type, 'start_to_start')
  assert.ok(f.edges.has('edge-bc'))
  await f.run('dependency replace', { taskId: 'task-b', direction: 'pre', links: [] }, true)
  assert.equal(f.edges.size, 1); assert.ok(f.edges.has('edge-bc'))
})
test('schedule task date/progress updates use actual permissions for both ordinary projects and templates, preserving explicit zero/null', async () => {
  for (const template of [false, true]) {
    const f = fixture({ template })
    await f.run('schedule task update', { taskId: 'task-a', dates: { start: '2026-11-07', end: '2026-11-08' }, progress: 70 }, true)
    assert.equal(f.tasks.get('task-a').realStartDate, '2026-11-07'); assert.equal(f.tasks.get('task-a').progress, 70)
    await f.run('schedule task update', { taskId: 'task-a', dates: { start: null, end: null }, progress: 0 }, true)
    assert.equal(f.tasks.get('task-a').realEndDate, null); assert.equal(f.tasks.get('task-a').progress, 0)
  }
  for (const options of [{ canDates: false }, { canProgress: false }, { template: true, withEdit: false }]) {
    const f = fixture(options)
    await assert.rejects(f.run('schedule task update', { taskId: 'task-a', dates: { start: null, end: null }, progress: 0 }, true), { code: 'FORBIDDEN' }); assert.equal(f.mutations.length, 0)
  }
  const repeat = fixture(); repeat.tasks.get('task-a').rrule = 'FREQ=DAILY'
  await assert.rejects(repeat.run('schedule task update', { taskId: 'task-a', dates: { start: null } }, true), { code: 'INVALID_INPUT' }); assert.equal(repeat.mutations.length, 0)
})
test('self-reference, cycles, duplicate pairs, foreign/readonly tasks and stale graphs stop before mutation', async () => {
  for (const options of [{ foreignTask: true }, { staleGraph: true }, { readonly: true }, { cycle: true }, { duplicate: true }]) {
    const f = fixture(options)
    if (options.readonly) f.tasks.get('task-a').forbidEdit = true
    if (options.cycle) f.edges.set('edge-ba', { id: 'edge-ba', fromId: 'task-b', toId: 'task-a', type: 'start_to_start', gap: 0 })
    if (options.duplicate) f.edges.set('edge-ab', { id: 'edge-ab', fromId: 'task-a', toId: 'task-b', type: 'start_to_start', gap: 0 })
    await assert.rejects(f.run('dependency create', { fromTaskId: 'task-a', toTaskId: 'task-b' }))
    assert.equal(f.mutations.length, 0)
  }
  const f = fixture()
  await assert.rejects(f.run('dependency create', { fromTaskId: 'task-a', toTaskId: 'task-a' }), { code: 'INVALID_INPUT' })
  await assert.rejects(f.run('dependency remove', { dependencyId: 'not-in-module' }, true), { code: 'FORBIDDEN' })
  assert.equal(f.mutations.length, 0)
})
test('dependency readback only polls HTTP reads; an unsettled date reports stored mutation and never retries the write', async () => {
  const later = fixture({ settleLater: true })
  later.tasks.get('task-b').realStartDate = '2026-11-09'
  const done = await later.run('dependency create', { fromTaskId: 'task-a', toTaskId: 'task-b' })
  assert.ok(done.result.tasks.some(row => row.changed)); assert.equal(later.mutations.length, 1)
  const pending = fixture()
  pending.tasks.get('task-b').realStartDate = '2026-11-09'
  await assert.rejects(pending.run('dependency create', { fromTaskId: 'task-a', toTaskId: 'task-b' }), error => error.code === 'ASYNC_READBACK_PENDING' && error.details.resources.dependencyId === 'edge-501' && error.details.completedSteps.includes('changed'))
  assert.equal(pending.mutations.length, 1)
  const timeout = fixture({ writeTimeout: true })
  await assert.rejects(timeout.run('dependency create', { fromTaskId: 'task-a', toTaskId: 'task-b' }), error => error.details.writeOutcome === 'unknown-do-not-retry')
  assert.equal(timeout.mutations.length, 1)
})
test('date constraints retain UI calendar semantics for all four types, signed gaps, absent dates and timezone-bearing timestamps', () => {
  const tasks = new Map([['a', { realStartDate: '2026-11-08T23:00:00+08:00', realEndDate: '2026-11-10' }], ['b', { realStartDate: '2026-11-10', realEndDate: '2026-11-12' }]])
  const rows = ['start_to_start', 'start_to_end', 'end_to_start', 'end_to_end'].map((type, i) => ({ id: String(i), fromId: 'a', toId: 'b', type, gap: 0 }))
  assert.deepEqual(dependencyDates(rows, tasks).map(row => row.status), ['satisfied', 'satisfied', 'pending', 'satisfied'])
  tasks.get('b').realStartDate = null
  assert.equal(dependencyDates([rows[2]], tasks)[0].status, 'not-applicable-missing-date')
  assert.throws(() => dependencyGraph([{ id: '1', fromId: 'a', toId: 'b', type: 'unknown', gap: 0 }]))
  assert.throws(() => assertDag([{ fromId: 'a', toId: 'b' }, { fromId: 'b', toId: 'a' }]), { code: 'DEPENDENCY_CYCLE' })
})
test('agent dry-run and destructive guards send no HTTP; tampered executor, unsupported modes and raw bypasses are rejected', async () => {
  let calls = 0; const transport = async () => { calls++; throw Error('unexpected HTTP') }
  for (const command of ['project baseline create', 'project template dependency replace']) {
    const input = command.includes('template') ? { coverId: '6001', taskId: 'task-a', direction: 'post', links: [] } : { projectId: '9001', name: 'draft' }
    assert.equal((await executeWorkflow(ctx, flow(command), input, null, { dryRun: true, transport })).dryRun, true)
  }
  const changed = structuredClone(flow('project baseline create')); changed.steps.pop()
  await assert.rejects(runWorkflow(ctx, changed, { projectId: '9001', name: 'bad' }, session, { dryRun: true, transport }), { code: 'INVALID_CONTRACT' })
  await assert.rejects(runWorkflow(ctx, flow('project gantt settings update'), { projectId: '9001', settings: { mode: 'yearly' } }, session, { transport }), { code: 'INVALID_INPUT' })
  const raw = catalog.operations.find(op => op.route.endsWith('/task/depend') && op.method === 'POST')
  await assert.rejects(executeOperation(ctx, raw, { body: { fromId: 'a', toId: 'b', type: 'start_to_start' } }, session, { transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.equal(calls, 0)
})
test('public schedule entry checks expiry, over-capacity and PLAN before resource HTTP; current company does not gain permissions through an alias', async () => {
  for (const options of [{ expired: true }, { overCapacity: true }, { disabled: true }]) {
    const f = fixture(options)
    await assert.rejects(executeWorkflow(ctx, flow('project schedule context'), { projectId: '9001' }, session, { transport: f.transport }))
    assert.equal(f.calls.some(row => row.path === '/task/v1/kanbanCrud'), false)
    assert.equal(f.mutations.length, 0)
  }
  const f = fixture()
  await assert.rejects(executeWorkflow(ctx, flow('project schedule task update'), { projectId: '9001', taskId: 'task-a', progress: 0 }, session, { transport: f.transport }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(f.calls.length, 0)
})
