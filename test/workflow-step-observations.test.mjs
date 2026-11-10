import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const target = { processId: '9223372036854775801', stepId: '9223372036854775802' }, applicationId = '9223372036854775803', originId = '9223372036854775804', key = [applicationId, target.processId, originId].join('-')
const json = data => new Response(JSON.stringify({ code: 200, data }), { headers: { 'content-type': 'application/json' } })
const flow = command => workflows.workflows.find(flow => flow.command === command)
function fixture(branch = 'valid', tasks = false) {
  const calls = [], process = { id: target.processId, flowAppId: applicationId, status: 'doing', processInfoStepList: [{ id: target.stepId }], editControl: { read: true } }
  const step = { id: target.stepId, processInfoId: target.processId, applicationId, originId, status: 'doing', editControl: { fillStepForm: true } }
  let processReads = 0, stepReads = 0
  return { calls, transport: async (url, init) => {
    calls.push({ method: init.method, path: url.pathname })
    if (url.pathname.endsWith('/details')) { processReads++; return json({ ...process, ...(branch === 'changed-permission' && processReads === 2 && { editControl: { read: false } }) }) }
    if (url.pathname.endsWith('/step')) {
      stepReads++; return json({ ...step, ...(branch === 'cross-instance' && { processInfoId: '9999' }), ...(branch === 'wrong-instance-step' && { id: '9999' }), ...(branch === 'missing-origin' && { originId: null }), ...(branch === 'changed-state' && stepReads === 2 && { status: 'passed' }) })
    }
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { idList: [{ processInfoId: target.processId, flowApplicationId: applicationId, stepInfoId: originId }] })
    const data = tasks ? [{ id: '9223372036854775805', name: 'second', isDone: false }, { id: '9223372036854775806', name: 'first', isDone: true }] : { status: 'executing', operateDuration: '0.0秒', stepExecutors: [] }
    return json(branch === 'empty-map' ? {} : { [key]: data, ...(branch === 'extra-context' && { '8000-9000-8200': data }) })
  } }
}
test('current step timing and task queries derive the definition ID, preserve 64-bit IDs and reread actual state and permission', async () => {
  for (const tasks of [false, true]) {
    const command = tasks ? 'workflow instance step tasks list' : 'workflow instance step timing', server = fixture('valid', tasks)
    const output = await runWorkflow(ctx, flow(command), target, session, { transport: server.transport })
    assert.deepEqual(server.calls.map(call => call.method), ['GET', 'GET', 'POST', 'GET', 'GET'])
    assert.equal(output.result.stepId, target.stepId); assert.equal(output.result.definitionStepId, originId); assert.equal(output.result.proof.contextReadBack, true)
    if (tasks) assert.deepEqual(output.result.tasks.map(task => task.name), ['second', 'first'])
    else assert.equal(output.result.timing.operateDuration, '0.0秒')
    assert.match(workflowSchema(flow(command)).recovery, /定义步骤 ID/)
  }
})
test('wrong instance, wrong returned step and absent origin ID stop before any observation POST', async () => {
  for (const branch of ['cross-instance', 'wrong-instance-step', 'missing-origin']) {
    const server = fixture(branch)
    await assert.rejects(runWorkflow(ctx, flow('workflow instance step timing'), target, session, { transport: server.transport }), { code: 'CONTEXT_MISSING' })
    assert.equal(server.calls.filter(call => call.method === 'POST').length, 0)
  }
})
test('missing or extra observation keys and changed status or permission never become successful reads', async () => {
  for (const branch of ['empty-map', 'extra-context', 'changed-permission', 'changed-state']) {
    const server = fixture(branch)
    await assert.rejects(runWorkflow(ctx, flow('workflow instance step timing'), target, session, { transport: server.transport }), { code: branch.startsWith('changed-') ? 'CONTEXT_CONFLICT' : 'BUSINESS_ASSERTION_FAILED' })
    assert.equal(server.calls.length, 5)
  }
})
test('step reads are discoverable and offline dry-run performs zero HTTP; raw ID batches stay gated', async () => {
  for (const command of ['workflow instance step timing', 'workflow instance step tasks list']) {
    let calls = 0
    assert.equal((await runWorkflow(ctx, flow(command), target, null, { dryRun: true, transport: async () => { calls++; throw Error('unexpected network') } })).dryRun, true)
    assert.equal(calls, 0)
    const operation = catalog.operations.find(operation => operation.id === flow(command).steps[2].operationId)
    await assert.rejects(executeOperation(ctx, operation, { body: { idList: [{ processInfoId: target.processId, flowApplicationId: applicationId, stepInfoId: originId }] } }, session, { transport: async () => { calls++; throw Error('unexpected network') } }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
    assert.equal(calls, 0)
  }
})
test('removing definition-step preparation or context readback is rejected at runtime and by coverage', async () => {
  for (const mutate of [flow => { delete flow.steps[2].prepare }, flow => { delete flow.steps[4].verify }]) {
    const altered = structuredClone(flow('workflow instance step timing')); mutate(altered); let calls = 0
    await assert.rejects(runWorkflow(ctx, altered, target, session, { transport: async () => { calls++; throw Error('unexpected network') } }), { code: 'INVALID_CONTRACT' })
    assert.equal(calls, 0)
    assert.ok(auditWorkflows({ workflows: [altered] }, catalog, { domains: [] }).length > 0)
  }
})
