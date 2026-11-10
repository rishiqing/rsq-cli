import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { taskTypeTransitionPlan, verifyTaskTypeTransition, validateTaskTypeTransitionWorkflow, taskTypeDefinitionContext } from '../dist/task-type-transition.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeWorkflow } from '../dist/dispatch.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure', 'https://www.rishiqing.com'); session.cookies = jar.serializeSync()
test('definition comparison ignores only same-service transient default-file signatures and retains identity and configuration', () => {
  const origin = 'https://www.rishiqing.com', make = signature => ({ fields: [{ id: '7501', type: 6, defaultFileList: [{ id: '7801', name: 'guide', size: 10, realPath: origin + '/task/v1/folder/file/url?signature=' + signature }] }] })
  const first = make('first'), second = make('second')
  assert.deepEqual(taskTypeDefinitionContext(first, origin), taskTypeDefinitionContext(second, origin)); assert.ok(first.fields[0].defaultFileList[0].realPath.includes('first'))
  for (const [key, value] of [['id', '7802'], ['name', 'changed'], ['size', 11], ['realPath', origin + '/task/v1/folder/file/url?signature=second&version=2'], ['realPath', 'https://other.example/task/v1/folder/file/url?signature=second'], ['realPath', origin + '/task/other?signature=second']]) {
    const changed = make('second'); changed.fields[0].defaultFileList[0][key] = value
    assert.notDeepEqual(taskTypeDefinitionContext(first, origin), taskTypeDefinitionContext(changed, origin))
  }
})
const base = () => ({ id: 'task-one', name: 'keep name', note: '<p>keep content</p>', from: { projectId: '7001', planId: '7101' }, cardId: '7301', taskId: null, taskTemplate: { id: '7401', isMilepost: false }, members: [{ id: '81' }], participants: [], responsibilityId: '81', labelList: [], priorityV2: 2, progress: 0, isDone: false, isClose: false, realStartDate: null, realEndDate: null, hasSubTask: false, subTaskNum: 0, forbidEdit: false })
const definition = () => ({ id: '7402', name: 'target', isMilepost: false, type: 'kanban', fields: [{ id: '7502', type: 1, name: 'target field' }], defaultValues: {}, auths: { elements: [] } })
const fields = (templateId = '7401', fieldId = '7501') => ({ taskTemplate: { id: templateId, isMilepost: false }, templateFields: [{ id: fieldId, name: 'text', type: 1, value: 'stored text', isHidden: false, editControl: { canEdit: true } }] })
const input = { projectId: '7001', taskId: 'task-one', templateId: '7402' }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = command => workflows.workflows.find(row => row.command === command)
function fixture(options = {}) {
  const task = Object.assign(base(), structuredClone(options.before ?? {})), target = Object.assign(definition(), structuredClone(options.definition ?? {})), calls = [], writes = []
  let definitionReads = 0, permissionReads = 0
  const transport = async (url, init) => {
    const path = url.pathname, body = typeof init.body === 'string' ? JSON.parse(init.body) : null; calls.push({ path, method: init.method, body })
    if (path.endsWith('/authAjax')) return json({ success: true, id: '81', username: 'fixture', token: 'fixture', team: { id: options.changedIdentity ? '8' : '7', name: 'fixture' } })
    if (path.endsWith('/member/state/independent')) return json({ vt: 'fixture', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: 1, userLimit: options.capacity ? 0 : 2, mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json(options.features ?? [])
    if (path.endsWith('/authorities/company/current')) return json({ useKanban: true })
    if (path.endsWith('/kanbanCrud')) { assert.equal(init.headers.get('Plan-Type'), 'template'); return json({ id: '7001', coverId: options.template ? '8001' : null }) }
    if (path.endsWith('/v4/template')) return json({ id: '8001', name: 'owned', templateKanbanId: options.wrongCover ? '7999' : '7001', withEdit: options.editable !== false })
    if (path.endsWith('/task/editcontrol')) { permissionReads++; return json({ taskId: options.wrongPermissions ? 'other-task' : 'task-one', module: 'project', siteId: '7001', editControl: { modifyTaskType: options.denied ? false : !(options.revoked && permissionReads > 1) } }) }
    if (path.endsWith('/template/listByTask')) return json(options.unavailable ? [] : [{ id: '7401', isStop: false }, { id: '7402', isStop: options.stopped === true }])
    if (path.endsWith('/v3/template')) { definitionReads++; return json({ ...target, ...(options.definitionDrift && definitionReads > 1 ? { name: 'concurrent reconfiguration' } : {}) }) }
    if (path.endsWith('/task/template')) return json(task.taskTemplate.id === '7401' ? fields() : fields('7402', '7502'))
    if (path.endsWith('/scopes/company/current')) return json({ taskExecutorScope: options.scope ?? ['81', '82'] })
    if (path.endsWith('/kanbanLabel/list')) return json(options.labels ?? [{ id: '91', type: 'project', name: 'allowed', color: 1 }])
    if (path.endsWith('/v3/task') && init.method === 'GET') return json(task)
    if (path.endsWith('/v3/task') && init.method === 'PUT') {
      writes.push(body); if (options.timeout) throw new TypeError('simulated response lost after sending')
      assert.deepEqual(body, { id: 'task-one', taskTemplateId: '7402', module: 'project', siteId: '7001' })
      Object.assign(task, options.after ?? {}, { taskTemplate: { id: '7402', isMilepost: target.isMilepost } })
      if (options.corrupt) task.note = 'unexpected overwrite'
      return json(task)
    }
    throw Error('Unexpected HTTP ' + path)
  }
  return { task, target, calls, writes, transport }
}
test('type transition preserves populated values and does not reuse task creation defaults', () => {
  const task = { ...base(), participants: [{ id: '82' }], labelList: [{ id: '91', type: 'project', name: 'allowed', color: 1 }], realStartDate: '2026-11-03', realEndDate: '2026-11-07' }, target = { ...definition(), defaultValues: { member: { memberIds: '99', responsibilityId: '99' }, participantsIds: '98', label: { kanbanLabelIds: '97' }, date: { realStartDate: '2099-01-01' }, note: 'must not apply', priorityV2: 4, subtasks: [{ name: 'must not create' }] } }
  const plan = taskTypeTransitionPlan(task, target)
  assert.deepEqual(plan.appliedDefaults, []); assert.deepEqual(plan.expected.members, ['81']); assert.deepEqual(plan.expected.participants, ['82']); assert.equal(plan.expected.note, task.note); assert.equal(plan.expected.priorityV2, 2); assert.equal(plan.expected.subTaskNum, 0)
  assert.equal(plan.expected.realEndDate, '2026-11-07'); assert.deepEqual(plan.expected.labels, [{ id: '91', type: 'project' }])
})
test('findSimple update path preserves empty values despite complete creation defaults', () => {
  const task = { ...base(), members: [], responsibilityId: null }, target = { ...definition(), defaultValues: { member: { memberIds: '81', responsibilityId: '81' }, participantsIds: '82', label: { kanbanLabelIds: '91' }, date: { realStartDate: '2026-11-01', realEndDate: '2026-11-07' }, note: 'ignored', priorityV2: 4, subtasks: [{ name: 'ignored' }] } }
  const plan = taskTypeTransitionPlan(task, target)
  assert.deepEqual(plan.appliedDefaults, []); assert.equal(plan.creationDefaultsApplied, false); assert.equal(plan.expected.responsibilityId, null); assert.equal(plan.expected.realEndDate, null); assert.equal(plan.expected.note, task.note); assert.equal(plan.expected.priorityV2, 2); assert.equal(plan.expected.subTaskNum, 0)
  assert.deepEqual(plan.expected.members, []); assert.deepEqual(plan.expected.participants, []); assert.deepEqual(plan.expected.labels, [])
  assert.deepEqual(taskTypeTransitionPlan(task, { ...target, defaultValues: { member: { memberIds: '81', responsibilityId: '82' } } }).expected.members, [])
})
test('milestone conversion uses actual Shanghai end day and distinguishes previously empty date', () => {
  const target = { ...definition(), isMilepost: true }
  for (const [dates, day] of [[{ realStartDate: '2026-11-01', realEndDate: '2026-11-07' }, '2026-11-07'], [{ realStartDate: '2026-11-08' }, '2026-11-08'], [{ realEndDate: '2026-11-07T20:30:00Z' }, '2026-11-08']]) {
    const plan = taskTypeTransitionPlan({ ...base(), ...dates }, target); assert.equal(plan.expected.realStartDate, day); assert.equal(plan.expected.realEndDate, day)
  }
  const plan = taskTypeTransitionPlan(base(), { ...target, defaultValues: { date: { realEndDate: '2026-11-09' } } }); assert.equal(plan.expected.realStartDate, null)
  const initializedRange = taskTypeTransitionPlan(base(), { ...target, defaultValues: { date: { realStartDate: '2026-11-01', realEndDate: '2026-11-09' } } }); assert.equal(initializedRange.expected.realStartDate, null)
  assert.throws(() => taskTypeTransitionPlan({ ...base(), realEndDate: 'tomorrow' }, target), { code: 'CONTEXT_MISSING' })
})
test('impact lists async clearing and audit lifecycle without claiming all field storage is preserved', () => {
  const plan = taskTypeTransitionPlan(base(), { ...definition(), fields: [{ id: '7502', type: 31 }] }, { templateFields: [{ id: '7501', type: 10 }, { id: '7503', type: 31 }] })
  assert.deepEqual(plan.fieldLifecycle.clearOldFromProjectFieldIds, ['7501']); assert.deepEqual(plan.fieldLifecycle.closeOldAuditFieldIds, ['7503']); assert.deepEqual(plan.fieldLifecycle.initializeOrRestartTargetAuditFieldIds, ['7502']); assert.equal(plan.fieldLifecycle.specificFieldLifecycleVerified, false)
})
test('shared field contents and target full field identities are independently checked', () => {
  const before = base(), after = { ...base(), taskTemplate: { id: '7402', isMilepost: false } }, target = { ...definition(), fields: [{ id: '7501', type: 1 }] }, afterFields = fields('7402')
  const plan = taskTypeTransitionPlan(before, target)
  assert.deepEqual(verifyTaskTypeTransition(before, after, target, fields(), afterFields, plan).sharedVisibleFieldIdsPreserved, ['7501'])
  afterFields.templateFields[0].value = 'lost'; assert.throws(() => verifyTaskTypeTransition(before, after, target, fields(), afterFields, plan), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.throws(() => verifyTaskTypeTransition(before, after, target, fields(), fields('7402', '9999'), plan), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('shared attachment values retain file identity while transient download signatures are excluded', () => {
 const before = base(), after = { ...base(), taskTemplate: { id: '7402', isMilepost: false } }, target = { ...definition(), fields: [{ id: '7501', type: 6 }] }, origin = 'https://www.rishiqing.com'
 const make = (templateId, signature) => ({ taskTemplate: { id: templateId }, templateFields: [{ id: '7501', type: 6, files: [{ id: '7801', name: 'keep', realPath: origin + '/task/v1/folder/file/url?signature=' + signature }] }] })
 const a = make('7401', 'old'), b = make('7402', 'new'), plan = taskTypeTransitionPlan(before, target, a)
 assert.deepEqual(verifyTaskTypeTransition(before, after, target, a, b, plan, origin).sharedVisibleFieldIdsPreserved, ['7501'])
 b.templateFields[0].files[0].id = '7802'; assert.throws(() => verifyTaskTypeTransition(before, after, target, a, b, plan, origin), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('ordinary and template transitions have separate fixed routes and same-type apply sends no PUT', async () => {
  for (const template of [false, true]) {
    const prefix = template ? 'project template task type' : 'project task type', f = fixture({ template })
    const preview = await executeWorkflow(ctx, flow(prefix + ' inspect'), input, session, { transport: f.transport }); assert.equal(preview.result.canApply, true)
    const result = await executeWorkflow(ctx, flow(prefix + ' apply'), { ...input, contextVersion: preview.result.contextVersion }, session, { transport: f.transport, approved: true })
    assert.equal(result.result.proof.independentlyReadBack, true); assert.equal(result.result.target, template ? 'project-template' : 'project'); assert.equal(f.writes.length, 1)
    const same = fixture({ template, before: { taskTemplate: { id: '7402', isMilepost: false } } })
    const noOp = await executeWorkflow(ctx, flow(prefix + ' apply'), input, session, { transport: same.transport, approved: true }); assert.equal(noOp.result.noOp, true); assert.equal(same.writes.length, 0)
  }
})
test('known populated and empty values use independent post-mutation fixtures', async () => {
  const defaults = { member: { memberIds: '81', responsibilityId: '81' }, participantsIds: '82', label: { kanbanLabelIds: '91' }, date: { realEndDate: '2026-11-09' }, note: 'ignored', priorityV2: 4 }
  const f = fixture({ before: { members: [], responsibilityId: null }, definition: { defaultValues: defaults }, after: { members: [], participants: [], responsibilityId: null, labelList: [], realStartDate: null, realEndDate: null } })
  const result = await executeWorkflow(ctx, flow('project task type apply'), input, session, { transport: f.transport, approved: true }); assert.deepEqual(result.result.plan.appliedDefaults, []); assert.equal(f.writes.length, 1)
})
test('wrong resource kinds, cover editing, expired access and dynamic grants reject before writing', async () => {
  for (const [options, code] of [[{ template: true }, 'FORBIDDEN'], [{ denied: true }, 'FORBIDDEN'], [{ wrongPermissions: true }, 'CONTEXT_MISMATCH'], [{ unavailable: true }, 'INVALID_INPUT'], [{ stopped: true }, 'INVALID_INPUT'], [{ expired: true }, 'COMPANY_EXPIRED'], [{ capacity: true }, 'COMPANY_OVER_CAPACITY'], [{ changedIdentity: true }, 'IDENTITY_CHANGED'], [{ features: [{ funcName: 'TASK_TYPE', status: 'disable' }] }, 'FEATURE_DISABLED']]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('project task type apply'), input, session, { transport: f.transport, approved: true }), { code }); assert.equal(f.writes.length, 0)
  }
  for (const options of [{ template: true, editable: false }, { template: true, wrongCover: true }]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('project template task type apply'), input, session, { transport: f.transport, approved: true })); assert.equal(f.writes.length, 0)
  }
})
test('stale default definitions, revoked permissions and stale preview tokens never send PUT', async () => {
  for (const options of [{ definitionDrift: true }, { revoked: true }, {}]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('project task type apply'), { ...input, ...(!Object.keys(options).length && { contextVersion: '0'.repeat(64) }) }, session, { transport: f.transport, approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.equal(f.writes.length, 0)
  }
})
test('unloaded defaults never add inaccessible people; unknown writes and incorrect readback are not replayed', async () => {
  const invalid = fixture({ before: { members: [], responsibilityId: null }, definition: { defaultValues: { member: { memberIds: '99' } } } })
  const actual = await executeWorkflow(ctx, flow('project task type apply'), input, session, { transport: invalid.transport, approved: true }); assert.deepEqual(actual.result.task.members, []); assert.equal(invalid.writes.length, 1); assert.ok(!invalid.calls.some(row => row.path.includes('/scopes/')))
  for (const option of ['timeout', 'corrupt']) {
    const f = fixture({ [option]: true }); await assert.rejects(executeWorkflow(ctx, flow('project task type apply'), input, session, { transport: f.transport, approved: true }), error => { assert.equal(error.details.resources.taskId, input.taskId); assert.equal(error.details.writeOutcome, option === 'timeout' ? 'unknown' : 'accepted-needs-verification'); return true }); assert.equal(f.writes.length, 1)
  }
})
test('dry-run and missing confirmation send zero HTTP and route tampering is rejected', async () => {
  const f = fixture(), selected = flow('project task type apply')
  assert.equal((await executeWorkflow(ctx, selected, input, null, { transport: f.transport, dryRun: true })).dryRun, true)
  await assert.rejects(executeWorkflow(ctx, selected, input, session, { transport: f.transport }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const tampered = structuredClone(selected); tampered.steps[0].forEach = { path: '/arbitrary', limit: 100 }; assert.throws(() => validateTaskTypeTransitionWorkflow(tampered), { code: 'INVALID_CONTRACT' })
  assert.throws(() => validateTaskTypeTransitionWorkflow({ ...selected, effect: 'read' }), { code: 'INVALID_CONTRACT' })
  assert.equal((await runWorkflow(ctx, flow('task template apply'), input, null, { dryRun: true })).command, 'task template apply')
})
