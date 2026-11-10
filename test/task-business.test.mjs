import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { taskDate } from '../dist/task-business.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const base = { taskId: 'task-1', projectId: '7001' }
function fixture(options = {}) {
  let task = { id: 'task-1', name: '任务', from: { projectId: 7001, type: 'project' }, members: [{ id: 81 }], participants: [], responsibilityId: null, creatorId: 81, taskId: null, taskTemplate: { isMilepost: false }, realStartDate: '2027-02-01', realEndDate: '2027-02-02', rrule: null, rruleType: null, rruleContent: [], alert: { personal: [{ schedule: 'begin_-5_min' }], member: [] }, ...options.task }
  let comments = options.comments ?? [], labels = [], selectedLabels = [], permissions = { editTaskName: true, editTaskNote: true, editTaskDate: true, editTaskProgress: true, finishTask: true, editTaskPriority: true, addTaskMember: true, removeTaskMember: true, editSubTask: true, commentTask: true, editTaskLabel: true, selectTaskLabel: true, editTaskRemind: true, editTaskRepeat: true, removeTask: true, ...options.permissions }
  const calls = [], tasks = new Map([['task-1', task]])
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method: init.method, body, query: Object.fromEntries(url.searchParams), planType: init.headers.get('Plan-Type') })
    if (url.pathname.endsWith('/scopes/company/current')) return json({ taskExecutorScope: options.memberScope ?? [81,82] })
    // Legacy GET decorates coverId only when the template header is present.
    if (url.pathname.endsWith('/kanbanCrud')) return json({ id: 7001, coverId: options.template && init.headers.get('Plan-Type') === 'template' ? '8001' : null })
    if (url.pathname.endsWith('/v4/template')) { options.coverReads = (options.coverReads ?? 0) + 1; return json({ id: '8001', name: 'fixture-template', templateKanbanId: options.mismatchedCover ? '7999' : '7001', withEdit: options.readonly !== true && !(options.expireCover && options.coverReads > 1) }) }
    if (url.pathname.endsWith('/task/editcontrol')) return json({ taskId: 'task-1', module: url.searchParams.get('module'), siteId: url.searchParams.get('siteId'), editControl: permissions })
    if (url.pathname.endsWith('/task/template')) return json({ templateFields: options.fields ?? [] })
    if (url.pathname.endsWith('/task/subs')) return json([...tasks.values()].filter(item => item.taskId === 'task-1'))
    if (url.pathname.endsWith('/api/v3/task')) {
      if (init.method === 'POST') { const created = { ...task, ...body, id: 'task-2', members: (body.memberIds ?? '').split(',').filter(Boolean).map(id => ({ id })) }; tasks.set('task-2', created); return json(created) }
      if (init.method === 'PUT') {
        if (!options.ignoreWrite) {
          Object.assign(task, body)
          for (const [dto, key] of [['memberIds','members'],['participantsIds','participants']]) if (Object.hasOwn(body, dto)) task[key] = body[dto].split(',').filter(Boolean).map(id => ({ id }))
          if (body.kanbanLabelIds != null) task.labelList = body.kanbanLabelIds.split(',').filter(Boolean).map(id => ({ id, type: 'project' }))
          if (body.todoLabelIds) task.labelList.push(...body.todoLabelIds.split(',').map(id => ({ id, type: 'todo' })))
          if (body.alert) task.alert = { ...body.alert, member: body.alert.member.map((item, index) => ({ ...item, id: item.id ?? 990 + index, edit: item.id === 989 ? false : true })) }
        }
        return json(task)
      }
      if (init.method === 'DELETE') { tasks.delete('task-1'); return new Response(null) }
      return json(tasks.get(url.searchParams.get('id')))
    }
    if (url.pathname.endsWith('/comment/list')) return json(comments)
    if (url.pathname.endsWith('/comment/data')) {
      if (init.method === 'POST') { options.notifyFlag = body.notifyFlag; return new Response(null) }
      return json({ notifyFlag: options.notifyFlag ?? false, atMembers: [{ id: 81, showName: '本人' }, { id: 82, showName: '<成员>' }] })
    }
    if (url.pathname.endsWith('/comment')) {
      if (init.method === 'POST') { const comment = { id: 9001, content: body.content, creator: { id: 81 }, fileList: [], gaodeList: [] }; comments.push(comment); return json(comment) }
      comments = comments.filter(item => String(item.id) !== url.searchParams.get('id')); return new Response(null)
    }
    if (url.pathname.endsWith('/kanbanLabel/list')) return json([...labels, ...selectedLabels])
    if (url.pathname.endsWith('/todoLabel/list')) return json([...labels, ...selectedLabels])
    if (url.pathname.endsWith('/kanbanLabel')) {
      if (init.method === 'POST') { const label = { id: 9201, name: body.name, color: body.color, type: 'project' }; labels.push(label); return json(label) }
      if (init.method === 'PUT') { const label = labels.find(item => String(item.id) === body.id); Object.assign(label, body); return json(label) }
      labels = labels.filter(item => String(item.id) !== url.searchParams.get('id')); return json({ isDeleted: true })
    }
    if (url.pathname.endsWith('/recycleBin/list')) return json([{ id: 10001, resourceId: 'task-1', userId: 81, type: 5 }])
    throw Error('Unexpected task request ' + url.pathname)
  }
  return { calls, transport, task: () => task }
}
const run = (command, input, fixture) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { approved: true, transport: fixture.transport })
test('all generic task content writes enforce actual template cover access even in common permission context', async () => {
  const examples = [['task change', { patch: { name: 'changed' } }], ['task member set', { executors: ['81'] }], ['task schedule set', { dates: { start: null, end: null } }], ['task subtask create', { name: 'child' }], ['task remove', {}], ['task comment add', { text: 'owned' }], ['task comment remove', { commentId: '9001' }], ['task label create', { name: 'label', color: 3 }], ['task label set', { labels: [] }], ['task repeat clear', {}], ['task reminder set', { personal: [] }]]
  for (const [command, extra] of examples) for (const explicit of [false, true]) {
    if (command.startsWith('task label ') && !explicit) continue
    const f = fixture({ template: true, readonly: true, comments: [{ id: 9001, creator: { id: 81 } }] })
    await assert.rejects(run(command, { taskId: base.taskId, ...(explicit && { projectId: base.projectId }), ...extra }, f), { code: 'FORBIDDEN' })
    assert.ok(f.calls.every(call => call.method === 'GET'), command)
    assert.equal(f.calls.filter(call => call.path.endsWith('/v4/template')).length, 2, command)
    assert.ok(f.calls.some(call => call.path.endsWith('/kanbanCrud') && call.query.id === base.projectId && call.planType === 'template'), command)
  }
})
test('readonly template inspection remains available; cover mismatch and revoked fresh editing permission stop writes', async () => {
  const readonly = fixture({ template: true, readonly: true })
  const inspected = await run('task context inspect', base, readonly)
  assert.equal(inspected.result.task.id, base.taskId)
  assert.equal(readonly.calls.filter(call => call.path.endsWith('/v4/template')).length, 1)
  for (const options of [{ template: true, mismatchedCover: true }, { template: true, expireCover: true }]) {
    const f = fixture(options)
    await assert.rejects(run('task change', { ...base, patch: { name: 'changed' } }, f), error => ['CONTEXT_MISMATCH', 'FORBIDDEN'].includes(error.code))
    assert.ok(f.calls.every(call => call.method === 'GET'))
  }
  const editable = fixture({ template: true })
  await run('task change', { ...base, patch: { name: 'changed' } }, editable)
  assert.equal(editable.calls.filter(call => call.method === 'PUT').length, 1)
})
test('membership adds enforce the current UI scope, removal enforces its own permission, and readback confirms empty participant CSV', async () => {
  const f = fixture()
  const result = await run('task member set', { ...base, executors: ['81','82'], participants: [], principalId: '82' }, f)
  assert.equal(result.result.responsibilityId, '82')
  assert.equal(f.calls.find(call => call.method === 'PUT').body.participantsIds, '')
  const forbidden = fixture({ memberScope: [81] })
  await assert.rejects(run('task member set', { ...base, executors: ['81','82'] }, forbidden), { code: 'FORBIDDEN' })
  assert.equal(forbidden.calls.filter(call => call.method === 'PUT').length, 0)
  const cannotRemove = fixture({ permissions: { removeTaskMember: false } })
  await assert.rejects(run('task member set', { ...base, executors: [] }, cannotRemove), { code: 'FORBIDDEN' })
  const unchangedOutOfScope = fixture({ task: { members: [{ id: 83 }] }, memberScope: [81] })
  await run('task member set', { ...base, executors: ['83','81'] }, unchangedOutOfScope)
})
test('task completion respects required fields and independent readback rejects a successful response without persisted changes', async () => {
  const required = fixture({ fields: [{ id: 1, name: '必填', isRequired: true, type: 1, value: '' }] })
  await assert.rejects(run('task change', { ...base, patch: { isDone: true } }, required), { code: 'INVALID_INPUT' })
  assert.equal(required.calls.some(call => call.method === 'PUT'), false)
  const ignored = fixture({ ignoreWrite: true })
  await assert.rejects(run('task change', { ...base, patch: { name: '新名' } }, ignored), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.failedStep === 'verifiedTask')
  assert.equal(ignored.calls.filter(call => call.method === 'PUT').length, 1)
})
test('comment removal rejects another creator before DELETE and replies bind the target to this task and escape text', async () => {
  const others = fixture({ comments: [{ id: 9000, content: '原评论', creator: { id: 82 } }] })
  await assert.rejects(run('task comment remove', { ...base, commentId: '9000' }, others), { code: 'FORBIDDEN' })
  assert.equal(others.calls.some(call => call.method === 'DELETE'), false)
  const result = await run('task comment reply', { ...base, replyTo: '9000', text: '<script>\nhello' }, others)
  assert.ok(result.result.content.includes('data-people-id="82"'))
  assert.ok(result.result.content.includes('&lt;script&gt;<br>hello'))
  assert.ok(!result.result.content.includes('<script>'))
  assert.equal(others.calls.find(call => call.method === 'POST').body.atIds, '82')
  await run('task comment remove', { ...base, commentId: '9001' }, others)
  await assert.rejects(run('task comment reply', { ...base, replyTo: '9999', text: 'bad target' }, fixture()), { code: 'INVALID_INPUT' })
})
test('project labels preserve scope, selected associations can clear, and mutations are verified independently', async () => {
  const f = fixture()
  await run('task label create', { ...base, name: '准备', color: 1 }, f)
  await run('task label configure', { ...base, labelId: '9201', patch: { name: '进行' } }, f)
  await run('task label set', { ...base, labels: [{ id: '9201', type: 'project' }] }, f)
  await run('task label set', { ...base, labels: [] }, f)
  await assert.rejects(run('task label configure', { ...base, labelId: '9999', patch: { name: 'foreign' } }, f), { code: 'INVALID_INPUT' })
  await run('task label remove', { ...base, labelId: '9201' }, f)
})
test('dates require calendar validity and explicit timezones; one side is preserved, recurrence and milestones are protected', async () => {
  for (const date of ['2027-02-30','2027-01-01T10:00:00','2027-01-01T25:00:00Z']) assert.throws(() => taskDate(date), { code: 'INVALID_INPUT' })
  const f = fixture()
  const result = await run('task schedule set', { ...base, dates: { start: '2027-01-31' } }, f)
  assert.equal(result.result.realEndDate, '2027-02-02')
  await assert.rejects(run('task schedule set', { ...base, dates: { start: '2027-02-03' } }, fixture()), { code: 'INVALID_INPUT' })
  await assert.rejects(run('task schedule set', { ...base, dates: { start: '2027-02-03', end: '2027-02-04' } }, fixture({ task: { taskTemplate: { isMilepost: true } } })), { code: 'INVALID_INPUT' })
})
test('reminders preserve the omitted category and immutable reminders and verify cleared personal reminders', async () => {
  const alert = { personal: [{ schedule: 'begin_-5_min' }], member: [{ id: 989, date: '2027-02-01', time: '10:00', memberIds: '81', edit: false }] }
  const f = fixture({ task: { alert } })
  const result = await run('task reminder set', { ...base, personal: [] }, f)
  assert.deepEqual(result.result.alert.personal, [])
  assert.equal(result.result.alert.member.length, 1)
  assert.equal(f.calls.find(call => call.method === 'PUT').body.alert.member[0].id, 989)
  assert.equal(f.calls.find(call => call.method === 'PUT').body.alert.member[0].date, '2027.02.01')
  const relative = await run('task reminder set', { ...base, personal: [{ anchor: 'start', offset: -15, unit: 'minute' }] }, f)
  assert.equal(relative.result.alert.personal[0].schedule, 'begin_-15_min')
  await run('task reminder set', { ...base, member: [{ date: '2027-02-02', time: '10:00', memberIds: ['81'] }] }, f)
  assert.equal(f.calls.filter(call => call.method === 'PUT').at(-1).body.alert.member.at(-1).date, '2027.02.02')
  await assert.rejects(run('task reminder set', { ...base, member: [{ date: '2027-02-01', time: '10:00', memberIds: ['82'] }] }, f), { code: 'INVALID_INPUT' })
})
test('recurrence is built from business options, copied content is explicit, and unsupported contexts are rejected', async () => {
  const f = fixture()
  const result = await run('task repeat set', { ...base, rule: { frequency: 'monthly', startDate: '2027-02-01', weekdays: ['MO','TU','WE','TH','FR'], positions: [-1], count: 2, excludeHolidays: true }, copy: ['note','field'] }, f)
  assert.ok(result.result.rrule.includes('BYSETPOS=-1'))
  assert.ok(result.result.rrule.includes('X-RSQ-EXRULE:BYTYPE=HOLIDAY'))
  assert.deepEqual(result.result.rruleContent, ['note','field'])
  await run('task repeat clear', base, f)
  assert.equal(f.task().rrule, null)
  assert.equal(Object.hasOwn(f.calls.filter(call => call.method === 'PUT').at(-1).body, 'rruleType'), false, 'noRepeat is not a backend enum; an explicit null rrule clears the rule')
  for (const task of [{ taskId: 'parent' }, { from: { projectId: 7001, type: 'workflow' } }]) await assert.rejects(run('task repeat set', { ...base, rule: { frequency: 'daily', startDate: '2027-02-01' } }, fixture({ task })), { code: 'INVALID_INPUT' })
})
test('subtasks bind their actual parent and creation failures are never replayed', async () => {
  const f = fixture()
  const created = await run('task subtask create', { ...base, name: '子任务' }, f)
  assert.equal(created.result.taskId, 'task-1')
  const denied = fixture({ permissions: { editSubTask: false } })
  await assert.rejects(run('task subtask create', { ...base, name: '子任务' }, denied), { code: 'FORBIDDEN' })
  let writes = 0
  const transport = async (url, init) => { if (init.method === 'POST') { writes++; throw new Error('network result unknown') } return f.transport(url, init) }
  await assert.rejects(runWorkflow(ctx, workflows.workflows.find(flow => flow.command === 'task subtask create'), { ...base, name: 'one' }, session, { transport, approved: true }), error => error.details.writeOutcome === 'unknown')
  assert.equal(writes, 1)
})
test('eventually consistent deletion waits on bounded reads, never repeats DELETE and rejects polling on writes before dispatch', async () => {
  const f = fixture(), flow = structuredClone(workflows.workflows.find(flow => flow.command === 'task remove'))
  flow.steps.at(-1).readback = { attempts: 3, delayMs: 50 }
  let reads = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/recycleBin/list') && ++reads < 3) return json([])
    return f.transport(url, init)
  }
  const result = await runWorkflow(ctx, flow, base, session, { transport, approved: true })
  assert.equal(result.result.removedTaskId, base.taskId)
  assert.equal(reads, 3)
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1)
  const invalid = structuredClone(workflows.workflows.find(flow => flow.command === 'task change'))
  invalid.steps.find(step => step.id === 'changed').readback = { attempts: 3, delayMs: 50 }
  let requests = 0
  await assert.rejects(runWorkflow(ctx, invalid, { ...base, patch: { name: 'new' } }, session, { transport: async () => { requests++; return json({}) }, approved: true }), { code: 'INVALID_CONTRACT' })
  assert.equal(requests, 0)
})
