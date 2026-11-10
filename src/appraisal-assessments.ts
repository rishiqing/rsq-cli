import { resolveOwnSignature } from './signature.js'
import Big from 'big.js'
import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'

const Decimal = Big()
Decimal.DP = 20
Decimal.RM = Decimal.roundHalfUp
type Route = [string, string, string]
export const appraisalQueues = { 'content-confirm': 'contentConfirm', 'content-acknowledgement': 'contentAcknowledgement', 'result-entry': 'resultValue', 'collaborator-invites': 'invitingColleagues', score: 'score', 'result-confirm': 'resultConfirm', 'result-acknowledgement': 'resultAcknowledgement', interview: 'interview' } as const
export type AppraisalAssessmentAction = 'assessment-cycles' | 'assessment-personal' | 'assessment-managed' | `assessment-queue-${keyof typeof appraisalQueues}` |
  'assessment-inspect' | 'assessment-launch' | 'assessment-remove' | 'assessment-start' | 'assessment-entry-save' | 'assessment-entry-submit' |
  'assessment-score-save' | 'assessment-score-submit' | 'assessment-confirm' | 'assessment-result-confirm' | 'assessment-content-ack' | 'assessment-result-ack' |
  'assessment-reviews' | 'assessment-review-set' | 'assessment-calibrate'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
function check(value: unknown, message: string): asserts value { if (!value) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const forbidden = (message: string): never => { throw new RsqError('RESOURCE_FORBIDDEN', message, 4) }
const key = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('考核资源 ID 必须为精确正整数。')
const numeric = (value: unknown) => { const id = key(value); if (!Number.isSafeInteger(Number(id))) invalid('绩效 JSON 数字 ID 超出可无损表示范围。'); return Number(id) }
const list = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : invalid('考核响应不是有界列表。')
const decimal = (value: unknown) => { if (typeof value !== 'string' || value.length > 30 || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) invalid('分值须使用十进制字符串。'); return new Decimal(value as string) }
const equalDecimal = (a: unknown, b: unknown) => { try { return new Decimal(String(a)).eq(new Decimal(String(b))) } catch { return a === b } }
const formatEntry = (value: string) => {
  let parsed: Big
  try { parsed = new Decimal(value.trim().replace(/^\+/, '')) } catch { return value }
  if (parsed.e > 1995) invalid('结果值展开后超出 2000 字符边界，请缩小数值或指数。')
  const formatted = parsed.toFixed(2)
  if (formatted.length > 2000) invalid('结果值展开后超出 2000 字符边界。')
  return formatted
}
const ids = (value: unknown) => list(value).map(row => key(row.id))
function date(value: unknown): string {
  const time = typeof value === 'string' ? Date.parse(value + 'T00:00:00Z') : NaN
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid('日期须为有效 YYYY-MM-DD，不依赖本机时区。')
  return (value as string).replaceAll('-', '.')
}
export function appraisalAssessmentSteps(action: AppraisalAssessmentAction): Route[] {
  const get = (step: string, path: string): Route => [step, 'GET', '/task/performance' + path]
  const change = (method: string, path: string): Route => ['changed', method, '/task/performance' + path]
  const graph = (verified = false) => [get(verified ? 'verifiedAssessment' : 'assessment', '/appraisal'), get(verified ? 'verifiedContent' : 'content', '/v2/content'), get(verified ? 'verifiedFlow' : 'flow', '/content/flowInfo')]
  if (action === 'assessment-cycles') return [get('cycles', '/appraisal/periodList')]
  if (action === 'assessment-personal') return [get('assessments', '/appraisals/my')]
  if (action === 'assessment-managed') return [get('assessments', '/appraisals/all')]
  if (action.startsWith('assessment-queue-')) return [get('assessments', '/appraisals/' + appraisalQueues[action.slice('assessment-queue-'.length) as keyof typeof appraisalQueues])]
  if (action === 'assessment-launch') return [get('templates', '/templates/my'), get('template', '/template'), get('templateMembers', '/appraisal/getUser'), get('members', '/member/select'),
    get('beforeAssessments', '/appraisals/all'), ['validation', 'POST', '/task/performance/appraisal/batchHas'], change('POST', '/appraisal/batch'), get('verifiedAssessments', '/appraisals/all'), ...graph(true)]
  if (action === 'assessment-inspect') return [...graph(), get('fields', '/preference/dimension/dictionaries'), get('reviews', '/appraisal/reviews'), get('rule', '/appraisal/rule')]
  if (action === 'assessment-reviews') return [...graph(), get('reviews', '/appraisal/reviews')]
  if (action === 'assessment-review-set') return [...graph(), get('reviews', '/appraisal/reviews'), change('PUT', '/appraisal/reviews'), get('verifiedReviews', '/appraisal/reviews')]
  if (action === 'assessment-remove') return [...graph(), get('members', '/member/select'), change('DELETE', '/appraisal'), get('verifiedAssessments', '/appraisals/all')]
  if (action === 'assessment-start') return [...graph(), get('members', '/member/select'), change('POST', '/appraisal/startScore'), ...graph(true)]
  if (action.startsWith('assessment-entry-')) return [...graph(), change('PUT', '/appraisal/entry'), ...graph(true)]
  if (action.startsWith('assessment-score-')) return [...graph(), get('reviews', '/appraisal/reviews'), change('PUT', '/appraisal/score'), ...graph(true)]
  if (action === 'assessment-calibrate') return [...graph(), get('rule', '/appraisal/rule'), change('PUT', '/resultConfirm/calibration'), ...graph(true)]
  const routes = { 'assessment-confirm': '/appraisal/confirmSubmit', 'assessment-result-confirm': '/appraisal/resultConfirmSubmit', 'assessment-content-ack': '/appraisal/contentAcknowledgement', 'assessment-result-ack': '/appraisal/resultAcknowledgement' }
  if (Object.hasOwn(routes, action)) return [...graph(), ...(action.endsWith('-ack') ? [['signature', 'GET', '/task/file/signature/getFront'], ['signatureFile', 'GET', '/task/v1/folder/file']] as Route[] : []), change('POST', routes[action as keyof typeof routes]), ...graph(true)]
  throw new RsqError('INVALID_CONTRACT', '未定义的绩效考核操作。', 6)
}
type AssessmentGraph = { assessment: JsonObject; content: JsonObject; flow: JsonObject }
const indicators = (content: JsonObject): JsonObject[] => list(content.dimensions).flatMap(dimension => list(dimension.indicators).map(indicator => ({ ...indicator, dimensionId: key(dimension.id), dimensionType: dimension.type })))
const pendingNodes = (flow: JsonObject, stages: string[]) => list(flow.flowInfo).filter(node => node.status === 'processing' && stages.includes(String(node.stage)))
function task(flow: JsonObject, userId: string, stages: string[], status: string | null) {
  const matches = pendingNodes(flow, stages).filter(node => list(node.assignee).some(user => key(user.id) === userId && (status == null || user.status === status)))
  if (matches.length !== 1) forbidden('当前本人没有唯一的对应阶段待办；请重新查看 appraisal assessments inspect。')
  return matches[0]
}
function consumed(before: JsonObject, after: JsonObject, userId: string) {
  const fields = ['stage', 'scoreNodeId', 'resultConfirmId', 'inviteNodeId']
  check(!list(after.flowInfo).some(node => fields.every(field => (node[field] ?? null) === (before[field] ?? null)) && node.status === 'processing' && list(node.assignee).some(user => key(user.id) === userId && !['rated', 'entered', 'invited', 'skipped', 'done', 'confirmed'].includes(String(user.status)))), '提交后本人原阶段待办仍待处理，不能认定提交成功。')
}
export function appraisalEntryPlan(before: AssessmentGraph, userId: string, supplied: unknown, temporary: boolean) {
  const current = task(before.flow, userId, ['resultEntry', 'resultEntryTwo'], 'tbe')
  const editable = indicators(before.content).filter(indicator => indicator.dimensionType === 'quantitative' && indicator.canEntry === true && key(asObject(indicator.entryUser).id) === userId)
  const seen = new Set<string>(), values: JsonObject[] = []
  for (const item of list(supplied)) {
    const id = key(item.indicatorId)
    if (seen.has(id) || !editable.some(row => key(row.id) === id) || typeof item.value !== 'string' || item.value.length > 2000) invalid('填报指标必须是本考核本人当前可录入的定量指标，且不能重复。')
    const indicator = editable.find(row => key(row.id) === id)!, text = String(item.value).trim(), number = /^[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text)
    const places = number ? Math.max(0, (number[1] ?? number[2] ?? '').length - Number(number[3] ?? 0)) : 0
    if (indicator.isAutoScore === true && (!number || places > 2)) invalid('自动评分的结果值须为至多两位有效小数的数值；支持 UI 的符号及科学计数。')
    formatEntry(String(item.value)) // Guard expanded numeric size before a write.
    seen.add(id); values.push({ indicatorId: numeric(id), value: item.value })
  }
  if (!values.length || !temporary && (editable.length !== seen.size || values.some(row => String(row.value).trim() === ''))) invalid('正式提交须包含本人全部当前可录入指标的有效结果值；暂存可显式清空。')
  return { current, values }
}
export function appraisalEntrySnapshot(graph: AssessmentGraph) {
  return { appraisalId: key(graph.assessment.id), indicators: indicators(graph.content).map(row => ({ id: key(row.id), dimensionType: row.dimensionType, canEntry: row.canEntry ?? null, entryUserId: asObject(row.entryUser).id == null ? null : key(asObject(row.entryUser).id), isAutoScore: row.isAutoScore ?? null, resultValue: row.resultValue ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
    phases: pendingNodes(graph.flow, ['resultEntry', 'resultEntryTwo']).map(node => ({ stage: node.stage, status: node.status, assignee: list(node.assignee).map(user => ({ id: key(user.id), status: user.status })).sort((a, b) => a.id.localeCompare(b.id)) })) }
}
function management(role: JsonObject) {
  const authority = asObject(role.authorities)
  if (authority.performanceAppraisalAllDataManage !== true && authority.performanceAppraisalDeptDataManage !== true) forbidden('当前绩效角色没有考核管理权限。')
}
function query(input: JsonObject): JsonObject {
  const out: JsonObject = { offset: input.offset ?? 0, max: input.max ?? 20, type: input.type ?? 'all', stage: input.stage ?? 'all' }
  for (const field of ['period', 'isHistory', 'sortKey', 'sortOrder', 'levelName']) if (Object.hasOwn(input, field)) out[field] = input[field]
  for (const [field, target] of [['objectIds', 'userIds'], ['departmentIds', 'deptIds'], ['ruleIds', 'ruleId']]) if (Array.isArray(input[field]) && (input[field] as unknown[]).length) out[target] = (input[field] as unknown[]).map(key).join(',')
  for (const field of ['startDate', 'endDate']) if (input[field] != null) out[field] = date(input[field])
  return out
}
/** Same decimal arithmetic and order as the current UI, including add/sub. */
export function appraisalTotal(content: JsonObject, values: Map<string, Big>): string | null {
  const regular = list(content.dimensions).filter(dimension => !['add', 'sub'].includes(String(dimension.type))), all = indicators(content)
  if (!all.some(indicator => values.has(key(indicator.id)))) return null
  const zero = () => new Decimal('0'), sum = (values: Big[]) => values.reduce((a, b) => a.plus(b), zero())
  const weight = (value: unknown) => value == null || value === '-' || value === '' ? zero() : decimal(String(value))
  const ratio = (value: Big, part: Big, total: Big) => total.eq('0') ? zero() : value.times(part).div(total)
  const dimensionTotal = sum(regular.map(dimension => weight(dimension.weight))), indicatorTotal = sum(regular.flatMap(dimension => list(dimension.indicators).map(indicator => weight(indicator.weight))))
  const score = sum(regular.map(dimension => {
    const inDimension = list(dimension.indicators), total = content.isDimensionsWeight === true ? sum(inDimension.map(indicator => weight(indicator.weight))) : indicatorTotal
    const subtotal = sum(inDimension.map(indicator => content.calculation === 'sum' ? values.get(key(indicator.id)) ?? zero() : ratio(values.get(key(indicator.id)) ?? zero(), weight(indicator.weight), total)))
    return content.isDimensionsWeight === true ? ratio(subtotal, weight(dimension.weight), dimensionTotal) : subtotal
  }))
  return all.filter(indicator => ['add', 'sub'].includes(String(indicator.dimensionType))).reduce((total, indicator) => indicator.dimensionType === 'sub' ? total.minus(values.get(key(indicator.id)) ?? zero()) : total.plus(values.get(key(indicator.id)) ?? zero()), score).toFixed(2)
}

export async function runAppraisalAssessment(action: AppraisalAssessmentAction, input: JsonObject, context: {
  call: (step: string, args?: JsonObject, envelope?: boolean) => Promise<unknown>; role: JsonObject; userId: string; resources: Record<string, unknown>;
  templateDetail: (value: unknown, target: string, listing: JsonObject) => JsonObject;
  expectedEntrySnapshot?: unknown;
}) {
  const { call, role, userId, resources } = context, authority = asObject(role.authorities)
  const graph = async (target: string, verified = false): Promise<AssessmentGraph> => {
    const step = (name: string) => verified ? 'verified' + name[0].toUpperCase() + name.slice(1) : name
    const assessment = asObject(await call(step('assessment'), { query: { id: target } })); check(key(assessment.id) === target, '返回了其他考核。')
    const content = asObject(await call(step('content'), { query: { appraisalId: target } })), flow = asObject(await call(step('flow'), { query: { appraisalId: target } }))
    key(content.id); const all = indicators(content); check(new Set(all.map(indicator => key(indicator.id))).size === all.length, '考核指标存在重复关联。')
    list(flow.flowInfo); return { assessment, content, flow }
  }
  const managed = async (assessment: JsonObject) => {
    management(role)
    const members = list(await call('members', { query: { type: 'my' } }))
    if (!members.some(member => key(member.id) === key(asObject(assessment.object).id))) forbidden('考核对象不在当前实际绩效管理成员范围内。')
  }
  if (action === 'assessment-cycles') {
    const scope = input.scope ?? 'personal'; if (scope === 'managed') management(role); else if (authority.performanceAppraisalMyData !== true) forbidden('当前绩效角色不能查看本人绩效。')
    return { cycles: list(await call('cycles', { query: { type: scope === 'managed' ? 'all' : 'my', ...(input.stage != null && { stage: input.stage }), ...(input.objectId != null && { objectId: key(input.objectId) }) } })), scope }
  }
  if (action === 'assessment-personal' || action === 'assessment-managed' || action.startsWith('assessment-queue-')) {
    if (action === 'assessment-managed') management(role)
    if (action === 'assessment-personal' && authority.performanceAppraisalMyData !== true) forbidden('当前绩效角色不能查看本人绩效。')
    const response = asObject(await call('assessments', { query: query(input) }, true))
    return { assessments: list(response.data), statistics: response.ext ?? null, pagination: { offset: input.offset ?? 0, max: input.max ?? 20, complete: false }, ...(action.startsWith('assessment-queue-') && { queue: action.slice('assessment-queue-'.length), isHistory: input.isHistory ?? false, historySemantics: '按当前 UI 与服务端语义传递；false 为待处理，true 为已处理。' }) }
  }
  if (action === 'assessment-launch') {
    if (authority.performanceAppraisalSubmit !== true) forbidden('当前绩效角色不能发起考核。')
    management(role) // HTTP verification uses the same scoped management list.
    const target = key(input.templateId), templates = list(await call('templates', { query: { isAll: true, isOfficialTemplate: false } })), listing = templates.find(template => key(template.id) === target)
    if (!listing || listing.appraisalSubmit !== true) forbidden('模板不在本公司可发起列表中。')
    const template = context.templateDetail(await call('template', { query: { id: target } }), target, listing!)
    const selectable = new Set([...ids(template.objects), ...ids(await call('templateMembers', { query: { id: target } }))]), managedIds = new Set(ids(await call('members', { query: { type: 'my' } })))
    const objectIds = (input.objectIds as unknown[]).map(key)
    if (!objectIds.length || new Set(objectIds).size !== objectIds.length || objectIds.some(id => !selectable.has(id) || !managedIds.has(id))) invalid('发起对象必须同时来自本模板实际成员和当前可管理成员，不能重复。')
    const startDate = date(input.startDate), endDate = date(input.endDate), period = String(input.period)
    if (startDate > endDate || !period.trim() || period.length > 100) invalid('考核周期名称或日期范围无效。')
    const filter = { type: template.type, stage: 'all', period, userIds: objectIds.join(','), offset: 0, max: 100 }
    const existing = list(await call('beforeAssessments', { query: filter }))
    if (existing.length) throw new RsqError('ALREADY_EXISTS', '本周期已有考核；未再次发起。', 2, { appraisalIds: existing.map(row => key(row.id)) })
    const body = { type: template.type, period, startDate, endDate, appraisalList: [{ appraisalTempId: numeric(target), userIds: objectIds.join(',') }] }
    const validation = asObject(await call('validation', { body }))
    if (validation.errorMessage || validation.warnMessage) throw new RsqError('LAUNCH_CONTEXT_CONFLICT', '服务端发起校验未通过；没有提交批量发起。', 2, { error: validation.errorMessage, warning: validation.warnMessage })
    resources.period = period; resources.templateId = target; resources.expectedObjectIds = objectIds
    await call('changed', { body }); resources.asynchronousRequestAccepted = true
    const found = new Map<string, JsonObject>()
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = list(await call('verifiedAssessments', { query: filter }))
      check(current.length < 100 || objectIds.length === 100, '发起结果超过单页，不能假定对象和结果完整。')
      for (const row of current) {
        check(row.period === period && objectIds.includes(key(asObject(row.object).id)), '发起读回包含不匹配的周期或对象。')
        if (found.has(key(asObject(row.object).id))) check(key(found.get(key(asObject(row.object).id))!.id) === key(row.id), '同一对象出现多个考核。')
        found.set(key(asObject(row.object).id), row)
      }
      resources.appraisalIds = [...found.values()].map(row => key(row.id))
      if (found.size === objectIds.length) break
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (found.size !== objectIds.length) throw new RsqError('ASYNC_RESULT_PENDING', '批量发起已受理，但 HTTP 中尚未找到全部实例；先按返回周期和对象查询，不要重放发起。', 5, { resources })
    const assessments = []
    for (const row of found.values()) {
      const actual = await graph(key(row.id), true), time = asObject(actual.assessment.time)
      check(time.period === period && time.startDate === startDate && time.endDate === endDate && actual.assessment.type === template.type && objectIds.includes(key(asObject(actual.assessment.object).id)), '实际考核的周期、日期或对象不符。')
      assessments.push(actual)
    }
    return { assessments, independentlyVerified: true, asynchronous: true, notificationsPossible: true }
  }
  const target = key(input.appraisalId); resources.appraisalId = target
  const before = await graph(target), all = indicators(before.content)
  if (action === 'assessment-inspect') return { ...before, fields: await call('fields', { query: { contentId: key(before.content.id), isLaunched: true, appraisalId: target } }), reviews: await call('reviews', { query: { appraisalId: target } }), rule: await call('rule', { query: { appraisalId: target } }),
    currentRaterColumns: list(before.content.raters ?? []).map((rater, index): JsonObject => ({ index, ...rater })).filter(rater => String(rater.id) === userId),
    nextCommands: ['appraisal assessments entry save', 'appraisal assessments entry submit', 'appraisal assessments score save', 'appraisal assessments score submit', 'appraisal assessments reviews list'] }
  if (action === 'assessment-reviews' || action === 'assessment-review-set') {
    const reviews = asObject(await call('reviews', { query: { appraisalId: target } }))
    if (action === 'assessment-reviews') return { appraisalId: target, reviews }
    task(before.flow, userId, ['scoring'], 'tbs')
    const review = list(reviews.reviewList).find(review => key(review.id) === key(input.reviewId))
    if (!review || review.canEdit !== true) forbidden('该总结不是本考核当前可编辑总结。')
    const content = asObject(input.content)
    if (!Array.isArray(content.ops) || content.ops.length > 20000 || JSON.stringify(content).length > 4 * 1024 * 1024) invalid('总结正文须为有界 Quill Delta。')
    await call('changed', { body: { reviewId: numeric(input.reviewId), content } })
    const after = asObject(await call('verifiedReviews', { query: { appraisalId: target } })), actual = list(after.reviewList).find(row => key(row.id) === key(input.reviewId))
    check(actual && isDeepStrictEqual(actual.reviewContent, content), '总结正文没有独立持久化。')
    return { appraisalId: target, review: actual, independentlyVerified: true }
  }
  if (action === 'assessment-remove') {
    await managed(before.assessment)
    const time = asObject(before.assessment.time)
    await call('changed', { query: { id: target } })
    for (let offset = 0; offset < 10000; offset += 100) {
      const after = list(await call('verifiedAssessments', { query: { offset, max: 100, type: before.assessment.type, stage: 'all', period: time.period, userIds: key(asObject(before.assessment.object).id) } }))
      check(!after.some(row => key(row.id) === target), '考核删除后仍在列表中。')
      if (after.length < 100) return { appraisalId: target, removed: true, independentlyVerified: true }
    }
    throw new RsqError('PAGINATION_LIMIT', '删除读回未完成全部分页。', 5)
  }
  if (action === 'assessment-start') {
    await managed(before.assessment)
    if (before.assessment.isStartScore !== false || !pendingNodes(before.flow, ['contentConfirm', 'contentAcknowledgement', 'unScore', 'inviteColleague', 'resultEntry']).length) invalid('当前考核没有可开启的等待评分阶段。')
    await call('changed', { body: { appraisalId: target } }); const after = await graph(target, true)
    check(after.assessment.isStartScore === true, '开始评分设置没有持久化。'); return { ...after, independentlyVerified: true }
  }
  if (action.startsWith('assessment-entry-')) {
    if (context.expectedEntrySnapshot != null && !isDeepStrictEqual(appraisalEntrySnapshot(before), context.expectedEntrySnapshot)) throw new RsqError('CONTEXT_CONFLICT', '批量预览后的考核结果值、可编辑指标或阶段已变化；未覆盖该考核。', 5)
    const temporary = action.endsWith('save'), { current, values } = appraisalEntryPlan(before, userId, input.values, temporary)
    await call('changed', { body: { isTemporary: temporary, values } }); const after = await graph(target, true), actual = indicators(after.content)
    for (const item of values) check(actual.find(row => key(row.id) === key(item.indicatorId))?.resultValue === formatEntry(String(item.value)), '填报值没有独立持久化。')
    if (temporary) task(after.flow, userId, [String(current.stage)], 'tbe'); else consumed(current, after.flow, userId)
    return { ...after, temporary, independentlyVerified: true }
  }
  if (action.startsWith('assessment-score-')) {
    const current = task(before.flow, userId, ['scoring'], 'tbs'), temporary = action.endsWith('save'), raters = list(before.content.raters)
    // With only automatic indicators, the current UI advances scoring so that
    // resultEntryTwo can supply the data. It does not manufacture zero scores.
    if (!temporary && list(input.scores ?? []).length === 0 && all.length && all.every(indicator => indicator.isAutoScore === true) && list(before.flow.flowInfo).some(node => node.stage === 'resultEntryTwo' && node.status === 'notStart')) {
      if (input.totalScore != null) invalid('全自动评分等待二次录入时不能手工设置总分。')
      await call('changed', { body: { appraisalId: numeric(target), isBeforeResultEntryTwo: true, scores: [], totalScore: null, isTemporary: false } })
      const after = await graph(target, true); consumed(current, after.flow, userId)
      check(list(after.flow.flowInfo).some(node => node.stage === 'resultEntryTwo' && ['processing', 'done'].includes(String(node.status))), '全自动评分未进入后续结果录入阶段。')
      return { ...after, awaitingAutomaticResultEntry: true, independentlyVerified: true }
    }
    const eligible = raters.map((row, index) => ({ row, index })).filter(({ row }) => String(row.id) === userId && row.status === 'undone' && list(row.scores).some(score => score.canEdit === true))
    const match = input.raterIndex == null ? eligible.length === 1 ? eligible[0] : undefined : eligible.find(candidate => candidate.index === input.raterIndex)
    if (!match) invalid('当前评分列不唯一或不可编辑；请从 inspect 返回的 currentRaterColumns 明确选择 raterIndex。')
    const rater = match!.row, actualScores = list(rater.scores), editable = actualScores.filter(score => score.canEdit === true), provided = list(input.scores ?? []), merged = new Map<string, JsonObject>(), values = new Map<string, Big>()
    for (const score of actualScores) { const indicatorId = key(score.indicatorId); check(all.some(row => key(row.id) === indicatorId), '评分列引用了本考核以外的指标。'); merged.set(indicatorId, { ...score }) }
    const seen = new Set<string>()
    for (const score of provided) {
      const indicatorId = key(score.indicatorId)
      if (seen.has(indicatorId) || !editable.some(row => key(row.indicatorId) === indicatorId)) invalid('评分指标须来自本人当前可编辑评分列，不能跨考核或重复。')
      const indicator = all.find(row => key(row.id) === indicatorId)!
      if (indicator.isAutoScore === true && Object.hasOwn(score, 'score')) invalid('自动评分指标不能通过手工评分覆盖。')
      const optionMode = asObject(before.assessment.scoreRule).scoreMode === 'option' && !['add', 'sub'].includes(String(indicator.dimensionType)) && indicator.isAutoScore !== true
      if (optionMode && Object.hasOwn(score, 'score') && !Object.hasOwn(score, 'scoreOptionId')) invalid('选项评分须显式使用本考核规则的 scoreOptionId；不能直接写选项分值。')
      if (!optionMode && score.scoreOptionId != null) invalid('此指标不是选项评分模式。')
      seen.add(indicatorId); merged.set(indicatorId, { ...merged.get(indicatorId), ...score })
    }
    const options = list(asObject(before.assessment.scoreRule).optionList ?? []), wire: JsonObject[] = []
    for (const indicator of all) {
      const indicatorId = key(indicator.id), score = merged.get(indicatorId)
      if (!score) continue
      const optionMode = asObject(before.assessment.scoreRule).scoreMode === 'option' && !['add', 'sub'].includes(String(indicator.dimensionType)) && indicator.isAutoScore !== true
      let value: Big | null = null
      if (optionMode && score.scoreOptionId != null) {
        const option = options.find(option => key(option.id) === key(score.scoreOptionId)); if (!option) invalid('评分选项必须来自本考核快照规则。'); value = decimal(String(option!.score))
      } else if (score.score != null && score.score !== '' && score.score !== '-') value = decimal(String(score.score))
      if (value) { if (value.lt('0') || indicator.scoreLimit !== '-' && value.gt(decimal(String(indicator.scoreLimit)))) invalid('指标分值超出当前实际评分上限。'); values.set(indicatorId, value) }
      if (score.canEdit !== true) continue
      if (!temporary && rater.isTotal !== true && !value) invalid('正式提交前必须填写全部本人可评分指标。')
      if (!temporary && rater.isExplanation === true && !String(score.scoreExplanation ?? '').trim() && !list(score.files ?? []).length) invalid('当前评分节点要求填写评分说明。')
      const item: JsonObject = { indicatorId: numeric(indicatorId), ...(score.scoreExplanation != null && { scoreExplanation: String(score.scoreExplanation) }) }
      if (value) { const number = Number(value.toString()); if (!Number.isFinite(number) || !new Decimal(String(number)).eq(value)) invalid('数值转换会丢失精度。'); item.score = number }
      if (optionMode && score.scoreOptionId != null) item.scoreOptionId = numeric(score.scoreOptionId)
      const changed = provided.find(row => key(row.indicatorId) === indicatorId)
      if (changed?.score === null) item.score = null
      if (changed?.scoreOptionId === null) item.scoreOptionId = null
      wire.push(item)
    }
    if (!wire.length || !provided.length && temporary) invalid('暂存须明确提供修改值；当前没有可评分指标。')
    let total = rater.isTotal === true ? input.totalScore == null ? rater.fullScore : decimal(input.totalScore).toFixed(2) : appraisalTotal(before.content, values)
    if (!temporary && rater.isTotal === true && (total == null || decimal(String(total)).eq('0'))) invalid('直接评定总分的节点必须提供非零总分。')
    if (!temporary) { const reviews = asObject(await call('reviews', { query: { appraisalId: target } })); if (list(reviews.reviewList).some(review => review.isRequired === true && review.reviewContent == null)) invalid('评分总结仍有必填内容；请先使用 reviews set。') }
    await call('changed', { body: { appraisalId: numeric(target), scores: wire, ...(total != null && { totalScore: String(total) }), isTemporary: temporary } })
    const after = await graph(target, true), actualRater = list(after.content.raters)[match!.index]
    check(actualRater && String(actualRater.id) === userId, '评分读回中的本人列不符。')
    for (const item of wire) {
      const actual = list(actualRater.scores).find(score => key(score.indicatorId) === key(item.indicatorId)); check(actual, '评分读回缺少指标。')
      if (item.score != null) check(equalDecimal(actual.score, new Decimal(String(item.score)).toFixed(2)), '指标评分没有独立持久化。')
      if (item.scoreExplanation != null) check(actual.scoreExplanation === item.scoreExplanation, '评分说明没有独立持久化。')
      if (item.scoreOptionId != null) check(String(actual.scoreOptionId) === String(item.scoreOptionId), '评分选项没有独立持久化。')
      const providedItem = provided.find(row => key(row.indicatorId) === key(item.indicatorId))
      if (providedItem?.score === null && item.score == null && actual.score != null && actual.score !== '-') throw new RsqError('PERSISTENCE_UNSUPPORTED', '当前服务未保存评分清空请求；原评分仍然存在，需要服务端修复后再清空。', 5, { indicatorId: String(item.indicatorId), field: 'score', actual: actual.score, retry: 'do-not-repeat-write' })
      if (providedItem?.scoreOptionId === null && actual.scoreOptionId != null) throw new RsqError('PERSISTENCE_UNSUPPORTED', '当前服务未保存评分选项清空请求；原选项仍然存在，需要服务端修复后再清空。', 5, { indicatorId: String(item.indicatorId), field: 'scoreOptionId', retry: 'do-not-repeat-write' })
    }
    if (temporary) task(after.flow, userId, ['scoring'], 'tbs'); else { consumed(current, after.flow, userId); if (total != null) check(equalDecimal(actualRater.fullScore, total), '本人总分没有独立持久化。') }
    return { ...after, temporary, calculatedTotal: total ?? null, independentlyVerified: true }
  }
  if (action === 'assessment-calibrate') {
    task(before.flow, userId, ['resultConfirm'], 'tbrc')
    if (before.assessment.isCanResultConfirm !== true || before.assessment.isResultCalibration !== true) forbidden('当前本人结果确认节点未授予校准权限。')
    const rule = asObject(await call('rule', { query: { appraisalId: target } })), values = asObject(input.calibration)
    const score = decimal(values.score), levels = list(rule.levels), level = levels.find(level => level.levelName === values.level)
    if (score.lt('0') || score.gt('99999.99') || !level) invalid('校准分值须在 0 到 99999.99 之间，等级须来自本考核的实际规则。')
    if (values.coefficient != null && rule.isOpenCoefficient !== true) invalid('本考核规则未开启绩效系数。')
    const coefficient = values.coefficient ?? level!.coefficient
    if (coefficient != null) decimal(String(coefficient))
    await call('changed', { body: { result: [{ id: numeric(target), calibrationScore: score.toFixed(2), calibrationLevel: values.level, ...(values.coefficient != null && { calibrationCoefficient: values.coefficient }) }] } })
    const after = await graph(target, true)
    check(equalDecimal(after.assessment.finalScore, score.toFixed(2)) && after.assessment.level === values.level, '校准后的得分或等级没有独立持久化。')
    if (rule.isOpenCoefficient === true && coefficient != null) check(equalDecimal(after.assessment.coefficient, coefficient), '校准绩效系数没有独立持久化。')
    task(after.flow, userId, ['resultConfirm'], 'tbrc')
    return { ...after, independentlyVerified: true, confirmationSubmitted: false }
  }
  const stages = { 'assessment-confirm': ['contentConfirm', 'tbc', 'isCanConfirm'], 'assessment-result-confirm': ['resultConfirm', 'tbrc', 'isCanResultConfirm'], 'assessment-content-ack': ['contentAcknowledgement', 'tbc', 'isContentSignature'], 'assessment-result-ack': ['resultAcknowledgement', 'tbc', 'isResultSignature'] }
  const stage = stages[action as keyof typeof stages]
  if (!stage) throw new RsqError('INVALID_CONTRACT', '没有对应的阶段操作。', 6)
  // The current acknowledgement UI checks the actual object and processing
  // stage, not legacy tbc/tbrc values supplied by the Activiti service.
  const current = task(before.flow, userId, [stage[0]], action.endsWith('-ack') ? null : stage[1])
  let signature: { fileId: string } | undefined
  if (action.endsWith('-ack')) {
    if (key(asObject(before.assessment.object).id) !== userId) forbidden('只有实际考核对象能确认本人的内容或结果。')
    const requested = input.useLastSignature === true || input.signatureFileId !== undefined, required = before.assessment[stage[2]] === true
    if (required && !requested) invalid('本阶段要求签字；先 signature upload/latest，再显式提供 signatureFileId 或 useLastSignature。')
    if (!required && requested) invalid('当前本人确认环节未启用签字；不能附加额外签名。')
    if (requested) { signature = await resolveOwnSignature(call, userId, 'performance', input.signatureFileId); resources.signatureFileId = signature.fileId }
  }
  else if (before.assessment[stage[2]] !== true) forbidden('当前详情未授予本阶段提交权限。')
  const body = action === 'assessment-result-confirm' ? { appraisalIds: target } : action.endsWith('-ack') ? { appraisalId: numeric(target) } : { appraisalId: target }
  await call('changed', { body: { ...body, ...(signature && { fileId: signature.fileId }) } }); const after = await graph(target, true); consumed(current, after.flow, userId)
  if (signature) check(list(after.flow.flowInfo).some(node => node.stage === stage[0] && asObject(node.fileVO).id != null && String(asObject(node.fileVO).id) === signature!.fileId), '本人确认后 HTTP 流程信息未包含本次签名文件，不能认定签字闭环。')
  return { ...after, ...(signature && { signature: { fileId: signature.fileId, businessUnit: 'performance' } }), independentlyVerified: true }
}
