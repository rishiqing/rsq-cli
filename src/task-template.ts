import { createHash, randomUUID } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'
import { catalog } from './operations.js'
import { buildHoursMutation, verifyTaskHours } from './task-hours.js'
import type { Session } from './session.js'
import { verifyTaskBusiness } from './task-business.js'
import { normalizeTaskDefaultDefinition, projectTaskValues, verifyProjectTaskChildren } from './task-create-defaults.js'
import { taskLabels } from './task-personal-labels.js'

export const taskFieldTypes: Record<string, number> = { Content: 1, Number: 2, Selector: 3, Menu: 4, Date: 5, File: 6, Line: 7, WorkHour: 8, Grade: 9,
  FromProject: 10, Confirm: 11, PerfScore: 12, Cost: 13, Income: 14, RichText: 15, Count: 16, Address: 19, Table: 20, Member: 22, Formula: 24,
  Progress: 25, SupportOkr: 26, StartProcess: 27, Explanation: 28, Audit: 31, QueryQuote: 34, DatasheetLink: 35, Dept: 36 }
// form-field/helper.ts getSelfEditList. Audit has node/button permissions;
// formulas and query references do not acquire ordinary editable-field roles.
const controlledFieldTypes = new Set([1,2,3,4,5,6,8,9,10,12,13,14,15,16,19,20,22,25,26,27,35,36])
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '任务模板上下文缺少列表。', 5); return value.map(asObject) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(asObject(value)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
export const taskTemplateVersion = (value: JsonObject) => createHash('sha256').update(canonical({ name: value.name, icon: value.icon, fields: value.fields, defaultValues: value.defaultValues, auths: value.auths })).digest('hex')
const templateOp = () => catalog.operations.find(op => op.route === '/task/api/v3/template' && op.method === 'PUT')!
function shape(value: unknown, schema: JsonObject, depth = 0): unknown {
  if (depth > 50) throw new RsqError('INVALID_INPUT', '任务字段嵌套过深。', 2)
  if (value === null || value === undefined) return value
  if (typeof schema.$ref === 'string') return shape(value, asObject(asObject(templateOp().inputSchema.$defs)[schema.$ref.split('/').at(-1)!]), depth + 1)
  if (Array.isArray(schema.anyOf)) return shape(value, asObject(schema.anyOf.find(item => asObject(item).type !== 'null')), depth + 1)
  if (Array.isArray(value)) return value.map(item => shape(item, asObject(schema.items), depth + 1))
  if (value && typeof value === 'object' && schema.properties) return Object.fromEntries(Object.entries(asObject(value)).filter(([key, item]) => {
    const property = asObject(asObject(schema.properties)[key])
    if (!Object.hasOwn(asObject(schema.properties), key)) return false
    // VOs include null for every unused field-type option. Omission binds the
    // same null on a new DTO and avoids forwarding response-only placeholders.
    return item !== null || property.type === 'null' || Array.isArray(property.type) && property.type.includes('null') || Array.isArray(property.anyOf) && property.anyOf.some(value => asObject(value).type === 'null')
  }).map(([key, item]) => [key, shape(item, asObject(asObject(schema.properties)[key]), depth + 1)]))
  return value
}
const bodySchema = () => asObject(asObject(templateOp().inputSchema.properties).body)
function definition(value: JsonObject, fresh = false): JsonObject {
  const field = structuredClone(value), type = typeof field.type === 'string' ? taskFieldTypes[field.type] : field.type
  if (!Number.isInteger(type) || ![...Object.values(taskFieldTypes), 17, 18].includes(Number(type))) throw new RsqError('INVALID_INPUT', '未知任务字段类型；请先查询 Schema。', 2)
  if (fresh && field.id != null) throw new RsqError('INVALID_INPUT', '新字段不接受已有字段 ID。', 2)
  field.type = type
  if (field.id == null && controlledFieldTypes.has(Number(type)) && !field.authId) field.authId = randomUUID().replaceAll('-', '')
  if (Array.isArray(field.selector)) {
    const options = rows(field.selector), used = new Set<string>()
    let maximum = options.reduce((maximum, option) => typeof option.value === 'string' && /^[1-9][0-9]*$/.test(option.value) && BigInt(option.value) > maximum ? BigInt(option.value) : maximum, 0n)
    field.selector = options.map(option => {
      if (fresh && option.id != null) throw new RsqError('INVALID_INPUT', '新选项不接受已有选项 ID。', 2)
      const value = option.value ?? (++maximum).toString()
      if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 9223372036854775807n || used.has(value)) throw new RsqError('INVALID_INPUT', '任务选项内部值须为不重复的正整数串；省略 value 由 CLI 按 UI 规则生成。', 2)
      used.add(value); return { ...option, value }
    })
  }
  if (Array.isArray(field.tables)) field.tables = rows(field.tables).map(child => definition(child, fresh))
  return asObject(shape(field, asObject(asObject(asObject(templateOp().inputSchema.$defs)['Type_b34e6032bd4c']))))
}
function ownership(before: JsonObject[], after: JsonObject[]) {
  const seen = new Set<string>()
  for (const field of after) {
    if (field.id == null) { definition(field, true); continue }
    const original = before.find(item => same(item.id, field.id))
    if (!original || seen.has(String(field.id))) throw new RsqError('INVALID_INPUT', '字段 ID 不属于当前模板或出现重复。', 2)
    seen.add(String(field.id))
    if (original.authId !== field.authId) throw new RsqError('INVALID_INPUT', '已有字段的权限标识不能修改。', 2)
    if (Number(original.type) !== Number(field.type)) throw new RsqError('INVALID_INPUT', '已有字段不能直接变更类型；请显式新增并处理旧字段依赖。', 2)
    const options = new Set<string>()
    for (const option of rows(field.selector ?? [])) if (option.id != null) {
      if (!rows(original.selector ?? []).some(item => same(item.id, option.id) && item.value === option.value) || options.has(String(option.id))) throw new RsqError('INVALID_INPUT', '选项 ID 不属于当前字段、重复或改变了已有内部值。', 2)
      options.add(String(option.id))
    }
    ownership(rows(original.tables ?? []), rows(field.tables ?? []))
  }
}
const flatten = (fields: JsonObject[]): JsonObject[] => fields.flatMap(field => [field, ...flatten(rows(field.tables ?? []))])
// form-editor/store.js saveAuthList preserves system permissions and projects
// new top-level field permissions using createInitAuthListByField defaults.
function fieldAuths(original: JsonObject, before: JsonObject[], after: JsonObject[]): JsonObject {
  if (!Array.isArray(asObject(original.auths).elements)) throw new RsqError('CONTEXT_MISSING', '模板权限表缺失，不能在未知权限基础上修改字段。', 2)
  const existing = rows(asObject(original.auths).elements), beforeIds = new Set(before.filter(field => controlledFieldTypes.has(Number(field.type))).map(field => String(field.authId)))
  const belongs = (authId: unknown, ids: Set<string>) => [...ids].some(id => authId === id || String(authId).startsWith(id + '_'))
  const elements = existing.filter(entry => !belongs(entry.authId, beforeIds))
  const seen = new Set(elements.map(entry => String(entry.authId)))
  for (const field of after.filter(field => controlledFieldTypes.has(Number(field.type)))) {
    if (typeof field.authId !== 'string' || !field.authId) throw new RsqError('CONTEXT_MISSING', '字段缺少权限标识，请重新读取定义。', 2)
    const authIds = Number(field.type) === 8 ? [field.authId + '_plan', field.authId + '_real'] : [field.authId]
    for (const authId of authIds) {
      if (seen.has(authId)) throw new RsqError('INVALID_INPUT', '字段权限标识重复。', 2)
      seen.add(authId)
      const previous = existing.find(entry => entry.authId === authId)
      if (!previous && before.some(item => same(item.id, field.id))) continue
      elements.push(previous ?? { authId, authName: field.name, creator: { editStatus: true }, principal: { editStatus: true }, executor: { editStatus: true }, participant: { editStatus: false }, confirmer: { editStatus: false }, projectRole: { editStatus: false, roleIdList: [] } })
    }
  }
  return { elements }
}
function dependencies(before: JsonObject[], after: JsonObject[]) {
  const factorKey = (value: unknown) => String(value).replace(/^\$_field_(.+)_\$$/, '$1')
  const ids = new Set(flatten(after).map(field => String(field.id))), factors = new Set(flatten(before).filter(field => !ids.has(String(field.id))).map(field => factorKey(field.factor)).filter(value => value !== 'undefined'))
  for (const field of flatten(after)) for (const factor of rowsOrScalars(asObject(field.formula).factors)) if (factors.has(factorKey(factor))) throw new RsqError('DEPENDENCY_EXISTS', '待删字段仍被公式引用。', 2, { fieldId: field.id, name: field.name })
  for (const type of [8, 12, 31]) if (flatten(after).filter(field => field.type === type).length > 1) throw new RsqError('INVALID_INPUT', '此任务字段类型只能添加一个。', 2, { type })
}
function rowsOrScalars(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function project(input: JsonObject, results: JsonObject) {
  const actual = asObject(results.project)
  if (input.projectId !== undefined && !same(actual.id, input.projectId)) throw new RsqError('CONTEXT_MISSING', '项目不属于当前可访问上下文。', 2)
  if (input.projectId !== undefined) {
    if (!Object.hasOwn(actual, 'coverId')) throw new RsqError('CONTEXT_MISSING', '项目未声明普通项目或模板封面归属，不能猜测目标类型。', 5)
    if (actual.coverId !== null) {
      const cover = asObject(results.templateBoundary)
      if (!same(cover.id, actual.coverId) || !same(cover.templateKanbanId, actual.id)) throw new RsqError('CONTEXT_MISMATCH', '该对象是项目模板；使用 project template 命令读取封面与模板项目上下文。', 4)
    }
  }
  return actual
}
function selected(input: JsonObject, results: JsonObject, write = false) {
  const item = rows(results.available).find(item => same(item.id, input.templateId))
  if (!item) throw new RsqError('CONTEXT_MISSING', '模板不在指定项目或公司可见列表中。', 2)
  if (write) {
    const company = asObject(results.company).taskTypeManager === true, local = asObject(project(input, results).editControl).kanbanTaskTypeManager === true
    if (!company && (item.type !== 'kanban' || !local)) throw new RsqError('FORBIDDEN', '当前身份没有此范围的任务类型管理权。', 4)
  }
  return item
}
function task(input: JsonObject, results: JsonObject) {
  const current = asObject(results.task)
  if (!same(current.id, input.taskId)) throw new RsqError('CONTEXT_MISSING', '任务 ID 与上下文不一致。', 2)
  if (input.projectId !== undefined && !same(asObject(current.from).projectId, input.projectId)) throw new RsqError('CONTEXT_MISSING', '任务不属于指定项目。', 2)
  if (current.forbidEdit === true) throw new RsqError('FORBIDDEN', '当前任务禁止编辑。', 4)
  return current
}
function taskPermissions(input: JsonObject, results: JsonObject) {
  task(input, results)
  const permissions = asObject(results.taskPermissions)
  if (!same(permissions.taskId, input.taskId) || !same(permissions.siteId, input.projectId) || permissions.module !== 'project') throw new RsqError('CONTEXT_MISSING', '任务操作权限不属于当前任务和项目上下文。', 2)
  return permissions
}
function allowed(current: JsonObject, key: string) {
  if (asObject(current.editControl)[key] !== true) throw new RsqError('FORBIDDEN', '当前资源不允许此操作：' + key, 4)
}
function moduleContext(input: JsonObject, results: JsonObject) {
  project(input, results)
  const module = rows(results.modules).find(item => same(item.id, input.moduleId) && ['task', 'todo', 'kanban'].includes(String(item.type)))
  if (!module) throw new RsqError('CONTEXT_MISSING', '目标任务模块不属于指定项目。', 2)
  return module
}
function calendarDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new RsqError('INVALID_INPUT', '里程碑日期必须为有效的 YYYY-MM-DD。', 2)
}
function value(field: JsonObject, input: unknown): unknown {
  const type = Number(field.type)
  if ([3, 4].includes(type)) {
    if (input === null || input === '') return ''
    const picked = Array.isArray(input) ? input : [input]
    if (field.isCheckBox !== true && picked.length > 1) throw new RsqError('INVALID_INPUT', '当前字段仅允许一个选项。', 2)
    return picked.map(item => {
      const matches = rows(field.selector ?? []).filter(option => [option.id, option.name, option.value].some(candidate => same(candidate, item)))
      if (matches.length !== 1) throw new RsqError('INVALID_INPUT', '选项不存在或不唯一，请先读取 task field inspect。', 2)
      return matches[0].value
    }).join(',')
  }
  if (input === null) return ''
  if ([2, 9, 13, 14].includes(type) && input !== '' && (typeof input !== 'number' || !Number.isFinite(input))) throw new RsqError('INVALID_INPUT', '数字字段需要有限数值。', 2)
  if ([6, 22, 36].includes(type) && input !== '' && (typeof input !== 'string' || !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(input))) throw new RsqError('INVALID_INPUT', '成员、部门和附件请使用已发现的 ID。', 2)
  if ([7, 10, 16, 24, 25, 26, 27, 28, 31, 34, 35].includes(type) || field.isHidden === true) throw new RsqError('READ_ONLY_FIELD', '此字段需要计算、关联或审批业务操作，不能以普通值覆盖。', 2)
  return input
}
function attachmentField(input: JsonObject, results: JsonObject, source = 'values') {
  task(input, results)
  const field = rows(asObject(results[source]).templateFields).find(field => same(field.id, input.fieldId))
  if (!field || Number(field.type) !== 6 || field.isHidden === true) throw new RsqError('INVALID_INPUT', '请从 task field inspect 选择当前任务可见的附件字段。', 2)
  return field
}
function attachmentIds(field: JsonObject): string[] {
  const files = rows(field.files ?? [])
  const ids = files.map(file => String(file.id))
  if (ids.some(id => !/^[1-9][0-9]*$/.test(id)) || new Set(ids).size !== ids.length) throw new RsqError('CONTEXT_MISSING', '当前附件列表缺少唯一的文件 ID。', 5)
  return ids
}
// Callers must first prove the native task belongs to this actual business scope.
// Encoding field values is shared; project/replay visibility and permissions are not.
export function prepareTaskFieldMutation(input: JsonObject, results: JsonObject, session: Session | null, where: { module: 'project' | 'objectiveReplay'; siteId: string }): JsonObject | null {
  const current = asObject(results.task)
  if (!same(current.id, input.taskId)) throw new RsqError('CONTEXT_MISSING', '字段上下文与实际任务 ID 不一致。', 2)
  if (current.forbidEdit === true) throw new RsqError('FORBIDDEN', '当前任务不允许修改字段。', 4)
  const field = rows(asObject(results.values).templateFields).find(field => same(field.id, input.fieldId))
  if (!field) throw new RsqError('CONTEXT_MISSING', '字段不在当前任务的可见字段中。', 2)
  if (Number(field.type) === 8) {
    if (!Array.isArray(input.hours) || ['value', 'time', 'placeholder', 'list', 'tableRows'].some(key => Object.hasOwn(input, key))) throw new RsqError('INVALID_INPUT', '工时请使用 hours 增量记录或 task hours 命令，不可用普通字段值覆盖。', 2)
    const hours = buildHoursMutation(field, input, results, session)
    results.taskContext = { fieldId: input.fieldId }
    return hours ? { body: { taskId: input.taskId, taskTemplateFieldId: input.fieldId, ...where, hours } } : null
  }
  if (Object.hasOwn(input, 'hours')) throw new RsqError('INVALID_INPUT', '仅工时字段接受 hours，不能将工时协议用于其他字段。', 2)
  allowed(field, 'canEdit')
  const body: JsonObject = { taskId: input.taskId, taskTemplateFieldId: input.fieldId, ...where }
  for (const key of ['value', 'time', 'placeholder', 'list', 'tableRows']) if (Object.hasOwn(input, key)) body[key] = key === 'value' ? value(field, input[key]) : input[key]
  if (Object.keys(body).length === 4) throw new RsqError('INVALID_INPUT', '至少提供一个需要填写或清空的值。', 2)
  results.taskContext = { fieldId: input.fieldId, expected: body }
  return { body }
}
export function prepareTaskTemplate(kind: string, input: JsonObject, results: JsonObject, session: Session | null = null): JsonObject | null {
  const action = kind.replace('task-context-', '')
  if (action === 'template-cover') {
    const actual = asObject(results.project), coverId = actual.coverId
    if (!same(actual.id, input.projectId) || !(typeof coverId === 'string' && /^[1-9][0-9]*$/.test(coverId) || typeof coverId === 'number' && Number.isSafeInteger(coverId) && coverId > 0)) throw new RsqError('CONTEXT_MISMATCH', '模板操作必须使用当前封面对应的模板项目 ID；普通项目不能作为模板。', 4)
    return { query: { id: String(coverId) } }
  }
  if (action.startsWith('attachment-')) {
    const field = attachmentField(input, results), existing = attachmentIds(field)
    if (action === 'attachment-list') return { query: { taskId: input.taskId, module: 'project', siteId: input.projectId } }
    allowed(field, 'canEdit')
    const local = asObject(results.localUpload)
    if (action === 'attachment-check') {
      if (typeof local.name !== 'string' || typeof local.md5 !== 'string') throw new RsqError('CONTEXT_MISSING', '附件缺少已读取的本地文件摘要。', 5)
      results.taskAttachment = { originalIds: existing }
      return { query: { fileName: local.name } }
    }
    if (action === 'attachment-second-pass') {
      if (asObject(results.uploadCheck).canUpload !== true) throw new RsqError('FORBIDDEN', '当前文件扩展名不允许直接上传，请先打包为支持的文件。', 4)
      return { body: { fileName: local.name, md5: local.md5, folderId: 'all', taskId: input.taskId } }
    }
    if (action === 'attachment-remove') {
      if (!existing.includes(String(input.fileId))) throw new RsqError('CONTEXT_MISSING', '待移除附件不属于此任务字段。', 2)
      results.taskAttachment = { expectedIds: existing.filter(id => id !== input.fileId) }
      return prepareTaskTemplate('task-context-field-set', { ...input, value: existing.filter(id => id !== input.fileId).join(',') }, results)
    }
    const second = asObject(results.secondPass)
    if (typeof second.secondPass !== 'boolean') throw new RsqError('CONTEXT_MISSING', '附件秒传结果未知，停止写入并核对。', 5)
    if (action === 'attachment-certificate') return second.secondPass ? null : { query: { type: 'file' } }
    if (action === 'attachment-register') {
      if (second.secondPass) return null
      const stored = asObject(results.stored)
      if (typeof stored.path !== 'string' || stored.md5 !== local.md5 || stored.size !== local.size) throw new RsqError('CONTEXT_MISSING', '附件没有已完成的字节上传结果，不能登记存储路径。', 5)
      return { body: { fileName: local.name, filePath: stored.path, folderId: 'all', taskId: input.taskId } }
    }
    const fileId = String(asObject(second.secondPass ? second.file : results.changed).id)
    if (!/^[1-9][0-9]*$/.test(fileId)) throw new RsqError('CONTEXT_MISSING', '已上传附件缺少真实文件 ID；请核对已完成步骤。', 5)
    results.prepared = { resources: { fileId } }
    if (action === 'attachment-file') return { query: { id: fileId } }
    if (action === 'attachment-latest') return { query: { taskId: input.taskId, module: 'project', siteId: input.projectId } }
    if (action === 'attachment-bind') {
      const file = asObject(results.file), latest = attachmentField(input, results, 'latestValues')
      if (!same(file.id, fileId) || file.name !== local.name || Number(file.size) !== local.size) throw new RsqError('BUSINESS_ASSERTION_FAILED', '附件登记后文件 ID、名称或字节数不一致；不会继续关联。', 5)
      if (canonical(attachmentIds(latest)) !== canonical(asObject(results.taskAttachment).originalIds)) throw new RsqError('CONTEXT_CONFLICT', '上传期间附件集合已变化；已保存文件 ID 已返回，请重新核对后显式关联，勿重复上传。', 5)
      const expectedIds = [...new Set([...existing, fileId])]
      results.taskAttachment = { ...asObject(results.taskAttachment), expectedIds }
      const latestContext: JsonObject = { ...results, values: results.latestValues }
      const request = prepareTaskTemplate('task-context-field-set', { ...input, value: expectedIds.join(',') }, latestContext)
      results.taskContext = latestContext.taskContext
      return request
    }
    throw new RsqError('INVALID_CONTRACT', '未知附件上下文适配。', 6)
  }
  if (action.startsWith('card-template-')) {
    const args = prepareTaskTemplate('task-context-card-' + action.slice('card-template-'.length), input, results)
    return args && { ...args, headers: { 'Plan-Type': 'template' } }
  }
  if (action === 'card-permissions') { moduleContext(input, results); return { query: { planId: input.moduleId } } }
  if (action.startsWith('card-')) {
    if (['card-create', 'card-rename'].includes(action) && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw new RsqError('INVALID_INPUT', '卡片名须非空且不超过80个 UTF-16 长度单位；表情字符可能占两个单位。', 2)
    moduleContext(input, results)
    if (action === 'card-module') return { query: { id: input.moduleId } }
    if (action === 'card-list') return { query: { kanbanChildId: input.moduleId } }
    const detail = asObject(results.moduleDetail)
    if (!same(detail.id, input.moduleId)) throw new RsqError('CONTEXT_MISSING', '卡片模块详情与目标不一致。', 2)
    if (action === 'card-create') { allowed(detail, 'createKanbanCard'); return { body: { kanbanChildId: input.moduleId, name: input.name, position: input.position ?? 'bottom' } } }
    const card = rows(results.cards).find(item => same(item.id, input.cardId))
    if (!card) throw new RsqError('CONTEXT_MISSING', '卡片不属于指定项目模块。', 2)
    if (action === 'card-get') return { query: { id: input.cardId } }
    if (action === 'card-rename') { allowed(card, 'editKanbanCardName'); return { body: { id: input.cardId, name: input.name } } }
    if (action === 'card-remove') { allowed(card, 'removeKanbanCard'); return { query: { id: input.cardId } } }
    throw new RsqError('INVALID_CONTRACT', '未知项目卡片上下文适配。', 6)
  }
  if (action === 'list') { project(input, results); return { query: input.projectId === undefined ? {} : { id: input.projectId } } }
  if (action === 'get') { selected(input, results); return { query: { id: input.templateId } } }
  if (action === 'default-label-catalogue' || action === 'default-label-catalogue-if-needed') {
    if (action === 'default-label-catalogue-if-needed' && !Object.hasOwn(asObject(asObject(input.patch).defaultValues), 'label')) return null
    project(input, results); selected(input, results)
    if (input.projectId == null) throw new RsqError('INVALID_INPUT', '默认项目标签需要明确项目上下文；使用 task template 或 project template task-type 的 labels 命令。', 2)
    return { query: { kanbanId: input.projectId } }
  }
  if (action === 'default-label-cover-fresh') {
    const current = asObject(results.defaultLabelProjectFresh)
    if (!same(current.id, input.projectId) || !Object.hasOwn(current, 'coverId')) throw new RsqError('CONTEXT_MISMATCH', '默认标签写前项目上下文不完整。', 5)
    return current.coverId == null ? null : { query: { id: String(current.coverId) } }
  }
  if (action === 'permissions') { task(input, results); return { query: { taskId: input.taskId, module: 'project', siteId: input.projectId } } }
  if (action === 'values') { project(input, results); task(input, results); return { query: { taskId: input.taskId, module: 'project', siteId: input.projectId } } }
  if (action === 'create') {
    const company = asObject(results.company).taskTypeManager === true, companyScope = input.projectId === undefined
    if (companyScope ? !company : !company && asObject(project(input, results).editControl).kanbanTaskTypeManager !== true) throw new RsqError('FORBIDDEN', '当前身份没有此范围的任务类型创建权。', 4)
    return { body: { name: input.name, icon: input.icon ?? 1, type: companyScope ? 'company' : 'kanban', ...(companyScope ? {} : { kanbanId: input.projectId }) } }
  }
  if (['configure', 'default-labels', 'field-add', 'field-edit', 'field-remove', 'remove', 'default', 'availability'].includes(action)) {
    const item = selected(input, results, action !== 'default'), original = asObject(results.original)
    if (!same(original.id, input.templateId)) throw new RsqError('CONTEXT_MISSING', '模板详细定义 ID 与上下文不一致。', 2)
    if (input.expectedDefinition !== undefined && input.expectedDefinition !== taskTemplateVersion(original)) throw new RsqError('CONTEXT_CONFLICT', '任务模板已变化，请重新读取并核对配置。', 5)
    if (action === 'default-labels') {
      const identity = asObject(results.defaultLabelIdentityFresh)
      if (!session || String(identity.id) !== session.identity.userId || String(asObject(identity.team).id ?? '') !== String(session.identity.teamId ?? '')) throw new RsqError('IDENTITY_CHANGED', '默认标签写前身份或公司已变化。', 3)
      if (!same(asObject(results.defaultLabelProjectFresh).id, input.projectId) || asObject(results.defaultLabelProjectFresh).coverId !== asObject(results.project).coverId) throw new RsqError('CONTEXT_CONFLICT', '默认标签写前项目或模板归属已变化。', 5)
      const fresh = { ...results, project: results.defaultLabelProjectFresh, company: results.defaultLabelCompanyFresh, available: results.defaultLabelAvailableFresh, templateBoundary: results.defaultLabelCoverFresh }
      selected(input, fresh, true)
      const cover = asObject(results.defaultLabelCoverFresh)
      if (asObject(fresh.project).coverId != null && (!same(cover.id, asObject(fresh.project).coverId) || !same(cover.templateKanbanId, input.projectId) || cover.withEdit !== true)) throw new RsqError('FORBIDDEN', '项目模板当前不可编辑，未修改默认标签。', 4)
      if (taskTemplateVersion(asObject(results.defaultLabelDefinitionFresh)) !== taskTemplateVersion(original) || canonical(taskLabels(results.defaultLabelsFresh).sort((a, b) => String(a.id).localeCompare(String(b.id)))) !== canonical(taskLabels(results.defaultLabels).sort((a, b) => String(a.id).localeCompare(String(b.id))))) throw new RsqError('CONTEXT_CONFLICT', '任务类型定义或项目标签库在写前已变化；未发送更新。', 5)
    }
    if (action === 'availability') {
      project(input, results)
      if (input.stopped === true && item.isDefault === true) throw new RsqError('INVALID_INPUT', '当前项目默认任务类型不能停用，请先显式选择另一个默认类型。', 2)
      return { body: { id: input.templateId, kanbanId: input.projectId, isStop: input.stopped } }
    }
    if (action === 'remove') {
      if (item.type === 'system' || original.isDefault === true) throw new RsqError('INVALID_INPUT', '系统默认任务模板不能删除。', 2)
      if (input.transferTemplateId !== undefined && (!rows(results.available).some(target => same(target.id, input.transferTemplateId) && target.isStop !== true) || same(input.templateId, input.transferTemplateId))) throw new RsqError('INVALID_INPUT', '迁移目标不在当前可用模板中或指向自己。', 2)
      return { query: { id: input.templateId, ...(input.transferTemplateId !== undefined && { transferTaskTemplateId: input.transferTemplateId }) } }
    }
    if (action === 'default') { allowed(project(input, results), 'setKanbanDefTaskType'); if (item.isStop === true) throw new RsqError('INVALID_INPUT', '停用模板不能设为默认。', 2); return { body: { id: input.templateId, kanbanId: input.projectId, isDefault: true } } }
    if (action === 'default-labels' && (!Array.isArray(input.labelIds) || input.labelIds.some(value => typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) || new Set(input.labelIds).size !== input.labelIds.length)) throw new RsqError('INVALID_INPUT', '默认标签须为精确、不重复的项目标签 ID 数组；[] 清空。', 2)
    const patch: JsonObject = action === 'default-labels' ? { defaultValues: { label: { kanbanLabelIds: (input.labelIds as string[]).join(',') } } } : action === 'configure' ? structuredClone(asObject(input.patch)) : {}, before = rows(original.fields ?? [])
    if (Object.hasOwn(asObject(patch.defaultValues), 'label')) {
      const raw = asObject(asObject(patch.defaultValues).label)
      if (typeof raw.kanbanLabelIds !== 'string') throw new RsqError('INVALID_INPUT', '默认标签必须显式指定完整 ID 集合；空字符串或 labels set 的 [] 表示清空，null 或省略不能代替清空。', 2)
      const normalized = asObject(normalizeTaskDefaultDefinition({ label: raw }).label), selected = String(normalized.kanbanLabelIds).split(',').filter(Boolean)
      const catalogue = taskLabels(results.defaultLabels), existing = taskLabels(asObject(asObject(original.defaultValues).label).kanbanLabels ?? [])
      if (input.projectId == null || catalogue.some(label => label.type !== 'project') || existing.some(label => label.type !== 'project') || selected.some(value => ![...catalogue, ...existing].some(label => String(label.id) === value))) throw new RsqError('FORBIDDEN', '默认标签必须来自当前项目库或该类型实际已有的项目标签，不能猜测其他项目标签编号。', 4)
      asObject(patch.defaultValues).label = normalized
    }
    if (item.type === 'system' && (patch.name !== undefined || patch.icon !== undefined)) throw new RsqError('INVALID_INPUT', '系统任务类型不能重命名或修改图标。', 2)
    let fields = before.map(field => definition(field))
    if (patch.fields !== undefined) fields = rows(patch.fields).map(field => definition(field))
    if (action === 'field-add') fields.push(definition(asObject(input.field), true))
    if (action === 'field-edit' || action === 'field-remove') {
      const index = fields.findIndex(field => same(field.id, input.fieldId))
      if (index < 0) throw new RsqError('CONTEXT_MISSING', '字段不属于指定任务模板。', 2)
      if (action === 'field-remove') fields.splice(index, 1)
      else fields[index] = definition({ ...fields[index], ...asObject(input.patch), id: fields[index].id })
    }
    const editsFields = !['configure', 'default-labels'].includes(action) || patch.fields !== undefined
    if (editsFields) { ownership(before, fields); dependencies(before, fields) }
    if (editsFields && patch.auths !== undefined) throw new RsqError('INVALID_INPUT', '字段定义和权限修改请分步执行；新增字段由 CLI 初始化标准权限。', 2)
    const body = asObject(shape({ id: input.templateId, ...patch, ...(editsFields && { fields, auths: fieldAuths(original, before, fields) }) }, bodySchema()))
    results.taskContext = { expected: body, ...(action === 'default-labels' && { defaultLabelDefinitionBefore: structuredClone(original) }) }; return { body }
  }
  if (action === 'field-set') {
    task(input, results)
    return prepareTaskFieldMutation(input, results, session, { module: 'project', siteId: String(input.projectId) })
  }
  if (action === 'apply') throw new RsqError('INVALID_CONTRACT', '任务类型切换需要完整的 task-type-transition 业务上下文。', 6)
  if (action === 'milestones') {
    project(input, results)
    if (input.groupType === 'field') {
      const fields = rows(results.available).filter(item => item.isMilepost === true).flatMap(item => rows(item.fields ?? []))
      if (!fields.some(field => same(field.id, input.fieldId) && [3, 4].includes(Number(field.type)))) throw new RsqError('INVALID_INPUT', '分组字段必须为里程碑模板中的选项字段。', 2)
    }
    return { query: { projectId: input.projectId, groupType: input.groupType ?? 'none', ...(input.fieldId !== undefined && { fieldId: input.fieldId }) } }
  }
  if (action === 'milestone-create') {
    project(input, results)
    const templates = rows(results.available).filter(item => item.isMilepost === true && item.isStop !== true)
    if (templates.length !== 1) throw new RsqError('CONTEXT_MISSING', '需要唯一且可用的里程碑模板。', 2)
    moduleContext(input, results)
    const detail = asObject(results.moduleDetail)
    if (!same(detail.id, input.moduleId)) throw new RsqError('CONTEXT_MISSING', '任务模块详情与当前资源不一致。', 2)
    const cards = rows(results.cards), cardId = input.cardId ?? detail.firstCardId ?? (cards.length === 1 ? cards[0].id : undefined)
    if (cardId == null || !cards.some(card => same(card.id, cardId))) throw new RsqError('CONTEXT_MISSING', '请从project card list 返回列表 显式选择 cardId；没有唯一默认卡片。', 2, { moduleId: input.moduleId, cards: cards.map(card => ({ id: card.id, name: card.name })) })
    const permissions = asObject(results.cardPermissions)
    for (const key of ['createTask', 'editTaskDate', ...(!templates[0].isDefault ? ['modifyTaskType'] : []), ...(input.memberIds !== undefined ? ['addTaskMember'] : [])]) if (permissions[key] !== true) throw new RsqError('FORBIDDEN', '当前任务模块不允许此新建配置：' + key, 4)
    calendarDate(input.date)
    const body = { name: input.name, projectId: input.projectId, moduleId: input.moduleId, cardId: String(cardId), taskTemplateId: String(templates[0].id), groupType: 'card', realStartDate: input.date, realEndDate: input.date, ...(input.memberIds !== undefined && { memberIds: input.memberIds }) }
    results.taskContext = { milestone: true, expected: body }; return { body }
  }
  if (action === 'project-definition' || action === 'project-create') {
    project(input, results); moduleContext(input, results)
    const available = rows(results.available).filter(item => item.isMilepost !== true && item.isStop !== true)
    const selected = available.filter(item => input.templateId != null ? same(item.id, input.templateId) : item.isDefault === true)
    if (selected.length !== 1) throw new RsqError('CONTEXT_MISSING', '需要当前项目中唯一可用的普通任务类型；先发现任务类型，或显式指定 templateId。', 2)
    if (action === 'project-definition') return { query: { id: String(selected[0].id) } }
    const definition = asObject(results.creationTemplate)
    if (!same(definition.id, selected[0].id) || definition.isStop === true || definition.isMilepost === true) throw new RsqError('CONTEXT_MISMATCH', '实际任务类型定义与当前可用类型不一致。', 4)
    const detail = asObject(results.moduleDetail), cards = rows(results.cards)
    if (!same(detail.id, input.moduleId) || !['task', 'todo', 'kanban'].includes(String(detail.type))) throw new RsqError('CONTEXT_MISSING', '任务模块详情与目标不一致。', 5)
    const cardId = input.cardId ?? detail.firstCardId ?? (cards.length === 1 ? cards[0].id : undefined)
    if (cardId == null || !cards.some(card => same(card.id, cardId))) throw new RsqError('CONTEXT_MISSING', '没有唯一默认卡片；先查看 project card list，显式指定当前模块 cardId。', 2)
    const permissions = asObject(results.cardPermissions)
    for (const key of ['createTask', ...(!selected[0].isDefault ? ['modifyTaskType'] : [])]) if (permissions[key] !== true) throw new RsqError('FORBIDDEN', '当前任务模块不允许此新建配置：' + key, 4)
    if (!session) throw new RsqError('AUTH_REQUIRED', '创建任务需要已核对身份。', 3)
    const values = projectTaskValues(input, definition, results, session)
    const body = { name: input.name, ...values.body, projectId: input.projectId, moduleId: input.moduleId, cardId: String(cardId), taskTemplateId: String(selected[0].id), groupType: 'card' }
    results.taskContext = { projectTask: true, expected: body, expectedChildren: values.children }
    results.taskBusiness = { expected: { name: input.name, ...values.expected } }
    return { body }
  }
  if (action === 'module-detail') { moduleContext(input, results); return { query: { id: input.moduleId } } }
  if (action.startsWith('milestone-')) {
    const current = task(input, results)
    if (asObject(current.taskTemplate).isMilepost !== true) throw new RsqError('INVALID_INPUT', '当前任务不是里程碑，请勿按里程碑操作普通任务。', 2)
    const permissions = taskPermissions(input, results)
    if (action === 'milestone-remove') { allowed(permissions, 'removeTask'); return { query: { id: input.taskId, module: 'project', siteId: input.projectId } } }
    if (action === 'milestone-complete' && input.done !== false) {
      const missing = rows(asObject(results.values).templateFields).filter(field => field.isRequired === true && field.isHidden !== true && (field.value == null || field.value === '') && !['list', 'tableRows', 'hours', 'files', 'recordList'].some(key => Array.isArray(field[key]) && field[key].length > 0))
      if (missing.length) throw new RsqError('INVALID_INPUT', '里程碑有必填字段未填写；请先用 task field inspect/set 完成填写。', 2, { fields: missing.map(field => ({ id: field.id, name: field.name, type: field.type, editControl: field.editControl })) })
    }
    const patch: JsonObject = action === 'milestone-complete' ? { isDone: input.done ?? true } : { ...asObject(input.patch) }
    if (patch.name !== undefined) allowed(permissions, 'editTaskName')
    if (patch.date !== undefined) { allowed(permissions, 'editTaskDate'); calendarDate(patch.date); patch.realStartDate = patch.date; patch.realEndDate = patch.date; delete patch.date }
    if (patch.isDone !== undefined) allowed(permissions, 'finishTask')
    results.taskContext = { milestone: true, expected: patch }
    return { body: { id: input.taskId, ...patch, module: 'project', siteId: input.projectId } }
  }
  throw new RsqError('INVALID_CONTRACT', '未知任务上下文适配。', 6)
}
function compare(actual: unknown, expected: unknown, path = '') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务配置列表读回不一致：' + path, 5)
    expected.forEach((item, index) => compare(actual[index], item, path + '/' + index)); return
  }
  if (expected && typeof expected === 'object') { for (const [key, value] of Object.entries(asObject(expected))) compare(asObject(actual)[key], value, path + '/' + key); return }
  if (expected == null && actual == null || path.endsWith('/id') && same(actual, expected)) return
  if (canonical(actual) !== canonical(expected)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务配置读回不一致：' + path, 5)
}
export function verifyTaskTemplate(input: JsonObject, results: JsonObject, step: string) {
  if (step === 'createdTaskChildren' || step === 'verifiedTaskChildren') { verifyProjectTaskChildren(input, results, step); return }
  const expected = asObject(asObject(results.taskContext).expected), actual = asObject(results[step])
  if (step === 'verifiedTemplate') {
    const copy = structuredClone(expected); delete copy.id
    const readback = structuredClone(actual)
    if (copy.defaultValues != null) { copy.defaultValues = normalizeTaskDefaultDefinition(copy.defaultValues); readback.defaultValues = normalizeTaskDefaultDefinition(actual.defaultValues) }
    if (asObject(copy.auths).elements) copy.auths = { ...asObject(copy.auths), elements: rows(asObject(copy.auths).elements).map(element => { const projected = { ...element }; delete projected.authName; return projected }) }
    compare(readback, copy)
    const before = asObject(asObject(results.taskContext).defaultLabelDefinitionBefore)
    if (Object.keys(before).length) {
      const preserved = structuredClone(actual), defaults = asObject(preserved.defaultValues), previous = asObject(before.defaultValues)
      if (Object.hasOwn(previous, 'label')) defaults.label = previous.label; else delete defaults.label
      if (taskTemplateVersion(preserved) !== taskTemplateVersion(before)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '默认标签更新改变了其他默认值、字段、权限、名称或图标；保留资源 ID，勿重放。', 5)
    }
    return
  }
  if (step === 'verifiedValues') {
    if (results.taskHours) { verifyTaskHours(input,results,step); return }
    const field = rows(actual.templateFields).find(field => same(field.id, asObject(results.taskContext).fieldId))
    if (!field) throw new RsqError('BUSINESS_ASSERTION_FAILED', '写入字段未出现在独立读回中。', 5)
    if (Array.isArray(asObject(results.taskAttachment).expectedIds)) {
      compare(attachmentIds(field).sort(), [...asObject(results.taskAttachment).expectedIds as string[]].sort(), '/files')
      return
    }
    if (Object.hasOwn(expected, 'value') && expected.value === 0 && field.value == null && [2, 9].includes(Number(field.type))) throw new RsqError('SERVER_READBACK_AMBIGUOUS', '服务端将数字字段的零返回为空，不能确认赋值结果；请核对资源，勿重放写入。', 5, { taskId: input.taskId, fieldId: field.id })
    for (const key of ['value', 'time', 'placeholder']) if (Object.hasOwn(expected, key) && String(field[key] ?? '') !== String(expected[key] ?? '')) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务字段值独立读回不一致。', 5)
    for (const key of ['list', 'tableRows']) if (Array.isArray(expected[key])) compare(field[key] ?? [], expected[key], '/' + key)
    return
  }
  if (step === 'verifiedTask') {
    if (asObject(results.taskContext).projectTask === true) {
      if (!same(actual.id, asObject(results.created).id) || !same(asObject(actual.from).projectId, input.projectId) || !same(asObject(actual.from).planId, input.moduleId) || !same(actual.cardId, expected.cardId) || actual.taskId != null || !same(asObject(actual.taskTemplate).id, expected.taskTemplateId)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '新建任务的独立身份、项目、模块、卡片、类型或父级与请求不符。', 5)
      verifyTaskBusiness(input, results, step); return
    }
    if (!same(asObject(actual.from).projectId, input.projectId)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务未归属到指定项目；创建成功回执不能代替业务归属。', 5)
    if (asObject(results.taskContext).milestone === true && asObject(actual.taskTemplate).isMilepost !== true) throw new RsqError('BUSINESS_ASSERTION_FAILED', '里程碑读回类型不一致。', 5)
    for (const key of ['name', 'isDone']) if (Object.hasOwn(expected, key)) compare(actual[key], expected[key], '/' + key)
    if (expected.taskTemplateId !== undefined && !same(asObject(actual.taskTemplate).id, expected.taskTemplateId)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务类型未切换到指定模板。', 5)
    for (const key of ['realStartDate', 'realEndDate']) if (Object.hasOwn(expected, key) && String(actual[key] ?? '').slice(0, 10) !== expected[key]) throw new RsqError('BUSINESS_ASSERTION_FAILED', '里程碑日期读回不一致：' + key, 5)
  }
  if (step === 'remainingMilestones' && rows(results[step]).flatMap(group => rows(group.taskList ?? [])).some(item => same(item.id, input.taskId))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '删除后的里程碑仍在项目概览中。', 5)
}
export function describeTaskTemplate(results: JsonObject) {
  const original = asObject(results.verifiedTemplate ?? results.original)
  return { ...original, definitionVersion: taskTemplateVersion(original), fieldTypes: taskFieldTypes, ...(Array.isArray(results.defaultLabels) && { availableProjectLabels: taskLabels(results.defaultLabels) }) }
}
export function describeTaskAttachments(input: JsonObject, results: JsonObject) {
  const field = attachmentField(input, results, results.verifiedValues ? 'verifiedValues' : 'values')
  return { taskId: input.taskId, fieldId: input.fieldId, files: rows(field.files ?? []).map(file => Object.fromEntries(['id','name','size','contentType'].filter(key => Object.hasOwn(file, key)).map(key => [key, file[key]]))) }
}
