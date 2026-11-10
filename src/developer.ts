import { createHash, timingSafeEqual } from 'node:crypto'
import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { requireSession, type Session } from './session.js'
import { catalog, runOperation } from './operations.js'
import { privateOutput } from './private-output.js'
import { fingerprint } from './fingerprint.js'
import type { Workflow } from './workflows.js'
export const developerActions = ['context', 'inspect', 'save', 'rotate'] as const
export type DeveloperAction = typeof developerActions[number]
type Route = [string, string, string]
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : 5) }
const identifier = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('开发者上下文没有精确用户或公司 ID。')
export function developerState(state: JsonObject) {
  // The current public UI hides the entry for free/trial accounts. The current
  // state endpoint always declares isTrial; older versions also declare isFree.
  if (typeof state.isTrial !== 'boolean' && state.isTrial !== 0 && state.isTrial !== 1) fail('当前套餐未返回可确认的试用状态，不能访问开发令牌。')
  if (state.isTrial === true || state.isTrial === 1 || state.isFree === true || state.isFree === 1) fail('免费版或试用版未开放开发者配置。', 'FEATURE_DISABLED')
  if (!Number.isInteger(state.appModule) || Number(state.appModule) < 0 || Number(state.appModule) > 100) fail('当前应用未提供有效 appModule；不接受用户猜测或覆盖应用编号。')
  if (typeof state.vt !== 'string' || !state.vt) fail('当前套餐版本缺失。')
  return { appModule: Number(state.appModule), version: state.vt, isTrial: false, free: state.isFree === false || state.isFree === 0 ? false : 'not-declared-by-current-state', mainApp: state.mainApp }
}
export function developerSteps(action: DeveloperAction): Route[] {
  const base: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['state', 'GET', '/task/ordercenter/v2/member/state/independent']]
  if (action === 'context') return base
  return [...base, ['key', 'GET', '/task/v1/userSetting/getOpenapiKey'], ...(action === 'rotate' ? [['rotated', 'POST', '/task/v1/userSetting/generateOpenapiKey'] as Route] : [])]
}
export function validateDeveloperWorkflow(flow: Workflow) {
  if (!developerActions.includes(flow.developerAction!)) fail('未知开发者操作。', 'INVALID_CONTRACT')
  const steps = developerSteps(flow.developerAction!)
  if (flow.executor !== 'developer' || steps.length !== flow.steps.length || steps.some(([key, method, route], i) => {
    const step = flow.steps[i], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== key || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.resources || step.transfer || step.authentication || step.readback || step.collectPages || step.forEach || step.expectAbsent || step.waitBeforeMs
  })) fail('开发者步骤与已核对协议不一致。', 'INVALID_CONTRACT')
}
export async function runDeveloper(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateDeveloperWorkflow(flow)
  const session = requireSession(supplied), action = flow.developerAction!, completed: string[] = []
  let phase = 'output-preflight', rotated = false, rotationAttempted = false, output: Awaited<ReturnType<typeof privateOutput>> | undefined
  const call = async (name: string, args: JsonObject = {}) => { const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId); if (!op) fail('未声明开发者步骤。', 'INVALID_CONTRACT'); phase = name; if (name === 'rotated') rotationAttempted = true; const result = await runOperation(ctx, op, args, session, options); completed.push(name); return result }
  const key = (response: unknown) => { const value = asObject(response).openapiKey; if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /[\r\n\u0000]/.test(value)) fail('服务端未返回合法开发令牌。'); return value }
  const digest = (secret: string) => createHash('sha256').update(secret).digest('hex')
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources: {}, result })
  try {
    if (action === 'save' || action === 'rotate') output = await privateOutput(String(input.secretOutput))
    const who = asObject(await call('identity'))
    if (identifier(who.id) !== session.identity.userId || identifier(asObject(who.team).id) !== session.identity.teamId) fail('用户或公司与当前 profile 不一致。', 'IDENTITY_CHANGED')
    const state = developerState(asObject(await call('state'))), scope = { userId: session.identity.userId, companyId: session.identity.teamId, appModule: state.appModule, scope: 'current-user-and-app-module', companyWideKey: false }
    if (action === 'context') return done({ ...scope, available: true, initializationSideEffect: 'token inspect/save 的 GET 在首次调用时创建令牌；context 不读取或创建令牌。', rotationSideEffect: '同一用户与应用的旧令牌立即失效；不是重置整个公司。', secretOutput: '保存与轮换须指定新文件；以 0600 权限原子写入，JSON 不含令牌。', relatedCommands: ['organization developer token inspect', 'organization developer token save', 'organization developer token rotate'] })
    let secret = key(await call('key', { query: { appModule: state.appModule } }))
    const originalFingerprint = digest(secret)
    if (action === 'rotate') {
      if (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint) || !timingSafeEqual(Buffer.from(originalFingerprint), Buffer.from(input.expectedFingerprint))) fail('当前令牌与预期指纹不符；先 inspect，未执行轮换。', 'CONTEXT_CONFLICT')
      if (fingerprint(state) !== fingerprint(developerState(asObject(await call('state'))))) fail('套餐或应用上下文在轮换前变化。', 'CONTEXT_CONFLICT')
      const current = key(await call('key', { query: { appModule: state.appModule } })); if (current !== secret) fail('令牌已被其他进程轮换，未执行新的轮换。', 'CONTEXT_CONFLICT')
      secret = key(await call('rotated', { body: { appModule: state.appModule } })); rotated = true
      if (secret === current) fail('轮换返回了旧令牌；先独立读取结果，不自动重放。', 'VERIFICATION_FAILED')
    }
    // Persist the newly issued secret before the independent HTTP check. A
    // timeout or version conflict must not discard the only local copy.
    phase = 'secret-output'
    const file = output ? await output.commit(secret) : null
    phase = 'key-readback'
    const verified = key(await call('key', { query: { appModule: state.appModule } }))
    if (verified !== secret) fail('独立读回发现令牌已变化；已保存文件可能过期，不自动重复轮换。', 'CONTEXT_CONFLICT')
    return done({ ...scope, fingerprint: digest(secret), ...(rotated && { previousFingerprint: originalFingerprint }), rotated, getMayInitialize: true, secretExposed: false, ...(file && { output: file }), verified: true })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '开发者配置未完成。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, rotationAttempted, rotated, ...(rotated && output ? { secretOutput: output.path } : {}), ...(rotationAttempted && !rotated ? { resultMayBeUnknown: true } : {}), automaticRetry: false, cause: original.details })
  } finally { await output?.close() }
}
