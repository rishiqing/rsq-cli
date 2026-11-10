import { isDeepStrictEqual } from 'node:util'
import { asObject, request, parseJson, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'
import { appraisalAssessmentSteps, runAppraisalAssessment, type AppraisalAssessmentAction } from './appraisal-assessments.js'
import { appraisalReportSteps, runAppraisalReport, type AppraisalReportAction } from './appraisal-reports.js'
import { appraisalSalarySteps, runAppraisalSalary, type AppraisalSalaryAction } from './appraisal-salary.js'
import { appraisalEntryImportSteps, runAppraisalEntryImport, type AppraisalEntryImportAction } from './appraisal-entry-import.js'
import { appraisalOptionKeys, appraisalParticipantNode, appraisalNodeWeights, appraisalTemplateBody, verifyAppraisalParticipants, verifyAppraisalTemplateBody } from './appraisal-template.js'

export type AppraisalAction = 'context' | 'participants' | 'preferences' | 'preferences-set' | 'fields' | 'field-create' | 'field-set' | 'field-remove' | 'field-order' |
  'rules' | 'groups' | 'group-create' | 'group-rename' | 'group-remove' | 'templates' | 'template-inspect' | 'template-create' | 'template-configure' | 'template-copy' | 'template-move' | 'template-remove' |
  'contents' | 'content-inspect' | 'content-create' | 'content-replace' | 'content-remove' | AppraisalAssessmentAction | AppraisalReportAction | AppraisalSalaryAction | AppraisalEntryImportAction
type Route = [string, string, string]
const prefix = '/task/performance'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
function assert(value: unknown, message: string): asserts value { if (!value) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('绩效资源 ID 必须为精确的正整数字符串。')
const numberId = (value: unknown) => { const result = id(value); if (!Number.isSafeInteger(Number(result))) invalid('当前绩效服务的 JSON 数字 ID 超出安全精度。'); return Number(result) }
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : invalid('绩效服务未返回有界列表。')
const name = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : invalid('名称不能为空、不能含控制字符，最多 200 字符。')
const data = (value: unknown): unknown => { const result = asObject(value); assert(result.code === 200 && Object.hasOwn(result, 'data'), '绩效返回信封不完整。'); return result.data }
const sameIds = (a: unknown[], b: unknown[]) => isDeepStrictEqual(a.map(id).sort(), b.map(id).sort())
const manualTypes = ['quantitative', 'qualitative', 'add', 'sub']
const sortKeys = ['id', 'key', 'name', 'type', 'isAsFormulaField', 'isConfigurable']
const project = (row: JsonObject, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]))
const selected = (values: JsonObject[], target: unknown, description: string) => {
  const matches = values.filter(row => id(row.id) === id(target))
  if (matches.length !== 1) throw new RsqError('RESOURCE_FORBIDDEN', description + '不在当前公司实际可见列表中。', 4)
  return matches[0]
}
function templateDetail(value: unknown, target: string, listing: JsonObject): JsonObject {
  const detail = asObject(value)
  assert(id(listing.id) === target && typeof listing.name === 'string' && typeof listing.type === 'string', '模板列表未提供可核对的资源身份。')
  assert(detail.name === listing.name && detail.type === listing.type, '模板详情与当前公司列表中的名称或周期不符。')
  for (const key of ['group', 'rule']) if (listing[key] != null) assert(String(asObject(detail[key]).id) === String(asObject(listing[key]).id), '模板详情与列表中的关联不符：' + key)
  // The deployed converter can return a null id. The explicit HTTP query is
  // accepted only after matching an independently company-scoped list row.
  // A non-null mismatching server ID is always rejected.
  if (detail.id != null) assert(id(detail.id) === target, '考核模板 ID 不符。')
  return { ...detail, id: numberId(target) }
}
function normalizeContent(value: unknown): JsonObject {
  const content = asObject(value)
  return { ...content, dimensions: rows(content.dimensions).map(dimension => ({ ...dimension, indicators: rows(dimension.indicators).map(indicator => ({ ...indicator,
    customFieldMap: { ...asObject(indicator.customFieldMap), ...Object.fromEntries(Object.entries(indicator).filter(([key]) => /^custom_fieldTemplate_[1-9][0-9]*$/.test(key))) },
  })) })) }
}
function contentWire(value: JsonObject): JsonObject {
  return { ...value, dimensions: rows(value.dimensions).map(dimension => ({ ...dimension, indicators: rows(dimension.indicators).map(indicator => {
    const { customFieldMap, ...properties } = indicator
    return { ...properties, ...asObject(customFieldMap) }
  }) })) }
}
const decimalParts = (value: unknown) => {
  const text = String(value)
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text) || text.length > 200) invalid('评分规则及权重须为非负十进制数。')
  const [whole, fraction = ''] = text.split('.')
  return { units: BigInt(whole + fraction), digits: fraction.length, divisor: 10n ** BigInt(fraction.length) }
}
const decimalEqual = (a: unknown, b: unknown) => {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(String(a)) || !/^[0-9]+(?:\.[0-9]+)?$/.test(String(b))) return String(a ?? '') === String(b ?? '')
  const left = decimalParts(a), right = decimalParts(b)
  return left.units * right.divisor === right.units * left.divisor
}
export function appraisalRuleContent(definition: JsonObject, fullScore: unknown): JsonObject {
  const result = structuredClone(definition), dimensions = rows(result.dimensions)
  if (fullScore === '-') {
    for (const dimension of dimensions) for (const indicator of rows(dimension.indicators)) indicator.scoreLimit = '-'
    return result
  }
  const full = decimalParts(fullScore), regular = dimensions.filter(dimension => !['add', 'sub'].includes(String(dimension.type)))
  if (result.calculation !== 'sum') {
    for (const dimension of regular) for (const indicator of rows(dimension.indicators)) indicator.scoreLimit = String(fullScore)
    return result
  }
  const batches = result.isDimensionsWeight === true ? regular.map(dimension => rows(dimension.indicators)) : [regular.flatMap(dimension => rows(dimension.indicators))]
  for (const indicators of batches) {
    const weights = indicators.map(indicator => decimalParts(indicator.weight)), digits = Math.max(0, ...weights.map(weight => weight.digits))
    const scaled = weights.map(weight => weight.units * 10n ** BigInt(digits - weight.digits)), total = scaled.reduce((a, b) => a + b, 0n)
    for (const [index, indicator] of indicators.entries()) {
      const numerator = full.units * scaled[index] * 100n, denominator = full.divisor * total
      const cents = denominator === 0n ? 0n : (2n * numerator + denominator) / (2n * denominator)
      indicator.scoreLimit = String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0')
    }
  }
  return result
}

export function appraisalSteps(action: AppraisalAction): Route[] {
  const get = (step: string, path: string): Route => [step, 'GET', prefix + path]
  const base: Route[] = [['identity', 'GET', '/task/login/authAjax'], get('initialized', '/init'), get('role', '/authority/role')]
  if (action.startsWith('assessment-')) return [...base, ...appraisalAssessmentSteps(action as AppraisalAssessmentAction)]
  if (action.startsWith('report-')) return [...base, ...appraisalReportSteps(action as AppraisalReportAction)]
  if (action.startsWith('salary-')) return [...base, ...appraisalSalarySteps(action as AppraisalSalaryAction)]
  if (action.startsWith('entry-import-')) return [...base, ...appraisalEntryImportSteps(action as AppraisalEntryImportAction)]
  const change = (method: string, path: string): Route => ['changed', method, prefix + path]
  const fields = [get('placements', '/preference/fields/all'), get('definitions', '/preference/fields')]
  const groups = get('groups', '/template/group'), templates = get('templates', '/templates/my'), detail = get('template', '/template')
  const graph = (verified = false): Route[] => [get(verified ? 'verifiedTemplate' : 'template', '/template'), get(verified ? 'verifiedNodes' : 'nodes', '/template/nodes'), get(verified ? 'verifiedConfirms' : 'confirms', '/template/confirms'), get(verified ? 'verifiedResultConfirms' : 'resultConfirms', '/template/resultConfirms'), get(verified ? 'verifiedContent' : 'content', '/template/content')]
  if (action === 'context') return base
  if (action === 'participants') return [...base, get('participants', '/member/select')]
  if (action === 'preferences') return [...base, get('preferences', '/preference')]
  if (action === 'preferences-set') return [...base, get('preferences', '/preference'), change('PUT', '/preference'), get('verifiedPreferences', '/preference')]
  if (action === 'fields') return [...base, ...fields]
  if (action === 'field-create') return [...base, ...fields, change('POST', '/preference/fields'), get('verifiedPlacements', '/preference/fields/all'), get('verifiedDefinitions', '/preference/fields')]
  if (action === 'field-set' || action === 'field-remove') return [...base, ...fields, get('relations', '/preference/field/relation'), change(action === 'field-remove' ? 'DELETE' : 'PUT', '/preference/fields'), get('verifiedPlacements', '/preference/fields/all'), get('verifiedDefinitions', '/preference/fields')]
  if (action === 'field-order') return [...base, ...fields, change('PUT', '/preference/field/sort'), get('verifiedPlacements', '/preference/fields/all')]
  if (action === 'rules') return [...base, get('rules', '/preference/rule/list')]
  if (action === 'groups') return [...base, groups]
  if (action.startsWith('group-')) return [...base, groups, change(action === 'group-remove' ? 'DELETE' : 'POST', '/template/group'), get('verifiedGroups', '/template/group')]
  if (action === 'templates') return [...base, groups, templates]
  if (action === 'template-inspect') return [...base, templates, ...graph()]
  if (action === 'template-remove') return [...base, templates, detail, change('DELETE', '/template'), get('verifiedTemplates', '/templates/my')]
  if (action === 'template-move') return [...base, templates, detail, groups, change('PUT', '/template/group/move'), get('verifiedTemplates', '/templates/my'), get('verifiedTemplate', '/template')]
  if (action === 'template-copy') return [...base, templates, ...graph(), change('POST', '/template/copy'), get('verifiedTemplates', '/templates/my'), ...graph(true)]
  if (action === 'template-configure') return [...base, templates, ...graph(), get('invites', '/template/inviteColleagues/list'), get('rules', '/preference/rule/list'), get('members', '/member/select'), change('PUT', '/template'), get('verifiedTemplates', '/templates/my'), ...graph(true), get('verifiedInvites', '/template/inviteColleagues/list')]
  if (action === 'template-create') return [...base, groups, get('rules', '/preference/rule/list'), ['members', 'GET', prefix + '/member/select'], ['participants', 'GET', prefix + '/member/select'], ...fields,
    ['createdContent', 'POST', prefix + '/template/content'], ['createdNodes', 'POST', prefix + '/template/node'], ['createdConfirms', 'POST', prefix + '/template/confirm'], ['createdResultConfirms', 'POST', prefix + '/template/resultConfirm'], change('POST', '/template'), get('verifiedTemplates', '/templates/my'), ...graph(true)]
  const contents = get('contents', '/template/contents'), content = get('content', '/template/content')
  if (action === 'contents') return [...base, contents]
  if (action === 'content-inspect') return [...base, contents, content]
  if (action === 'content-create') return [...base, ...fields, change('POST', '/template/content'), get('verifiedContents', '/template/contents'), get('verifiedContent', '/template/content')]
  if (action === 'content-replace') return [...base, contents, content, ...fields, change('PUT', '/template/content'), get('verifiedContent', '/template/content')]
  if (action === 'content-remove') return [...base, contents, content, change('DELETE', '/template/content'), get('verifiedContents', '/template/contents')]
  throw new RsqError('INVALID_CONTRACT', '未知绩效业务操作。', 6)
}
export function validateAppraisalWorkflow(flow: Workflow) {
  const expected = appraisalSteps(flow.appraisalAction!)
  if (flow.executor !== 'appraisal' || flow.steps.length !== expected.length || expected.some(([key, method, route], index) => {
    const step = flow.steps[index], operation = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== key || operation?.method !== method || operation.route !== route || route === '/task/performance/member/select' && asObject(operation.defaults?.query).type !== (key === 'participants' ? 'all' : 'my') || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.transfer || step.resources || step.authentication || step.readback || step.collectPages || step.expectAbsent
  })) throw new RsqError('INVALID_CONTRACT', '绩效业务 HTTP 步骤与已核对契约不一致。', 6)
}

// A content definition is constructed without browser store/DOM state. Field
// keys come from this company's dictionary, not guessed IDs or UI row indices.
export function appraisalManualContent(value: unknown, dictionary: JsonObject, before: JsonObject | null = null): JsonObject {
  const definition = structuredClone(asObject(value)), dimensions = rows(definition.dimensions), previous = before ? rows(before.dimensions) : []
  if (!dimensions.length || dimensions.length > 100) invalid('至少需要一个考核维度，最多 100 个。')
  let totalWeight = 0
  const dimensionIds = new Set<string>(), indicatorIds = new Set<string>()
  for (const dimension of dimensions) {
    if (!manualTypes.includes(String(dimension.type))) invalid('当前此命令构造定量、定性、加分、减分维度；系统数据导入维度须使用其专门的上下文适配，不能猜协议。')
    dimension.name = name(dimension.name)
    const fields = rows(dictionary[String(dimension.type)]), permitted = new Set(fields.map(field => String(field.key))), custom = new Set(fields.filter(field => field.type === 'custom').map(field => String(field.key)))
    assert(fields.length && permitted.has('name'), '当前公司缺少该维度的字段定义。')
    if (dimension.id != null) {
      const currentId = id(dimension.id)
      if (!before || dimensionIds.has(currentId) || !previous.some(row => id(row.id) === currentId && row.type === dimension.type)) invalid('维度 ID 必须来自当前内容，且不能重复或改变其类型。')
      dimensionIds.add(currentId); dimension.id = numberId(currentId)
    }
    const current = previous.find(row => dimension.id != null && id(row.id) === id(dimension.id)), oldIndicators = current ? rows(current.indicators) : []
    const indicators = rows(dimension.indicators)
    if (!indicators.length || indicators.length > 1000) invalid('每个手工维度需要 1 到 1000 个指标。')
    if (definition.isDimensionsWeight === true) { const weight = Number(dimension.weight); if (dimension.weight === '' || !Number.isFinite(weight) || weight < 0) invalid('开启维度权重后，每个维度必须提供非负权重。'); totalWeight += weight }
    for (const indicator of indicators) {
      indicator.name = name(indicator.name)
      if (indicator.id != null) {
        const indicatorId = id(indicator.id)
        if (indicatorIds.has(indicatorId) || !oldIndicators.some(row => id(row.id) === indicatorId)) invalid('指标 ID 必须来自当前维度且不能重复。')
        indicatorIds.add(indicatorId); indicator.id = numberId(indicatorId)
      }
      if (indicator.entryRole === 'specified' || indicator.entryUser != null || indicator.systemIndicatorType != null || indicator.isAutoScore === true || indicator.rule != null || indicator.advancedRule != null) invalid('指定录入人、自动评分或系统指标需要独立成员和规则上下文，不能作为手工指标直接提交。')
      indicator.isAutoScore = false
      if (indicator.entryRole == null) indicator.entryRole = 'object'
      for (const key of Object.keys(asObject(indicator.customFieldMap))) if (!custom.has(key) || typeof asObject(indicator.customFieldMap)[key] !== 'string') invalid('自定义值必须使用当前维度字典提供的字段 key 和字符串；清空用空字符串。')
      for (const key of ['threshold', 'target', 'challenge', 'unit', 'note']) if (indicator[key] != null && indicator[key] !== '' && !permitted.has(key)) invalid('指标使用了该维度未开放的字段：' + key)
    }
    if (dimension.configurableFields != null) {
      const requested = rows(dimension.configurableFields), seen = new Set<string>()
      dimension.configurableFields = requested.map(field => {
        const actual = fields.find(row => id(row.id) === id(field.id) && row.key === field.key)
        if (!actual || actual.isConfigurable !== true || seen.has(String(field.key)) || typeof field.isShow !== 'boolean') invalid('可配置字段必须来自当前维度，名称、类型和关联由 CLI 重新组装。')
        seen.add(String(field.key)); return { ...project(actual!, sortKeys), isShow: field.isShow }
      })
    }
  }
  if (definition.isDimensionsWeight === true && Math.abs(totalWeight - 100) > 0.000001) invalid('维度权重合计必须为 100。')
  if (rows(definition.tips ?? []).length) invalid('说明组件与维度交错顺序需要专门排序上下文；此命令暂只构造维度。')
  return { calculation: definition.calculation, isDimensionsWeight: definition.isDimensionsWeight, dimensions, tips: [] }
}

function contentProjection(value: JsonObject, expected: JsonObject, preserveIds = true) {
  assert(value.calculation === expected.calculation && value.isDimensionsWeight === expected.isDimensionsWeight, '考核内容的计算或维度权重设置没有持久化。')
  const dimensions = rows(value.dimensions), wanted = rows(expected.dimensions)
  assert(dimensions.length === wanted.length, '考核维度数不符。')
  for (const [index, want] of wanted.entries()) {
    const actual = dimensions[index]
    for (const key of ['name', 'type', 'weight', 'dimensionsPercent', 'indicatorsWeight', 'indicatorPercent', 'sumAdd', 'sumSub']) if (want[key] != null) assert(String(actual[key] ?? '') === String(want[key]), '维度属性未持久化：' + key)
    if (preserveIds && want.id != null) assert(id(actual.id) === id(want.id), '更新替换了原维度 ID。')
    const indicators = rows(actual.indicators), expectedIndicators = rows(want.indicators)
    assert(indicators.length === expectedIndicators.length, '维度指标数不符。')
    for (const [position, desired] of expectedIndicators.entries()) {
      const row = indicators[position]
      for (const key of ['name', 'criteria', 'threshold', 'target', 'challenge', 'note', 'weight', 'scoreLimit', 'unit', 'entryRole', 'isAutoScore']) if (desired[key] != null) assert(['weight', 'scoreLimit'].includes(key) ? decimalEqual(row[key], desired[key]) : String(row[key] ?? '') === String(desired[key]), '指标属性未持久化：' + key)
      if (preserveIds && desired.id != null) assert(id(row.id) === id(desired.id), '更新替换了原指标 ID。')
      for (const [key, entry] of Object.entries(asObject(desired.customFieldMap))) assert(asObject(row.customFieldMap)[key] === entry, '自定义字段值未独立持久化。')
    }
    for (const field of rows(want.configurableFields ?? [])) assert(rows(actual.configurableFields).some(row => row.key === field.key && row.isShow === field.isShow), '维度字段显示配置未持久化。')
  }
}

export async function runAppraisal(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateAppraisalWorkflow(flow)
  const session = requireSession(supplied), action = flow.appraisalAction!, resources: Record<string, unknown> = {}, completed: string[] = []
  let phase = 'identity', pending = false
  const call = async (stepId: string, args: JsonObject = {}, envelope = false) => {
    const step = flow.steps.find(step => step.id === stepId), operation = catalog.operations.find(op => op.id === step?.operationId)
    if (!operation) throw new RsqError('INVALID_CONTRACT', '绩效调用了未声明的 HTTP 步骤。', 6)
    phase = stepId; pending = false
    const transport: Transport = async (url, init) => {
      pending = operation.effect !== 'read'
      const response = await (options.transport ?? request)(url, init)
      if (response.ok && operation.method === 'POST') try {
        const row = asObject(asObject(parseJson(await response.clone().text())).data)
        if (row.id != null) resources[stepId === 'createdReport' ? 'salaryReportId' : stepId === 'createdField' ? 'salaryFieldId' : stepId === 'createdNodes' ? 'lastCreatedNodeId' : stepId === 'createdConfirms' ? 'lastCreatedContentConfirmId' : stepId === 'createdResultConfirms' ? 'lastCreatedResultConfirmId' : stepId === 'createdContent' ? 'contentId' : action.startsWith('template-') ? 'templateId' : 'contentId'] = id(row.id)
      } catch { /* Preserve returned creation IDs before response validation. */ }
      return response
    }
    const response = await runOperation(ctx, operation, args, session, { ...options, transport })
    pending = false; completed.push(stepId)
    if (['/task/v1/department/list', '/task/file/signature/getFront', '/task/v1/folder/file'].includes(operation.route)) return response
    return envelope ? { data: data(response), ext: asObject(response).ext ?? null } : data(response)
  }
  const result = (value: unknown) => ({ workflow: flow.id, completedSteps: completed, resources, result: value })
  const allow = (role: JsonObject, permission: string) => { if (asObject(role.authorities)[permission] !== true) throw new RsqError('RESOURCE_FORBIDDEN', '当前绩效角色没有授予此业务权限。', 4, { permission }) }
  const groupList = (step = 'groups', official = false) => call(step, { query: { isOfficialTemplate: official } }).then(rows)
  const templateList = (step = 'templates', official = false) => call(step, { query: { isAll: true, isOfficialTemplate: official } }).then(rows)
  const contentList = async (step = 'contents', query: JsonObject = {}) => {
    const all: JsonObject[] = [], seen = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const values = rows(await call(step, { query: { ...query, offset: all.length, max: 100 } }))
      for (const row of values) { const key = id(row.id); assert(!seen.has(key), '考核内容列表分页出现重复 ID，停止而不假定完整。'); seen.add(key); all.push(row) }
      if (values.length < 100) return all
    }
    throw new RsqError('PAGINATION_LIMIT', '考核内容列表超过 100 页；未将截断结果用于写入归属证明。', 5)
  }
  const graph = async (target: string, listing: JsonObject, verified = false) => {
    const get = (key: string) => verified ? 'verified' + key[0].toUpperCase() + key.slice(1) : key
    const template = templateDetail(await call(get('template'), { query: { id: target } }), target, listing)
    const nodes = rows(await call(get('nodes'), { query: { id: target } })), confirms = rows(await call(get('confirms'), { query: { appraisalId: target } })), resultConfirms = rows(await call(get('resultConfirms'), { query: { appraisalId: target } }))
    const contentId = id(template.contentId), content = normalizeContent(await call(get('content'), { query: { id: contentId } })); assert(id(content.id) === contentId, '模板的内容关联不符。')
    return { template, nodes, confirms, resultConfirms, content }
  }
  try {
    // authAjax and the explicitly declared legacy directory have bare responses;
    // performance service steps require the checked code/data envelope.
    const identityStep = flow.steps[0], identityOp = catalog.operations.find(op => op.id === identityStep.operationId)!
    const actor = asObject(await runOperation(ctx, identityOp, {}, session, options)); completed.push('identity')
    assert(id(actor.id) === session.identity.userId && id(asObject(actor.team).id) === session.identity.teamId, '绩效身份或当前公司与 profile 不符。')
    const initialized = asObject(await call('initialized')), role = asObject(await call('role'))
    if (action === 'context') return result({ identity: session.identity, initialized: initialized.hasInit === true, role, relatedCommands: ['appraisal setup', 'appraisal templates list', 'appraisal custom-fields list', 'appraisal scoring-rules list', 'appraisal reports context', 'appraisal salary context'] })
    if (initialized.hasInit !== true) throw new RsqError('APPLICATION_NOT_INITIALIZED', '当前公司尚未初始化绩效，请先查看 appraisal setup 的 Schema。', 4)
    if (action === 'participants') { allow(role, 'performanceAppraisalTempManage'); return result({ members: rows(await call('participants', { query: { type: 'all' } })), scope: 'current-company-participants', objectScope: '考核对象仍受实际可管理成员范围限制；不能把本列表用作对象授权。' }) }
    if (action.startsWith('assessment-')) return result(await runAppraisalAssessment(action as AppraisalAssessmentAction, input, { call, role, userId: session.identity.userId, resources, templateDetail }))
    if (action.startsWith('report-')) return result(await runAppraisalReport(action as AppraisalReportAction, input, { call, role, resources, inspect: appraisalId => runAppraisalAssessment('assessment-inspect', { appraisalId }, { call, role, userId: session.identity.userId, resources, templateDetail }) }))
    if (action.startsWith('salary-')) return result(await runAppraisalSalary(action as AppraisalSalaryAction, input, { call, role, resources }))
    if (action.startsWith('entry-import-')) return result(await runAppraisalEntryImport(action as AppraisalEntryImportAction, input, { call, userId: session.identity.userId, resources,
      inspect: appraisalId => runAppraisalAssessment('assessment-inspect', { appraisalId }, { call, role, userId: session.identity.userId, resources, templateDetail }),
      save: (appraisalId, values, expectedEntrySnapshot) => runAppraisalAssessment('assessment-entry-save', { appraisalId, values }, { call, role, userId: session.identity.userId, resources, templateDetail, expectedEntrySnapshot }),
    }))
    if (action === 'preferences' || action === 'preferences-set') {
      allow(role, 'performancePreferencesManage')
      const before = asObject(await call('preferences'))
      if (action === 'preferences') return result({ preferences: before, initializationPossible: true })
      const patch = asObject(input.patch), keys = ['isAutoReminder', 'isAutoScore', 'scoreType', 'days']
      if (!Object.keys(patch).length || Object.keys(patch).some(key => !keys.includes(key))) invalid('请提供当前 UI 支持的稀疏偏好设置。')
      await call('changed', { body: patch }); const after = asObject(await call('verifiedPreferences'))
      for (const key of Object.keys(before)) assert(isDeepStrictEqual(after[key] ?? null, (Object.hasOwn(patch, key) ? patch[key] : before[key]) ?? null), '偏好没有持久化，或未指定设置发生变化：' + key)
      return result({ preferences: after, independentlyVerified: true })
    }
    if (action === 'rules') return result({ rules: rows(await call('rules')) })
    if (action === 'fields' || action.startsWith('field-')) {
      if (action !== 'fields') allow(role, 'performancePreferencesManage')
      let placements = asObject(asObject(await call('placements')).allFields), definitions = rows(await call('definitions'))
      if (action === 'fields') return result({ definitions, placements, idSemantics: 'definition.id 用于维护；placements[type][].id 用于该维度排序；实际赋值使用 key。' })
      if (action === 'field-order') {
        const type = String(input.dimensionType), before = rows(placements[type]), ordered = (input.placementIds as unknown[]).map(id), initial = structuredClone(placements)
        if (!sameIds(before.map(row => row.id), ordered) || id(before[0].id) !== ordered[0]) invalid('排序须给出该维度的完整排列 ID，保留首列，不能使用字段定义 ID。')
        for (let index = 1; index < ordered.length; index++) {
          const current = rows(placements[type]); if (id(current[index].id) === ordered[index]) continue
          const remaining = current.filter(row => id(row.id) !== ordered[index]), next = remaining[index]
          await call('changed', { body: { id: numberId(ordered[index]), frontId: numberId(ordered[index - 1]), ...(next && { nextId: numberId(next.id) }) } })
          placements = asObject(asObject(await call('verifiedPlacements')).allFields)
        }
        if (!completed.includes('verifiedPlacements')) placements = asObject(asObject(await call('verifiedPlacements')).allFields)
        assert(isDeepStrictEqual(rows(placements[type]).map(row => id(row.id)), ordered), '维度字段排列未持久化。')
        for (const [other, value] of Object.entries(initial)) if (other !== type) assert(isDeepStrictEqual(value, placements[other]), '排序意外改变了其他维度。')
        return result({ dimensionType: type, placements: rows(placements[type]), independentlyVerified: true })
      }
      const previous = action === 'field-create' ? null : selected(definitions, input.fieldId, '字段定义')
      if (previous) resources.fieldId = id(previous.id)
      const relations = previous ? asObject(await call('relations', { query: { fieldId: id(previous.id) } })) : null
      const patch = asObject(input.patch), expected: JsonObject = action === 'field-create' ? { name: name(input.name), types: input.dimensionTypes, isAsFormulaField: input.isAsFormulaField ?? false } : { ...previous, ...patch, ...(Object.hasOwn(patch, 'dimensionTypes') && { types: patch.dimensionTypes }) }
      if (action !== 'field-remove') {
        expected.name = name(expected.name); const types = expected.types as unknown[]
        if (!Array.isArray(types) || types.some(type => !manualTypes.includes(String(type))) || new Set(types).size !== types.length) invalid('自定义字段只使用当前 UI 开放的四种维度，不能重复。')
        if (definitions.some(row => (!previous || id(row.id) !== id(previous.id)) && row.name === expected.name)) invalid('当前公司已有同名字段。')
        if (previous && (expected.isAsFormulaField === false && previous.isAsFormulaField === true || (previous.types as unknown[]).some(type => !types.includes(type))) && relations?.canDelete !== true) throw new RsqError('DEPENDENCY_CONFLICT', '已有模板、内容或指标引用该字段；先修改引用后再移除维度或公式资格。', 4, { relations })
      } else if (relations?.canDelete !== true) throw new RsqError('DEPENDENCY_CONFLICT', '该字段仍有业务引用，不能删除。', 4, { relations })
      await call('changed', action === 'field-remove' ? { query: { id: id(previous!.id) } } : { body: { ...(previous && { id: numberId(previous.id) }), name: expected.name, types: (expected.types as unknown[]).join(','), isAsFormulaField: expected.isAsFormulaField } })
      const afterPlacements = asObject(asObject(await call('verifiedPlacements')).allFields), after = rows(await call('verifiedDefinitions'))
      if (action === 'field-remove') { assert(!after.some(row => id(row.id) === id(previous!.id)), '字段删除后仍存在。'); for (const value of Object.values(afterPlacements)) assert(!rows(value).some(row => row.key === 'custom_fieldTemplate_' + id(previous!.id)), '删除后仍残留维度字段关联。') }
      else {
        const matches = after.filter(row => previous ? id(row.id) === id(previous.id) : row.name === expected.name && !definitions.some(old => id(old.id) === id(row.id)))
        assert(matches.length === 1, '未唯一发现本次新增或修改的字段。'); const actual = matches[0]; resources.fieldId = id(actual.id)
        assert(actual.name === expected.name && actual.isAsFormulaField === expected.isAsFormulaField && isDeepStrictEqual((actual.types as string[]).slice().sort(), (expected.types as string[]).slice().sort()), '字段定义未独立持久化。')
        for (const type of manualTypes) { const fields = rows(afterPlacements[type] ?? []), linked = fields.filter(row => row.key === 'custom_fieldTemplate_' + id(actual.id)); assert((expected.types as string[]).includes(type) ? linked.length === 1 && linked[0].name === expected.name && linked[0].isAsFormulaField === expected.isAsFormulaField : linked.length === 0, '字段与维度关联未持久化。') }
      }
      for (const row of definitions.filter(row => !previous || id(row.id) !== id(previous.id))) assert(isDeepStrictEqual(selected(after, row.id, '其他字段'), row), '维护字段时改变了其他字段定义。')
      return result({ definitions: after, placements: afterPlacements, independentlyVerified: true })
    }
    if (action === 'groups' || action.startsWith('group-')) {
      allow(role, 'performanceAppraisalTempManage')
      const before = await groupList()
      if (action === 'groups') return result({ groups: before })
      const previous = action === 'group-create' ? null : selected(before.filter(row => /^[1-9][0-9]*$/.test(String(row.id))), input.groupId, '模板分组')
      if (previous) resources.groupId = id(previous.id)
      const expectedName = action === 'group-remove' ? null : name(input.name)
      if (expectedName != null && expectedName.length > 20) invalid('绩效模板分组名称最多 20 字符。')
      if (expectedName === '未分组模板' || before.some(row => row.name === expectedName && (!previous || String(row.id) !== id(previous.id)))) invalid('模板分组名称已被占用。')
      if (action === 'group-remove' && Number(previous!.count) > 0) invalid('请先把该分组内的模板移到明确目标，再删除空分组。')
      await call('changed', action === 'group-remove' ? { query: { id: id(previous!.id) } } : { body: { ...(previous && { id: numberId(previous.id) }), name: expectedName } })
      const after = await groupList('verifiedGroups')
      if (action === 'group-remove') assert(!after.some(row => String(row.id) === id(previous!.id)), '模板分组删除后仍存在。')
      else { const matches = after.filter(row => row.name === expectedName && (previous ? String(row.id) === id(previous.id) : !before.some(old => String(old.id) === String(row.id)))); assert(matches.length === 1, '未唯一发现新增或改名的分组。'); resources.groupId = id(matches[0].id) }
      return result({ groups: after, independentlyVerified: true })
    }
    if (action === 'templates') { const groups = await groupList('groups', input.official === true), templates = rows(await call('templates', { query: { offset: input.offset ?? 0, max: input.max ?? 20, ...(input.type != null && { type: input.type }), ...(input.name != null && { templateName: input.name }), ...(input.groupId != null && { groupId: input.groupId }), isOfficialTemplate: input.official === true } })); return result({ groups, templates, pagination: { offset: input.offset ?? 0, max: input.max ?? 20, complete: false } }) }
    if (action === 'template-inspect' || action === 'template-copy') {
      if (action === 'template-copy') allow(role, 'performanceAppraisalTempManage')
      const before = await templateList('templates', input.official === true), sourceId = id(input.templateId), listing = selected(before, sourceId, '考核模板'); resources.templateId = sourceId
      const initial = await graph(sourceId, listing)
      if (action === 'template-inspect') return result({ ...initial, official: input.official === true })
      const created = asObject(await call('changed', { body: { id: numberId(sourceId), isOfficialTemplate: input.official === true } })), target = id(created.id); resources.templateId = target; resources.sourceTemplateId = sourceId
      assert(target !== sourceId, '复制返回了原模板 ID。')
      const after = await graph(target, selected(await templateList('verifiedTemplates'), target, '复制结果'), true)
      assert(after.template.name === String(initial.template.name) + '副本' && after.template.type === initial.template.type && id(after.content.id) !== id(initial.content.id), '模板复制名称、周期或独立内容不符。')
      assert(after.nodes.length === initial.nodes.length && after.confirms.length === initial.confirms.length && after.resultConfirms.length === initial.resultConfirms.length, '模板复制遗漏了流程节点。')
      assert(!after.nodes.some(node => initial.nodes.some(old => id(old.id) === id(node.id))), '复制复用了原评分节点。')
      contentProjection(after.content, initial.content, false)
      return result({ ...after, sourceTemplateId: sourceId, officialSource: input.official === true, independentlyVerified: true, ...(input.official === true && { requiredNextStep: '官方模板复制会清空本公司评分规则及对象；配置本公司规则和对象后才能发起。' }) })
    }
    if (action === 'template-remove' || action === 'template-move') {
      allow(role, 'performanceAppraisalTempManage'); const before = await templateList(), target = id(input.templateId), listing = selected(before, target, '考核模板'); resources.templateId = target
      const current = templateDetail(await call('template', { query: { id: target } }), target, listing); assert(current.hasTemplateMange === true, '模板不属于当前可管理上下文。')
      if (action === 'template-remove') { await call('changed', { query: { id: target } }); assert(!(await templateList('verifiedTemplates')).some(row => id(row.id) === target), '模板删除后仍可见。'); return result({ removed: true, templateId: target, independentlyVerified: true }) }
      const groups = await groupList(), groupId = String(input.groupId)
      if (groupId !== 'unassigned') selected(groups.filter(row => /^[1-9][0-9]*$/.test(String(row.id))), groupId, '目标分组')
      await call('changed', { body: { groupId, ids: target } }); const listRow = selected(await templateList('verifiedTemplates'), target, '移动结果'), after = templateDetail(await call('verifiedTemplate', { query: { id: target } }), target, listRow)
      assert(String(asObject(listRow.group).id) === groupId && String(asObject(after.group).id) === groupId, '模板分组关联未独立持久化。')
      for (const [key, value] of Object.entries(current)) if (key !== 'group') assert(isDeepStrictEqual(after[key], value), '移动分组时改变了模板其他配置：' + key)
      return result({ template: after, independentlyVerified: true })
    }
    if (action === 'template-configure') {
      allow(role, 'performanceAppraisalTempManage')
      const target = id(input.templateId), listing = selected(await templateList(), target, '考核模板'); resources.templateId = target
      const initial = await graph(target, listing); assert(initial.template.hasTemplateMange === true, '模板不属于当前可管理上下文。')
      const invites = rows(await call('invites', { query: { appraisalId: target } })), body = appraisalTemplateBody(initial, invites), patch = asObject(input.patch), settings = asObject(patch.options)
      const rules = rows(await call('rules')), rule = selected(rules, patch.ruleId ?? body.ruleId, '评分规则')
      body.ruleId = numberId(rule.id)
      if (patch.name != null) body.name = name(patch.name)
      if (patch.type != null) body.type = patch.type
      if (patch.objectIds != null) {
        const members = rows(await call('members', { query: { type: 'my' } })), ids = (patch.objectIds as unknown[]).map(id)
        if (!ids.length || ids.some(key => !members.some(member => id(member.id) === key))) invalid('模板考核对象必须来自当前实际可管理成员。')
        body.objectIds = ids.join(',')
      }
      if (!body.objectIds && !body.deptId && !body.staffGroupId) invalid('模板至少需要一位考核对象、部门或小组；官方复制结果需先配置本公司对象。')
      for (const [key, value] of Object.entries(settings)) { if (!appraisalOptionKeys.includes(key) || typeof value !== 'boolean') invalid('模板选项必须是 Schema 中的布尔开关。'); body[key] = value }
      if (body.isContentSignature === true && body.isContentAcknowledgement !== true || body.isResultSignature === true && body.isResultAcknowledgement !== true) invalid('签字必须启用对应的本人确认环节。')
      const expectedContent = appraisalRuleContent(initial.content, rule.fullScore)
      await call('changed', { body })
      const after = await graph(target, selected(await templateList('verifiedTemplates'), target, '模板配置结果'), true), afterInvites = rows(await call('verifiedInvites', { query: { appraisalId: target } }))
      verifyAppraisalTemplateBody(after, afterInvites, body)
      for (const part of ['nodes', 'confirms', 'resultConfirms'] as const) assert(isDeepStrictEqual(initial[part], after[part]), '配置改变了未修改的模板节点：' + part)
      assert(isDeepStrictEqual(invites, afterInvites), '配置改变了未修改的邀请节点。')
      contentProjection(after.content, expectedContent)
      return result({ ...after, invites: afterInvites, independentlyVerified: true, assessmentLaunched: false })
    }
    if (action === 'template-create') {
      allow(role, 'performanceAppraisalTempManage')
      const groups = await groupList(), rules = rows(await call('rules')), rule = selected(rules, input.ruleId, '评分规则'), members = rows(await call('members', { query: { type: 'my' } }))
      const available = new Set<string>()
      const visit = (value: unknown) => { if (Array.isArray(value)) { for (const row of value) visit(row); return }; const row = asObject(value); if (row.type === 'user' || row.username != null || row.showName != null || row.userName != null) { if (row.id != null) available.add(id(row.id)) }; for (const key of ['userList', 'users', 'childList', 'children', 'members']) if (row[key] != null) visit(row[key]) }
      visit(members)
      const objectIds = (input.objectIds as unknown[]).map(id)
      if (!objectIds.length || objectIds.some(key => !available.has(key))) invalid('考核对象必须来自当前绩效成员选择器及管理范围。')
      const groupId = String(input.groupId ?? 'unassigned'); if (groupId !== 'unassigned') selected(groups.filter(row => /^[1-9][0-9]*$/.test(String(row.id))), groupId, '目标分组')
      const dictionary = asObject(asObject(await call('placements')).allFields); await call('definitions')
      const definition = appraisalManualContent(input.content, dictionary), expectedContent = appraisalRuleContent(definition, rule.fullScore), participants = rows(await call('participants', { query: { type: 'all' } }))
      const nodes = rows(input.nodes).map(node => appraisalParticipantNode(node, participants, 'score')), confirms = rows(input.contentConfirms ?? []).map(node => appraisalParticipantNode(node, participants, 'content')), resultConfirms = rows(input.resultConfirms ?? []).map(node => appraisalParticipantNode(node, participants, 'result'))
      appraisalNodeWeights(nodes)
      const settings = asObject(input.options)
      if (settings.isContentSignature === true && settings.isContentAcknowledgement !== true || settings.isResultSignature === true && settings.isResultAcknowledgement !== true) invalid('签字必须启用对应的本人确认环节。')
      const content = asObject(await call('createdContent', { body: { ...contentWire(definition), name: [...name(input.name)].slice(0, 197).join('') + '-内容', isCreateByAppraisal: true } })), contentId = id(content.id); resources.contentId = contentId
      const nodeIds: string[] = []; resources.nodeIds = nodeIds
      for (const node of nodes) { const created = asObject(await call('createdNodes', { body: node })); nodeIds.push(id(created.id)) }
      const confirmIds: string[] = [], resultConfirmIds: string[] = []; resources.contentConfirmIds = confirmIds; resources.resultConfirmIds = resultConfirmIds
      for (const confirm of confirms) confirmIds.push(id(asObject(await call('createdConfirms', { body: confirm })).id))
      for (const confirm of resultConfirms) resultConfirmIds.push(id(asObject(await call('createdResultConfirms', { body: confirm })).id))
      const body = { name: name(input.name), type: input.type, contentId: numberId(contentId), ruleId: numberId(rule.id), groupId, objectIds: objectIds.join(','), nodeIds: nodeIds.join(','),
        isScore: true, isScoreExplanation: true, isCanSeeScoreReview: false, isDeduplication: false, isAnonymous: false, isConfirm: confirms.length > 0, isResultConfirm: resultConfirms.length > 0,
        ...(confirmIds.length && { confirmIds: confirmIds.join(',') }), ...(resultConfirmIds.length && { resultConfirmIds: resultConfirmIds.join(',') }),
        isInviteColleagues: false, raterEmpty: 'initiator', startScoreFlag: true, isContentAcknowledgement: false, isResultAcknowledgement: false, isContentSignature: false, isResultSignature: false, isInterview: false, isResultEntryOnlyManual: true, ...settings, isNeedStart: false }
      const created = asObject(await call('changed', { body })), target = id(created.id); resources.templateId = target
      const after = await graph(target, selected(await templateList('verifiedTemplates'), target, '新模板'), true)
      assert(after.template.name === body.name && after.template.type === body.type && id(after.template.contentId) === contentId && id(asObject(after.template.rule).id) === id(rule.id), '新模板的名称、周期、内容或评分规则未持久化。')
      assert(sameIds(rows(after.template.objects).map(row => row.id), objectIds) && sameIds(after.nodes.map(row => row.id), nodeIds), '新模板的对象或评分节点关联不符。')
      verifyAppraisalParticipants(after.nodes, nodes, 'score'); verifyAppraisalParticipants(after.confirms, confirms, 'content'); verifyAppraisalParticipants(after.resultConfirms, resultConfirms, 'result')
      for (const [key, value] of Object.entries(settings)) assert(isDeepStrictEqual((['isDeduplication', 'isAnonymous'].includes(key) ? asObject(after.template.score) : ['isScore', 'isScoreExplanation', 'isCanSeeScoreReview', 'isCanSeeAppraisalScore', 'isCanSeeAppraisalLevel', 'isCanSeeAppraisalCoefficient'].includes(key) ? asObject(after.template.objectVisible) : after.template)[key], value), '模板开关未持久化：' + key)
      contentProjection(after.content, expectedContent)
      return result({ ...after, independentlyVerified: true, assessmentLaunched: false, derivedFields: ['scoreLimit 按当前规则满分、计算方式和维度/指标权重重算，四舍五入到两位。'] })
    }
    if (action === 'contents') return result({ contents: rows(await call('contents', { query: { offset: input.offset ?? 0, max: input.max ?? 20, ...(input.name != null && { name: input.name }) } })), pagination: { offset: input.offset ?? 0, max: input.max ?? 20, complete: false } })
    allow(role, 'performanceAppraisalContentManage')
    let before: JsonObject | null = null
    if (action !== 'content-create') {
      const contents = await contentList(), target = id(input.contentId); selected(contents, target, '内容模板'); resources.contentId = target
      before = normalizeContent(await call('content', { query: { id: target } })); assert(id(before.id) === target, '内容模板 ID 不符。')
      if (action === 'content-inspect') return result({ content: before })
      if (action === 'content-remove') { await call('changed', { query: { id: target } }); assert(!(await contentList('verifiedContents')).some(row => id(row.id) === target), '内容模板删除后仍在列表中。'); return result({ removed: true, contentId: target, independentlyVerified: true }) }
    }
    const dictionary = asObject(asObject(await call('placements')).allFields); await call('definitions')
    const definition = appraisalManualContent(input.definition, dictionary, before), expectedName = name(input.name), body = { ...contentWire(definition), name: expectedName, ...(before ? { id: numberId(before.id) } : { isCreateByAppraisal: false }) }
    const changed = asObject(await call('changed', { body })), target = before ? id(before.id) : id(changed.id); resources.contentId = target
    if (!before) selected(await contentList('verifiedContents', { name: expectedName }), target, '新内容模板')
    const after = normalizeContent(await call('verifiedContent', { query: { id: target } })); assert(id(after.id) === target && after.name === expectedName, '内容模板名称或 ID 不符。'); contentProjection(after, definition)
    return result({ content: after, independentlyVerified: true })
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '绩效业务未完成。', 5)
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown-do-not-retry' : 'check-completed-steps', automaticRollback: false, retry: 'manual-after-readback', ...(failure.details && { cause: failure.details }) })
  }
}
