import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const rows = (data: unknown): JsonObject[] => { if (!Array.isArray(data)) throw new RsqError('CONTEXT_MISSING', '回收站没有返回记录列表。', 5); return data.map(asObject) }
export function prepareFileItem(kind: string, input: JsonObject, results: JsonObject, provided: Session | null): JsonObject {
  const session = requireSession(provided)
  // The service already scopes records to currentUser. userId filters the
  // deleted resource's members, not the deleting user; files have no members.
  if (kind === 'file-item-recycle-list') return { query: { type: '10', max: input.max ?? 100, ...(input.cursor != null && { lastDataId: input.cursor }) } }
  if (kind === 'file-item-remove') {
    const file = asObject(results.file)
    if (!same(file.id, input.fileId)) throw new RsqError('CONTEXT_MISSING', '文件详情与目标 ID 不符。', 2)
    if (asObject(file.editControl).removeFile !== true) throw new RsqError('FORBIDDEN', '当前文件未授予 removeFile 权限。', 4)
    return { query: { id: input.fileId } }
  }
  const entry = rows(results.entries).find(entry => same(entry.id, input.entryId) && same(entry.resourceId, input.fileId) && Number(entry.type) === 10 && same(entry.userId, session.identity.userId))
  if (!entry) throw new RsqError('CONTEXT_MISSING', '回收记录必须在当前用户的指定文件列表页中，并同时匹配 entryId 和 fileId；请先查询实际记录。', 2)
  if (kind === 'file-item-purge') return { query: { id: String(entry.id) } }
  throw new RsqError('INVALID_CONTRACT', '未知文件业务上下文。', 6)
}
export function verifyFileItem(input: JsonObject, results: JsonObject, step: string, provided: Session | null) {
  const userId = requireSession(provided).identity.userId, entries = rows(results[step])
  const selected = entries.filter(entry => same(entry.resourceId, input.fileId) && Number(entry.type) === 10 && same(entry.userId, userId))
  if (step === 'removedEntry' && selected.length !== 1) throw new RsqError('BUSINESS_ASSERTION_FAILED', '文件移除后未能在当前用户回收站页中唯一确认；不会自动重放，请分页核对。', 5, { fileId: input.fileId })
  if (step === 'purgedEntries' && entries.some(entry => same(entry.id, input.entryId))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '删除的回收记录仍出现在独立读回中。', 5)
}
export function describeFileItems(input: JsonObject, results: JsonObject) {
  const list = results.removedEntry ?? results.purgedEntries ?? results.entries
  const entries = rows(list).map(entry => Object.fromEntries(['id','resourceId','userId','type','name','dateCreated','fileSize','contentType'].filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]])))
  return { entries, cursor: entries.at(-1)?.id ?? null, mayHaveMore: entries.length === (input.max ?? 100), ...(results.removedEntry !== undefined && { removedFileId: input.fileId }), ...(results.purgedEntries !== undefined && { purgedEntryId: input.entryId }) }
}
