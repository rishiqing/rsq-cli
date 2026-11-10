import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { validateWorkflowTaskWorkflow } from '../dist/workflow-tasks.js'
import { prepareWorkflowLifecycle } from '../dist/workflow-lifecycle.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const base = { processId: '8101', stepId: '8201', fieldId: '8301' }, json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), wf = value => json({ code: 200, data: value })
const flow = (action, project = false) => { const selected = workflows.workflows.find(row => row.command === (project ? 'project ' : '') + 'workflow instance task ' + action); assert.ok(selected); return selected }
function fixture(options = {}) {
  const calls = [], writes = [], tasks = new Map(), order = ['9301', '9302'], other = { id: '9401', name: '其他字段任务', isDone: false }
  const detail = (id, name) => ({ id, name, isDone: false, priorityV2: 1, progress: 0, note: '', from: { type: 'workflow', workflowId: '8001', processId: options.wrongTaskOrigin ? '8199' : '8101', stepId: '8201', projectId: null, taskPosition: options.project ? 'projectWorkflow' : 'workflow' }, members: [{ id: '81' }] })
  tasks.set('9301', detail('9301', '已有一')); tasks.set('9302', detail('9302', '已有二'))
  const summary = task => ({ id: task.id, name: task.name, isDone: task.isDone })
  let forms = 0, permissions = 0, next = 9500
  const transport = async (url, init) => {
    const path = url.pathname, body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined, query = Object.fromEntries(url.searchParams)
    calls.push({ path, method: init.method, query, body })
    if (path.endsWith('/authAjax')) return json({ success: true, id: '81', username: 'fixture', team: { id: options.identity ? '8' : '7', name: 'fixture' }, token: 'fixture' })
    if (path.endsWith('/member/state/independent')) return json({ vt: 'fixture', mainApp: 'rsq', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: 1, userLimit: options.capacity ? 0 : 2 })
    if (path.endsWith('/function/available')) return json(options.features ?? [])
    if (path.endsWith('/authorities/company/current')) return json({ useFlow: true, useKanban: true })
    if (path.endsWith('/process/info/details')) return wf({ id: '8101', flowAppId: '8001', status: 'doing', belongToProjectId: options.project ? '8501' : null, processInfoStepList: [{ id: '8201' }] })
    if (path.endsWith('/process/info/step')) return wf({ id: options.wrongStep ? '8299' : '8201', applicationId: '8001', processInfoId: options.wrongProcess ? '8199' : '8101', formId: '8601', originId: '8701', status: 'doing' })
    if (path.endsWith('/auditsAndForms')) {
      forms++
      return wf({ formId: options.wrongForm ? '8699' : '8601', editControl: { fillStepForm: !options.readonly && !(options.revoke && forms > 1) }, fields: [{ id: '8301', type: options.type ?? 23, name: options.drift && forms > 1 ? 'concurrent' : '任务', isHidden: options.hidden ?? false, tasks: order.filter(id => tasks.has(id)).map(id => summary(tasks.get(id))) }, { id: '8302', type: 23, tasks: [other] }] })
    }
    if (path.endsWith('/workflow/application')) return wf({ id: '8001', workflowModuleSubType: options.project || options.projectMismatch ? 'projectWorkflow' : null })
    if (path.endsWith('/kanbanCrud')) return json({ id: '8501', coverId: options.template ? '8801' : null })
    if (path.endsWith('/sheet/taskList')) { assert.deepEqual(body, { idList: [{ processInfoId: '8101', flowApplicationId: '8001', stepInfoId: '8701' }] }); return wf({ '8001-8101-8701': options.missingStepTask ? [] : [...order.filter(id => tasks.has(id)).map(id => summary(tasks.get(id))), other] }) }
    if (path.endsWith('/task/editcontrol')) { permissions++; return json({ taskId: options.wrongPermission ? '9999' : query.taskId, module: query.module, siteId: query.siteId, editControl: { editTaskName: !options.taskReadonly && !(options.revokeTask && permissions > 1), finishTask: !options.taskReadonly, editTaskProgress: true, editTaskNote: true, editTaskPriority: true } }) }
    if (path.endsWith('/task/template')) return json({ templateFields: options.required ? [{ id: '9901', isRequired: true, value: null }] : [] })
    if (path.endsWith('/form/task') || path.endsWith('/form/task/batch')) {
      assert.equal(init.method, 'POST'); assert.equal(body.stepId, '8201'); assert.equal(body.fieldId, '8301')
      writes.push({ path, method: init.method, body }); if (options.timeout) throw new TypeError('lost creation response')
      const created = (body.tasks ?? [body.taskName]).map(name => { const value = String(++next), task = detail(options.uuid ? '09ab01ed-d036-49ab-81de-' + value.padStart(12, '0') : value, name); tasks.set(task.id, task); if (!options.ignoreWrite) order.push(task.id); return summary(task) })
      return wf(path.endsWith('/batch') ? options.partial ? created.slice(0, 1) : created : created[0])
    }
    if (path.endsWith('/process/info/form') && init.method === 'PUT') { writes.push({ path, method: init.method, body }); if (options.timeout) throw new TypeError('lost order response'); if (!options.ignoreWrite) order.splice(0, order.length, ...body.value.split(',')); return wf({ id: '8301', type: 23 }) }
    if (path.endsWith('/api/v3/task')) {
      if (init.method === 'GET') return json(tasks.get(query.id))
      writes.push({ path, method: init.method, body, query }); if (options.timeout) throw new TypeError('lost mutation response')
      if (init.method === 'PUT') { const task = tasks.get(body.id); if (!options.ignoreWrite) for (const [key, value] of Object.entries(body)) if (!['module', 'siteId'].includes(key)) task[key] = value; return json(task) }
      if (init.method === 'DELETE') { if (!options.ignoreWrite) tasks.delete(query.id); return new Response(null) }
    }
    if (path.endsWith('/recycleBin/list')) return json(options.noRecycle ? [] : [{ id: '9601', resourceId: '9301', userId: '81', type: 5 }])
    throw Error('Unexpected ' + init.method + ' ' + path)
  }
  return { calls, writes, tasks, transport }
}
const run = (action, input, f, project = false) => executeWorkflow(ctx, flow(action, project), { ...base, ...(project && { projectId: '8501' }), ...input }, session, { approved: true, transport: f.transport })
test('workflow Task23 inspect binds form and definition-step observations without claiming an empty create path', async () => {
  for (const project of [false, true]) { const f = fixture({ project }), out = await run('inspect', {}, f, project); assert.deepEqual(out.result.taskIds, ['9301', '9302']); assert.equal(out.result.proof.formAndStepTasksReadBack, true); assert.equal(f.writes.length, 0); assert.match(out.result.contextVersion, /^[a-f0-9]{64}$/) }
})
test('single and batch creation append in exact order and independently fetch every real task', async () => {
  for (const project of [false, true]) for (const batch of [false, true]) {
    const f = fixture({ project }), out = await run(batch ? 'create-batch' : 'create', batch ? { names: ['甲', '乙'] } : { name: '甲' }, f, project)
    assert.deepEqual(out.result.taskIds, batch ? ['9301', '9302', '9501', '9502'] : ['9301', '9302', '9501']); assert.equal(f.writes.length, 1)
    assert.equal(f.calls.filter(call => call.path.endsWith('/api/v3/task') && call.method === 'GET').length, batch ? 2 : 1); assert.equal(out.result.proof.unrelatedTasksPreserved, true)
  }
})
test('native Task3 UUID is preserved through create, inspection and task edits without numeric coercion', async () => {
  const f = fixture({ uuid: true }), out = await run('create', { name: 'UUID任务' }, f), taskId = out.result.changedTaskIds[0]
  assert.equal(taskId, '09ab01ed-d036-49ab-81de-000000009501')
  const changed = await run('change', { taskId, patch: { name: 'UUID改名' } }, f); assert.equal(changed.result.tasks.find(task => task.id === taskId).name, 'UUID改名')
  const before = f.writes.length; await assert.rejects(run('reorder', { taskIds: changed.result.taskIds }, f), error => error.code === 'CONTEXT_INCOMPLETE'); assert.equal(f.writes.length, before)
})
test('wrong instance, form, hidden/type23, project and step-task contexts cannot send a creation', async () => {
  for (const options of [{ wrongStep: true }, { wrongProcess: true }, { wrongForm: true }, { hidden: true }, { type: 1 }, { projectMismatch: true }, { missingStepTask: true }]) { const f = fixture(options); await assert.rejects(run('create', { name: '甲' }, f)); assert.equal(f.writes.length, 0) }
  const f = fixture({ project: true, template: true }); await assert.rejects(run('create', { name: '甲' }, f, true)); assert.equal(f.writes.length, 0)
})
test('current form rights, expiry, capacity, stale summary and write-time revocation stop before creating', async () => {
  for (const options of [{ readonly: true }, { expired: true }, { capacity: true }, { revoke: true }, { drift: true }, { identity: true }]) { const f = fixture(options); await assert.rejects(run('create', { name: '甲' }, f)); assert.equal(f.writes.length, 0) }
  const f = fixture(); await assert.rejects(run('create', { name: '甲', contextVersion: '0'.repeat(64) }, f), error => error.code === 'CONTEXT_CONFLICT'); assert.equal(f.writes.length, 0)
})
test('workflow task edits use actual task permissions even with readonly form and read back name and done state', async () => {
  for (const project of [false, true]) { const f = fixture({ project, readonly: true }); const out = await run('change', { taskId: '9301', patch: { name: '改名', isDone: true, progress: 0, priorityV2: 4, note: '' } }, f, project); assert.equal(out.result.tasks[0].name, '改名'); assert.equal(out.result.tasks[0].isDone, true); assert.equal(f.writes.length, 1); assert.deepEqual(out.result.taskIds, ['9301', '9302']) }
  for (const options of [{ taskReadonly: true }, { revokeTask: true }, { wrongPermission: true }, { required: true }, { wrongTaskOrigin: true }]) { const f = fixture(options); await assert.rejects(run('change', { taskId: '9301', patch: { name: '改名', isDone: true } }, f)); assert.equal(f.writes.length, 0) }
})
test('remove follows current UI Task3 DELETE, checks actual membership and independent recycle evidence', async () => {
  for (const project of [false, true]) { const f = fixture({ project }), out = await run('remove', { taskId: '9301' }, f, project); assert.deepEqual(out.result.taskIds, ['9302']); assert.equal(out.result.proof.recycleReadBack, true); assert.equal(f.writes[0].path, '/task/api/v3/task'); assert.deepEqual(f.writes[0].query, { id: '9301', module: project ? 'project' : 'common', siteId: project ? '8501' : 'common' }) }
  for (const [options, taskId] of [[{}, '9999'], [{ readonly: true }, '9301']]) { const f = fixture(options); await assert.rejects(run('remove', { taskId }, f)); assert.equal(f.writes.length, 0) }
  const f = fixture({ noRecycle: true }); await assert.rejects(run('remove', { taskId: '9301' }, f), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.taskIds[0] === '9301'); assert.equal(f.writes.length, 1)
})
test('ordering accepts only a complete permutation and keeps task content and other fields', async () => {
  for (const project of [false, true]) { const f = fixture({ project }), out = await run('reorder', { taskIds: ['9302', '9301'] }, f, project); assert.deepEqual(out.result.taskIds, ['9302', '9301']); assert.deepEqual(f.writes[0].body, { stepId: '8201', fieldId: '8301', value: '9302,9301' }); assert.equal(out.result.proof.taskDetailsReadBack, false) }
  for (const taskIds of [[], ['9301'], ['9301', '9301'], ['9301', '9999']]) { const f = fixture(); await assert.rejects(run('reorder', { taskIds }, f)); assert.equal(f.writes.length, 0) }
  const f = fixture({ readonly: true }); await assert.rejects(run('reorder', { taskIds: ['9302', '9301'] }, f)); assert.equal(f.writes.length, 0)
})
test('generic form fill cannot implicitly remove Task23 associations or send ignored scalar values', () => {
  assert.throws(() => prepareWorkflowLifecycle('workflow-lifecycle-fill', { ...base, value: '9301' }, { process: { data: { id: '8101', flowAppId: '8001', processInfoStepList: [{ id: '8201' }] } }, instanceStep: { data: { id: '8201', applicationId: '8001', processInfoId: '8101', formId: '8601' } }, instanceForm: { data: { formId: '8601', editControl: { fillStepForm: true }, fields: [{ id: '8301', type: 23 }] } } }, session), error => error.code === 'BUSINESS_CONTEXT_REQUIRED')
})
test('lost response, partial create and missing readback retain IDs and never replay a write', async () => {
  const lost = fixture({ timeout: true }); await assert.rejects(run('create', { name: '甲' }, lost), error => error.details.writeOutcome === 'unknown' && error.details.automaticallyRetried === false); assert.equal(lost.writes.length, 1)
  const partial = fixture({ partial: true }); await assert.rejects(run('create-batch', { names: ['甲', '乙'] }, partial), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.taskIds[0] === '9501'); assert.equal(partial.writes.length, 1)
  const ignored = fixture({ ignoreWrite: true }); await assert.rejects(run('create', { name: '甲' }, ignored)); assert.equal(ignored.writes.length, 1)
})
test('raw field creation is context gated; dry-run is offline; removal requires explicit confirmation', async () => {
  for (const route of ['/task/workflow/process/info/form/task', '/task/workflow/process/info/form/task/batch']) { const operation = catalog.operations.find(op => op.route === route && op.method === 'POST'); await assert.rejects(executeOperation(ctx, operation, { body: { stepId: '8201', fieldId: '8301', ...(route.endsWith('/batch') ? { tasks: ['甲'] } : { taskName: '甲' }) } }, session), error => error.code === 'BUSINESS_CONTEXT_REQUIRED') }
  for (const project of [false, true]) for (const action of ['inspect', 'create', 'create-batch', 'change', 'remove', 'reorder']) {
    const input = { ...base, ...(project && { projectId: '8501' }), ...(action === 'create' && { name: '甲' }), ...(action === 'create-batch' && { names: ['甲'] }), ...(['change', 'remove'].includes(action) && { taskId: '9301' }), ...(action === 'change' && { patch: { name: '甲' } }), ...(action === 'reorder' && { taskIds: ['9302', '9301'] }) }
    const out = await runWorkflow(ctx, flow(action, project), input, null, { dryRun: true, transport: () => { throw Error('network in dry run') } }); assert.equal(out.dryRun, true); assert.ok(out.steps.every(step => step.context === 'resolve-from-verified-http-context'))
  }
  await assert.rejects(runWorkflow(ctx, flow('remove'), { ...base, taskId: '9301' }, session), error => error.code === 'CONFIRMATION_REQUIRED')
})
test('metadata cannot remove a permission, actual form, independent observation or recycle step', () => {
  for (const action of ['inspect', 'create', 'create-batch', 'change', 'remove', 'reorder']) { const f = flow(action); for (let index = 0; index < f.steps.length; index++) { const changed = structuredClone(f); changed.steps.splice(index, 1); assert.throws(() => validateWorkflowTaskWorkflow(changed)) } }
})
