import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { docDelta } from './doc-context.js'
import { docCommentContent, docCommentDirectory } from './doc-comments.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'
export const docCollaborationActions = ['collaboration-list', 'collaboration-inspect', 'collaboration-body', 'collaboration-rename', 'collaboration-quit', 'collaboration-comments', 'collaboration-comment-context', 'collaboration-comment-create', 'collaboration-comment-remove'] as const
export type DocCollaborationAction = typeof docCollaborationActions[number]
type Route = [string, string, string]
const base = '/task/v1/corpus/summary', hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, 5) }
const id = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('协作文档上下文缺少精确 ID。')
const rows = (value: unknown) => Array.isArray(value) ? value.map(asObject) : fail('协作文档 HTTP 列表不是数组。')
const preview = (value: unknown) => { const row = asObject(value); return ['', 'noEdit'].includes(String(row.status)) && row.auth != null && Object.keys(asObject(row.auth)).length > 0 }
const describe = (row: JsonObject) => Object.fromEntries(['id', 'name', 'corpusId', 'corpusType', 'isCorpusMember', 'hasCorpusOrProjectMembership', 'operator', 'operatorTime', 'brief', 'editControl'].filter(key => row[key] !== undefined).map(key => [key, ['id', 'corpusId'].includes(key) && row[key] != null ? id(row[key]) : row[key]]))
// List membership is a direct CorpusMember row. Detail membership also counts
// department membership and project members for project-backed corpora.
// Preserve both meanings instead of overwriting the list's filter context.
const combined = (entry: JsonObject, detail: JsonObject) => ({ ...entry, ...detail, isCorpusMember: entry.isCorpusMember, hasCorpusOrProjectMembership: typeof detail.isCorpusMember === 'boolean' ? detail.isCorpusMember : null })
const comments = (value: JsonObject[]) => value.map(row => ({ id: id(row.id), content: row.content, dateCreated: row.dateCreated, creator: { id: id(asObject(row.creator).id), showName: asObject(row.creator).showName } }))
export function docCollaborationSteps(action: DocCollaborationAction): Route[] {
  const start: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['visible', 'GET', base + '/cooperateList'], ['authority', 'GET', base + '/authority'], ['before', 'GET', base]]
  if (action === 'collaboration-list' || action === 'collaboration-inspect') return start
  if (action === 'collaboration-body') return [...start, ['content', 'GET', '/task/reditor/client/resource/get-delta']]
  if (action.startsWith('collaboration-comment')) {
    const context: Route[] = [...start, ['comments', 'GET', base + '/comments']]
    if (action === 'collaboration-comments') return context
    const directory: Route = ['directory', 'GET', '/task/v1/department/list']
    if (action === 'collaboration-comment-context') return [...context, directory]
    return [...context, directory, ['preflightVisible', 'GET', base + '/cooperateList'], ['preflightAuthority', 'GET', base + '/authority'], ['preflight', 'GET', base], ['changed', action === 'collaboration-comment-create' ? 'POST' : 'DELETE', base + '/comment' + (action === 'collaboration-comment-remove' ? '/{commentId}' : '')], ['verifiedComments', 'GET', base + '/comments']]
  }
  return [...start, ['preflightVisible', 'GET', base + '/cooperateList'], ['preflightAuthority', 'GET', base + '/authority'], ['preflight', 'GET', base], ['changed', action === 'collaboration-quit' ? 'POST' : 'PUT', base + (action === 'collaboration-quit' ? '/quitCooperateSummary' : '/{id}')], ['verifiedVisible', 'GET', base + '/cooperateList'], ['verifiedAuthority', 'GET', base + '/authority'], ['verified', 'GET', base]]
}
export async function runDocCollaboration(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  const session = requireSession(supplied), action = flow.docAction as DocCollaborationAction, completed: string[] = [], resources: JsonObject = {}
  let phase = 'identity', pending = false, changed = false
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) fail('未声明协作文档 HTTP 步骤。', 'INVALID_CONTRACT')
    phase = name; pending = false
    const transport: Transport = async (url, init) => {
      pending = op.effect !== 'read'
      const response = await (options.transport ?? request)(url, init)
      if (name === 'changed' && response.ok) {
        changed = true
        try { const receipt = asObject(parseJson(await response.clone().text())); if (receipt.id != null && action === 'collaboration-comment-create') resources.commentId = id(receipt.id) } catch { /* Preserve IDs before response schema validation. */ }
      }
      return response
    }
    const result = await runOperation(ctx, op, args, session, { ...options, transport })
    pending = false; completed.push(name); return result
  }
  const directory = async (step: string, all = true) => {
    const output: JsonObject[] = [], seen = new Set<string>(); let cursor: string | undefined
    for (let page = 0; page < 200; page++) {
      // The legacy handler uses Groovy truthiness: allSummary=false as a query
      // string would enable the all filter. Omit it for outside-space scope.
      const batch = rows(await call(step, { query: { max: 50, ...(cursor && { lastId: cursor }), ...(all && { allSummary: true }) } }))
      if (batch.length > 50) fail('协作目录服务忽略分页上限。')
      for (const row of batch) {
        const key = id(row.id); id(row.corpusId)
        if (seen.has(key) || typeof row.isCorpusMember !== 'boolean') fail('协作目录重复、游标未前进或缺少文集成员标志。')
        seen.add(key); output.push(row)
      }
      if (batch.length < 50) return output
      cursor = id(batch.at(-1)!.id)
    }
    fail('协作目录超过 10000 条，未执行写入或将截断目录当完整范围。', 'CONTEXT_LIMIT')
  }
  const get = async (entry: JsonObject, authorityStep: string, detailStep: string) => {
    const docId = id(entry.id), authority = await call(authorityStep, { query: { id: docId } })
    if (!preview(authority)) fail('当前协作文档没有实际预览权限，未读取正文。', 'RESOURCE_FORBIDDEN')
    const detail = asObject(await call(detailStep, { query: { id: docId } }))
    if (id(detail.id) !== docId || id(detail.corpusId) !== id(entry.corpusId) || detail.isNoteBook !== false || detail.isDisplay === false) fail('协作文档详情与实际目录范围不符。')
    if (detail.corpusType !== 'essays') fail('旧日报、周报和月报文档不在当前范围，请使用复盘。', 'RETIRED_BUSINESS')
    const members = rows(detail.members), own = members.filter(row => id(row.userId) === session.identity.userId)
    if (own.length !== 1 || !['read', 'write'].includes(String(own[0].role))) fail('当前文档详情未证实本人非创建者协作成员关系。', 'RESOURCE_NOT_VISIBLE')
    return detail
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources, result })
  try {
    const identity = asObject(await call('identity'))
    if (id(identity.id) !== session.identity.userId || id(asObject(identity.team).id) !== session.identity.teamId) fail('协作文档用户或公司与当前 profile 不符。', 'IDENTITY_CHANGED')
    const visible = await directory('visible', action !== 'collaboration-list' || input.scope !== 'outside-spaces')
    if (action === 'collaboration-list') {
      const offset = input.cursor == null ? 0 : visible.findIndex(row => id(row.id) === input.cursor) + 1
      if (input.cursor != null && offset === 0) fail('分页游标不属于当前实际协作目录。', 'INVALID_INPUT')
      const limit = Number(input.limit ?? 20), selected = visible.slice(offset, offset + limit), items: JsonObject[] = []; let excludedRetiredCount = 0, unavailableCount = 0
      for (const entry of selected) try { const detail = await get(entry, 'authority', 'before'); items.push(describe(combined(entry, detail))) } catch (error) {
        if (error instanceof RsqError && error.code === 'RETIRED_BUSINESS') excludedRetiredCount++
        else if (error instanceof RsqError && error.code === 'RESOURCE_FORBIDDEN') unavailableCount++
        else throw error
      }
      return done({ items, scannedCount: selected.length, scope: input.scope ?? 'all', hasMore: offset + selected.length < visible.length, nextCursor: offset + selected.length < visible.length ? id(selected.at(-1)!.id) : null, excludedRetiredCount, unavailableCount, completeDirectory: true, concurrency: 'observed-http-directory-without-server-cas' })
    }
    const entry = visible.find(row => id(row.id) === input.id)
    if (!entry) fail('该文档不属于当前用户实际协作目录；创建者文档请使用普通文档命令。', 'RESOURCE_NOT_VISIBLE')
    resources.documentId = id(entry.id)
    const before = await get(entry, 'authority', 'before'), contextVersion = hash({ entry, before })
    if (input.expectedVersion != null && input.expectedVersion !== contextVersion) fail('协作文档上下文已变化。', 'CONTEXT_CONFLICT')
    if (action === 'collaboration-inspect') return done({ document: describe(combined(entry, before)), contextVersion, membership: 'explicit-document-collaborator', spaceMembershipRequired: false })
    if (action === 'collaboration-body') {
      const content = docDelta(rows(await call('content', { query: { type: 'doc', id: input.id } })))
      return done({ document: describe(combined(entry, before)), content, contentHash: hash(content), concurrency: 'HTTP snapshot; no server revision or collaborative save claim' })
    }
    const fresh = async () => {
      const current = await directory('preflightVisible'), row = current.find(row => id(row.id) === input.id)
      if (!row) fail('写入前协作关系已失效。', 'CONTEXT_CONFLICT')
      const detail = await get(row, 'preflightAuthority', 'preflight')
      if (!isDeepStrictEqual(row, entry) || !isDeepStrictEqual(detail, before)) fail('协作关系、权限或文档在写入前发生变化。', 'CONTEXT_CONFLICT')
    }
    if (action.startsWith('collaboration-comment')) {
      const existing = rows(await call('comments', { query: { id: input.id } }))
      if (action === 'collaboration-comments') return done({ comments: comments(existing), complete: true })
      if (asObject(before.editControl).commentNote !== true) fail('当前协作文档没有评论权限。', 'RESOURCE_FORBIDDEN')
      const members = action === 'collaboration-comment-remove' ? undefined : await call('directory', { query: { cliContext: 'fresh' } })
      if (action === 'collaboration-comment-context') return done({ comments: comments(existing), ...docCommentDirectory(members), contextVersion, replyProtocol: 'mention-author-in-new-comment' })
      const payload = action === 'collaboration-comment-create' ? docCommentContent(input, members, existing, session) : undefined
      if (action === 'collaboration-comment-remove') {
        const selected = existing.find(row => id(row.id) === input.commentId)
        if (!selected || id(asObject(selected.creator).id) !== session.identity.userId) fail('只能删除该协作文档实际列表中的本人评论。', 'RESOURCE_FORBIDDEN')
      }
      await fresh()
      const receipt = await call('changed', action === 'collaboration-comment-create' ? { body: { noteId: input.id, ...payload } } : { path: { commentId: input.commentId } }), commentId = action === 'collaboration-comment-create' ? id(asObject(receipt).id) : id(input.commentId)
      resources.commentId = commentId
      const after = rows(await call('verifiedComments', { query: { id: input.id } })), selected = after.find(row => id(row.id) === commentId)
      if (action === 'collaboration-comment-create' ? !selected || selected.content !== payload!.content || id(asObject(selected.creator).id) !== session.identity.userId : selected != null) fail('协作评论未通过独立读回。', 'BUSINESS_ASSERTION_FAILED')
      return done({ comments: comments(after), commentId, ...(action === 'collaboration-comment-remove' && { removed: true }) })
    }
    if (action === 'collaboration-rename' && asObject(before.editControl).editNote !== true) fail('当前协作文档没有编辑权限。', 'RESOURCE_FORBIDDEN')
    await fresh()
    await call('changed', action === 'collaboration-quit' ? { body: { id: input.id } } : { path: { id: input.id }, body: { name: input.name } })
    const after = await directory('verifiedVisible'), selected = after.find(row => id(row.id) === input.id)
    if (action === 'collaboration-quit') {
      if (selected || visible.filter(row => id(row.id) !== input.id).some(old => !after.some(row => id(row.id) === id(old.id)))) fail('退出后仍有协作关系，或无关协作关系丢失。', 'BUSINESS_ASSERTION_FAILED')
      const authority = await call('verifiedAuthority', { query: { id: input.id } })
      if (preview(authority)) {
        const surviving = asObject(await call('verified', { query: { id: input.id } }))
        if (id(surviving.id) !== input.id || surviving.isDisplay === false || rows(surviving.members).some(row => id(row.userId) === session.identity.userId)) fail('退出后保留的文档或本人协作成员状态异常。', 'BUSINESS_ASSERTION_FAILED')
      }
      return done({ documentId: input.id, quit: true, documentDeleted: false, remainingAccess: preview(authority) ? 'preview-through-other-permission' : 'no-preview', verification: 'independent-collaboration-directory-and-preview-authority' })
    }
    if (!selected) fail('改名后协作关系消失。', 'BUSINESS_ASSERTION_FAILED')
    const verified = await get(selected, 'verifiedAuthority', 'verified')
    if (verified.name !== input.name) fail('协作文档名称没有独立保存。', 'BUSINESS_ASSERTION_FAILED')
    return done({ document: describe(combined(selected, verified)), contextVersion: hash({ entry: selected, before: verified }) })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '协作文档业务未完成。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, resources, cause: original.details, writeOutcome: pending ? 'unknown-do-not-retry' : changed ? 'applied-or-partial-do-not-retry' : 'no-confirmed-write', automaticRollback: false })
  }
}
