import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { prepareTaskTemplate, taskTemplateVersion, verifyTaskTemplate } from '../dist/task-template.js'
import { executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '9223372036854775801', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, approved = false) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, approved })
const project = { id: '7001', coverId: null, editControl: { kanbanTaskTypeManager: true, setKanbanDefTaskType: true } }
const original = { auths: { elements: [] }, id: '7101', name: 'fixture', fields: [{ id: '7201', authId: 'auth-text', type: 1, name: '说明', value: 'not-config', factor: 'text_factor', selector: null, unit: null, decimalNum: null }, { id: '7202', type: 24, name: '公式', formula: { factors: ['text_factor'], text: '1' } }] }
test('default configuration verifies native decorated child/label responses and exact nested dates', () => {
  const expected = { id: '7101', defaultValues: { member: { memberIds: '82,81', responsibilityId: '82' }, participantsIds: '82,81', label: { kanbanLabelIds: '7402,7401' }, date: { realStartDate: '2026-11-09', realEndDate: null }, subtasks: [{ name: 'child', memberIds: '81', responsibilityId: '81' }] } }
  const actual = { id: '7101', defaultValues: { member: { memberIds: '81,82', responsibilityId: '82' }, participantsIds: '81,82', label: { kanbanLabels: [{ id: '7401', name: 'one' }, { id: '7402', name: 'two' }] }, date: { realStartDate: '2026-11-09', realEndDate: null }, subtasks: [{ id: 'new-child-default', name: 'child', member: { members: [{ id: '81', name: 'self' }], responsibilityId: '81' } }] } }
  verifyTaskTemplate({}, { taskContext: { expected }, verifiedTemplate: actual }, 'verifiedTemplate')
  actual.defaultValues.subtasks[0].member.members = [{ id: '82' }]
  assert.throws(() => verifyTaskTemplate({}, { taskContext: { expected }, verifiedTemplate: actual }, 'verifiedTemplate'), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('task template field mutation preserves definitions and never writes VO values', async () => {
  let written, count = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/company/current')) return json({ taskTypeManager: false })
    if (url.pathname.endsWith('/kanbanCrud')) return json(project)
    if (url.pathname.endsWith('/settingList')) return json([{ id: '7101', type: 'kanban' }])
    if (init.method === 'PUT') { count++; written = JSON.parse(init.body); return json(written) }
    return json(written ?? original)
  }
  const input = { projectId: '7001', templateId: '7101', fieldId: '7201', patch: { name: '已修改' }, expectedDefinition: taskTemplateVersion(original) }
  await assert.rejects(run('task template field configure', { ...input, expectedDefinition: '0'.repeat(64) }, transport, true), { code: 'CONTEXT_CONFLICT' })
  assert.equal(count, 0)
  const result = await run('task template field configure', input, transport, true)
  assert.equal(written.fields[0].value, undefined); assert.equal(written.fields[0].factor, 'text_factor')
  assert.equal(written.fields[0].selector, undefined); assert.equal(written.fields[0].unit, undefined); assert.equal(written.fields[0].decimalNum, undefined)
  assert.deepEqual(written.fields[1].formula, original.fields[1].formula)
  assert.match(result.result.definitionVersion, /^[a-f0-9]{64}$/)
  await assert.rejects(run('task template field remove', { projectId: '7001', templateId: '7101', fieldId: '7201' }, transport, true), { code: 'DEPENDENCY_EXISTS' })
  assert.equal(count, 1)
})
test('company and project management permissions cannot be interchanged', () => {
  const results = { project, company: { taskTypeManager: false }, available: [{ id: '7101', type: 'company' }], original }
  assert.throws(() => prepareTaskTemplate('task-context-configure', { projectId: '7001', templateId: '7101', patch: { name: 'x' } }, results), { code: 'FORBIDDEN' })
  assert.throws(() => prepareTaskTemplate('task-context-create', { name: 'x' }, results), { code: 'FORBIDDEN' })
  const local = prepareTaskTemplate('task-context-create', { projectId: '7001', name: 'x' }, results)
  assert.deepEqual(local.body, { name: 'x', icon: 1, type: 'kanban', kanbanId: '7001' })
  assert.throws(() => prepareTaskTemplate('task-context-list', { projectId: '9999' }, results), { code: 'CONTEXT_MISSING' })
})
test('new field definitions reject foreign ids and duplicate singleton fields', () => {
  const results = { project, company: {}, available: [{ id: '7101', type: 'kanban' }], original: { ...original, fields: [{ id: '7201', name: '工时', type: 8 }] } }
  assert.throws(() => prepareTaskTemplate('task-context-field-add', { projectId: '7001', templateId: '7101', field: { name: '工时2', type: 'WorkHour' } }, results), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareTaskTemplate('task-context-field-add', { projectId: '7001', templateId: '7101', field: { id: '9999', name: 'x', type: 'Content' } }, results), { code: 'INVALID_INPUT' })
})
test('task options follow numeric UI values and reject invalid definitions before any write', () => {
  const results = { project, company: {}, available: [{ id: '7101', type: 'kanban' }], original: { ...original, fields: [] } }
  const input = { projectId: '7001', templateId: '7101', field: { name: '状态', type: 'Menu', selector: [{ name: '准备' }, { name: '完成' }] } }
  assert.deepEqual(prepareTaskTemplate('task-context-field-add', input, results).body.fields[0].selector.map(option => option.value), ['1', '2'])
  for (const selector of [[{ name: 'x', value: 'done' }], [{ name: 'x', value: '0' }], [{ name: 'x', value: '9223372036854775808' }], [{ name: 'x', value: '1' }, { name: 'y', value: '1' }], [{ id: '73', name: 'x' }]]) {
    assert.throws(() => prepareTaskTemplate('task-context-field-add', { ...input, field: { ...input.field, selector } }, results), { code: 'INVALID_INPUT' })
  }
  const previous = { authId: 'auth-option', id: '7201', name: '状态', type: 4, selector: [{ id: '7301', name: '准备', value: '7' }] }
  results.original.fields = [previous]
  const configured = prepareTaskTemplate('task-context-field-edit', { projectId: '7001', templateId: '7101', fieldId: '7201', patch: { selector: [...previous.selector, { name: '完成' }] } }, results)
  assert.deepEqual(configured.body.fields[0].selector.map(option => option.value), ['7', '8'])
  assert.throws(() => prepareTaskTemplate('task-context-field-edit', { projectId: '7001', templateId: '7101', fieldId: '7201', patch: { selector: [{ ...previous.selector[0], value: '8' }] } }, results), { code: 'INVALID_INPUT' })
})
test('project template task types use the template resource header and offline dry-run performs no context reads', async () => {
  let calls = 0
  const flow = workflows.workflows.find(flow => flow.command === 'project template task-type list')
  await runWorkflow(ctx, flow, { projectId: '7001' }, null, { dryRun: true, transport: async () => { throw Error('offline') } })
  const transport = async (url, init) => { calls++; if (url.pathname.endsWith('/kanbanCrud')) { assert.equal(init.headers.get('Plan-Type'), 'template'); return json({ ...project, coverId: '8001' }) } if (url.pathname.endsWith('/v4/template')) { assert.equal(url.searchParams.get('id'), '8001'); return json({ id: '8001', templateKanbanId: '7001', name: 'readable', withEdit: false }) } return json([]) }
  await run('project template task-type list', { projectId: '7001' }, transport)
  assert.equal(calls, 3)
})
test('task field assignment resolves real option values, preserves zero and checks current permissions', () => {
  const task = { id: 'task-1', from: { projectId: '7001' } }, field = { id: '7201', name: '状态', type: 4, selector: [{ id: '7301', name: '完成', value: '1' }], editControl: { canEdit: true } }
  const results = { task, values: { templateFields: [field] } }, input = { projectId: '7001', taskId: 'task-1', fieldId: '7201', value: '完成' }
  assert.equal(prepareTaskTemplate('task-context-field-set', input, results).body.value, '1')
  assert.equal(prepareTaskTemplate('task-context-field-set', { ...input, value: null }, results).body.value, '')
  field.type = 2
  assert.equal(prepareTaskTemplate('task-context-field-set', { ...input, value: 0 }, results).body.value, 0)
  field.editControl.canEdit = false
  assert.throws(() => prepareTaskTemplate('task-context-field-set', input, results), { code: 'FORBIDDEN' })
  assert.throws(() => prepareTaskTemplate('task-context-field-set', { ...input, projectId: '9999' }, results), { code: 'CONTEXT_MISSING' })
})
test('milestone commands verify actual task type and explicit permissions before updating', () => {
  const input = { projectId: '7001', taskId: 'task-1', patch: { date: '2026-11-08' } }, current = { id: 'task-1', from: { projectId: '7001' }, taskTemplate: { isMilepost: false }, editControl: { editTaskDate: true } }
  assert.throws(() => prepareTaskTemplate('task-context-milestone-update', input, { task: current }), { code: 'INVALID_INPUT' })
  current.taskTemplate.isMilepost = true
  const result = prepareTaskTemplate('task-context-milestone-update', input, { task: current, taskPermissions: { taskId: 'task-1', module: 'project', siteId: '7001', editControl: { editTaskDate: true } } })
  assert.equal(result.body.realEndDate, '2026-11-08'); assert.equal(result.body.realStartDate, '2026-11-08')
  assert.equal(result.body.taskTemplateId, undefined)
})
test('project task creation requires a discovered card and availability cannot stop the project default', () => {
  const input = { projectId: '7001', moduleId: '7002', name: 'milestone', date: '2026-11-08' }
  const results = { project, modules: [{ id: '7002', type: 'task' }], available: [{ id: '7101', isMilepost: true }], cardPermissions: { createTask: true, editTaskDate: true, modifyTaskType: true } }
  assert.throws(() => prepareTaskTemplate('task-context-milestone-create', input, results), { code: 'CONTEXT_MISSING' })
  results.moduleDetail = { id: '7002', firstCardId: '7003', kanbanCardList: [{ id: '7003', name: '默认卡片' }] }
  results.cards = [{ id: '7003', name: '默认卡片' }]
  assert.equal(prepareTaskTemplate('task-context-milestone-create', input, results).body.cardId, '7003')
  assert.throws(() => prepareTaskTemplate('task-context-milestone-create', { ...input, cardId: '9999' }, results), { code: 'CONTEXT_MISSING' })
  results.company = {}; results.available = [{ id: '7101', type: 'kanban', isDefault: true }]; results.original = { id: '7101', fields: [] }
  assert.throws(() => prepareTaskTemplate('task-context-availability', { projectId: '7001', templateId: '7101', stopped: true }, results), { code: 'INVALID_INPUT' })
})
test('new transport writes cannot bypass their executable business context commands', async () => {
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/api/v3/template'), input = { body: { id: '7101', name: 'unsafe' } }
  await assert.rejects(executeOperation(ctx, op, input, session, { approved: true, transport: async () => { throw Error('No HTTP allowed') } }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.ok(op.requiresBusinessContext.every(command => workflows.workflows.some(flow => flow.command === command)))
})

test('field creation initializes UI permissions while preserving every existing role choice', () => {
  const restricted = { authId: 'auth-text', authName: '说明', creator: { editStatus: false }, principal: { editStatus: false }, executor: { editStatus: false }, participant: { editStatus: false }, confirmer: { editStatus: false }, projectRole: { editStatus: true, roleIdList: ['9223372036854775801'] } }
  const results = { project, company: {}, available: [{ id: '7101', type: 'kanban' }], original: { ...original, auths: { elements: [restricted] } } }
  const body = prepareTaskTemplate('task-context-field-add', { projectId: '7001', templateId: '7101', field: { name: '新字段', type: 'Content' } }, results).body
  const added = body.fields.at(-1), auth = body.auths.elements.find(element => element.authId === added.authId)
  assert.match(added.authId, /^[a-f0-9]{32}$/)
  assert.deepEqual(body.auths.elements.find(element => element.authId === 'auth-text'), restricted)
  assert.equal(auth.creator.editStatus, true); assert.equal(auth.executor.editStatus, true)
  assert.equal(auth.participant.editStatus, false); assert.equal(auth.projectRole.editStatus, false)
  assert.throws(() => prepareTaskTemplate('task-context-field-edit', { projectId: '7001', templateId: '7101', fieldId: '7201', patch: { authId: 'other' } }, results), { code: 'INVALID_INPUT' })
})
test('audit and calculated reference fields do not invent ordinary editable-field permission identifiers', () => {
  const results = { project, company: {}, available: [{ id: '7101', type: 'kanban' }], original: { ...original, auths: { elements: [] } } }
  const body = prepareTaskTemplate('task-context-field-add', { projectId: '7001', templateId: '7101', field: { name: '审核', type: 'Audit', audits: { confirm: { enable: false, contentRequirement: null, signatureRequirement: null }, completion: { auditMode: 0, simpleList: [] } } } }, results).body
  assert.equal(body.fields.at(-1).authId, undefined)
  assert.ok(!body.auths.elements.some(element => element.authName === '审核'))
  assert.equal(body.fields.at(-1).audits.confirm.contentRequirement, null)
})
test('retired narrow type adapter cannot bypass the full transition context even with task grants', () => {
 const input = { projectId: '7001', taskId: 'task-1', templateId: '7101' }
 const task = { id: 'task-1', from: { projectId: '7001' }, editControl: { modifyTaskType: true } }
 for (const taskPermissions of [undefined, { taskId: 'task-1', siteId: '9999', module: 'project', editControl: { modifyTaskType: true } }, { taskId: 'task-1', siteId: '7001', module: 'project', editControl: { modifyTaskType: true } }]) {
   assert.throws(() => prepareTaskTemplate('task-context-apply', input, { task, taskPermissions, taskTemplates: [{ id: '7101' }] }), { code: 'INVALID_CONTRACT' })
 }
})

test('milestone completion exposes missing required fields before attempting the write', () => {
 const input = { projectId: '7001', taskId: 'task-1', done: true }
 const results = { task: { id: 'task-1', from: { projectId: '7001' }, taskTemplate: { isMilepost: true } }, taskPermissions: { taskId: 'task-1', module: 'project', siteId: '7001', editControl: { finishTask: true } }, values: { templateFields: [{ id: '7201', name: '说明', type: 1, isRequired: true, value: '' }] } }
 assert.throws(() => prepareTaskTemplate('task-context-milestone-complete', input, results), error => error.code === 'INVALID_INPUT' && error.details.fields[0].id === '7201')
 results.values.templateFields[0].value = 'filled'
 assert.equal(prepareTaskTemplate('task-context-milestone-complete', input, results).body.isDone, true)
})

test('milestone independent readback checks both ends of the single-day range', () => {
  const input = { projectId: '7001', taskId: 'task-1' }, expected = { realStartDate: '2097-01-02', realEndDate: '2097-01-02' }
  const actual = { id: 'task-1', from: { projectId: '7001' }, taskTemplate: { isMilepost: true }, realStartDate: '2097-01-01', realEndDate: '2097-01-02' }
  const results = { taskContext: { milestone: true, expected }, verifiedTask: actual }
  assert.throws(() => verifyTaskTemplate(input, results, 'verifiedTask'), { code: 'BUSINESS_ASSERTION_FAILED' })
  actual.realStartDate = '2097-01-02'; assert.doesNotThrow(() => verifyTaskTemplate(input, results, 'verifiedTask'))
})

test('structured task field readback rejects equal-size lists or tables with the wrong values', () => {
  const input = { taskId: 'task-1', fieldId: '4001' }
  for (const key of ['list', 'tableRows']) {
    const expected = key === 'list' ? [{ id: '5001', value: '必须保存的值' }] : [{ '6001': { id: '5001', value: '必须保存的值' } }]
    const wrong = key === 'list' ? [{ id: '5001', value: '没有修改' }] : [{ '6001': { id: '5001', value: '没有修改' } }]
    const results = { taskContext: { fieldId: '4001', expected: { [key]: expected } }, verifiedValues: { templateFields: [{ id: '4001', type: 20, [key]: wrong }] } }
    assert.throws(() => verifyTaskTemplate(input, results, 'verifiedValues'), { code: 'BUSINESS_ASSERTION_FAILED' })
    results.verifiedValues.templateFields[0][key] = expected
    assert.doesNotThrow(() => verifyTaskTemplate(input, results, 'verifiedValues'))
  }
})
