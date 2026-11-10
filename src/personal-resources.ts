import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { replayTextDelta } from './replay.js'
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '服务端未返回当前用户资源列表。', 5); return value.map(asObject) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
function selected(list: JsonObject[], id: unknown) {
  const resource = list.find(item => same(item.id, id))
  if (!resource) throw new RsqError('FORBIDDEN', '目标必须存在于当前用户资源列表；不会仅凭任意资源 ID 执行写入。', 4)
  return resource
}
export function personalMove(list: JsonObject[], input: JsonObject) {
  selected(list, input.id)
  if ((input.beforeId == null) === (input.afterId == null)) invalid('请明确指定 beforeId 或 afterId，且只能指定一个。')
  const targetId = input.beforeId ?? input.afterId
  if (same(input.id, targetId)) invalid('不能相对自身移动。')
  const ordered = list.filter(item => !same(item.id, input.id)).map(item => String(item.id)), index = ordered.indexOf(String(targetId))
  if (index < 0) throw new RsqError('FORBIDDEN', '排序目标不在当前用户列表中。', 4)
  ordered.splice(index + (input.afterId == null ? 0 : 1), 0, String(input.id))
  const position = ordered.indexOf(String(input.id))
  return { ordered, frontId: ordered[position - 1], nextId: ordered[position + 1] }
}
function favoriteRows(results: JsonObject, session: Session | null) {
  const userId = requireSession(session).identity.userId, list = rows(results.items)
  if (list.some(item => !same(item.creator, userId))) throw new RsqError('CONTEXT_MISSING', '个人收藏列表中存在其他创建者，未执行写入。', 4)
  return list
}
export function preparePersonalResource(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject {
  const action = kind.replace('personal-', ''), list = action.startsWith('favorite-') ? favoriteRows(results, session) : rows(results.items)
  if (action.startsWith('favorite-add-')) {
    const kind = action.slice('favorite-add-'.length), body: JsonObject = { collectedType: kind }
    if (kind === 'link') {
      let link: URL
      try { link = new URL(String(input.url)) } catch { return invalid('收藏链接须为完整 HTTP(S) 地址。') }
      if (!['https:','http:'].includes(link.protocol) || link.username || link.password) invalid('仅支持不含用户名和密码的 HTTP(S) 收藏地址。')
      body.realPath = input.url; body.name = input.name
    } else if (kind === 'file') {
      const file = asObject(results.file)
      if (!same(file.id, input.fileId)) invalid('文件元数据与目标 ID 不符。')
      body.fileId = input.fileId
    } else if (kind === 'doc') body.docId = input.docId
    else invalid('不支持的收藏类型。')
    if (input.source != null) body.type = input.source
    if (input.dataId != null) body.dataId = input.dataId
    const duplicate = list.find(item => kind === 'file' ? same(item.fileId, input.fileId) : kind === 'doc' ? same(item.docId, input.docId) : item.type === 'link' && item.realPath === input.url)
    if (duplicate) throw new RsqError('ALREADY_EXISTS', '目标已在个人收藏中，请使用已有收藏 ID，避免重复创建。', 2, { id: String(duplicate.id) })
    results.personalExpected = { type: kind, ...(body.fileId != null && { fileId: body.fileId }), ...(body.docId != null && { docId: body.docId }), ...(body.realPath != null && { realPath: body.realPath, name: body.name }) }
    return { body }
  }
  if (action.endsWith('-move')) {
    const move = personalMove(list, input)
    results.personalOrder = move.ordered
    return { body: { [action.startsWith('favorite-') ? 'moveId' : 'id']: input.id, ...(move.frontId && { frontId: move.frontId }), ...(move.nextId && { nextId: move.nextId }) } }
  }
  if (action.endsWith('-remove')) { selected(list, input.id); return { query: { id: input.id } } }
  if (action === 'inspiration-create' || action === 'inspiration-update') {
    if (action === 'inspiration-update') selected(list, input.id)
    const values = action === 'inspiration-update' ? asObject(input.patch) : input, body: JsonObject = action === 'inspiration-update' ? { id: input.id } : {}
    for (const key of ['name','color','cover']) if (Object.hasOwn(values, key)) body[key] = values[key]
    if (Object.hasOwn(values, 'text')) body.note = replayTextDelta(String(values.text))
    if (Object.hasOwn(values, 'delta')) body.note = JSON.stringify(values.delta)
    if (Object.hasOwn(values, 'text') && Object.hasOwn(values, 'delta')) invalid('text 与 delta 只能指定一种。')
    if (action === 'inspiration-create' && !String(body.name ?? '').trim() && !String(values.text ?? '').trim() && !values.delta) invalid('灵感需要标题或非空正文。')
    if (action === 'inspiration-create') { body.color ??= 1; body.cover ??= ''; body.note ??= replayTextDelta('') }
    results.personalExpected = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'id'))
    return { body }
  }
  throw new RsqError('INVALID_CONTRACT', '未知个人资源上下文适配。', 6)
}
export function verifyPersonalResource(input: JsonObject, results: JsonObject, step: string, session: Session | null) {
  const list = rows(results[step]), original = rows(results.items)
  if (step === 'verifiedFavorites' && list.some(item => !same(item.creator, requireSession(session).identity.userId))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '收藏读回创建者与当前身份不符。', 5)
  if (results.personalOrder) {
    if (!isDeepStrictEqual(list.map(item => String(item.id)), results.personalOrder)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '排序读回与当前列表预期不同，可能存在并发修改；不会覆盖或重放。', 5)
    return
  }
  if (input.id != null && input.patch == null) {
    if (list.some(item => same(item.id, input.id))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '删除的个人资源仍出现在列表中。', 5)
    return
  }
  const targetId = input.id ?? asObject(results.created).id, item = list.find(item => same(item.id, targetId))
  if (!item || input.id == null && original.some(old => same(old.id, item.id))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '独立列表读回未确认新建或修改资源。', 5)
  for (const [key, value] of Object.entries(asObject(results.personalExpected))) {
    const actual = item[key]
    const matches = ['docId','fileId'].includes(key) ? same(actual, value) : key === 'note' ? JSON.stringify(JSON.parse(String(actual))) === JSON.stringify(JSON.parse(String(value))) : isDeepStrictEqual(actual, value)
    if (!matches) throw new RsqError('BUSINESS_ASSERTION_FAILED', '个人资源独立读回不符：' + key, 5)
  }
}
export function describePersonalResources(input: JsonObject, results: JsonObject, favorite: boolean) {
  if (favorite) {
    const list = rows(results.verifiedFavorites ?? results.items), project = (item: JsonObject) => Object.fromEntries(['id','name','type','displayOrder','creator','invalid','fileId','docId','contentType','fromWhere','dataId','editControl', ...(item.type === 'link' ? ['realPath'] : [])].filter(key => Object.hasOwn(item, key)).map(key => [key === 'realPath' ? 'url' : key, item[key]]))
    if (results.created) return project(selected(list, asObject(results.created).id))
    return { items: list.map(project), ...(results.personalOrder != null && { order: results.personalOrder }), ...(input.id != null && !results.personalOrder && { removedId: input.id }) }
  }
  const list = rows(results.verifiedInspirations ?? results.items)
  if (results.created) return selected(list, asObject(results.created).id)
  if (input.id && input.patch) return selected(list, input.id)
  if (input.id && !results.personalOrder && !results.verifiedInspirations) return selected(list, input.id)
  return { items: list, ...(results.personalOrder != null && { order: results.personalOrder }), ...(input.id != null && !results.personalOrder && { removedId: input.id }) }
}
