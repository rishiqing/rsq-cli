import { asObject, RsqError, type JsonObject } from './core.js'
const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('文档动态缺少精确 ID。')
/** The DAO selects ten newest IDs and WebSummaryActionBizService reverses that
 * page. The paging cursor is its first (oldest) ID, not its last ID. */
export function docActivityPage(value: unknown, cursor?: unknown): JsonObject[] {
 if (!Array.isArray(value) || value.length > 10) fail('文档动态不是当前 HTTP 协议的至多10条记录。')
 let previous: string | undefined
 return (value as unknown[]).map(raw => {
  const row = asObject(raw), key = id(row.id)
  if (previous != null && BigInt(key) <= BigInt(previous) || cursor != null && BigInt(key) >= BigInt(id(cursor))) fail('文档动态游标未向更早记录前进，未将重复或乱序页当作成功。')
  if (typeof row.comment !== 'string' || typeof row.dateCreated !== 'string' || row.isNote !== true || !Number.isSafeInteger(row.type) || typeof row.idOrContent !== 'string' && (!Array.isArray(row.idOrContent) || row.idOrContent.some(item => typeof item !== 'string'))) fail('文档动态缺少实际注释、时间、类型或当前编辑器 HTML 列表。')
  previous = key
  return { id: key, comment: row.comment, idOrContent: row.idOrContent, dateCreated: row.dateCreated, isNote: true, type: row.type, contentHistory: row.type === 10 }
 })
}
export function describeDocActivities(page: JsonObject[], hasMore: boolean, cursor?: unknown) {
 if (hasMore && page.length !== 10) fail('服务端声称还有动态，但没有提供完整页。')
 return { activities: [...page].reverse(), order: 'newest-first', pageSize: 10, hasMore, nextCursor: hasMore ? page[0].id : null, completeHistory: !hasMore && cursor == null, timeZone: 'Asia/Shanghai', sideEffect: 'GET-may-materialize-current-editor-history', contentHistoryRestoreVerified: false }
}
