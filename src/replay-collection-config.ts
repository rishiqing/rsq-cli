import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { checkAccess } from './access.js'
import { requireSession, type Session } from './session.js'
import { describeContact } from './contact.js'
import type { Workflow } from './workflows.js'

export const replayCollectionConfigActions = ['context', 'settings', 'rule-add', 'rule-update', 'rule-remove'] as const
export type ReplayCollectionConfigAction = typeof replayCollectionConfigActions[number]
type Route = [string, string, string]
function fail(code: string, message: string, details?: JsonObject): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5, details) }
const id = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('CONTEXT_MISSING', '复盘集上下文缺少精确资源 ID。')
const list = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('CONTEXT_MISSING', '复盘集配置未返回完整有界列表。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const replaySettingFlags = ['isSkipHoliday', 'isOpenWriteEarliestTime', 'isOpenCommitDeadline', 'isOpenCommitNotifyTime', 'isOpenWorkStatus', 'isAllowAddViewer', 'isAllowShare', 'isAllowAfterCommitRevert', 'isAllowAfterRefuseCommit', 'isAllowSupplement'] as const
export const replaySettingTimes = ['writeEarliestTime', 'commitDeadline', 'commitNotifyTime'] as const
const lists = { writerUserIds: 'writerUserList', writerDepartmentIds: 'writerDeptList', excludedWriterUserIds: 'writerWhiterList', viewerUserIds: 'viewerUserList', viewerDepartmentIds: 'viewerDeptList' } as const
const wires = { writerUserIds: 'writerUserIdList', writerDepartmentIds: 'writerDeptIdList', excludedWriterUserIds: 'writerWhiterUserIdList', viewerUserIds: 'viewerUserIdList', viewerDepartmentIds: 'viewerDeptIdList', auditorUserIds: 'auditorIdList' } as const
type Rule = JsonObject & { id?: string; auditorType: string; auditType: string; auditorUserIds: string[] }
function unique(value: unknown, ordered = false): string[] {
  if (!Array.isArray(value) || value.length > 10000) return fail('CONTEXT_MISSING', '规则成员 ID 必须为有界数组。')
  const ids = value.map(id)
  if (new Set(ids).size !== ids.length) fail('CONTEXT_MISSING', '规则成员 ID 重复。')
  return ordered ? ids : ids.sort()
}
function rule(raw: JsonObject): Rule {
  const auditorUserIds = unique(list(raw.auditorList).map(user => user.id), true)
  const value: Rule = { id: id(raw.id), auditorType: String(raw.auditorType), auditType: String(raw.auditType ?? 'anyOne'), auditorUserIds,
    ...Object.fromEntries(Object.entries(lists).map(([name, field]) => [name, unique(list(raw[field]).map(user => user.id))])) }
  if (!['user', 'writerSuperior', 'writerLeader', 'writerChoose'].includes(value.auditorType) || !['all', 'anyOne', 'oneByOne'].includes(value.auditType)) fail('CONTEXT_MISSING', '当前规则含不支持的审核人或审核方式，未猜测。')
  return value
}
function settings(value: JsonObject): JsonObject {
  const result: JsonObject = { writeWeekDayList: value.writeWeekDays }
  for (const name of replaySettingFlags) {
    if (name === 'isSkipHoliday' && value.type !== 'day' && value[name] == null) { result[name] = null; continue }
    if (typeof value[name] !== 'boolean') fail('CONTEXT_MISSING', '复盘集缺少明确开关：' + name)
    result[name] = value[name]
  }
  for (const name of replaySettingTimes) {
    const time = asObject(value[name]); result[name] = { dateType: time.dateType, date: value.type === 'day' && time.date == null ? '1' : time.date, time: time.time }
  }
  return result
}
function snapshot(value: JsonObject): JsonObject {
  const rules = list(value.ruleList).map(rule)
  if (new Set(rules.map(row => row.id)).size !== rules.length) fail('CONTEXT_MISSING', '复盘集返回了重复规则。')
  return { id: id(value.id), name: value.name, type: value.type, templateId: id(asObject(value.template).id), settings: settings(value), rules }
}
function memberContext(tree: unknown) {
  const contact = describeContact({}, { tree })
  return { users: list(contact.members).map<JsonObject>(user => ({ ...user, id: id(user.id) })), departments: list(contact.departments).map<JsonObject>(department => ({ ...department, id: id(department.id) })) }
}
function validateRule(value: Rule, members: ReturnType<typeof memberContext>) {
  for (const [name, selected] of [...Object.keys(lists), 'auditorUserIds'].map(name => [name, value[name]] as const)) {
    const ids = unique(selected, name === 'auditorUserIds'), directory = name.endsWith('DepartmentIds') ? members.departments : members.users
    if (ids.some(selected => !directory.some(row => id(row.id) === selected))) fail('INVALID_INPUT', '规则成员或部门不在当前可见通讯录中；先查 configuration，不猜隐藏 ID。')
    if (name.endsWith('DepartmentIds') && ids.some(selected => members.departments.find(row => id(row.id) === selected)?.type === 'unassigned')) fail('INVALID_INPUT', 'UI 不允许将未分配部门作为规则部门。')
  }
  if (!['user', 'writerSuperior', 'writerLeader', 'writerChoose'].includes(value.auditorType) || !['all', 'anyOne', 'oneByOne'].includes(value.auditType)) fail('INVALID_INPUT', '未知审核人类型或审核方式。')
  if (value.auditorType === 'user' ? value.auditorUserIds.length === 0 : value.auditorUserIds.length > 0) fail('INVALID_INPUT', '指定人员必须选择审核人；动态审核人不能同时传固定人员。')
}
/** Creation and maintenance share the same UI and visible-member constraints. */
export function validateNewReplayCollection(body: JsonObject, tree: unknown, requestedSettings: JsonObject = {}) {
  if (body.type !== 'day' && ['writeWeekDayList', 'isSkipHoliday'].some(name => Object.hasOwn(requestedSettings, name))) fail('INVALID_INPUT', '填写星期和跳过节假日只适用于日复盘。')
  validateReplaySettings(String(body.type), body)
  const members = memberContext(tree)
  for (const raw of list(body.ruleList)) {
    const ids = [...(Array.isArray(raw.auditorIdList) ? raw.auditorIdList : []), ...(raw.auditorId == null ? [] : [raw.auditorId])].map(id)
    const next: Rule = { auditorType: String(raw.auditorType), auditType: String(raw.auditType ?? 'anyOne'), auditorUserIds: [...new Set(ids)],
      ...Object.fromEntries(Object.entries(wires).filter(([name]) => name !== 'auditorUserIds').map(([name, wire]) => [name, unique(raw[wire] ?? [])])) }
    validateRule(next, members)
  }
}
/** Validate the same calendar choices as the current UI, in Asia/Shanghai. */
export function validateReplaySettings(type: string, value: JsonObject, now = Date.now()) {
  const days = value.writeWeekDayList
  if (!['day', 'week', 'month'].includes(type) || (type === 'day' || days != null) && (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7) || new Set(days).size !== days.length)) fail('INVALID_INPUT', '日复盘填写周期至少选择一个且只能包含不重复的周一至周日编号。')
  if (type !== 'day' && value.isSkipHoliday === true) fail('INVALID_INPUT', '当前 UI 只有日复盘可以设置跳过休息日和节假日。')
  const current = new Date(now + 28800000), year = current.getUTCFullYear(), month = current.getUTCMonth(), date = current.getUTCDate()
  const times = new Map<string, number>()
  for (const name of replaySettingTimes) {
    const time = asObject(value[name]), day = String(time.date), clock = String(time.time)
    if (!['now', 'next'].includes(String(time.dateType)) || !/^(?:[01][0-9]|2[0-3]):(?:00|30)$/.test(clock)) fail('INVALID_INPUT', '时间须使用当前/下一周期和 UI 的半小时时刻。')
    if (type === 'day' && day !== '1' || type === 'week' && !/^[1-7]$/.test(day) || type === 'month' && !/^(?:[1-9]|1[0-9]|2[0-8]|last|last2|last3)$/.test(day)) fail('INVALID_INPUT', '日期不在当前复盘类型的 UI 选项中。')
    const next = time.dateType === 'next' ? 1 : 0
    let base: number
    if (type === 'month') { const last = new Date(Date.UTC(year, month + next + 1, 0)).getUTCDate(); const monthDay = day === 'last' ? last : day === 'last2' ? last - 1 : day === 'last3' ? last - 2 : Number(day); base = Date.UTC(year, month + next, monthDay) }
    else if (type === 'week') base = Date.UTC(year, month, date - (current.getUTCDay() + 6) % 7 + Number(day) - 1 + next * 7)
    else base = Date.UTC(year, month, date + next)
    times.set(name, base + (Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))) * 60000)
  }
  if (value.isOpenWriteEarliestTime === true && value.isOpenCommitDeadline === true && times.get('commitDeadline')! - times.get('writeEarliestTime')! < 1800000) fail('INVALID_INPUT', '截止时间须至少晚于最早填写时间 30 分钟。')
  if (value.isOpenWriteEarliestTime === true && value.isOpenCommitNotifyTime === true && times.get('commitNotifyTime')! < times.get('writeEarliestTime')!) fail('INVALID_INPUT', '提醒时间不能早于最早填写时间。')
}
export function replayCollectionConfigSteps(action: ReplayCollectionConfigAction): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['permissions', 'GET', '/task/authority/v3/authorities/company/current'], ['collections', 'GET', '/task/review/replay/config/collect/list'], ['collection', 'GET', '/task/review/replay/collect'], ['directory', 'GET', '/task/v1/department/list'], ['members', 'GET', '/task/review/replay/collect/member/list'],
    ...(action !== 'context' ? [['changed', action === 'rule-remove' ? 'DELETE' : 'PUT', action === 'settings' ? '/task/review/replay/collect' : '/task/review/replay/collect/member/rule'], ['verified', 'GET', '/task/review/replay/collect']] as Route[] : [])]
}
export function validateReplayCollectionConfigWorkflow(flow: Workflow) {
  if (!replayCollectionConfigActions.includes(flow.replayCollectionConfigAction!) || flow.outputAdapter || Object.keys(flow.output as object).length) fail('INVALID_CONTRACT', '未知复盘集配置编排。')
  const expected = replayCollectionConfigSteps(flow.replayCollectionConfigAction!)
  if (flow.steps.length !== expected.length || flow.steps.some((step, i) => { const op = catalog.operations.find(op => op.id === step.operationId), [name, method, route] = expected[i]; return !op || step.id !== name || op.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.collectPages || step.transfer || step.authentication })) fail('INVALID_CONTRACT', '复盘集配置只能使用当前固定 HTTP 上下文和独立读回。')
}
export async function runReplayCollectionConfig(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateReplayCollectionConfigWorkflow(flow)
  const action = flow.replayCollectionConfigAction!, session = requireSession(supplied), completed: string[] = [], resources: JsonObject = { collectionId: input.collectionId }
  let phase = 'identity', pending = false
  const call = async (name: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === name), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) return fail('INVALID_CONTRACT', '复盘集配置缺少固定步骤。')
    phase = name; pending = false
    const transport: Transport = async (url, init) => { if (name === 'changed') pending = true; return (options.transport ?? request)(url, init) }
    const value = await runOperation(ctx, op, args, session, { ...options, transport }); pending = false; completed.push(name); return value
  }
  try {
    const collectionId = id(input.collectionId), who = asObject(await call('identity'))
    if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '复盘集配置身份与当前 profile 不同。')
    const permission = async () => { if (asObject(await call('permissions')).replayManage !== true) fail('FORBIDDEN', '当前 UI 未授予复盘配置管理权限。') }
    await permission()
    const scoped = async () => { const entries = list(await call('collections')), matches = entries.filter(row => ['day', 'week', 'month'].includes(String(row.type)) && id(row.id) === collectionId); if (matches.length !== 1) fail('FORBIDDEN', '复盘集不在当前配置目录中。'); const value = asObject(await call('collection', { query: { id: collectionId } })); if (id(value.id) !== collectionId || value.type !== matches[0].type || !['day', 'week', 'month'].includes(String(value.type))) fail('INVALID_INPUT', '配置只适用于明确的日/周/月复盘集。'); return value }
    const before = await scoped(), initial = snapshot(before), version = hash(initial), members = memberContext(await call('directory', { query: { cliContext: 'fresh' } }))
    const writers = asObject(await call('members', { query: { replayCollectId: collectionId } })), writerIds = unique(list(writers.userList).map(row => row.id))
    if (action === 'context') return { workflow: flow.id, completedSteps: completed, resources, result: { collection: initial, contextVersion: version, members, effectiveWriterIds: writerIds,
      rulePrecedence: '按服务端返回的规则顺序，首个匹配规则优先；删除或修改规则会影响当前未提交复盘的候选审核人。', dynamicAuditors: ['writerSuperior', 'writerLeader', 'writerChoose'], auditTypes: ['all', 'anyOne', 'oneByOne'], editable: true,
      timeChoices: { dateTypes: ['now', 'next'], minuteInterval: 30, monthDates: [...Array.from({ length: 28 }, (_, i) => String(i + 1)), 'last3', 'last2', 'last'] }, concurrency: 'fresh-preflight-and-independent-readback; no-atomic-cas' } }
    if (input.expectedContextVersion != null && input.expectedContextVersion !== version) fail('CONTEXT_CONFLICT', '复盘集上下文已改变；未写入。')
    let body: JsonObject = {}, expected = structuredClone(initial), targetId: string | undefined
    const currentRules = initial.rules as Rule[], remaining = () => currentRules.filter(row => row.id !== targetId)
    if (action === 'settings') {
      const patch = asObject(input.patch), updated = { ...asObject(initial.settings), ...patch }
      if (before.type !== 'day' && ['writeWeekDayList', 'isSkipHoliday'].some(name => Object.hasOwn(patch, name))) fail('INVALID_INPUT', '周/月复盘没有日复盘的填写星期和跳过节假日选项。')
      validateReplaySettings(String(before.type), updated)
      for (const name of replaySettingFlags) if (!(name === 'isSkipHoliday' && before.type !== 'day' && updated[name] === null) && typeof updated[name] !== 'boolean') fail('INVALID_INPUT', '设置开关必须明确为 true/false。')
      body = { id: collectionId, ...patch }; expected.settings = updated
    } else if (action === 'rule-remove') { targetId = id(input.ruleId); if (!currentRules.some(row => row.id === targetId)) fail('INVALID_INPUT', '所选规则不属于此复盘集。'); expected.rules = remaining(); body = { id: targetId } }
    else {
      const patch = asObject(input.rule ?? input.patch), target = action === 'rule-update' ? currentRules.find(row => row.id === id(input.ruleId)) : undefined
      if (action === 'rule-update' && !target) fail('INVALID_INPUT', '所选规则不属于此复盘集。')
      const next = { ...(target ?? { auditorType: 'user', auditType: 'anyOne', auditorUserIds: [], ...Object.fromEntries(Object.keys(lists).map(name => [name, []])) }), ...patch } as Rule
      for (const name of [...Object.keys(lists), 'auditorUserIds']) next[name] = unique(next[name], name === 'auditorUserIds')
      validateRule(next, members)
      if (target) { targetId = target.id; expected.rules = currentRules.map(row => row.id === targetId ? next : row) }
      else expected.rules = [...currentRules, next]
      body = { replayCollectId: collectionId, ...(target && { ruleId: target.id }) }
      for (const [name, field] of Object.entries(wires)) if (!target || Object.hasOwn(patch, name)) body[field] = next[name]
      if (!target || ['auditorType', 'auditorUserIds', 'auditType'].some(name => Object.hasOwn(patch, name))) Object.assign(body, { auditorType: next.auditorType, auditorIdList: next.auditorUserIds, auditType: next.auditType })
    }
    const changed = !isDeepStrictEqual(initial, expected)
    if (targetId) resources.ruleId = targetId
    if (!changed) return { workflow: flow.id, completedSteps: completed, resources, result: { collection: initial, contextVersion: version, changed: false, verified: true } }
    await permission()
    if (!isDeepStrictEqual(snapshot(await scoped()), initial)) fail('CONTEXT_CONFLICT', '复盘集规则或设置在写前改变；未覆盖。')
    if (action === 'rule-add' || action === 'rule-update') {
      const fresh = memberContext(await call('directory', { query: { cliContext: 'fresh' } }))
      validateRule((expected.rules as Rule[]).find(row => action === 'rule-add' ? row.id == null : row.id === targetId)!, fresh)
    }
    await checkAccess(ctx, flow, input, session, options.transport)
    const reply = await call('changed', action === 'rule-remove' ? { query: body } : { body })
    if (action === 'rule-add') { targetId = id(asObject(reply).id); if (currentRules.some(row => row.id === targetId)) fail('VERIFICATION_FAILED', '新增规则返回了已有 ID。'); resources.ruleId = targetId }
    else if (targetId) resources.ruleId = targetId
    const after = snapshot(asObject(await call('verified', { query: { id: collectionId } }))), afterRules = after.rules as Rule[]
    if (action === 'rule-add') {
      const inserted = afterRules.find(row => row.id === targetId), intended = (expected.rules as Rule[]).at(-1)!
      if (!inserted || !isDeepStrictEqual({ ...inserted, id: undefined }, { ...intended, id: undefined }) || !isDeepStrictEqual(afterRules.filter(row => row.id !== targetId), currentRules)) fail('VERIFICATION_FAILED', '新增规则未持久化，或改变了原有规则与优先顺序。')
      expected.rules = afterRules
    }
    if (!isDeepStrictEqual(after, expected)) fail('VERIFICATION_FAILED', '复盘集独立读回与目标配置或应保留字段不一致。')
    const afterWriters = asObject(await call('members', { query: { replayCollectId: collectionId } }))
    return { workflow: flow.id, completedSteps: completed, resources, result: { collection: after, contextVersion: hash(after), changed: true, verified: true, effectiveWriterIds: unique(list(afterWriters.userList).map(row => row.id)), ...(targetId && { ruleId: targetId }), concurrency: 'fresh-preflight-and-readback; no-atomic-cas' } }
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('REPLAY_CONFIG_FAILED', '复盘集配置步骤失败，先核对已完成资源，不自动重放写入。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, resources, writeOutcomeUnknown: pending, automaticRetry: false, cause: original.details })
  }
}
