import { isDeepStrictEqual } from 'node:util'
import rrule from 'rrule'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { preparePersonalLabel, verifyPersonalLabel, taskLabels, validateLabelPatch } from './task-personal-labels.js'

const { RRule } = rrule
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '任务业务缺少服务端列表上下文。', 5); return value.map(asObject) }
const same = (left: unknown, right: unknown) => left != null && right != null && String(left) === String(right)
const ids = (value: unknown) => rows(value).map(item => String(item.id))
const scope = (input: JsonObject) => input.projectId == null ? { module: 'common', siteId: 'common' } : { module: 'project', siteId: String(input.projectId) }
const invalid = (message: string, details?: JsonObject): never => { throw new RsqError('INVALID_INPUT', message, 2, details) }
function current(input: JsonObject, results: JsonObject) {
  const task = asObject(results.task)
  if (!same(task.id, input.taskId)) throw new RsqError('CONTEXT_MISSING', '任务详情与目标 ID 不符。', 2)
  if (input.projectId != null && (!same(asObject(results.project).id, input.projectId) || !same(asObject(task.from).projectId, input.projectId))) throw new RsqError('CONTEXT_MISSING', '任务不属于指定项目；请核对实际归属。', 2)
  return task
}
function projectTarget(input: JsonObject, results: JsonObject) {
  const task = current(input, results), projectId = input.projectId ?? asObject(task.from).projectId
  if (projectId == null) return null
  const project = asObject(results.project)
  if (!same(project.id, projectId) || !same(asObject(task.from).projectId, projectId) || !Object.hasOwn(project, 'coverId')) throw new RsqError('CONTEXT_MISSING', '任务的实际项目或模板封面上下文不完整，未执行操作。', 5)
  return project
}
function templateTarget(input: JsonObject, results: JsonObject, mutation: boolean) {
  const project = projectTarget(input, results)
  if (project?.coverId == null) return
  const cover = asObject(mutation ? results.templateCoverFresh : results.templateCover)
  if (!same(cover.id, project.coverId) || !same(cover.templateKanbanId, project.id)) throw new RsqError('CONTEXT_MISMATCH', '模板封面与任务实际项目不一致或缺少写前重新读取。', 5)
  if (mutation && cover.withEdit !== true) throw new RsqError('FORBIDDEN', '当前 UI 不允许编辑此项目模板；任务权限不能替代模板封面编辑权。', 4)
}
export function assertTaskTargetEditable(input: JsonObject, results: JsonObject) { templateTarget(input, results, true) }
function permission(input: JsonObject, results: JsonObject, name: string) {
  const task = current(input, results), permissions = asObject(results.permissions), where = scope(input)
  if (!same(permissions.taskId, input.taskId) || permissions.module !== where.module || !same(permissions.siteId, where.siteId)) throw new RsqError('CONTEXT_MISSING', '权限返回的 taskId/module/siteId 与当前业务上下文不符。', 2)
  if (task.forbidEdit === true || asObject(permissions.editControl)[name] !== true) throw new RsqError('FORBIDDEN', '当前任务不允许此操作：' + name, 4)
}
export function taskMembersAllowed(value: unknown, results: JsonObject, previous: string[] = []) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) || new Set(value).size !== value.length) invalid('成员须为不重复的 ID 数组，清空使用 []。')
  const available = asObject(results.memberScope).taskExecutorScope
  if (!Array.isArray(available)) throw new RsqError('CONTEXT_MISSING', '可选任务成员范围缺失，未执行写入。', 4)
  const allowed = new Set([...available.map(String), ...previous])
  if ((value as string[]).some(id => !allowed.has(id))) throw new RsqError('FORBIDDEN', '目标成员不在当前 UI 允许的任务成员范围中。', 4, { allowedMemberIds: available })
  return value as string[]
}
const membersAllowed = taskMembersAllowed
export function taskDate(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return invalid('日期须为 YYYY-MM-DD 或带时区的 ISO 时间；清空使用 null。')
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const instant = new Date(value + 'T00:00:00Z')
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) return invalid('日期不存在。')
    return value
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d\d):(\d\d):(\d\d)(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value)
  if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || !Number.isFinite(Date.parse(value))) return invalid('具体时间须包含秒和明确时区。')
  taskDate(match[1]); return value
}
export function taskDatesPatch(patch: JsonObject, task: JsonObject = {}) {
  const start = Object.hasOwn(patch, 'start') ? taskDate(patch.start) : task.realStartDate ?? null
  const end = Object.hasOwn(patch, 'end') ? taskDate(patch.end) : task.realEndDate ?? null
  if (start && end && String(start).length !== String(end).length && (String(start).length === 10 || String(end).length === 10)) invalid('起止日期应同时为全天日期或同时为具体时间。')
  if (start && end && Date.parse(String(start)) > Date.parse(String(end))) invalid('结束时间早于开始时间。')
  return { ...(Object.hasOwn(patch, 'start') && { realStartDate: start }), ...(Object.hasOwn(patch, 'end') && { realEndDate: end }) }
}
const dates = taskDatesPatch
function expected(results: JsonObject, patch: JsonObject) { results.taskBusiness = { ...asObject(results.taskBusiness), expected: patch } }
export function prepareTaskBusiness(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject | null {
  const session = requireSession(supplied), action = kind.replace('task-business-', ''), where = scope(input)
  if (action.startsWith('personal-library-')) return preparePersonalLabel(action.slice('personal-library-'.length), input, results, session)
  if (action === 'detail') return { query: { id: input.taskId, ...where } }
  if (action === 'project') { const projectId = input.projectId ?? asObject(asObject(results.task).from).projectId; return projectId == null ? null : { query: { id: String(projectId) } } }
  if (action === 'template-cover') { const project = projectTarget(input, results); return project?.coverId == null ? null : { query: { id: String(project.coverId) } } }
  if (action === 'permissions') { current(input, results); templateTarget(input, results, false); return { query: { taskId: input.taskId, ...where } } }
  if (action === 'values') { current(input, results); return { query: { taskId: input.taskId, ...where } } }
  if (action === 'label-project-catalogue') { current(input, results); return input.projectId == null ? null : { query: { kanbanId: input.projectId, taskId: input.taskId } } }
  if (action === 'label-personal-catalogue') { current(input, results); return input.projectId == null ? { query: { todoId: input.taskId } } : null }
  if (action === 'children') { current(input, results); return { query: { taskId: input.taskId, ...(input.moduleId != null && { planId: input.moduleId }) } } }
  if (action === 'comment-list' || action === 'comment-data') { current(input, results); return { query: { taskId: input.taskId } } }
  if (action === 'recycle') return { query: { type: '1,5', max: 200 } }
  if (action === 'create-personal') {
    const memberIds = membersAllowed(input.memberIds ?? [session.identity.userId], results)
    const body = { name: input.name, memberIds: memberIds.join(','), ...dates(asObject(input.dates)), ...(input.note != null && { note: input.note }) }
    expected(results, { name: input.name, members: memberIds, ...dates(asObject(input.dates)) })
    return { body }
  }
  const task = current(input, results)
  assertTaskTargetEditable(input, results)
  if (action === 'update') {
    const patch = { ...asObject(input.patch) }, permissions: Record<string, string> = { name: 'editTaskName', note: 'editTaskNote', progress: 'editTaskProgress', priorityV2: 'editTaskPriority', isDone: 'finishTask', isClose: 'finishTask' }
    for (const key of Object.keys(patch)) if (permissions[key]) permission(input, results, permissions[key])
    if (patch.isDone === true || patch.isClose === true) {
      const missing = rows(asObject(results.values).templateFields).filter(field => field.isRequired === true && field.isHidden !== true && (field.value == null || field.value === '') && !['list','hours','files','tableRows','recordList'].some(key => Array.isArray(field[key]) && field[key].length))
      if (missing.length) invalid('任务仍有必填字段未填写，请先发现并填写当前任务字段。', { fields: missing.map(field => ({ id: field.id, name: field.name, type: field.type })) })
    }
    expected(results, patch); return { body: { id: input.taskId, ...where, ...patch } }
  }
  if (action === 'dates') {
    permission(input, results, 'editTaskDate')
    if (task.rrule) invalid('重复任务的单次日期和整条规则需要明确处理，请先用 task repeat inspect/set/clear 核对重复设置。')
    const patch = dates(asObject(input.dates), task)
    if (asObject(task.taskTemplate).isMilepost === true && patch.realStartDate !== patch.realEndDate) invalid('里程碑只支持单日，请使用 milestone update。')
    expected(results, patch); return { body: { id: input.taskId, ...where, ...patch } }
  }
  if (action === 'members') {
    const body: JsonObject = { id: input.taskId, ...where }, check: JsonObject = {}
    for (const [key, responseKey, dtoKey] of [['executors','members','memberIds'],['participants','participants','participantsIds']]) if (Object.hasOwn(input, key)) {
      const before = ids(task[responseKey] ?? []), after = membersAllowed(input[key], results, before)
      if (after.some(id => !before.includes(id))) permission(input, results, 'addTaskMember')
      if (before.some(id => !after.includes(id))) permission(input, results, 'removeTaskMember')
      body[dtoKey] = after.join(','); check[responseKey] = after
    }
    if (Object.hasOwn(input, 'principalId')) {
      permission(input, results, 'addTaskMember')
      const executors = (check.members ?? ids(task.members ?? [])) as string[]
      if (input.principalId !== null && !executors.includes(String(input.principalId))) invalid('负责人必须为最终执行人之一。')
      body.responsibilityId = input.principalId; check.responsibilityId = input.principalId
    }
    if (!Object.keys(check).length) invalid('请至少提供 executors、participants 或 principalId。')
    expected(results, check); return { body }
  }
  if (action === 'child-create') {
    permission(input, results, 'editSubTask')
    const memberIds = membersAllowed(input.memberIds ?? [session.identity.userId], results)
    expected(results, { name: input.name, members: memberIds, taskId: input.taskId })
    return { body: { name: input.name, taskId: input.taskId, memberIds: memberIds.join(','), ...(input.note != null && { note: input.note }) } }
  }
  if (action === 'remove') { permission(input, results, 'removeTask'); return { query: { id: input.taskId, ...where } } }
  if (action.startsWith('comment-')) {
    if (action === 'comment-remove') {
      const item = rows(results.comments).find(item => same(item.id, input.commentId))
      if (!item || !same(asObject(item.creator).id, session.identity.userId)) throw new RsqError('FORBIDDEN', '只能删除当前任务中自己创建的评论，与 UI 一致。', 4)
      return { query: { id: String(item.id) } }
    }
    permission(input, results, 'commentTask')
    if (action === 'comment-notification') return { body: { taskId: input.taskId, notifyFlag: input.onlyMentioned } }
    const atMembers = rows(asObject(results.commentContext).atMembers), mentionIds = new Set((input.mentionIds ?? []) as string[])
    if (input.replyTo != null) {
      const reply = rows(results.comments).find(item => same(item.id, input.replyTo))
      if (!reply) invalid('回复目标不在当前任务评论中。')
      mentionIds.add(String(asObject(reply!.creator).id))
    }
    const escape = (text: unknown) => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
    const mentions = [...mentionIds].map(id => {
      const user = atMembers.find(user => same(user.id, id))
      if (!user) invalid('提及成员不在当前任务可提及列表中。')
      return '<input class="toolbox-atSpan" readonly="readonly" value="@' + escape(user!.showName) + '" type="button" data-user-id="' + id + '" data-at-category="people" data-people-id="' + id + '">'
    }).join('&nbsp;')
    const content = '<p>' + mentions + (mentions ? '&nbsp;' : '') + escape(input.text).replace(/\r?\n/g, '<br>') + '</p>'
    expected(results, { content })
    return { body: { taskId: input.taskId, content, atIds: [...mentionIds].join(','), atDeptIds: '', atType: '' } }
  }
  if (action === 'labels') {
    permission(input, results, 'selectTaskLabel')
    const selected = rows(input.labels), catalog = rows(results.labels)
    for (const label of selected) if (!catalog.some(item => same(item.id, label.id) && item.type === label.type)) invalid('标签不在当前任务可选库或已选列表中。')
    const patch = { kanbanLabelIds: selected.filter(item => item.type === 'project').map(item => item.id).join(','), todoLabelIds: selected.filter(item => item.type === 'todo').map(item => item.id).join(',') }
    expected(results, { labels: selected }); return { body: { id: input.taskId, ...where, ...patch } }
  }
  if (action.startsWith('label-')) {
    permission(input, results, 'editTaskLabel')
    validateLabelPatch(action === 'label-create' ? { name: input.name, color: input.color } : asObject(input.patch))
    if (input.projectId == null) invalid('项目标签维护需要明确 projectId。')
    if (action === 'label-create') return { body: { kanbanId: input.projectId, name: input.name, color: input.color } }
    const selected = rows(results.labels).find(item => same(item.id, input.labelId) && item.type === 'project')
    if (!selected) invalid('标签必须属于指定项目标签库。')
    return action === 'label-remove' ? { query: { id: input.labelId } } : { body: { id: input.labelId, ...asObject(input.patch) } }
  }
  if (action === 'reminders') {
    permission(input, results, 'editTaskRemind')
    if (!Object.hasOwn(input, 'personal') && !Object.hasOwn(input, 'member')) invalid('请提供 personal 或 member；[] 明确清空对应类别。')
    const personal = input.personal == null ? rows(asObject(task.alert).personal ?? []) : rows(input.personal).map(item => ({ schedule: (item.anchor === 'start' ? 'begin' : 'end') + '_' + item.offset + '_' + (item.unit === 'minute' ? 'min' : item.unit) }))
    const member = rows(input.member ?? [])
    if (personal.length && !task.realStartDate && !task.realEndDate) invalid('没有任务日期不能设置相对个人提醒；服务端会直接清空。')
    const available = new Set([...ids(task.members ?? []), ...ids(task.participants ?? []), String(task.creatorId), ...rows(asObject(results.values).templateFields).flatMap(field => rows(field.confirmers ?? []).map(item => String(asObject(item.confirmer).id)))])
    for (const item of member) {
      taskDate(item.date)
      if (!Array.isArray(item.memberIds) || item.memberIds.some(id => !available.has(String(id)))) invalid('多人提醒只允许任务创建人、执行人、参与人或确认人。')
      if (item.id != null && !rows(asObject(task.alert).member ?? []).some(current => same(current.id, item.id) && current.edit === true)) throw new RsqError('FORBIDDEN', '提醒 ID 不属于当前任务或不可编辑。', 4)
    }
    const fixed = rows(asObject(task.alert).member ?? []).filter(item => input.member == null || item.edit !== true).map(item => ({ id: item.id, date: String(item.date).replaceAll('-', '.'), time: item.time, memberIds: item.memberIds }))
    // The task API uses ISO dates for task scheduling but yyyy.MM.dd in
    // TaskAlertEntityConverter.toAlertTime, matching the member-reminder UI.
    const alert = { personal: personal.map(item => ({ schedule: item.schedule })), member: [...fixed, ...member.map(item => ({ ...item, date: String(item.date).replaceAll('-', '.'), memberIds: (item.memberIds as string[]).join(',') }))] }
    expected(results, { alert }); return { body: { id: input.taskId, ...where, alert } }
  }
  if (action === 'repeat-set' || action === 'repeat-clear') {
    permission(input, results, 'editTaskRepeat')
    if (task.taskId || asObject(task.from).type === 'workflow') invalid('当前 UI 不允许子任务和流程任务设置重复。')
    if (action === 'repeat-clear') { expected(results, { rrule: null }); return { body: { id: input.taskId, ...where, rrule: null, rruleContent: [] } } }
    if (!task.realStartDate && !task.realEndDate) invalid('设置重复前必须先安排任务日期。')
    const rule = asObject(input.rule), startDate = taskDate(rule.startDate)
    if (String(startDate).length !== 10) invalid('重复起始日期须为全天日期。')
    if (rule.until && rule.count) invalid('重复次数和截止日期不能同时指定。')
    const options: Record<string, unknown> = { dtstart: new Date(startDate + 'T00:00:00Z'), freq: ({ daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY, yearly: RRule.YEARLY } as Record<string, number>)[String(rule.frequency)], interval: rule.interval ?? 1 }
    if (rule.until) { taskDate(rule.until); options.until = new Date(rule.until + 'T23:59:59Z'); if (String(rule.until) < String(startDate)) invalid('重复截止早于起始日期。') }
    if (rule.count) options.count = rule.count
    if (rule.weekdays) options.byweekday = (rule.weekdays as string[]).map(day => ({ MO: RRule.MO, TU: RRule.TU, WE: RRule.WE, TH: RRule.TH, FR: RRule.FR, SA: RRule.SA, SU: RRule.SU })[day])
    for (const [key, dto] of [['monthDays','bymonthday'],['months','bymonth'],['positions','bysetpos']]) if (rule[key]) options[dto] = rule[key]
    let serialized = new RRule(options).toString()
    if (rule.excludeHolidays === true) serialized += '\nX-RSQ-EXRULE:BYTYPE=HOLIDAY'
    const patch = { rrule: serialized, rruleType: 'custom', rruleContent: input.copy ?? [] }
    expected(results, patch); return { body: { id: input.taskId, ...where, ...patch } }
  }
  throw new RsqError('INVALID_CONTRACT', '未知任务业务适配。', 6)
}
const assert = (condition: boolean, field: string) => { if (!condition) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务独立读回与预期不符：' + field, 5) }
export function verifyTaskBusiness(input: JsonObject, results: JsonObject, step: string) {
  if (results.personalLibraryScope) return verifyPersonalLabel(results, step)
  if (step === 'personalLabels') { taskLabels(results.personalLabels); results.labels = results.personalLabels; return }
  if (step === 'removedEntries') { assert(rows(results[step]).some(item => same(item.resourceId, input.taskId) && [1,5].includes(Number(item.type))), 'recycle.resourceId'); return }
  if (step === 'verifiedComments') {
    const list = rows(results[step])
    if (input.commentId) assert(!list.some(item => same(item.id, input.commentId)), 'comment.removed')
    else assert(list.some(item => same(item.id, asObject(results.created).id) && item.content === asObject(asObject(results.taskBusiness).expected).content), 'comment.content')
    return
  }
  if (step === 'verifiedNotification') { assert(asObject(results[step]).notifyFlag === input.onlyMentioned, 'notifyFlag'); return }
  if (step === 'verifiedLabels') {
    const list = rows(results[step])
    if (input.labelId && input.patch) { const actual = list.find(item => same(item.id, input.labelId)); for (const [key, value] of Object.entries(asObject(input.patch))) assert(actual?.[key] === value, 'label.' + key) }
    else if (input.labelId) assert(!list.some(item => same(item.id, input.labelId)), 'label.removed')
    else assert(list.some(item => same(item.id, asObject(results.created).id) && item.name === input.name && item.color === input.color), 'label.created')
    return
  }
  const actual = asObject(results[step]), expectation = asObject(asObject(results.taskBusiness).expected)
  for (const [key, value] of Object.entries(expectation)) {
    if (key === 'members' || key === 'participants') assert(isDeepStrictEqual(ids(actual[key] ?? []).sort(), [...value as string[]].sort()), key)
    else if (key === 'labels') {
      const typed = (labels: unknown) => rows(labels).map(item => String(item.type) + ':' + String(item.id)).sort()
      assert(isDeepStrictEqual(typed(actual.labelList ?? []), typed(value)), key)
    }
    else if (key === 'alert') {
      const want = asObject(value), got = asObject(actual.alert)
      assert(isDeepStrictEqual(rows(want.personal).map(item => item.schedule).sort(), rows(got.personal ?? []).map(item => item.schedule).sort()), 'alert.personal')
      const normalize = (values: unknown) => rows(values).map(item => JSON.stringify({ date: String(item.date).replaceAll('.', '-'), time: item.time, memberIds: String(item.memberIds).split(',').sort() })).sort()
      assert(isDeepStrictEqual(normalize(want.member), normalize(got.member ?? [])), 'alert.member')
    } else if (key === 'realStartDate' || key === 'realEndDate') assert(value == null ? actual[key] == null : String(value).length === 10 ? actual[key] === value : Date.parse(String(actual[key])) === Date.parse(String(value)), key)
    else if (key === 'responsibilityId' || key === 'taskId') assert(value == null ? actual[key] == null : same(actual[key], value), key)
    else assert(isDeepStrictEqual(actual[key] ?? null, value ?? null), key)
  }
}
