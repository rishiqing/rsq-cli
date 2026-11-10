import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'
import { validateFeatures } from './access.js'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const denied = (message: string): never => { throw new RsqError('RESOURCE_FORBIDDEN', message, 4) }
const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('风险上下文缺少精确资源 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : invalid('风险上下文缺少有界完整列表。')
const same = (actual: unknown, expected: unknown) => actual != null && expected != null && String(actual) === String(expected)
const allowed = (row: JsonObject, permission: string) => { if (asObject(row.editControl)[permission] !== true) denied('当前 UI 未授予 ' + permission + ' 权限。') }
function target(input: JsonObject, results: JsonObject, optional = false) {
  const project = asObject(results.project)
  if (id(project.id) !== input.projectId || !Object.hasOwn(project, 'coverId') || project.coverId !== null) denied('风险命令需要实际普通项目，模板使用独立上下文。')
  const selected = rows(results.modules).filter(module => module.type === 'risk-module' && (input.moduleId == null || same(module.id, input.moduleId)))
  if (selected.length > 1) invalid('风险模块不唯一，请显式提供 moduleId。')
  if (!optional && selected.length !== 1) denied('项目中不存在所选可见风险模块。')
  return { project, module: selected[0] }
}
function risk(input: JsonObject, results: JsonObject) {
  const { module } = target(input, results), before = asObject(results.before)
  if (!same(before.id, input.riskId) || !same(before.kanbanChildId, module.id)) denied('风险必须实际属于所选项目的风险模块。')
  return before
}
function delta(value: unknown) {
  const result = typeof value === 'string' ? value === '' ? {} : { ops: [{ insert: value.endsWith('\n') ? value : value + '\n' }] } : asObject(value)
  if (Object.keys(result).length && (!Array.isArray(result.ops) || result.ops.length > 10000 || result.ops.some(value => {
    const op = asObject(value)
    return typeof op.insert !== 'string' || Object.keys(op).some(key => !['insert', 'attributes'].includes(key)) || op.attributes != null && op.attributes !== asObject(op.attributes)
  }))) invalid('风险方案和进展须为文本或完整文本 Delta，不能使用浏览器占位内容、retain/delete 或未上传的嵌入对象。')
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) invalid('风险文本内容超过 4MiB。')
  return result
}
function calendar(value: unknown): string {
  if (value === null || value === '') return ''
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00+08:00')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) invalid('预计完成日期必须是真实的 YYYY-MM-DD，或 null 明确清空。')
  return value as string
}
function changes(patch: JsonObject, before: JsonObject, results: JsonObject) {
  const body: JsonObject = {}, expected: JsonObject = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!['name', 'status', 'possible', 'impact', 'cost', 'time', 'quality', 'note', 'principalId', 'deadline'].includes(key)) invalid('风险补丁包含未核对属性。')
    if (key === 'name' && (typeof value !== 'string' || !value.trim() || value.length > 200)) invalid('风险名称不能为空，最多 200 字符。')
    if (key === 'status' && ![1, 2, 3].includes(Number(value))) invalid('风险状态只支持 1 打开、2 暂缓、3 关闭。')
    if (['possible', 'impact'].includes(key) && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 5)) invalid('风险概率和影响必须为 1 至 5 的整数。')
    if (['cost', 'time', 'quality'].includes(key) && typeof value !== 'boolean') invalid('风险影响范围必须是明确的布尔值。')
    if (key === 'note') { expected.note = delta(value); body.note = JSON.stringify(expected.note) }
    else if (key === 'deadline') { const date = calendar(value); body.deadline = date.replaceAll('-', '.'); expected.deadline = date || null }
    else if (key === 'principalId') {
      if (value !== null && !companyDirectoryUsers(results.directory).some(member => id(member.id) === value)) denied('风险负责人必须从当前实际公司目录发现；null 清空。')
      body.principalId = value ?? ''; expected.principalId = value
    } else { body[key] = value; expected[key] = value }
  }
  if (patch.possible !== undefined || patch.impact !== undefined) {
    const possible = patch.possible ?? before.possible, impact = patch.impact ?? before.impact
    const matrix = rows(results.matrix).filter(row => row.possible === possible && row.impact === impact)
    // Existing installations can contain duplicate matrix rows. Identical
    // levels are unambiguous; conflicting levels must still stop the write.
    if (!matrix.length || matrix.some(row => ![1, 2, 3].includes(Number(row.level))) || new Set(matrix.map(row => row.level)).size !== 1) invalid('风险矩阵未返回唯一有效的概率、影响和等级组合。')
    body.possible = possible; body.impact = impact; body.level = matrix[0].level
    Object.assign(expected, { possible, impact, level: matrix[0].level })
  }
  return { body, expected }
}
export function prepareProjectRisk(action: string, input: JsonObject, results: JsonObject): JsonObject | null {
  const { project, module } = target(input, results, action === 'module-open')
  results.riskContext = { ...asObject(results.riskContext), action, projectId: input.projectId, ...(module && { moduleId: id(module.id) }) }
  if (action === 'module-open') {
    allowed(project, 'createKanbanChild')
    return module ? null : { body: { kanbanId: input.projectId } }
  }
  if (action === 'module-close') {
    allowed(module, 'removeKanbanChild')
    if (rows(results.modules).length < 2) invalid('至少保留一个可见项目模块。')
    return { body: { kanbanId: input.projectId } }
  }
  if (action === 'matrix') return {}
  if (action === 'list' || action === 'verify-list') return { query: { kanbanChildId: id(module.id), max: input.max ?? 200, ...(input.lastId != null && { lastId: input.lastId }) } }
  if (action === 'target') return { path: { id: input.riskId } }
  if (action === 'verify-created') return { path: { id: id(asObject(results.created).id) } }
  if (action === 'create' || action === 'update') {
    const before = action === 'update' ? risk(input, results) : {}, patch = action === 'create' ? asObject(input.values) : asObject(input.patch)
    const { body, expected } = changes(patch, before, results)
    if (!Object.keys(body).length || action === 'create' && (!body.name || body.possible == null || body.impact == null)) invalid('创建风险必须提供 name、possible 和 impact；更新必须有明确属性。')
    results.riskExpected = { ...expected, ...(action === 'create' && { kanbanChildId: id(module.id) }) }
    return action === 'create' ? { body: { ...body, kanbanChildId: id(module.id), ...(body.note === undefined && { note: '{}' }) } } : { path: { id: input.riskId }, body }
  }
  const before = risk(input, results)
  if (action === 'task-list') return { body: { key: id(before.kanbanCardId), planId: id(module.id), planViewId: null, showView: 'kanban', groupType: 'card', sortType: null, filter: [], isNeedTemplateField: true, offset: input.offset ?? 0, max: input.max ?? 200 } }
  if (action === 'task-permissions') return { query: { planId: id(module.id) } }
  if (action === 'task-templates') return { query: { id: input.projectId } }
  if (action === 'task-create') {
    const permissions = asObject(results.cardPermissions), templates = rows(results.templates).filter(template => template.isStop !== true)
    if (permissions.createTask !== true) denied('当前风险模块未授予 createTask 权限。')
    const selected = templates.filter(template => input.templateId != null ? same(template.id,input.templateId) : template.isDefault === true)
    if (selected.length !== 1) invalid('没有唯一可用默认类型，请从当前项目 templates 显式选择 templateId。')
    if (selected[0].isDefault !== true) {
      validateFeatures(['TASK_TYPE'],results.functions,asObject(results.company))
      if (permissions.modifyTaskType !== true) denied('风险模块未授予选择其他任务类型的权限。')
    }
    const body: JsonObject = { name: input.name, projectId: input.projectId, moduleId: id(module.id), cardId: id(before.kanbanCardId), taskTemplateId: id(selected[0].id), groupType: 'card' }
    if (input.note != null) body.note = JSON.stringify(delta(input.note))
    if (input.memberIds !== undefined) {
      if (permissions.addTaskMember !== true) denied('风险模块未授予 addTaskMember 权限。')
      const available = new Set(companyDirectoryUsers(results.directory).map(member => id(member.id)))
      const ids = (input.memberIds as unknown[]).map(id)
      if (new Set(ids).size !== ids.length || ids.some(id => !available.has(id))) denied('任务成员必须来自当前公司实际成员目录。')
      body.memberIds = ids.join(',')
    }
    results.riskExpected = { taskName: input.name, templateId: body.taskTemplateId, riskId: input.riskId, moduleId: id(module.id), cardId: body.cardId }
    return { body }
  }
  if (action === 'task-readback') {
    const taskId = asObject(results.createdTask).id
    if (typeof taskId !== 'string' || !taskId || taskId.length > 256) invalid('任务创建没有返回有效任务 ID。')
    return { query: { id: taskId, module: 'project', siteId: input.projectId } }
  }
  if (action === 'remove') return { path: { id: input.riskId } }
  if (action === 'actions') return { query: { id: input.riskId } }
  if (action === 'progress-current' || action === 'progress-list') return { query: { riskId: input.riskId, ...(action === 'progress-list' && { max: input.max ?? 200, ...(input.lastId != null && { lastId: input.lastId }) }) } }
  if (action === 'progress-create') {
    const note = delta(input.note); results.riskExpected = { note, status: input.status, riskId: input.riskId }
    return { body: { riskId: input.riskId, status: input.status, note: JSON.stringify(note) } }
  }
  if (action === 'progress-remove') {
    const selected = rows(before.progressList).filter(progress => same(progress.id, input.progressId))
    if (selected.length !== 1) denied('进展必须来自当前风险详情的实际完整 progressList，不能删除其他风险或猜测 ID。')
    results.riskExpected = { removedProgressId: input.progressId }
    return { query: { id: input.progressId } }
  }
  throw new RsqError('INVALID_CONTRACT', '未知风险业务上下文。', 6)
}
function compare(row: JsonObject, expected: JsonObject) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === 'principalId' ? row.principalId ?? asObject(row.principal).id : row[key]
    if (key === 'note') { let parsed = actual; if (typeof parsed === 'string') parsed = parseJson(parsed); if (!isDeepStrictEqual(parsed, value)) fail('风险富文本未独立持久化。') }
    else if (key === 'deadline') { if (value === null ? actual != null && actual !== '' : typeof actual !== 'string' || actual.slice(0, 10).replaceAll('.', '-') !== value) fail('风险预计完成日期未独立保存。') }
    else if (key.endsWith('Id')) { if (value === null ? actual != null && actual !== '' : !same(actual, value)) fail('风险资源关联未独立保存：' + key) }
    else if (!isDeepStrictEqual(actual, value)) fail('风险属性未独立保存：' + key)
  }
}
export function verifyProjectRisk(input: JsonObject, results: JsonObject, step: string) {
  const context = asObject(results.riskContext), expected = asObject(results.riskExpected)
  if (step === 'before') { risk(input,results); return }
  if (step === 'verifiedTask') {
    const task = asObject(results.verifiedTask), from = asObject(task.from)
    if (task.id !== asObject(results.createdTask).id || task.name !== expected.taskName || !same(from.projectId,input.projectId) || !same(from.planId,expected.moduleId) || !same(from.cardId,expected.cardId) || !same(from.riskId,input.riskId) || !same(asObject(task.taskTemplate).id,expected.templateId)) fail('风险关联任务的项目、模块、卡片、风险或任务类型未独立保存。')
    return
  }
  if (step === 'verifiedTasks' && !rows(results.verifiedTasks).some(task => task.id === asObject(results.createdTask).id && same(task.cardId,expected.cardId))) fail('新任务未在独立风险卡片任务页中出现，可能超出当前页或写入未完成；请按 taskId 独立核对，不重放创建。')
  if (step === 'verifiedModules') {
    const actual = rows(results.verifiedModules).filter(module => module.type === 'risk-module')
    if (context.action === 'module-close' ? actual.length !== 0 : actual.length !== 1) fail('风险模块启停状态未在项目模块列表中独立保存。')
    if (context.action === 'module-open' && context.moduleId && !same(actual[0].id, context.moduleId)) fail('重新启用风险模块未保留原有模块。')
    return
  }
  if (step === 'verifiedList') {
    if (rows(results.verifiedList).some(row => same(row.id, input.riskId))) fail('删除后风险仍在独立模块列表中。')
    return
  }
  if (step === 'verifiedRisk') {
    const actual = asObject(results.verifiedRisk), created = asObject(results.created)
    if (!same(actual.id, created.id ?? input.riskId) || !same(actual.kanbanChildId, context.moduleId)) fail('风险详情读回的 ID 或模块归属不一致。')
    if (expected.removedProgressId) {
      if (rows(actual.progressList).some(progress => same(progress.id, expected.removedProgressId)) || same(asObject(actual.currentProgress).id, expected.removedProgressId)) fail('进展删除后仍存在于风险详情或当前进展。')
    } else if (expected.riskId) {
      const progress = rows(actual.progressList).find(row => same(row.id, asObject(results.createdProgress).id))
      if (!progress) fail('新进展未在风险完整进展列表中出现。')
      compare(progress ?? fail('新风险进展不存在。'), { note: expected.note, status: expected.status })
    } else compare(actual, expected)
  } else if (step === 'verifiedCurrent') {
    const current = asObject(results.verifiedCurrent), detail = asObject(results.verifiedRisk)
    if (expected.removedProgressId ? same(current.id, expected.removedProgressId) : !same(current.id, asObject(results.createdProgress).id)) fail('风险当前进展与写入结果不一致。')
    if (Object.keys(current).length && (!same(current.riskId, input.riskId) || !same(current.id, asObject(detail.currentProgress).id))) fail('独立当前进展与风险详情不一致。')
  }
}
export function describeProjectRisk(input: JsonObject, results: JsonObject) {
  const context = asObject(results.riskContext)
  const modules = rows(results.verifiedModules ?? results.modules).filter(module => module.type === 'risk-module').map(module => ({ id: id(module.id), name: module.name, permissions: module.editControl }))
  const normalize = (value: unknown) => { const row = asObject(value); return { ...row, ...Object.fromEntries(['id', 'kanbanChildId', 'kanbanCardId', 'creatorId', 'principalId', 'riskId'].filter(key => row[key] != null).map(key => [key, id(row[key])])) } }
  return { projectId: input.projectId, modules,
    ...(results.matrix != null && { matrix: results.matrix }),
    ...(results.directory != null && { availablePrincipals: companyDirectoryUsers(results.directory).map(member => ({ id: id(member.id), showName: member.showName })) }),
    ...(results.items != null && { risks: rows(results.items).map(normalize), pagination: { max: input.max ?? 200, lastId: input.lastId ?? null, nextLastId: rows(results.items).length ? id(rows(results.items).at(-1)!.id) : null, complete: rows(results.items).length < Number(input.max ?? 200) } }),
    ...((results.verifiedRisk != null || results.before != null) && { risk: normalize(results.verifiedRisk ?? results.before) }),
    ...(results.progressItems != null && { progress: rows(results.progressItems).map(normalize), max: input.max ?? 200, lastId: input.lastId ?? null }),
    ...(results.actions != null && { actions: results.actions }),
    ...(results.templates != null && { templates: results.templates, taskPermissions: results.cardPermissions }),
    ...((results.tasks != null || results.verifiedTasks != null) && { tasks: rows(results.verifiedTasks ?? results.tasks), taskPagination: { max: input.max ?? 200, offset: input.offset ?? 0, nextOffset: rows(results.verifiedTasks ?? results.tasks).length === Number(input.max ?? 200) ? Number(input.offset ?? 0)+Number(input.max ?? 200) : null } }),
    ...(results.verifiedTask != null && { task: results.verifiedTask }),
    ...(results.verifiedAbsent != null && { removedRiskId: input.riskId, absentFromIndependentDetail: true }),
    ...(results.createdProgress != null && { progressId: id(asObject(results.createdProgress).id) }),
    ...(results.verifiedCurrent != null && { currentProgress: results.verifiedCurrent }),
    action: context.action, verified: !!(results.verifiedModules || results.verifiedRisk || results.verifiedList || results.verifiedAbsent || results.verifiedTask) }
}
