import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { runOperation, type Operation } from './operations.js'
import type { Session } from './session.js'
export type CursorPages = { limit: number; cursorParameter: string; cursorField: string; pageSizeParameter: string }
export function validateCursorPages(op: Operation, config: CursorPages) {
  const query = asObject(asObject(asObject(op.inputSchema).properties).query), properties = asObject(query.properties)
  if (op.method !== 'GET' || op.effect !== 'read' || op.idempotency !== 'idempotent' || op.response !== 'json'
    || !Number.isInteger(config.limit) || config.limit < 1 || config.limit > 100
    || !['frontId','lastDataId','lastId','cursor'].includes(config.cursorParameter) || config.cursorField !== 'id'
    || !Object.hasOwn(properties, config.cursorParameter) || config.pageSizeParameter !== 'max' || !Object.hasOwn(properties, 'max')) throw new RsqError('INVALID_CONTRACT', '有界游标遍历只能用于已核对的幂等 GET 列表及声明的游标字段。', 6)
}
export async function collectOperationPages(ctx: Context, op: Operation, input: JsonObject, session: Session | null, config: CursorPages, transport?: Transport) {
  validateCursorPages(op, config)
  const query = { ...asObject(input.query) }, size = query[config.pageSizeParameter]
  if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > 1000) throw new RsqError('INVALID_CONTRACT', '游标遍历缺少合法的 max 页大小。', 6)
  const result: unknown[] = [], seen = new Set<string>(), cursors = new Set<string>()
  if (query[config.cursorParameter] != null) cursors.add(String(query[config.cursorParameter]))
  for (let page = 0; page < config.limit; page++) {
    const response = await runOperation(ctx, op, { ...input, query: { ...query } }, session, { transport })
    if (!Array.isArray(response) || response.length > Number(size)) throw new RsqError('RESPONSE_SCHEMA_MISMATCH', '游标列表返回结构或条数不符。', 5, { pagesRead: page + 1 })
    for (const row of response) {
      const value = asObject(row)[config.cursorField], id = String(value)
      if (!/^[1-9][0-9]*$/.test(id) || typeof value === 'number' && !Number.isSafeInteger(value) || seen.has(id)) throw new RsqError('PAGINATION_CHANGED', '列表游标缺失或发生重复，可能有并发变化；不将部分遍历当完整结果。', 5, { pagesRead: page + 1, itemsRead: result.length })
      seen.add(id); result.push(row)
    }
    if (response.length < Number(size)) return result
    const cursor = String(asObject(response.at(-1))[config.cursorField])
    if (cursors.has(cursor)) throw new RsqError('PAGINATION_CHANGED', '列表返回了重复游标，已停止遍历。', 5, { pagesRead: page + 1, itemsRead: result.length })
    cursors.add(cursor); query[config.cursorParameter] = cursor
  }
  throw new RsqError('PAGINATION_LIMIT', '已到有界遍历上限，完整读回尚未确认；请先分页核对，不要自动重发写请求。', 5, { pagesRead: config.limit, itemsRead: result.length, nextCursor: query[config.cursorParameter] })
}

/** Indexed POST searches are reads. A complete ownership check cannot use just
 * the UI's first page, a guessed total, or a partially traversed collection. */
export async function collectIndexedPages(ctx: Context, op: Operation, input: JsonObject, session: Session | null, transport?: Transport, limit = 100) {
  const properties = asObject(asObject(asObject(op.inputSchema.properties).body).properties)
  if (op.method !== 'POST' || op.effect !== 'read' || op.idempotency !== 'idempotent' || op.response !== 'business'
    || !properties.page || !properties.size || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new RsqError('INVALID_CONTRACT','完整页码遍历要求已核对的幂等 POST 查询和 page/size 契约。',6)
  const size = Number(asObject(input.body).size)
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new RsqError('INVALID_CONTRACT','页码遍历需要 1–100 的合法页大小。',6)
  const items: unknown[] = [],seen = new Set<string>();let total: number | undefined
  for (let page = 1;page <= limit;page++) {
    const response = asObject(await runOperation(ctx,op,{ ...input,body: { ...asObject(input.body),page,size } },session,{ transport })),ext = asObject(response.ext),rows = response.data
    if (!Array.isArray(rows) || rows.length > size || ext.page !== page || ext.size !== size || !Number.isSafeInteger(ext.total) || Number(ext.total) < 0 || !Number.isSafeInteger(ext.totalPages) || ext.totalPages !== Math.ceil(Number(ext.total)/size)) throw new RsqError('RESPONSE_SCHEMA_MISMATCH','分页查询的实际页码、条数或总量不符。',5,{ pagesRead: page })
    if (total !== undefined && total !== ext.total) throw new RsqError('PAGINATION_CHANGED','遍历期间列表总量发生变化；完整上下文尚未确认。',5,{ pagesRead: page })
    total = Number(ext.total)
    const expected = Math.max(0,Math.min(size,total-(page-1)*size))
    if (rows.length !== expected) throw new RsqError('PAGINATION_CHANGED','分页条数与服务端总量不一致；没有将部分遍历当作完整列表。',5,{ pagesRead: page })
    for (const value of rows) {
      const id = asObject(value).id
      if (!(typeof id === 'string' && /^[1-9][0-9]*$/.test(id) || typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || seen.has(String(id))) throw new RsqError('PAGINATION_CHANGED','分页包含缺失、不精确或重复资源 ID。',5,{ pagesRead: page })
      seen.add(String(id));items.push(value)
    }
    if (items.length === total) return items
  }
  throw new RsqError('PAGINATION_LIMIT','完整列表超过有界页码遍历上限，未发送依赖完整上下文的写入。',5,{ pagesRead: limit,itemsRead: items.length })
}
