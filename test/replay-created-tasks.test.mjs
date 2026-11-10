import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { accessPlan } from '../dist/access.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), base = { replayId: '91', componentId: '301' }
const flow = command => workflows.workflows.find(flow => flow.command === 'replay relations ' + command)
const run = (command, input, mock) => runWorkflow(ctx, flow(command), { ...base, ...input }, session, { transport: mock.transport })
function fixture(options = {}) {
  let reads = 0, taskReads = 0, tasks = [{ id: 'existing-task', name: 'Existing', members: [{ id: '1' }] }], created
  const calls = [], templates = [{ id: '401', icon: 1, name: 'Default', isDefault: !options.noDefault, isMilepost: !!options.milestone }, { id: '402', icon: 1, name: 'Custom', isDefault: !!options.duplicateDefault }]
  return { calls, transport: async (url, init) => {
    const call = { path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams), ...(typeof init.body === 'string' && { body: JSON.parse(init.body) }) }; calls.push(call)
    if (call.path === '/task/review/replay') { reads++; return json({ id: 91, replayCollectId: 51, year: 2026, month: 11, day: 8, type: 'day', status: options.stale && reads > 1 ? 'committed' : 'uncommitted', writer: { id: options.foreignWriter ? 2 : 1 }, editControl: { edit: true }, componentList: [{ id: 501, type: 'createTask', replayCollectTemplateComponentId: 301 }] }) }
    if (call.path === '/task/review/replay/collect') return json({ id: 51, type: 'day', name: 'Own fixture' })
    if (call.path.endsWith('/task/create/list')) { taskReads++; if (options.drift && taskReads === 2) tasks[0].name = 'Concurrent'; return json(tasks) }
    if (call.path.endsWith('/createTemplateList')) return json(templates)
    if (call.path.endsWith('/department/list')) return json([{ id: '7', name: 'Company', displayOrder: 1, type: 'top', parentId: null, childList: [], userList: [{ id: '1', showName: 'Me' }, { id: '9007199254740993', showName: 'Other' }] }])
    if (call.path.endsWith('/task/create')) {
      if (options.timeout) throw Error('unknown create outcome')
      created = { id: options.reused ? 'existing-task' : 'native-task-uuid', name: call.body.name, members: call.body.memberIds.split(',').map(id => ({ id })) }
      if (!options.ignoreWrite) tasks.push(created)
      return json(created)
    }
    if (call.path === '/task/api/v3/task') return json({ ...created, isDisplay: !options.hidden, taskTemplate: { id: options.wrongType ? '999' : calls.find(call => call.method === 'POST').body.taskTemplateId }, responsibilityId: calls.find(call => call.method === 'POST').body.responsibilityId })
    throw Error('Unexpected route ' + call.path)
  } }
}
test('native task context discovers actual tasks, current template choices and company members', async () => {
  const result = (await run('created-tasks context', {}, fixture())).result
  assert.equal(result.tasks[0].id, 'existing-task'); assert.equal(result.taskTemplates.length, 2)
  assert.equal(result.members[1].id, '9007199254740993')
  const mock = fixture(), plan = await runWorkflow(ctx, flow('task create'), { ...base, name: 'New' }, null, { dryRun: true, transport: mock.transport })
  assert.equal(plan.effect, 'write'); assert.equal(mock.calls.length, 0)
  assert.deepEqual(accessPlan(flow('task create'), { taskTemplateId: '402' }).features.sort(), ['PLAN', 'REPLAY', 'TASK_TYPE'])
})
test('native task creation persists actual relation and independently verifies Task HTTP', async () => {
  const mock = fixture(), result = await run('task create', { name: 'New', memberIds: ['1', '9007199254740993'], responsibilityId: '1' }, mock)
  assert.equal(result.resources.taskId, 'native-task-uuid'); assert.equal(result.result.createdTaskId, 'native-task-uuid')
  assert.equal(result.result.tasks[0].id, 'existing-task')
  const request = mock.calls.find(call => call.method === 'POST')
  assert.equal(request.body.taskTemplateId, '401'); assert.equal(request.body.memberIds, '1,9007199254740993'); assert.equal(request.body.replayCollectTemplateComponentId, '301'); assert.equal(request.body.day, 8)
  assert.equal(mock.calls.at(-1).path, '/task/api/v3/task')
})
test('default task type must be unique and nonmilestone; arbitrary members and types are refused', async () => {
  for (const [input, options] of [[{}, { duplicateDefault: true }], [{}, { noDefault: true }], [{}, { milestone: true }], [{ taskTemplateId: '999' }, {}], [{ memberIds: ['99'] }, {}], [{ responsibilityId: '99' }, {}], [{ name: '  ' }, {}]]) {
    const mock = fixture(options); await assert.rejects(run('task create', { name: 'New', ...input }, mock)); assert.equal(mock.calls.filter(call => call.method === 'POST').length, 0)
  }
})
test('stale status, foreign writer and changed task context stop before creation', async () => {
  for (const options of [{ stale: true }, { foreignWriter: true }, { drift: true }]) {
    const mock = fixture(options); await assert.rejects(run('task create', { name: 'New' }, mock)); assert.equal(mock.calls.filter(call => call.method === 'POST').length, 0)
  }
})
test('readback failures retain created task UUID and completed steps without retrying creation', async () => {
  for (const options of [{ ignoreWrite: true }, { hidden: true }, { wrongType: true }]) {
    const mock = fixture(options)
    await assert.rejects(run('task create', { name: 'New' }, mock), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.taskId === 'native-task-uuid' && error.details.completedSteps.includes('changed'))
    assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1)
  }
})
test('unknown creation is reported once; a reused ID never passes as a newly created task', async () => {
  const unknown = fixture({ timeout: true }); await assert.rejects(run('task create', { name: 'New' }, unknown), error => error.details.writeOutcome === 'unknown'); assert.equal(unknown.calls.filter(call => call.method === 'POST').length, 1)
  const reused = fixture({ reused: true }); await assert.rejects(run('task create', { name: 'New' }, reused), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(reused.calls.filter(call => call.path === '/task/api/v3/task').length, 0)
})
