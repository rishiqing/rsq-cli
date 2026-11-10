import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type Context, type JsonObject } from './core.js'
import { sessionOrigin, type Session } from './session.js'

export const docSharingActions = ['share-inspect', 'share-enable', 'share-disable'] as const
export type DocSharingAction = typeof docSharingActions[number]
type Call = (name: string, input?: JsonObject) => Promise<unknown>
function fail(message: string, code = 'VERIFICATION_FAILED'): never { throw new RsqError(code, message, code === 'RESOURCE_FORBIDDEN' ? 4 : 5) }
const exactId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : fail('分享资源缺少精确 ID。')
const version = (row: JsonObject) => Object.fromEntries(['id', 'name', 'corpusId', 'isNoteBook', 'isShare', 'encodeSummaryId', 'lastUpdated', 'editControl', 'isOpenToMember', 'forbidEdit'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))
const spaceVersion = (row: JsonObject) => Object.fromEntries(['id', 'type', 'canBeShared', 'isRelease', 'editControl'].map(key => [key, row[key]]))
export async function runDocSharing(ctx: Context, action: DocSharingAction, input: JsonObject, session: Session, before: JsonObject, space: JsonObject, call: Call) {
  const documentId = exactId(before.id), spaceId = exactId(space.id)
  const validate = (row: JsonObject) => {
    if (exactId(row.id) !== documentId || exactId(row.corpusId) !== spaceId || row.isNoteBook !== false || typeof row.isShare !== 'boolean') fail('分享文档与真实资源或状态不一致。')
    return row
  }
  validate(before)
  if (typeof space.canBeShared !== 'boolean' || typeof space.isRelease !== 'boolean') fail('文集没有声明单篇分享或整个文集发布状态，不能猜测实际公开范围。', 'CONTEXT_MISSING')
  const probe = async (row: JsonObject, released: boolean) => {
    const uuid = row.encodeSummaryId
    const shouldBePublic = row.isShare === true || released
    if (typeof uuid !== 'string' || !/^[a-f0-9]{32}$/.test(uuid)) {
      if (shouldBePublic) fail('已公开文档没有有效的当前分享 UUID，不能回退旧版 Base64 ID。')
      return { accessible: false, verified: false, reason: 'no-current-share-uuid' }
    }
    try {
      const shared = asObject(await call('public', { query: { id: uuid } }))
      if (!shouldBePublic) fail('不携带凭证仍能读取文档，公开访问没有撤销。', 'PUBLIC_ACCESS_REMAINS')
      if (shared.id !== uuid || shared.name !== row.name || exactId(shared.corpusId) !== spaceId || shared.isNoteBook !== false || typeof shared.note !== 'string') fail('匿名 HTTP 返回的文档身份、标题、归属或正文不一致。')
      return { accessible: true, verified: true, credentialSent: false, shareId: uuid, url: sessionOrigin(ctx, session.method) + '/share/doc/' + uuid, contentFormat: 'html', contentSha256: createHash('sha256').update(shared.note).digest('hex'), inheritedFromPublishedSpace: released }
    } catch (error) {
      if (error instanceof RsqError && error.code === 'BUSINESS_ERROR' && String(asObject(error.details).upstreamCode) === '401029') {
        if (shouldBePublic) fail('分享标记已开启，但无凭证 HTTP 仍明确返回未分享，不能认定公开成功。')
        return { accessible: false, verified: true, credentialSent: false, shareId: uuid, upstreamCode: '401029' }
      }
      // A missing resource, authentication denial, proxy 404 or timeout does not
      // demonstrate that the existing public link has been revoked.
      throw error
    }
  }
  if (action === 'share-inspect') return { documentId, spaceId, isShare: before.isShare, spacePublished: space.isRelease, canShare: asObject(before.editControl).shareNote === true && asObject(before.editControl).editNote === true && space.canBeShared, anonymousAccess: await probe(before, space.isRelease), changed: false }
  if (asObject(before.editControl).shareNote !== true || asObject(before.editControl).editNote !== true || !space.canBeShared) fail('当前公开 UI 要求文集允许分享，且文档同时具有 shareNote 和 editNote 权限。', 'RESOURCE_FORBIDDEN')
  if (action === 'share-disable' && space.isRelease) fail('整个文集仍已发布，关闭单篇开关不能撤销匿名访问。请先明确处理文集发布范围；未修改任何开关。', 'PUBLISHED_SPACE')
  const freshSpace = asObject(await call('space', { path: { id: spaceId } })), fresh = validate(asObject(await call('before', { query: { id: documentId } })))
  if (!isDeepStrictEqual(spaceVersion(space), spaceVersion(freshSpace)) || !isDeepStrictEqual(version(before), version(fresh))) fail('文集发布、文档分享或权限在写入前变化，未修改开关。', 'CONTEXT_CONFLICT')
  const enabled = action === 'share-enable'
  let changed = false
  if (before.isShare !== enabled) { await call('changed', { path: { id: documentId }, body: { isShare: enabled } }); changed = true }
  const after = validate(asObject(await call('verified', { query: { id: documentId } }))), afterSpace = asObject(await call('space', { path: { id: spaceId } }))
  if (!isDeepStrictEqual(spaceVersion(space), spaceVersion(afterSpace))) fail('写入后文集发布范围或权限改变，须重新核对公开访问，不重放。', 'CONTEXT_CONFLICT')
  if (after.isShare !== enabled || after.name !== before.name || after.isOpenToMember !== before.isOpenToMember || after.forbidEdit !== before.forbidEdit) fail('分享独立读回与稀疏修改不一致。')
  const anonymousAccess = await probe(after, afterSpace.isRelease as boolean)
  if (!anonymousAccess.verified) fail('没有可独立验证的分享链接；未将元信息开关当作撤销证明。')
  return { documentId, spaceId, isShare: after.isShare, spacePublished: afterSpace.isRelease, changed, verified: true, anonymousAccess, concurrency: 'fresh-preflight-and-readback; no-atomic-compare-and-swap' }
}
