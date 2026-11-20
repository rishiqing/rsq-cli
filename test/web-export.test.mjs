import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeWorkflow } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'

const ctx = { environment: 'production', profile: 'export-fixture' }
const session = { method: 'password', identity: { userId: '81', teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 60000 }
const flow = command => workflows.workflows.find(item => item.command === command)
const execute = (command, input, options) => executeWorkflow(ctx, flow(command), input, session, options)
const trigger = command => catalog.operations.find(op => op.id === flow(command).steps.at(-1).operationId)
const reply = data => Response.json(data)

function projectTransport(calls, { permitted = true, wrongModule = false, responses = {},
  onExport = () => new Response(null, { status: 204 }) } = {}) {
  return async (url, request) => {
    calls.push({ path: url.pathname, method: request.method, query: Object.fromEntries(url.searchParams),
      ...(request.body && { body: JSON.parse(request.body) }) })
    if (Object.hasOwn(responses, url.pathname)) return reply(responses[url.pathname])
    switch (url.pathname) {
      case '/task/login/authAjax': return reply({ success: true, id: 81, username: 'fixture', team: { id: 7, name: 'Fixture' }, token: 'fixture' })
      case '/task/ordercenter/v2/member/state/independent': return reply({ deadLine: '2100-01-01 00:00:00', userLimit: 5, usersCount: 2, mainApp: 'rsq', vt: 'test' })
      case '/task/ordercenter/v2/function/available': return reply([])
      case '/task/authority/v3/authorities/company/current': return reply({ useKanban: true })
      case '/task/v1/kanbanCrud': return reply({ id: '100', coverId: null, editControl: { exportKanban: permitted } })
      case '/task/v1/kanbanChildCrud/list': return reply([{ id: wrongModule ? '201' : '200', name: 'Fixture module', type: 'task' }])
      case '/task/v3/taskTemplate/kanbanChildUsedTaskTemplate': return reply([{ fieldList: [{ id: 10, isSelected: false }, { id: 11, isSelected: true }] }])
      case '/task/v1/kanbanExport/setFilterCondition': return reply({ code: 200 })
      case '/task/v4/kanbanChild/exportExcel': return onExport()
      default: assert.fail('Unexpected request ' + url.pathname)
    }
  }
}

test('task export uses the selected module, webpage columns and filter preparation', async () => {
  const calls = [], command = 'project module tasks export'
  const filters = [{ key: 'taskName', operators: ['包含'], contentValue: 'fixture' }]
  const input = { projectId: '100', moduleId: '200', filters }
  const result = await execute(command, input, { transport: projectTransport(calls) })
  assert.deepEqual(result.result, { status: 'accepted', receiver: 'export watch' })
  assert.deepEqual(calls.slice(-2), [
    { path: '/task/v1/kanbanExport/setFilterCondition', method: 'POST', body: { id: 200, filter: filters }, query: {} },
    { path: '/task/v4/kanbanChild/exportExcel', method: 'GET', query: { id: '200', fieldIds: '11' } }
  ])
  const preview = await execute(command, input, { dryRun: true, transport: () => assert.fail('offline preview should not connect') })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.steps.at(-1).effect, 'write')
})

test('task export checks project rights, parent module and fields before requesting an export', async () => {
  const command = 'project module tasks export'
  const input = { projectId: '100', moduleId: '200' }
  for (const [options, args, code] of [
    [{ permitted: false }, {}, 'FORBIDDEN'],
    [{ wrongModule: true }, {}, 'FORBIDDEN'],
    [{}, { fieldIds: '12' }, 'INVALID_INPUT'],
  ]) {
    const calls = []
    await assert.rejects(execute(command, { ...input, ...args }, { transport: projectTransport(calls, options) }), { code })
    assert.ok(calls.every(call => call.method === 'GET' && call.path !== trigger(command).route))
  }
})

test('HTTP success with a business error is not an export acceptance, and write failures are not replayed', async () => {
  const command = 'project module tasks export', input = { projectId: '100', moduleId: '200' }
  for (const [onExport, code] of [[() => reply({ code: 401007 }), 'FORBIDDEN'], [() => { throw Error('timeout') }, 'NETWORK_ERROR']]) {
    const calls = []
    await assert.rejects(execute(command, input, { transport: projectTransport(calls, { onExport }) }), { code })
    assert.equal(calls.filter(call => call.path === trigger(command).route).length, 1)
  }
})

test('OKR statistics reads and export use the role from the same business context', async () => {
  for (const [command, input] of [
    ['okr statistics context', {}],
    ['okr statistics report export', { cycleId: '123', objectiveType: 'person' }],
  ]) {
    const calls = [], transport = projectTransport(calls, { responses: {
      '/task/okr/objective/sidebar': { editControl: { statisticsVisible: false } },
    } })
    await assert.rejects(execute(command, input, { transport }), { code: 'FORBIDDEN' })
    assert.equal(calls.at(-1).path, '/task/okr/objective/sidebar')
  }
})

test('appraisal detail export must bind the indicator to the actor’s visible assessment', async () => {
  const command = 'appraisal statistics monthly details export', input = { appraisalId: '123', indicatorId: '456' }
  const envelope = data => ({ code: 200, data })
  for (const [assessmentId, indicatorId, exportable] of [[123, 456, true], [999, 456, false], [123, 999, false]]) {
    const calls = [], transport = projectTransport(calls, { responses: {
      '/task/performance/init': envelope({ hasInit: true }),
      '/task/performance/authority/role': envelope({ authorities: {} }),
      '/task/performance/appraisal': envelope({ id: assessmentId }),
      '/task/performance/v2/content': envelope({ dimensions: [{ type: 'monthlyAppraisalData', indicators: [{ id: indicatorId, detail: { detailType: 'monthlyAppraisalData' } }] }] }),
      [trigger(command).route]: { code: 200 },
    } })
    if (exportable) assert.equal((await execute(command, input, { transport })).result.status, 'accepted')
    else await assert.rejects(execute(command, input, { transport }), { code: assessmentId === 123 ? 'FORBIDDEN' : 'BUSINESS_ASSERTION_FAILED' })
    assert.equal(calls.some(call => call.path === trigger(command).route), exportable)
  }
})

test('replay export verifies the document’s actual role before requesting a file', async () => {
  const command = 'replay entry export'
  for (const permission of [true, false, undefined]) {
    const calls = [], transport = projectTransport(calls, { responses: {
      '/task/review/replay': { id: 101, editControl: { export: permission } },
      [trigger(command).route]: { code: 200 },
    } })
    if (permission === true) assert.equal((await execute(command, { replayId: '101' }, { transport })).result.status, 'accepted')
    else await assert.rejects(execute(command, { replayId: '101' }, { transport }), { code: 'FORBIDDEN' })
    assert.equal(calls.some(call => call.path === trigger(command).route), permission === true)
  }
})
