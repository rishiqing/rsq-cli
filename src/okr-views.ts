import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
function id(value: unknown): string { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('OKR 视图上下文含无效或不精确的资源 ID。') }
function rows(value: unknown): JsonObject[] { return Array.isArray(value) ? value.map(asObject) : fail('OKR 视图未返回完整列表。') }
const pick = (source: JsonObject, names: string[]) => Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]))
function unique(values: JsonObject[]) { const ids = values.map(row => id(row.id)); if (new Set(ids).size !== ids.length) fail('OKR 视图列表有重复资源。'); return values }
function boards(value: unknown) { return unique(rows(asObject(asObject(value).team).kanbanList)).map(board => ({ id: id(board.id), name: board.name, type: board.type, isShowKr: board.isShowKr, displayOrder: board.displayOrder })) }
function cardConfig(card: JsonObject) { return { id: id(card.id), cycleId: card.cycleId == null ? null : id(card.cycleId), type: card.type ?? null, typeDataId: card.typeDataId == null ? null : id(card.typeDataId), responsibleUserId: card.responsibleUserId == null ? null : id(card.responsibleUserId), cycleStatus: card.cycleStatus, displayOrder: card.displayOrder } }
function boardConfig(value: unknown) { const board = asObject(value); if (board.type !== 'team' || typeof board.name !== 'string' || typeof board.isShowKr !== 'boolean') fail('公示看板不是当前企业看板或缺少配置。'); return { id: id(board.id), name: board.name, type: board.type, isShowKr: board.isShowKr, cardList: unique(rows(board.cardList)).map(cardConfig) } }
function identity(results: JsonObject, session: Session | null) {
  const expected = requireSession(session).identity, user = asObject(results.user)
  if (id(user.id) !== expected.userId || id(asObject(user.team).id) !== expected.teamId) fail('OKR 视图身份或公司发生变化。', 'IDENTITY_CHANGED')
  return expected
}
function targetBoard(input: JsonObject, results: JsonObject) {
  if (!boards(results.directory).some(board => board.id === input.boardId && board.type === 'team')) fail('看板不在当前公司的公示目录中。', 'FORBIDDEN')
  const board = boardConfig(results.before)
  if (board.id !== input.boardId) fail('看板详情与所选资源不一致。')
  return board
}
function manage(results: JsonObject) { if (asObject(asObject(asObject(results.preflightDirectory ?? results.directory).team).editControl).manageKanban !== true) fail('当前身份没有管理企业公示看板的 UI 权限。', 'FORBIDDEN') }
function prepareState(results: JsonObject, data: JsonObject) { results.prepared = { ...data, resources: { ...asObject(asObject(results.prepared).resources), ...asObject(data.resources) } } }
function compare(before: unknown, after: unknown) { if (!isDeepStrictEqual(before, after)) fail('写前视图配置已变化；请重新读取上下文，不会覆盖或自动重放。', 'CONTEXT_CONFLICT') }
function ordering(values: JsonObject[], movingId: unknown, input: JsonObject) {
  if ((input.beforeId == null) === (input.afterId == null)) fail('必须且只能指定 beforeId 或 afterId。', 'INVALID_INPUT')
  const moving = values.find(row => id(row.id) === movingId), anchorId = input.beforeId ?? input.afterId
  if (!moving || movingId === anchorId || !values.some(row => id(row.id) === anchorId)) fail('排序目标及锚点须为同一当前列表内不同资源。', 'INVALID_INPUT')
  const rest = values.filter(row => id(row.id) !== movingId), index = rest.findIndex(row => id(row.id) === anchorId) + (input.afterId == null ? 0 : 1)
  return { order: [...rest.slice(0, index), moving, ...rest.slice(index)].map(row => id(row.id)), frontId: rest[index - 1] ? id(rest[index - 1]!.id) : null, nextId: rest[index] ? id(rest[index]!.id) : null }
}
function selection(input: JsonObject, results: JsonObject, session: Session | null) {
  const selected = asObject(input.selection), who = identity(results, session), cycles = asObject(results.cycles)
  if (!['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(key => rows(cycles[key])).some(cycle => id(cycle.id) === selected.cycleId && cycle.isArchived !== true)) fail('卡片周期不在当前公司未归档周期目录中。', 'INVALID_INPUT')
  const departments = companyDirectoryUnits(results.tree), people = companyDirectoryUsers(results.tree)
  if (selected.responsibleUserId != null && !people.some(user => id(user.id) === selected.responsibleUserId)) fail('卡片负责人不在当前公司实际通讯录中。', 'FORBIDDEN')
  if (selected.type !== 'dept' && selected.departmentId !== undefined) fail('只有部门类型可以指定 departmentId。', 'INVALID_INPUT')
  const typeDataId = selected.type === 'company' ? id(who.teamId) : selected.type === 'dept' ? departments.find(dept => dept.id === selected.departmentId)?.id ?? fail('请选择当前公司真实部门。', 'INVALID_INPUT') : selected.type === 'person' ? selected.responsibleUserId ?? null : null
  const expected = { cycleId: selected.cycleId, type: selected.type === 'all' ? null : selected.type, typeDataId, responsibleUserId: selected.responsibleUserId ?? null }
  return { expected, body: { cycleId: selected.cycleId, ...(selected.type !== 'all' && { type: selected.type }), ...(typeDataId != null && { typeDataId }), ...(selected.responsibleUserId != null && { responsibleUserId: selected.responsibleUserId }) } }
}
function planItems(value: unknown) { return unique(rows(value)).map(row => ({ id: id(row.id), deptId: id(row.deptId), name: row.name })) }
function preferences(value: unknown, results: JsonObject, session: Session | null) {
  const config = asObject(value)
  identity(results, session)
  // The authenticated endpoint resolves getOkrUserId(), an internal service ID.
  // It is deliberately distinct from authAjax's public company-user ID. Keep it
  // explicit and compare it across preflight/readback, never accept a caller ID.
  return { ...pick(config, ['isShowKeyResult', 'isHorizontal', 'isShowInitCard', 'isIndicatorHorizontal', 'defaultModule', 'defaultCycleId']), okrUserId: id(config.userId) }
}

export function prepareOkrView(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const action = kind.replace('okr-views-', '')
  identity(results, session)
  if (action === 'preferences-update') {
    const current = preferences(results.config, results, session); compare(current, preferences(results.preflightConfig, results, session))
    const patch = Object.fromEntries(Object.entries(input).filter(([key, value]) => current[key as keyof typeof current] !== value))
    prepareState(results, { action, expected: { ...current, ...patch }, resources: { userId: requireSession(session).identity.userId } })
    return Object.keys(patch).length ? { body: patch } : null
  }
  if (action === 'publicity-inspect') {
    if (!boards(results.directory).some(board => board.id === input.boardId && board.type === 'team')) fail('看板不在当前企业公示目录中。', 'FORBIDDEN')
    prepareState(results, { action, resources: { boardId: input.boardId } }); return { query: { id: input.boardId } }
  }
  if (action === 'publicity-readback') { const boardId = asObject(results.prepared).action === 'publicity-create' ? asObject(results.created).id : input.boardId; return { query: { id: id(boardId) } } }
  if (action.startsWith('publicity-')) {
    compare(boards(results.directory), boards(results.preflightDirectory)); manage(results)
    const board = action === 'publicity-create' ? null : targetBoard(input, results)
    if (board) compare(board, boardConfig(results.preflight))
    prepareState(results, { action, before: board, directory: boards(results.directory), resources: { ...(input.boardId != null && { boardId: input.boardId }), ...(input.cardId != null && { cardId: input.cardId }) } })
    const prepared = asObject(results.prepared)
    if (action === 'publicity-create') { if (!String(input.name).trim()) fail('看板名称不能为空白。', 'INVALID_INPUT'); prepared.expected = { name: input.name, type: 'team', isShowKr: false }; return { body: { name: input.name, type: 'team' } } }
    const before = board!
    if (action === 'publicity-rename' || action === 'publicity-key-results') {
      if (action === 'publicity-rename' && !String(input.name).trim()) fail('看板名称不能为空白。', 'INVALID_INPUT')
      const patch = action === 'publicity-rename' ? { name: input.name } : { isShowKr: input.enabled }
      prepared.expected = { name: before.name, isShowKr: before.isShowKr, ...patch }
      return Object.entries(patch).every(([key, value]) => before[key as keyof typeof before] === value) ? null : { body: { id: input.boardId, ...patch } }
    }
    if (action === 'publicity-remove') return { query: { id: input.boardId } }
    if (action === 'publicity-move') {
      const moved = ordering(boards(results.directory), input.boardId, input); prepared.order = moved.order
      return isDeepStrictEqual(moved.order, boards(results.directory).map(row => row.id)) ? null : { body: { moveId: input.boardId, ...(moved.frontId && { frontId: moved.frontId }), ...(moved.nextId && { nextId: moved.nextId }) } }
    }
    const cards = before.cardList, current = action === 'publicity-card-create' ? null : cards.find(card => card.id === input.cardId) ?? fail('卡片不属于所选看板。', 'FORBIDDEN')
    if (action === 'publicity-card-create' || action === 'publicity-card-configure') {
      if (current && current.cycleStatus !== 'normal') fail('当前卡片周期已归档或删除；只能读取、排序或移除。', 'FORBIDDEN')
      const selected = selection(input, results, session); prepared.expected = selected.expected
      if (current && Object.entries(selected.expected).every(([key, value]) => current[key as keyof typeof current] === value)) return null
      return { body: action === 'publicity-card-create' ? { kanbanId: input.boardId, ...selected.body } : { id: input.cardId, ...selected.body, ...(asObject(input.selection).type === 'all' && { type: '' }), responsibleUserId: asObject(input.selection).responsibleUserId ?? '0' } }
    }
    if (action === 'publicity-card-remove') return { query: { id: input.cardId } }
    if (action === 'publicity-card-move') {
      const moved = ordering(cards, input.cardId, input); prepared.order = moved.order
      return isDeepStrictEqual(moved.order, cards.map(card => card.id)) ? null : { body: { moveId: input.cardId, ...(moved.frontId && { frontId: moved.frontId }), ...(moved.nextId && { behindId: moved.nextId }) } }
    }
  }
  if (action === 'plan-list' || action === 'plan-superiors') {
    const cycles = asObject(results.cycles), all = ['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(key => rows(cycles[key]))
    if (!all.some(cycle => id(cycle.id) === input.cycleId && cycle.isArchived !== true)) fail('工作计划周期不在当前公司未归档周期目录中。', 'INVALID_INPUT')
    if (!companyDirectoryUnits(results.tree).some(dept => dept.id === input.departmentId)) fail('工作计划必须选择当前公司的实际部门；公司范围使用根部门 ID。', 'FORBIDDEN')
    prepareState(results, { action, resources: { departmentId: input.departmentId, cycleId: input.cycleId } })
    return { query: { cycleId: input.cycleId, type: 'dept', dataId: input.departmentId, filterType: input.filter ?? 'dept', max: input.limit ?? 30, ...(input.after != null && { frontId: input.after }) } }
  }
  if (action.startsWith('plan-')) {
    const items = planItems(results.items); compare(items, planItems(results.preflightItems))
    prepareState(results, { action, items, resources: { ...(input.itemId != null && { itemId: input.itemId }), ...(input.departmentId != null && { departmentId: input.departmentId }) } })
    const prepared = asObject(results.prepared)
    if (action === 'plan-open') {
      if (!companyDirectoryUnits(results.tree).some(dept => dept.id === input.departmentId)) fail('不能为其他公司或未分配部门添加工作计划页签。', 'FORBIDDEN')
      if (items.some(row => row.deptId === input.departmentId)) fail('该部门页签已存在，请从当前列表使用其实际 ID。', 'INVALID_INPUT')
      return { body: { deptId: input.departmentId } }
    }
    if (!items.some(row => row.id === input.itemId)) fail('页签不属于当前公司用户；页签 ID 与部门 ID 不可混用。', 'FORBIDDEN')
    if (action === 'plan-close') return { query: { id: input.itemId } }
    if (action === 'plan-move') { const moved = ordering(items, input.itemId, input); prepared.order = moved.order; return isDeepStrictEqual(moved.order, items.map(row => row.id)) ? null : { body: { moveId: input.itemId, ...(moved.frontId && { frontId: moved.frontId }), ...(moved.nextId && { nextId: moved.nextId }) } } }
  }
  fail('未知的 OKR 视图上下文适配。', 'INVALID_CONTRACT')
}

export function verifyOkrView(input: JsonObject, results: JsonObject, step: string, session: Session | null) {
  identity(results, session)
  if (step === 'user') return
  const prepared = asObject(results.prepared), action = String(prepared.action), before = asObject(prepared.before)
  const assert = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) fail('OKR 视图独立 HTTP 读回与预期不一致；请按资源 ID 核对，不会自动重放。', 'BUSINESS_ASSERTION_FAILED') }
  if (step === 'verifiedConfig') { assert(preferences(results.verifiedConfig, results, session), prepared.expected); return }
  if (step === 'verifiedDirectory') {
    const old = rows(prepared.directory), actual = boards(results.verifiedDirectory), createdId = action === 'publicity-create' ? id(asObject(results.created).id) : null
    if (action === 'publicity-remove') assert(actual, old.filter(board => board.id !== input.boardId))
    else if (action === 'publicity-create') {
      assert(actual.filter(board => board.id !== createdId), old)
      const created = actual.find(board => board.id === createdId); if (!created) assert(null, prepared.expected)
      for (const [key, value] of Object.entries(asObject(prepared.expected))) assert(asObject(created)[key], value)
    } else if (action === 'publicity-move') {
      assert(actual.map(board => board.id), prepared.order)
      assert(actual.map(board => pick(board, ['id', 'name', 'type', 'isShowKr'])).sort((a, b) => String(a.id).localeCompare(String(b.id))), old.map(board => pick(board, ['id', 'name', 'type', 'isShowKr'])).sort((a, b) => String(a.id).localeCompare(String(b.id))))
    } else if (action === 'publicity-rename' || action === 'publicity-key-results') assert(actual, old.map(board => board.id === input.boardId ? { ...board, ...asObject(prepared.expected) } : board))
    return
  }
  if (step === 'verified') {
    const actual = boardConfig(results.verified)
    assert(actual.id, action === 'publicity-create' ? id(asObject(results.created).id) : input.boardId)
    if (action === 'publicity-create') { for (const [key, value] of Object.entries(asObject(prepared.expected))) assert(actual[key as keyof typeof actual], value); assert(actual.cardList, []); return }
    if (action === 'publicity-rename' || action === 'publicity-key-results') { assert(pick(actual, ['name', 'isShowKr']), prepared.expected); assert(actual.cardList, before.cardList); return }
    if (action === 'publicity-move') { assert(actual, before); return }
    assert(pick(actual, ['name', 'type', 'isShowKr']), pick(before, ['name', 'type', 'isShowKr']))
    const cards = actual.cardList, old = rows(before.cardList), createdId = action === 'publicity-card-create' ? id(asObject(results.created).id) : null, targetId = createdId ?? input.cardId
    if (action === 'publicity-card-remove') assert(cards, old.filter(card => card.id !== targetId))
    else if (action === 'publicity-card-move') { assert(cards.map(card => card.id), prepared.order); const withoutOrder = (card: JsonObject) => pick(card, ['id', 'cycleId', 'type', 'typeDataId', 'responsibleUserId', 'cycleStatus']); assert(cards.map(withoutOrder).sort((a, b) => String(a.id).localeCompare(String(b.id))), old.map(withoutOrder).sort((a, b) => String(a.id).localeCompare(String(b.id)))) }
    else {
      assert(cards.filter(card => card.id !== targetId), old.filter(card => card.id !== targetId))
      const selected = cards.find(card => card.id === targetId)
      if (!selected) fail('新增或编辑的卡片未在独立详情中找到。', 'BUSINESS_ASSERTION_FAILED')
      for (const [key, value] of Object.entries(asObject(prepared.expected))) assert(selected[key as keyof typeof selected], value)
      if (action === 'publicity-card-configure') assert(selected.displayOrder, old.find(card => card.id === targetId)?.displayOrder)
    }
    return
  }
  if (step === 'verifiedItems') {
    const actual = planItems(results.verifiedItems), old = rows(prepared.items)
    if (action === 'plan-open') { const created = asObject(results.created); assert(actual.filter(row => row.id !== id(created.id)), old); assert(actual.find(row => row.id === id(created.id))?.deptId, input.departmentId) }
    if (action === 'plan-close') assert(actual, old.filter(row => row.id !== input.itemId))
    if (action === 'plan-move') { assert(actual.map(row => row.id), prepared.order); assert([...actual].sort((a, b) => a.id.localeCompare(b.id)), [...old].sort((a, b) => String(a.id).localeCompare(String(b.id)))) }
  }
}

function publicObjective(value: unknown): JsonObject {
  const objective = asObject(value), user = asObject(objective.responsibleUser)
  return { ...pick(objective, ['id', 'name', 'type', 'progressType', 'progress', 'progressCurrent', 'progressStart', 'progressTarget', 'confident', 'grade', 'approvalStatus', 'editControl']), ...(objective.responsibleUser != null && { responsibleUser: pick(user, ['id', 'name']) }), ...(Array.isArray(objective.kr) && { kr: objective.kr.map(publicObjective) }), ...(Array.isArray(objective.krList) && { krList: objective.krList.map(publicObjective) }) }
}
export function describeOkrView(input: JsonObject, results: JsonObject, session: Session | null) {
  const who = identity(results, session), prepared = asObject(results.prepared), action = String(prepared.action ?? ''), raw = results.verified ?? results.before
  if (results.config != null) return { context: 'okr-personal-preferences', companyId: who.teamId, userId: who.userId, configurationScope: 'current-company-user', preferences: preferences(results.verifiedConfig ?? results.config, results, session), options: { defaultModule: ['objective', 'align', 'action', 'replay'] }, ...(results.verifiedConfig != null && { verified: true }), querySideEffects: { objectiveLists: 'asynchronously-set-defaultModule-to-objective' } }
  if (results.directory != null) {
    const directory = results.verifiedDirectory ?? results.directory
    return { context: 'okr-publicity', companyId: who.teamId, managesCompanyBoards: asObject(asObject(asObject(directory).team).editControl).manageKanban === true, boards: boards(directory),
      ...(raw != null && action !== 'publicity-remove' && { board: { ...boardConfig(raw), cardList: rows(asObject(raw).cardList).map(card => ({ ...cardConfig(card), ...pick(card, ['name', 'simpleName', 'cycleName', 'cycleStartDate', 'cycleEndDate', 'editControl']), objectives: rows(card.objectiveList).map(publicObjective) })) } }),
      ...(results.cycles != null && { cycles: results.cycles }), ...(results.tree != null && { departments: companyDirectoryUnits(results.tree), people: companyDirectoryUsers(results.tree).map(user => pick(user, ['id', 'name'])) }),
      ...(action === 'publicity-remove' && { removed: true, removedBoardId: input.boardId, objectivesDeleted: false }), ...(action === 'publicity-card-remove' && { cardRemoved: true, objectivesDeleted: false }), ...(results.verified != null || results.verifiedDirectory != null ? { verified: true } : {}) }
  }
  const page = action === 'plan-list' || action === 'plan-superiors'
  return { context: 'okr-work-plans', companyId: who.teamId, userId: who.userId, configurationScope: 'current-company-user', departmentSelectionUses: 'departmentId-not-itemId',
    departments: companyDirectoryUnits(results.tree), ...(results.items != null && { openDepartments: planItems(results.verifiedItems ?? results.items) }), ...(results.cycles != null && { cycles: results.cycles }),
    ...(page && { items: results.objectives, pagination: { kind: 'cursor', limit: input.limit ?? 30, next: rows(results.objectives).length === (input.limit ?? 30) && rows(results.objectives).length && rows(results.objectives).at(-1)!.isUnAlign !== true ? id(rows(results.objectives).at(-1)!.id) : null, total: null, ...(rows(results.objectives).at(-1)?.isUnAlign === true && { terminalGroup: 'unaligned-objectives-without-resource-id' }) }, filter: input.filter ?? 'dept', queryScope: 'dept', departmentId: input.departmentId, cycleId: input.cycleId, sideEffects: ['asynchronously-set-own-defaultModule-to-objective'] }),
    ...(action === 'plan-close' && { closed: true, departmentDeleted: false, objectivesDeleted: false }), ...(results.verifiedItems != null && { verified: true }) }
}
