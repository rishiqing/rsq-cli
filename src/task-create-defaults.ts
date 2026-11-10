import { asObject, RsqError, type JsonObject } from './core.js'
import { taskDatesPatch, taskMembersAllowed, verifyTaskBusiness } from './task-business.js'
import type { Session } from './session.js'

const fail = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const list = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '任务创建列表上下文缺失。', 5)
  return value.map(asObject)
}
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const csv = (value: unknown): string[] => {
  if (value == null || value === '') return []
  if (typeof value !== 'string' || !/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(value)) return fail('任务类型默认成员或标签不是有效 ID 列表。')
  return [...new Set(value.split(','))]
}
const unique = (values: string[]) => [...new Set(values)]

/** Definition writes use flat IDs; definition reads return decorated labels/people. */
export function normalizeTaskDefaultDefinition(value: unknown): JsonObject {
  const defaults = structuredClone(asObject(value))
  const canonicalIds = (value: unknown) => csv(value).sort().join(',')
  if (defaults.member != null) {
    const member = asObject(defaults.member)
    defaults.member = { ...member, ...(Object.hasOwn(member, 'memberIds') && { memberIds: canonicalIds(member.memberIds) }), ...(Object.hasOwn(member, 'responsibilityId') && { responsibilityId: member.responsibilityId == null || member.responsibilityId === '' ? '' : String(member.responsibilityId) }) }
  }
  if (Object.hasOwn(defaults, 'participantsIds')) defaults.participantsIds = canonicalIds(defaults.participantsIds)
  if (defaults.label != null) {
    const label = asObject(defaults.label)
    defaults.label = { kanbanLabelIds: Object.hasOwn(label, 'kanbanLabelIds') ? canonicalIds(label.kanbanLabelIds) : list(label.kanbanLabels ?? []).map(label => String(label.id)).sort().join(',') }
  }
  if (defaults.subtasks != null) defaults.subtasks = list(defaults.subtasks).map(child => {
    const member = asObject(child.member), ids = Object.hasOwn(child, 'memberIds') ? csv(child.memberIds) : member.memberIds != null ? csv(member.memberIds) : list(member.members ?? []).map(person => String(person.id))
    const principal = Object.hasOwn(child, 'responsibilityId') ? child.responsibilityId : member.responsibilityId
    return { ...child, memberIds: ids.sort().join(','), ...(principal !== undefined && { responsibilityId: principal == null || principal === '' ? '' : String(principal) }) }
  })
  return defaults
}

/** Apply UI defaults explicitly: the create endpoint does not expand them. */
export function projectTaskValues(input: JsonObject, definition: JsonObject, results: JsonObject, session: Session) {
  const defaults = input.defaults === 'ignore' ? {} : asObject(definition.defaultValues), permissions = asObject(results.cardPermissions)
  const require = (permission: string) => { if (permissions[permission] !== true) throw new RsqError('FORBIDDEN', '当前任务模块不允许此新建配置：' + permission, 4) }
  const defaultMember = asObject(defaults.member), suppliedMembers = Object.hasOwn(input, 'memberIds')
  const memberIds = taskMembersAllowed(suppliedMembers ? input.memberIds : unique([session.identity.userId, ...csv(defaultMember.memberIds)]), results)
  const defaultParticipants = csv(defaults.participantsIds), suppliedParticipants = Object.hasOwn(input, 'participantIds')
  const participantIds = suppliedParticipants ? taskMembersAllowed(input.participantIds, results) : defaultParticipants.length ? taskMembersAllowed(defaultParticipants, results) : undefined
  if (suppliedMembers || suppliedParticipants || Object.hasOwn(input, 'principalId') || memberIds.some(id => id !== session.identity.userId) || participantIds?.length) require('addTaskMember')
  if (input.principalId != null && !memberIds.includes(String(input.principalId))) fail('负责人必须属于本次任务的执行人。')
  // The UI keeps the caller's principal; a type's member default does not
  // silently promote its responsibilityId to the new root task principal.
  const body: JsonObject = { memberIds: memberIds.join(','), ...(participantIds && { participantsIds: participantIds.join(',') }), ...(Object.hasOwn(input, 'principalId') && { responsibilityId: input.principalId }) }
  const expected: JsonObject = { members: memberIds, ...(participantIds && { participants: participantIds }), ...(Object.hasOwn(input, 'principalId') && { responsibilityId: input.principalId }) }
  for (const key of ['note', 'priorityV2']) {
    const value = Object.hasOwn(input, key) ? input[key] : defaults[key]
    if (value == null) continue
    if (key === 'note' && (typeof value !== 'string' || value.length > 1000000)) fail('任务类型默认备注格式不正确。')
    if (key === 'priorityV2') {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 4) fail('任务优先级须为 1 到 4。')
      require('editTaskPriority')
    }
    body[key] = value; expected[key] = value
  }
  const defaultDate = defaults.date
  if (defaultDate != null && (typeof defaultDate !== 'object' || Array.isArray(defaultDate))) throw new RsqError('CONTEXT_MISSING', '任务类型默认日期不是当前 HTTP 返回的日期对象。', 5)
  const date = asObject(defaultDate), dates = Object.hasOwn(input, 'dates') ? asObject(input.dates) : { ...(date.realStartDate != null && { start: date.realStartDate }), ...(date.realEndDate != null && { end: date.realEndDate }) }
  if (Object.keys(dates).length) { require('editTaskDate'); Object.assign(body, taskDatesPatch(dates)); Object.assign(expected, taskDatesPatch(dates)) }
  const defaultLabel = asObject(defaults.label)
  const nativeLabels = defaultLabel.kanbanLabels == null ? csv(defaultLabel.kanbanLabelIds).map(id => ({ id, type: 'project' })) : list(defaultLabel.kanbanLabels).map(label => ({ id: String(label.id), type: 'project' }))
  const selectedLabels = Object.hasOwn(input, 'labels') ? list(input.labels) : nativeLabels
  if (Object.hasOwn(input, 'labels') || selectedLabels.length) {
    require('selectTaskLabel')
    const catalogue = list(results.creationLabels), identities = selectedLabels.map(label => String(label.type) + ':' + String(label.id))
    if (new Set(identities).size !== identities.length || selectedLabels.some(label => !['project', 'todo'].includes(String(label.type)) || !catalogue.some(item => same(item.id, label.id) && item.type === label.type))) fail('标签不属于当前项目可见标签库；先发现真实标签，不使用模板中的失效编号。')
    body.kanbanLabelIds = selectedLabels.filter(label => label.type === 'project').map(label => label.id).join(',')
    body.todoLabelIds = selectedLabels.filter(label => label.type === 'todo').map(label => label.id).join(',')
    expected.labels = selectedLabels
  }
  const childrenInput = Object.hasOwn(input, 'subtasks') ? input.subtasks : defaults.subtasks ?? []
  const children = list(childrenInput)
  if (children.length > 100) fail('一次创建最多包含 100 个直接子任务。')
  const subTasks = children.map(child => {
    if (typeof child.name !== 'string' || !child.name.trim() || child.name.length > 10000) return fail('默认或显式子任务必须有有效名称。')
    if (Array.isArray(child.subtasks) && child.subtasks.length) return fail('此创建命令只接受直接子任务；更深层使用 task subtask create。')
    const member = asObject(child.member)
    const selected = Object.hasOwn(child, 'memberIds') ? typeof child.memberIds === 'string' ? csv(child.memberIds) : child.memberIds : member.memberIds != null ? csv(member.memberIds) : member.members == null ? [] : list(member.members).map(person => String(person.id))
    const members = taskMembersAllowed(selected, results)
    const principal = Object.hasOwn(child, 'principalId') ? child.principalId : child.responsibilityId ?? member.responsibilityId
    if (members.length || principal != null && principal !== '') require('addTaskMember')
    if (principal != null && principal !== '' && !members.includes(String(principal))) return fail('子任务负责人必须属于该子任务执行人。')
    const childDate = asObject(child.date), dateInput = Object.hasOwn(child, 'dates') ? asObject(child.dates) : { ...(childDate.realStartDate != null && { start: childDate.realStartDate }), ...(childDate.realEndDate != null && { end: childDate.realEndDate }) }
    if (Object.keys(dateInput).length) require('editTaskDate')
    return { name: child.name, memberIds: members.join(','), ...(principal != null && principal !== '' && { responsibilityId: String(principal) }), ...taskDatesPatch(dateInput) }
  })
  if (children.length || Object.hasOwn(input, 'subtasks')) body.subTasks = subTasks
  return { body, expected, children: subTasks }
}

export function verifyProjectTaskChildren(input: JsonObject, results: JsonObject, step: string) {
  const expected = list(asObject(results.taskContext).expectedChildren), parentId = asObject(results.created).id, listed = list(results.createdTaskChildren)
  if (listed.length !== expected.length || listed.some(child => child.id == null) || new Set(listed.map(child => String(child.id))).size !== listed.length) throw new RsqError('BUSINESS_ASSERTION_FAILED', '新任务的直接子任务数量或独立身份不符合创建配置。', 5)
  if (step !== 'verifiedTaskChildren') return
  const actual = list(results.verifiedTaskChildren), remaining = [...expected]
  if (actual.length !== listed.length) throw new RsqError('BUSINESS_ASSERTION_FAILED', '子任务详情读回不完整。', 5)
  for (const child of actual) {
    const index = remaining.findIndex(want => {
      if (want.name !== child.name) return false
      try {
        verifyTaskBusiness(input, { taskBusiness: { expected: { name: want.name, members: csv(want.memberIds), ...(Object.hasOwn(want, 'responsibilityId') && { responsibilityId: want.responsibilityId }), ...Object.fromEntries(['realStartDate', 'realEndDate'].filter(key => Object.hasOwn(want, key)).map(key => [key, want[key]])) } }, child }, 'child')
        return true
      } catch { return false }
    })
    if (index < 0 || !listed.some(item => same(item.id, child.id)) || !same(child.taskId, parentId) || !same(asObject(child.from).projectId, input.projectId) || !same(asObject(child.from).planId, input.moduleId)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '子任务名称、执行人、日期、父级或项目模块归属未通过独立核对。', 5)
    remaining.splice(index, 1)
  }
}
