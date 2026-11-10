import { ownSignatureFile, signatureId } from './signature.js'
import { createHash } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'
import { catalog } from './operations.js'
import { requireSession, type Session } from './session.js'
import { buildWorkflowGraph, parseWorkflowGraph } from './workflow-graph.js'
import type { Workflow } from './workflows.js'

// FieldEnum from the pinned workflow service. These are protocol types, not
// inferred URL suffixes. Schema exposes names; HTTP receives integer codes.
export const workflowFieldTypes: Record<string, number> = { Content: 1, Number: 2, Selector: 3, Menu: 4, Date: 5, File: 6, Line: 7, WorkHour: 8,
  Grade: 9, FromProject: 10, Confirm: 11, PerfScore: 12, Cost: 13, Income: 14, RichText: 15, Count: 16, Phone: 17, Email: 18, Address: 19,
  Table: 20, Check: 21, Member: 22, Task: 23, Formula: 24, StartProcess: 27, Explanation: 28, Quote: 29, PublicArea: 30,
  DataQuery: 32, DataResult: 33, QueryQuote: 34, DatasheetLink: 35, Dept: 36, UseRole: 37, Location: 38, ProcessInfoCreator: 39,
  AlterationContent: 40, AlterationReason: 41, AlterationTask: 42, AlterationBelongProject: 43, RefuseCount: 44, DatasheetModify: 45 }
const typeNames = Object.fromEntries(Object.entries(workflowFieldTypes).map(([name, type]) => [type, name]))
const get = (value: unknown) => asObject(asObject(value).data)
const array = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '流程服务未返回所需列表。', 5)
  return value.map(asObject)
}
const fields = (value: JsonObject) => array(value.fields ?? [])
const sameId = (a: unknown, b: unknown) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b)
const permission = (resource: JsonObject, key: string) => {
  if (asObject(resource.editControl)[key] !== true) throw new RsqError('FORBIDDEN', '当前流程资源不允许此操作：' + key, 4)
}
const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
function assertConfiguration(actual: unknown, expected: unknown, path: string) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) fail('配置列表读回不一致：' + path)
    expected.forEach((value, index) => assertConfiguration((actual as unknown[])[index], value, path + '/' + index)); return
  }
  if (expected && typeof expected === 'object') {
    for (const [key, value] of Object.entries(asObject(expected))) assertConfiguration(asObject(actual)[key], value, path + '/' + key)
    return
  }
  if (path.endsWith('/id') || /Id$/.test(path)) { if (!sameId(actual, expected)) fail('配置 ID 读回不一致：' + path); return }
  if (canonical(actual) !== canonical(expected)) fail('配置读回不一致：' + path)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(asObject(value)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
export const workflowDefinitionVersion = (form: JsonObject): string => createHash('sha256').update(canonical({ name: form.name, fields: form.fields })).digest('hex')
const sortedIds = (value: unknown) => (Array.isArray(value) ? value.map(item => String(asObject(item).id)) : String(value ?? '').split(',').filter(Boolean)).sort()
export function describeWorkflowDefinitionSteps(value: unknown): JsonObject[] {
  return array(value).map(step => ({ ...step,
    // StepInfoVO.userIds is local to workflow; UserVO.id is the public RSQ ID
    // accepted by ParamTransferAspect. Keep internal IDs out of business output.
    userIds: sortedIds(step.users ?? []).join(','), stepLimitUserIds: sortedIds(step.stepLimitUsers ?? []).join(','),
    deptIdentityIds: sortedIds(step.departments ?? []).join(','), groupIdentityIds: sortedIds(step.groups ?? []).join(','),
    ...(Array.isArray(step.children) && { children: describeWorkflowDefinitionSteps(step.children) }) }))
}
const formOperation = catalog.operations.find(op => op.method === 'POST' && op.route === '/task/workflow/form')!
const definitions = asObject(formOperation.inputSchema.$defs)
// Follow the actual input DTO recursively; do not spread a server VO back into
// a write, which would include values, ownership, snapshots and display state.
function requestShape(value: unknown, schema: JsonObject, depth = 0): unknown {
  if (depth > 40) throw new RsqError('CONTEXT_MISSING', '流程字段配置嵌套过深。', 5)
  if (typeof schema.$ref === 'string') return requestShape(value, asObject(definitions[schema.$ref.replace('#/$defs/', '')]), depth + 1)
  if (Array.isArray(value)) return value.map(item => requestShape(item, asObject(schema.items), depth + 1))
  if (value && typeof value === 'object') {
    const props = asObject(schema.properties)
    if (!Object.keys(props).length) return value
    return Object.fromEntries(Object.entries(asObject(value)).filter(([key, value]) => Object.hasOwn(props, key) && value !== null && value !== undefined)
      .map(([key, value]) => [key, requestShape(value, asObject(props[key]), depth + 1)]))
  }
  return value
}
const fieldSchema = asObject(definitions['Type_e07bfe3f3915'])
const flatFields = (items: JsonObject[]): JsonObject[] => items.flatMap(field => [field, ...flatFields(Array.isArray(field.tables) ? array(field.tables) : [])])
function checkDefinitionDependencies(original: JsonObject[], replacement: JsonObject[], results: JsonObject) {
  const before = flatFields(original), after = flatFields(replacement), retained = new Set(after.filter(field => field.id !== undefined).map(field => String(field.id)))
  const removed = before.filter(field => !retained.has(String(field.id)))
  if (!removed.length) return
  const all = Array.isArray(results.dependencies) ? array(results.dependencies).map(value => get(value)) : []
  const current = get(results.original)
  const candidates = [...all.filter(form => !sameId(form.id, current.id)).flatMap(fields), ...replacement]
  const factorKey = (value: unknown) => String(value).replace(/^\$_field_(.+)_\$$/, '$1')
  const removedIds = new Set(removed.map(field => String(field.id))), removedFactors = new Set(removed.flatMap(field => typeof field.factor === 'string' ? [factorKey(field.factor)] : []))
  const dependencies: JsonObject[] = []
  for (const field of flatFields(candidates)) {
    const links = array(field.quoteFields ?? [])
    if (links.some(link => removedIds.has(String(link.id)))) dependencies.push({ fieldId: field.id, name: field.name, type: 'quote' })
    if (array(field.publicFields ?? []).some(link => removedIds.has(String(link.stepFieldId).split('_').at(-1) ?? ''))) dependencies.push({ fieldId: field.id, name: field.name, type: 'public-area' })
    const inspect = (value: unknown, key = '') => {
      if (Array.isArray(value)) { value.forEach(item => inspect(item, key)); return }
      if (value && typeof value === 'object') { Object.entries(asObject(value)).forEach(([name, item]) => inspect(item, name)); return }
      if (['factor', 'factors'].includes(key) && removedFactors.has(factorKey(value)) || /^(?:fieldId|quoteFieldId)$/.test(key) && removedIds.has(String(value))) dependencies.push({ fieldId: field.id, name: field.name, type: 'formula-or-reference' })
    }
    for (const key of ['formula', 'formulaValidateList', 'queryQuoteVO', 'datasheetLinkVO']) inspect(field[key])
  }
  if (dependencies.length) throw new RsqError('DEPENDENCY_EXISTS', '待删除字段仍有公式或引用依赖；请先修改依赖字段。', 2, { dependencies })
}
function checkDefinitionOwnership(original: JsonObject[], requested: JsonObject[]) {
  const old = new Map(original.map(field => [String(field.id), field])), seen = new Set<string>()
  for (const field of requested) {
    if (field.id === undefined) { definition(field, true); continue }
    const existing = old.get(String(field.id))
    if (!existing || seen.has(String(field.id))) throw new RsqError('INVALID_INPUT', '字段 ID 重复或不属于当前表单/子表。', 2)
    seen.add(String(field.id))
    const options = new Set(array(existing.selector ?? []).map(option => String(option.id))), optionIds = new Set<string>()
    for (const option of array(field.selector ?? [])) if (option.id !== undefined) {
      if (!options.has(String(option.id)) || optionIds.has(String(option.id))) throw new RsqError('INVALID_INPUT', '选项 ID 重复或不属于当前字段。', 2)
      optionIds.add(String(option.id))
    }
    checkDefinitionOwnership(array(existing.tables ?? []), array(field.tables ?? []))
  }
}
function definition(value: JsonObject, fresh = false, depth = 0): JsonObject {
  if (depth > 15) throw new RsqError('INVALID_INPUT', '子表字段嵌套过深。', 2)
  const result = asObject(requestShape(value, fieldSchema))
  result.type = typeof value.type === 'string' ? workflowFieldTypes[value.type] : value.type
  if (!Object.hasOwn(typeNames, String(result.type))) throw new RsqError('INVALID_INPUT', '未知流程字段类型；先查询 Schema。', 2)
  if (fresh && value.id !== undefined && value.id !== null) throw new RsqError('INVALID_INPUT', '创建字段不能指定已有字段 ID。', 2)
  if (value.tables !== undefined && value.tables !== null) result.tables = array(value.tables).map(item => definition(item, fresh, depth + 1))
  if (value.selector !== undefined && value.selector !== null) result.selector = array(value.selector).map((option, index) => {
    if (fresh && option.id !== undefined && option.id !== null) throw new RsqError('INVALID_INPUT', '新字段选项不能指定已有选项 ID。', 2)
    return { ...asObject(requestShape(option, asObject(definitions['Type_7b1193ee4943']))), displayOrder: index,
      // Backend/UI use option.value, rather than option.id, as the selected value.
      value: option.value ?? option.name }
  })
  return result
}
const configuredSteps = (results: JsonObject) => {
  const output: JsonObject[] = [], seen = new Set<string>()
  const visit = (items: JsonObject[], depth: number) => {
    if (depth > 30 || output.length + items.length > 2000) throw new RsqError('CONTEXT_MISSING', '流程步骤树过深或过大。', 5)
    for (const item of items) {
      if (seen.has(String(item.id))) throw new RsqError('CONTEXT_MISSING', '流程步骤树有重复 ID。', 5)
      seen.add(String(item.id)); output.push(item)
      if (Array.isArray(item.children)) visit(array(item.children), depth + 1)
    }
  }
  visit(array(asObject(results.steps).data), 0)
  return output
}
const belongs = (input: JsonObject, results: JsonObject) => {
  if (!array(asObject(results.forms).data).some(form => sameId(form.id, input.formId))) throw new RsqError('CONTEXT_MISSING', '该表单不属于指定流程应用。', 2)
}
const selectedStep = (input: JsonObject, results: JsonObject) => {
  const step = configuredSteps(results).find(step => sameId(step.id, input.stepId))
  if (!step) throw new RsqError('CONTEXT_MISSING', '该定义步骤不属于指定应用。', 2)
  return step
}
const state = (results: JsonObject, key = 'process') => get(results[key])
function instanceStep(input: JsonObject, results: JsonObject) {
  const process = state(results), step = state(results, 'instanceStep')
  if (!sameId(process.id, input.processId) || !sameId(step.id, input.stepId) || !sameId(step.processInfoId, process.id) || !sameId(step.applicationId, process.flowAppId)
    || !array(process.processInfoStepList).some(item => sameId(item.id, step.id))) throw new RsqError('CONTEXT_MISSING', '实例步骤与当前流程上下文不一致。', 2)
  return step
}
const stepObservations = { 'workflow instance step timing': 'stepUseTimeList', 'workflow instance step tasks list': 'taskList' } as const
export function validateWorkflowStepObservation(flow: Workflow) {
  const suffix = stepObservations[flow.command as keyof typeof stepObservations]
  if (!suffix) return
  const input = (key: string) => ({ $input: '/' + key })
  const expected = [
    ['process', 'GET', '/process/info/details', { query: { processInfoId: input('processId') } }],
    ['instanceStep', 'GET', '/process/info/step', { query: { stepInfoId: input('stepId') } }],
    ['observation', 'POST', '/process/info/sheet/' + suffix, {}],
    ['observedProcess', 'GET', '/process/info/details', { query: { processInfoId: input('processId') } }],
    ['observedStep', 'GET', '/process/info/step', { query: { stepInfoId: input('stepId') } }],
  ] as const
  if (flow.executor || flow.effect !== 'read' || flow.steps.length !== expected.length || !['processId', 'stepId'].every(key => flow.inputSchema.required?.includes(key)) || expected.some(([id, method, route, args], index) => {
    const step = flow.steps[index], operation = catalog.operations.find(operation => operation.id === step.operationId)
    return step.id !== id || operation?.method !== method || operation.route !== '/task/workflow' + route || operation.effect !== 'read' || operation.idempotency !== 'idempotent' || canonical(step.input) !== canonical(args)
      || step.prepare !== (id === 'observation' ? 'workflow-lifecycle-step-' + (suffix === 'taskList' ? 'tasks' : 'timing') : undefined) || step.verify !== (id === 'observedStep' ? 'workflow-lifecycle' : undefined)
      || step.forEach || step.transfer || step.authentication || step.collectPages || step.resources || step.expectAbsent
  })) throw new RsqError('INVALID_CONTRACT', '流程步骤查询必须保留实际实例/步骤归属、定义 ID 绑定与独立上下文复核。', 6)
}
function observationBinding(input: JsonObject, results: JsonObject) {
  const step = instanceStep(input, results), process = state(results)
  const id = (value: unknown) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return String(value)
    throw new RsqError('CONTEXT_MISSING', '流程步骤查询缺少精确的实际应用或定义步骤 ID。', 5)
  }
  return { applicationId: id(step.applicationId), processId: id(process.id), stepId: id(step.id), definitionStepId: id(step.originId),
    processStatus: process.status, stepStatus: step.status, processPermissions: process.editControl, stepPermissions: step.editControl }
}
function formContext(input: JsonObject, results: JsonObject) {
  const step = instanceStep(input, results), form = state(results, 'instanceForm')
  if (step.formId !== null && step.formId !== undefined && !sameId(step.formId, form.formId)) throw new RsqError('CONTEXT_MISSING', '实例步骤的表单上下文已变化。', 5)
  return form
}
const numberTypes = new Set([2, 8, 9, 12, 13, 14, 16, 44])
const calculatedTypes = new Set([7, 10, 11, 24, 28, 30, 32, 33, 34, 39, 40, 41, 42, 43, 44, 45])
function encodeValue(field: JsonObject, value: unknown): unknown {
  const type = Number(field.type)
  if (value === null) return '' // null is a no-op in SingleValueModuleImpl.
  if (type === 3 || type === 4) {
    const options = array(field.selector ?? []), values = Array.isArray(value) ? value : [value]
    if (!field.isCheckBox && values.length > 1) throw new RsqError('INVALID_INPUT', '单选字段只能选择一个选项。', 2)
    const selected = values.map(value => {
      const matches = options.filter(option => String(option.value) === String(value) || String(option.id) === String(value) || option.name === value)
      if (matches.length !== 1) throw new RsqError('INVALID_INPUT', '选项不存在或有歧义；请使用上下文返回的唯一选项值。', 2)
      return String(matches[0].value)
    })
    return selected.join(',')
  }
  if (numberTypes.has(type) && value !== '' && (typeof value !== 'string' && typeof value !== 'number' || !Number.isFinite(Number(value)))) throw new RsqError('INVALID_INPUT', '此字段需要有限数字。', 2)
  if ([6, 22, 36, 37].includes(type)) {
    const values = Array.isArray(value) ? value : value === '' ? [] : String(value).split(',')
    if (values.some(value => !/^[1-9][0-9]*$/.test(String(value)))) throw new RsqError('INVALID_INPUT', '字段需要明确的资源 ID；请先发现成员、部门、角色或附件。', 2)
    return values.map(String).join(',')
  }
  return value
}
const simpleValue = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'object' ? canonical(value) : String(value)
const empty = (value: unknown): boolean => value === null || value === undefined || value === '' || Array.isArray(value) && !value.length
function checkRequired(field: JsonObject): boolean {
  const type = Number(field.type)
  if ([7, 19, 28].includes(type) || calculatedTypes.has(type)) return false
  if (type === 5) return empty(field.value) && empty(field.time)
  if (type === 6) return empty(field.files)
  if (type === 8) return empty(field.value) && empty(field.hours)
  if (type === 20) return empty(field.tableRows)
  if (type === 23) return empty(field.tasks)
  if (type === 27) return empty(field.list) && empty(field.processInfos)
  if (type === 29) return empty(field.quoteRows)
  if (type === 35) return empty(asObject(asObject(field.datasheetLinkVO).linkContentFieldData).value ?? field.value)
  if (type === 15) return !array(asObject(field.value).ops ?? []).some(op => typeof op.insert === 'string' && op.insert.trim() || typeof op.insert === 'object')
  return empty(field.value)
}
// The UI enforces required/type checks before an advancing operation. Keep
// these independent of the API, which accepts some otherwise invalid writes.
export function validateWorkflowFields(items: JsonObject[]) {
  const issues: JsonObject[] = []
  for (const field of items) {
    if (field.isHidden === true) continue
    if (field.isRequired === true && checkRequired(field)) issues.push({ fieldId: field.id, name: field.name, reason: 'required' })
    if (field.value && Number(field.type) === 18 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(field.value))) issues.push({ fieldId: field.id, name: field.name, reason: 'email' })
    if (field.value && Number(field.type) === 17 && !/^1[3-9][0-9]{9}$/.test(String(field.value))) issues.push({ fieldId: field.id, name: field.name, reason: 'phone' })
    if (Number(field.type) === 20) {
      const columns = array(field.tables ?? [])
      for (const row of array(field.tableRows ?? [])) {
        for (const key of Object.keys(row)) {
          const match = /^(\d+)-(\d+)$/.exec(key), column = match && columns[Number(match[2])]
          if (!column || Number(column.type) !== Number(match![1])) throw new RsqError('CONTEXT_MISSING', '子表列上下文已变化。', 5)
        }
        // Omitted required columns are still empty cells, not an exemption.
        validateWorkflowFields(columns.map((column, index) => ({ ...column, value: undefined, ...asObject(row[column.type + '-' + index]) })))
      }
    }
  }
  if (issues.length) throw new RsqError('INVALID_INPUT', '流程字段未通过必填或类型校验。', 2, { fields: issues })
}
export function prepareWorkflowLifecycle(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const action = kind.replace('workflow-lifecycle-', '')
  if (['form-create', 'form-replace', 'field-add', 'field-edit', 'field-remove', 'form-remove', 'step-create', 'step-edit', 'step-remove', 'deploy', 'graph-apply'].includes(action)) permission(get(results.source), 'flowConfig')
  if (action === 'form-context') { belongs(input, results); return { query: { id: input.formId } } }
  if (action === 'form-create') {
    const expected = { applicationId: input.applicationId, name: input.name, fields: array(input.fields).map(field => definition(field, true)) }
    results.lifecycle = { form: expected }; return { body: expected }
  }
  if (['form-replace', 'field-add', 'field-edit', 'field-remove'].includes(action)) {
    belongs(input, results)
    const original = get(results.original), version = workflowDefinitionVersion(original)
    if (input.expectedDefinition !== undefined && input.expectedDefinition !== version) throw new RsqError('CONTEXT_CONFLICT', '表单定义已变化，请重新读取后修改。', 5, { currentDefinition: version })
    let all = fields(original).map(field => definition(field))
    if (action === 'form-replace') all = array(input.fields).map(field => definition(field))
    if (action === 'field-add') all.push(definition(asObject(input.field), true))
    if (action === 'field-edit' || action === 'field-remove') {
      const index = all.findIndex(field => sameId(field.id, input.fieldId))
      if (index < 0) throw new RsqError('CONTEXT_MISSING', '字段不属于此表单。', 2)
      if (action === 'field-remove') all.splice(index, 1)
      else {
        const patch = asObject(input.patch)
        if (patch.type !== undefined && Number(patch.type) !== Number(all[index].type) && workflowFieldTypes[String(patch.type)] !== all[index].type) throw new RsqError('INVALID_INPUT', '字段类型变更需使用完整定义替换并核对依赖。', 2)
        all[index] = definition({ ...all[index], ...patch, id: all[index].id })
      }
    }
    checkDefinitionOwnership(fields(original), all)
    checkDefinitionDependencies(fields(original), all, results)
    const expected = { id: input.formId, applicationId: input.applicationId, name: input.name ?? original.name, fields: all }
    results.lifecycle = { form: expected }; return { body: expected }
  }
  if (action === 'form-remove') {
    belongs(input, results)
    if (configuredSteps(results).some(step => sameId(step.formId, input.formId))) throw new RsqError('DEPENDENCY_EXISTS', '表单仍被步骤引用；请先解除关联，再删除。', 2)
    checkDefinitionDependencies(fields(get(results.original)), [], results)
    return { query: { id: input.formId } }
  }
  if (action === 'step-create') {
    const all = configuredSteps(results)
    for (const key of ['frontId', 'nextId']) if (input[key] !== undefined && !all.some(step => sameId(step.id, input[key]))) throw new RsqError('CONTEXT_MISSING', '相邻步骤不属于此流程应用。', 2)
    return { body: { applicationId: input.applicationId, stepType: input.stepType, ...(input.name !== undefined && { name: input.name }), ...(input.frontId !== undefined && { frontId: input.frontId }), ...(input.nextId !== undefined && { nextId: input.nextId }) } }
  }
  if (action === 'step-edit' || action === 'step-remove') {
    selectedStep(input, results)
    if (action === 'step-remove') return { query: { id: input.stepId } }
    const patch = asObject(input.patch)
    if (patch.formId !== undefined && patch.formId !== null && !array(asObject(results.forms).data).some(form => sameId(form.id, patch.formId))) throw new RsqError('CONTEXT_MISSING', '要关联的表单不属于指定应用。', 2)
    results.lifecycle = { stepPatch: patch }
    return { body: { ...patch, id: input.stepId, applicationId: input.applicationId } }
  }
  if (action === 'deploy') { configuredSteps(results); return { body: { applicationId: input.applicationId } } }
  if (action === 'graph-apply') {
    const arrangement = get(results.arrangement), current = parseWorkflowGraph(arrangement.stepInfoAdjustXml)
    if (input.expectedArrangement !== undefined && input.expectedArrangement !== current.version) throw new RsqError('CONTEXT_CONFLICT', '流程编排已变化，请重新读取并核对连线。', 5)
    // Conditional combo/action-node protocols require their own context; never
    // erase them simply because the basic graph has the same userTask nodes.
    if (/branchTask_|BPMNCombo|listenerTask|actionNode/.test(String(arrangement.stepInfoAdjustXml))) throw new RsqError('DEPENDENCY_EXISTS', '当前编排含条件分组或动作节点；基础连线操作不能覆盖这些节点。', 2)
    const built = buildWorkflowGraph(get(results.source), configuredSteps(results), array(input.links))
    results.lifecycle = { graphEdges: built.edges }
    return { body: { applicationId: input.applicationId, content: built.content } }
  }
  if (action === 'start') {
    const application = get(results.source); permission(application, 'initProcess')
    if (application.mode !== 0) throw new RsqError('INVALID_INPUT', '此命令用于标准模式；请先检查应用模式及自由模式发起命令的 Schema。', 2)
    if (!configuredSteps(results).length) throw new RsqError('CONTEXT_MISSING', '流程应用还没有可执行步骤；请先配置并部署。', 2)
    return { body: { applicationId: input.applicationId, name: input.name, userId: input.userId ?? requireSession(session).identity.userId,
      ...(input.identities !== undefined && { identities: input.identities }) } }
  }
  if (action === 'instance-form') { instanceStep(input, results); return { query: { stepInfoId: input.stepId, isRefresh: false } } }
  if (['step-timing', 'step-tasks'].includes(action)) {
    const binding = observationBinding(input, results)
    results.lifecycle = { observationBinding: binding }
    return { body: { idList: [{ processInfoId: binding.processId, flowApplicationId: binding.applicationId, stepInfoId: binding.definitionStepId }] } }
  }
  if (action === 'fill') {
    const form = formContext(input, results), controls = asObject(form.editControl)
    if (controls.fillStepForm !== true && controls.modifyStepForm !== true) throw new RsqError('FORBIDDEN', '此步骤不允许当前身份填写表单。', 4)
    const field = fields(form).find(field => sameId(field.id, input.fieldId))
    if (!field) throw new RsqError('CONTEXT_MISSING', '字段不属于当前实例步骤可填写的表单。', 2)
    if (Number(field.type) === 23) throw new RsqError('BUSINESS_CONTEXT_REQUIRED', '任务字段请使用 workflow instance task 或 project workflow instance task；创建、修改、排序和删除必须先核对真实任务上下文，不能通过通用填写接口替换关联。', 2)
    if (field.isHidden === true || calculatedTypes.has(Number(field.type))) throw new RsqError('READ_ONLY_FIELD', '此字段为隐藏、系统或计算字段，不能直接填写。', 2)
    const body: JsonObject = { fieldId: field.id, stepId: input.stepId }
    if (Object.hasOwn(input, 'value')) body.value = encodeValue(field, input.value)
    for (const key of ['time', 'placeholder', 'tableRows', 'quoteRows', 'hours', 'list']) if (Object.hasOwn(input, key)) body[key] = input[key]
    if (Number(field.type) === 20 && Array.isArray(input.rows)) {
      const columns = array(field.tables ?? [])
      body.tableRows = array(input.rows).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const matches = columns.map((column, index) => ({ column, index })).filter(({ column }) => sameId(column.id, key) || column.name === key)
        if (matches.length !== 1) throw new RsqError('INVALID_INPUT', '子表列不存在或有歧义，请使用列 ID。', 2)
        const { column, index } = matches[0]
        if (calculatedTypes.has(Number(column.type))) throw new RsqError('READ_ONLY_FIELD', '子表计算列不能直接赋值。', 2)
        return [column.type + '-' + index, { id: '0', value: encodeValue(column, value) }]
      })))
    }
    if (Object.keys(body).length === 2) throw new RsqError('INVALID_INPUT', '至少提供一个待填写值；清空单值使用 value:null。', 2)
    if (Number(field.type) === 23) throw new RsqError('INVALID_INPUT', '任务字段需要创建/关联任务协议，不能直接用 value 改写。', 2)
    results.lifecycle = { fieldId: field.id, fieldType: field.type, expected: body }; return { body }
  }
  if (action === 'validate') {
    const form = formContext(input, results)
    if (get(results.actions)[String(input.action)] !== true) throw new RsqError('FORBIDDEN', '此动作当前不可执行，请重新读取实例。', 4)
    if (!['finish', 'pending', 'reaudit', 'agree', 'onlyDone'].includes(String(input.action))) return null
    validateWorkflowFields(fields(form))
    const validation = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/workflow/formulaValidate')!
    const shape = asObject(asObject(validation.inputSchema.properties).body), props = asObject(shape.properties), fieldDef = asObject(props.fields)
    // Different DTO root from FormCreate: preserve values for server validation.
    const project = (value: unknown, schema: JsonObject, depth = 0): unknown => {
      if (depth > 40) throw new RsqError('CONTEXT_MISSING', '校验上下文嵌套过深。', 5)
      if (typeof schema.$ref === 'string') return project(value, asObject(asObject(validation.inputSchema.$defs)[schema.$ref.replace('#/$defs/', '')]), depth + 1)
      if (Array.isArray(value)) return value.map(item => project(item, asObject(schema.items), depth + 1))
      if (value && typeof value === 'object' && Object.keys(asObject(schema.properties)).length) return Object.fromEntries(Object.entries(asObject(value)).filter(([key, value]) => Object.hasOwn(asObject(schema.properties), key) && value !== null).map(([key, value]) => [key, project(value, asObject(asObject(schema.properties)[key]), depth + 1)]))
      return value
    }
    return { body: { processInfoStepId: input.stepId, fields: project(fields(form).filter(field => ![15, 29].includes(Number(field.type))), fieldDef) } }
  }
  if (action === 'signature' || action === 'signature-file') {
    instanceStep(input, results)
    if (input.signatureFileId === undefined && input.useLastSignature !== true) return null
    if (!['agree', 'refuse'].includes(String(input.action))) throw new RsqError('INVALID_INPUT', '当前服务仅在同意或拒绝审核时保存签名；本动作不接受签名文件。', 2)
    if (get(results.actions)[String(input.action)] !== true) throw new RsqError('FORBIDDEN', '当前流程动作不可执行，不读取签名。', 4)
    if (action === 'signature') return { query: { fromWhere: 'workflow' } }
    const fileId = signatureId(asObject(results.signature).fileId)
    if (input.signatureFileId !== undefined && signatureId(input.signatureFileId) !== fileId) throw new RsqError('CONTEXT_CONFLICT', '所选文件不是本人最近 workflow 签名；请刷新签名上下文。', 5)
    return { query: { id: fileId } }
  }
  if (action === 'act') {
    instanceStep(input, results)
    const current = get(results.actions)
    if (current[String(input.action)] !== true) throw new RsqError('FORBIDDEN', '该动作当前不可执行；请重新读取实例步骤和允许动作。', 4, { availableActions: Object.keys(current).filter(key => current[key] === true) })
    if (Array.isArray(asObject(results.validated).data) && array(asObject(results.validated).data).length) throw new RsqError('INVALID_INPUT', '字段公式校验未通过。', 2, { fields: asObject(results.validated).data })
    const process = state(results)
    const requirement = { agree: ['isAgreeExplanation', 'isAgreeSignature'], refuse: ['isRefuseExplanation', 'isRefuseSignature'], back: ['isBackExplanation'] }[String(input.action)] ?? []
    if (process[requirement[0]] === true && !String(input.content ?? '').trim()) throw new RsqError('INVALID_INPUT', '流程配置要求填写此操作的说明。', 2)
    if (process[requirement[1]] === true && input.signatureFileId === undefined && input.useLastSignature !== true) throw new RsqError('INVALID_INPUT', '流程配置要求提供签名附件 ID。', 2)
    if (input.action === 'back' && !array(asObject(results.reverse).data).some(step => sameId(step.id, input.backStepId))) throw new RsqError('INVALID_INPUT', '退回目标不在当前可退回步骤中。', 2)
    let signatureFileId: string | undefined
    if (input.signatureFileId !== undefined || input.useLastSignature === true) {
      const actor = requireSession(session), latest = asObject(results.signature)
      signatureFileId = signatureId(latest.fileId)
      ownSignatureFile(results.signatureFile, signatureFileId, actor.identity.userId)
      if (input.signatureFileId !== undefined && signatureId(input.signatureFileId) !== signatureFileId) throw new RsqError('CONTEXT_CONFLICT', '签名上下文已改变，不提交流程。', 5)
    }
    return { body: { stepInfoId: input.stepId, action: input.action, ...(input.content !== undefined && { operateContent: input.content }), ...(signatureFileId !== undefined && { signatureFileId }), ...(input.backStepId !== undefined && { backStepInfoId: input.backStepId }) } }
  }
  if (action === 'close' || action === 'reopen') {
    const process = state(results); permission(process, action === 'close' ? 'closeProcess' : 'restartProcess')
    if (process.status !== (action === 'close' ? 'doing' : 'suspended')) throw new RsqError('INVALID_INPUT', '当前流程状态不允许关闭或重启。', 2)
    results.lifecycle = { processStatus: action === 'close' ? 'suspended' : 'doing' }
    return action === 'close' ? { body: { id: input.processId } } : { query: { processInfoId: input.processId } }
  }
  if (action === 'transfer') {
    const step = instanceStep(input, results); permission(step, 'transferStep')
    if (array(step.stepUsers ?? []).some(user => sameId(user.id, input.userId))) throw new RsqError('INVALID_INPUT', '目标已经是当前步骤执行人。', 2)
    return { body: { processInfoStepId: input.stepId, transferUserId: input.userId, position: 'step' } }
  }
  throw new RsqError('INVALID_CONTRACT', '未知流程生命周期适配：' + action)
}
export function verifyWorkflowLifecycle(input: JsonObject, results: JsonObject, step: string) {
  const expected = asObject(results.lifecycle)
  if (step === 'observedStep') {
    const binding = asObject(expected.observationBinding), refreshed = observationBinding(input, { process: results.observedProcess, instanceStep: results.observedStep })
    if (canonical(binding) !== canonical(refreshed)) throw new RsqError('CONTEXT_CONFLICT', '步骤查询期间状态、归属或权限发生变化，请重新发现。', 5)
    const key = [binding.applicationId, binding.processId, binding.definitionStepId].join('-'), response = get(results.observation)
    if (Object.keys(response).length !== 1 || !Object.hasOwn(response, key)) fail('流程步骤查询返回缺失或额外业务上下文。')
    const value = response[key]
    if (!(Array.isArray(value) || value !== null && typeof value === 'object')) fail('流程步骤查询返回值不完整。')
    expected.stepObservation = { applicationId: binding.applicationId, processId: binding.processId, stepId: binding.stepId, definitionStepId: binding.definitionStepId,
      ...(Array.isArray(value) ? { tasks: value, ordering: 'server-field-and-display-order' } : { timing: value }),
      proof: { actualInstanceBound: true, definitionStepDerived: true, contextReadBack: true, transport: 'http', uiSocketRequired: false } }
  }
  if (step === 'verifiedGraph') {
    const actual = parseWorkflowGraph(get(results[step]).stepInfoAdjustXml)
    const edges = new Set(actual.edges.map(edge => edge.from + '>' + edge.to))
    if (array(expected.graphEdges).some(edge => !edges.has(edge.from + '>' + edge.to))) fail('流程编排保存后独立读取的连线不一致。')
  }
  if (step === 'verifiedForm') {
    const actual = get(results[step]), requested = asObject(expected.form), after = fields(actual), wanted = array(requested.fields)
    if (actual.name !== requested.name || after.length !== wanted.length) fail('表单名称或字段数量未按要求持久化。')
    for (let index = 0; index < wanted.length; index++) {
      if (wanted[index].name !== after[index].name || Number(wanted[index].type) !== Number(after[index].type) || wanted[index].id !== undefined && !sameId(wanted[index].id, after[index].id)) fail('表单字段名称、类型、顺序或 ID 与请求不一致。')
      for (const key of ['isRequired', 'isHidden', 'placeholder', 'unit', 'decimalNum']) if (Object.hasOwn(wanted[index], key) && wanted[index][key] !== after[index][key]) fail('表单字段配置未按要求持久化。')
      if (Array.isArray(wanted[index].selector) && canonical(array(wanted[index].selector).map(option => [option.name, option.value])) !== canonical(array(after[index].selector).map(option => [option.name, option.value]))) fail('字段选项未按要求持久化。')
      assertConfiguration(after[index], wanted[index], '/fields/' + index)
    }
  }
  if (step === 'verifiedSteps') {
    const selected = configuredSteps({ steps: results[step] }).find(item => sameId(item.id, input.stepId ?? get(results.created).id))
    if (results.removed !== undefined) { if (selected) fail('定义步骤删除后仍然存在。'); return }
    if (!selected) return fail('写入的定义步骤未出现在独立读取的步骤树中。')
    const publicLists: Record<string, string> = { userIds: 'users', stepLimitUserIds: 'stepLimitUsers', deptIdentityIds: 'departments', groupIdentityIds: 'groups', applicationIdentityIds: 'applicationIdentities' }
    for (const [key, value] of Object.entries(asObject(expected.stepPatch))) {
      if (publicLists[key]) { if (canonical(sortedIds(value)) !== canonical(sortedIds(selected[publicLists[key]] ?? []))) fail('步骤人员或角色读回不一致：' + key); continue }
      if (key === 'stepInfoLimitTimeVO' || key === 'aiConfig') { assertConfiguration(selected[key], value, '/' + key); continue }
      if (key.endsWith('Id') ? value === null ? selected[key] !== null : !sameId(value, selected[key]) : canonical(value) !== canonical(selected[key])) fail('步骤配置读回不一致：' + key)
    }
  }
  if (step === 'verifiedValue') {
    const expectedBody = asObject(expected.expected), field = fields(get(results[step])).find(field => sameId(field.id, expected.fieldId))
    if (!field) return fail('读回未找到所填写字段。')
    for (const key of ['value', 'time', 'placeholder']) if (Object.hasOwn(expectedBody, key) && simpleValue(field[key]) !== simpleValue(expectedBody[key])) fail('流程字段写入后读回值不一致。')
    if (Array.isArray(expectedBody.tableRows) && array(field.tableRows ?? []).length !== expectedBody.tableRows.length) fail('子表写入后行数不一致。')
  }
  if (step === 'verifiedProcess') {
    const actual = state(results, step)
    if (expected.processStatus !== undefined && actual.status !== expected.processStatus) fail('流程关闭/重启后状态不一致。')
    if (results.started !== undefined && (!sameId(actual.flowAppId, input.applicationId) || actual.name !== input.name)) fail('新实例的应用或名称不一致。')
    if (results.acted !== undefined) {
      const response = get(results.acted), changedStep = array(actual.processInfoStepList).find(item => sameId(item.id, input.stepId))
      if (response.processStatus && actual.status !== response.processStatus || response.currentStepStatus && changedStep?.status !== response.currentStepStatus) fail('流程动作返回状态与独立读回不一致。')
    }
  }
}
export function describeWorkflowArrangement(results: JsonObject) {
  const arrangement = get(results.verifiedGraph ?? results.arrangement), parsed = parseWorkflowGraph(arrangement.stepInfoAdjustXml)
  const publicId = (value: string) => value === 'startEvent1' ? 'start' : value === 'endEvent1' ? 'end' : value.startsWith('userTask') ? value.slice(8) : value
  return { applicationId: get(results.source).id, arrangementVersion: parsed.version, steps: describeWorkflowDefinitionSteps(asObject(results.steps).data),
    links: parsed.edges.map(edge => ({ from: publicId(edge.from), to: publicId(edge.to) })), conditions: arrangement.stepInfoConditionList ?? [],
    hasConditionalOrActionNodes: /branchTask_|BPMNCombo|listenerTask|actionNode/.test(String(arrangement.stepInfoAdjustXml)) }
}
export function describeWorkflowInstance(results: JsonObject) {
  const process = get(results.process), details = array(results.stepDetails), forms = array(results.instanceForms), actions = array(results.stepActions)
  return { ...process, steps: array(process.processInfoStepList).map((step, index) => ({ ...step, detail: get(details[index]), form: get(forms[index]),
    actions: Object.fromEntries(Object.entries(get(actions[index])).filter(([key, value]) => value === true && ['finish', 'pending', 'reaudit', 'agree', 'refuse', 'reverse', 'skip', 'back', 'onlyDone', 'cancelDone'].includes(key))) })), fieldTypes: workflowFieldTypes }
}
