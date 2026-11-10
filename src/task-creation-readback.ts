import { asObject, RsqError, type JsonObject } from './core.js'
import { catalog, type Operation } from './operations.js'
import type { Workflow } from './workflows.js'

export type TaskCreationVisibility = { attempts: number; delayMs: number }
type Step = Workflow['steps'][number]
const supported = new Set(['project task create', 'project template task create'])
const invalid = (): never => { throw new RsqError('INVALID_CONTRACT', '新任务归属重查只能用于已核对创建流程中的准确任务详情。', 6) }
export function validateTaskCreationVisibility(flow: Workflow, step: Step) {
  if (!step.creationVisibility) return
  const read = catalog.operations.find(op => op.id === step.operationId), create = catalog.operations.find(op => op.id === flow.steps.find(row => row.id === 'created')?.operationId)
  if (!supported.has(flow.command) || !['verifiedTask', 'verifiedTaskChildren'].includes(step.id) || step.creationVisibility.attempts !== 5 || step.creationVisibility.delayMs !== 1000
    || Object.keys(step.creationVisibility).sort().join(',') !== 'attempts,delayMs' || read?.method !== 'GET' || read.route !== '/task/api/v3/task' || create?.method !== 'POST' || create.route !== '/task/api/v3/task'
    || step.collectPages || step.expectAbsent || step.waitBeforeMs || step.readback || step.transfer || step.authentication) invalid()
}
/** The create event builds TaskAscription asynchronously, before same-team reads succeed. */
export async function readCreatedTask(flow: Workflow, step: Step, op: Operation, args: JsonObject, input: JsonObject, results: JsonObject, completed: string[], item: unknown, read: () => Promise<unknown>, delay: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  validateTaskCreationVisibility(flow, step)
  if (!step.creationVisibility) return read()
  const query = asObject(args.query), created = asObject(results.created), original = asObject(results.taskContext)
  const target = step.id === 'verifiedTask' ? created.id : asObject(item).id
  if (op.method !== 'GET' || op.route !== '/task/api/v3/task' || !completed.includes('created') || original.projectTask !== true || typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target)
    || query.id !== target || query.module !== 'project' || String(query.siteId) !== input.projectId || typeof created.id !== 'string'
    || step.id === 'verifiedTaskChildren' && (!Array.isArray(results.createdTaskChildren) || !results.createdTaskChildren.some(row => asObject(row).id === target))) invalid()
  for (let attempt = 1; ; attempt++) {
    try { return await read() }
    catch (error) {
      // Neither network errors, expired sessions nor general HTTP forbiddens are retried.
      if (!(error instanceof RsqError) || error.code !== 'BUSINESS_ERROR' || asObject(error.details).httpStatus !== 400 || asObject(error.details).upstreamCode !== 401005) throw error
      if (attempt >= step.creationVisibility.attempts) throw new RsqError(error.code, error.message, error.exit, { ...asObject(error.details), creationVisibility: { attempts: attempt, taskId: target, exhausted: true }, automaticallyRetriedWrite: false })
      await delay(step.creationVisibility.delayMs)
    }
  }
}
