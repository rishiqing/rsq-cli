import test from 'node:test'
import assert from 'node:assert/strict'
import { readCreatedTask, validateTaskCreationVisibility } from '../dist/task-creation-readback.js'
import { RsqError } from '../dist/core.js'
import { catalog } from '../dist/operations.js'
import { workflows } from '../dist/workflows.js'
const flow = () => structuredClone(workflows.workflows.find(row => row.command === 'project task create'))
const input = { projectId: '7001' }, results = { created: { id: 'own-new-root' }, taskContext: { projectTask: true }, createdTaskChildren: [{ id: 'own-new-child' }] }, completed = ['created']
const op = catalog.operations.find(row => row.route === '/task/api/v3/task' && row.method === 'GET')
const denied = () => new RsqError('BUSINESS_ERROR', 'not visible yet', 4, { httpStatus: 400, upstreamCode: 401005 })
test('bounded creation visibility retries only the one explicit upstream rejection and exact created ID', async () => {
  for (const child of [false, true]) {
    const current = flow(), step = current.steps.find(row => row.id === (child ? 'verifiedTaskChildren' : 'verifiedTask')), taskId = child ? 'own-new-child' : 'own-new-root'
    let calls = 0; const waits = []
    const value = await readCreatedTask(current, step, op, { query: { id: taskId, module: 'project', siteId: '7001' } }, input, results, completed, child ? { id: taskId } : undefined, async () => { if (++calls < 3) throw denied(); return { id: taskId } }, async delay => waits.push(delay))
    assert.equal(calls, 3); assert.deepEqual(waits, [1000, 1000]); assert.equal(value.id, taskId)
  }
})
test('network failure, general permission denial, login expiry and other business errors are not retried', async () => {
  for (const error of [new TypeError('network lost'), new RsqError('AUTH_EXPIRED', 'expired', 3), new RsqError('FORBIDDEN', 'forbidden', 4), new RsqError('BUSINESS_ERROR', 'different rejection', 4, { httpStatus: 403, upstreamCode: 401005 }), new RsqError('BUSINESS_ERROR', 'different business', 4, { httpStatus: 400, upstreamCode: 400001 })]) {
    const current = flow(), step = current.steps.find(row => row.id === 'verifiedTask'); let calls = 0
    await assert.rejects(readCreatedTask(current, step, op, { query: { id: 'own-new-root', module: 'project', siteId: '7001' } }, input, results, completed, undefined, async () => { calls++; throw error }, async () => assert.fail('must not wait')), value => value === error); assert.equal(calls, 1)
  }
})
test('unrelated task, wrong scene, absent creation receipt and other workflow cannot enter visibility recovery', async () => {
  const current = flow(), step = current.steps.find(row => row.id === 'verifiedTask')
  for (const [query, prior, finished] of [[{ id: 'someone-else', module: 'project', siteId: '7001' }, results, completed], [{ id: 'own-new-root', module: 'common', siteId: '7001' }, results, completed], [{ id: 'own-new-root', module: 'project', siteId: '7999' }, results, completed], [{ id: 'own-new-root', module: 'project', siteId: '7001' }, {}, completed], [{ id: 'own-new-root', module: 'project', siteId: '7001' }, results, []]]) await assert.rejects(readCreatedTask(current, step, op, { query }, input, prior, finished, undefined, async () => assert.fail('no HTTP')), { code: 'INVALID_CONTRACT' })
  assert.throws(() => validateTaskCreationVisibility({ ...current, command: 'task inspect' }, step), { code: 'INVALID_CONTRACT' })
  assert.throws(() => validateTaskCreationVisibility(current, { ...step, creationVisibility: { attempts: 100, delayMs: 1 } }), { code: 'INVALID_CONTRACT' })
  assert.throws(() => validateTaskCreationVisibility(current, { ...step, creationVisibility: { attempts: 5, delayMs: 1000, retryWrite: true } }), { code: 'INVALID_CONTRACT' })
})
test('exhausted visibility preserves the upstream refusal and exact resource without replaying mutation', async () => {
  const current = flow(), step = current.steps.find(row => row.id === 'verifiedTask'); let calls = 0, waits = 0
  await assert.rejects(readCreatedTask(current, step, op, { query: { id: 'own-new-root', module: 'project', siteId: '7001' } }, input, results, completed, undefined, async () => { calls++; throw denied() }, async () => { waits++ }), error => { assert.equal(error.code, 'BUSINESS_ERROR'); assert.deepEqual(error.details.creationVisibility, { attempts: 5, taskId: 'own-new-root', exhausted: true }); assert.equal(error.details.automaticallyRetriedWrite, false); return true })
  assert.equal(calls, 5); assert.equal(waits, 4)
})
