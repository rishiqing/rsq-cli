import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { checkAccess } from './access.js'
import { verifyFileLibrary } from './file-library.js'
import type { Workflow } from './workflows.js'

const fail = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'PERMISSION_DENIED' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '文件库上下文缺少精确 ID。')
const members = (value: JsonObject) => {
  if (!Array.isArray(value.userRoles)) return fail('CONTEXT_MISSING', '文件库成员上下文缺失。')
  return value.userRoles.map(asObject).map(row => ({ userId: id(row.userId), roleId: id(asObject(row.role ?? row.teamRole).id), type: asObject(row.role ?? row.teamRole).type })).sort((a, b) => a.userId.localeCompare(b.userId))
}
export const fileLibraryQuitSteps = [
  ['identity', 'GET', '/task/login/authAjax'], ['before', 'GET', '/task/v1/folder'], ['changed', 'POST', '/task/v1/folder/quit'],
  ['verified', 'GET', '/task/v1/folder'], ['libraries', 'GET', '/task/v1/folder/list'],
] as const
export function validateFileLibraryQuitWorkflow(flow: Workflow) {
  if (flow.command !== 'file library quit' || flow.effect !== 'destructive' || flow.outputAdapter || Object.keys(flow.output as object).length || flow.steps.length !== fileLibraryQuitSteps.length || flow.steps.some((step, index) => {
    const [name, method, route] = fileLibraryQuitSteps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return !op || step.id !== name || op.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.authentication
  })) fail('INVALID_CONTRACT', '退出文件库只能使用固定身份、成员和权限上下文及独立 HTTP 读回。')
}
export async function runFileLibraryQuit(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateFileLibraryQuitWorkflow(flow)
  const session = requireSession(supplied), libraryId = id(input.libraryId), completed: string[] = []
  let phase = 'identity', pending = false, written = false
  const call = async (name: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === name), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) return fail('INVALID_CONTRACT', '缺少固定的文件库退出步骤。')
    phase = name; pending = false
    const transport: Transport = async (url, init) => { if (name === 'changed') pending = true; return (options.transport ?? request)(url, init) }
    const value = await runOperation(ctx, op, args, session, { ...options, transport })
    if (name === 'changed') written = true
    pending = false; completed.push(name); return value
  }
  const identity = async () => {
    const who = asObject(await call('identity'))
    if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '当前身份或公司与 profile 不同；未退出文件库。')
  }
  const read = async (name: string) => {
    const value = asObject(await call(name, { query: { id: libraryId } }))
    verifyFileLibrary(input, { before: value }, 'before'); return value
  }
  try {
    await identity()
    const before = await read('before'), previous = members(before), current = previous.find(row => row.userId === session.identity.userId)
    if (!current) fail('INVALID_INPUT', '当前账号不是该文件库成员；没有重复提交退出请求。')
    if (current!.type === 'libCreator') fail('PERMISSION_DENIED', '文件库拥有者不能直接退出；请先向已有成员明确转移拥有者。')
    if (asObject(before.editControl).quitLib !== true) fail('PERMISSION_DENIED', '当前文件库未授予 quitLib 权限。')
    await checkAccess(ctx, flow, input, session, options.transport)
    await identity()
    const fresh = await read('before')
    if (!isDeepStrictEqual(previous, members(fresh)) || !isDeepStrictEqual(before.editControl, fresh.editControl)) fail('CONTEXT_CONFLICT', '退出前成员、拥有者、角色或权限变化；未提交退出。')
    await call('changed', { body: { id: libraryId } })
    let verification: JsonObject
    try {
      const after = await read('verified')
      if (!isDeepStrictEqual(members(after), previous.filter(row => row.userId !== session.identity.userId))) fail('BUSINESS_ASSERTION_FAILED', '退出后成员集合或其他成员的角色与预期不同；不重放退出请求。')
      verification = { mode: 'full-membership', membershipReadback: true, otherMembersAndRolesPreserved: true }
    } catch (error) {
      if (!(error instanceof RsqError) || error.code !== 'BUSINESS_ERROR' || String(asObject(error.details).upstreamCode) !== '401005') throw error
      // Ordinary members lose detail access. Only the exact current permission
      // denial plus a full list read is evidence of this account's access loss;
      // neither 404 nor timeout proves that the membership/other roles survived.
      const value = await call('libraries')
      if (!Array.isArray(value) || value.some(row => id(asObject(row).id) === libraryId)) fail('BUSINESS_ASSERTION_FAILED', '退出后详情拒绝访问，但目标仍出现在完整文件库列表中。')
      verification = { mode: 'current-account-access-revoked', membershipReadback: false, otherMembersAndRolesPreserved: 'unverified', upstreamCode: '401005' }
    }
    return { workflow: flow.id, result: { libraryId, userId: session.identity.userId, quit: true, verification, concurrency: 'fresh-preflight-and-readback; no-atomic-compare-and-swap' }, completed, resources: { libraryId } }
  } catch (error) {
    const cause = error instanceof RsqError ? error : new RsqError('FILE_LIBRARY_QUIT_FAILED', '退出文件库失败；先核对当前成员状态，不自动重复写入。', 5)
    throw new RsqError(cause.code, cause.message, cause.exit, { ...asObject(cause.details), failedStep: phase, completed, resources: { libraryId }, writeOutcome: pending ? 'unknown' : written ? 'accepted-needs-verification' : 'not-sent', automaticallyRetried: false })
  }
}
