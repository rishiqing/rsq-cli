import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type Context, type JsonObject } from './core.js'
import { sessionOrigin, type Session } from './session.js'

export const docPublicationActions = ['publication-inspect', 'publication-enable', 'publication-disable'] as const
export type DocPublicationAction = typeof docPublicationActions[number]
type Call = (name: string, input?: JsonObject) => Promise<unknown>
type Scan = () => Promise<Map<string, JsonObject>>
function fail(code: string, message: string, exit = 5): never { throw new RsqError(code, message, exit) }
function exactId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value
  return fail('CONTEXT_MISSING', '文集发布资源缺少精确 ID。')
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const spaceVersion = (value: JsonObject) => Object.fromEntries(['id', 'name', 'type', 'attribute', 'isRelease', 'canBeShared', 'editControl', 'encodeCorpusId'].map(key => [key, value[key]]))
const treeVersion = (tree: Map<string, JsonObject>) => [...tree].map(([id, row]) => [id, Object.fromEntries(['name', 'isNoteBook', 'noteBookId', 'corpusId', 'isOpenToMember', 'isShare', 'lastUpdated', 'displayOrder'].map(key => [key, row[key]]))]).sort(([a], [b]) => String(a).localeCompare(String(b)))
const key = (row: JsonObject) => JSON.stringify([row.name, row.isNoteBook, row.displayOrder])
function items(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) fail('CONTEXT_MISSING', '匿名文集目录缺失。')
  return (value as unknown[]).map(asObject)
}
export async function runDocPublication(ctx: Context, action: DocPublicationAction, input: JsonObject, session: Session,
  space: JsonObject, tree: Map<string, JsonObject>, call: Call, scan: Scan) {
  const spaceId = exactId(space.id)
  if (space.type !== 'essays' || typeof space.isRelease !== 'boolean' || typeof space.canBeShared !== 'boolean') fail('CONTEXT_MISSING', '文集未声明当前普通业务及公开范围。')
  const documents = [...tree.values()].filter(row => row.isNoteBook === false), privatelyVisible = documents.filter(row => row.isOpenToMember !== false)
  const separatelyShared = documents.filter(row => row.isShare === true).map(row => exactId(row.id))
  const detail = async (row: JsonObject) => {
    const value = asObject(await call('document', { query: { id: exactId(row.id) } }))
    if (exactId(value.id) !== exactId(row.id) || exactId(value.corpusId) !== spaceId || value.isNoteBook !== false || value.name !== row.name
      || value.isOpenToMember !== row.isOpenToMember || value.isShare !== row.isShare) fail('CONTEXT_CONFLICT', '文档详情与文集目录的归属或公开设置不一致。')
    return value
  }
  const probe = async (current: JsonObject, currentTree: Map<string, JsonObject>, publicationWasReachable = false) => {
    const shareId = current.encodeCorpusId
    if (!uuid(shareId)) {
      if (current.isRelease) fail('VERIFICATION_FAILED', '已发布文集没有当前 32 hex UUID；不猜测旧分享编码。')
      return { accessible: false, verified: false, reason: 'no-current-publication-uuid' }
    }
    try {
      const publicSpace = asObject(await call('publicSpace', { query: { id: shareId } }))
      if (current.isRelease !== true) fail('PUBLIC_ACCESS_REMAINS', '文集已取消发布，但同一匿名入口仍可访问。')
      if (publicSpace.id !== shareId || publicSpace.name !== current.name) fail('VERIFICATION_FAILED', '匿名文集 UUID 或名称与当前目标不符。')
      const queue: { privateParent?: string; publicParent?: string; depth: number }[] = [{ depth: 0 }], found = new Set<string>(), publicDocuments: JsonObject[] = []
      for (let index = 0; index < queue.length; index++) {
        if (queue.length > 1000 || queue[index].depth > 64) fail('CONTEXT_MISSING', '匿名文集目录超出完整核对上限。')
        const parent = queue[index], expected = [...currentTree.values()].filter(row => (row.noteBookId == null ? undefined : exactId(row.noteBookId)) === parent.privateParent && row.isOpenToMember === false)
        const lookup = new Map<string, JsonObject>()
        for (const row of expected) {
          if (lookup.has(key(row))) fail('AMBIGUOUS_CONTEXT', '同一目录中存在无法独立映射的同名同顺序节点，不能猜测分享 ID。')
          lookup.set(key(row), row)
        }
        const rows = items(await call('publicTree', { query: { corpusId: shareId, ...(parent.publicParent && { noteBookId: parent.publicParent }), allData: true } }))
        if (rows.length !== expected.length) fail('VERIFICATION_FAILED', '匿名目录与应发布的完整可见目录数量不一致。')
        for (const row of rows) {
          const source = lookup.get(key(row))
          if (!source || !uuid(row.id) || found.has(row.id) || row.corpusId !== shareId || (row.noteBookId ?? undefined) !== parent.publicParent) fail('VERIFICATION_FAILED', '匿名目录存在重复、额外、缺少或错误父级节点。')
          lookup.delete(key(row)); found.add(row.id)
          if (found.size > 10000) fail('CONTEXT_MISSING', '匿名目录超过完整核对上限。')
          if (row.isNoteBook === true) queue.push({ privateParent: exactId(source.id), publicParent: row.id, depth: parent.depth + 1 })
          else {
            const privateDocument = await detail(source)
            if (privateDocument.encodeSummaryId !== row.id) fail('VERIFICATION_FAILED', '匿名文档 UUID 与同一私有文档不一致。')
            const publicDocument = asObject(await call('publicDocument', { query: { id: row.id } }))
            if (publicDocument.id !== row.id || publicDocument.name !== source.name || exactId(publicDocument.corpusId) !== spaceId || publicDocument.isNoteBook !== false || typeof publicDocument.note !== 'string') fail('VERIFICATION_FAILED', '匿名文档正文、标题或归属与发布目录不一致。')
            publicDocuments.push({ documentId: exactId(source.id), shareId: row.id, contentSha256: createHash('sha256').update(publicDocument.note).digest('hex') })
          }
        }
      }
      return { accessible: true, verified: true, credentialSent: false, shareId, url: sessionOrigin(ctx, session.method) + '/collect/' + shareId,
        completeVisibleTreeCompared: true, nodes: found.size, documents: publicDocuments }
    } catch (error) {
      if (error instanceof RsqError && error.code === 'BUSINESS_ERROR' && String(asObject(error.details).upstreamCode) === '403316') {
        if (current.isRelease) fail('VERIFICATION_FAILED', '文集发布标记已开启，但匿名服务拒绝访问；会员或成员条件可能不满足。')
        // This service code also means missing members or insufficient edition.
        // Report its ambiguity even when the same link was reachable before.
        return { accessible: false, verified: publicationWasReachable, credentialSent: false, shareId, upstreamCode: '403316',
          publicationWasReachable, denialCause: 'unpublished-or-member-or-edition-restriction', denialCauseVerified: false }
      }
      throw error
    }
  }
  if (action === 'publication-inspect') return { spaceId, isRelease: space.isRelease, canMaintain: asObject(space.editControl).editCorpusPreferences === true,
    privateDocumentIds: privatelyVisible.map(row => exactId(row.id)), separatelySharedDocumentIds: separatelyShared,
    privateDocumentProtection: 'current-pinned-server-public-detail-does-not-enforce-isOpenToMember', anonymousAccess: await probe(space, tree), changed: false }
  if (asObject(space.editControl).editCorpusPreferences !== true) fail('RESOURCE_FORBIDDEN', '当前用户没有文集偏好及发布维护权限。', 4)
  const enabled = action === 'publication-enable'
  if (enabled && privatelyVisible.length) fail('PRIVATE_PUBLICATION_UNSAFE', '当前服务端的公开正文未核对仅协作者可见标记；此文集含受限文档，已在发布前停止。请先修复服务端公开读取条件。', 4)
  const priorAccess = space.isRelease ? await probe(space, tree) : null
  const fresh = asObject(await call('space', { path: { id: spaceId } })), freshTree = await scan()
  if (!isDeepStrictEqual(spaceVersion(space), spaceVersion(fresh)) || !isDeepStrictEqual(treeVersion(tree), treeVersion(freshTree))) fail('CONTEXT_CONFLICT', '文集公开范围、权限或目录在写入前变化，未修改发布开关。', 4)
  let changed = false
  if (space.isRelease !== enabled) {
    const response = asObject(await call('changed', { body: { corpusId: spaceId, isRelease: enabled } }))
    if (exactId(response.id) !== spaceId || response.isRelease !== enabled || !uuid(response.encodeCorpusId)) fail('VERIFICATION_FAILED', '发布写入响应与目标文集不符；先核对资源，不能重放。')
    changed = true
  }
  const after = asObject(await call('verified', { path: { id: spaceId } })), afterTree = await scan()
  if (exactId(after.id) !== spaceId || after.type !== space.type || after.name !== space.name || after.isRelease !== enabled || after.canBeShared !== space.canBeShared
    || !isDeepStrictEqual(after.editControl, space.editControl) || !isDeepStrictEqual(treeVersion(tree), treeVersion(afterTree))) fail('VERIFICATION_FAILED', '发布独立读回与应保留的目录、权限或单篇策略不一致。')
  const anonymousAccess = await probe(after, afterTree, priorAccess?.accessible === true), documentAccess: JsonObject[] = []
  if (!enabled) for (const row of documents) {
    const privateDocument = await detail(row), shareId = privateDocument.encodeSummaryId
    if (!uuid(shareId)) { documentAccess.push({ documentId: exactId(row.id), verified: false, reason: 'no-current-share-uuid' }); continue }
    try {
      const publicDocument = asObject(await call('publicDocument', { query: { id: shareId } }))
      if (!(row.isShare === true && after.canBeShared === true)) fail('PUBLIC_ACCESS_REMAINS', '取消整库发布后，未单独分享的正文仍能匿名访问。')
      if (publicDocument.id !== shareId || publicDocument.name !== row.name || exactId(publicDocument.corpusId) !== spaceId) fail('VERIFICATION_FAILED', '保留单篇分享的正文与目标不一致。')
      documentAccess.push({ documentId: exactId(row.id), accessible: true, verified: true, reason: 'individually-shared-link-preserved' })
    } catch (error) {
      if (!(row.isShare === true && after.canBeShared === true) && error instanceof RsqError && error.code === 'BUSINESS_ERROR' && String(asObject(error.details).upstreamCode) === '401029') documentAccess.push({ documentId: exactId(row.id), accessible: false, verified: true, upstreamCode: '401029' })
      else throw error
    }
  }
  return { spaceId, isRelease: enabled, changed, publicationStateVerified: true, anonymousAccess, documentAccess,
    separatelySharedDocumentIds: separatelyShared, individualShareFlagsPreserved: true, privateContentProtectionRequiresBackendFix: true,
    concurrency: 'fresh-preflight-and-readback; no-atomic-compare-and-swap' }
}
