import Big from 'big.js'
import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'

const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
function check(value: unknown, message: string): asserts value { if (!value) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const key = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('绩效关联 ID 必须为精确正整数。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : invalid('绩效关联不是有界列表。')
const csv = (value: unknown) => rows(value).map(row => key(row.id)).join(',') || null
const flags = ['isScore', 'isScoreExplanation', 'isCanSeeScoreReview', 'isCanSeeAppraisalScore', 'isCanSeeAppraisalLevel', 'isCanSeeAppraisalCoefficient']
export const appraisalOptionKeys = [...flags, 'isDeduplication', 'isAnonymous', 'startScoreFlag', 'isResultEntryOnlyManual', 'isContentAcknowledgement', 'isResultAcknowledgement', 'isContentSignature', 'isResultSignature']
export type TemplateGraph = { template: JsonObject; nodes: JsonObject[]; confirms: JsonObject[]; resultConfirms: JsonObject[]; content: JsonObject }

/** Use the company member selector, never browser store indices or guessed IDs. */
export function appraisalParticipantNode(value: JsonObject, members: JsonObject[], kind: 'score' | 'content' | 'result'): JsonObject {
  const input = structuredClone(value), role = String(input.role), available = new Set(members.map(member => key(member.id)))
  const people = (field: string) => {
    const values = input[field] == null ? [] : input[field]
    if (!Array.isArray(values) || values.length > 1000) invalid('节点参与人须为当前公司成员 ID 数组。')
    const ids = (values as unknown[]).map(key)
    if (new Set(ids).size !== ids.length || ids.some(id => !available.has(id))) invalid('节点参与人重复或不在当前公司绩效成员中。')
    delete input[field]; return ids
  }
  const field = kind === 'score' ? 'raterIds' : 'confirmorIds', ids = people(field)
  if (kind === 'content' && ids.length > 1) invalid('当前内容制定服务每个节点只保存一位指定成员；需要多位时请分为多个节点。')
  if (kind === 'result') {
    if (!['object', 'calibrationUser'].includes(role)) invalid('结果校准节点须选择本人或校准人。')
    if (role === 'object' && (ids.length || input.isDirectSupervisor === true || input.isDepartmentManager === true || input.isAssignColleagues === true)) invalid('本人节点不能混入其他校准人。')
    if (role === 'calibrationUser' && !ids.length && input.isDirectSupervisor !== true && input.isDepartmentManager !== true) invalid('校准人须明确选择同事、直属上级或部门主管。')
    input.isAssignColleagues = ids.length > 0
  } else {
    const permitted = kind === 'score' ? ['object', 'specified', 'colleagues', 'higher', 'departmentManager'] : ['object', 'specified', 'colleagues', 'higher', 'departmentManager']
    if (!permitted.includes(role)) invalid('此节点角色尚未取得对应上下文。')
    if (['higher', 'departmentManager'].includes(role)) {
      if (!Number.isInteger(input.level) || Number(input.level) < 1 || Number(input.level) > 6 || ids.length) invalid('上级或主管节点须选择 1 到 6 级，不能混入指定成员。')
      input.raterValue = (role === 'higher' ? 'higher' : 'manager') + input.level
    } else if (input.level != null) invalid('只有上级或主管节点支持 level。')
    delete input.level
    if (role === 'object' && ids.length) invalid('本人节点不能带其他参与人。')
    if (role === 'specified' && !ids.length) invalid('指定成员节点至少需要一位实际成员。')
    if (role === 'colleagues') {
      if (kind === 'content' && !ids.length || kind === 'score' && !ids.length && input.isSameLevel !== true && input.isLowerLevel !== true) invalid('同事节点须明确指定成员或同级/下级范围。')
      if (kind === 'score') input.isAssignColleagues = ids.length > 0
    }
  }
  if (ids.length) input[field] = ids.join(',')
  return input
}

export function appraisalNodeWeights(nodes: JsonObject[]) {
  if (!nodes.length || nodes.length > 30) invalid('至少需要一个评分节点，最多 30 个。')
  const weights = nodes.map(node => { if (typeof node.weight !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(node.weight) || node.weight.length > 10) invalid('评分节点权重须为最多 10 字符的非负十进制字符串。'); return new Big(String(node.weight)) })
  if (!weights.reduce((a, b) => a.plus(b), new Big('0')).eq('100')) invalid('评分节点权重合计必须为 100。')
}

/** Reconstruct every setting that the UI submits, including inactive settings. */
export function appraisalTemplateBody(graph: TemplateGraph, inviteNodes: JsonObject[]): JsonObject {
  const template = graph.template, visible = asObject(template.objectVisible), score = asObject(template.score), interview = asObject(template.interview)
  const body: JsonObject = { id: key(template.id), name: template.name, type: template.type, contentId: template.contentId,
    ruleId: asObject(template.rule).id ?? null, groupId: asObject(template.group).id ?? 'unassigned',
    objectIds: csv(template.objects), deptId: csv(template.departmentList ?? []), staffGroupId: csv(template.staffGroupList ?? []),
    nodeIds: csv(graph.nodes), confirmIds: csv(graph.confirms), resultConfirmIds: csv(graph.resultConfirms), inviteColleagueIds: csv(inviteNodes),
    userIdsRaterEmpty: csv(score.usersRaterEmpty ?? []), raterEmpty: score.raterEmpty, customScoreRangeType: template.customScoreRangeType ?? 'node',
  }
  for (const field of flags) body[field] = visible[field]
  for (const field of ['isDeduplication', 'isAnonymous', 'isCustomScore']) body[field] = score[field]
  for (const field of ['isConfirm', 'isResultConfirm', 'isInviteColleagues', 'inviteColleaguesMax', 'inviteColleaguesMin', 'isInviteColleaguesRolePeer', 'isInviteColleaguesRoleSuperior', 'isInviteColleaguesRoleJunior', 'isInviteColleaguesRoleOther', 'inviteColleaguesCountType', 'inviteColleaguesCountList', 'isContentAcknowledgement', 'isResultAcknowledgement', 'isContentSignature', 'isResultSignature', 'isInterview', 'startScoreFlag', 'isResultEntryOnlyManual']) if (Object.hasOwn(template, field)) body[field] = template[field]
  if (interview.id != null) {
    body.interviewParams = Object.fromEntries(['id', 'role', 'raterValue', 'isCondition', 'conditionType', 'conditionScoreLimit', 'isTemplate', 'reviewTemplateId', 'viewPermission'].filter(field => Object.hasOwn(interview, field)).map(field => [field, interview[field]]))
    Object.assign(asObject(body.interviewParams), { levelIds: csv(interview.levelList ?? []), specifyUserIds: csv(interview.specifyUserIdList ?? []), specifyDeptIds: csv(interview.departmentList ?? []) })
  }
  for (const field of ['isScore', 'isScoreExplanation', 'isConfirm', 'isDeduplication', 'isAnonymous', 'isCustomScore', 'isInviteColleagues', 'isResultConfirm']) check(typeof body[field] === 'boolean', '模板缺少必要配置，停止而不套用默认值覆盖：' + field)
  check(typeof body.nodeIds === 'string' && body.nodeIds.length, '模板没有实际评分节点。')
  return body
}

export function verifyAppraisalParticipants(actual: JsonObject[], expected: JsonObject[], kind: 'score' | 'content' | 'result') {
  check(actual.length === expected.length, '模板流程节点数量未持久化。')
  const field = kind === 'score' ? 'raterIds' : 'confirmorIds', returned = kind === 'score' ? 'raters' : 'confirmors'
  for (const [index, wanted] of expected.entries()) {
    for (const [key, value] of Object.entries(wanted)) if (key !== field) check(isDeepStrictEqual(actual[index][key], value), '流程节点配置未持久化：' + key)
    const ids = String(wanted[field] ?? '').split(',').filter(Boolean).sort(), observed = rows(actual[index][returned] ?? []).map(person => key(person.id)).sort()
    check(isDeepStrictEqual(observed, ids), '流程节点参与人未持久化。')
  }
}

export function verifyAppraisalTemplateBody(graph: TemplateGraph, invites: JsonObject[], expected: JsonObject) {
  const actual = appraisalTemplateBody(graph, invites)
  for (const [field, value] of Object.entries(expected)) {
    if (['objectIds', 'deptId', 'staffGroupId', 'nodeIds', 'confirmIds', 'resultConfirmIds', 'inviteColleagueIds', 'userIdsRaterEmpty'].includes(field)) check(isDeepStrictEqual(String(actual[field] ?? '').split(',').filter(Boolean).sort(), String(value ?? '').split(',').filter(Boolean).sort()), '模板关联未持久化：' + field)
    else if (['id', 'ruleId', 'contentId', 'groupId'].includes(field)) check(String(actual[field]) === String(value), '模板身份关联未持久化：' + field)
    else check(isDeepStrictEqual(actual[field] ?? null, value ?? null), '模板设置未持久化或发生并发修改：' + field)
  }
}
