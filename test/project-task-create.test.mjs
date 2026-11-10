import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { prepareTaskTemplate, verifyTaskTemplate } from '../dist/task-template.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const root = { projectId: '7001', moduleId: '7101', name: 'owned-task' }
const normal = { id: '7201', name: '普通', isDefault: true, isMilepost: false, isStop: false }, custom = { id: '7202', name: '自定义', isDefault: false, isMilepost: false, isStop: false }
function fixture(options = {}) {
  const calls = [], writes = [], state = { created: null, children: [] }
  const transport = async (url, init) => {
    const path = url.pathname; calls.push({ path, method: init.method, planType: init.headers.get('Plan-Type') })
    if (path.endsWith('/kanbanCrud')) return json({ id: '7001', coverId: options.template ? '8001' : null, editControl: {} })
    if (path.endsWith('/v4/template')) return json({ id: '8001', templateKanbanId: '7001', name: 'template', withEdit: options.editable !== false })
    if (path.endsWith('/template/settingList')) return json(options.types ?? [normal, custom])
    if (path.endsWith('/api/v3/template')) return json({ id: options.wrongDefinition ? '9999' : Number(url.searchParams.get('id')), name: 'current-type', defaultValues: options.defaults ?? null })
    if (path.endsWith('/kanbanLabel/list')) return json(options.labels ?? [{ id: '7401', name: 'owned-label', type: 'project', color: 1 }])
    if (path.endsWith('/kanbanChildCrud/list')) return json([{ id: '7101', type: 'task', name: 'tasks' }])
    if (path.endsWith('/kanbanChildCrud')) return json({ id: '7101', type: 'task', name: 'tasks', firstCardId: options.ambiguous ? null : '7301' })
    if (path.endsWith('/kanbanCardCrud/list')) return json((options.ambiguous ? ['7301', '7302'] : ['7301']).map(id => ({ id, name: 'card-' + id, editControl: {} })))
    if (path.endsWith('/cardEditControl')) return json({ createTask: true, modifyTaskType: true, addTaskMember: true, editTaskDate: true, editTaskPriority: true, selectTaskLabel: true, ...options.permissions })
    if (path.endsWith('/scopes/company/current')) return json({ taskExecutorScope: options.scope ?? ['81', '82'] })
    if (path.endsWith('/api/v3/task') && init.method === 'POST') {
      const body = JSON.parse(init.body); writes.push(body)
      assert.equal(init.headers.get('Plan-Type'), null)
      state.created = { id: 'owned-new-task', name: body.name, note: body.note ?? '', cardId: body.cardId, taskId: null, from: { projectId: body.projectId, planId: body.moduleId, type: 'project' }, taskTemplate: { id: body.taskTemplateId, isMilepost: false }, members: body.memberIds ? body.memberIds.split(',').map(id => ({ id })) : [], participants: body.participantsIds ? body.participantsIds.split(',').map(id => ({ id })) : [], responsibilityId: body.responsibilityId ?? null, ...(body.realStartDate !== undefined && { realStartDate: body.realStartDate }), ...(body.realEndDate !== undefined && { realEndDate: body.realEndDate }), ...(body.priorityV2 != null && { priorityV2: body.priorityV2 }) }
      state.created.labelList = (body.kanbanLabelIds ? body.kanbanLabelIds.split(',') : []).map(id => ({ id, type: 'project' }))
      state.children = (body.subTasks ?? []).map((child, index) => ({ id: 'owned-child-' + index, name: child.name, taskId: state.created.id, from: state.created.from, members: child.memberIds ? child.memberIds.split(',').map(id => ({ id })) : [], responsibilityId: child.responsibilityId ?? null, ...Object.fromEntries(['realStartDate', 'realEndDate'].filter(key => Object.hasOwn(child, key)).map(key => [key, child[key]])) }))
      if (options.timeout) throw Error('lost response after creation')
      return json({ id: state.created.id })
    }
    if (path.endsWith('/api/v3/task/subs')) return json(options.missingChildren ? [] : state.children.map(child => ({ id: child.id, name: child.name })))
    if (path.endsWith('/api/v3/task')) {
      state.detailReads = (state.detailReads ?? 0) + 1
      if (state.detailReads <= (options.visibilityFailures ?? 0)) return new Response(JSON.stringify({ code: 401005, message: 'task ascription not visible yet' }), { status: 400, headers: { 'content-type': 'application/json' } })
      const child = state.children.find(child => child.id === url.searchParams.get('id'))
      if (child) return json({ ...child, ...(options.foreignChild && { taskId: 'foreign-parent' }) })
      return json({ ...state.created, ...(options.wrongModule && { from: { projectId: '7001', planId: '7102' } }), ...(options.wrongMembers && { members: [] }) })
    }
    throw Error('Unexpected HTTP ' + path)
  }
  return { calls, writes, transport, state }
}
const run = async (input = {}, options = {}, dryRun = false) => {
  const server = fixture(options), flow = workflows.workflows.find(flow => flow.command === (options.template ? 'project template task create' : 'project task create'))
  try { return { server, result: await runWorkflow(ctx, flow, { ...root, ...input }, session, { transport: server.transport, dryRun }) } } catch (error) { error.fixture = server; throw error }
}
test('ordinary and template project task creation independently bind project/module/card/type and self executor', async () => {
  for (const template of [false, true]) {
    const { server, result } = await run({}, { template })
    assert.equal(result.result.id, 'owned-new-task'); assert.equal(result.resources.taskId, 'owned-new-task'); assert.equal(server.writes.length, 1)
    assert.deepEqual(server.writes[0], { name: root.name, projectId: '7001', moduleId: '7101', cardId: '7301', taskTemplateId: '7201', groupType: 'card', memberIds: '81' })
    assert.equal(server.calls.filter(row => row.path.endsWith('/v4/template')).length, template ? 1 : 0)
    assert.ok(server.calls.filter(row => row.path.startsWith('/task/v1/')).every(row => row.planType === (template || row.path.endsWith('/kanbanCrud') ? 'template' : null)))
  }
})
test('explicit type, participants clear, principal, priority, HTML note and zoned dates survive independent readback', async () => {
  const values = { templateId: '7202', memberIds: ['81', '82'], participantIds: [], principalId: '82', priorityV2: 2, note: '<p>task note</p>', dates: { start: '2026-11-09T09:00:00+08:00', end: '2026-11-09T18:00:00+08:00' } }
  const { server } = await run(values)
  assert.equal(server.writes[0].participantsIds, ''); assert.equal(server.writes[0].responsibilityId, '82'); assert.equal(server.writes[0].taskTemplateId, '7202')
  const long = await run({ memberIds: ['9007199254740993'] }, { scope: ['9007199254740993'] }); assert.equal(long.server.writes[0].memberIds, '9007199254740993')
})
const defaults = { note: '<p>type note</p>', priorityV2: 2, member: { memberIds: '82', responsibilityId: '82' }, participantsIds: '81', date: { realStartDate: '2026-11-09', realEndDate: '2026-11-10' }, label: { kanbanLabels: [{ id: '7401', name: 'owned-label', type: 'project' }] }, subtasks: [{ id: '7500', name: 'default-child', member: { members: [{ id: '81', name: 'self' }], responsibilityId: '81' } }] }
test('real type defaults produce task data and new direct children in both project contexts', async () => {
  for (const template of [false, true]) {
    const { server, result } = await run({ templateId: '7202' }, { defaults, template })
    const body = server.writes[0]
    assert.equal(body.note, defaults.note); assert.equal(body.priorityV2, 2); assert.equal(body.memberIds, '81,82'); assert.equal(body.participantsIds, '81')
    assert.equal(body.realStartDate, '2026-11-09'); assert.equal(body.kanbanLabelIds, '7401'); assert.equal(body.responsibilityId, undefined)
    assert.deepEqual(body.subTasks, [{ name: 'default-child', memberIds: '81', responsibilityId: '81' }]); assert.equal(result.resources.childTaskId0, 'owned-child-0')
    assert.ok(server.calls.some(call => call.path.endsWith('/api/v3/template')))
    assert.ok(server.calls.some(call => call.path.endsWith('/api/v3/task/subs')))
  }
})
test('explicit empty values clear defaults while ignore leaves configured values and children unused', async () => {
  const { server } = await run({ note: '', memberIds: [], participantIds: [], principalId: null, labels: [], subtasks: [], dates: { start: null, end: null }, priorityV2: 4 }, { defaults })
  assert.equal(server.writes[0].note, ''); assert.equal(server.writes[0].memberIds, ''); assert.equal(server.writes[0].participantsIds, ''); assert.equal(server.writes[0].realStartDate, null); assert.equal(server.writes[0].kanbanLabelIds, ''); assert.deepEqual(server.writes[0].subTasks, [])
  const ignored = await run({ defaults: 'ignore' }, { defaults })
  assert.equal(ignored.server.writes[0].note, undefined); assert.equal(ignored.server.writes[0].subTasks, undefined); assert.equal(ignored.server.writes[0].memberIds, '81')
})
test('defaults cannot bypass field permissions, member scope, label ownership or actual definition identity', async () => {
  for (const options of [{ wrongDefinition: true }, { defaults, scope: ['81'] }, ...['addTaskMember', 'editTaskDate', 'editTaskPriority', 'selectTaskLabel'].map(permission => ({ defaults, permissions: { [permission]: false } })), { defaults, labels: [] }, { defaults: { ...defaults, date: '2026-11-09' } }]) await assert.rejects(run({}, options), error => { assert.equal(error.fixture.writes.length, 0); return true })
})
test('child readback detects missing or foreign children after one creation and keeps resource IDs', async () => {
  for (const options of [{ defaults, missingChildren: true }, { defaults, foreignChild: true }]) await assert.rejects(run({}, options), error => { assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.fixture.writes.length, 1); assert.equal(error.details.resources.taskId, 'owned-new-task'); return true })
})
test('wrong template target or readonly template stops before any creation', async () => {
  await assert.rejects(run({}, { template: true, editable: false }), error => { assert.equal(error.fixture.writes.length, 0); return true })
  const results = { project: { id: '7001', coverId: '8001' }, modules: [] }
  assert.throws(() => prepareTaskTemplate('task-context-project-create', root, results, session), { code: 'CONTEXT_MISMATCH' })
})
test('task type availability/default ambiguity, invalid cards, hidden members, principal and date constraints fail before writes', async () => {
  const cases = [[{}, { types: [custom] }], [{ templateId: '7202' }, { types: [{ ...custom, isStop: true }] }], [{ templateId: '7202' }, { types: [{ ...custom, isMilepost: true }] }], [{}, { ambiguous: true }], [{ cardId: '9999' }, {}], [{ memberIds: ['99'] }, {}], [{ principalId: '82' }, {}], [{ dates: { start: '2026-11-10', end: '2026-11-09' } }, {}]]
  for (const [input, options] of cases) await assert.rejects(run(input, options), error => { assert.equal(error.fixture.writes.length, 0); return true })
})
test('UI permissions are enforced separately for each requested creation capability', async () => {
  for (const [input, permission] of [[{}, 'createTask'], [{ templateId: '7202' }, 'modifyTaskType'], [{ memberIds: ['82'] }, 'addTaskMember'], [{ participantIds: [] }, 'addTaskMember'], [{ dates: { start: '2026-11-09' } }, 'editTaskDate'], [{ priorityV2: 2 }, 'editTaskPriority']]) await assert.rejects(run(input, { permissions: { [permission]: false } }), error => { assert.equal(error.code, 'FORBIDDEN'); assert.equal(error.fixture.writes.length, 0); return true })
})
test('unknown writes and inconsistent independent identities/members retain resources and never create twice', async () => {
  for (const options of [{ timeout: true }, { wrongModule: true }, { wrongMembers: true }]) await assert.rejects(run({}, options), error => {
    assert.equal(error.fixture.writes.length, 1)
    if (options.timeout) assert.equal(error.details.writeOutcome, 'unknown')
    else assert.equal(error.details.resources.taskId, 'owned-new-task')
    return true
  })
})
test('offline project task plans perform zero HTTP and declare distinct template context', async () => {
  const { server, result } = await run({}, { template: true }, true)
  assert.equal(result.dryRun, true); assert.equal(server.calls.length, 0)
})

test('post-create async task attribution is rechecked without repeating the creation request', async () => {
  for (const template of [false, true]) {
    const { server, result } = await run({}, { template, visibilityFailures: 2 })
    assert.equal(server.writes.length, 1); assert.equal(server.state.detailReads, 3); assert.equal(result.result.id, 'owned-new-task')
  }
})
test('persistent post-create permission rejection retains the new ID and stops after five detail checks', async () => {
  await assert.rejects(run({}, { visibilityFailures: 100 }), error => {
    assert.equal(error.code, 'BUSINESS_ERROR'); assert.equal(error.fixture.writes.length, 1); assert.equal(error.fixture.state.detailReads, 5); assert.equal(error.details.resources.taskId, 'owned-new-task'); return true
  })
})
