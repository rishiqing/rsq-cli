import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareWorkspaceTask } from '../dist/workspace-tasks.js'
import { runWorkflow, workflows } from '../dist/workflows.js'

const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const args = { name: '工作区任务', groupId: 'custom-1', dates: { start: '2026-11-09', end: '2026-11-09' } }
const actionInput = { ...args, type: 'my', startDate: '2026.11.09', endDate: '2026.11.09' }
const executionInput = { ...args, type: 'user', startDate: '2026-11-09', endDate: '2026-11-09' }
function state() {
  return { memberScope: { taskExecutorScope: [81, 82] }, departments: [], staffGroups: [], mode: { mode: 'taskOnly' },
    views: [{ id: '101', isSelected: true, subView: 'kanban', viewType: 'list', group: 'custom', sort: 'custom', dateRangeType: 'month' }],
    selectedFilters: { filter: [] }, actionQuery: { type: 'my', groupType: 'custom' },
    groups: { effectiveMode: 'taskOnly', editControl: { createTask: true }, groupList: [{ id: 'custom-1', name: '实际分组' }] } }
}
test('workspace creation binds visible groups and uses the two distinct UI attachment keys', () => {
  const action = prepareWorkspaceTask('workspace-task-action', actionInput, state(), session).body
  const execution = prepareWorkspaceTask('workspace-task-execution', executionInput, state(), session).body
  assert.equal(action.groupId, 'custom-1'); assert.ok(!Object.hasOwn(action, 'executionGroupId'))
  assert.equal(execution.executionGroupId, 'custom-1'); assert.ok(!Object.hasOwn(execution, 'groupId'))
  assert.equal(action.memberIds, '81'); assert.equal(action.realStartDate, '2026-11-09')
  assert.throws(() => prepareWorkspaceTask('workspace-task-action', { ...actionInput, groupId: 'guessed' }, state(), session), { code: 'CONTEXT_NOT_FOUND' })
})
test('workspace creation preserves UI create permission and executor restrictions', () => {
  const denied = state(); denied.groups.editControl.createTask = false
  assert.throws(() => prepareWorkspaceTask('workspace-task-action', actionInput, denied, session), { code: 'FORBIDDEN' })
  assert.throws(() => prepareWorkspaceTask('workspace-task-execution', { ...executionInput, memberIds: ['99'] }, state(), session), { code: 'FORBIDDEN' })
  const userGroup = state(); userGroup.groups.groupList[0].userId = 82
  assert.equal(prepareWorkspaceTask('workspace-task-execution', executionInput, userGroup, session).body.memberIds, '82')
  assert.throws(() => prepareWorkspaceTask('workspace-task-execution', { ...executionInput, memberIds: ['81'] }, userGroup, session), { code: 'INVALID_INPUT' })
})
test('mixed execution mode can create in an actual ordinary group without changing company mode', () => {
  const context = state(); context.mode.mode = 'taskAndWorkflowTodo'; context.groups.effectiveMode = 'taskAndWorkflowTodo'
  context.views[0].group = 'priority'; context.groups.groupList[0] = { id: '2', priorityV2: 2 }
  const prepared = prepareWorkspaceTask('workspace-task-execution', { ...executionInput, groupId: '2' }, context, session)
  assert.equal(prepared.body.executionGroupId, '2'); assert.equal(prepared.body.priorityV2, 2)
  assert.equal(context.taskBusiness.expected.priorityV2, 2)
  const fallback = state(); fallback.views[0].group = 'taskType'; fallback.groups.groupList[0].groupType = 'custom'
  assert.throws(() => prepareWorkspaceTask('workspace-task-execution', executionInput, fallback, session), { code: 'CONTEXT_MISSING' })
  const typed = state(); typed.groups.groupList[0].taskTemplateId = 9001
  assert.throws(() => prepareWorkspaceTask('workspace-task-execution', executionInput, typed, session), { code: 'UNSUPPORTED_CONTEXT' })
})
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
for (const [domain, input] of [['action', actionInput], ['execution', executionInput]]) test(domain + ' task create sends once, independently reads the task and supports offline dry-run', async () => {
  const flow = workflows.workflows.find(item => item.command === domain + ' task create'), context = state(), calls = []
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method: init.method, body })
    if (url.pathname.endsWith('/department/list') || url.pathname.endsWith('/staffGroupCrud/list')) return json([])
    if (url.pathname.endsWith('/displayMode')) return json(context.mode)
    if (url.pathname.endsWith('/view/list')) return json(context.views)
    if (url.pathname.endsWith('/filter/selected')) return json(context.selectedFilters)
    if (url.pathname.endsWith('/view/filter')) return json({ filter: [] })
    if (url.pathname.endsWith('/group/list')) return json(context.groups)
    if (url.pathname.endsWith('/scopes/company/current')) return json(context.memberScope)
    if (url.pathname === '/task/api/v3/task') return json({ id: 'task-1', name: input.name, members: [{ id: 81 }], realStartDate: '2026-11-09', realEndDate: '2026-11-09' })
    throw Error('Unexpected request ' + url.pathname)
  }
  const result = await runWorkflow({ environment: 'production', profile: 'fixture' }, flow, input, session, { transport })
  assert.equal(result.result.name, input.name)
  assert.equal(calls.filter(call => call.path === '/task/api/v3/task' && call.method === 'POST').length, 1)
  assert.equal(calls.at(-1).method, 'GET')
  const dryRun = await runWorkflow({ environment: 'production', profile: 'fixture' }, flow, input, null, { dryRun: true, transport: () => { throw Error('Network forbidden') } })
  assert.equal(dryRun.dryRun, true)
})
test('a task readback mismatch reports the created resource and does not replay creation', async () => {
  const flow = workflows.workflows.find(item => item.command === 'action task create'), context = state(); let writes = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/view/list')) return json(context.views)
    if (url.pathname.endsWith('/group/list')) return json(context.groups)
    if (url.pathname.endsWith('/scopes/company/current')) return json(context.memberScope)
    if (init.method === 'POST') { writes++; return json({ id: 'task-1' }) }
    return json({ id: 'task-1', name: '不同结果', members: [{ id: 81 }], realStartDate: '2026-11-09', realEndDate: '2026-11-09' })
  }
  await assert.rejects(runWorkflow({ environment: 'production', profile: 'fixture' }, flow, actionInput, session, { transport }), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.resources.taskId === 'task-1')
  assert.equal(writes, 1)
})
