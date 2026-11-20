import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'

export const usageManifest = JSON.parse(readFileSync(new URL('../contracts/arms-usage-http.json', import.meta.url), 'utf8')) as { operations: unknown[]; workflows: Workflow[] }
export function usageError(code: string, message: string, details?: JsonObject): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : code === 'INVALID_INPUT' ? 2 : 5, details) }
export function requireUsage(value: unknown, message: string): asserts value { if (!value) usageError('BUSINESS_ASSERTION_FAILED', message) }
export const usageRows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : usageError('RESPONSE_SCHEMA_MISMATCH', '服务没有返回预期列表。')
export const usageData = (value: unknown): JsonObject => asObject(Object.hasOwn(asObject(value), 'data') ? asObject(value).data : value)
export const usageList = (value: unknown): JsonObject[] => usageRows(Object.hasOwn(asObject(value), 'data') ? asObject(value).data : value)
export const usageId = (value: unknown): string => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : usageError('CONTEXT_MISSING', '缺少精确资源标识。')
export const usageHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function usageDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) usageError('INVALID_INPUT', '日期需要有效的 YYYY-MM-DD，按 GMT+8 日历解释。')
  return value as string
}
export function usageSnapshotPage(items: JsonObject[], input: JsonObject, binding: unknown) {
  const query = usageHash(binding), snapshot = usageHash(items), limit = Number(input.limit ?? 50)
  let offset = 0
  if (input.cursor !== undefined) {
    let cursor: JsonObject
    try { cursor = asObject(JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8'))) } catch { return usageError('INVALID_INPUT', '分页游标无效。') }
    if (cursor.query !== query || cursor.snapshot !== snapshot) usageError('CONTEXT_CONFLICT', '查询条件、身份或结果已改变，请从第一页重新发现；没有重复执行写操作。')
    if (!Number.isSafeInteger(cursor.offset) || Number(cursor.offset) <= 0 || Number(cursor.offset) >= items.length) usageError('INVALID_INPUT', '分页偏移无效。')
    offset = Number(cursor.offset)
  }
  const selected = items.slice(offset, offset + limit), next = offset + selected.length
  return { items: selected, total: items.length, limit, offset, nextCursor: next < items.length ? Buffer.from(JSON.stringify({ query, snapshot, offset: next })).toString('base64url') : null, pagination: 'local-stable-snapshot', snapshotVersion: snapshot }
}
export function validateUsageWorkflow(flow: Workflow) {
  const expected = usageManifest.workflows?.find(item => item.id === flow.id)
  if (!expected || expected.command !== flow.command || expected.effect !== flow.effect || expected.usageAction !== flow.usageAction || expected.usageTemplate !== flow.usageTemplate || expected.usageProject !== flow.usageProject || expected.workflowScope !== flow.workflowScope || !isDeepStrictEqual(expected.steps, flow.steps)) usageError('INVALID_CONTRACT', 'ARMS 业务命令必须保留已经核对的上下文、执行步骤与副作用。')
}
export type UsageRuntime = ReturnType<typeof usageRuntime>
export function usageRuntime(ctx: Context, flow: Workflow, supplied: Session | null, options: { transport?: Transport; approved?: boolean; timeoutMs?: number }) {
  const session = requireSession(supplied), completed: string[] = [], resources: JsonObject = {}
  let phase = 'context', mutationAttempted = false
  const runtime = { ctx, flow, session, options, completed, resources,
    async call(method: string, route: string, args: JsonObject = {}, label = method + ' ' + route): Promise<unknown> {
      phase = label
      const op = flow.steps.map(step => catalog.operations.find(op => op.id === step.operationId)!).find(op => op.method === method && op.route === route)
      if (!op) usageError('INVALID_CONTRACT', '业务请求没有登记在当前命令步骤中：' + method + ' ' + route)
      if (op.effect !== 'read') mutationAttempted = true
      const value = await runOperation(ctx, op, args, session, { ...options, transport: options.transport ?? request })
      completed.push(label); return value
    },
    async existing(command: string, input: JsonObject): Promise<JsonObject> {
      phase = command
      const { workflows } = await import('./workflows.js'), { executeWorkflow } = await import('./dispatch.js')
      const target = workflows.workflows.find(item => item.command === command)
      if (!target || target.steps.some(step => !flow.steps.some(allowed => allowed.operationId === step.operationId))) usageError('INVALID_CONTRACT', '当前命令没有登记所需的资源上下文：' + command)
      if (target.effect !== 'read') mutationAttempted = true
      const out = asObject(await executeWorkflow(ctx, target, input, session, options))
      Object.assign(resources, asObject(out.resources))
      const scope = asObject(out.scope)
      if (scope.kind === 'project') Object.assign(resources, { projectId: scope.projectId, applicationId: scope.applicationId, moduleId: scope.moduleId })
      completed.push(command)
      return asObject(out.result)
    },
    async identity() {
      const actor = usageData(await runtime.call('GET', '/task/login/authAjax'))
      requireUsage(usageId(actor.id) === session.identity.userId && usageId(asObject(actor.team).id) === session.identity.teamId, '当前远程身份与 profile 不一致。')
      return actor
    },
    finish(result: unknown) { return { command: flow.command, completedSteps: completed, resources, result } },
    fail(error: unknown): never {
      const cause = error instanceof RsqError ? error : new RsqError('UNEXPECTED_ERROR', error instanceof Error ? error.message : '业务执行失败。', 1)
      throw new RsqError(cause.code, cause.message, cause.exit, { ...cause.details, completedSteps: completed, resources: { ...resources, ...asObject(cause.details?.resources) }, failedStep: phase, ...(mutationAttempted && { writeOutcome: ['NETWORK_ERROR','TIMEOUT','REQUEST_TIMEOUT'].includes(cause.code) ? 'unknown' : 'partial-or-readback-failed', writeReplay: false }) })
    },
  }
  return runtime
}
