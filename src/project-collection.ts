import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { isDeepStrictEqual } from 'node:util'
import { companyDirectoryUsers } from './contact.js'

const numeric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
const key = (value: unknown) => { if (!numeric(value)) throw new RsqError('CONTEXT_MISSING', '项目集缺少有效的资源 ID。', 5); return String(value) }
const objects = (value: unknown) => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '项目集服务未返回预期列表。', 5); return value.map(asObject) }
function members(value: unknown): (JsonObject & { id: string })[] {
  const rows: (JsonObject & { id: string })[] = objects(asObject(value).members).map(member => ({ ...member, id: key(member.userId ?? member.id) }))
  if (new Set(rows.map(member => member.id)).size !== rows.length || rows.some(member => !['creator', 'common'].includes(String(member.role)))) throw new RsqError('CONTEXT_MISSING', '项目集成员重复或角色不明确。', 5)
  return rows
}
function ownerOf(value: unknown) {
  const owners = members(value).filter(member => member.role === 'creator')
  if (owners.length !== 1) throw new RsqError('CONTEXT_MISSING', '项目集缺少唯一创建者，不能修改成员或设置。', 5)
  return owners[0]!.id
}
const memberState = (value: unknown) => members(value).map(member => ({ id: member.id, role: member.role })).sort((a, b) => a.id.localeCompare(b.id))
function creator(results: JsonObject, session: Session | null) {
  const owner = ownerOf(results.before)
  if (owner !== requireSession(session).identity.userId) throw new RsqError('FORBIDDEN', '只有项目集创建者可以修改此设置。', 4)
  return owner
}
function csv(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(value)) throw new RsqError('INVALID_INPUT', '成员 ID 必须为逗号分隔的正整数；先用通讯录发现成员。', 2)
  return [...new Set(value.split(','))]
}
function companyUsers(selected: string[], results: JsonObject) {
  const available = new Set(companyDirectoryUsers(results.directory).map(user => key(user.id)))
  if (selected.some(id => !available.has(id))) throw new RsqError('FORBIDDEN', '所选人员不在当前公司实际通讯录中；未发送写入或统计请求。', 4)
  return selected
}
function projectIds(value: unknown) {
  const ids = objects(value).map(project => key(project.kanbanId))
  if (new Set(ids).size !== ids.length) throw new RsqError('CONTEXT_MISSING', '项目集返回重复项目关联。', 5)
  return ids.sort()
}
function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new RsqError('INVALID_INPUT', '项目集名称不能为空白或含控制字符。', 2)
  return value
}
function membership(input: JsonObject, results: JsonObject) {
  const project = objects(results.projects).find(project => String(project.kanbanId) === input.projectId)
  if (!project) throw new RsqError('CONTEXT_MISSING', '所选项目不在该项目集中；先执行 project collection projects list。', 2)
  return project
}
export function prepareProjectCollection(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const collectionId = input.collectionId
  if (kind === 'collection-create') {
    const self = key(requireSession(session).identity.userId), selected = input.memberIds === undefined ? [] : csv(input.memberIds)
    const memberIds = companyUsers([...new Set([self, ...selected])], results), owner = self
    results.prepared = { memberIds, owner, name: name(input.name), color: input.color ?? '1' }
    return { body: { name: input.name, color: input.color ?? '1', memberIds: memberIds.join(',') } }
  }
  if (kind === 'collection-update' || kind === 'collection-members') {
    const owner = creator(results, session), patch = kind === 'collection-members' ? { memberIds: [...new Set([owner, ...csv(input.memberIds)])].join(',') } : asObject(input.patch)
    if (!isDeepStrictEqual(memberState(results.before), memberState(results.preflight)) || ['id', 'name', 'color'].some(field => String(asObject(results.before)[field]) !== String(asObject(results.preflight)[field]))) throw new RsqError('CONTEXT_CONFLICT', '项目集设置或成员在写入前已变化；请重新读取，不会覆盖或重发。', 5)
    if (patch.name !== undefined) name(patch.name)
    const memberIds = kind === 'collection-members' ? companyUsers(csv(patch.memberIds), results) : members(results.before).map(member => member.id)
    results.prepared = { ...asObject(results.before), ...patch, memberIds, owner }
    return { body: { id: collectionId, ...patch } }
  }
  if (kind === 'collection-delete') { creator(results, session); return { query: { id: collectionId } } }
  if (kind === 'collection-move') {
    if (input.collectionId === input.targetId) throw new RsqError('INVALID_INPUT', '移动目标不能是项目集本身。', 2)
    const list = objects(results.visible).filter(item => String(item.id) !== collectionId)
    if (list.some(item => typeof item.displayOrder !== 'number' || !Number.isFinite(item.displayOrder)) || new Set(list.map(item => item.displayOrder)).size !== list.length) throw new RsqError('CONTEXT_MISSING', '项目集顺序上下文不完整或存在相同顺序值。', 5)
    list.sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder))
    const target = list.findIndex(item => String(item.id) === input.targetId)
    if (target < 0) throw new RsqError('CONTEXT_MISSING', '移动目标不在当前账号可见项目集中。', 2)
    const index = target + (input.position === 'after' ? 1 : 0), front = list[index - 1], next = list[index]
    results.prepared = { order: { ...(front && { frontId: key(front.id) }), ...(next && { nextId: key(next.id) }) } }
    return { body: { id: collectionId, ...asObject(asObject(results.prepared).order) } }
  }
  if (kind === 'collection-project-add') {
    const projectId = key(input.projectId)
    const before = projectIds(results.projects)
    results.prepared = { expectedProjects: [...new Set([...before, projectId])].sort() }
    if (before.includes(projectId)) return null
    if (!objects(results.available).some(project => String(project.id) === projectId)) throw new RsqError('FORBIDDEN', '该项目不在当前账号可选择的项目列表中。', 4)
    return { body: { id: collectionId, kanbanIds: projectId } }
  }
  if (kind === 'collection-project-remove') { membership(input, results); results.prepared = { expectedProjects: projectIds(results.projects).filter(id => id !== input.projectId) }; return { query: { id: collectionId, kanbanId: input.projectId } } }
  if (kind === 'collection-project-context') { membership(input, results); return { query: { kanbanId: input.projectId } } }
  if (kind === 'collection-roadmap-plans-card' || kind === 'collection-roadmap-plans-milestone') { membership(input, results); return { query: { projectId: input.projectId, mode: kind.endsWith('-milestone') ? 'milestone' : 'card' } } }
  if (kind === 'collection-roadmap-items') {
    membership(input, results)
    const modules = objects(results.modules)
    if (modules.length > 10000 || new Set(modules.map(module => key(module.id))).size !== modules.length) throw new RsqError('CONTEXT_MISSING', '路线图的实际项目模块目录重复或超出界限。', 5)
    const available = new Set(modules.filter(module => module.type === 'task').map(module => key(module.id)))
    const planIds = objects(results.plans).map(plan => key(plan.id))
    if (planIds.length > 10000 || new Set(planIds).size !== planIds.length || planIds.some(id => !available.has(id))) throw new RsqError('CONTEXT_MISMATCH', '路线图模块必须来自所选项目的实际可见任务模块；不能把项目 ID、其他类型或其他项目模块当作 planId。', 4)
    results.prepared = { ...asObject(results.prepared), roadmapPlanIds: planIds }
    return planIds.length ? { query: { planIds: planIds.join(',') } } : null
  }
  if (kind === 'collection-stage-context') {
    results.prepared = { stageModules: objects(results.modules).filter(module => module.type === 'task').map(module => ({ id: key(module.id), name: module.name })) }
    return null
  }
  if (kind === 'collection-workload' || kind === 'collection-workload-statistics') {
    const userIds = companyUsers(input.userIds === undefined ? [key(requireSession(session).identity.userId)] : csv(input.userIds), results).join(',')
    return { query: { projectCollectionId: collectionId, userIds, ...(kind.endsWith('-statistics') && { statsType: input.statsType, dateType: input.dateType }) } }
  }
  if (kind === 'collection-workload-tasks') { companyUsers([key(input.userId)], results); return { query: { projectCollectionId: collectionId, userId: input.userId, statsType: input.statsType } } }
  if (kind.startsWith('collection-settings-')) {
    const area = kind.slice('collection-settings-'.length), before = asObject(results.before), patch = asObject(input.patch)
    const fields = area === 'schedule' ? ['mode', 'isOpenView', 'isOpenKeyPath'] : ['mode']
    const expectedSettings = Object.fromEntries(fields.map(field => [field, patch[field] ?? before[field]]))
    if (fields.some(field => before[field] === undefined)) throw new RsqError('CONTEXT_MISSING', '项目集个人设置返回不完整，未提交修改。', 5)
    if (area === 'workload') {
      const selected = patch.workloadUserIds === undefined ? objects(before.workloadUsers).map(user => key(user.id)) : patch.workloadUserIds === '' ? [ownerOf(results.collection)] : csv(patch.workloadUserIds)
      expectedSettings.workloadUserIds = companyUsers(selected, results)
    }
    results.prepared = { expectedSettings }
    return { body: { collectionId, ...patch } }
  }
  if (kind === 'collection-baseline-membership') {
    if (!objects(results.baselines).some(baseline => String(baseline.id) === input.baselineId)) throw new RsqError('CONTEXT_MISSING', '基线不属于该项目集；先执行 baseline list。', 2)
    return null
  }
  if (kind === 'collection-workflow-progress') return { query: { projectCollectionId: collectionId, pageNum: input.page ?? 1, pageSize: input.pageSize ?? 50, ...(input.sortKey !== undefined && { sortKey: input.sortKey, sortValue: input.sortOrder }) } }
  throw new RsqError('INVALID_CONTRACT', '未知的项目集上下文适配。')
}
export function verifyProjectCollection(input: JsonObject, results: JsonObject, step: string) {
  if (step === 'items') {
    const expected = asObject(results.prepared).roadmapPlanIds as string[], items = objects(results.items), actual = items.map(item => key(item.planId))
    if (new Set(actual).size !== actual.length || !isDeepStrictEqual([...actual].sort(), [...expected].sort())) throw new RsqError('BUSINESS_ASSERTION_FAILED', '路线图返回的模块与已核对任务模块目录不一致，不把缺失、重复或外部模块当作完整数据。', 5)
    for (const item of items) {
      const tasks = objects(item.taskList ?? item.cardList), ids = tasks.map(task => String(task.id))
      if (tasks.length > 10000 || new Set(ids).size !== ids.length || ids.some(id => !id || id === 'undefined' || id === 'null')) throw new RsqError('BUSINESS_ASSERTION_FAILED', '路线图模块包含无效或重复条目。', 5)
      if (item.taskList !== undefined) for (const task of tasks) {
        for (const field of ['startDate', 'endDate']) if (task[field] != null) {
          const value = String(task[field]), date = new Date(value + 'T00:00:00Z')
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RsqError('BUSINESS_ASSERTION_FAILED', '里程碑路线图包含无效日期。', 5)
        }
        if (task.startDate == null && task.endDate == null) throw new RsqError('BUSINESS_ASSERTION_FAILED', '当前路线图只返回已设日期的里程碑，不能把无日期任务当作已核对路线图。', 5)
      }
    }
    return
  }
  if (Array.isArray(results[step])) {
    const list = objects(results[step]), moved = list.find(item => String(item.id) === input.collectionId), order = asObject(asObject(results.prepared).order)
    if (Array.isArray(asObject(results.prepared).expectedProjects) && !isDeepStrictEqual(projectIds(list), asObject(results.prepared).expectedProjects)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '项目集关联集合读回不一致，或无关项目发生变化；请重新读取，不会覆盖。', 5)
    if (Object.keys(order).length) {
      const ordered = [...list].sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder)), index = ordered.findIndex(item => String(item.id) === input.collectionId)
      const frontId = index > 0 ? String(ordered[index - 1].id) : undefined, nextId = index >= 0 && index < ordered.length - 1 ? String(ordered[index + 1].id) : undefined
      if (!moved || list.some(item => typeof item.displayOrder !== 'number' || !Number.isFinite(item.displayOrder))
        || new Set(list.map(item => item.displayOrder)).size !== list.length || frontId !== order.frontId || nextId !== order.nextId) throw new RsqError('BUSINESS_ASSERTION_FAILED', '项目集排序读回未满足目标相邻位置；请重新读取，不自动覆盖并发修改。', 5)
    }
    return
  }
  const verified = asObject(results[step]), prepared = asObject(results.prepared)
  for (const [field, expected] of Object.entries(asObject(prepared.expectedSettings))) {
    const actual = field === 'workloadUserIds' ? objects(verified.workloadUsers).map(user => key(user.id)).sort() : verified[field]
    if (!isDeepStrictEqual(Array.isArray(expected) ? [...expected].sort() : expected, actual)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '项目集个人设置修改后读回不一致；省略属性也必须保留。', 5)
  }
  for (const field of ['name', 'color']) if (prepared[field] !== undefined && prepared[field] !== verified[field]) throw new RsqError('BUSINESS_ASSERTION_FAILED', '项目集修改后读取结果不一致。', 5)
  if (Array.isArray(prepared.memberIds)) {
    const actual = members(verified).map(member => member.id).sort(), expected = [...prepared.memberIds].map(String).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected) || ownerOf(verified) !== prepared.owner) throw new RsqError('BUSINESS_ASSERTION_FAILED', '项目集成员集合或创建者角色未按要求保存；请读取当前状态，不要重放写入。', 5)
  }
}
export function describeProjectCollection(results: JsonObject, kind: string) {
  if (kind === 'collection-roadmap') return { plans: results.plans, items: results.items ?? [] }
  if (kind === 'collection-stages') {
    const source = objects(asObject(results.prepared).stageModules), cards = results.stageCards
    if (!Array.isArray(cards) || cards.length !== source.length) throw new RsqError('BUSINESS_ASSERTION_FAILED', '阶段图未读取所有任务模块。', 5)
    return { modules: source.map((module, index) => ({ ...module, cards: cards[index] })) }
  }
  throw new RsqError('INVALID_CONTRACT', '未知的项目集结果适配。')
}
