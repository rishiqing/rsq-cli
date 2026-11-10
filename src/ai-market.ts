import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'

export type AiMarketAction = 'list' | 'get' | 'subscription-list' | 'subscription-status' | 'preset-status' | 'subscribe' | 'unsubscribe' | 'conversation-create' | 'conversation-resolve'
type Route = [string, string, string]
const root = '/task/agent/v1/market'
const actions: AiMarketAction[] = ['list', 'get', 'subscription-list', 'subscription-status', 'preset-status', 'subscribe', 'unsubscribe', 'conversation-create', 'conversation-resolve']
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, 5) }
const textId = (value: unknown): string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 ? value : fail('AI 员工上下文缺少精确 ID。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rows = (value: unknown) => Array.isArray(value) ? value.map(asObject) : fail('AI 员工分页缺少条目数组。')
export function aiMarketSteps(action: AiMarketAction): Route[] {
  const identity: Route = ['identity', 'GET', '/task/login/authAjax'], agent: Route = ['agent', 'GET', root + '/agents/{agentId}'], status: Route = ['status', 'GET', root + '/agents/{agentId}/subscription-status']
  if (action === 'list') return [identity, ['items', 'GET', root + '/agents']]
  if (action === 'subscription-list') return [identity, ['items', 'GET', root + '/subscriptions']]
  if (action === 'preset-status') return [identity, ['status', 'GET', root + '/builtin-agents/{presetType}/subscription-status']]
  if (action === 'get' || action === 'subscription-status') return [identity, agent, status]
  if (action === 'subscribe' || action === 'unsubscribe') return [identity, agent, status, ['subscriptions', 'GET', root + '/subscriptions'], ['agentPreflight', 'GET', root + '/agents/{agentId}'], ['statusPreflight', 'GET', root + '/agents/{agentId}/subscription-status'], ['changed', action === 'subscribe' ? 'POST' : 'DELETE', action === 'subscribe' ? root + '/agents/{agentId}/subscriptions' : root + '/subscriptions/{subscriptionId}'], ['verified', 'GET', root + '/agents/{agentId}/subscription-status'], ['verifiedSubscriptions', 'GET', root + '/subscriptions']]
  return [identity, agent, status, ['changed', 'POST', root + '/agent-conversations' + (action === 'conversation-resolve' ? '/resolve' : '')]]
}
export function validateAiMarketWorkflow(flow: Workflow) {
  if (!actions.includes(flow.aiMarketAction!)) fail('未知 AI 市场业务操作。', 'INVALID_CONTRACT')
  const expected = aiMarketSteps(flow.aiMarketAction!)
  if (flow.executor !== 'ai-market' || expected.length !== flow.steps.length || expected.some(([name, method, route], i) => {
    const step = flow.steps[i], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.collectPages || step.resources || step.transfer || step.authentication || step.readback || step.waitBeforeMs || step.expectAbsent
  })) fail('AI 市场业务步骤与已核对 HTTP 协议不一致。', 'INVALID_CONTRACT')
}
function data(value: unknown) {
  const envelope = asObject(value)
  if (envelope.code !== 200 || envelope.data == null) fail('AI 服务未返回成功业务回执。', 'BUSINESS_ERROR')
  return asObject(envelope.data)
}
function statusData(value: unknown, agentId?: unknown) {
  const status = data(value)
  if (typeof status.subscribed !== 'boolean') fail('订阅状态缺少布尔值。')
  if (status.subscribed && (status.status !== 'subscribed' || !status.subscriptionId || !status.agentId || agentId != null && status.agentId !== agentId)) fail('订阅状态与当前员工不符。')
  if (status.subscribed) { textId(status.subscriptionId); textId(status.agentId) }
  return status
}
export async function runAiMarket(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateAiMarketWorkflow(flow)
  const session = requireSession(supplied), action = flow.aiMarketAction!, completed: string[] = [], resources: JsonObject = {}
  let phase = 'identity', pending = false, changed = false
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(s => s.id === name)?.operationId)
    if (!op) fail('未声明 AI 员工 HTTP 步骤。', 'INVALID_CONTRACT')
    phase = name; pending = false
    const transport: Transport = async (url, init) => {
      pending = op.effect !== 'read'
      const response = await (options.transport ?? request)(url, init)
      if (name === 'changed' && response.ok) {
        changed = true
        try { const receipt = data(parseJson(await response.clone().text())); for (const key of ['agentId', 'subscriptionId', 'conversationId']) if (receipt[key] != null) resources[key] = textId(receipt[key]) } catch { /* Preserve identifiers before schema validation, without replaying writes. */ }
      }
      return response
    }
    const result = await runOperation(ctx, op, args, session, { ...options, transport })
    pending = false; completed.push(name); return result
  }
  const page = (value: unknown, expectedPage: number, expectedLimit: number): JsonObject & { items: JsonObject[] } => {
    const result = data(value), items = rows(result.items)
    if (!Number.isSafeInteger(result.total) || Number(result.total) < 0 || result.page !== expectedPage || result.limit !== expectedLimit || result.totalPages !== Math.ceil(Number(result.total) / expectedLimit) || items.length > expectedLimit || items.length > Number(result.total)) fail('AI 服务分页回执与请求不一致。')
    return { ...result, items }
  }
  const allSubscriptions = async (name: string) => {
    const output: JsonObject[] = [], seen = new Set<string>(); let expectedTotal: unknown
    for (let index = 1; index <= 100; index++) {
      const value = page(await call(name, { query: { page: index, limit: 100 } }), index, 100)
      if (expectedTotal != null && expectedTotal !== value.total) fail('订阅目录在分页时变化，请重新读取。', 'CONTEXT_CONFLICT')
      expectedTotal = value.total
      for (const row of value.items) {
        const id = textId(row.subscriptionId); textId(row.agentId)
        if (row.status !== 'subscribed' || seen.has(id)) fail('订阅目录有重复或非活跃条目。')
        seen.add(id); output.push(row)
      }
      if (index >= Number(value.totalPages)) { if (output.length !== expectedTotal) fail('订阅目录分页不完整。'); return output }
      if (!value.items.length) fail('订阅目录提前中断。')
    }
    fail('订阅目录超过 10000 条上限，未进行写入。', 'CONTEXT_LIMIT')
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources, result })
  try {
    const identity = asObject(await call('identity'))
    if (String(identity.id) !== session.identity.userId || String(asObject(identity.team).id) !== session.identity.teamId) fail('AI 员工上下文与当前公司或用户不符。', 'IDENTITY_CHANGED')
    if (action === 'list' || action === 'subscription-list') {
      const pageNumber = input.page ?? 1, limit = input.limit ?? 20, query = { page: pageNumber, limit, ...Object.fromEntries(['keyword', 'categoryId'].filter(key => input[key] != null).map(key => [key, input[key]])) }
      const result = page(await call('items', { query }), Number(pageNumber), Number(limit)), key = action === 'list' ? 'id' : 'subscriptionId', seen = new Set<string>()
      for (const row of result.items) { const id = textId(row[key]); if (seen.has(id)) fail('AI 员工列表出现重复 ID。'); seen.add(id) }
      return done(result)
    }
    if (action === 'preset-status') {
      const status = statusData(await call('status', { path: { presetType: input.presetType } }))
      if (status.presetType !== input.presetType) fail('内置能力状态用途与请求不一致。')
      return done(status)
    }
    const path = { agentId: input.agentId }, agent = data(await call('agent', { path }))
    if (agent.id !== input.agentId || typeof agent.price !== 'string' || typeof agent.subscribed !== 'boolean') fail('AI 员工详情的身份、价格或订阅状态不完整。')
    const status = statusData(await call('status', { path }), input.agentId), contextVersion = hash({ teamId: session.identity.teamId, agent, status })
    if (agent.subscribed !== status.subscribed) fail('员工详情与订阅状态不一致，请重新读取。', 'CONTEXT_CONFLICT')
    if (input.expectedVersion != null && input.expectedVersion !== contextVersion) fail('AI 员工价格或订阅上下文已变化，请重新读取。', 'CONTEXT_CONFLICT')
    if (action === 'get' || action === 'subscription-status') return done({ agent, subscription: status, contextVersion, teamId: session.identity.teamId })
    resources.agentId = input.agentId
    if (action === 'conversation-create' || action === 'conversation-resolve') {
      if (input.source !== 'market_agent_test' && !status.subscribed) fail('此入口要求当前企业已有活跃订阅，请先发现并明确订阅。', 'FORBIDDEN')
      const body = { agentId: input.agentId, source: input.source, ...(input.runtimeConfigOverride != null && { runtimeConfigOverride: input.runtimeConfigOverride }) }
      const result = data(await call('changed', { body }))
      textId(result.conversationId)
      if (typeof result.reused !== 'boolean' || action === 'conversation-create' && result.reused !== false) fail('会话创建/复用回执不一致。', 'BUSINESS_ASSERTION_FAILED')
      return done({ ...result, agentId: input.agentId, source: input.source, verification: 'server-receipt', executionStarted: false, limitations: ['本命令只建立或复用 HTTP 会话，不证明模型执行成功；独立消息/运行状态按该员工实际传输方式处理。'] })
    }
    const before = await allSubscriptions('subscriptions'), matching = before.filter(row => row.agentId === input.agentId)
    if (matching.length > 1 || status.subscribed && (matching.length !== 1 || matching[0].subscriptionId !== status.subscriptionId) || !status.subscribed && matching.length) fail('订阅状态与完整活跃目录不一致。', 'CONTEXT_CONFLICT')
    if (action === 'unsubscribe' && (!status.subscribed || input.subscriptionId !== status.subscriptionId)) fail('取消 ID 必须是该员工在当前公司的实际活跃订阅。', 'INVALID_INPUT')
    if (action === 'subscribe' && status.subscribed) return done({ agentId: input.agentId, subscription: status, changed: false, contextVersion })
    const currentAgent = data(await call('agentPreflight', { path })), currentStatus = statusData(await call('statusPreflight', { path }), input.agentId)
    if (!isDeepStrictEqual(currentAgent, agent) || !isDeepStrictEqual(currentStatus, status)) fail('订阅写入前员工价格或状态发生变化。', 'CONTEXT_CONFLICT')
    const receipt = data(await call('changed', action === 'subscribe' ? { path } : { path: { subscriptionId: input.subscriptionId } }))
    if (receipt.agentId !== input.agentId || receipt.status !== (action === 'subscribe' ? 'subscribed' : 'cancelled') || action === 'unsubscribe' && receipt.subscriptionId !== input.subscriptionId) fail('订阅操作回执不符。', 'BUSINESS_ASSERTION_FAILED')
    const after = statusData(await call('verified', { path }), input.agentId), directory = await allSubscriptions('verifiedSubscriptions'), found = directory.filter(row => row.agentId === input.agentId)
    if (after.subscribed !== (action === 'subscribe') || action === 'subscribe' && (after.subscriptionId !== receipt.subscriptionId || found.length !== 1 || found[0].subscriptionId !== receipt.subscriptionId) || action === 'unsubscribe' && found.length) fail('订阅结果没有通过状态与完整目录的独立读回。', 'BUSINESS_ASSERTION_FAILED')
    for (const old of before.filter(row => row.agentId !== input.agentId)) if (!directory.some(row => row.subscriptionId === old.subscriptionId && row.agentId === old.agentId)) fail('无关企业订阅没有保留。', 'BUSINESS_ASSERTION_FAILED')
    return done({ agentId: input.agentId, subscription: after, changed: true, enterpriseWide: true, displayedPrice: agent.price, verification: 'independent-status-and-directory' })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('BUSINESS_ASSERTION_FAILED', 'AI 员工业务执行失败，请根据已知资源核对结果。', 5)
    throw new RsqError(original.code, original.message, original.exit, { ...asObject(original.details), workflow: flow.command, failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown-do-not-replay' : changed ? 'applied-or-partial-do-not-replay' : 'no-confirmed-write', rollback: 'not-attempted' })
  }
}
