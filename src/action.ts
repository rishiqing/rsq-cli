import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'

function fail(code: string, message: string): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : 2) }
function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}\.\d{2}\.\d{2}$/.test(value)) fail('INVALID_INPUT', '行动日期需要 YYYY.MM.DD。')
  const iso = String(value).replaceAll('.', '-'), parsed = new Date(iso + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) fail('INVALID_INPUT', '行动日期不存在。')
  return iso
}
export function validateActionInput(input: JsonObject) {
  if (date(input.startDate) > date(input.endDate)) fail('INVALID_INPUT', '开始日期不能晚于结束日期。')
  if (['person', 'dept', 'group'].includes(String(input.type)) && !input.typeId) fail('CONTEXT_REQUIRED', '所选行动范围需要 --type-id。')
}
function viewContext(input: JsonObject, results: JsonObject) {
  if (!Array.isArray(results.views)) fail('CONTEXT_MISSING', '行动视图列表缺失。')
  const views = results.views as JsonObject[]
  const selected = input.viewId ? views.filter(view => String(view.id) === input.viewId) : views.filter(view => view.isSelected === true)
  if (selected.length !== 1) fail('AMBIGUOUS_CONTEXT', '请从 action view list 中选择唯一视图并传入 --view-id。')
  const view = selected[0]
  if (['person', 'dept', 'group'].includes(String(input.type)) && !input.typeId) fail('CONTEXT_REQUIRED', '所选行动范围需要通讯录 userId、departmentId 或 groupId，通过 --type-id 提供。')
  validateActionInput(input)
  const query: JsonObject = { type: input.type, ...(input.typeId !== undefined && { typeId: input.typeId }), viewId: String(view.id), startDate: input.startDate, endDate: input.endDate,
    showView: input.showView ?? view.subView, groupType: input.groupType ?? view.group, sortType: input.sortType ?? view.sort,
    isShowDoneTask: input.isShowDoneTask ?? view.isShowDoneTask, isShowSubTask: input.isShowSubTask ?? view.isShowSubTask,
    ...(input.type === 'my' && { filterMyType: input.filterMyType ?? 'executive' }), ...(input.type === 'dept' && { filterDeptType: input.filterDeptType ?? 'dept' }) }
  if (!query.showView || !query.groupType || !query.sortType) fail('CONTEXT_MISSING', '行动视图没有完整的展现、分组和排序配置。')
  results.actionView = view; results.actionQuery = query
  return { view, query }
}
function groupContext(input: JsonObject, results: JsonObject, editable: boolean) {
  const groups = asObject(results.groups)
  if (!Array.isArray(groups.groupList)) fail('CONTEXT_MISSING', '行动分组列表缺失。')
  if (editable && (asObject(groups.editControl).editCard !== true || asObject(results.actionQuery).groupType !== 'custom')) fail('FORBIDDEN', '当前范围或分组方式不允许维护自定义行动分组。')
  const list = groups.groupList as JsonObject[]
  const find = (id: unknown) => {
    const matches = list.filter(group => group.id === id)
    if (matches.length !== 1) fail('CONTEXT_NOT_FOUND', '分组不在当前范围中，请重新发现业务上下文。')
    return matches[0]
  }
  const group = input.groupId ? find(input.groupId) : undefined
  if (editable && group && (group.isUngroup === true || !/^custom-[1-9][0-9]*$/.test(String(group.id)))) fail('FORBIDDEN', '系统分组和未分组不能修改或删除。')
  for (const id of [input.frontId, input.nextId].filter(Boolean)) {
    if (id === input.groupId) fail('INVALID_INPUT', '相邻分组不能是自身。')
    find(id)
  }
  if (input.frontId && input.frontId === input.nextId) fail('INVALID_INPUT', '前后分组不能相同。')
  return { list, group }
}
export function prepareAction(action: string, input: JsonObject, results: JsonObject): JsonObject {
  if (action === 'action-context') return { query: viewContext(input, results).query }
  const query = asObject(results.actionQuery)
  if (action === 'action-filters') {
    if (!Object.keys(query).length) viewContext(input, results)
    const context = asObject(results.actionQuery)
    return { query: Object.fromEntries(['type', 'typeId', 'viewId', 'startDate', 'endDate', 'filterDeptType'].filter(key => context[key] !== undefined).map(key => [key, context[key]])) }
  }
  if (action === 'action-groups-verify') return { query }
  if (action === 'action-group-count') {
    const { list } = groupContext(input, results, false), ids = input.groupIds as string[] | undefined ?? list.map(group => String(group.id))
    if (ids.some(id => !list.some(group => group.id === id))) fail('CONTEXT_NOT_FOUND', '计数分组不在当前范围中。')
    if (!ids.length) fail('NO_RESULTS', '当前范围没有可统计的分组。')
    return { query: { ...query, groupIds: ids.join(',') } }
  }
  if (action === 'action-group-tasks') {
    groupContext(input, results, false)
    return { query: { ...query, groupId: input.groupId, max: input.max ?? 20, offset: input.offset ?? 0 } }
  }
  if (action === 'action-view-update') {
    const { view } = viewContext(input, results), patch = structuredClone(asObject(input.patch))
    if (patch.name !== undefined && view.isCustom !== true) fail('FORBIDDEN', '系统视图不能重命名。')
    if (Array.isArray(patch.filter)) {
      const available = asObject(results.filters).filter
      if (!Array.isArray(available)) fail('CONTEXT_MISSING', '行动筛选定义缺失。')
      const selected = new Map<string, JsonObject>()
      for (const raw of patch.filter) {
        const item = asObject(raw), key = String(item.key)
        if (selected.has(key) || !available.some(filter => asObject(filter).key === key)) fail('CONTEXT_NOT_FOUND', '筛选 key 不存在或重复，请从 workspace inspect 获取筛选定义。')
        selected.set(key, item)
      }
      patch.filter = available.map(raw => {
        const current = asObject(raw), change = selected.get(String(current.key))
        const merged: JsonObject = { ...current, ...(change ?? {}), ...(!patch.filter || !(patch.filter as unknown[]).length ? { contentValue: '' } : {}) }
        for (const name of ['operator', 'selector']) {
          const options = current[name] as JsonObject[] | undefined, changes = change?.[name] as JsonObject[] | undefined
          if (changes && (!Array.isArray(options) || changes.some(entry => !options.some(option => option.value === entry.value)))) fail('CONTEXT_NOT_FOUND', '筛选操作符或选项不在当前业务上下文中。')
          if (Array.isArray(options) && (changes || name === 'selector' && !(patch.filter as unknown[]).length)) merged[name] = options.map(option => ({ ...option, selected: changes?.some(entry => entry.value === option.value && entry.selected === true) ?? false }))
        }
        return Object.fromEntries(Object.entries(merged).filter(([key, value]) => ['contentValue', 'key', 'type', 'name', 'operator', 'selector'].includes(key) && value != null).map(([key, value]) => [key,
          ['operator', 'selector'].includes(key) && Array.isArray(value) ? value.map(option => Object.fromEntries(Object.entries(asObject(option)).filter(([key, value]) => ['name', 'value', 'selected'].includes(key) && value != null))) : value]))
      })
    }
    const body: JsonObject = { id: String(view.id), type: input.type, ...(input.typeId !== undefined && { typeId: input.typeId }),
      subView: view.subView, group: view.group, sort: view.sort, isShowDoneTask: view.isShowDoneTask, isShowSubTask: view.isShowSubTask, ...patch }
    results.prepared = { action, resources: { viewId: String(view.id) }, expected: { ...body, ...(body.name !== undefined && { viewName: body.name }) } }
    return { body }
  }
  const { group } = groupContext(input, results, true)
  const resources: JsonObject = { ...(group && { groupId: String(group.id) }) }
  if (action === 'action-group-add') {
    if (!['my', 'person', 'dept'].includes(String(input.type))) fail('CONTEXT_REQUIRED', '当前后端只支持个人和部门自定义分组的创建。')
    results.prepared = { action, resources, expected: { name: input.name } }
    return { body: { name: input.name, ascriptionType: input.type, ...(input.typeId !== undefined && { ascriptionId: input.typeId }), ...(input.frontId !== undefined && { frontId: input.frontId }), ...(input.nextId !== undefined && { nextId: input.nextId }) } }
  }
  if (!group) fail('CONTEXT_REQUIRED', '请指定 --group-id。')
  results.prepared = { action, resources, expected: { id: group.id, ...(action === 'action-group-rename' && { name: input.name }) } }
  if (action === 'action-group-rename') return { body: { id: group.id, name: input.name } }
  if (action === 'action-group-remove') return { query: { id: group.id } }
  if (action === 'action-group-reorder') return { body: { moveId: group.id, ascriptionType: input.type, ...(input.typeId !== undefined && { ascriptionId: input.typeId }), ...(input.frontId !== undefined && { frontId: input.frontId }), ...(input.nextId !== undefined && { nextId: input.nextId }) } }
  fail('INVALID_CONTRACT', '未知行动业务适配。')
}
export function verifyAction(results: JsonObject, stepId = 'verify') {
  const prepared = asObject(results.prepared), expected = asObject(prepared.expected), failAssertion = () => { throw new RsqError('BUSINESS_ASSERTION_FAILED', '行动读回与业务变更不符，请先核对已完成步骤和资源。', 5) }
  if (prepared.action === 'action-view-update') {
    if (!Array.isArray(results.verify)) return failAssertion()
    const view = (results.verify as JsonObject[]).find(view => String(view.id) === String(expected.id))
    if (!view) return failAssertion()
    for (const key of ['subView', 'group', 'sort', 'isShowDoneTask', 'isShowSubTask', 'viewName', 'isSelected']) if (Object.hasOwn(expected, key) && !isDeepStrictEqual(view[key], expected[key])) failAssertion()
    if (stepId === 'filterVerify' && Array.isArray(expected.filter)) {
      const actual = asObject(results.filterVerify).filter
      if (!Array.isArray(actual)) return failAssertion()
      for (const raw of expected.filter) {
        const wanted = asObject(raw), entry = (actual as JsonObject[]).find(filter => filter.key === wanted.key)
        if (!entry || String(entry.contentValue ?? '') !== String(wanted.contentValue ?? '')) return failAssertion()
        for (const name of ['operator', 'selector']) if (Array.isArray(wanted[name])) {
          const values = (value: unknown) => (Array.isArray(value) ? value as JsonObject[] : []).filter(option => option.selected === true).map(option => String(option.value)).sort()
          if (!isDeepStrictEqual(values(entry[name]), values(wanted[name]))) failAssertion()
        }
      }
    }
    return
  }
  const groups = asObject(results.verify).groupList
  if (!Array.isArray(groups)) return failAssertion()
  const id = expected.id ?? asObject(results.write).id
  if (prepared.action === 'action-group-remove') { if (groups.some(group => asObject(group).id === id)) failAssertion(); return }
  const group = (groups as JsonObject[]).find(group => group.id === id)
  if (!group || expected.name !== undefined && group.name !== expected.name) return failAssertion()
  if (prepared.action === 'action-group-reorder' && group.displayOrder !== results.write) failAssertion()
}
