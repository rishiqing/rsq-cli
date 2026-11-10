import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { validateProjectCardBatchWorkflow } from '../dist/project-card-batch.js'
import { prepareTaskTemplate } from '../dist/task-template.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure', 'https://www.rishiqing.com'); session.cookies = jar.serializeSync()
const root = { projectId: '7001', moduleId: '7101', cardId: '7301' }, response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const grant = { createTask: true, copyTask: true, moveTask: true, addTaskMember: true, removeTaskMember: true, editIsOpenToMember: true, editTaskDate: true, editTaskPriority: true, editTaskLabel: true, selectTaskLabel: true, finishTask: true, archiveTask: true, archiveKanbanCard: true }
function fixture(options = {}) {
  const calls = [], writes = [], records = [], originals = Array.from({ length: options.many ? 201 : 2 }, (_, index) => 'task-' + index)
  const tasks = new Map([...originals.map((id, index) => [id, { id, name: 'owned-task-' + index, note: '<p>body-' + index + '</p>', from: { type: 'project', projectId: '7001', planId: '7101' }, cardId: '7301', taskId: null, members: [{ id: '81' }], participants: [], responsibilityId: null, realStartDate: null, realEndDate: null, priorityV2: 2, isDone: true, forbidEdit: false, taskTemplate: { isMilepost: options.milestone === true } }]), ['destination-existing', { id: 'destination-existing', name: 'existing', cardId: '7302', from: { type: 'project', projectId: '7001', planId: '7101' }, members: [{ id: '81' }] }]])
  const comments = new Map(), projectLabel = { id: '7801', type: 'project', name: 'owned-label', color: 3 }, personalLabel = { id: '7801', type: 'todo', name: 'own-personal-label', color: 4 }
  originals.forEach((id, index) => Object.assign(tasks.get(id), options.initialDates?.[index] ?? {}, options.repeat ? { rrule: 'FREQ=DAILY' } : {}))
  originals.forEach((id, index) => Object.assign(tasks.get(id), options.initialLabels ? { labelList: options.initialLabels[index] } : {}, options.initialMembers ? { members: options.initialMembers[index].map(id => ({ id })) } : {}, options.principal ? { responsibilityId: options.principal } : {}))
  if (options.tree) {
    tasks.get('task-0').hasSubTask = true
    tasks.get('task-0').labelList = [projectLabel]
    for (const [id, parent, nested] of [['child-a', 'task-0', true], ['grandchild-a', 'child-a', false], ['child-b', 'task-0', false]]) tasks.set(id, { ...structuredClone(tasks.get('task-0')), id, taskId: parent, cardId: null, name: id, note: '<p>' + id + '</p>', realStartDate: '2026-11-09', realEndDate: '2026-11-10', hasSubTask: nested, taskTemplate: { id: '7501' } })
    for (const [index, id] of ['task-0', 'child-a', 'grandchild-a', 'child-b'].entries()) comments.set(id, [{ id: String(9007199254740993n + BigInt(index)), content: '<p>same content</p>', creator: { id: '81' }, dateCreated: '2026-11-09 08:00:00', fileList: [{ id: '7901' }], gaodeList: [] }])
  }
  let copied = 0, commentCopied = 0, listReads = 0, commentReads = 0, fieldReads = 0, personalLabelReads = 0
  const transport = async (url, init) => {
    const path = url.pathname, body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method: init.method, body, planType: init.headers.get('Plan-Type') })
    if (path.endsWith('/authAjax')) return response({ success: true, id: '81', username: 'fixture', token: 'fixture', team: { id: options.changedIdentity ? '99' : '7', name: 'fixture' } })
    if (path.endsWith('/member/state/independent')) return response({ vt: 'fixture', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: 1, userLimit: options.overCapacity ? 0 : 2, mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return response(options.features ?? [])
    if (path.endsWith('/authorities/company/current')) return response({ useKanban: true })
    if (path.endsWith('/kanbanCrud')) return response({ id: url.searchParams.get('id'), coverId: init.headers.get('Plan-Type') === 'template' ? options.template ? '8001' : options.wrongKind ? '8002' : null : null, editControl: {} })
    if (path.endsWith('/v4/template')) return response({ id: '8001', name: 'owned-template', templateKanbanId: '7001', withEdit: options.editable !== false })
    if (path.endsWith('/kanbanChildCrud/list')) return response([{ id: '7101', name: 'tasks', type: 'task' }])
    if (path.endsWith('/kanbanChildCrud')) return response({ id: '7101', name: 'tasks', type: 'task' })
    if (path.endsWith('/kanbanCardCrud/list')) return response(['7301', '7302'].map(id => ({ id, name: id, editControl: {} })))
    if (path.endsWith('/cardEditControl')) return response({ ...grant, ...options.cardGrants })
    if (path.endsWith('/comment/list')) {
      const id = url.searchParams.get('taskId')
      if (id === 'task-0' && ++commentReads === 2 && options.commentDrift) comments.get(id)[0].content = 'changed before submitting'
      return response(comments.get(id) ?? [])
    }
    if (path.endsWith('/task/subs')) return response([...tasks.values()].filter(task => task.taskId === url.searchParams.get('taskId')).filter(task => !options.partiallyHiddenChildren || task.id !== 'child-b').map(task => ({ id: task.id })))
    if (path.endsWith('/kanbanLabel/list')) return response(options.foreignCopiedLabel ? [] : [...new Map([projectLabel, ...(tasks.get(url.searchParams.get('taskId'))?.labelList ?? [])].map(label => [label.type + ':' + label.id, label])).values()])
    if (path.endsWith('/todoLabel/userLabels')) { personalLabelReads++; return response([{ ...personalLabel, ...(options.labelDrift && personalLabelReads > 1 ? { name: 'concurrent rename' } : {}) }]) }
    if (path.endsWith('/projectTask/taskList')) {
      listReads++
      const found = [...tasks.values()].filter(task => task.cardId === body.key && !task.archived)
      if (options.duplicatePage && body.offset > 0) return response(found.slice(0, 1))
      if (options.contextDrift && listReads > 1 && body.key === '7301') found.reverse()
      return response(found.slice(body.offset, body.offset + body.max).map(task => ({ id: task.id, name: task.name, cardId: task.cardId })))
    }
    if (path.endsWith('/task/editcontrol')) return response({ taskId: url.searchParams.get('taskId'), module: 'project', siteId: '7001', editControl: { ...grant, ...(options.deniedTask === url.searchParams.get('taskId') ? { [options.deniedPermission ?? 'copyTask']: false } : {}) } })
    if (path.endsWith('/api/v3/task')) {
      if (init.method === 'PUT') {
        writes.push({ path, body })
        const task = tasks.get(body.id)
        if (!(options.skipLast && body.id === 'task-1')) {
          if (Object.hasOwn(body, 'memberIds')) task.members = body.memberIds ? body.memberIds.split(',').map(id => ({ id })) : []
          if (Object.hasOwn(body, 'kanbanLabelIds') || Object.hasOwn(body, 'todoLabelIds')) {
            const existing = task.labelList ?? []
            task.labelList = [['project', 'kanbanLabelIds', [projectLabel]], ['todo', 'todoLabelIds', [personalLabel]]].flatMap(([type, key, library]) => body[key] ? body[key].split(',').map(id => existing.find(label => label.type === type && label.id === id) ?? library.find(label => label.id === id)) : [])
          }
          for (const key of ['responsibilityId', 'isOpenToMember', 'realStartDate', 'realEndDate']) if (Object.hasOwn(body, key)) task[key] = body[key]
          if (options.utcDates) for (const key of ['realStartDate', 'realEndDate']) if (typeof task[key] === 'string' && task[key].includes('T')) task[key] = new Date(task[key]).toISOString()
          if (options.dateChangesOtherContent) task.note = 'unexpected change'
          if (options.batchChangesOtherContent) task.note = 'unexpected change'
        }
        if (options.timeout || options.timeoutTask === body.id) throw Error('Write outcome unknown')
        return response(task)
      }
      const task = tasks.get(url.searchParams.get('id'))
      const childCount = [...tasks.values()].filter(row => row.taskId === task.id).length
      return response({ ...task, subTaskNum: childCount, hasSubTask: childCount > 0, ...(options.foreignTask ? { from: { projectId: '9001', planId: '7101' } } : {}) })
    }
    if (path.endsWith('/api/v3/template')) return response({ id: '7501', name: 'actual-type', defaultValues: { priorityV2: options.copyPriority ?? 3 } })
    if (path.endsWith('/api/v3/task/template')) { fieldReads++; return response({ templateFields: options.fieldsDrift && fieldReads > 2 ? [{ id: '1', type: 1, isRequired: true, value: '' }] : options.fields ?? [] }) }
    if (path.endsWith('/scopes/company/current')) return response({ taskExecutorScope: ['81', '82', '9007199254740993'] })
    if (path.endsWith('/archiveBag/list')) return response([{ id: '7901', name: 'owned', teamId: '7', creatorId: '81', userRoles: [{ userId: '81', role: { id: '1', type: 'archiveCreator' } }], editControl: { allowArchiving: options.archiveAllowed !== false } }])
    if (path.endsWith('/archiveFile/list')) return response(records)
    if (/\/projectTask\/batch/.test(path)) {
      writes.push({ path, body }); assert.equal(body.currCardId, undefined)
      const selected = body.ids.split(',').map(id => tasks.get(id))
      for (const [index, task] of selected.entries()) {
        if (options.skipLast && index === selected.length - 1) continue
        if (path.endsWith('/batchCopy')) {
          const clone = (source, parent = null) => {
            const children = [...tasks.values()].filter(child => child.taskId === source.id), copiedTask = structuredClone(source)
            copiedTask.id = 'copy-' + copied++; copiedTask.taskId = parent; copiedTask.cardId = parent ? null : body.cardId; copiedTask.priorityV2 = options.copyPriority ?? 3; copiedTask.taskTemplate = { id: '7501' }; tasks.set(copiedTask.id, copiedTask)
            if (options.wrongParent && parent) copiedTask.taskId = 'foreign-parent'
            if (options.wrongLabels && parent) copiedTask.labelList = []
            if (options.wrongPrincipal) copiedTask.responsibilityId = '82'
            comments.set(copiedTask.id, options.missingComments ? [] : (comments.get(source.id) ?? []).map(comment => ({ ...structuredClone(comment), id: options.reusedCommentId ? comment.id : String(19001 + commentCopied++) })))
            if (!options.missingChild) for (const child of children) clone(child, copiedTask.id)
            else copiedTask.hasSubTask = false
          }
          clone(task)
        }
        else if (path.endsWith('/batchMove')) task.cardId = body.cardId
        else if (path.endsWith('/batchArchive')) { task.archived = true; records.push({ id: String(9001 + records.length), resourceId: task.id, type: 1, name: task.name }) }
        else if (path.endsWith('/batchRemoveMember')) {
          const removed = body.memberIds.split(',')
          if (removed.includes(task.responsibilityId)) throw Error('负责人必须是任务执行人')
          task.members = task.members.filter(member => !removed.includes(member.id))
        }
        else if (path.endsWith('/batchRemoveLabel')) task.labelList = (task.labelList ?? []).filter(label => !(body[label.type === 'project' ? 'kanbanLabelIds' : 'todoLabelIds'] ?? '').split(',').includes(label.id))
        else {
          // Independent server model: non-empty bulk input appends, not replaces.
          if (Object.hasOwn(body, 'memberIds')) task.members = body.memberIds ? [...new Set([...task.members.map(member => String(member.id)), ...body.memberIds.split(',')])].map(id => ({ id })) : []
          if (Object.hasOwn(body, 'kanbanLabelIds') || Object.hasOwn(body, 'todoLabelIds')) {
            const existing = task.labelList ?? []
            // Independent two-stage converter: null/empty passes through;
            // toLabelList then rebuilds the entire list and drops omitted source.
            task.labelList = [['project', 'kanbanLabelIds', [projectLabel]], ['todo', 'todoLabelIds', [personalLabel]]].flatMap(([type, key, library]) => {
              const selected = body[key] ? body[key].split(',') : []
              const ids = selected.length ? [...new Set([...existing.filter(label => label.type === type).map(label => label.id), ...selected])] : []
              return ids.map(id => existing.find(label => label.id === id && label.type === type) ?? library.find(label => label.id === id))
            })
          }
          for (const key of ['responsibilityId', 'isOpenToMember', 'realStartDate', 'realEndDate', 'priorityV2', 'isDone']) if (Object.hasOwn(body, key)) task[key] = body[key]
          // Actual bulk converter: a lone null date clears both endpoints.
          if (Object.hasOwn(body, 'realStartDate') !== Object.hasOwn(body, 'realEndDate') && (body.realStartDate === null || body.realEndDate === null)) task.realStartDate = task.realEndDate = null
          if (options.utcDates) for (const key of ['realStartDate', 'realEndDate']) if (typeof task[key] === 'string' && task[key].includes('T')) task[key] = new Date(task[key]).toISOString()
        }
        if (options.batchChangesOtherContent) task.note = 'unexpected change'
      }
      if (options.timeout) throw Error('Response lost after accepting a batch')
      return response(['/batchCopy', '/batchUpdate', '/batchRemoveMember', '/batchRemoveLabel'].some(suffix => path.endsWith(suffix)) ? null : body.ids.split(','))
    }
    throw Error('Unexpected HTTP ' + path)
  }
  return { transport, writes, calls, tasks, records }
}
const run = async (action, input = {}, options = {}) => {
  const server = fixture(options), command = 'project ' + (options.template ? 'template ' : '') + 'card tasks ' + action, flow = workflows.workflows.find(flow => flow.command === command)
  assert.ok(flow, command)
  try { return { server, result: await runWorkflow(ctx, flow, { ...root, ...(action === 'inspect' ? {} : { taskIds: ['task-0', 'task-1'] }), ...input }, session, { approved: options.approved !== false, dryRun: options.dryRun, transport: server.transport }) } } catch (error) { error.fixture = server; error.message += ' ' + JSON.stringify(error.details); throw error }
}
test('ordinary and template batches freeze selected IDs and independently verify actual copied tasks', async () => {
  for (const template of [false, true]) {
    const { server, result } = await run('copy', { targetCardId: '7302' }, { template })
    assert.equal(server.writes.length, 1); assert.deepEqual(result.resources.createdTaskIds, ['copy-0', 'copy-1'])
    assert.equal(result.result.verified.length, 2)
    assert.ok(result.result.verified.every(row => row.priorityV2 === 3)); assert.equal(server.tasks.get('task-0').priorityV2, 2)
    assert.ok(server.calls.filter(call => call.path.startsWith('/task/v1/')).every(call => call.planType === (template || call.path.endsWith('/kanbanCrud') ? 'template' : null)))
    assert.ok(server.calls.filter(call => call.path.startsWith('/task/api/')).every(call => call.planType === null))
    assert.equal(server.tasks.get('task-0').cardId, '7301'); assert.equal(server.tasks.get('destination-existing').cardId, '7302')
  }
})
test('batch copies use the actual destination type default rather than an assumed global priority', async () => {
  const { result } = await run('copy', { targetCardId: '7302' }, { copyPriority: 4 })
  assert.ok(result.result.verified.every(row => row.priorityV2 === 4))
})
test('ordinary and template copies prove comments, exact long IDs, labels and ordered grandchildren by independent HTTP', async () => {
  for (const template of [false, true]) {
    const { result, server } = await run('copy', { targetCardId: '7302' }, { tree: true, template })
    assert.equal(result.result.copyProof.length, 5)
    assert.equal(result.resources.createdDescendantTaskIds.length, 3)
    assert.equal(result.result.copyProof.filter(row => row.commentCount === 1).length, 4)
    assert.equal(result.result.copyProof.find(row => row.sourceTaskId === 'grandchild-a').parentTaskId, result.result.copyProof.find(row => row.sourceTaskId === 'child-a').taskId)
    assert.ok(server.calls.filter(call => call.path.endsWith('/comment/list') || call.path.endsWith('/task/subs')).every(call => call.planType === null))
    assert.ok(server.calls.some(call => call.path.endsWith('/kanbanLabel/list') && call.planType === (template ? 'template' : null)))
    assert.equal(server.writes.length, 1)
  }
})
test('dropped descendants, lost comments, reused comment IDs and foreign or missing labels cannot pass a copy', async () => {
  for (const failure of ['missingChild', 'missingComments', 'reusedCommentId', 'wrongLabels', 'foreignCopiedLabel', 'wrongParent', 'wrongPrincipal']) await assert.rejects(run('copy', { targetCardId: '7302' }, { tree: true, [failure]: true }), error => {
    assert.ok(['BUSINESS_ASSERTION_FAILED', 'CONTEXT_MISSING'].includes(error.code), error.code)
    assert.equal(error.fixture.writes.length, 1); assert.equal(error.details.writeOutcome, 'accepted-needs-verification'); assert.ok(error.details.resources.createdTaskIds.length)
    return true
  })
})
test('source comments are re-read before submitting and concurrent change prevents any copy', async () => {
  await assert.rejects(run('copy', { targetCardId: '7302' }, { tree: true, commentDrift: true }), error => { assert.equal(error.code, 'CONTEXT_CONFLICT'); assert.equal(error.fixture.writes.length, 0); return true })
})
test('move verifies real card membership for each original ID rather than returned IDs', async () => {
  for (const template of [false, true]) {
    const { server } = await run('move', { targetCardId: '7302' }, { template }); assert.equal(server.tasks.get('task-0').cardId, '7302'); assert.equal(server.writes.length, 1)
    await assert.rejects(run('move', { targetCardId: '7302' }, { template, skipLast: true }), error => { assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.fixture.writes.length, 1); assert.equal(error.details.writeOutcome, 'accepted-needs-verification'); return true })
  }
})
test('batch member replacement, exact long IDs, explicit clearing and date clearing read back in both contexts', async () => {
  for (const template of [false, true]) {
    const member = await run('members set', { memberIds: ['9007199254740993'], principalId: '9007199254740993', isOpenToMember: true }, { template }); assert.equal(member.server.writes[0].body.memberIds, '9007199254740993')
    const cleared = await run('members set', { memberIds: [], principalId: null, isOpenToMember: false }, { template }); assert.equal(cleared.server.writes[0].body.memberIds, ''); assert.equal(cleared.result.result.verified[0].responsibilityId, null)
    const date = await run('dates set', { dates: { start: '2026-11-09', end: '2026-11-10' } }, { template }); assert.equal(date.server.writes[0].body.realStartDate, '2026-11-09')
    const empty = await run('dates set', { dates: { start: null, end: null } }, { template }); assert.equal(empty.server.writes[0].body.realEndDate, null)
  }
})
test('sparse date changes preserve each task own omitted endpoint, including one-sided clearing', async () => {
  const initialDates = [{ realStartDate: '2026-11-08', realEndDate: '2026-11-10' }, { realStartDate: '2026-11-07', realEndDate: '2026-11-11' }]
  for (const template of [false, true]) for (const dates of [{ start: null }, { end: null }, { start: '2026-11-09' }, { end: '2026-11-12' }]) {
    const { result, server } = await run('dates set', { dates }, { template, initialDates })
    assert.equal(server.writes.length, 2)
    for (const [index, actual] of result.result.verified.entries()) {
      const expected = { realStartDate: Object.hasOwn(dates, 'start') ? dates.start : initialDates[index].realStartDate, realEndDate: Object.hasOwn(dates, 'end') ? dates.end : initialDates[index].realEndDate }
      assert.equal(actual.realStartDate, expected.realStartDate); assert.equal(actual.realEndDate, expected.realEndDate)
      assert.equal(server.writes[index].path, '/task/api/v3/task')
      assert.deepEqual(server.writes[index].body, { id: 'task-' + index, module: 'project', siteId: '7001', ...expected })
      assert.equal(actual.note, '<p>body-' + index + '</p>'); assert.equal(actual.priorityV2, 2)
    }
  }
})
test('date writes stop on unexpected other-field changes or later lost outcomes and do not silently modify repeat rules', async () => {
  await assert.rejects(run('dates set', { dates: { start: null } }, { dateChangesOtherContent: true }), error => { assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.fixture.writes.length, 1); return true })
  await assert.rejects(run('dates set', { dates: { start: null } }, { repeat: true }), error => { assert.equal(error.code, 'INVALID_INPUT'); assert.equal(error.fixture.writes.length, 0); return true })
  await assert.rejects(run('dates set', { dates: { start: '2026-11-09' } }, { timeoutTask: 'task-1' }), error => {
    assert.equal(error.details.writeOutcome, 'unknown'); assert.equal(error.fixture.writes.length, 2)
    assert.deepEqual(error.details.resources.mutatedTaskIds, ['task-0']); assert.deepEqual(error.details.resources.verifiedTaskIds, ['task-0']); assert.equal(error.details.resources.currentTaskId, 'task-1')
    return true
  })
})
test('archive-completed verifies unique real bag records and source removal and remains unavailable for templates', async () => {
  const { result, server } = await run('archive-completed', { bagId: '7901' }); assert.equal(result.resources.archiveRecordIds.length, 2); assert.equal(server.writes.length, 1)
  assert.equal(workflows.workflows.some(flow => flow.command === 'project template card tasks archive-completed'), false)
  await assert.rejects(run('archive-completed', { bagId: '7901' }, { archiveAllowed: false }), error => { assert.equal(error.fixture.writes.length, 0); return true })
})
test('batch priority and completion distinguish false and zero and require every task, card and current field context', async () => {
  for (const template of [false, true]) {
    const priority = await run('priority set', { priority: 4 }, { template })
    assert.equal(priority.server.writes.length, 1)
    assert.ok(priority.result.result.verified.every(row => row.priorityV2 === 4))
    const reopened = await run('status set', { done: false }, { template })
    assert.equal(reopened.server.writes[0].body.isDone, false)
    assert.ok(reopened.result.result.verified.every(row => row.isDone === false))
    const completed = await run('status set', { done: true }, { template, fields: [{ id: '1', type: 2, isRequired: true, value: 0 }] })
    assert.ok(completed.result.result.verified.every(row => row.isDone === true))
  }
  for (const [action, input, options, code] of [
    ['priority set', { priority: 2 }, { deniedTask: 'task-1', deniedPermission: 'editTaskPriority' }, 'FORBIDDEN'],
    ['status set', { done: true }, { cardGrants: { finishTask: false } }, 'FORBIDDEN'],
    ['status set', { done: true }, { fields: [{ id: '1', type: 1, isRequired: true, value: '' }] }, 'INVALID_INPUT'],
    ['status set', { done: true }, { fieldsDrift: true }, 'CONTEXT_CONFLICT'],
  ]) await assert.rejects(run(action, input, options), error => { assert.equal(error.code, code); assert.equal(error.fixture.writes.length, 0); return true })
  await assert.rejects(run('priority set', { priority: 4 }, { skipLast: true }), error => { assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.fixture.writes.length, 1); return true })
})
test('zoned date assertions compare instants while milestone ranges still obey the single-date UI rule', async () => {
  const { result } = await run('dates set', { dates: { start: '2026-11-09T09:00:00+08:00', end: '2026-11-09T10:00:00+08:00' } }, { utcDates: true })
  assert.equal(result.result.verified[0].realStartDate, '2026-11-09T01:00:00.000Z')
  await assert.rejects(run('dates set', { dates: { start: '2026-11-09', end: '2026-11-10' } }, { milestone: true }), error => { assert.equal(error.code, 'INVALID_INPUT'); assert.equal(error.fixture.writes.length, 0); return true })
})
test('visible catalog pagination is complete before explicit selection and duplicate pages fail before writes', async () => {
  const { server } = await run('copy', { targetCardId: '7302' }, { many: true }); assert.ok(server.calls.some(call => call.body?.offset === 200)); assert.equal(server.writes[0].body.ids, 'task-0,task-1')
  await assert.rejects(run('copy', { targetCardId: '7302' }, { many: true, duplicatePage: true }), error => { assert.equal(error.code, 'CONTEXT_CONFLICT'); assert.equal(error.fixture.writes.length, 0); return true })
  await assert.rejects(run('copy', { taskIds: undefined, allVisible: true, targetCardId: '7302' }, { many: true }), error => { assert.equal(error.fixture.writes.length, 0); return true })
})
test('per-task permission, scope, foreign resources and readonly templates stop the entire batch before writing', async () => {
  for (const options of [{ deniedTask: 'task-1' }, { foreignTask: true }, { wrongKind: true }, { template: true, editable: false }, { cardGrants: { createTask: false } }]) await assert.rejects(run('copy', { targetCardId: '7302' }, options), error => { assert.equal(error.fixture.writes.length, 0); return true })
  for (const input of [{ memberIds: ['99'] }, { memberIds: [], principalId: '81' }]) await assert.rejects(run('members set', input), error => { assert.equal(error.fixture.writes.length, 0); return true })
  await assert.rejects(run('dates set', { dates: { start: '2026-11-10', end: '2026-11-09' } }), error => { assert.equal(error.fixture.writes.length, 0); return true })
})
test('stale versions, changed preflight, expiry, over-capacity and disabled features prevent batch side effects', async () => {
  for (const options of [{ contextDrift: true }, { expired: true }, { overCapacity: true }, { features: [{ funcName: 'PLAN', status: 'disable' }] }]) await assert.rejects(run('copy', { targetCardId: '7302' }, options), error => { assert.equal(error.fixture.writes.length, 0); return true })
  await assert.rejects(run('copy', { targetCardId: '7302', expectedContextVersion: '0'.repeat(64) }), error => { assert.equal(error.code, 'CONTEXT_CONFLICT'); assert.equal(error.fixture.writes.length, 0); return true })
})
test('silent server skipping and unknown outcomes never replay the batch and preserve explicit resource IDs', async () => {
  for (const [action, input] of [['copy', { targetCardId: '7302' }], ['members set', { memberIds: ['82'] }], ['dates set', { dates: { start: '2026-11-09' } }]]) {
    for (const options of [{ skipLast: true }, { timeout: true }]) await assert.rejects(run(action, input, options), error => { assert.equal(error.fixture.writes.length, ['members set','dates set'].includes(action) && !options.timeout ? 2 : 1); assert.deepEqual(error.details.resources.taskIds, ['task-0', 'task-1']); assert.equal(error.details.automaticallyRetried, false); assert.equal(error.details.writeOutcome, options.timeout ? 'unknown' : 'accepted-needs-verification'); return true })
  }
})
test('literal member replacement does not inherit the bulk append behavior and preserves verified progress on a later unknown write', async () => {
  for (const template of [false, true]) {
    const result = await run('members set', { memberIds: ['82'], principalId: '82' }, { template })
    assert.deepEqual(result.server.writes.map(row => row.body.id), ['task-0', 'task-1'])
    assert.ok(result.server.writes.every(row => row.path === '/task/api/v3/task' && row.body.ids === undefined))
    assert.ok(result.result.result.verified.every(row => row.members.length === 1 && String(row.members[0].id) === '82'))
    assert.deepEqual(result.result.resources.mutatedTaskIds, ['task-0', 'task-1'])
  }
  await assert.rejects(run('members set', { memberIds: ['82'] }, { timeoutTask: 'task-1' }), error => {
    assert.equal(error.fixture.writes.length, 2)
    assert.equal(error.details.writeOutcome, 'unknown')
    assert.deepEqual(error.details.resources.mutatedTaskIds, ['task-0'])
    assert.deepEqual(error.details.resources.verifiedTaskIds, ['task-0'])
    assert.equal(error.details.resources.currentTaskId, 'task-1')
    return true
  })
})
test('member addition preserves existing executors and principal; removal subtracts rather than replacing', async () => {
  for (const template of [false, true]) {
    const added = await run('members add', { memberIds: ['82', '9007199254740993'] }, { template, principal: '81' })
    assert.equal(added.server.writes.length, 1)
    assert.equal(added.server.writes[0].path, '/task/api/v3/projectTask/batchUpdate')
    assert.ok(added.result.result.verified.every(task => task.members.map(member => String(member.id)).sort().join(',') === ['81', '82', '9007199254740993'].sort().join(',') && task.responsibilityId === '81'))
    const removed = await run('members remove', { memberIds: ['82'] }, { template, initialMembers: [['81', '82'], ['81', '82']], principal: '81' })
    assert.equal(removed.server.writes.length, 1)
    assert.equal(removed.server.writes[0].path, '/task/api/v3/projectTask/batchRemoveMember')
    assert.ok(removed.result.result.verified.every(task => task.members.length === 1 && task.members[0].id === '81' && task.responsibilityId === '81'))
  }
  for (const [action, input, options] of [['members add', { memberIds: ['99'] }, {}], ['members remove', { memberIds: ['81'] }, { principal: '81' }], ['members remove', { memberIds: ['81'] }, { deniedTask: 'task-1', deniedPermission: 'removeTaskMember' }]]) await assert.rejects(run(action, input, options), error => { assert.equal(error.fixture.writes.length, 0); return true })
})
const mixedLabels = [
  [{ id: '7801', type: 'project', name: 'owned-label', color: 3 }, { id: '9901', type: 'todo', name: 'foreign-personal-kept', color: 5 }],
  [{ id: '7801', type: 'todo', name: 'own-personal-label', color: 4 }, { id: '9902', type: 'project', name: 'foreign-project-kept', color: 6 }],
]
const keys = labels => labels.map(label => label.type + ':' + label.id).sort()
test('label addition resolves both complete categories per task and preserves foreign labels and same-number source identities', async () => {
  for (const template of [false, true]) for (const type of ['project', 'todo']) {
    const { server, result } = await run('labels add', { labels: [{ id: '7801', type }] }, { template, initialLabels: mixedLabels })
    assert.equal(server.writes.length, 2)
    assert.ok(server.writes.every(row => row.path === '/task/api/v3/task' && row.body.ids === undefined && Object.hasOwn(row.body, 'kanbanLabelIds') && Object.hasOwn(row.body, 'todoLabelIds')))
    for (const [index, row] of server.writes.entries()) assert.equal(row.body[type === 'project' ? 'todoLabelIds' : 'kanbanLabelIds'], mixedLabels[index].filter(label => label.type !== type).map(label => label.id).join(','))
    for (const [index, task] of result.result.verified.entries()) assert.deepEqual(keys(task.labelList), [...new Set([...keys(mixedLabels[index]), type + ':7801'])].sort())
  }
  const both = await run('labels add', { labels: [{ id: '7801', type: 'project' }, { id: '7801', type: 'todo' }] }, { initialLabels: mixedLabels })
  assert.ok(both.result.result.verified.every(task => keys(task.labelList).includes('project:7801') && keys(task.labelList).includes('todo:7801')))
})
test('bulk label removal uses typed difference; explicit clearing empties both categories only after confirmation', async () => {
  for (const template of [false, true]) {
    const removed = await run('labels remove', { labels: [{ id: '7801', type: 'project' }] }, { template, initialLabels: mixedLabels })
    assert.equal(removed.server.writes[0].path, '/task/api/v3/projectTask/batchRemoveLabel')
    assert.deepEqual(keys(removed.result.result.verified[0].labelList), ['todo:9901'])
    assert.deepEqual(keys(removed.result.result.verified[1].labelList), keys(mixedLabels[1]))
    const cleared = await run('labels clear', {}, { template, initialLabels: mixedLabels })
    assert.equal(cleared.server.writes[0].body.kanbanLabelIds, ''); assert.equal(cleared.server.writes[0].body.todoLabelIds, '')
    assert.ok(cleared.result.result.verified.every(task => task.labelList.length === 0))
  }
  for (const action of ['labels clear', 'labels remove', 'members remove']) await assert.rejects(run(action, action === 'labels remove' ? { labels: [{ id: '7801', type: 'project' }] } : action === 'members remove' ? { memberIds: ['81'] } : {}, { approved: false }), error => { assert.equal(error.code, 'CONFIRMATION_REQUIRED'); assert.equal(error.fixture.calls.length, 0); return true })
})
test('bulk label scope, catalog drift and actual card/task permission names fail before any write', async () => {
  for (const options of [{ labelDrift: true }, { cardGrants: { selectTaskLabel: false } }, { deniedTask: 'task-1', deniedPermission: 'editTaskLabel' }, { template: true, editable: false }]) await assert.rejects(run('labels add', { labels: [{ id: '7801', type: 'project' }] }, options), error => { assert.equal(error.fixture.writes.length, 0); return true })
  await assert.rejects(run('labels add', { labels: [{ id: '9901', type: 'todo' }] }, { initialLabels: mixedLabels }), error => { assert.equal(error.code, 'FORBIDDEN'); assert.equal(error.fixture.writes.length, 0); return true })
})
test('bulk add/remove/clear detect skipped writes and unrelated changes, preserve verified IDs and never replay unknown results', async () => {
  for (const [action, input, options] of [['members add', { memberIds: ['82'] }, {}], ['members remove', { memberIds: ['82'] }, { initialMembers: [['81', '82'], ['81', '82']] }], ['labels add', { labels: [{ id: '7801', type: 'project' }] }, { initialLabels: mixedLabels }], ['labels remove', { labels: [{ id: '7801', type: 'todo' }] }, { initialLabels: mixedLabels }], ['labels clear', {}, { initialLabels: mixedLabels }]]) {
    for (const failure of [{ skipLast: true }, { timeout: true }, { batchChangesOtherContent: true }]) await assert.rejects(run(action, input, { ...options, ...failure }), error => {
      assert.equal(error.fixture.writes.length, action === 'labels add' && failure.skipLast ? 2 : 1); assert.equal(error.details.automaticallyRetried, false)
      assert.deepEqual(error.details.resources.taskIds, ['task-0', 'task-1'])
      assert.equal(error.details.writeOutcome, failure.timeout ? 'unknown' : 'accepted-needs-verification')
      if (failure.skipLast) assert.deepEqual(error.details.resources.verifiedTaskIds, ['task-0'])
      return true
    })
  }
})
test('new bulk commands have executable offline plans while malformed empty selections send no HTTP', async () => {
  for (const [action, input] of [['members add', { memberIds: ['82'] }], ['members remove', { memberIds: ['81'] }], ['labels add', { labels: [{ id: '7801', type: 'project' }] }], ['labels remove', { labels: [{ id: '7801', type: 'todo' }] }], ['labels clear', {}]]) {
    const { server, result } = await run(action, input, { dryRun: true }); assert.equal(result.dryRun, true); assert.equal(server.calls.length, 0)
  }
  for (const [action, input] of [['members add', { memberIds: [] }], ['members remove', { memberIds: [] }], ['labels add', { labels: [] }], ['labels remove', { labels: [] }]]) await assert.rejects(run(action, input), error => { assert.equal(error.fixture.calls.length, 0); return true })
})
test('label addition verifies each complete replacement before the next item and reports a later lost write', async () => {
  await assert.rejects(run('labels add', { labels: [{ id: '7801', type: 'project' }] }, { initialLabels: mixedLabels, timeoutTask: 'task-1' }), error => {
    assert.equal(error.fixture.writes.length, 2)
    assert.deepEqual(error.details.resources.mutatedTaskIds, ['task-0'])
    assert.deepEqual(error.details.resources.verifiedTaskIds, ['task-0'])
    assert.equal(error.details.resources.currentTaskId, 'task-1')
    assert.equal(error.details.writeOutcome, 'unknown'); assert.equal(error.details.automaticallyRetried, false)
    return true
  })
})
test('native member and label removal cannot bypass business context or execute HTTP during dry-run', async () => {
  for (const suffix of ['RemoveMember', 'RemoveLabel']) {
    const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/api/v3/projectTask/batch' + suffix), server = fixture()
    assert.ok(op)
    const input = { body: { ids: 'task-0', module: 'project', siteId: '7001', ...(suffix === 'RemoveMember' ? { memberIds: '81' } : { kanbanLabelIds: '7801' }) } }
    await assert.rejects(executeOperation(ctx, op, input, session, { approved: true, transport: server.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
    await executeOperation(ctx, op, input, session, { approved: true, transport: server.transport, dryRun: true })
    assert.equal(server.calls.length, 0)
  }
})
test('offline plans send zero HTTP, destructive calls require confirmation and fixed executor contracts reject route tampering', async () => {
  const { server, result } = await run('move', { targetCardId: '7302' }, { dryRun: true }); assert.equal(result.dryRun, true); assert.equal(server.calls.length, 0)
  await assert.rejects(run('move', { targetCardId: '7302' }, { approved: false }), error => { assert.equal(error.code, 'CONFIRMATION_REQUIRED'); assert.equal(error.fixture.calls.length, 0); return true })
  const flow = structuredClone(workflows.workflows.find(flow => flow.command === 'project card tasks copy')); flow.steps.at(-1).operationId = flow.steps[0].operationId; assert.throws(() => validateProjectCardBatchWorkflow(flow), { code: 'INVALID_CONTRACT' })
})
test('card creation and rename enforce the actual eighty UTF-16 unit storage boundary', () => {
  for (const action of ['card-create', 'card-rename']) {
    for (const name of ['a'.repeat(81), '😀'.repeat(41), '   ']) assert.throws(() => prepareTaskTemplate('task-context-' + action, { ...root, name }, {}), { code: 'INVALID_INPUT' })
    const results = { project: { id: '7001', coverId: null }, modules: [{ id: '7101', type: 'task' }], moduleDetail: { id: '7101', editControl: { createKanbanCard: true } }, cards: [{ id: '7301', editControl: { editKanbanCardName: true } }] }
    for (const name of ['a'.repeat(80), '😀'.repeat(40)]) assert.equal(prepareTaskTemplate('task-context-' + action, { ...root, name }, results).body.name, name)
  }
})

test('ordinary and template copies refuse a nonempty but partially hidden subtree before mutation', async () => {
 for (const template of [false, true]) await assert.rejects(run('copy', { targetCardId: '7302' }, { tree: true, template, partiallyHiddenChildren: true }), error => {
  assert.equal(error.code, 'CONTEXT_MISSING'); assert.equal(error.fixture.writes.length, 0); return true
 })
})
