import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { prepareWorkflowStatistics } from './workflow-statistics.js'
import { prepareWorkflowLifecycle, workflowDefinitionVersion, workflowFieldTypes, describeWorkflowDefinitionSteps } from './workflow-lifecycle.js'

const id = (value: unknown): string => {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new RsqError('CONTEXT_MISSING', '流程上下文缺少有效资源 ID。', 5)
}
const list = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '流程服务未返回预期列表。', 5)
  return value.map(asObject)
}
const data = (value: unknown) => asObject(value).data
function groups(value: unknown): JsonObject[] {
  const roots = list(data(value)), output: JsonObject[] = [], seen = new Set<string>()
  const visit = (items: JsonObject[], depth: number) => {
    if (depth > 50 || output.length + items.length > 10000) throw new RsqError('CONTEXT_MISSING', '流程分组树过深或过大。', 5)
    for (const group of items) {
      const key = id(group.id)
      if (seen.has(key)) throw new RsqError('CONTEXT_MISSING', '流程分组树含重复节点。', 5)
      seen.add(key); output.push(group)
      if (group.groupList !== null && group.groupList !== undefined) visit(list(group.groupList), depth + 1)
    }
  }
  visit(roots, 0); return output
}
function selectedGroup(input: JsonObject, results: JsonObject) {
  const all = groups(results.groups), selected = input.groupId === undefined ? all.find(group => group.type === 'all') ?? all.find(group => group.type === 'ungrouped') : all.find(group => String(group.id) === input.groupId)
  if (!selected) throw new RsqError('CONTEXT_MISSING', '未找到目标流程分组；请先发现分组，不要猜测分组 ID。', 2)
  return id(selected.id)
}
const requirePermission = (results: JsonObject, permission: string) => {
  const source = asObject(data(results.source))
  if (asObject(source.editControl)[permission] !== true) throw new RsqError('FORBIDDEN', '当前身份没有此流程操作所需权限。', 4)
  return source
}
export function prepareWorkflowContext(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  if (kind.startsWith('workflow-statistics-')) return prepareWorkflowStatistics(kind, input, results, session)
  if (kind.startsWith('workflow-lifecycle-')) return prepareWorkflowLifecycle(kind, input, results, session)
  if (kind === 'workflow-template-apply') {
    const templates = asObject(data(results.templates)), entries = [...list(templates.custom ?? []), ...list(templates.normal ?? [])].flatMap(group => list(group.childCover ?? []))
    const matches = entries.filter(template => String(template.id) === input.templateId), selected = matches[0]
    if (!selected) throw new RsqError('CONTEXT_MISSING', '流程模板不在当前模板目录中。', 2)
    const definition = (row: JsonObject) => [row.name, row.mode, row.cover ?? null, row.skipUrl ?? null]
    if (matches.some(row => !isDeepStrictEqual(definition(row), definition(selected)))) throw new RsqError('CONTEXT_CONFLICT', '同一模板在不同目录分组的定义冲突；未创建流程应用。', 4)
    if (selected.skipUrl) throw new RsqError('UNSUPPORTED_BUSINESS_FLOW', '该模板入口用于咨询定制，不能通过创建应用接口直接应用。', 2)
    const covers = list(data(results.covers)), cover = input.cover === undefined ? covers[0]?.cover : covers.find(cover => cover.cover === input.cover)?.cover
    if (typeof cover !== 'string' || !cover.length) throw new RsqError('CONTEXT_MISSING', '请从流程封面列表选择可用封面。', 2)
    const memberIds = input.memberIds === undefined ? [] : String(input.memberIds).split(','), self = id(requireSession(session).identity.userId)
    results.prepared = { templateId: id(selected.id), expectedMode: selected.mode }
    return { body: { templateId: id(selected.id), name: input.name, cover, memberIds: [...new Set([self, ...memberIds])].join(','), deptIds: input.deptIds ?? '', parentGroupId: selectedGroup(input, results), isStar: input.isStar ?? false, from: 'workflow', ...(input.introduction !== undefined && { introduction: input.introduction }) } }
  }
  if (kind === 'workflow-application-clone') {
    requirePermission(results, 'copyFlow')
    return { body: { applicationId: input.applicationId, name: input.name, parentGroupId: selectedGroup(input, results) } }
  }
  if (kind === 'workflow-application-rename') {
    requirePermission(results, 'infoConfig')
    return { body: { id: input.applicationId, name: input.name } }
  }
  if (kind === 'workflow-application-remove') { requirePermission(results, 'removeFlow'); return { query: { id: input.applicationId } } }
  if (kind === 'workflow-form-describe' || kind === 'workflow-form-clone') {
    if (!list(data(results.forms)).some(form => String(form.id) === input.formId)) throw new RsqError('CONTEXT_MISSING', '表单不属于该流程应用；先发现流程的表单列表。', 2)
    if (kind === 'workflow-form-clone') requirePermission(results, 'flowConfig')
    return { query: { [kind === 'workflow-form-clone' ? 'formId' : 'id']: input.formId } }
  }
  throw new RsqError('INVALID_CONTRACT', '未知流程上下文适配。')
}
export function verifyWorkflowContext(input: JsonObject, results: JsonObject, step: string) {
  if (step === 'remaining') {
    if (groups(results.remaining).some(group => Array.isArray(group.applications) && group.applications.some(value => String(asObject(value).id) === input.applicationId))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '流程应用删除后仍在可见分组中。', 5)
    return
  }
  const verified = asObject(data(results[step]))
  if (input.name !== undefined && verified.name !== input.name) throw new RsqError('BUSINESS_ASSERTION_FAILED', '流程名称未按要求持久化。', 5)
  if (asObject(results.prepared).expectedMode !== undefined && verified.mode !== asObject(results.prepared).expectedMode) throw new RsqError('BUSINESS_ASSERTION_FAILED', '新流程模式与选择的模板不一致。', 5)
  if (step === 'copiedForm') {
    const source = asObject(data(results.original)), before = list(source.fields ?? []), after = list(verified.fields ?? [])
    if (id(source.id) === id(verified.id) || before.length !== after.length || before.some((field, index) => field.name !== after[index].name || field.type !== after[index].type || id(field.id) === id(after[index].id))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '复制表单的字段数量、名称、类型或新资源 ID 不一致。', 5)
  }
}
export function describeWorkflowConfiguration(results: JsonObject) {
  return { application: data(results.source), forms: list(results.details).map(value => { const form = asObject(data(value)); return { ...form, definitionVersion: workflowDefinitionVersion(form) } }), steps: describeWorkflowDefinitionSteps(data(results.steps)), fieldTypes: workflowFieldTypes }
}
