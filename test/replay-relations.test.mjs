import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { catalog } from '../dist/operations.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
import { businessScope } from '../dist/business.js'
import { replayTemplateComponent } from '../dist/replay-template-fields.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const getFlow = command => workflows.workflows.find(flow => flow.command === command)
const run = (command, input, mock, approved = false) => runWorkflow(ctx, getFlow(command), input, session, { transport: mock.transport, approved })
const base = { replayId: '91', componentId: '101' }
function service(options = {}) {
  const calls = [], source = new Map([['task-a', { id: 'task-a', name: 'A', isDisplay: true }], ['task-b', { id: 'task-b', name: 'B', isDisplay: true }]])
  let list = [{ id: 900, taskId: 'task-a', name: 'A', fieldList: [{ id: 701, type: 'text', text: 'keep' }, { id: 702, type: 'progress', progress: 0 }] }]
  let template = { id: 20, name: 'Original', componentList: [{ id: 999, name: 'Question', type: 'question', isRequired: false, answer: '{"ops":[]}', placeholder: '', isOpenInsertTask: false, isOpenInsertFlowStep: false }] }, reportGets = 0, nextField = 300
  const report = () => ({ id: 91, replayCollectId: 51, type: 'day', year: 2026, month: 11, day: 8, status: options.stale && reportGets > 1 ? 'committed' : 'uncommitted',
    writer: { id: options.otherWriter ? 2 : 1 }, editControl: { edit: !options.noEdit }, componentList: [{ id: 501, replayCollectTemplateComponentId: 101, type: 'importTask', name: 'Imported tasks',
      importTaskFieldList: [{ id: 701, type: 'text', name: 'Note', isOpen: true }, { id: 702, type: 'progress', name: 'Progress', isOpen: true }] }] })
  return { calls, source, get list() { return structuredClone(list) }, get template() { return structuredClone(template) }, transport: async (url, init) => {
    const call = { path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams), ...(typeof init.body === 'string' && { body: JSON.parse(init.body) }) }; calls.push(call)
    if (url.pathname === '/task/review/replay/collect/template') {
      if (init.method === 'PUT') {
        if (!options.ignoreWrite) template = { ...call.body, componentList: call.body.componentList.map(component => ({ ...component, id: component.id ?? 100,
          ...(component.importTaskFieldList && { importTaskFieldList: component.importTaskFieldList.map(field => ({ ...field, id: field.id ?? nextField++ })) }),
          ...(component.importObjectiveFieldList && { importObjectiveFieldList: component.importObjectiveFieldList.map(field => ({ ...field, id: field.id ?? nextField++ })) }) })) }
      }
      return json(init.method === 'PUT' ? null : template)
    }
    if (url.pathname === '/task/review/replay') { reportGets++; return json(report()) }
    if (url.pathname === '/task/review/replay/collect') return json({ id: 51, type: 'day', name: 'Own fixture' })
    if (url.pathname === '/task/api/v3/task') return json(source.get(url.searchParams.get('id')) ?? { id: 'unexpected', isDisplay: false })
    if (url.pathname === '/task/review/replay/component/task/import/list') return json(list)
    if (url.pathname === '/task/review/replay/component/task/import/list/latest') {
      if (!options.ignoreWrite) list = list.map(row => ({ ...row, name: source.get(row.taskId).name }))
      return json(list)
    }
    if (url.pathname === '/task/review/replay/component/task/import/text') {
      if (!options.ignoreWrite) list = list.map(row => String(row.id) === call.body.replayTaskId ? { ...row, fieldList: row.fieldList.map(field => String(field.id) === call.body.replayFieldId ? { ...field, text: call.body.text } : field) } : row)
      return json(null)
    }
    if (url.pathname === '/task/review/replay/component/task/import') {
      if (options.timeout) throw Error('timeout after possible import')
      if (!options.ignoreWrite) {
        if (init.method === 'DELETE') list = list.filter(row => String(row.id) !== url.searchParams.get('id'))
        else list.push({ id: 300, taskId: call.body.taskList[0], name: source.get(call.body.taskList[0]).name, fieldList: [{ id: 701, type: 'text', text: '' }, { id: 702, type: 'progress', progress: 0 }] })
      }
      return init.method === 'DELETE' ? json(null) : json(list)
    }
    throw Error('Unexpected route ' + url.pathname)
  } }
}
test('new replay commands have checked context routes and offline confirmation plans', async () => {
  assert.deepEqual(auditWorkflows(workflows, catalog, businessScope), [])
  const mock = service()
  const plan = await runWorkflow(ctx, getFlow('replay relations tasks refresh'), base, null, { dryRun: true, transport: mock.transport })
  assert.equal(plan.effect, 'destructive'); assert.equal(mock.calls.length, 0)
  await assert.rejects(run('replay relations tasks refresh', base, mock), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(mock.calls.length, 0)
})
test('template context and explicit component fields preserve other components and discover actual IDs', async () => {
  const mock = service(), initial = mock.template
  const context = (await run('replay template components context', { templateId: '20' }, mock)).result
  const created = (await run('replay template component add', { templateId: '20', type: 'importTask', name: 'Tasks', expectedDefinition: context.definitionDigest,
    fields: [{ type: 'progress', name: 'Progress' }, { type: 'text', name: 'Risks' }, { type: 'text', name: 'Next' }] }, mock, true)).result
  assert.equal(created.componentId, '100')
  assert.deepEqual(mock.template.componentList[0], { ...initial.componentList[0], id: '999' })
  const added = created.template.componentList[1]
  assert.deepEqual(added.importTaskFieldList.map(field => String(field.id)), ['300', '301', '302'])
  const updated = (await run('replay template component configure', { templateId: '20', componentId: '100', patch: { name: 'Renamed', fields: [
    { id: '302', name: 'Changed next', isOpen: false }, { id: '300' }, { type: 'text', name: 'New' }] } }, mock, true)).result.template.componentList[1]
  assert.equal(updated.name, 'Renamed'); assert.deepEqual(updated.importTaskFieldList.map(field => String(field.id)), ['302', '300', '303'])
  assert.equal(updated.importTaskFieldList[0].isOpen, false)
  assert.deepEqual(mock.template.componentList[0], { ...initial.componentList[0], id: '999' })
})
test('template fields reject cross-component IDs, type changes, duplicate system fields and stale definitions', async () => {
  const current = { id: '10', name: 'Tasks', type: 'importTask', importTaskFieldList: [{ id: '20', name: 'Old', type: 'text', isOpen: true }] }
  for (const patch of [{ fields: [{ id: '99' }] }, { fields: [{ id: '20', type: 'progress' }] }, { fields: [{ name: 'A', type: 'member' }, { name: 'B', type: 'member' }] }, { fields: [{ name: 'A', type: 'grade' }] }]) assert.throws(() => replayTemplateComponent(patch, current), { code: 'INVALID_INPUT' })
  assert.throws(() => replayTemplateComponent({ name: 'Import', type: 'importTask' }), { code: 'INVALID_INPUT' })
  const mock = service()
  await assert.rejects(run('replay template component add', { templateId: '20', type: 'file', name: 'File', expectedDefinition: '0'.repeat(64) }, mock, true), { code: 'CONTEXT_CONFLICT' })
  assert.equal(mock.calls.some(call => call.method === 'PUT'), false)
})
test('non-question template types retain their separate configuration rules', () => {
  assert.deepEqual(replayTemplateComponent({ type: 'file', name: 'Files', required: true }), { type: 'file', name: 'Files', isRequired: true })
  assert.deepEqual(replayTemplateComponent({ name: 'Next actions' }, { id: '1', type: 'createTask', name: 'Old' }), { id: '1', type: 'createTask', name: 'Next actions', isRequired: false })
  const objective = replayTemplateComponent({ type: 'importObjective', name: 'Objectives', fields: [
    { type: 'grade', name: 'Score', isOpen: false }, { type: 'responsibleUser', name: 'Owner' }, { type: 'text', name: 'Review' }, { type: 'keyAction', name: 'Next' }] })
  assert.equal(objective.importObjectiveFieldList[0].isOpen, false)
  assert.deepEqual(objective.importObjectiveFieldList.map(field => field.type), ['grade', 'responsibleUser', 'text', 'keyAction'])
  assert.throws(() => replayTemplateComponent({ type: 'createTask', name: 'Next', fields: [] }), { code: 'INVALID_INPUT' })
  assert.throws(() => replayTemplateComponent({ type: 'importTask', name: 'Tasks', required: true, fields: [] }), { code: 'INVALID_INPUT' })
})
test('import uses current replay period and template component; unrelated snapshots remain and source task stays untouched', async () => {
  const mock = service(), old = mock.list
  const result = await run('replay relations task link', { ...base, taskId: 'task-b' }, mock)
  const write = mock.calls.find(call => call.method === 'POST')
  assert.deepEqual(write.body, { replayCollectId: '51', replayCollectTemplateComponentId: '101', year: 2026, month: 11, day: 8, taskList: ['task-b'] })
  assert.equal(result.resources.relationId, '300'); assert.deepEqual(result.result.tasks[0], old[0])
  assert.deepEqual(mock.source.get('task-b'), { id: 'task-b', name: 'B', isDisplay: true })
  await assert.rejects(run('replay relations task link', { ...base, taskId: 'task-b' }, mock), { code: 'INVALID_INPUT' })
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1)
})
test('association writes reject wrong components, other writers, closed permissions and stale status before writing', async () => {
  for (const [input, options] of [[{ ...base, componentId: '999', taskId: 'task-b' }, {}], [{ ...base, taskId: 'task-b' }, { otherWriter: true }], [{ ...base, taskId: 'task-b' }, { noEdit: true }], [{ ...base, taskId: 'task-b' }, { stale: true }]]) {
    const mock = service(options)
    await assert.rejects(run('replay relations task link', input, mock))
    assert.equal(mock.calls.some(call => call.method === 'POST'), false)
  }
})
test('custom text set and clear only affect the actual text field of the actual association', async () => {
  const mock = service()
  let result = (await run('replay relations task text set', { ...base, relationId: '900', fieldId: '701', text: '问题 <plain>\n下一步' }, mock)).result
  assert.equal(result.tasks[0].fieldList[0].text, '问题 <plain>\n下一步')
  result = (await run('replay relations task text set', { ...base, relationId: '900', fieldId: '701', text: '' }, mock)).result
  assert.equal(result.tasks[0].fieldList[0].text, ''); assert.equal(result.tasks[0].fieldList[1].progress, 0)
  const writes = mock.calls.filter(call => call.method === 'PUT').length
  for (const [relationId, fieldId] of [['999', '701'], ['900', '702'], ['900', '999']]) await assert.rejects(run('replay relations task text set', { ...base, relationId, fieldId, text: 'bad' }, mock), { code: 'INVALID_INPUT' })
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, writes)
})
test('HTTP refresh observes changed source task names and preserves custom text; unlink preserves the source task', async () => {
  const mock = service(); mock.source.get('task-a').name = 'A updated'
  const refreshed = (await run('replay relations tasks refresh', base, mock, true)).result
  assert.equal(refreshed.tasks[0].name, 'A updated'); assert.equal(refreshed.tasks[0].fieldList[0].text, 'keep')
  const removed = (await run('replay relations task unlink', { ...base, relationId: '900' }, mock, true)).result
  assert.deepEqual(removed.tasks, []); assert.equal(mock.source.get('task-a').name, 'A updated')
  assert.equal(mock.calls.at(-1).path, '/task/api/v3/task')
})
test('ignored mutations fail independent readback and unknown writes are never replayed', async () => {
  const ignored = service({ ignoreWrite: true })
  await assert.rejects(run('replay relations task link', { ...base, taskId: 'task-b' }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(ignored.calls.filter(call => call.method === 'POST').length, 1)
  const refresh = service({ ignoreWrite: true }); refresh.source.get('task-a').name = 'Expected new name'
  await assert.rejects(run('replay relations tasks refresh', base, refresh, true), { code: 'BUSINESS_ASSERTION_FAILED' })
  const timeout = service({ timeout: true })
  await assert.rejects(run('replay relations task link', { ...base, taskId: 'task-b' }, timeout), error => {
    assert.equal(error.details.writeOutcome, 'unknown'); assert.equal(error.details.resources.replayComponentId, '501'); return true
  })
  assert.equal(timeout.calls.filter(call => call.method === 'POST').length, 1)
})
