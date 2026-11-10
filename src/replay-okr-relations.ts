import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { replayRelationContext } from './replay.js'
import type { Session } from './session.js'

const fail = (message: string, code = 'BUSINESS_ASSERTION_FAILED'): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return fail('目标关联缺少有效且精度安全的资源 ID。', 'CONTEXT_MISSING')
}
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('目标关联列表不完整。', 'CONTEXT_MISSING')
const key = (row: JsonObject) => String(row.okrType) + ':' + id(row.okrId) + ':' + String(row.isKr)
type Relation = JsonObject & { parentObjectiveId?: string }
function relations(value: unknown): Relation[] {
  const seen = new Set<string>(), ids = new Set<string>(), output: Relation[] = []
  const add = (row: JsonObject, kr: boolean, parent?: string) => {
    if (!['objective', 'keyResult'].includes(String(row.okrType)) || row.isKr !== kr || seen.has(key(row))) fail('关联目标类型、层级或唯一键无效。', 'CONTEXT_MISSING')
    seen.add(key(row))
    if (typeof row.isDirectRelate !== 'boolean') fail('缺少实际/虚拟父目标标识。', 'CONTEXT_MISSING')
    if (!row.isDirectRelate) {
      if (kr || row.id != null) fail('虚拟父目标不能作为可修改关联。', 'CONTEXT_MISSING')
      return
    }
    const relationId = id(row.id)
    if (ids.has(relationId)) fail('重复的复盘关联 ID。', 'CONTEXT_MISSING')
    ids.add(relationId)
    const fieldIds = new Set<string>()
    for (const field of rows(row.fieldList)) { const value = id(field.id); if (fieldIds.has(value)) fail('重复的复盘目标字段 ID。', 'CONTEXT_MISSING'); fieldIds.add(value) }
    output.push({ ...row, ...(parent && { parentObjectiveId: parent }) })
  }
  for (const root of rows(value)) {
    if (root.okrType !== 'objective') fail('目标树的根必须为目标。', 'CONTEXT_MISSING')
    add(root, false)
    for (const child of root.krList == null ? [] : rows(root.krList)) add(child, true, id(root.okrId))
  }
  return output
}
function selected(input: JsonObject, results: JsonObject) {
  return relations(results.before).find(row => id(row.id) === input.relationId) ?? fail('关联 ID 不属于当前复盘组件，虚拟父节点不可操作。', 'INVALID_INPUT')
}
function sourceObjective(value: unknown, wanted: unknown) {
  const source = asObject(value)
  if (id(source.id) !== id(wanted) || asObject(source.editControl).view !== true) fail('源目标不可见或 HTTP 详情与请求不一致。', 'FORBIDDEN')
  return source
}
function sourceFor(row: Relation, source: JsonObject) {
  if (row.okrType === 'objective' && id(source.id) === id(row.okrId)) return source
  const result = rows(source.krList).find(item => id(item.id) === id(row.okrId) && item.krType === (row.okrType === 'keyResult' ? 'normal' : 'subObjective'))
  if (!result || result.isPrivate === true || typeof result.name !== 'string') return fail('关联的 KR 不属于实际源目标或当前不可见。', 'FORBIDDEN')
  return result
}
function context(input: JsonObject, results: JsonObject, session: Session | null, writable: boolean) {
  const original = replayRelationContext(input, results, session, writable, 'importObjective')
  const current = results.preflight === undefined ? original : replayRelationContext(input, { ...results, report: results.preflight }, session, writable, 'importObjective')
  if (current.componentId !== original.componentId || current.report.status !== original.report.status || !isDeepStrictEqual(current.component, original.component)) fail('复盘状态或目标组件定义已变化。', 'CONTEXT_CONFLICT')
  for (const row of relations(results.before ?? [])) for (const field of rows(row.fieldList)) if (!rows(current.component.importObjectiveFieldList).some(definition => id(definition.id) === id(field.id) && definition.type === field.type)) fail('目标快照字段不属于实际实例组件。', 'CONTEXT_CONFLICT')
  return current
}
const remember = (results: JsonObject, value: JsonObject) => { results.relationExpected = value }
export function prepareReplayOkrRelations(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const writable = !['replay-okr-relations-list', 'replay-okr-relations-preflight-list', 'replay-okr-relations-readback', 'replay-okr-relations-source', 'replay-okr-relations-retained-source'].includes(kind)
  const current = context(input, results, session, writable)
  results.prepared = { resources: { replayId: id(current.report.id), replayComponentId: current.componentId, ...(input.relationId != null && { relationId: input.relationId }) } }
  if (kind === 'replay-okr-relations-list' || kind === 'replay-okr-relations-preflight-list') return { query: { id: current.componentId } }
  const before = relations(results.before)
  if (kind === 'replay-okr-relations-source' || kind === 'replay-okr-relations-retained-source') {
    const row = input.relationId == null ? null : selected(input, results)
    return { query: { id: row ? row.okrType === 'objective' ? row.okrId : row.parentObjectiveId : input.objectiveId } }
  }
  if (kind === 'replay-okr-relations-readback') return { query: { id: current.componentId } }
  if (!isDeepStrictEqual(results.before, results.preflightRelations)) fail('复盘目标关联在操作前已变化，停止写入。', 'CONTEXT_CONFLICT')
  if (kind === 'replay-okr-relations-link') {
    const source = sourceObjective(results.source, input.objectiveId)
    let target = source, type = 'objective', isKr = false
    if (input.resultId != null) {
      const result = rows(source.krList).find(row => id(row.id) === input.resultId)
      if (!result || !['normal', 'subObjective'].includes(String(result.krType)) || result.isPrivate === true) return fail('resultId 必须是当前目标实际可见的普通 KR 或目标型 KR。', 'INVALID_INPUT')
      target = result; type = result.krType === 'normal' ? 'keyResult' : 'objective'; isKr = true
    }
    const added = { okrId: id(target.id), okrType: type, isKr }
    if (before.some(row => key(row) === key(added))) fail('目标已经关联，不能重复导入。', 'INVALID_INPUT')
    if (!isDeepStrictEqual(results.source, results.sourcePreflight)) fail('源目标已变化，请重新读取。', 'CONTEXT_CONFLICT')
    remember(results, { action: 'link', ...added, name: target.name })
    const period = Object.fromEntries(['year', 'month', 'week', 'day'].filter(key => current.report[key] != null).map(key => [key, current.report[key]]))
    // POST reconciles the COMPLETE selection, including KR rows below virtual parents.
    return { body: { replayCollectId: id(current.collection.id), replayCollectTemplateComponentId: input.componentId, ...period, okrList: [...before.map(row => ({ okrId: id(row.okrId), okrType: row.okrType, isKr: row.isKr })), added] } }
  }
  if (kind === 'replay-okr-relations-unlink') {
    const row = selected(input, results)
    sourceFor(row, sourceObjective(results.source, row.okrType === 'objective' ? row.okrId : row.parentObjectiveId))
    remember(results, { action: 'unlink', relationId: id(row.id) })
    return { query: { id: id(row.id) } }
  }
  if (kind === 'replay-okr-relations-text') {
    const row = selected(input, results), field = rows(row.fieldList).find(field => id(field.id) === input.fieldId && field.type === 'text')
    if (!field || field.openFlag !== true) fail('只能设置当前真实目标关联中已启用的文本字段。', 'INVALID_INPUT')
    remember(results, { action: 'text', relationId: id(row.id), fieldId: input.fieldId, text: input.text })
    return field!.text === input.text ? null : { body: { replayOkrId: id(row.id), replayFieldId: input.fieldId, text: input.text } }
  }
  if (kind === 'replay-okr-relations-progress') {
    const row = selected(input, results), source = sourceObjective(results.source, row.okrType === 'objective' ? row.okrId : row.parentObjectiveId), target = sourceFor(row, source), controls = asObject(target.editControl)
    if (!rows(row.fieldList).some(field => field.type === 'progress' && field.openFlag === true)) fail('此组件未启用进度字段，不能通过隐藏字段修改源目标。', 'FORBIDDEN')
    if (!isDeepStrictEqual(results.source, results.sourcePreflight)) fail('源目标进度或权限已变化。', 'CONTEXT_CONFLICT')
    if (row.okrType === 'objective' ? controls.edit !== true && controls.advance !== true : controls.advance !== true) fail('没有源目标或 KR 的进度权限。', 'FORBIDDEN')
    if (target.isSyncIndicator === true || (row.okrType === 'keyResult' ? target.progressType !== 'def' : target.allowManualUpdateProgress !== true || ['fromDS', 'fromIndicator'].includes(String(target.progressType)))) fail('源进度由其他业务同步或不允许手动更新；不能静默切换。', 'INVALID_INPUT')
    const start = target.progressStart, end = target.progressTarget
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start === end) fail('源目标缺少有效且不同的起始值与目标值。', 'CONTEXT_MISSING')
    const value = Number(start) + (Number(end) - Number(start)) * Number(input.percent) / 100
    remember(results, { action: 'progress', relationId: id(row.id), current: value, percent: input.percent })
    return { body: { replayOkrId: id(row.id), progressCurrent: value, ...(row.okrType === 'objective' && { progressType: 'manual' }) } }
  }
  if (kind === 'replay-okr-relations-refresh') {
    const trees = rows(results.before), sources = rows(results.sourceRoots)
    if (trees.length !== sources.length) fail('源目标读取不完整。', 'CONTEXT_MISSING')
    for (let i = 0; i < trees.length; i++) { const source = sourceObjective(sources[i], trees[i]!.okrId); for (const row of before.filter(row => row.parentObjectiveId === id(trees[i]!.okrId) || row.isKr === false && id(row.okrId) === id(trees[i]!.okrId))) sourceFor(row, source) }
    remember(results, { action: 'refresh' })
    return before.length ? { query: { id: current.componentId } } : null
  }
  return fail('未知复盘目标关联适配。', 'INVALID_CONTRACT')
}
export function describeReplayOkrRelations(input: JsonObject, results: JsonObject, session: Session | null) {
  const current = context(input, results, session, false), before = relations(results.before), after = relations(results.verified ?? results.before), wanted = asObject(results.relationExpected)
  const changed = after.find(row => id(row.id) === wanted.relationId)
  const oldById = (row: Relation) => before.find(old => id(old.id) === id(row.id))
  const plain = (row: Relation) => { const { krList, editControl, ...value } = row; return value }
  if (wanted.action === 'link') {
    const added = after.filter(row => !oldById(row))
    const actual = added.filter(row => key(row) === key(wanted))
    if (actual.length === 1) results.prepared = { ...asObject(results.prepared), resources: { ...asObject(asObject(results.prepared).resources), relationId: id(actual[0]!.id) } }
    if (added.length !== 1 || key(added[0]!) !== key(wanted) || added[0]!.name !== wanted.name || after.length !== before.length + 1) fail('目标导入未独立读回唯一关联；不要重放。')
    results.prepared = { ...asObject(results.prepared), resources: { ...asObject(asObject(results.prepared).resources), relationId: id(added[0]!.id) } }
  }
  if (wanted.action === 'unlink') {
    if (changed || after.length !== before.length - 1) fail('目标解除关联未独立读回。')
    const row = selected(input, results)
    sourceFor(row, sourceObjective(results.retainedSource, row.okrType === 'objective' ? row.okrId : row.parentObjectiveId))
  }
  if (['text', 'refresh', 'progress'].includes(String(wanted.action)) && (before.length !== after.length || after.some(row => !oldById(row) || key(row) !== key(oldById(row)!)))) fail('目标操作改变了关联集合。')
  for (const row of after) {
    const old = oldById(row)
    if (!old) continue
    if (['link', 'unlink'].includes(String(wanted.action)) && !isDeepStrictEqual(plain(row), plain(old))) fail('关联操作覆盖了未修改的目标快照或文本。')
    if (wanted.action === 'text') {
      const expected = id(old.id) === wanted.relationId ? { ...old, fieldList: rows(old.fieldList).map(field => id(field.id) === wanted.fieldId ? { ...field, text: wanted.text } : field) } : old
      if (!isDeepStrictEqual(plain(row), plain(expected))) fail('复盘文本未持久化或其他快照被覆盖。')
    }
    if (['refresh', 'progress'].includes(String(wanted.action))) for (const field of rows(old.fieldList).filter(field => field.type === 'text')) if (!isDeepStrictEqual(rows(row.fieldList).find(value => id(value.id) === id(field.id)), field)) fail('快照更新覆盖了复盘文本。')
  }
  if (wanted.action === 'refresh') {
    const roots = rows(results.before), sources = rows(results.sourceRoots)
    for (const row of after) {
      const index = roots.findIndex(root => id(root.okrId) === (row.parentObjectiveId ?? id(row.okrId))), source = sourceFor(row, sources[index]!)
      if (row.name !== source.name || rows(row.fieldList).some(field => field.type === 'progress' && Number(field.progress) !== Math.round(Number(source.progress)))) fail('刷新后的目标快照与独立源 HTTP 读取不一致。')
    }
  }
  if (wanted.action === 'progress') {
    const row = selected(input, results), source = sourceFor(row, sourceObjective(results.retainedSource, row.okrType === 'objective' ? row.okrId : row.parentObjectiveId))
    if (typeof source.progressCurrent !== 'number' || Math.abs(source.progressCurrent - Number(wanted.current)) > 1e-8 || !changed || rows(changed.fieldList).some(field => field.type === 'progress' && Number(field.progress) !== Math.round(Number(source.progress)))) fail('源目标进度及复盘快照未分别持久化。')
  }
  return { replayId: id(current.report.id), replayComponentId: current.componentId, templateComponentId: input.componentId, fields: current.component.importObjectiveFieldList, tree: results.verified ?? results.before, relations: after,
    ...(typeof wanted.action === 'string' && { action: wanted.action }), sourcePolicy: 'text changes replay only; refresh persists snapshots; progress changes actual source OKR; unlink preserves source; no atomic CAS' }
}
