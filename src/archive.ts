import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

function fail(message: string, code = 'BUSINESS_ASSERTION_FAILED'): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('档案上下文缺少精确资源 ID。', 'CONTEXT_MISSING')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('档案上下文不是完整列表。', 'CONTEXT_MISSING')
const optionalId = (value: unknown) => value == null || value === '' ? null : id(value)
const name = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : fail('名称须为 1 至 200 字且不能为空白或含控制字符。', 'INVALID_INPUT')
function memberRoles(bag: JsonObject, requireUnique = true) {
  const members = rows(bag.userRoles).map(member => ({ userId: id(member.userId), role: { id: id(asObject(member.role).id), type: asObject(member.role).type } })).sort((a, b) => a.userId.localeCompare(b.userId) || a.role.id.localeCompare(b.role.id))
  if (requireUnique && new Set(members.map(member => member.userId)).size !== members.length) fail('档案袋成员重复。', 'CONTEXT_MISSING')
  return members
}
function bagState(bag: JsonObject, requireUnique = true) { return { id: id(bag.id), name: bag.name, teamId: id(bag.teamId), creatorId: id(bag.creatorId), groupId: optionalId(bag.archiveGroupId), members: memberRoles(bag, requireUnique), editControl: bag.editControl } }
function getBag(list: unknown, target: unknown, session: Session | null) {
  const identity = requireSession(session).identity, bag = rows(list).find(bag => id(bag.id) === target)
  if (!bag || id(bag.teamId) !== identity.teamId || !memberRoles(bag).some(member => member.userId === identity.userId)) fail('档案袋不是当前公司中本人实际所属的可见资源。', 'FORBIDDEN')
  const creators = memberRoles(bag).filter(member => member.role.type === 'archiveCreator')
  if (creators.length !== 1 || creators[0]!.userId !== id(bag.creatorId)) fail('档案袋创建者角色与资源归属不一致。', 'CONTEXT_MISSING')
  return bag
}
const permission = (bag: JsonObject, key: string) => { if (asObject(bag.editControl)[key] !== true) fail('当前档案袋 UI 权限不允许此操作：' + key, 'FORBIDDEN') }
export function archiveTarget(list: unknown, target: unknown, session: Session | null) {
  const bag = getBag(list, target, session); permission(bag, 'allowArchiving'); return bag
}
function group(list: unknown, target: unknown) { return rows(list).find(item => id(item.id) === target) ?? fail('目标分组不在当前公司有效目录中。', 'INVALID_INPUT') }
function roles(value: unknown) { return Array.isArray(value) ? rows(value) : Object.keys(asObject(value)).length === 0 ? [] : fail('档案角色响应格式未知。', 'CONTEXT_MISSING') }
function sameBag(input: JsonObject, results: JsonObject, session: Session | null) {
  const before = getBag(results.bags, input.bagId, session), latest = getBag(results.preflight, input.bagId, session)
  if (!isDeepStrictEqual(bagState(before), bagState(latest))) fail('档案袋名称、归属、成员或权限已变化；不会覆盖或重放。', 'CONTEXT_CONFLICT')
  return latest
}
function save(results: JsonObject, value: JsonObject) { results.prepared = { ...asObject(results.prepared), ...value } }
const archiveTypes = [
  [1, '日程'], [2, '项目'], [3, '模块'], [4, '卡片'], [5, '任务'], [6, '文集'], [7, '笔记本'], [8, '笔记'], [9, '文件夹'], [10, '文件'], [12, '流程应用'], [13, '已发起的流程'], [14, '风险'],
].map(([id, name]) => ({ id, name }))
function calendarDay(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) fail('日期须为有效的 YYYY-MM-DD 日历日期。', 'INVALID_INPUT')
  const date = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('日期须为有效的 YYYY-MM-DD 日历日期。', 'INVALID_INPUT')
  return value
}
function itemFilters(input: JsonObject, results: JsonObject) {
  const query: JsonObject = { id: input.bagId, max: input.limit ?? 20 }
  if (input.types !== undefined) {
    if (!Array.isArray(input.types) || !input.types.length || new Set(input.types).size !== input.types.length || input.types.some(type => !archiveTypes.some(item => item.id === type))) fail('类型须从 archive items context 发现的类型中明确选择，不能使用旧版类型。', 'INVALID_INPUT')
    query.type = input.types.join(',')
  }
  if (input.operatorId !== undefined) {
    if (!companyDirectoryUsers(results.directory).some(user => id(user.id) === input.operatorId)) fail('归档人须从当前公司新鲜目录中选择。', 'INVALID_INPUT')
    query.userId = input.operatorId
  }
  if (input.startDate !== undefined || input.endDate !== undefined) {
    const start = calendarDay(input.startDate), end = calendarDay(input.endDate)
    if (start > end || end === '9999-12-31') fail('须同时提供有序的起止日期；终日须能计算次日边界。', 'INVALID_INPUT')
    const next = new Date(end + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1)
    query.startDate = start.replaceAll('-', '.'); query.endDate = next.toISOString().slice(0, 10).replaceAll('-', '.')
  }
  return query
}
function filteredItems(input: JsonObject, value: unknown) {
  return rows(value).filter(row => {
    if (Array.isArray(input.types) && !input.types.includes(row.type)) fail('服务端返回了所选类型范围外的档案。')
    if (input.operatorId !== undefined && id(row.userId) !== input.operatorId) fail('服务端返回了所选归档人范围外的档案。')
    if (input.startDate !== undefined) {
      // The service uses an inclusive midnight endpoint. Request the next day
      // then exclude that boundary, so the CLI's endDate is a whole calendar day.
      if (typeof row.dateCreated !== 'string' || !/^\d{4}\.\d{2}\.\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(row.dateCreated)) fail('无法核对档案的归档日期格式。', 'CONTEXT_MISSING')
      const day = calendarDay(row.dateCreated.slice(0, 10).replaceAll('.', '-'))
      return day >= String(input.startDate) && day <= String(input.endDate)
    }
    return true
  })
}
const filterContext = () => ({ types: archiveTypes, typeSelection: 'use-actual-record-type; current-personal-tasks-may-also-be-type-5', order: 'id-desc', orderingSelectable: false, dateRange: { input: 'YYYY-MM-DD', timezone: 'Asia/Shanghai', startInclusive: true, endInclusive: true, precision: 'calendar-day' }, operatorMeaning: 'archive-record-creator; not-source-resource-member' })
export function prepareArchive(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const action = kind.slice('archive-'.length), identity = requireSession(session).identity
  if (action.startsWith('resource-')) return prepareArchiveResource(action.slice('resource-'.length), input, results, session)
  if (action === 'group-children') { group(results.groups, input.groupId); return { query: { id: input.groupId } } }
  if (action === 'group-create-parent') return input.parentId == null ? null : { query: { id: input.parentId } }
  if (action === 'group-create') {
    if (input.parentId != null) group(results.groups, input.parentId)
    save(results, { action, name: name(input.name), parentId: input.parentId ?? null })
    return { body: { name: input.name, ...(input.parentId != null && { archiveGroupId: input.parentId }) } }
  }
  if (action === 'group-rename' || action === 'group-remove') {
    const before = group(results.groups, input.groupId), latest = group(results.preflightGroups, input.groupId)
    if (!isDeepStrictEqual(before, latest)) fail('档案分组在操作前已变化。', 'CONTEXT_CONFLICT')
    if (action === 'group-remove' && (rows(results.children).length || rows(results.preflightChildren).length)) fail('先用 group children 发现依赖，显式移动档案袋并逐个处理子分组；不能隐式影响后代。', 'DEPENDENCY_EXISTS')
    save(results, { action, targetId: input.groupId, ...(action === 'group-rename' && { name: name(input.name) }) })
    return action === 'group-remove' ? { query: { id: input.groupId } } : { body: { id: input.groupId, name: input.name } }
  }
  if (action === 'bag-create') {
    if (input.groupId != null) group(results.groups, input.groupId)
    save(results, { action, name: name(input.name), groupId: input.groupId ?? null })
    return { body: { name: input.name, position: input.position ?? 'bottom', ...(input.groupId != null && { archiveGroupId: input.groupId }) } }
  }
  if (action === 'items-context' || action === 'items-filter-directory') {
    getBag(results.bags, input.bagId, session)
    return action === 'items-filter-directory' && input.operatorId === undefined ? null : { query: { cliContext: 'fresh' } }
  }
  if (action === 'items') { getBag(results.bags, input.bagId, session); return { query: itemFilters(input, results) } }
  if (action === 'bag-items-before') { getBag(results.bags, input.bagId, session); return { query: { id: input.bagId, max: 1 } } }
  const bag = sameBag(input, results, session), before = bagState(bag)
  save(results, { action, targetId: input.bagId, expected: before })
  if (action === 'bag-rename') {
    permission(bag, 'renameArchiveBag'); const next = name(input.name)
    save(results, { expected: { ...before, name: next } }); return before.name === next ? null : { body: { id: input.bagId, name: next } }
  }
  if (action === 'bag-move') {
    permission(bag, 'selectArchiveBagGroup')
    if (input.groupId != null) group(results.groups, input.groupId)
    save(results, { expected: { ...before, groupId: input.groupId } })
    return before.groupId === input.groupId ? null : { body: { archiveBagId: input.bagId, archiveGroupId: input.groupId ?? '' } }
  }
  if (action === 'bag-members') {
    const chosen = input.memberIds as string[], actual = before.members.map(member => member.userId)
    if (!Array.isArray(chosen) || new Set(chosen).size !== chosen.length || !chosen.includes(identity.userId) || !chosen.includes(before.creatorId)) fail('完整成员集合必须保留当前用户和创建者，且不能重复。', 'INVALID_INPUT')
    const available = new Set(companyDirectoryUsers(results.directory).map(user => id(user.id)))
    if (chosen.some(member => !available.has(member))) fail('新成员必须来自当前公司的新鲜通讯录。', 'INVALID_INPUT')
    const added = chosen.filter(member => !actual.includes(member)), removed = actual.filter(member => !chosen.includes(member))
    if (added.length) permission(bag, 'addArchiveBagMember')
    if (removed.length) permission(bag, 'removeArchiveBagMember')
    const defaults = roles(results.roles).filter(role => role.type === 'archiveWrite')
    if (added.length && defaults.length !== 1) fail('无法识别当前公司的默认档案编辑角色。', 'CONTEXT_MISSING')
    const members = [...before.members.filter(member => chosen.includes(member.userId)), ...added.map(userId => ({ userId, role: { id: id(defaults[0]!.id), type: 'archiveWrite' } }))].sort((a, b) => a.userId.localeCompare(b.userId))
    save(results, { expected: { ...before, members } })
    return added.length || removed.length ? { body: { id: input.bagId, memberIds: chosen.join(',') } } : null
  }
  if (action === 'bag-role') {
    permission(bag, 'editArchiveBagMemberRole')
    const member = before.members.find(member => member.userId === input.memberId), role = roles(results.roles).find(role => id(role.id) === input.roleId)
    if (!member || member.userId === before.creatorId || !role || role.type === 'archiveCreator') fail('只能修改实际普通成员，目标角色须从当前公司目录选择且不能为创建者。', 'INVALID_INPUT')
    save(results, { expected: { ...before, members: before.members.map(item => item === member ? { ...item, role: { id: id(role.id), type: role.type } } : item) } })
    return member.role.id === input.roleId ? null : { body: { id: input.bagId, memberId: input.memberId, roleId: input.roleId } }
  }
  if (action === 'bag-leave') {
    permission(bag, 'quitArchiveBag')
    if (before.creatorId === identity.userId) fail('创建者不能退出并遗留无创建者档案袋。', 'FORBIDDEN')
    return { body: { id: input.bagId } }
  }
  if (action === 'bag-remove') {
    permission(bag, 'removeArchiveBag')
    if (rows(results.items).length || rows(results.preflightItems).length) fail('先显式处理可见档案资源，再删除档案袋；不会隐式隐藏这些档案。', 'DEPENDENCY_EXISTS')
    return { query: { id: input.bagId } }
  }
  fail('未知档案业务适配。', 'INVALID_CONTRACT')
}
function publicBag(bag: JsonObject) {
  const state = bagState(bag, false), creators = state.members.filter(member => member.role.type === 'archiveCreator')
  const ambiguous = new Set(state.members.map(member => member.userId)).size !== state.members.length || creators.length !== 1 || creators[0]!.userId !== state.creatorId
  return { ...state, ...(ambiguous && { contextStatus: 'ambiguous-membership', writable: false, issue: '服务返回重复成员或创建者角色不一致；保留原始角色供发现，禁止据此猜测或修改目标。' }) }
}
function publicChild(row: JsonObject): JsonObject { return row.archiveType === 'archiveBag' ? { archiveType: 'archiveBag', ...publicBag(row) } : Object.fromEntries(['id', 'name', 'parentGroup', 'archiveType', 'hasChild', 'subItems'].filter(key => row[key] !== undefined).map(key => [key, key === 'subItems' && row[key] !== null ? rows(row[key]).map(publicChild) : row[key]])) }
function preservedBags(before: unknown, after: unknown, except?: string) {
  const states = (value: unknown) => rows(value).filter(bag => id(bag.id) !== except).map(bag => bagState(bag, false)).sort((a, b) => a.id.localeCompare(b.id))
  if (!isDeepStrictEqual(states(before), states(after))) fail('其他可见档案袋的名称、归属或成员权限发生变化；请核对已完成步骤，不会重放。')
}
export function describeArchive(input: JsonObject, results: JsonObject, session: Session | null) {
  const prepared = asObject(results.prepared), action = String(prepared.action ?? ''), currentBags = results.verifiedBags ?? results.bags
  if (action.startsWith('resource-')) return describeArchiveResource(input, results)
  if (action.startsWith('group-')) {
    const current = rows(results.verifiedGroups), created = asObject(results.created), targetId = action === 'group-create' ? id(created.id) : String(prepared.targetId)
    const found = current.find(row => id(row.id) === targetId), removed = action === 'group-remove'
    if (removed ? found !== undefined : !found || found.name !== prepared.name) fail('档案分组独立读回不一致。')
    const stable = (list: JsonObject[]) => list.filter(row => id(row.id) !== targetId).sort((a, b) => id(a.id).localeCompare(id(b.id)))
    const previous = stable(rows(results.groups)), others = stable(current)
    if (!isDeepStrictEqual(previous, others)) fail('其他档案分组发生变化；请核对结果，不会重放。')
    if (action === 'group-create') {
      const siblings = prepared.parentId == null ? rows(asObject(results.verifiedRoot).archiveGroupList) : rows(results.verifiedParent)
      if (!siblings.some(row => id(row.id) === targetId && row.name === prepared.name && optionalId(row.parentGroup) === prepared.parentId) || id(created.teamId) !== requireSession(session).identity.teamId) fail('新分组的实际父级或公司归属未通过独立核对。')
    }
    if (results.verifiedBags) preservedBags(results.bags, results.verifiedBags)
    return { ...(removed ? { removed: true } : { group: found }), groupId: targetId, ...(action === 'group-create' && { parentId: prepared.parentId }) }
  }
  if (action.startsWith('bag-')) {
    const created = asObject(results.created), targetId = action === 'bag-create' ? id(created.id) : String(prepared.targetId), removed = action === 'bag-remove' || action === 'bag-leave'
    const found = rows(currentBags).find(bag => id(bag.id) === targetId)
    if (removed ? found !== undefined : !found) fail('档案袋独立列表读回不一致。')
    preservedBags(results.bags, currentBags, targetId)
    if (!removed) {
      const actual = bagState(getBag(currentBags, targetId, session))
      if (action === 'bag-create') {
        if (actual.name !== prepared.name || actual.groupId !== prepared.groupId || actual.creatorId !== requireSession(session).identity.userId || actual.members.length !== 1 || actual.members[0]!.userId !== actual.creatorId) fail('新档案袋未保持本人创建者和明确归属。')
      } else {
        const expected = asObject(prepared.expected)
        // A role change may change the actor's own UI permissions. All other
        // business properties and every member's actual role must still match.
        if (!isDeepStrictEqual({ ...actual, editControl: undefined }, { ...expected, editControl: undefined })) fail('档案袋修改后的名称、归属或完整成员角色不一致。')
      }
      return { bag: publicBag(found!) }
    }
    return { bagId: targetId, removed: action === 'bag-remove', left: action === 'bag-leave' }
  }
  if (results.items) {
    const visible = filteredItems(input, results.items), serverReturned = rows(results.items).length
    return { bag: publicBag(getBag(results.bags, input.bagId, session)), items: visible.map(row => Object.fromEntries(['id', 'name', 'type', 'resourceId', 'dateCreated', 'userId', 'showName'].filter(key => row[key] !== undefined).map(key => [key, row[key]]))),
      filters: { ...filterContext(), selected: Object.fromEntries(['types', 'operatorId', 'startDate', 'endDate'].filter(key => input[key] !== undefined).map(key => [key, input[key]])) },
      pagination: { requestedLimit: input.limit ?? 20, returned: visible.length, serverReturned, possiblyTruncated: serverReturned >= Number(input.limit ?? 20), pageSizeEnforced: false, serverLimitScope: 'direct-member-branch-only; department-visible-branch-is-unbounded', cursorSupported: false, scope: 'currently-visible-only' } }
  }
  if (results.directory !== undefined && input.bagId !== undefined) return { bag: publicBag(getBag(results.bags, input.bagId, session)), filters: filterContext(), operators: companyDirectoryUsers(results.directory).map(user => ({ id: id(user.id), name: user.showName ?? user.companyRealName ?? user.personRealName ?? user.name })) }
  return { ...(results.groups !== undefined && { groups: rows(results.groups) }), ...(results.bags !== undefined && { bags: rows(results.bags).map(publicBag) }), ...(results.roles !== undefined && { roles: roles(results.roles) }),
    ...(results.root !== undefined && { root: { groups: rows(asObject(results.root).archiveGroupList).map(publicChild), ungroupedBags: rows(asObject(results.root).archiveBagList).map(publicBag) } }),
    ...(results.children !== undefined && { groupId: input.groupId, children: rows(results.children).map(publicChild) }), tree: 'groups are a flat current-company directory; use group children for lazy descendants' }
}

function archiveRecord(row: JsonObject) {
  if (!Number.isInteger(row.type) || Number(row.type) < 1 || Number(row.type) > 14 || typeof row.resourceId !== 'string' && typeof row.resourceId !== 'number') fail('档案记录缺少当前已核对类型及源资源 ID。', 'CONTEXT_MISSING')
  return { id: id(row.id), name: row.name, type: row.type, resourceId: String(row.resourceId), userId: row.userId, dateCreated: row.dateCreated }
}
function selectedRecords(list: unknown, input: JsonObject) {
  const wanted = Array.isArray(input.itemIds) ? input.itemIds : [input.itemId], available = rows(list).map(archiveRecord)
  return wanted.map(target => available.find(row => row.id === target) ?? fail('所选档案记录不在本次实际可见查询窗口；可增大 limit 后重新发现，不能猜记录 ID。', 'CONTEXT_MISSING'))
}
function recordSnapshot(list: unknown) { return rows(list).map(archiveRecord).sort((a, b) => a.id.localeCompare(b.id)) }
function taskSnapshot(task: JsonObject) { return Object.fromEntries(['id', 'name', 'from', 'members', 'participants', 'progress', 'isDone', 'rrule', 'forbidEdit'].map(key => [key, task[key]])) }
function taskWhere(input: JsonObject, task?: JsonObject) {
  const projectId = input.projectId ?? asObject(task?.from).projectId
  return projectId == null ? { module: 'common', siteId: 'common' } : { module: 'project', siteId: id(projectId) }
}
function archiveTaskRecord(results: JsonObject, input: JsonObject) {
  const record = selectedRecords(results.items, input)[0]!
  if (![1, 5].includes(Number(record.type))) fail('此命令仅恢复任务；其他类型须发现对应业务和父级，不能通过 type 参数绕过记录权限。', 'INVALID_INPUT')
  return record
}
function prepareArchiveResource(action: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const max = input.limit ?? 200
  if (action === 'items' || action === 'target-items') {
    const bagId = action === 'items' ? input.bagId : input.targetBagId
    getBag(results.bags, bagId, session); return { query: { id: bagId, max } }
  }
  if (action === 'task-detail') return { query: { id: input.taskId, ...taskWhere(input) } }
  if (action === 'task-project') return input.projectId == null ? null : { query: { id: input.projectId } }
  if (action === 'task-permissions') return { query: { taskId: input.taskId, ...taskWhere(input) } }
  if (action === 'task-before-restore') {
    const record = archiveTaskRecord(results, input)
    return { query: { id: record.resourceId, module: 'archive', siteId: input.bagId } }
  }
  if (action === 'task-source') {
    const prepared = asObject(results.prepared), restored = prepared.action === 'resource-task-restore'
    if (restored && asObject(results.changed).hasParent !== true) fail('原位置不可恢复；本次未完成恢复，须先发现合法父级再继续，不能重复提交或猜父级。', 'RESTORE_TARGET_REQUIRED')
    return { query: { id: prepared.taskId, ...(restored ? taskWhere({}, asObject(results.task)) : { module: 'archive', siteId: input.bagId }) } }
  }
  const bag = sameBag(input, results, session)
  if (action === 'task-archive') {
    permission(bag, 'allowArchiving')
    const task = asObject(results.task), fresh = asObject(results.preflightTask), permissions = asObject(results.permissions), where = taskWhere(input)
    if (task.id !== input.taskId || !isDeepStrictEqual(taskSnapshot(task), taskSnapshot(fresh))) fail('任务内容或归属在写前已变化，不能覆盖或重放。', 'CONTEXT_CONFLICT')
    const actualProject = optionalId(asObject(task.from).projectId)
    if (actualProject !== (input.projectId ?? null) || input.projectId != null && String(asObject(results.project).id) !== input.projectId) fail('项目任务须显式指定其实际项目，不能沿用个人任务上下文。', 'INVALID_INPUT')
    if (input.projectId != null) {
      const project = asObject(results.project)
      if (!Object.hasOwn(project, 'coverId') || project.coverId !== null) fail('任务归档的项目上下文必须是实际普通项目；模板不能复用此写入入口。', 'INVALID_INPUT')
      if (project.teamId != null && id(project.teamId) !== requireSession(session).identity.teamId) fail('源项目不属于当前公司的任务归档上下文。', 'FORBIDDEN')
    }
    if (task.forbidEdit === true || permissions.taskId !== input.taskId || permissions.module !== where.module || permissions.siteId !== where.siteId || asObject(permissions.editControl).archiveTask !== true) fail('当前任务的独立 archiveTask 权限不允许归档。', 'FORBIDDEN')
    const previous = recordSnapshot(results.items)
    if (previous.some(row => row.resourceId === input.taskId && [1, 5].includes(Number(row.type)))) fail('目标袋中已有此任务的档案记录；先读回核对，不重复归档。', 'CONTEXT_CONFLICT')
    save(results, { action: 'resource-task-archive', taskId: input.taskId, previous, expectedTask: taskSnapshot(task), resources: { taskId: input.taskId, bagId: input.bagId } })
    return { body: { taskId: input.taskId, bagId: input.bagId, ...where } }
  }
  const selected = selectedRecords(results.items, input), fresh = selectedRecords(results.preflightItems, input)
  if (!isDeepStrictEqual(selected, fresh)) fail('所选档案记录内容或归属已变化，不能继续写入。', 'CONTEXT_CONFLICT')
  const chosen = selected.map(row => row.id)
  save(results, { action: 'resource-' + action, selected, previous: recordSnapshot(results.items), resources: { bagId: input.bagId, archiveRecordIds: chosen.join(','), ...(input.targetBagId != null && { targetBagId: input.targetBagId }) } })
  if (action === 'items-move') {
    permission(bag, 'moveArchiveFile')
    const target = getBag(results.bags, input.targetBagId, session), latest = getBag(results.preflight, input.targetBagId, session)
    if (!isDeepStrictEqual(bagState(target), bagState(latest))) fail('目标档案袋成员、归属或权限已变化。', 'CONTEXT_CONFLICT')
    permission(latest, 'allowArchiving')
    save(results, { previousTarget: recordSnapshot(results.targetItems) })
    if (input.targetBagId === input.bagId) return null
    return { body: { ids: chosen.join(','), archiveBagId: input.targetBagId } }
  }
  if (action === 'items-remove') { permission(bag, 'removeArchiveFile'); return { query: { id: chosen.join(',') } } }
  if (action === 'task-restore') {
    permission(bag, 'resetArchiveFile')
    const record = archiveTaskRecord(results, input), task = asObject(results.task)
    if (task.id !== record.resourceId || !isDeepStrictEqual(taskSnapshot(task), taskSnapshot(asObject(results.preflightTask)))) fail('归档任务的源上下文在写前变化或不属于所选记录。', 'CONTEXT_CONFLICT')
    save(results, { taskId: record.resourceId, expectedTask: taskSnapshot(task), resources: { ...asObject(asObject(results.prepared).resources), taskId: record.resourceId } })
    return { body: { id: record.id } }
  }
  return fail('未知档案资源业务适配。', 'INVALID_CONTRACT')
}
export function verifyArchive(input: JsonObject, results: JsonObject, step: string) {
  const prepared = asObject(results.prepared), action = prepared.action
  if (step === 'verifiedItems') {
    const current = recordSnapshot(results.verifiedItems), selected = action === 'resource-task-archive' ? [] : rows(prepared.selected), sameTarget = action === 'resource-items-move' && input.bagId === input.targetBagId
    if (action === 'resource-task-archive') {
      const previous = rows(prepared.previous), found = current.filter(row => row.resourceId === prepared.taskId && [1, 5].includes(Number(row.type)) && !previous.some(old => old.id === row.id))
      if (found.length !== 1 || found[0]!.name !== asObject(prepared.expectedTask).name) fail('归档事件尚未形成唯一、匹配的真实任务档案记录。')
      save(results, { createdRecord: found[0], resources: { ...asObject(prepared.resources), archiveRecordId: found[0]!.id } })
    } else if (!sameTarget && current.some(row => selected.some(item => item.id === row.id))) fail('档案记录在源袋独立读回中仍然存在。')
    for (const previous of rows(prepared.previous)) if (!selected.some(item => item.id === previous.id) && !current.some(row => isDeepStrictEqual(row, previous))) fail('其他已观察档案记录的独立读回不一致；不会重放。')
  }
  if (step === 'verifiedTarget') {
    const current = recordSnapshot(results.verifiedTarget)
    if (rows(prepared.selected).some(item => !current.some(row => isDeepStrictEqual(row, item)))) fail('目标袋未读回所有被移动的实际档案记录。')
    for (const previous of rows(prepared.previousTarget)) if (!current.some(row => isDeepStrictEqual(row, previous))) fail('目标袋的其他已观察记录未保持；先核对结果或增大查询窗口，不重放。')
  }
  if (step === 'source') {
    const task = asObject(results.source), expected = asObject(prepared.expectedTask)
    if (task.id !== prepared.taskId || task.name !== expected.name || !isDeepStrictEqual(task.members, expected.members)) fail('任务源业务未通过独立 HTTP 核对。')
    if (action === 'resource-task-restore' && asObject(results.changed).hasParent !== true) fail('还原回执未确认实际父级。')
  }
}
function describeArchiveResource(input: JsonObject, results: JsonObject) {
  const prepared = asObject(results.prepared)
  if (prepared.action === 'resource-task-archive' || prepared.action === 'resource-task-restore') {
    const source = asObject(results.source), from = asObject(source.from)
    return { task: { id: prepared.taskId, name: source.name, members: rows(source.members).map(member => ({ id: member.id, ...(member.name !== undefined && { name: member.name }) })), from: Object.fromEntries(['type', 'projectId', 'planId', 'cardId', 'taskPosition'].filter(key => from[key] !== undefined).map(key => [key, from[key]])) }, ...(prepared.action === 'resource-task-archive' ? { archived: true, record: prepared.createdRecord } : { restored: true, recordId: input.itemId }), verification: 'independent-archive-list-and-source-http' }
  }
  return { ...(prepared.action === 'resource-items-move' ? { movedRecordIds: rows(prepared.selected).map(row => row.id), targetBagId: input.targetBagId } : { hiddenRecordIds: rows(prepared.selected).map(row => row.id) }), bagId: input.bagId, verificationScope: 'selected-records-and-previously-observed-http-window', sourceResourcesDestroyed: false }
}
