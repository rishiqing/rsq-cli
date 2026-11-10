import { createHash } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '执行台上下文缺少列表。', 5); return value.map(asObject) }
function fail(code: string, message: string): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : code === 'BUSINESS_ASSERTION_FAILED' ? 5 : 2) }
const select = (list: JsonObject[], id: unknown, key = 'id') => { const found = list.filter(item => same(item[key], id)); if (found.length !== 1) fail('CONTEXT_MISSING', '目标不在当前范围或标识不唯一，请重新发现执行台上下文。'); return found[0] }
function date(value: unknown) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('INVALID_INPUT', '日期需要有效的 YYYY-MM-DD。'); return String(value) }
function scope(input: JsonObject, results: JsonObject, session: Session) {
  const type = input.type ?? 'user', typeId = input.typeId ?? (type === 'user' ? session.identity.userId : undefined)
  if (!typeId) fail('INVALID_INPUT', '部门或小组范围必须提供 typeId。')
  let visible = type === 'user' && same(typeId, session.identity.userId)
  const visit = (nodes: JsonObject[]) => { for (const node of nodes) { if (type === 'dept' && same(node.id, typeId) || type === 'user' && rows(node.userList ?? []).some(user => same(user.id, typeId))) visible = true; visit(rows(node.childList ?? [])) } }
  visit(rows(results.departments))
  if (type === 'group') visible = rows(results.staffGroups).some(group => same(group.id, typeId))
  if (!visible) fail('FORBIDDEN', '目标不在当前组织可见通讯录或小组中，未查询其他范围的执行数据。')
  return { type, typeId: String(typeId) }
}
function view(input: JsonObject, results: JsonObject, session: Session) {
  const target = scope(input, results, session), views = rows(results.views), matching = input.viewId === undefined ? views.filter(item => item.isSelected === true) : views.filter(item => same(item.id, input.viewId))
  if (matching.length !== 1) fail('AMBIGUOUS_CONTEXT', '请从 workspace inspect 中选择唯一视图并提供 viewId。')
  const current = matching[0]
  if (current.disabled === true) fail('FORBIDDEN', String(current.disabledReason ?? '执行视图不可用。'))
  return { current, target }
}
function constraints(group: unknown, range: unknown, mode: unknown, type: unknown, start: unknown, end: unknown) {
  if (group === 'custom' && mode === 'taskAndWorkflowTodo') fail('FORBIDDEN', '任务和流程待办混合模式不支持自定义分组。')
  if (group === 'date' && (range === 'day' || start === end)) fail('INVALID_INPUT', '单日范围不能按日期分组。')
  if (group === 'user' && type === 'user') fail('INVALID_INPUT', '个人范围不能按执行人分组。')
}
function filterList(value: unknown) { const list = asObject(value).filter; return list == null ? [] : rows(list) }
export function resolveExecutionFilters(value: unknown, available: JsonObject[]) {
  const changes = rows(value), used = new Set<string>()
  for (const change of changes) {
    if (used.has(String(change.key))) fail('INVALID_INPUT', '筛选条件不能重复。')
    used.add(String(change.key)); select(available, change.key, 'key')
  }
  return available.map(definition => {
    const change = changes.find(change => same(change.key, definition.key)) ?? { key: definition.key }
    const result: JsonObject = { name: definition.name, type: definition.type, key: definition.key, contentValue: change.contentValue ?? '' }
    for (const [key, selector] of [['operator', 'operators'], ['selector', 'values']]) {
      const options = rows(definition[key] ?? []), wanted = change[selector] as string[] | undefined ?? []
      const selected = wanted.map(value => { const matches = options.filter(option => same(option.value, value) || option.name === value); if (matches.length !== 1) fail('INVALID_INPUT', '筛选选项或操作符不存在或不唯一。'); return String(matches[0].value) })
      if (new Set(selected).size !== selected.length) fail('INVALID_INPUT', '筛选选项不能重复。')
      if (options.length) result[key] = options.map(option => ({ name: option.name, value: option.value, selected: selected.includes(String(option.value)) }))
    }
    if (change.contentValue && definition.type === 'content' && !rows(result.operator ?? []).some(operator => operator.selected === true)) fail('INVALID_INPUT', '文本筛选需要从实际定义中选择适用操作符。')
    return result
  })
}
function query(input: JsonObject, results: JsonObject, session: Session) {
  const { current, target } = view(input, results, session), startDate = date(input.startDate), endDate = date(input.endDate)
  if (startDate > endDate) fail('INVALID_INPUT', '开始日期不能晚于结束日期。')
  constraints(current.group, current.dateRangeType, asObject(results.mode).mode, target.type, startDate, endDate)
  const params = { ...target, viewId: String(current.id), viewType: current.viewType, startDate, endDate, group: current.group, sort: current.sort, filter: input.filters === undefined ? filterList(results.selectedFilters) : resolveExecutionFilters(input.filters, filterList(results.filters)) }
  if (!params.viewType || !params.group || !params.sort) fail('CONTEXT_MISSING', '执行视图缺少类型、分组或排序配置。')
  return { current, params }
}
function normalizedFilters(list: JsonObject[]) { return list.map(item => ({ key: item.key, contentValue: item.contentValue ?? '', operator: rows(item.operator ?? []).filter(value => value.selected === true).map(value => String(value.value)).sort(), selector: rows(item.selector ?? []).filter(value => value.selected === true).map(value => String(value.value)).sort() })).filter(item => item.contentValue !== '' || item.operator.length || item.selector.length).sort((a, b) => String(a.key).localeCompare(String(b.key))) }
export function executionVersion(results: JsonObject, current: JsonObject) { return createHash('sha256').update(JSON.stringify({ view: current, selected: normalizedFilters(filterList(results.selectedFilters)) })).digest('hex') }
function editableGroups(input: JsonObject, results: JsonObject, session: Session, permission = 'editGroup') {
  const { params } = query(input, results, session), groups = asObject(results.groups)
  if (groups.effectiveMode !== 'taskOnly' || params.group !== 'custom' || asObject(groups.editControl)[permission] !== true) fail('FORBIDDEN', '当前模式、范围或分组权限不允许此操作。')
  return rows(groups.groupList)
}
function anchor(list: JsonObject[], moveId: unknown, frontId: unknown, nextId: unknown, key = 'id') {
  if (frontId != null && same(frontId, nextId) || same(moveId, frontId) || same(moveId, nextId)) fail('INVALID_INPUT', '移动目标和前后锚点不能重复。')
  if (frontId != null) select(list, frontId, key)
  if (nextId != null) select(list, nextId, key)
  const remaining = list.filter(item => !same(item[key], moveId))
  if (frontId != null && nextId != null && remaining.findIndex(item => same(item[key], nextId)) !== remaining.findIndex(item => same(item[key], frontId)) + 1) fail('INVALID_INPUT', '前后锚点必须在当前列表中相邻。')
}
function ordered(list: JsonObject[], wanted: JsonObject, key = 'id') {
  const index = list.findIndex(item => same(item[key], wanted.moveId)), before = list.findIndex(item => same(item[key], wanted.frontId)), after = list.findIndex(item => same(item[key], wanted.nextId))
  if (index < 0 || wanted.frontId != null && (before < 0 || before >= index) || wanted.nextId != null && (after < 0 || index >= after)) fail('BUSINESS_ASSERTION_FAILED', '执行台排序读回与目标顺序不符。')
}
export function prepareExecution(kind: string, input: JsonObject, results: JsonObject, provided: Session | null): JsonObject {
  const session = requireSession(provided)
  const action = kind.replace('execution-', '')
  if (action === 'scope') return { query: scope(input, results, session) }
  if (action === 'mode-set') {
    if (!same(input.teamId, session.identity.teamId)) fail('FORBIDDEN', 'teamId 与当前登录公司不一致。')
    if (asObject(results.mode).canUpdate !== true) fail('FORBIDDEN', '当前身份不能修改公司执行显示模式。')
    results.executionExpected = { mode: input.mode }; return { body: { mode: input.mode } }
  }
  const { current, params } = query(action === 'filters' ? { ...input, filters: undefined } : input, results, session)
  if (action === 'filters') return { query: Object.fromEntries(['type', 'typeId', 'viewId', 'startDate', 'endDate'].map(key => [key, asObject(params)[key]])) }
  if (action === 'selected-fields') return { query: { viewId: current.id } }
  if (action === 'groups' || action === 'counts') return { body: params }
  if (action === 'items' || action === 'source-items' || action === 'target-items' || action === 'verify-items') {
    const groups = rows(asObject(results.groups).groupList)
    let groupId = action === 'target-items' || action === 'verify-items' ? input.destinationGroupId : action === 'source-items' ? input.sourceGroupId : input.groupId
    if (groupId == null) {
      if (groups.length !== 1) throw new RsqError('AMBIGUOUS_CONTEXT', '请从 execution groups list 中明确选择 groupId；界面按组分别读取事项。', 2, { groups: groups.map(group => ({ id: group.id, name: group.name })) })
      groupId = groups[0].id
    }
    select(groups, groupId)
    return { body: { ...params, ...(groupId != null && { groupId }), max: input.max ?? 100, ...(action === 'items' && input.lastId != null && { lastId: input.lastId }), ...(action === 'source-items' && input.sourceCursor != null && { lastId: input.sourceCursor }), ...(action === 'target-items' && input.targetCursor != null && { lastId: input.targetCursor }) } }
  }
  if (action === 'view-update') {
    if (input.expectedVersion !== undefined && input.expectedVersion !== executionVersion(results, current)) fail('CONTEXT_CONFLICT', '视图或筛选条件已变化，请重新读取并核对。')
    const patch = structuredClone(asObject(input.patch)), group = patch.group ?? current.group, sort = patch.sort ?? current.sort
    if (patch.viewType !== undefined && patch.viewType !== current.viewType) fail('INVALID_INPUT', '系统视图类型不能改写；请从 workspace inspect 返回的 views 中选择目标 viewId，并设置 isSelected。')
    constraints(group, patch.dateRangeType ?? current.dateRangeType, asObject(results.mode).mode, params.type, params.startDate, params.endDate)
    if (sort === 'custom' && group !== 'custom') fail('INVALID_INPUT', '只有自定义分组支持自定义排序。')
    if (patch.filter !== undefined) {
      // Send complete definitions to clear omitted selections, as in the UI.
      patch.filter = resolveExecutionFilters(patch.filter, filterList(results.filters))
    }
    results.executionExpected = { ...patch, id: String(current.id) }; return { body: { id: String(current.id), ...patch } }
  }
  if (action.startsWith('group-')) {
    const groups = editableGroups(input, results, session), selected = input.groupId == null ? undefined : select(groups, input.groupId)
    if (selected && (selected.isUngroup === true || selected.groupType !== 'custom')) fail('FORBIDDEN', '固定分组和未分组不能修改。')
    anchor(groups, input.groupId, input.frontId, input.nextId)
    results.executionExpected = { ...(selected && { id: selected.id }), ...(input.name !== undefined && { name: input.name }), moveId: input.groupId, frontId: input.frontId, nextId: input.nextId }
    if (action === 'group-create') return { body: { type: params.type, typeId: params.typeId, name: input.name, ...(input.frontId != null && { frontId: input.frontId }), ...(input.nextId != null && { nextId: input.nextId }) } }
    if (action === 'group-rename') return { body: { id: selected?.id, name: input.name } }
    if (action === 'group-remove') return { query: { id: selected?.id } }
    if (action === 'group-order') return { body: { moveId: selected?.id, ...(input.frontId != null && { frontId: input.frontId }), ...(input.nextId != null && { nextId: input.nextId }) } }
  }
  if (action === 'fields-set' || action === 'fields-order') {
    if (current.viewType !== 'list') fail('INVALID_INPUT', '显示字段仅适用于列表视图。')
    if (action === 'fields-set') {
      const fields = rows(results.fields).flatMap(group => rows(group.list)), seen = new Set<string>()
      const list = (input.fields as string[]).map(id => {
        const matches = fields.filter(field => same(field.id, id) || field.name === id)
        if (matches.length !== 1 || seen.has(String(matches[0].id))) fail('INVALID_INPUT', '显示字段不存在、不唯一或重复。')
        const field = matches[0]; seen.add(String(field.id))
        return Object.fromEntries(['id', 'key', 'name', 'taskTemplateType'].filter(key => field[key] != null).map(key => [key, field[key]]))
      })
      results.executionExpected = { fields: list }; return { body: { viewId: current.id, list } }
    }
    const selected = rows(results.selectedFields); select(selected, input.moveId, 'primaryId'); anchor(selected, input.moveId, input.frontId, input.nextId, 'primaryId')
    results.executionExpected = { moveId: input.moveId, frontId: input.frontId, nextId: input.nextId }
    return { body: { viewId: current.id, moveId: input.moveId, ...(input.frontId != null && { frontId: input.frontId }), ...(input.nextId != null && { nextId: input.nextId }) } }
  }
  if (action === 'item-move') {
    const groups = editableGroups(input, results, session, 'dragTask'), source = select(groups, input.sourceGroupId), destination = select(groups, input.destinationGroupId)
    if (same(source.id, destination.id) || source.groupType !== 'custom' || destination.groupType !== 'custom') fail('INVALID_INPUT', '任务移动需要不同的自定义分组。')
    const item = select(rows(asObject(results.sourceItems).list), input.itemId)
    if (item.processInfoId != null) fail('INVALID_INPUT', '流程待办不能通过普通任务移动接口操作。')
    anchor(rows(asObject(results.targetItems).list), input.itemId, input.frontId, input.nextId)
    results.executionExpected = { itemId: input.itemId }
    return { body: { moveId: input.itemId, srcExecutionGroupId: source.id, destExecutionGroupId: destination.id, ...(input.frontId != null && { frontId: input.frontId }), ...(input.nextId != null && { nextId: input.nextId }) } }
  }
  fail('INVALID_CONTRACT', '未知执行台适配。')
}
export function verifyExecution(input: JsonObject, results: JsonObject, step: string) {
  const expected = asObject(results.executionExpected), failReadback = () => fail('BUSINESS_ASSERTION_FAILED', '执行台独立读回与提交目标不符，请核对已完成步骤；不会重放写入。')
  if (step === 'verifiedMode') { if (asObject(results[step]).mode !== expected.mode) failReadback(); return }
  if (step === 'verifiedViews') {
    const current = select(rows(results[step]), expected.id)
    for (const key of ['group', 'sort', 'viewType', 'dateRangeType', 'isSelected']) if (Object.hasOwn(expected, key) && current[key] !== expected[key]) failReadback()
  } else if (step === 'verifiedFilters') {
    if (Object.hasOwn(expected, 'filter') && JSON.stringify(normalizedFilters(filterList(results[step]))) !== JSON.stringify(normalizedFilters(rows(expected.filter)))) failReadback()
  } else if (step === 'verifiedFields') {
    const actual = rows(results[step]), wanted = rows(expected.fields ?? [])
    if (Object.hasOwn(expected, 'moveId')) ordered(actual, expected, 'primaryId')
    // An empty selection deliberately restores server defaults.
    else if (wanted.length && (actual.length !== wanted.length || wanted.some((field, index) => !same(actual[index]?.id, field.id)))) failReadback()
    else if (!wanted.length && !actual.length) failReadback()
  } else if (step === 'verifiedItems') {
    if (!rows(asObject(results[step]).list).some(item => same(item.id, expected.itemId))) failReadback()
  } else if (step === 'verifiedGroups') {
    const actual = rows(asObject(results[step]).groupList)
    if (results.created) { if (select(actual, asObject(results.created).id).name !== expected.name) failReadback() }
    else if (Object.hasOwn(expected, 'name')) { if (select(actual, expected.id).name !== expected.name) failReadback() }
    else if (input.frontId != null || input.nextId != null) ordered(actual, expected)
    else if (actual.some(group => same(group.id, expected.id))) failReadback()
  }
}
export function describeExecution(input: JsonObject, results: JsonObject, provided: Session | null) {
  const session = requireSession(provided)
  const { current, params } = query(input, results, session)
  return { scope: { type: params.type, typeId: params.typeId }, mode: results.mode, views: results.views, view: current, version: executionVersion(results, current), filters: results.filters, selectedFilters: results.selectedFilters, groups: results.groups, fields: results.fields, selectedFields: results.selectedFields }
}

export function validateExecutionInput(input: JsonObject) {
  if (input.startDate !== undefined && date(input.startDate) > date(input.endDate)) fail('INVALID_INPUT', '开始日期不能晚于结束日期。')
  if (['dept', 'group'].includes(String(input.type)) && input.typeId === undefined) fail('INVALID_INPUT', '部门或小组范围需要 typeId。')
}
