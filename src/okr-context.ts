import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'

const id = (value: unknown): string => {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new RsqError('CONTEXT_MISSING', 'OKR 上下文缺少有效资源 ID。', 5)
}
const list = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', 'OKR 服务未返回预期列表。', 5)
  return value.map(asObject)
}
function cycle(input: JsonObject, results: JsonObject) {
  const data = asObject(results.cycles), cycles = ['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(key => list(data[key]))
  const selected = cycles.find(cycle => String(cycle.id) === input.cycleId)
  if (!selected || selected.isArchived === true) throw new RsqError('CONTEXT_MISSING', '周期不在当前组织的未归档周期中；请先查询 OKR 上下文。', 2)
  return selected
}
function permit(resource: JsonObject, key: string) {
  if (asObject(resource.editControl)[key] !== true) throw new RsqError('FORBIDDEN', '当前身份没有此 OKR 操作所需权限。', 4)
}
function objective(input: JsonObject, results: JsonObject) {
  const before = asObject(results.before)
  if (id(before.id) !== input.objectiveId) throw new RsqError('CONTEXT_MISSING', '目标详情与请求的资源不一致。', 5)
  return before
}
function result(input: JsonObject, results: JsonObject) {
  const parent = objective(input, results), selected = list(parent.krList).find(kr => String(kr.id) === input.resultId && kr.krType === 'normal')
  if (!selected) throw new RsqError('CONTEXT_MISSING', '未找到属于此目标的普通 KR；子目标与指标 KR 须使用各自业务操作。', 2)
  return selected
}
function availableUser(results: JsonObject, type: string, userId: string) {
  const scope = list(results.scopes).find(scope => scope.id === type)
  if (!scope || scope.canSelect !== true) throw new RsqError('FORBIDDEN', '当前身份不能创建所选类型的目标。', 4)
  if (type === 'person' && !list(scope.optionalUserList).some(user => String(user.id) === userId)) throw new RsqError('FORBIDDEN', '负责人不在当前身份可创建个人目标的成员范围中。', 4)
  return scope
}
export function prepareOkrContext(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  if (kind === 'okr-objective-create') {
    cycle(input, results)
    const identity = requireSession(session).identity, responsibleUserId = input.responsibleUserId === undefined ? id(identity.userId) : id(input.responsibleUserId)
    const scope = availableUser(results, String(input.type), responsibleUserId)
    const typeDataId = input.type === 'person' ? responsibleUserId : input.type === 'company' ? id(identity.teamId) : id(input.departmentId)
    if (input.type === 'dept' && !list(scope.optionalDeptList).some(dept => String(dept.id) === typeDataId)) throw new RsqError('FORBIDDEN', '部门不在当前身份可创建目标的部门范围中。', 4)
    if (input.type !== 'dept' && input.departmentId !== undefined) throw new RsqError('INVALID_INPUT', 'departmentId 仅适用于部门目标。', 2)
    if (input.scope === 'assign' && !input.scopeAssignUserIds || input.scope !== 'assign' && input.scopeAssignUserIds !== undefined) throw new RsqError('INVALID_INPUT', '指定可见范围时必须提供成员集合；其他范围不要传指定成员。', 2)
    results.prepared = { expected: { name: input.name, cycleId: input.cycleId, type: input.type, responsibleUserId, scope: input.scope ?? 'open' } }
    return { body: { cycleId: input.cycleId, type: input.type, typeDataId, name: input.name, responsibleUserId, scope: input.scope ?? 'open', ...(input.scopeAssignUserIds !== undefined && { scopeAssignUserIds: input.scopeAssignUserIds }) } }
  }
  if (kind === 'okr-objective-list' || kind === 'okr-planning-superiors') {
    cycle(input, results)
    if (['dept', 'person', 'group'].includes(String(input.range)) && input.rangeId === undefined) throw new RsqError('INVALID_INPUT', '所选查询范围需要明确的 rangeId。', 2)
    if (['my', 'all'].includes(String(input.range ?? 'my')) && input.rangeId !== undefined) throw new RsqError('INVALID_INPUT', 'my/all 范围不使用 rangeId。', 2)
    const query = { query: { cycleId: input.cycleId, type: input.range ?? 'my', filterType: input.filter ?? 'all', max: input.limit ?? 30,
      ...(input.rangeId !== undefined && { dataId: input.rangeId }), ...(input.after !== undefined && { frontId: input.after }), ...(input.role !== undefined && { filterPersonType: input.role }) } }
    results.query = query; return query
  }
  if (kind.startsWith('okr-objective-')) {
    const before = objective(input, results)
    permit(before, kind === 'okr-objective-progress' ? 'advance' : 'edit')
    if (kind === 'okr-objective-remove') {
      if (!list(results.selectable).some(item => String(item.id) === input.objectiveId)) throw new RsqError('CONTEXT_MISSING', '无法在原周期选择器中确认目标可见性，停止删除。', 5)
      return { query: { id: input.objectiveId } }
    }
    let patch: JsonObject
    if (kind === 'okr-objective-rename') patch = { name: input.name }
    else if (kind === 'okr-objective-description') patch = { describe: input.description, isShowDescribe: input.show ?? before.isShowDescribe }
    else if (kind === 'okr-objective-progress') {
      if (before.allowManualUpdateProgress !== true || ['fromDS', 'fromIndicator'].includes(String(before.progressType)) || before.isSyncIndicator === true) throw new RsqError('INVALID_INPUT', '当前目标不允许手动进度，或由数据表/指标同步；请先明确处理同步配置。', 2)
      const start = before.progressStart, target = before.progressTarget
      if (typeof start !== 'number' || typeof target !== 'number' || !Number.isFinite(start) || !Number.isFinite(target) || start === target) throw new RsqError('CONTEXT_MISSING', '手动百分比需要有效且不同的起始值和目标值；请先核对目标的数值配置。', 2)
      patch = { progressType: 'manual', progressCurrent: start + (target - start) * Number(input.percent) / 100, ...(input.note !== undefined && { objectiveProgressNote: input.note }) }
      results.prepared = { expected: { ...patch, progressStart: start, progressTarget: target, progressManual: input.percent } }
      return { body: { id: input.objectiveId, ...patch } }
    } else throw new RsqError('INVALID_CONTRACT', '未知目标上下文适配。')
    results.prepared = { expected: patch }
    return { body: { id: input.objectiveId, ...patch } }
  }
  if (kind === 'okr-result-add') {
    const before = objective(input, results); permit(before, 'edit')
    if (Number(input.start ?? 0) === Number(input.target ?? 100)) throw new RsqError('INVALID_INPUT', 'KR 的起始值和目标值不能相同。', 2)
    results.prepared = { expected: { name: input.name, progressStart: input.start ?? 0, progressTarget: input.target ?? 100, progressCurrent: input.start ?? 0, ...(input.unit !== undefined && { unit: input.unit }) } }
    return { body: { objectiveId: input.objectiveId, ...asObject(asObject(results.prepared).expected) } }
  }
  if (kind === 'okr-result-readback') {
    const before = list(asObject(results.before).krList), after = list(asObject(results.changed).krList)
    const added = after.filter(kr => kr.krType === 'normal' && !before.some(previous => previous.krType === 'normal' && id(previous.id) === id(kr.id)))
    if (added.length !== 1) throw new RsqError('CONTEXT_CONFLICT', '创建结果未能唯一确定新增 KR；请读取父目标核对，不要重放创建。', 5)
    results.prepared = { ...asObject(results.prepared), resultId: id(added[0].id), resources: { resultId: id(added[0].id) } }
    return { query: { id: input.objectiveId } }
  }
  if (kind.startsWith('okr-result-')) {
    const selected = result(input, results)
    let patch: JsonObject
    if (kind === 'okr-result-remove') { permit(objective(input, results), 'edit'); return { query: { id: input.resultId } } }
    if (kind === 'okr-result-rename') { permit(selected, 'name'); patch = { name: input.name } }
    else if (kind === 'okr-result-progress') {
      permit(selected, 'advance')
      if (selected.progressType !== 'def' || selected.isSyncIndicator === true) throw new RsqError('INVALID_INPUT', '该 KR 进度由外部数据同步；不能静默切换更新方式。', 2)
      patch = { progressCurrent: input.current, ...(input.note !== undefined && { krProgressNote: input.note }) }
    } else throw new RsqError('INVALID_CONTRACT', '未知 KR 上下文适配。')
    results.prepared = { resultId: input.resultId, expected: patch }
    return { body: { id: input.resultId, ...patch } }
  }
  throw new RsqError('INVALID_CONTRACT', '未知 OKR 上下文适配。')
}
export function verifyOkrContext(input: JsonObject, results: JsonObject, step: string) {
  if (step === 'deleted') {
    if (results.deleted !== null) throw new RsqError('APPROVAL_REQUIRED', '目标仍存在，删除可能需要审批；请查询目标的 approvalStatus 并处理后续流程。', 5)
    return
  }
  const expected = asObject(asObject(results.prepared).expected), resultId = asObject(results.prepared).resultId
  const parent = asObject(results[step]), actual = resultId === undefined ? parent : list(parent.krList).find(kr => String(kr.id) === resultId && kr.krType === 'normal')
  if (!actual) throw new RsqError('BUSINESS_ASSERTION_FAILED', '新读取的目标中缺少需要核对的 KR。', 5)
  for (const [key, value] of Object.entries(expected)) {
    const read = key === 'cycleId' ? id(asObject(actual.cycle).id) : key === 'type' ? asObject(actual.type).type : key === 'responsibleUserId' ? id(asObject(actual.responsibleUser).id) : actual[key]
    if (['objectiveProgressNote', 'krProgressNote'].includes(key)) continue // Notes are verified separately through history.
    if (!isDeepStrictEqual(read, value)) throw new RsqError('BUSINESS_ASSERTION_FAILED', 'OKR 读回值与提交的业务字段不一致。', 5, { field: key })
  }
}
export function describeOkrContext(results: JsonObject, planning: boolean, superior = false) {
  const items = list(results.items), query = asObject(asObject(results.query).query)
  const terminalGroup = superior && items.at(-1)?.isUnAlign === true
  return { context: planning ? 'planning' : 'objective', ...(superior && { view: 'superiors' }), items, pagination: { kind: 'cursor', limit: query.max, next: !terminalGroup && items.length === query.max && items.length ? id(items[items.length - 1].id) : null, total: null,
    ...(terminalGroup && { terminalGroup: 'unaligned-objectives-without-resource-id' }) }, sideEffects: ['asynchronously-set-own-defaultModule-to-objective'] }
}
