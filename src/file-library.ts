import { asObject, RsqError, type JsonObject } from './core.js'
import type { Session } from './session.js'
import { describeContact } from './contact.js'

const fail = (message: string, code = 'CONTEXT_CONFLICT'): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'PERMISSION_DENIED' ? 4 : 5) }
const id = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return String(value)
  return fail('文件库上下文缺少有效的日事清 ID。', 'CONTEXT_MISSING')
}
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('文件库服务未返回完整列表。', 'CONTEXT_MISSING')
const roleOf = (member: JsonObject) => asObject(member.role ?? member.teamRole)
function library(input: JsonObject, results: JsonObject) {
  const value = asObject(results.before)
  if (id(value.id) !== id(input.libraryId) || value.parentFolderId != null || !Array.isArray(value.userRoles) || typeof value.creator === 'object') {
    fail('目标必须是普通顶级文件库；子目录和项目文档模块使用各自的业务命令。')
  }
  const members = rows(value.userRoles), ids = members.map(member => id(member.userId))
  if (new Set(ids).size !== ids.length || members.filter(member => roleOf(member).type === 'libCreator').length !== 1) fail('文件库成员或拥有者上下文不完整。', 'CONTEXT_MISSING')
  return value
}
function permitted(value: JsonObject, permission: string) {
  if (asObject(value.editControl)[permission] !== true) fail('当前文件库未授予权限：' + permission, 'PERMISSION_DENIED')
}
function expected(results: JsonObject, value: JsonObject) {
  results.libraryExpected = { ...asObject(results.libraryExpected), ...value }
}
function listed(results: JsonObject) {
  const items = rows(results.libraries), ids = items.map(item => id(item.id))
  if (ids.length !== new Set(ids).size || items.some(item => typeof item.displayOrder !== 'number' || !Number.isFinite(item.displayOrder))) fail('文件库顺序列表不完整。', 'CONTEXT_MISSING')
  return [...items].sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder))
}
export function prepareFileLibrary(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  if (kind === 'library-created-readback') return { query: { id: id(asObject(results.changed).id) } }
  if (kind === 'library-create') {
    expected(results, { name: input.name, color: input.color ?? 1, createdOwnerId: id(session?.identity.userId) })
    return { body: { name: input.name, color: input.color ?? 1, position: input.position ?? 'top' } }
  }
  const before = library(input, results), libraryId = id(before.id), members = rows(before.userRoles)
  const beforeIds = members.map(member => id(member.userId)), owner = members.find(member => roleOf(member).type === 'libCreator')!
  if (kind === 'library-update') {
    const patch = asObject(input.patch)
    if (Object.hasOwn(patch, 'name')) permitted(before, 'renameLib')
    if (Object.hasOwn(patch, 'color')) permitted(before, 'editLibColor')
    expected(results, { name: patch.name ?? before.name, color: patch.color ?? before.color, members: beforeIds,
      preservedRoles: members.map(member => ({ userId: id(member.userId), roleId: id(roleOf(member).id) })) })
    return { path: { id: libraryId }, body: patch }
  }
  if (kind === 'library-members-add' || kind === 'library-members-remove') {
    const selected = (input.userIds as unknown[]).map(id), remove = kind.endsWith('remove')
    if (!remove) {
      const visible = rows(describeContact({}, { tree: results.directory }).members).map(member => id(member.id))
      if (selected.some(userId => !visible.includes(userId))) fail('新增成员必须属于当前可见的公司通讯录；先发现成员，不猜隐藏或跨公司 ID。', 'INVALID_INPUT')
    }
    const currentUser = id(session?.identity.userId)
    if (remove && selected.some(userId => userId === currentUser || userId === id(owner.userId))) fail('不能通过成员集合移除自己或拥有者；请使用退出或拥有者转移操作。', 'INVALID_INPUT')
    const ids = remove ? beforeIds.filter(value => !selected.includes(value)) : [...new Set([...beforeIds, ...selected])]
    expected(results, { members: ids, preservedRoles: members.filter(member => ids.includes(id(member.userId))).map(member => ({ userId: id(member.userId), roleId: id(roleOf(member).id) })) })
    if (ids.length === beforeIds.length && ids.every(value => beforeIds.includes(value))) return null
    permitted(before, remove ? 'removeLibMember' : 'addLibMember')
    return { path: { id: libraryId }, body: { memberIds: ids.join(',') } }
  }
  if (kind === 'library-member-role' || kind === 'library-owner-transfer') {
    const userId = id(input.userId), member = members.find(member => id(member.userId) === userId)
    if (!member) fail('目标尚不是文件库成员；请先发现成员或添加成员。', 'INVALID_INPUT')
    const roles = rows(results.roles), transfer = kind === 'library-owner-transfer'
    const candidates = roles.filter(role => transfer ? role.type === 'libCreator' : id(role.id) === id(input.roleId))
    if (candidates.length !== 1) fail('角色不属于当前公司的文件库角色；先查看 file library context。', 'INVALID_INPUT')
    const selected = candidates[0]
    if (!transfer && (selected.type === 'libCreator' || roleOf(member!).type === 'libCreator')) fail('拥有者变更必须使用 file library owner transfer 并显式确认。', 'INVALID_INPUT')
    const roleId = id(selected.id)
    if (transfer && roleOf(member!).type === 'libCreator') {
      expected(results, { members: beforeIds, preservedRoles: members.map(member => ({ userId: id(member.userId), roleId: id(roleOf(member).id) })) })
      return null
    }
    const writeRoles = transfer ? roles.filter(role => role.type === 'libWrite') : []
    if (transfer && writeRoles.length !== 1) fail('当前公司缺少唯一的拥有者转移后角色。', 'CONTEXT_MISSING')
    expected(results, { members: beforeIds, roleUserId: userId, roleId, transfer,
      ...(transfer && { previousOwnerId: id(owner.userId), previousOwnerRoleId: id(writeRoles[0].id) }),
      preservedRoles: members.filter(m => id(m.userId) !== userId && (!transfer || roleOf(m).type !== 'libCreator')).map(m => ({ userId: id(m.userId), roleId: id(roleOf(m).id) })) })
    if (id(roleOf(member!).id) === roleId) return null
    if (!transfer) permitted(before, 'editLibMemberRole')
    // Public dispatch checks the separate current company authority before
    // reaching this adapter; ordinary resource role-edit authority is distinct.
    return { body: { folderId: libraryId, userId, roleId } }
  }
  if (kind === 'library-join') {
    const userId = id(session?.identity.userId)
    expected(results, { members: [...new Set([...beforeIds, userId])], preservedRoles: members.map(member => ({ userId: id(member.userId), roleId: id(roleOf(member).id) })) })
    if (beforeIds.includes(userId)) return null
    return { body: { libId: libraryId } }
  }
  if (kind === 'library-reorder') {
    const items = listed(results), others = items.filter(item => id(item.id) !== libraryId).map(item => id(item.id))
    if (!items.some(item => id(item.id) === libraryId)) fail('目标不在当前用户可见的完整文件库列表中。')
    const frontId = input.frontId == null ? null : id(input.frontId), nextId = input.nextId == null ? null : id(input.nextId)
    const index = frontId == null ? 0 : others.indexOf(frontId) + 1
    if (frontId != null && index === 0 || (others[index] ?? null) !== nextId) fail('排序前后节点不相邻或已过期；请重新读取文件库列表。')
    expected(results, { order: [...others.slice(0, index), libraryId, ...others.slice(index)] })
    return { body: { moveId: libraryId, ...(frontId && { frontId }), ...(nextId && { nextId }) } }
  }
  if (kind === 'library-remove') {
    permitted(before, 'removeLib')
    if (!listed(results).some(item => id(item.id) === libraryId)) fail('待删除文件库不在当前可见列表中。')
    expected(results, { removed: libraryId })
    return { path: { id: libraryId } }
  }
  return fail('未知文件库上下文适配。', 'INVALID_CONTRACT')
}
export function verifyFileLibrary(input: JsonObject, results: JsonObject, stepId: string) {
  if (stepId === 'before') { library(input, results); return }
  const wanted = asObject(results.libraryExpected), actual = results[stepId]
  const assert = (condition: boolean, message: string) => { if (!condition) fail(message, 'BUSINESS_ASSERTION_FAILED') }
  if (wanted.removed) {
    assert(!rows(actual).some(item => id(item.id) === wanted.removed), '删除后文件库仍出现在完整列表中。'); return
  }
  if (wanted.order) {
    const actualIds = rows(actual).sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder)).map(item => id(item.id))
    assert(JSON.stringify(actualIds) === JSON.stringify(wanted.order), '排序读回与预期完整顺序不同。'); return
  }
  const value = asObject(actual), target = input.libraryId ?? asObject(results.changed).id
  assert(id(value.id) === id(target), '读回的文件库 ID 不一致。')
  for (const key of ['name', 'color']) if (Object.hasOwn(wanted, key)) assert(value[key] === wanted[key], '文件库 ' + key + ' 未持久化。')
  if (wanted.createdOwnerId) {
    const owners = rows(value.userRoles).filter(member => roleOf(member).type === 'libCreator')
    assert(owners.length === 1 && id(owners[0].userId) === wanted.createdOwnerId, '新文件库的拥有者不正确。')
  }
  if (wanted.members) {
    const members = rows(value.userRoles), actualIds = members.map(member => id(member.userId)).sort()
    assert(JSON.stringify(actualIds) === JSON.stringify([...(wanted.members as string[])].sort()), '文件库成员增减读回不一致；服务端可能忽略了无效或跨组织成员。')
    for (const kept of rows(wanted.preservedRoles ?? [])) assert(members.some(member => id(member.userId) === kept.userId && id(roleOf(member).id) === kept.roleId), '成员操作改变了应保留的角色。')
    if (wanted.roleUserId) assert(members.some(member => id(member.userId) === wanted.roleUserId && id(roleOf(member).id) === wanted.roleId), '目标成员角色未持久化。')
    if (wanted.transfer) assert(members.filter(member => roleOf(member).type === 'libCreator').length === 1, '转移后拥有者数量不正确。')
    if (wanted.previousOwnerId) assert(members.some(member => id(member.userId) === wanted.previousOwnerId && id(roleOf(member).id) === wanted.previousOwnerRoleId), '转移后原拥有者未保留为公司的可编辑角色。')
  }
}
