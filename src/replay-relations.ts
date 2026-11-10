import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { replayRelationContext } from './replay.js'
import type { Session } from './session.js'

const fail = (message: string, code = 'BUSINESS_ASSERTION_FAILED'): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown) => {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return fail('复盘关联缺少有效的业务 ID。', 'CONTEXT_MISSING')
}
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('复盘关联未返回完整列表。', 'CONTEXT_MISSING')
function snapshots(value: unknown) {
  const seen = new Set<string>(), tasks = new Set<string>()
  return rows(value).map(row => {
    const key = id(row.id)
    if (seen.has(key) || typeof row.taskId !== 'string' || !row.taskId || tasks.has(row.taskId)) return fail('导入任务关系 ID 或源任务重复/缺失。', 'CONTEXT_MISSING')
    seen.add(key); tasks.add(row.taskId)
    const fields = new Set<string>()
    for (const field of rows(row.fieldList)) {
      const key = id(field.id)
      if (fields.has(key)) fail('导入任务包含重复字段。', 'CONTEXT_MISSING')
      fields.add(key)
    }
    return row
  })
}
function target(input: JsonObject, results: JsonObject) {
  return snapshots(results.before).find(row => id(row.id) === input.relationId) ?? fail('关联 ID 不属于本复盘的所选组件。', 'INVALID_INPUT')
}
function expected(results: JsonObject, value: JsonObject) { results.relationExpected = value }
function componentFields(component: JsonObject, values: JsonObject[]) {
  const definitions = rows(component.importTaskFieldList)
  for (const row of values) for (const field of rows(row.fieldList)) if (!definitions.some(definition => id(definition.id) === id(field.id) && definition.type === field.type)) fail('快照字段不属于当前实例组件定义。', 'CONTEXT_CONFLICT')
}
export function prepareReplayRelations(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const writable = !['replay-relations-list', 'replay-relations-readback', 'replay-relations-preflight-list', 'replay-relations-retained-task'].includes(kind)
  const original = replayRelationContext(input, results, session, writable)
  const context = results.preflight === undefined ? original : replayRelationContext(input, { ...results, report: results.preflight }, session, writable)
  if (results.preflight !== undefined && (context.componentId !== original.componentId || context.report.status !== original.report.status || !isDeepStrictEqual(context.component, original.component))) return fail('复盘状态或组件定义已变化；请重新读取上下文。', 'CONTEXT_CONFLICT')
  if (writable && !isDeepStrictEqual(snapshots(results.preflightTasks), snapshots(results.before))) return fail('复盘导入关系在操作前已变化；停止写入。', 'CONTEXT_CONFLICT')
  results.prepared = { resources: { replayId: String(context.report.id), replayComponentId: context.componentId } }
  if (kind === 'replay-relations-list' || kind === 'replay-relations-preflight-list') return { query: { id: context.componentId } }
  const before = snapshots(results.before)
  componentFields(context.component, before)
  if (kind === 'replay-relations-retained-task') return { query: { id: target(input, results).taskId, module: 'common', siteId: 'common' } }
  if (kind === 'replay-relations-link') {
    const task = asObject(results.task)
    if (task.id !== input.taskId || task.isDisplay === false) return fail('选中的源任务不可见或详情不一致。', 'FORBIDDEN')
    if (before.some(row => row.taskId === input.taskId)) return fail('此任务已导入当前组件；请读取现有关联，不能重复创建。', 'INVALID_INPUT')
    expected(results, { action: 'link', taskId: input.taskId, taskName: task.name })
    const period = Object.fromEntries(['year', 'month', 'week', 'day'].filter(key => context.report[key] != null).map(key => [key, context.report[key]]))
    return { body: { replayCollectId: String(context.collection.id), replayCollectTemplateComponentId: input.componentId, ...period, taskList: [input.taskId] } }
  }
  if (kind === 'replay-relations-unlink') {
    const selected = target(input, results)
    expected(results, { action: 'unlink', relationId: id(selected.id), taskId: selected.taskId })
    return { query: { id: id(selected.id) } }
  }
  if (kind === 'replay-relations-text') {
    const selected = target(input, results), field = rows(selected.fieldList).find(field => id(field.id) === input.fieldId)
    if (!field || field.type !== 'text') return fail('只能修改当前导入关系中真实的文本字段。', 'INVALID_INPUT')
    expected(results, { action: 'text', relationId: id(selected.id), fieldId: input.fieldId, text: input.text })
    if (field.text === input.text) return null
    return { body: { replayTaskId: id(selected.id), replayFieldId: input.fieldId, text: input.text } }
  }
  if (kind === 'replay-relations-refresh') {
    const source = rows(results.sourceTasks)
    if (source.length !== before.length || source.some((task, index) => task.id !== before[index]!.taskId || task.isDisplay === false)) return fail('源任务读取不完整或权限变化，停止刷新快照。', 'FORBIDDEN')
    expected(results, { action: 'refresh' })
    return before.length ? { query: { id: context.componentId } } : null
  }
  if (kind === 'replay-relations-readback') {
    const wanted = asObject(results.relationExpected)
    if (wanted.action === 'link') {
      const added = snapshots(results.changed).find(row => row.taskId === wanted.taskId)
      if (added) results.prepared = { resources: { replayId: String(context.report.id), replayComponentId: context.componentId, relationId: id(added.id), taskId: String(added.taskId) } }
    }
    return { query: { id: context.componentId } }
  }
  return fail('未知复盘关联步骤。', 'INVALID_CONTRACT')
}
export function describeReplayRelations(input: JsonObject, results: JsonObject, session: Session | null) {
  const context = replayRelationContext(input, results, session, false), before = snapshots(results.before), after = snapshots(results.verified ?? results.before), wanted = asObject(results.relationExpected)
  componentFields(context.component, before); componentFields(context.component, after)
  const preserved = (row: JsonObject) => after.find(item => id(item.id) === id(row.id))
  if (wanted.action === 'link') {
    const added = after.filter(row => !before.some(old => id(old.id) === id(row.id)))
    if (added.length !== 1 || added[0]!.taskId !== wanted.taskId || added[0]!.name !== wanted.taskName || after.length !== before.length + 1 || before.some(row => !isDeepStrictEqual(preserved(row), row))) fail('任务导入结果或无关快照未独立读回一致。')
  }
  if (wanted.action === 'unlink') {
    if (after.length !== before.length - 1 || after.some(row => id(row.id) === wanted.relationId) || before.filter(row => id(row.id) !== wanted.relationId).some(row => !isDeepStrictEqual(preserved(row), row))) fail('关联删除结果或无关关系未独立读回一致。')
    const task = asObject(results.retainedTask)
    if (task.id !== wanted.taskId || task.isDisplay === false) fail('解除关联后未能独立核对底层任务仍存在。')
  }
  if (wanted.action === 'text') {
    const selected = after.find(row => id(row.id) === wanted.relationId)
    if (!selected || after.length !== before.length || rows(selected.fieldList).find(field => id(field.id) === wanted.fieldId)?.text !== wanted.text) fail('文本字段未独立持久化。')
    for (const old of before) {
      const current = preserved(old)
      if (id(old.id) !== wanted.relationId) { if (!isDeepStrictEqual(current, old)) fail('文本更新改动了无关导入任务。'); continue }
      const expected = { ...old, fieldList: rows(old.fieldList).map(field => id(field.id) === wanted.fieldId ? { ...field, text: wanted.text } : field) }
      if (!isDeepStrictEqual(current, expected)) fail('文本更新改动了其他字段或快照。')
    }
  }
  if (wanted.action === 'refresh') {
    const source = rows(results.sourceTasks)
    if (before.length !== after.length || before.some(row => !preserved(row) || preserved(row)!.taskId !== row.taskId)) fail('刷新快照改变了关联集合。')
    for (const row of before) {
      const current = preserved(row)!, task = source.find(task => task.id === row.taskId)
      if (!task || current.name !== task.name) fail('快照名称未与独立 Task HTTP 读取结果一致。')
      for (const field of rows(row.fieldList).filter(field => field.type === 'text')) if (!isDeepStrictEqual(rows(current.fieldList).find(item => id(item.id) === id(field.id)), field)) fail('刷新快照覆盖了复盘文本字段。')
    }
  }
  return { replayId: String(context.report.id), collectionId: String(context.collection.id), templateComponentId: input.componentId, replayComponentId: context.componentId,
    fields: context.component.importTaskFieldList, tasks: after, snapshotPolicy: 'HTTP refresh changes this component snapshots; unlink preserves source tasks', ...(typeof wanted.action === 'string' && { action: wanted.action }) }
}
