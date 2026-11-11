import { isDeepStrictEqual } from 'node:util'
import { validateNewReplayCollection } from './replay-collection-config.js'
import { asObject, RsqError, type JsonObject } from './core.js'
import type { Session } from './session.js'
import { fingerprint } from './fingerprint.js'
import { replayTemplateComponent, replayComponentFieldTypes } from './replay-template-fields.js'
import { docDelta } from './editor-delta.js'

const fail = (message: string, code = 'CONTEXT_CONFLICT'): never => { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'PERMISSION_DENIED' ? 4 : 5) }
const id = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return String(value)
  return fail('复盘上下文缺少有效的日事清 ID。', 'CONTEXT_MISSING')
}
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('复盘服务未返回完整列表。', 'CONTEXT_MISSING')
const text = (value: unknown): string => typeof value === 'string' ? value : fail('复盘内容缺少字符串。', 'CONTEXT_MISSING')
const sameId = (a: unknown, b: unknown) => id(a) === id(b)
const expect = (results: JsonObject, value: JsonObject) => { results.replayExpected = { ...asObject(results.replayExpected), ...value } }
const types = new Set(['question', 'file', 'importObjective', 'importTask', 'createTask'])
const componentKeys = ['id', 'name', 'type', 'isRequired', 'answer', 'placeholder', 'isOpenInsertTask', 'isOpenInsertFlowStep', 'importObjectiveFieldList', 'importTaskFieldList']

export function replayTextDelta(value: string) {
  const normalized = value.replace(/\r\n?/g, '\n')
  return JSON.stringify({ ops: [{ insert: normalized.endsWith('\n') ? normalized : normalized + '\n' }] })
}
export function replayQuestionDelta(input: JsonObject) {
  const hasText = Object.hasOwn(input, 'text'), hasContent = Object.hasOwn(input, 'content')
  if (hasText === hasContent) fail('text 和 content 必须且只能提供一个；清空正文请使用 text: ""。', 'INVALID_INPUT')
  if (hasText) {
    if (typeof input.text !== 'string') fail('text 必须是字符串。', 'INVALID_INPUT')
    return replayTextDelta(input.text as string)
  }
  if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) fail('content 必须是完整的 {ops:[{insert,attributes?}]} 编辑器正文对象。', 'INVALID_INPUT')
  return JSON.stringify(docDelta(input.content))
}
// The server uses Monday/one-day week numbering, not ISO Monday/four-day weeks.
// UTC arithmetic here treats the supplied date as a calendar date in GMT+8; it
// never converts it through the host's local timezone.
export function replayPeriod(type: unknown, value: unknown): JsonObject {
  if (!['day', 'week', 'month'].includes(String(type))) fail('主题复盘由 OKR 复盘入口处理，不能套用日/周/月的复盘集周期。', 'INVALID_INPUT')
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date 必须为 YYYY-MM-DD 日历日期。', 'INVALID_INPUT')
  const date = new Date(value + 'T00:00:00Z'), stamp = date.getTime()
  if (!Number.isFinite(stamp) || date.toISOString().slice(0, 10) !== value || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9998) fail('date 不是支持范围内的有效日历日期。', 'INVALID_INPUT')
  let year = date.getUTCFullYear()
  if (type === 'day') return { year, month: date.getUTCMonth() + 1, day: date.getUTCDate() }
  if (type === 'month') return { year, month: date.getUTCMonth() + 1 }
  const firstMonday = (year: number) => { const first = new Date(Date.UTC(year, 0, 1)); return first.getTime() - ((first.getUTCDay() + 6) % 7) * 86400000 }
  if (stamp >= firstMonday(year + 1)) year++
  return { year, week: Math.floor((stamp - firstMonday(year)) / (7 * 86400000)) + 1 }
}
function canonicalComponent(value: JsonObject): JsonObject {
  if (!types.has(String(value.type)) || !text(value.name).trim()) fail('模板含未知组件类型或空名称；停止更新以免丢失配置。', 'CONTEXT_MISSING')
  return Object.fromEntries(componentKeys.filter(key => value[key] != null).map(key => [key, key === 'id' ? id(value[key]) : key.endsWith('FieldList')
    ? rows(value[key]).map(field => Object.fromEntries(['id', 'name', 'type', 'isOpen'].filter(key => field[key] != null).map(key => [key, key === 'id' ? id(field[key]) : field[key]]))) : value[key]]))
}
function template(input: JsonObject, results: JsonObject): JsonObject & { componentList: JsonObject[] } {
  const value = asObject(results.template)
  if (!sameId(value.id, input.templateId)) fail('返回了其他复盘模板。')
  const components = rows(value.componentList), ids = components.map(c => id(c.id))
  if (new Set(ids).size !== ids.length) fail('复盘模板组件 ID 重复。', 'CONTEXT_MISSING')
  return { ...value, componentList: components.map(canonicalComponent) }
}
function collection(input: JsonObject, results: JsonObject) {
  const value = asObject(results.collection)
  if (!sameId(value.id, input.collectionId ?? asObject(results.report).replayCollectId)) fail('返回了其他复盘集。')
  if (!['day', 'week', 'month'].includes(String(value.type))) fail('此命令只适用于日、周、月复盘集；主题复盘需独立上下文。', 'INVALID_INPUT')
  return value
}
function report(input: JsonObject, results: JsonObject, actualRequired = true) {
  const value = asObject(results.report), collect = collection(input, results)
  if (!sameId(value.replayCollectId, collect.id) || value.type !== collect.type) fail('复盘与复盘集的归属或类型不一致。')
  if (input.replayId != null && !sameId(value.id, input.replayId)) fail('返回了其他复盘。')
  if (input.date != null) for (const [key, expected] of Object.entries(replayPeriod(collect.type, input.date))) if (value[key] !== expected) fail('复盘周期不一致；重新读取上下文。')
  if (actualRequired) id(value.id)
  rows(value.componentList)
  return value
}
function editable(value: JsonObject, session: Session | null) {
  if (!sameId(asObject(value.writer).id, session?.identity.userId) || asObject(value.editControl).edit !== true || !['uncommitted', 'uncommittedAfterRefused'].includes(String(value.status))) fail('当前用户不是可编辑的填写人，或复盘已提交；先读取状态与权限。', 'PERMISSION_DENIED')
}
function answerFilled(component: JsonObject) {
  const question = asObject(component.questionAnswer)
  if (question.answer === question.templateAnswer || typeof question.answer !== 'string') return false
  try {
    const delta = asObject(JSON.parse(question.answer)), ops = rows(delta.ops)
    return ops.some(op => typeof op.insert === 'string' ? op.insert.trim() !== '' && op.insert.trim() !== '[暂无内容]' : typeof op.insert === 'object' && op.insert !== null)
  } catch { return false }
}
function scorePayload(current: JsonObject, collect: JsonObject): JsonObject {
  const numericId = (value: unknown) => { const valueId = id(value), number = Number(valueId); if (!Number.isSafeInteger(number)) fail('当前 AI 服务只接受精确的 number ID；不能丢失长 ID 精度。', 'INVALID_INPUT'); return number }
  return { replayId: numericId(current.id), replayName: text(current.name), replayCollectId: numericId(collect.id), replayCollectName: text(collect.name),
    type: collect.type, writerId: numericId(asObject(current.writer).id),
    replayDetail: { ...current, replayCollectId: numericId(collect.id), replayCollectName: collect.name, collectData: collect },
    componentList: rows(current.componentList).map(component => ({ ...component, id: component.id == null ? null : numericId(component.id),
      ...(component.type === 'question' && { answer: asObject(component.questionAnswer).answer }),
      files: rows(component.fileList ?? []).map(file => ({ id: numericId(file.id), name: file.name })) })) }
}
export function replayIntelligenceEnabled(input: JsonObject, results: JsonObject) {
  const permissions = results[input.application === 'okr' ? 'okrPermissions' : 'companyPermissions']
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) fail('缺少当前应用的复盘权限；请先读取 replay permissions。', 'CONTEXT_MISSING')
  return asObject(results.intelligence).inWhitelist === true && asObject(permissions).replayIntelligence === true
}
export function replayScoreDigest(current: JsonObject, collect: JsonObject) {
  const payload = scorePayload(current, collect)
  // Only content sent to the scorer is bound here; permissions, read markers
  // and thumbs-up are mutable UI metadata rather than scored question content.
  return fingerprint({ replayId: payload.replayId, replayName: payload.replayName, replayCollectId: payload.replayCollectId, replayCollectName: payload.replayCollectName,
    type: payload.type, writerId: payload.writerId, componentList: rows(payload.componentList).map(component => ({ id: component.id, type: component.type, name: component.name,
      ...(component.type === 'question' && { answer: component.answer }), files: component.files })) })
}
export function prepareReplay(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  if (kind === 'replay-company-permissions') return input.application === 'okr' ? null : {}
  if (kind === 'replay-okr-permissions') return input.application === 'okr' ? {} : null
  if (kind === 'replay-created-template') return { query: { id: id(asObject(results.changed).id) } }
  if (kind === 'replay-created-collection') return { query: { id: id(asObject(results.changed).id) } }
  if (kind.startsWith('replay-template-')) {
    const before = template(input, results), components = before.componentList as JsonObject[]
    if (input.expectedDefinition !== undefined && input.expectedDefinition !== fingerprint(before)) fail('模板定义已变化；请重新读取组件上下文再修改。')
    let name = before.name, updated = components
    if (kind === 'replay-template-remove') {
      const all = rows(results.collectionDetails)
      if (all.length !== rows(results.collections).length) fail('模板依赖列表不完整，不能删除。', 'CONTEXT_MISSING')
      const references = all.filter(collect => sameId(asObject(collect.template).id, input.templateId)).map(collect => id(collect.id))
      if (references.length) throw new RsqError('RESOURCE_IN_USE', '复盘模板仍被复盘集使用；先处理依赖。', 5, { collectionIds: references })
      expect(results, { removedTemplate: id(before.id) }); return { query: { id: id(before.id) } }
    }
    if (kind === 'replay-template-rename') name = input.name
    else if (kind === 'replay-template-question-add') {
      const added = { type: 'question', name: input.name, isRequired: input.required ?? false, answer: replayTextDelta(String(input.text ?? '')),
        placeholder: input.placeholder ?? '', isOpenInsertTask: input.insertTasks ?? false, isOpenInsertFlowStep: input.insertFlowSteps ?? false }
      updated = [...components, added]; expect(results, { added: true, oldComponentIds: components.map(c => id(c.id)) })
    } else if (kind === 'replay-template-component-add') {
      updated = [...components, replayTemplateComponent(input)]
      expect(results, { added: true, oldComponentIds: components.map(c => id(c.id)) })
    } else if (kind === 'replay-template-component-configure') {
      const target = components.find(component => sameId(component.id, input.componentId)) ?? fail('组件不属于当前模板。', 'INVALID_INPUT')
      const changed = replayTemplateComponent(asObject(input.patch), target)
      updated = components.map(component => component === target ? changed : component)
    } else if (kind === 'replay-template-question-update' || kind === 'replay-template-component-remove') {
      const target = components.find(component => sameId(component.id, input.componentId)) ?? fail('组件不属于已选中的复盘模板。', 'INVALID_INPUT')
      if (kind.endsWith('remove')) updated = components.filter(component => component !== target)
      else {
        if (target.type !== 'question') fail('此命令只能修改问题组件；附件和导入组件使用各自配置。', 'INVALID_INPUT')
        const patch = asObject(input.patch), mapping: Record<string, string> = { name: 'name', required: 'isRequired', placeholder: 'placeholder', insertTasks: 'isOpenInsertTask', insertFlowSteps: 'isOpenInsertFlowStep' }
        const changed = { ...target }
        for (const [key, field] of Object.entries(mapping)) if (Object.hasOwn(patch, key)) changed[field] = patch[key]
        if (Object.hasOwn(patch, 'text')) changed.answer = replayTextDelta(text(patch.text))
        updated = components.map(component => component === target ? changed : component)
      }
    } else if (kind === 'replay-template-reorder') {
      const ids = (input.componentIds as unknown[]).map(id)
      if (ids.length !== components.length || new Set(ids).size !== ids.length || ids.some(selected => !components.some(c => id(c.id) === selected))) fail('componentIds 必须恰好包含当前所有组件，不能遗漏或引入其他模板的组件。', 'INVALID_INPUT')
      updated = ids.map(selected => components.find(c => id(c.id) === selected)!)
    } else if (kind !== 'replay-template-rename') fail('未知复盘模板适配。', 'INVALID_CONTRACT')
    expect(results, { template: { id: id(before.id), name, componentList: updated } })
    if (name === before.name && isDeepStrictEqual(updated, components)) return null
    return { body: { id: id(before.id), name, componentList: updated } }
  }
  if (kind === 'replay-collection-create') {
    const selected = asObject(results.template)
    if (!sameId(selected.id, input.templateId)) fail('模板上下文与目标不同。')
    const userId = id(session?.identity.userId)
    const defaults = { writeWeekDayList: [1, 2, 3, 4, 5, 6, 7], isSkipHoliday: false, isOpenWriteEarliestTime: false,
      isOpenCommitDeadline: false, isOpenCommitNotifyTime: false, isOpenWorkStatus: false, isAllowAddViewer: false,
      isAllowShare: false, isAllowAfterCommitRevert: true, isAllowAfterRefuseCommit: true, isAllowSupplement: true }
    // The UI supplies all three times even when their switches are off. The
    // service's toReplayCollectDO dereferences each value unconditionally.
    const settings = asObject(input.settings), endDate = input.type === 'week' ? '5' : input.type === 'month' ? 'last' : '1'
    const times = { writeEarliestTime: { dateType: 'now', date: '1', time: '09:00' }, commitDeadline: { dateType: 'now', date: endDate, time: '18:30' }, commitNotifyTime: { dateType: 'now', date: endDate, time: '18:00' } }
    const body = { ...defaults, ...asObject(input.settings), name: input.name, type: input.type, templateId: id(input.templateId),
      ...Object.fromEntries(Object.entries(times).map(([key, value]) => [key, { ...value, ...asObject(settings[key]) }])),
      ruleList: input.rules ?? [{ writerUserIdList: [userId], writerDeptIdList: [], writerWhiterUserIdList: [], auditorType: 'user', auditorId: userId, auditorIdList: [userId], auditType: 'all', viewerUserIdList: [], viewerDeptIdList: [] }] }
    validateNewReplayCollection(body, results.directory, settings)
    expect(results, { collection: { name: input.name, type: input.type, templateId: id(input.templateId) } })
    return { body }
  }
  if (kind === 'replay-report-collection') return { query: { id: id(asObject(results.report).replayCollectId) } }
  const collect = collection(input, results)
  if (kind === 'replay-period-context') return { query: { replayCollectId: id(collect.id), ...replayPeriod(collect.type, input.date) } }
  if (kind === 'replay-collection-remove') {
    expect(results, { removedCollection: id(collect.id) }); return { query: { id: id(collect.id) } }
  }
  if (kind === 'replay-collection-rename') {
    const body: JsonObject = { id: id(collect.id), name: input.name, templateId: id(asObject(collect.template).id),
      ...(collect.writeWeekDays != null && { writeWeekDayList: collect.writeWeekDays }) }
    for (const [key, value] of Object.entries(collect)) if (key.startsWith('is') && typeof value === 'boolean') body[key] = value
    for (const key of ['writeEarliestTime', 'commitDeadline', 'commitNotifyTime']) if (collect[key] != null) {
      const time = asObject(collect[key]); body[key] = { dateType: time.dateType, ...(time.date != null && { date: String(time.date) }), time: time.time }
    }
    expect(results, { collection: { ...collect, name: input.name }, preserveCollection: true })
    if (collect.name === input.name) return null
    return { body }
  }
  if (kind === 'replay-changed-readback') return { query: { id: id(asObject(results.changed).id) } }
  const current = report(input, results, kind !== 'replay-report-create')
  if (kind === 'replay-report-create') {
    editable(current, session)
    if (current.id != null) fail('该填写人和周期已有复盘；请读取或填写已有复盘，不重复创建。')
    expect(results, { reportCreated: true, period: replayPeriod(collect.type, input.date), collectionId: id(collect.id), writerId: id(session?.identity.userId) })
    return { body: { replayCollectId: id(collect.id), ...replayPeriod(collect.type, input.date) } }
  }
  if (kind === 'replay-question-set') {
    editable(current, session)
    const component = rows(current.componentList).find(component => sameId(component.replayCollectTemplateComponentId, input.componentId)) ?? fail('目标模板组件不属于此复盘的问题组件。', 'INVALID_INPUT')
    if (component.type !== 'question') fail('目标模板组件不属于此复盘的问题组件。', 'INVALID_INPUT')
    const answer = replayQuestionDelta(input)
    expect(results, { question: { componentId: id(input.componentId), answer }, reportId: id(current.id), unchangedQuestions: rows(current.componentList).filter(c => c.type === 'question' && c !== component).map(c => ({ componentId: id(c.replayCollectTemplateComponentId), answer: asObject(c.questionAnswer).answer })) })
    if (asObject(component.questionAnswer).answer === answer) return null
    return { body: { replayCollectId: id(collect.id), ...replayPeriod(collect.type, input.date), replayCollectTemplateComponentId: id(input.componentId), answer } }
  }
  if (kind === 'replay-like-set') {
    expect(results, { liked: input.liked, reportId: id(current.id) })
    return current.isThumbsUp === input.liked ? null : { body: { id: id(current.id), isThumbsUp: input.liked } }
  }
  if (kind === 'replay-score-evaluate') {
    editable(current, session)
    if (!replayIntelligenceEnabled(input, results)) fail('当前应用的复盘智能评分未开放或当前用户无权使用。', 'PERMISSION_DENIED')
    expect(results, { scoreDigest: replayScoreDigest(current, collect), reportId: id(current.id) })
    return { body: scorePayload(current, collect) }
  }
  if (kind === 'replay-score-context') {
    if (!replayIntelligenceEnabled(input, results)) return null
    const receipt = asObject(input.scoreReceipt)
    if (!receipt.scoreId || receipt.contextDigest !== replayScoreDigest(current, collect)) fail('提交前请先执行 replay report score evaluate，阅读评分后传入其 receipt；内容变化后需重新评分。', 'AI_SCORE_CONTEXT_REQUIRED')
    return { query: { scoreId: receipt.scoreId } }
  }
  const actions: Record<string, { status: string; from: string[]; recordType: number }> = {
    'replay-submit': { status: 'committed', from: ['uncommitted', 'uncommittedAfterRefused'], recordType: 1 },
    'replay-withdraw': { status: 'uncommitted', from: ['committed'], recordType: 2 },
    'replay-approve': { status: 'audited', from: ['committed'], recordType: 3 },
    'replay-reject': { status: 'auditRefused', from: ['committed'], recordType: 4 },
    'replay-reopen': { status: 'uncommittedAfterRefused', from: ['auditRefused'], recordType: 5 },
  }
  const action = actions[kind]
  if (!action) fail('未知复盘上下文适配。', 'INVALID_CONTRACT')
  if (!action.from.includes(String(current.status))) fail('当前复盘状态不允许此操作；先读取最新状态。')
  const audit = kind === 'replay-approve' || kind === 'replay-reject'
  const auditors = Array.isArray(current.auditorList) ? rows(current.auditorList) : current.auditor ? [asObject(current.auditor)] : []
  if (audit ? !auditors.some(auditor => sameId(auditor.id, session?.identity.userId)) : !sameId(asObject(current.writer).id, session?.identity.userId)) fail('当前账号不属于该操作的填写人或审核人。', 'PERMISSION_DENIED')
  if (kind === 'replay-withdraw' && collect.isAllowAfterCommitRevert !== true || kind === 'replay-reopen' && collect.isAllowAfterRefuseCommit !== true) fail('复盘集未允许该状态恢复操作。', 'PERMISSION_DENIED')
  if (kind === 'replay-submit') {
    editable(current, session)
    if (replayIntelligenceEnabled(input, results)) {
      const receipt = asObject(input.scoreReceipt), score = asObject(results.score)
      if (receipt.contextDigest !== replayScoreDigest(current, collect) || receipt.scoreId !== score.scoreId || score.status !== 'success' || !sameId(score.replayId, current.id)) fail('AI 评分与当前复盘内容不匹配；请重新评分并核对结果。', 'AI_SCORE_CONTEXT_REQUIRED')
    }
    const components = rows(current.componentList)
    if (!components.length || !auditors.length || components.some(c => c.isRequired === true && (c.type === 'question' ? !answerFilled(c) : c.type === 'file' ? !rows(c.fileList).length : false))) fail('复盘缺少内容、审核人或必填组件；先填写并读回。', 'INVALID_INPUT')
    if (current.status === 'uncommitted' && collect.isOpenCommitDeadline === true && collect.isAllowSupplement !== true && typeof current.commitDeadline === 'string') {
      const deadline = Date.parse(current.commitDeadline.replace(' ', 'T') + ':00+08:00')
      if (!Number.isFinite(deadline) || deadline < Date.now()) fail('当前复盘已超过截止时间，或截止时间格式无法确认。', 'INVALID_INPUT')
    }
  }
  expect(results, { reportId: id(current.id), status: action.status, recordType: action.recordType, beforeRecordIds: rows(results.records).map(record => id(record.id)) })
  return { body: { id: id(current.id), status: action.status } }
}
export function verifyReplay(input: JsonObject, results: JsonObject, stepId: string) {
  if (stepId === 'template') { template(input, results); return }
  if (stepId === 'collection') { collection(input, results); return }
  if (stepId === 'report') { report(input, results, input.replayId != null); return }
  const wanted = asObject(results.replayExpected), actual = results[stepId]
  const assert = (condition: boolean, message: string) => { if (!condition) fail(message, 'BUSINESS_ASSERTION_FAILED') }
  if (wanted.removedTemplate || wanted.removedCollection) {
    const removed = wanted.removedTemplate ?? wanted.removedCollection
    assert(!rows(actual).some(item => id(item.id) === removed), '删除后目标仍在完整列表内。'); return
  }
  if (stepId === 'verifiedRecords') {
    const previous = wanted.beforeRecordIds as string[]
    assert(rows(actual).some(record => !previous.includes(id(record.id)) && record.type === wanted.recordType), '审核/提交操作缺少新增的独立操作记录。'); return
  }
  if (stepId === 'score') {
    const score = asObject(actual)
    assert(sameId(score.replayId, asObject(results.report).id) && score.status === 'success' && typeof score.scoreId === 'string', '评分记录与当前复盘不一致。'); return
  }
  const value = asObject(actual)
  if (wanted.template) {
    const expected = asObject(wanted.template), components = rows(value.componentList).map(canonicalComponent), expectedComponents = rows(expected.componentList)
    assert(sameId(value.id, expected.id) && value.name === expected.name && components.length === expectedComponents.length, '模板名字或组件数量未持久化。')
    for (let i = 0; i < expectedComponents.length; i++) {
      const target = { ...components[i] }, expected = expectedComponents[i]
      if (expected.id == null) { assert(!(wanted.oldComponentIds as string[]).includes(id(target.id)), '未发现唯一新增的模板组件。'); wanted.addedComponentId = id(target.id); delete target.id }
      for (const fieldKey of ['importTaskFieldList', 'importObjectiveFieldList']) if (Array.isArray(expected[fieldKey])) {
        const wantedFields = rows(expected[fieldKey]), actualFields = rows(target[fieldKey]), oldIds = rows(asObject(results.template).componentList).flatMap(component => rows(component[fieldKey] ?? []).map(field => id(field.id)))
        assert(wantedFields.length === actualFields.length, '导入字段数量未持久化。')
        const seen = new Set<string>()
        target[fieldKey] = actualFields.map((field, index) => {
          const actualId = id(field.id)
          assert(!seen.has(actualId), '导入字段 ID 重复。'); seen.add(actualId)
          if (wantedFields[index]!.id != null) return field
          assert(!oldIds.includes(actualId), '新增字段复用了原有字段 ID。')
          const { id: ignored, ...rest } = field
          return rest
        })
      }
      assert(isDeepStrictEqual(target, expected), '模板组件配置、原有字段或顺序读回不一致。')
    }
    return
  }
  if (wanted.collection) {
    const expected = asObject(wanted.collection)
    if (wanted.preserveCollection) assert(isDeepStrictEqual(value, expected), '复盘集改名改变了应保留的规则或时间设置。')
    else assert(value.name === expected.name && value.type === expected.type && sameId(asObject(value.template).id, expected.templateId), '复盘集创建结果与选中模板不一致。')
    return
  }
  assert(sameId(value.id, wanted.reportId ?? asObject(results.changed).id), '复盘读回 ID 不一致。')
  if (wanted.reportCreated) {
    assert(sameId(value.replayCollectId, wanted.collectionId) && sameId(asObject(value.writer).id, wanted.writerId) && value.status === 'uncommitted', '新复盘的集、填写人或草稿状态不正确。')
    for (const [key, expected] of Object.entries(asObject(wanted.period))) assert(value[key] === expected, '新复盘的周期不正确。')
  }
  if (wanted.question) {
    for (const question of [asObject(wanted.question), ...rows(wanted.unchangedQuestions)]) {
      const target = rows(value.componentList).find(c => sameId(c.replayCollectTemplateComponentId, question.componentId))
      assert(!!target && asObject(target!.questionAnswer).answer === question.answer, '问题答案未持久化，或改动了其他问题。')
    }
  }
  if (Object.hasOwn(wanted, 'liked')) assert(value.isThumbsUp === wanted.liked, '本人的点赞状态未持久化。')
  if (wanted.status) assert(wanted.status === 'audited' ? ['committed', 'audited'].includes(String(value.status)) : value.status === wanted.status, '复盘状态读回未符合当前审核阶段。')
}
export function describeReplayTemplate(results: JsonObject) {
  const componentId = asObject(results.replayExpected).addedComponentId
  return { template: results.verified, ...(componentId != null && { componentId }) }
}
export function describeReplayTemplateComponents(input: JsonObject, results: JsonObject) {
  const current = template(input, results)
  return { template: current, definitionDigest: fingerprint(current), fieldTypes: replayComponentFieldTypes, replacementPolicy: 'configure.fields replaces only the selected component field list; keep existing IDs to preserve values; no atomic CAS' }
}
export function replayRelationContext(input: JsonObject, results: JsonObject, session: Session | null, writable: boolean, type = 'importTask') {
  const current = report(input, results), collect = collection(input, results)
  if (writable) editable(current, session)
  const component = rows(current.componentList).find(component => sameId(component.replayCollectTemplateComponentId, input.componentId)) ?? fail('所选模板组件不属于此复盘。', 'INVALID_INPUT')
  if (component.type !== type) fail('所选组件类型与复盘关联业务不一致。', 'INVALID_INPUT')
  return { report: current, collection: collect, component, componentId: id(component.id) }
}
export function describeReplayScore(results: JsonObject) {
  return { score: results.score, receipt: { scoreId: asObject(results.score).scoreId, contextDigest: asObject(results.replayExpected).scoreDigest },
    next: '阅读评分与建议后，将 receipt 作为 replay report submit 的 scoreReceipt 输入；内容变化需重新评分。' }
}
export function describeReplayFeatures(input: JsonObject, results: JsonObject) {
  return { application: input.application ?? 'rishiqing', permissions: results[input.application === 'okr' ? 'okrPermissions' : 'companyPermissions'],
    inWhitelist: asObject(results.intelligence).inWhitelist === true, scoreBeforeSubmit: replayIntelligenceEnabled(input, results) }
}
