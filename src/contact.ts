import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const deny = (message: string): never => { throw new RsqError('FORBIDDEN', message, 4) }
const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
function idOf(item: JsonObject) {
  if (!/^[1-9][0-9]*$/.test(String(item.id)) || typeof item.id === 'number' && !Number.isSafeInteger(item.id)) throw new RsqError('CONTEXT_MISSING', '公司目录包含无效或不精确的资源 ID。', 5)
  return String(item.id)
}
function list(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '公司目录或成员列表缺失。', 5)
  return value.map(item => { const object = asObject(item); idOf(object); return object })
}
function flatten(value: unknown) {
  const nodes: JsonObject[] = [], seen = new Set<string>()
  function walk(items: unknown, parent?: string) {
    for (const node of list(items)) {
      const id = idOf(node)
      if (seen.has(id) || seen.size >= 10000 || !['top','common','unassigned'].includes(String(node.type)) || parent && !same(node.parentId, parent)) throw new RsqError('CONTEXT_MISSING', '部门树重复、层级不一致或超过遍历上限。', 5)
      seen.add(id); nodes.push(node); list(node.userList); walk(node.childList, id)
    }
  }
  walk(value); return nodes
}
function target(items: JsonObject[], id: unknown) { return items.find(item => same(item.id, id)) ?? deny('目标资源不在当前公司的实际目录中。') }
function users(nodes: JsonObject[]) { return [...new Map(nodes.flatMap(node => list(node.userList)).map(user => [idOf(user),user])).values()] }
export function companyDirectoryUsers(value: unknown) { return users(flatten(value)) }
export function companyDirectoryDepartments(value: unknown) { return flatten(value).map(node => ({ id: idOf(node), name: node.name, type: node.type })) }
export function companyDirectoryUnits(value: unknown) { return flatten(value).filter(node => node.type !== 'unassigned').map(node => ({ id: idOf(node), name: node.name })) }
const ids = (values: JsonObject[]) => values.map(idOf)
function descendants(node: JsonObject): JsonObject[] { return [node, ...list(node.childList).flatMap(descendants)] }
function assertMembers(wanted: string[], actual: JsonObject[]) {
  if (!isDeepStrictEqual([...wanted].sort(), ids(actual).sort())) fail('独立读回的成员集合与预期不一致；可能有并发修改，不会覆盖或重发。')
}
function move(items: JsonObject[], input: JsonObject) {
  if ((input.beforeId == null) === (input.afterId == null)) invalid('请且仅提供 beforeId 或 afterId。')
  const current = target(items, input.id), anchor = target(items, input.beforeId ?? input.afterId)
  if (same(current.id, anchor.id)) invalid('移动目标与相对锚点不能相同。')
  const rest = items.filter(item => !same(item.id, current.id)), index = rest.indexOf(anchor) + (input.afterId == null ? 0 : 1)
  return { order: [...rest.slice(0,index),current,...rest.slice(index)].map(idOf), ...(rest[index-1] && { frontId: idOf(rest[index-1]!) }), ...(rest[index] && { nextId: idOf(rest[index]!) }) }
}
function identity(results: JsonObject, supplied: Session | null, input: JsonObject) {
  const session = requireSession(supplied), user = asObject(results.user)
  if (!same(user.id, session.identity.userId) || !same(asObject(user.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '通讯录上下文与当前身份或公司不一致。', 3)
  if (!same(input.companyId, session.identity.teamId)) invalid('公司高位操作必须明确提供与当前 profile 一致的 companyId。')
  return user
}
export function prepareContact(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject {
  const action = kind.replace('contact-', '')
  if (action === 'group-context') { target(list(results.groups),input.id); return { path: { id: input.id } } }
  const user = identity(results, supplied, input), permissions = asObject(results.authorities)
  const permission = action === 'departments-set' ? 'editStaffInfo' : action.startsWith('department-') ? 'editDept' : action.startsWith('group-member-') ? 'editStaffGroupMember' : 'editStaffGroup'
  if (permissions[permission] !== true) deny('当前用户没有通讯录操作所需的公司权限：' + permission)
  const oauth = asObject(user.oauth), origin = String(oauth.userFrom ?? ''), isIsv = /^(qywx|dingtalk|lark|wps|wp$)/.test(origin), canModify = asObject(oauth.isvOuterData).canModifyDepartment === true
  const nodes = flatten(results.tree), groups = results.groups ? list(results.groups) : []
  const prepared: JsonObject = { action }; results.prepared = prepared
  if (action.startsWith('department-') || action === 'departments-set') {
    const patch = asObject(input.patch)
    if (isIsv && !canModify && (action !== 'department-update' || patch.parentId != null || patch.name != null && !origin.startsWith('qywx'))) deny('此身份的通讯录由第三方平台同步，UI 不允许修改当前部门结构或成员归属。')
    if (action === 'department-create') {
      const parent = target(nodes, input.parentId)
      if (parent.type === 'unassigned') invalid('不能在未分配部门下创建部门。')
      if (!String(input.name).trim()) invalid('部门名称不能为空白。')
      return { body: { parentId: input.parentId, name: input.name } }
    }
    if (action === 'departments-set') {
      const selected = input.userIds as string[], departmentIds = input.departmentIds as string[]
      for (const id of selected) target(users(nodes), id)
      for (const id of departmentIds) target(nodes, id)
      if (departmentIds.some(id => target(nodes,id).type === 'unassigned') && departmentIds.length > 1) invalid('未分配部门不能和其他部门同时选中。')
      prepared.userIds = selected; prepared.departmentIds = departmentIds.length ? departmentIds : [idOf(nodes.find(node => node.type === 'unassigned') ?? deny('目录中缺少未分配部门。'))]
      return { body: { userIds: selected.join(','), departmentIds: departmentIds.join(',') } }
    }
    const node = target(nodes,input.id)
    if (node.type !== 'common') deny('UI 不允许修改、排序或删除根部门和未分配部门。')
    prepared.id = input.id; prepared.before = node
    if (action === 'department-update') {
      if (patch.name != null && !String(patch.name).trim()) invalid('部门名称不能为空白。')
      if (patch.parentId != null) {
        const parent = target(nodes,patch.parentId)
        if (parent.type === 'unassigned' || descendants(node).some(child => same(child.id,parent.id))) invalid('父部门不能是未分配部门、目标本身或其子部门。')
      }
      if (Array.isArray(patch.leaderIds)) for (const id of patch.leaderIds) target(list(node.userList),id)
      prepared.expected = { name: patch.name ?? node.name, parentId: patch.parentId ?? node.parentId, leaderIds: patch.leaderIds ?? ids(list(node.leaderList)) }
      return { path: { id: input.id }, body: { ...(patch.name != null && { name: patch.name }), ...(patch.parentId != null && { parentId: patch.parentId }), ...(Array.isArray(patch.leaderIds) && { leaderIds: patch.leaderIds.join(',') }) } }
    }
    if (action === 'department-remove') {
      prepared.removedIds = ids(descendants(node)); prepared.userIds = ids(users(descendants(node))); prepared.parentId = node.parentId
      return { path: { id: input.id } }
    }
    if (action === 'department-move') {
      const siblings = nodes.filter(item => same(item.parentId,node.parentId) && item.type === 'common'), moved = move(siblings,input)
      prepared.order = moved.order; prepared.parentId = node.parentId
      return { body: { id: input.id, ...(moved.frontId && { frontId: moved.frontId }), ...(moved.nextId && { nextId: moved.nextId }) } }
    }
  }
  if (action === 'group-create') {
    if (!String(input.name).trim()) invalid('小组名称不能为空白。')
    return { body: { name: input.name } }
  }
  const group = target(groups,input.id); prepared.id = input.id
  if (action === 'group-rename') {
    if (!String(input.name).trim()) invalid('小组名称不能为空白。')
    return { body: { id: input.id, name: input.name } }
  }
  if (action === 'group-remove') return { path: { id: input.id } }
  if (action === 'group-move') {
    const moved = move(groups,input); prepared.order = moved.order
    return { body: { id: input.id, ...(moved.frontId && { frontId: moved.frontId }), ...(moved.nextId && { lastId: moved.nextId }) } }
  }
  if (action.startsWith('group-member-')) {
    const before = asObject(results.group)
    if (!same(before.id,group.id)) deny('小组详情与当前公司目录目标不一致。')
    const requested = input.userIds as string[], current = ids(list(before.users))
    for (const id of requested) target(users(nodes),id)
    if (action.endsWith('-remove') && requested.some(id => !current.includes(id))) deny('待移除成员不在当前小组中。')
    prepared.expectedMembers = action.endsWith('-add') ? [...new Set([...current,...requested])] : current.filter(id => !requested.includes(id))
    return { body: { groupId: input.id, userIds: requested.join(',') } }
  }
  throw new RsqError('INVALID_CONTRACT','未知通讯录上下文适配。',6)
}
export function verifyContact(input: JsonObject, results: JsonObject, step: string) {
  const prepared = asObject(results.prepared), action = String(prepared.action), created = asObject(results.created)
  if (step === 'verifiedGroup') { const group = asObject(results[step]); if (!same(group.id,input.id)) fail('小组详情 ID 与目标不一致。'); assertMembers(prepared.expectedMembers as string[],list(group.users)); return }
  if (step === 'verifiedGroups') {
    const groups = list(results[step])
    if (action === 'group-remove') { if (groups.some(item => same(item.id,input.id))) fail('小组仍存在。'); return }
    if (action === 'group-move') { if (!isDeepStrictEqual(ids(groups),prepared.order)) fail('小组顺序未在独立读回中确认。'); return }
    const group = groups.find(item => same(item.id,action === 'group-create' ? created.id : input.id))
    if (!group || group.name !== input.name) fail('小组创建或名称未在独立列表中确认。')
    return
  }
  const nodes = flatten(results[step])
  if (action === 'department-create') { const node = nodes.find(item => same(item.id,created.id)); if (!node || node.name !== input.name || !same(node.parentId,input.parentId)) fail('新部门未在独立公司目录中确认。'); return }
  if (action === 'department-update') {
    const node = nodes.find(item => same(item.id,input.id)), expected = asObject(prepared.expected)
    if (!node || node.name !== expected.name || !same(node.parentId,expected.parentId)) fail('部门修改未在独立目录中确认。')
    assertMembers(expected.leaderIds as string[],list(node!.leaderList)); return
  }
  if (action === 'department-remove') {
    if (nodes.some(node => (prepared.removedIds as string[]).includes(idOf(node)))) fail('待删除部门子树仍有节点存在。')
    const parent = nodes.find(node => same(node.id,prepared.parentId)), members = parent ? ids(list(parent.userList)) : []
    if ((prepared.userIds as string[]).some(id => !members.includes(id))) fail('部门子树成员迁移到父部门的结果未确认。')
    return
  }
  if (action === 'department-move') { if (!isDeepStrictEqual(ids(nodes.filter(node => same(node.parentId,prepared.parentId) && node.type === 'common')),prepared.order)) fail('部门兄弟顺序未在独立目录中确认。'); return }
  if (action === 'departments-set') {
    for (const id of prepared.userIds as string[]) {
      const actual = nodes.filter(node => list(node.userList).some(user => same(user.id,id))).map(idOf)
      if (!isDeepStrictEqual(actual.sort(),[...(prepared.departmentIds as string[])].sort())) fail('成员的完整部门归属未在独立目录中确认。')
    }
  }
}
const safeUser = (user: JsonObject) => ({ ...Object.fromEntries(['id','showName','personRealName','companyRealName','professional','username','email','phoneNumber','role','deptNames'].filter(key => Object.hasOwn(user,key)).map(key => [key,user[key]])),
  ...(user.leader != null && { leader: Object.fromEntries(['id','showName'].filter(key => Object.hasOwn(asObject(user.leader),key)).map(key => [key,asObject(user.leader)[key]])) }) })
export function describeContact(input: JsonObject, results: JsonObject) {
  const action = String(asObject(results.prepared).action ?? ''), rawTree = results.verifiedTree ?? results.tree, rawGroups = results.verifiedGroups ?? results.groups
  if (!action && input.id != null && !results.group) target(flatten(rawTree), input.id)
  const departments = rawTree ? flatten(rawTree).map(node => ({ id: String(node.id), name: node.name, type: node.type, parentId: node.parentId == null ? null : String(node.parentId), level: node.level, displayOrder: node.displayOrder, memberIds: ids(list(node.userList)), leaderIds: ids(list(node.leaderList)) })) : []
  const group = results.verifiedGroup ?? results.group
  const groups = rawGroups ? list(rawGroups).map(item => ({ id: String(item.id), name: item.name, displayOrder: item.displayOrder, ...(item.userCount != null && { userCount: item.userCount }) })) : []
  return { departments, groups, ...(rawTree != null && { members: users(flatten(rawTree)).map(safeUser) }), ...(group != null && { group: { ...Object.fromEntries(['id','name','displayOrder','userCount'].map(key => [key,asObject(group)[key]])), users: list(asObject(group).users).map(safeUser) } }),
    ...(results.created != null && { createdId: String(asObject(results.created).id) }), ...(input.id != null && { targetId: input.id }), ...(action === 'department-remove' && { removedIds: asObject(results.prepared).removedIds, relocatedMemberIds: asObject(results.prepared).userIds, parentId: asObject(results.prepared).parentId }), verified: Boolean(results.verifiedTree || results.verifiedGroups || results.verifiedGroup) }
}
