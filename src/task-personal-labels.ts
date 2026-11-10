import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'

const fail = (code: string, message: string): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'IDENTITY_CHANGED' ? 3 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '标签缺少精确 ID。')
export function taskLabels(value: unknown, own = false): JsonObject[] {
  if (!Array.isArray(value) || value.length > 10000) fail('CONTEXT_MISSING', '标签目录不是完整列表或超出10000项，不能猜测目标。')
  const seen = new Set<string>()
  return (value as unknown[]).map(item => {
    const row = asObject(item), labelId = id(row.id), key = row.type + ':' + labelId
    if (!(own ? row.type === 'todo' : ['todo', 'project'].includes(String(row.type))) || typeof row.name !== 'string' || !Number.isInteger(row.color) || seen.has(key)) fail('CONTEXT_MISSING', '标签目录存在重复、未知来源或不完整内容。')
    seen.add(key); return { id: labelId, type: row.type, name: row.name, color: row.color }
  })
}
const ordered = (value: unknown) => taskLabels(value, true).sort((a, b) => String(a.id).localeCompare(String(b.id)))
export function validateLabelPatch(value: JsonObject) {
  if (Object.hasOwn(value, 'name') && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80)) fail('INVALID_INPUT', '标签名称须非空且最多80个 UTF-16 长度单位。')
  if (Object.hasOwn(value, 'color') && (!Number.isInteger(value.color) || Number(value.color) < 1 || Number(value.color) > 16)) fail('INVALID_INPUT', '标签颜色须来自当前选择器的1–16号颜色。')
}
function identity(value: unknown, session: Session) {
  const who = asObject(value)
  if (String(who.id) !== session.identity.userId || String(asObject(who.team).id ?? '') !== String(session.identity.teamId ?? '')) fail('IDENTITY_CHANGED', '标签目录身份或公司与当前 profile 不一致。')
}
export function preparePersonalLabel(action: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject {
  const session = requireSession(supplied)
  identity(results.identity, session)
  results.personalLibraryScope = { userId: session.identity.userId, teamId: session.identity.teamId ?? null }
  if (action === 'list') { if (results.identityFresh) identity(results.identityFresh, session); return {} }
  identity(results.identityFresh, session)
  const before = ordered(results.labels), latest = ordered(results.labelsFresh)
  if (!isDeepStrictEqual(before, latest)) fail('CONTEXT_CONFLICT', '个人标签目录在提交前已变化；未发送写入。')
  const patch = action === 'create' ? { name: input.name, color: input.color } : action === 'update' ? asObject(input.patch) : {}
  validateLabelPatch(patch)
  if (action !== 'create') {
    const target = latest.find(row => row.id === input.labelId)
    if (!target) fail('FORBIDDEN', '只允许维护当前用户独立目录中的个人标签；任务上已选的他人标签不能当作自己的库。')
    if (action === 'update' && (!Object.keys(patch).length || Object.keys(patch).some(key => !['name', 'color'].includes(key)))) fail('INVALID_INPUT', '只支持明确的标签名称或颜色补丁。')
  }
  results.personalLibraryMutation = { action, before: latest, patch, labelId: input.labelId ?? null }
  if (action === 'create') return { body: patch }
  if (action === 'update') return { body: { id: input.labelId, ...patch } }
  if (action === 'remove') return { query: { id: input.labelId } }
  return fail('INVALID_CONTRACT', '未知个人标签操作。')
}
export function verifyPersonalLabel(results: JsonObject, step: string) {
  if (['labels', 'labelsFresh'].includes(step)) { taskLabels(results[step], true); return }
  if (step !== 'verifiedLabels') return
  const mutation = asObject(results.personalLibraryMutation), before = taskLabels(mutation.before, true), patch = asObject(mutation.patch), actual = ordered(results.verifiedLabels)
  let expected: JsonObject[]
  if (mutation.action === 'create') {
    const receipt = asObject(results.created), newId = id(receipt.id)
    if (before.some(row => row.id === newId) || receipt.type !== 'todo' || receipt.name !== patch.name || receipt.color !== patch.color) fail('BUSINESS_ASSERTION_FAILED', '创建回执不是预期的全新个人标签；不会重放。')
    expected = [...before, { id: newId, type: 'todo', ...patch }]
  } else if (mutation.action === 'update') expected = before.map(row => row.id === mutation.labelId ? { ...row, ...patch } : row)
  else {
    if (asObject(results.changed).success !== true) fail('BUSINESS_ASSERTION_FAILED', '删除回执未确认，须先读回核对。')
    expected = before.filter(row => row.id !== mutation.labelId)
  }
  expected.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  if (!isDeepStrictEqual(actual, expected)) fail('BUSINESS_ASSERTION_FAILED', '个人标签未独立持久化或其他标签发生变化；保留资源 ID，不重放。')
}
