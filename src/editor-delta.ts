import { asObject, RsqError, type JsonObject } from './core.js'

const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }

/** A complete Quill snapshot, not an OT mutation. Extension values remain
 * ordinary JSON and are never executed or fetched by the CLI. */
export function docDelta(value: unknown): JsonObject {
  if (typeof value === 'string') return { ops: value ? [{ insert: value.endsWith('\n') ? value : value+'\n' }] : [] }
  const row = Array.isArray(value) ? { ops: value } : asObject(value)
  if (Object.keys(row).length !== 1 || !Array.isArray(row.ops) || row.ops.length > 20000) invalid('正文必须是文本或完整的 {ops:[{insert,attributes?}]} 快照。')
  for (const raw of row.ops as unknown[]) {
    const op = asObject(raw)
    if (!Object.hasOwn(op,'insert') || Object.keys(op).some(key => !['insert','attributes'].includes(key)) || typeof op.insert !== 'string' && (!op.insert || Array.isArray(op.insert) || typeof op.insert !== 'object' || Object.keys(op.insert).length !== 1) || op.attributes != null && (!op.attributes || Array.isArray(op.attributes) || typeof op.attributes !== 'object')) invalid('完整正文仅接受 insert 和可选 attributes；不能把 retain/delete 增量当作快照。')
  }
  const stack: unknown[] = [row];let nodes = 0
  while (stack.length) {
    const node = stack.pop()
    if (++nodes > 100000) invalid('正文结构过大。')
    if (node && typeof node === 'object') for (const [key,child] of Object.entries(node)) { if (['__proto__','constructor','prototype'].includes(key) || ['undefined','function','bigint','symbol'].includes(typeof child)) invalid('正文扩展必须是普通 JSON。');stack.push(child) }
    if (typeof node === 'number' && !Number.isFinite(node)) invalid('正文不能包含非有限数字。')
  }
  if (Buffer.byteLength(JSON.stringify(row)) > 4*1024*1024) invalid('文档正文最多 4 MiB。')
  return row
}

/** The wire format is an object containing ops, serialized exactly once.
 * Arrays and strings accepted by docDelta as user input are not wire snapshots. */
export function isSerializedEditorDelta(value: string): boolean {
  try {
    const decoded: unknown = JSON.parse(value)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return false
    docDelta(decoded)
    return true
  } catch { return false }
}
