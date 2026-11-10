// Public command dispatch. Low-level HTTP helpers remain usable for building
// preflight context; the CLI and live business runners enter through here.
import { accessDescription, checkAccess } from './access.js'
import { catalog, runOperation, type Operation } from './operations.js'
import { runWorkflow, type Workflow } from './workflows.js'
import { asObject, RsqError, type Context, type JsonObject } from './core.js'
import type { Session } from './session.js'

export async function executeOperation(ctx: Context, op: Operation, input: JsonObject, session: Session | null, options: Parameters<typeof runOperation>[4] = {}) {
  // Validate input, protocol and confirmation before any preflight network.
  const plan = await runOperation(ctx, op, input, session, { ...options, dryRun: true })
  if (options.dryRun) return { ...asObject(plan), access: accessDescription(op, input) }
  if (op.requiresBusinessContext?.length) throw new RsqError('BUSINESS_CONTEXT_REQUIRED', '此传输操作需要业务命令先核对资源归属、动态定义和 UI 权限。', 2, { commands: op.requiresBusinessContext, operationId: op.id })
  if (op.effect === 'destructive' && !options.approved || op.review !== 'reviewed') return runOperation(ctx, op, input, session, options)
  await checkAccess(ctx, op, input, session, options.transport)
  return runOperation(ctx, op, input, session, options)
}
export async function executeWorkflow(ctx: Context, flow: Workflow, input: JsonObject, session: Session | null, options: Parameters<typeof runWorkflow>[4] = {}) {
  const plan = await runWorkflow(ctx, flow, input, session, { ...options, dryRun: true })
  if (options.dryRun) return { ...plan, access: accessDescription(flow, input) }
  if (flow.effect === 'destructive' && !options.approved || flow.steps.some(step => !catalog.operations.some(op => op.id === step.operationId && op.review === 'reviewed'))) return runWorkflow(ctx, flow, input, session, options)
  await checkAccess(ctx, flow, input, session, options.transport)
  return runWorkflow(ctx, flow, input, session, options)
}
