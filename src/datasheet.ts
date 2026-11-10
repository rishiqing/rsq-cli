import { randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as json1 from 'ot-json1'
import { asObject, RsqError, type JsonObject } from './core.js'
import { datasheetVisibility, datasheetRoleSummary } from './datasheet-visibility.js'
import { bindDatasheetTarget } from './datasheet-target.js'
import type { Session } from './session.js'
import { configureField, fieldReferences, newId, fieldContracts, type Field } from './datasheet-fields.js'

type View = { id: string; name: string; rows: { recordId: string }[]; columns: { fieldId: string }[]; [key: string]: unknown }
type RecordValue = { id: string; data: JsonObject; recordMeta?: JsonObject; [key: string]: unknown }
type Snapshot = { datasheetId: string; meta: { fieldMap: Record<string, Field>; views: View[] }; recordMap: Record<string, RecordValue> }
type Pack = { datasheet: { id: string; revision: number; permissions: Record<string, boolean> }; snapshot: Snapshot; datasheetPermission?: JsonObject; sharedData?: unknown }
type Prepared = { snapshot: Snapshot; paths: (string | number)[][]; resources: Record<string, string>; messageId: string }
const names = ['NotSupport', 'Number', 'Text', 'SingleText', 'Currency', 'Percent', 'Rank', 'SingleSelect', 'MultiSelect', 'DateTime', 'Checkbox', 'Attach', 'Url', 'Tel', 'Email', 'AutoNumber', 'Formula', 'Member', 'Dept', 'CreatedMember', 'ModifiedMember', 'CreatedTime', 'ModifiedTime', 'Link', 'LookUp', 'Workflow', 'Project']
const readonly = new Set([0, 15, 16, 19, 20, 21, 22, 24])
function fail(message: string): never { throw new RsqError('INVALID_FIELD_VALUE', message, 2) }
function getPack(results: JsonObject, key = 'context'): Pack {
  const pack = asObject(asObject(results[key]).data) as unknown as Pack
  if (!pack.snapshot?.meta?.fieldMap || !Array.isArray(pack.snapshot.meta.views) || !pack.snapshot.recordMap || !pack.datasheet || !Number.isSafeInteger(pack.datasheet.revision)) throw new RsqError('CONTEXT_MISSING', '数据表上下文缺少字段、记录或有效版本。', 5)
  if (!pack.datasheet.permissions) {
    // Node permissions are deliberately null in the HTTP service. The UI
    // authorizes these actions using the returned role permission instead.
    const role = asObject(pack.datasheetPermission), definitions = role.fieldEditMode === 'manageFields', views = role.manageView === true
    pack.datasheet.permissions = { fieldCreatable: definitions, fieldPropertyEditable: definitions, fieldRenamable: definitions, fieldRemovable: definitions,
      viewCreatable: views, viewRemovable: views, viewRenamable: views, descriptionEditable: views, viewFilterable: views, columnSortable: views, fieldGroupable: views,
      rowCreatable: role.canCreateRecord === true, rowRemovable: role.canDeleteRecord === true,
      cellEditable: ['all', 'partial'].includes(String(role.editRecordScope)) && ['manageFields', 'editAll', 'custom'].includes(String(role.fieldEditMode)) && role.permissionMode !== 'readOnly' }
  }
  return pack
}
function lookup<T extends { id: string; name: string }>(items: T[], key: string, kind: string): T {
  const exact = items.find(item => item.id === key)
  if (exact) return exact
  const matches = items.filter(item => item.name === key)
  if (matches.length !== 1) throw new RsqError(matches.length ? 'AMBIGUOUS_CONTEXT' : 'CONTEXT_NOT_FOUND', kind + '名称不唯一或不存在，请使用发现命令返回的 ID。', 2)
  return matches[0]
}
function allowed(pack: Pack, permission: string, rolePermission?: string) {
  if (pack.datasheet.permissions[permission] !== true || rolePermission && pack.datasheetPermission?.[rolePermission] === false) throw new RsqError('FORBIDDEN', '当前身份没有数据表操作权限：' + permission, 4)
}
export function normalizeCell(field: Field, value: unknown): unknown {
  if (readonly.has(field.type)) fail('计算或只读字段不能赋值：' + field.id)
  if (value === null || Array.isArray(value) && !value.length) return null
  if ([1, 4, 5, 6].includes(field.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('数字字段需要有限 JSON 数字：' + field.id)
    if (field.type === 6 && (Number(value) < 0 || typeof field.attr?.max === 'number' && Number(value) > field.attr.max)) fail('等级超出字段范围：' + field.id)
    return value
  }
  if ([2, 3, 12, 13, 14].includes(field.type)) {
    const segmentType = ({ 12: 2, 13: 6, 14: 4 } as Record<number, number>)[field.type] ?? 1
    if (typeof value === 'string') return value ? [{ type: segmentType, text: value, ...(field.type === 12 && { link: value }) }] : null
    if (!Array.isArray(value) || !value.every(v => typeof asObject(v).text === 'string' && typeof asObject(v).type === 'number')) fail('文本字段需要字符串或有效文本片段：' + field.id)
    return value
  }
  if ([7, 8].includes(field.type)) {
    const options = (field.attr?.optionList ?? []) as { id: string; name: string }[]
    const selected = (Array.isArray(value) ? value : [value]).map(key => {
      if (typeof key !== 'string') return fail('选项必须是名称或 ID：' + field.id)
      return lookup(options, key, '字段选项').id
    })
    if (field.type === 7 && selected.length > 1) fail('单选字段只能选择一个值：' + field.id)
    return [...new Set(selected)]
  }
  if (field.type === 9) {
    const date = typeof value === 'number' ? value : typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
    if (!Number.isSafeInteger(date) || date < -2177452800000 || date > 32535216000000) fail('日期必须是毫秒时间戳或带时区的 ISO 日期：' + field.id)
    return date
  }
  if (field.type === 10) {
    if (typeof value !== 'boolean') fail('勾选字段需要 boolean：' + field.id)
    return value
  }
  if (field.type === 23) {
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && /^rec[\w-]+$/.test(v))) fail('关联字段需要记录 ID 数组：' + field.id)
    return value
  }
  const required = ({ 11: ['id', 'name', 'realPath', 'type'], 17: ['id', 'showName'], 18: ['id', 'name'], 25: ['processInfoId', 'applicationId'], 26: ['id', 'name'] } as Record<number, string[]>)[field.type]
  if (!required || !Array.isArray(value) || !value.every(v => required.every(key => {
    const entry = asObject(v)[key]
    return typeof entry === 'string' && entry.length > 0 || typeof entry === 'number' && Number.isSafeInteger(entry)
  }))) fail('关联资源需要发现接口返回的完整对象数组；ID 不得丢失精度：' + field.id)
  if ([11, 17, 18, 25, 26].includes(field.type) && field.attr?.isMulti === false && (value as unknown[]).length > 1) fail('该字段只允许一个关联对象：' + field.id)
  return value
}
function validateViewProperty(property: string, value: unknown, fieldMap: Record<string, Field>) {
  if (value === null) {
    if (property === 'name') fail('视图名称不能清空。')
    return
  }
  if (property === 'name' || property === 'description') {
    if (typeof value !== 'string') fail('视图名称和描述需要字符串。')
    return
  }
  function field(id: unknown) {
    if (typeof id !== 'string' || !Object.hasOwn(fieldMap, id)) fail('视图配置引用了不存在的字段。')
    return fieldMap[id as string]
  }
  function rules(raw: unknown) {
    if (!Array.isArray(raw)) fail('排序或分组需要字段规则数组。')
    const used = new Set()
    for (const item of raw as unknown[]) {
      const rule = asObject(item), target = field(rule.fieldId)
      if (used.has(target.id) || Object.keys(rule).some(k => !['fieldId', 'desc'].includes(k)) || rule.desc !== undefined && typeof rule.desc !== 'boolean') fail('字段规则重复或格式无效。')
      if (property === 'groupInfo' && [11, 25].includes(target.type)) fail('附件或流程字段不支持分组。')
      used.add(target.id)
    }
  }
  if (property === 'groupInfo') return rules(value)
  if (property === 'sortInfo') {
    const sort = asObject(value)
    if (typeof sort.keepSort !== 'boolean' || Object.keys(sort).some(k => !['rules', 'keepSort'].includes(k))) fail('排序需要 rules 和 keepSort。')
    return rules(sort.rules)
  }
  const filter = asObject(value)
  if (!['and', 'or'].includes(String(filter.conjunction)) || !Array.isArray(filter.conditions) || Object.keys(filter).some(k => !['conjunction', 'conditions'].includes(k))) fail('筛选需要 and/or conjunction 和 conditions 数组。')
  const used = new Set(), operators = ['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty', 'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual', 'isRepeat']
  for (const item of filter.conditions as unknown[]) {
    const condition = asObject(item), target = field(condition.fieldId)
    if (typeof condition.conditionId !== 'string' || !condition.conditionId || used.has(condition.conditionId)
      || condition.fieldType !== target.type || !operators.includes(String(condition.operator)) || typeof condition.useFieldValue !== 'boolean') fail('筛选条件缺少唯一 ID、正确字段类型、操作符或引用方式。')
    used.add(condition.conditionId)
    if (condition.useFieldValue) field(condition.fieldValueId)
    else if (!['isEmpty', 'isNotEmpty', 'isRepeat'].includes(String(condition.operator)) && condition.value !== null) {
      if (!Array.isArray(condition.value) || !condition.value.length) fail('筛选值需要非空数组或 null。')
      if ([7, 8].includes(target.type)) for (const id of condition.value as unknown[]) lookup((target.attr?.optionList ?? []) as { id: string; name: string }[], String(id), '筛选选项')
    }
  }
}
function getPath(value: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => current && typeof current === 'object' && Object.hasOwn(current, key) ? (current as JsonObject)[key] : undefined, value)
}
export function prepareDatasheet(action: string, input: JsonObject, results: JsonObject, session: Session | null = null): JsonObject | null {
  if (action === 'datasheet-context-bound') return bindDatasheetTarget(input, results, session)
  if (action === 'datasheet-import-verify') {
    const data = asObject(asObject(results.write).data), resources: Record<string, string> = { projectId: String(input.projectId) }
    if (Array.isArray(data.results)) for (const [index, raw] of data.results.entries()) {
      const module = asObject(raw), sheet = asObject(module.datasheetInfo)
      if (module.id != null) resources['module' + index + 'Id'] = String(module.id)
      if (sheet.datasheetId != null) resources['datasheet' + index + 'Id'] = String(sheet.datasheetId)
    }
    results.prepared = { resources }
    return { query: { kanbanId: input.projectId } }
  }
  const pack = getPack(results)
  if (pack.datasheet.id !== input.datasheetId || pack.snapshot.datasheetId !== input.datasheetId) throw new RsqError('CONTEXT_MISMATCH', '数据表上下文与目标 ID 不同。', 5)
  if (results.datasheetTarget) {
    const target = asObject(results.datasheetTarget)
    if (target.datasheetId !== input.datasheetId || target.projectId !== input.projectId) throw new RsqError('CONTEXT_MISMATCH', '数据表目标上下文已变化。', 5)
    const visible = datasheetVisibility(pack as unknown as JsonObject, target.mainProjectId !== target.projectId)
    if (['record-update', 'record-delete'].includes(action) && !visible.recordIds.includes(String(input.recordId))) throw new RsqError('RESOURCE_NOT_FOUND', '目标记录不在当前项目可见范围。', 4)
    if (input.fieldId !== undefined) lookup(visible.fields as Field[], String(input.fieldId), '可见字段')
    for (const key of Object.keys(asObject(input.values))) lookup(visible.fields as Field[], key, '可见字段')
    for (const key of ['viewId', 'sourceViewId']) if (input[key] !== undefined) lookup(visible.views as View[], String(input[key]), '可见视图')
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== pack.datasheet.revision) throw new RsqError('CONTEXT_STALE', '数据表版本已变化，请重新读取并核对。', 5)
  if (action === 'datasheet-project-context') return input.projectId ? { query: { id: input.projectId } } : null
  if (action === 'datasheet-project-modules') return input.projectId ? { query: { kanbanId: input.projectId } } : null
  if (['datasheet-related-project', 'datasheet-related-modules', 'datasheet-related-context'].includes(action)) {
    const current = input.fieldId ? lookup(Object.values(pack.snapshot.meta.fieldMap), String(input.fieldId), '字段') : undefined
    const attr = { ...asObject(current?.attr), ...asObject(asObject(input.field).attr) }
    if (!attr.linkDatasheetId || attr.lookUpTargetType === 'workflow') return null
    const projectId = attr.projectId == null ? input.projectId : String(attr.projectId)
    if (typeof projectId !== 'string' || !/^[1-9][0-9]*$/.test(projectId) || typeof attr.linkDatasheetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(attr.linkDatasheetId)) fail('关联目标需要精确的项目和数据表 ID。')
    if (attr.linkDatasheetId === input.datasheetId && projectId === input.projectId) return null
    if (action === 'datasheet-related-project') return { query: { id: projectId } }
    if (action === 'datasheet-related-modules') return { query: { kanbanId: projectId } }
    const bound: JsonObject = { targetIdentity: results.targetIdentity, targetProject: results.relatedProject, targetModules: results.relatedModules }
    const args = bindDatasheetTarget({ projectId, datasheetId: attr.linkDatasheetId }, bound, session)
    const target = asObject(bound.datasheetTarget)
    // The current field picker offers source tables owned by the selected
    // project, rather than references shared from another project.
    if (target.mainProjectId !== projectId) throw new RsqError('CONTEXT_MISMATCH', '关联字段必须选择目标项目实际拥有的数据表。', 5)
    results.relatedTarget = target
    return args
  }
  let snapshot = structuredClone(pack.snapshot), actions: json1.JSONOp = null
  const paths: (string | number)[][] = [], resources: Record<string, string> = { datasheetId: pack.datasheet.id }
  if (results.datasheetTarget) for (const key of ['projectId', 'mainProjectId', 'moduleId']) resources[key] = String(asObject(results.datasheetTarget)[key])
  function change(path: (string | number)[], value: unknown) {
    const old = getPath(snapshot, path)
    if (isDeepStrictEqual(old, value)) return
    const op = value === undefined ? json1.type.writeCursor().writeAtPath(path, 'r', old as json1.Doc).get() : old === undefined ? json1.insertOp(path, value as json1.Doc) : json1.replaceOp(path, old as json1.Doc, value as json1.Doc)
    actions = json1.type.compose(actions, op)
    snapshot = json1.type.apply(snapshot as unknown as json1.Doc, op) as unknown as Snapshot
    paths.push(path)
  }
  const fields = Object.values(snapshot.meta.fieldMap)
  const selectView = () => input.viewId ? lookup(snapshot.meta.views, String(input.viewId), '视图') : snapshot.meta.views.length === 1 ? snapshot.meta.views[0] : fail('数据表有多个视图，请显式传入 --view-id。')
  const manageFields = (permission: string) => {
    allowed(pack, permission)
    if (pack.datasheetPermission?.fieldEditMode && pack.datasheetPermission.fieldEditMode !== 'manageFields') throw new RsqError('FORBIDDEN', '当前角色不能维护字段定义。', 4)
  }
  const manageView = (view: View, permission: string) => {
    allowed(pack, permission, 'manageView')
    const entries = pack.datasheetPermission?.viewPermissions as { id: string; canManage: boolean }[] | undefined
    if (entries?.find(entry => entry.id === view.id)?.canManage === false) throw new RsqError('FORBIDDEN', '当前角色不能维护这个视图。', 4)
  }
  function values(raw: JsonObject, recordId?: string): JsonObject {
    const data: JsonObject = {}
    for (const [key, value] of Object.entries(raw)) {
      const field = lookup(fields, key, '字段')
      if (Object.hasOwn(data, field.id)) fail('同一字段不能同时以名称和 ID 赋值。')
      const permissions = pack.datasheetPermission?.fieldPermissions as { fields?: { fieldId: string; canView?: boolean; canEdit?: boolean; canAdd?: boolean; disable?: boolean }[]; newAddFiled?: { canView?: boolean; canEdit?: boolean; canAdd?: boolean } } | undefined
      const permission = permissions?.fields?.find(p => p.fieldId === field.id) ?? (pack.datasheetPermission?.fieldEditMode === 'custom' ? permissions?.newAddFiled : undefined)
      const canEdit = permission && (Object.hasOwn(permission, 'canEdit') ? permission.canEdit : permission.canView)
      const canAdd = permission && (Object.hasOwn(permission, 'canAdd') ? permission.canAdd : permission.canView)
      const previous = recordId ? snapshot.recordMap[recordId]?.data[field.id] : null
      const empty = previous == null || previous === false || previous === '' || Array.isArray(previous) && !previous.length
      if (pack.datasheetPermission?.fieldEditMode === 'readOnly' || permission && (!canEdit && !(canAdd && empty))
        || pack.datasheetPermission?.fieldEditMode === 'custom' && !permission) throw new RsqError('FORBIDDEN', '当前身份不能修改所选字段。', 4)
      data[field.id] = normalizeCell(field, value)
    }
    return data
  }
  function related(field: Field) {
    if (![23, 24].includes(field.type) || field.type === 24 && field.attr?.lookUpTargetType === 'workflow') return
    const targetId = String(field.attr?.linkDatasheetId), target = targetId === pack.datasheet.id ? pack : getPack(results, 'related')
    if (target.datasheet.id !== targetId) throw new RsqError('CONTEXT_MISMATCH', '关联目标数据表与上下文不一致。', 5)
    const visible = datasheetVisibility(target as unknown as JsonObject, target === pack && asObject(results.datasheetTarget).mainProjectId !== input.projectId)
    if (!visible.completeTable) throw new RsqError('VIEW_CONTEXT_REQUIRED', '关联目标只允许部分视图，需要先补齐视图筛选上下文。', 4)
    const visibleFields = Object.fromEntries(visible.fields.map(field => [String(field.id), field as unknown as Field]))
    const ids = [...(field.attr?.customFieldIds ?? []) as string[], ...(field.attr?.requiredFieldIds ?? []) as string[]]
    if (field.type === 24) ids.push(String(field.attr?.lookUpTargetFieldId))
    for (const id of ids) if (!Object.hasOwn(visibleFields, id)) fail('关联目标字段不存在或不可见：' + id)
    if (field.type === 24 && field.attr?.filterInfo) validateViewProperty('filterInfo', field.attr.filterInfo, visibleFields)
  }
  let cmd: string
  const fieldTypeMap: Record<string, number> = {}
  if (action === 'record-update') {
    allowed(pack, 'cellEditable')
    const recordId = String(input.recordId), record = snapshot.recordMap[recordId]
    if (!record) throw new RsqError('CONTEXT_NOT_FOUND', '数据表记录不存在或不可见。', 2)
    const match = asObject(asObject(pack.datasheetPermission?.matchRecordMap)[recordId])
    if (pack.datasheetPermission?.editRecordScope === 'none' || pack.datasheetPermission?.editRecordScope === 'partial' && match.canEdit !== true || match.canEdit === false) throw new RsqError('FORBIDDEN', '当前身份不能修改所选记录。', 4)
    for (const [fieldId, value] of Object.entries(values(asObject(input.values), recordId))) {
      fieldTypeMap[fieldId] = snapshot.meta.fieldMap[fieldId].type
      const project = fieldTypeMap[fieldId] === 26
      if (project && !record.recordMeta) change(['recordMap', recordId, 'recordMeta'], {})
      change(['recordMap', recordId, project ? 'recordMeta' : 'data', project ? 'projectInfo' : fieldId], value === null ? undefined : value)
    }
    resources.recordId = recordId; cmd = 'SetRecords'
  } else if (action === 'record-create') {
    allowed(pack, 'rowCreatable', 'canCreateRecord')
    if (Object.keys(snapshot.recordMap).length >= 50000) fail('数据表已达到记录数量上限。')
    const view = selectView(), recordId = 'rec' + randomBytes(8).toString('hex').slice(0, 10)
    const record: RecordValue = { id: recordId, data: {}, headwayCount: 0, commentCount: 0, comments: [], recordMeta: {} }
    if (input.projectId) {
      const project = asObject(results.project), modules = results.modules
      if (String(project.id) !== input.projectId || typeof project.name !== 'string' || !Array.isArray(modules)) throw new RsqError('CONTEXT_MISSING', '缺少数据表所属项目和模块上下文。', 5)
      const module = (modules as JsonObject[]).find(module => asObject(module.datasheetInfo).datasheetId === input.datasheetId)
      if (!module || asObject(module.datasheetInfo).mainProjectId == null) throw new RsqError('CONTEXT_MISMATCH', '当前项目未关联目标数据表或缺少主项目 ID。', 5)
      if (String(asObject(module.datasheetInfo).mainProjectId) !== input.projectId) record.recordMeta!.projectInfo = [{ id: project.id, name: project.name }]
    } else if (asObject(pack.sharedData).isOpen === true) throw new RsqError('CONTEXT_REQUIRED', '共享数据表创建记录需要 --project-id，用于发现模块归属和项目默认值。', 2)
    for (const field of fields) if (!readonly.has(field.type) && field.attr && Object.hasOwn(field.attr, 'defaultValue') && field.attr.defaultValue !== '' && field.attr.defaultValue !== null) {
      let value = field.attr.defaultValue
      if ([1, 4, 5, 6].includes(field.type) && typeof value === 'string') value = Number(value)
      record.data[field.id] = normalizeCell(field, value)
    }
    const supplied = values(asObject(input.values)), groups = values(asObject(input.groupValues))
    const groupFields = new Set((Array.isArray(view.groupInfo) ? view.groupInfo as JsonObject[] : []).map(group => group.fieldId))
    if (Object.keys(groups).some(id => !groupFields.has(id))) fail('groupValues 只能设置当前视图的分组字段。')
    const filter = asObject(view.filterInfo), conditions = Array.isArray(filter.conditions) ? filter.conditions as JsonObject[] : []
    // As in the UI, multi-branch OR filters supply no implicit defaults. An
    // explicit cell value always overrides filter and group defaults.
    if (filter.conjunction !== 'or' || conditions.length === 1) {
      const grouped = new Map<string, JsonObject[]>()
      for (const condition of conditions) {
        const id = String(condition.fieldId)
        if (!snapshot.meta.fieldMap[id] || readonly.has(snapshot.meta.fieldMap[id].type) || condition.useFieldValue || Object.hasOwn(supplied, id) || Object.hasOwn(groups, id)) continue
        grouped.set(id, [...grouped.get(id) ?? [], condition])
      }
      for (const [id, filters] of grouped) {
        const field = snapshot.meta.fieldMap[id], candidates: unknown[] = []
        for (const condition of filters) {
          const list = Array.isArray(condition.value) ? condition.value : []
          if (!list.length || !['is', 'contains'].includes(String(condition.operator))) continue
          if ([1, 4, 5, 6].includes(field.type) && condition.operator === 'is' && list[0] !== '') candidates.push(Number(list[0]))
          else if ([2, 3, 12, 13, 14].includes(field.type)) candidates.push(list.join(''))
          else if (field.type === 7 && list.length === 1 || field.type === 8 && (condition.operator === 'is' || list.length === 1)) candidates.push(list)
          else if (field.type === 10) candidates.push(true)
          else if ([17, 18].includes(field.type)) throw new RsqError('CONTEXT_REQUIRED', '成员或部门筛选默认值需要发现完整对象后通过 values 显式提供。', 2, { fieldId: id, relatedCommands: ['contact department list'] })
        }
        if (!candidates.length) continue
        const unique = [...new Map(candidates.map(value => [JSON.stringify(value), value])).values()]
        const candidate = field.type === 8 ? [...new Set(unique.flat() as string[])] : unique.length === 1 ? unique[0] : undefined
        if (candidate === undefined) continue
        const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [value]
        const equal = (a: unknown, b: unknown) => String(a) === String(b)
        const pass = filters.every(condition => {
          const wanted = Array.isArray(condition.value) ? condition.value : [], actual = array(candidate)
          switch (condition.operator) {
            case 'is': return [7, 8].includes(field.type) ? actual.length === wanted.length && actual.every(v => wanted.some(w => equal(v, w))) : field.type === 10 ? Boolean(wanted[0]) === Boolean(candidate) : wanted.some(w => equal(candidate, w))
            case 'isNot': return !actual.some(v => wanted.some(w => equal(v, w)))
            case 'contains': return [7, 8].includes(field.type) ? wanted.some(w => actual.some(v => equal(v, w))) : wanted.some(w => String(candidate).includes(String(w)))
            case 'doesNotContain': return !wanted.some(w => actual.some(v => String(v).includes(String(w))))
            case 'isNotEmpty': return true
            case 'isEmpty': return false
            case 'isGreater': return Number(candidate) > Number(wanted[0])
            case 'isGreaterEqual': return Number(candidate) >= Number(wanted[0])
            case 'isLess': return Number(candidate) < Number(wanted[0])
            case 'isLessEqual': return Number(candidate) <= Number(wanted[0])
            default: return false
          }
        })
        if (pass) record.data[id] = normalizeCell(field, candidate)
      }
    }
    Object.assign(record.data, groups, supplied)
    for (const field of fields) if (field.type === 9 && field.attr?.autoFill && record.data[field.id] == null) record.data[field.id] = Date.now()
    for (const field of fields) if (field.required && !readonly.has(field.type) && (record.data[field.id] == null || Array.isArray(record.data[field.id]) && !(record.data[field.id] as unknown[]).length)) fail('创建记录缺少必填字段：' + field.id)
    for (const [fieldId, value] of Object.entries(record.data)) {
      fieldTypeMap[fieldId] = snapshot.meta.fieldMap[fieldId].type
      if (fieldTypeMap[fieldId] === 26) { record.recordMeta!.projectInfo = value; delete record.data[fieldId] }
    }
    for (let i = 0; i < snapshot.meta.views.length; i++) change(['meta', 'views', i, 'rows', snapshot.meta.views[i].rows.length], { recordId })
    change(['recordMap', recordId], record)
    resources.recordId = recordId; cmd = 'AddRecords'
  } else if (action === 'record-delete') {
    allowed(pack, 'rowRemovable', 'canDeleteRecord')
    const recordId = String(input.recordId)
    if (!snapshot.recordMap[recordId]) throw new RsqError('CONTEXT_NOT_FOUND', '记录不存在或不可见。', 2)
    for (let i = 0; i < snapshot.meta.views.length; i++) change(['meta', 'views', i, 'rows'], snapshot.meta.views[i].rows.filter(r => r.recordId !== recordId))
    change(['recordMap', recordId], undefined)
    resources.recordId = recordId; cmd = 'DeleteRecords'
  } else if (action === 'view-update') {
    const view = selectView(), index = snapshot.meta.views.findIndex(v => v.id === view.id)
    const attr = String(input.property), permission = ({ name: 'viewRenamable', description: 'descriptionEditable', filterInfo: 'viewFilterable', sortInfo: 'columnSortable', groupInfo: 'fieldGroupable' } as Record<string, string>)[attr]
    if (!permission) fail('不支持的业务视图属性。')
    manageView(view, permission)
    const value = input.value
    validateViewProperty(attr, value, snapshot.meta.fieldMap)
    if (attr === 'name' && (typeof value !== 'string' || !value || value.length > 30 || snapshot.meta.views.some(v => v.id !== view.id && v.name === value))) fail('视图名称为空、超过 30 字或重名。')
    change(['meta', 'views', index, attr], value === null ? undefined : value)
    resources.viewId = view.id
    cmd = ({ filterInfo: 'SetViewFilter', sortInfo: 'SetViewSort', groupInfo: 'SetViewGroup' } as Record<string, string>)[attr] ?? 'ModifyViews'
  } else if (action === 'view-create' || action === 'view-copy') {
    allowed(pack, 'viewCreatable', 'manageView')
    if (snapshot.meta.views.length >= 100) fail('每张数据表最多 100 个视图。')
    const source = input.sourceViewId ? lookup(snapshot.meta.views, String(input.sourceViewId), '源视图') : selectView()
    const name = String(input.name)
    if (!name.trim() || name.length > 30 || snapshot.meta.views.some(view => view.name === name)) fail('视图名称为空、超过 30 字或重名。')
    const viewId = newId('viw'), type = input.type === 'Kanban' ? 2 : 1
    const view: View = action === 'view-copy' ? { ...structuredClone(source), id: viewId, name } : {
      id: viewId, name, type, rows: structuredClone(source.rows), columns: source.columns.map((column, index) => ({ fieldId: column.fieldId,
        ...(type === 1 && (index === 0 ? { statType: 1 } : [1, 4].includes(snapshot.meta.fieldMap[column.fieldId].type) ? { statType: 8 } : {})) })),
      ...(type === 1 ? { rowHeightLevel: 1, frozenColumnCount: 1, displayHiddenColumnWithinMirror: false } : { displayHiddenColumnWithinMirror: true }),
    }
    delete view.lockInfo
    if (action === 'view-create' && type === 2) {
      const group = input.groupFieldId ? lookup(fields, String(input.groupFieldId), '分组字段') : fields.find(field => [7, 8, 17].includes(field.type))
      if (!group || ![7, 8, 17].includes(group.type)) fail('看板视图需要单选、多选或成员分组字段。')
      const hiddenGroupMap = Object.fromEntries(((group.attr?.optionList ?? []) as { id: string }[]).map(option => [option.id, false]))
      view.groupInfo = [{ fieldId: group.id }]; view.style = { isCoverFill: true, kanbanFieldId: group.id, isColNameVisible: false, hiddenGroupMap }
      view.columns = view.columns.map((column, index) => ({ ...column, ...(index >= 2 && { hidden: true }) }))
    }
    change(['meta', 'views', snapshot.meta.views.length], view)
    resources.viewId = viewId; cmd = 'AddViews'
  } else if (action === 'view-delete') {
    const view = selectView(); manageView(view, 'viewRemovable')
    if (snapshot.meta.views.length === 1) fail('至少保留一个视图。')
    change(['meta', 'views'], snapshot.meta.views.filter(item => item.id !== view.id))
    resources.viewId = view.id; cmd = 'DeleteViews'
  } else if (action === 'field-create' || action === 'field-update' || action === 'field-convert') {
    const existing = action === 'field-create' ? undefined : lookup(fields, String(input.fieldId), '字段')
    manageFields(action === 'field-create' ? 'fieldCreatable' : 'fieldPropertyEditable')
    if (existing && asObject(input.field).name !== undefined && asObject(input.field).name !== existing.name) manageFields('fieldRenamable')
    if (!existing && fields.length >= 200) fail('每张数据表最多 200 个字段。')
    const view = input.viewId ? selectView() : snapshot.meta.views[0], viewIndex = snapshot.meta.views.indexOf(view)
    const field = configureField(asObject(input.field), action === 'field-convert' ? undefined : existing, action === 'field-convert' ? fields.filter(f => f.id !== existing!.id) : fields, pack.datasheet.id, viewIndex)
    if (action === 'field-convert') field.id = existing!.id
    related(field)
    if (!existing) {
      for (let index = 0; index < snapshot.meta.views.length; index++) {
        const target = snapshot.meta.views[index]
        change(['meta', 'views', index, 'columns', target.columns.length], { fieldId: field.id, ...([1, 4].includes(field.type) && { statType: 8 }) })
      }
    } else if (action === 'field-convert') {
      const converted = asObject(input.conversionValues)
      if (Object.keys(converted).some(id => !Object.hasOwn(snapshot.recordMap, id))) fail('转换值引用了不存在或不可见的记录。')
      for (const record of Object.values(snapshot.recordMap)) {
        const old = existing.type === 26 ? record.recordMeta?.projectInfo : record.data[field.id]
        if (!readonly.has(field.type) && old != null && !Object.hasOwn(converted, record.id)) fail('每条非空记录需要显式 conversionValues，null 表示清空：' + record.id)
        const value = readonly.has(field.type) ? null : Object.hasOwn(converted, record.id) ? normalizeCell(field, converted[record.id]) : null
        change(['recordMap', record.id, 'data', field.id], undefined)
        if (existing.type === 26) change(['recordMap', record.id, 'recordMeta', 'projectInfo'], undefined)
        if (field.type === 26 && value != null) {
          if (!record.recordMeta) change(['recordMap', record.id, 'recordMeta'], {})
          change(['recordMap', record.id, 'recordMeta', 'projectInfo'], value)
        } else if (value != null) change(['recordMap', record.id, 'data', field.id], value)
      }
    } else if ([7, 8].includes(field.type)) {
      const options = new Set((field.attr?.optionList as { id: string }[]).map(option => option.id))
      for (const record of Object.values(snapshot.recordMap)) {
        const value = record.data[field.id]
        if (Array.isArray(value)) { const retained = value.filter(value => options.has(value as string)); change(['recordMap', record.id, 'data', field.id], retained.length ? retained : undefined) }
      }
    }
    change(['meta', 'fieldMap', field.id], field)
    resources.fieldId = field.id; cmd = existing ? 'SetFieldAttr' : 'AddFields'
  } else if (action === 'field-delete') {
    manageFields('fieldRemovable')
    const field = lookup(fields, String(input.fieldId), '字段')
    if (fields.length === 1 || snapshot.meta.views[0]?.columns[0]?.fieldId === field.id) fail('首列和最后一个字段不能删除。')
    const dependents = fields.filter(candidate => candidate.id !== field.id && fieldReferences(candidate).includes(field.id))
    if (dependents.length) throw new RsqError('DEPENDENCY_EXISTS', '请先修改依赖公式，再删除字段。', 2, { fieldIds: dependents.map(field => field.id) })
    for (const record of Object.values(snapshot.recordMap)) {
      change(['recordMap', record.id, 'data', field.id], undefined)
      if (field.type === 26) change(['recordMap', record.id, 'recordMeta', 'projectInfo'], undefined)
    }
    for (let index = 0; index < snapshot.meta.views.length; index++) {
      const view = snapshot.meta.views[index], next = structuredClone(view), column = view.columns.findIndex(column => column.fieldId === field.id)
      next.columns = next.columns.filter(column => column.fieldId !== field.id)
      if (column >= 0 && typeof view.frozenColumnCount === 'number' && column < view.frozenColumnCount) next.frozenColumnCount = Math.max(1, view.frozenColumnCount - 1)
      for (const key of ['groupInfo', 'grouping']) if (Array.isArray(next[key])) {
        const list = (next[key] as JsonObject[]).filter(item => item.fieldId !== field.id).map(item => ({ ...item, ...(Array.isArray(item.fieldIds) && { fieldIds: item.fieldIds.filter(id => id !== field.id) }) })).filter(item => !Array.isArray(item.fieldIds) || item.fieldIds.length)
        if (list.length) next[key] = list; else delete next[key]
      }
      const sort = asObject(next.sortInfo)
      if (Array.isArray(sort.rules)) { const rules = (sort.rules as JsonObject[]).filter(rule => rule.fieldId !== field.id); if (rules.length) next.sortInfo = { ...sort, rules }; else delete next.sortInfo }
      const filter = asObject(next.filterInfo)
      if (Array.isArray(filter.conditions)) { const conditions = (filter.conditions as JsonObject[]).filter(condition => condition.fieldId !== field.id && condition.fieldValueId !== field.id); if (conditions.length) next.filterInfo = { ...filter, conditions }; else delete next.filterInfo }
      const style = asObject(next.style)
      if (style.kanbanFieldId === field.id || style.coverFieldId === field.id) { next.style = { ...style }; if (style.kanbanFieldId === field.id) delete (next.style as JsonObject).kanbanFieldId; if (style.coverFieldId === field.id) delete (next.style as JsonObject).coverFieldId }
      change(['meta', 'views', index], next)
    }
    change(['meta', 'fieldMap', field.id], undefined)
    resources.fieldId = field.id; cmd = 'DeleteFields'
  } else throw new RsqError('INVALID_CONTRACT', '未知数据表上下文适配。')
  if (!actions) throw new RsqError('NO_CHANGES', '目标值与当前业务状态相同，没有发送写请求。', 2)
  const messageId = randomUUID()
  // The HTTP OT service initializes AutoNumber after applying the client's OT.
  // This changes the expected readback, never the submitted changeset.
  if (['field-create', 'field-convert'].includes(action)) {
    const field = snapshot.meta.fieldMap[resources.fieldId]
    if (field.type === 15 && !field.attr?.nextId) {
      const view = snapshot.meta.views[Number(field.attr?.viewIdx)]
      field.attr!.nextId = view.rows.length + 1
    }
  }
  if (action === 'record-create') {
    // createdAt/createdBy/fieldUpdatedMap are supplied by the server. Assert
    // the requested record identity, values and project link independently.
    const index = paths.findIndex(path => path.length === 2 && path[0] === 'recordMap')
    if (index >= 0) paths.splice(index, 1, ['recordMap', resources.recordId, 'id'], ['recordMap', resources.recordId, 'data'])
    if (snapshot.recordMap[resources.recordId].recordMeta?.projectInfo !== undefined) paths.push(['recordMap', resources.recordId, 'recordMeta', 'projectInfo'])
  }
  results.prepared = { snapshot, paths, resources, messageId } satisfies Prepared
  return { body: { roomId: pack.datasheet.id, changesets: [{ baseRevision: pack.datasheet.revision, messageId, resourceId: pack.datasheet.id, resourceType: 0,
    operations: [{ cmd, actions, ...(Object.keys(fieldTypeMap).length && { fieldTypeMap }) }] }] } }
}
export function verifyDatasheet(results: JsonObject) {
  const expected = results.prepared as Prepared, pack = getPack(results, 'verify')
  const mismatches: (string | number)[][] = []
  function compare(actual: unknown, wanted: unknown, path: (string | number)[]) {
    if (isDeepStrictEqual(actual, wanted) || mismatches.length >= 16) return
    if (actual && wanted && typeof actual === 'object' && typeof wanted === 'object' && !Array.isArray(actual) && !Array.isArray(wanted)) {
      for (const key of new Set([...Object.keys(actual), ...Object.keys(wanted)])) compare(asObject(actual)[key], asObject(wanted)[key], [...path, key])
    } else mismatches.push(path)
  }
  for (const path of expected.paths) compare(getPath(pack.snapshot, path), getPath(expected.snapshot, path), path)
  if (pack.datasheet.revision <= getPack(results).datasheet.revision || mismatches.length) {
    throw new RsqError('BUSINESS_ASSERTION_FAILED', 'HTTP 读回未验证数据表变更；请核对资源和版本，不要重复提交。', 5,
      { mismatchPaths: mismatches, revisionAdvanced: pack.datasheet.revision > getPack(results).datasheet.revision })
  }
}
export function describeDatasheet(results: JsonObject, sharedReference = false) {
  const pack = getPack(results), visible = datasheetVisibility(pack as unknown as JsonObject, sharedReference)
  return { datasheetId: pack.datasheet.id, revision: pack.datasheet.revision, permissions: pack.datasheet.permissions,
    fields: visible.fields.map(raw => { const f = raw as Field; return ({ ...f, typeName: names[f.type] ?? 'Unknown', intrinsicWritable: !readonly.has(f.type), role: visible.fieldRoles[f.id], writable: !readonly.has(f.type) && ['manage', 'editor'].includes(visible.fieldRoles[f.id]),
      configuration: fieldContracts.types.find(model => model.type === f.type)?.attrSchema,
      input: [2, 3, 12, 13, 14].includes(f.type) ? 'string 或文本片段数组；null 清空' : [7, 8].includes(f.type) ? 'optionList 中唯一名称或 ID；多选使用数组；null 清空' : f.type === 9 ? '毫秒时间戳或带时区的 ISO 日期；null 清空' : '对应字段类型的 JSON 值；null 清空' }) }),
    views: visible.views, role: datasheetRoleSummary(visible.role), sharedData: pack.sharedData == null ? null : { isOpen: asObject(pack.sharedData).isOpen, sharedScope: asObject(pack.sharedData).sharedScope },
    recordIds: visible.completeTable ? visible.recordIds : [], recordIdsComplete: visible.completeTable, recordScope: visible.completeTable ? 'role-visible-table-records' : 'requires-view-context' }
}
export function verifyDatasheetImport(input: JsonObject, results: JsonObject) {
  const data = asObject(asObject(results.write).data), modules = data.results as JsonObject[], listed = results.modulesVerified as JsonObject[], packs = results.packs as JsonObject[]
  if (!Array.isArray(modules) || !Array.isArray(listed) || !Array.isArray(packs) || !modules.length) throw new RsqError('IMPORT_NO_RESULTS', '导入没有返回成功关联的模块；请先核对当前项目及导入资源，不要重复提交。', 5, { orphanResourcesMayExist: true })
  const before = Array.isArray(results.before) ? results.before as JsonObject[] : []
  for (const [index, module] of modules.entries()) {
    const linked = listed.find(item => String(item.id) === String(module.id)), id = asObject(module.datasheetInfo).datasheetId, pack = asObject(asObject(packs[index]).data)
    if (before.some(item => String(item.id) === String(module.id)) || !linked || asObject(linked.datasheetInfo).datasheetId !== id || asObject(pack.datasheet).id !== id || asObject(pack.snapshot).datasheetId !== id
      || !Object.keys(asObject(asObject(asObject(pack.snapshot).meta).fieldMap)).length || !Object.keys(asObject(asObject(pack.snapshot).recordMap)).length) {
      throw new RsqError('BUSINESS_ASSERTION_FAILED', '导入模块、项目关联或数据表读回不一致。', 5, { projectId: input.projectId, moduleId: module.id, datasheetId: id })
    }
  }
  if (data.failureMessage) throw new RsqError('PARTIAL_SUCCESS', '部分 sheet 导入失败；已成功模块已读回，不要整体重试。', 5, { failureMessage: data.failureMessage, completedModuleIds: modules.map(module => String(module.id)) })
}
export function describeDatasheetImport(results: JsonObject) {
  const modules = asObject(asObject(results.write).data).results as JsonObject[], packs = results.packs as JsonObject[]
  return { imported: modules.map((module, index) => {
    const pack = asObject(asObject(packs[index]).data), snapshot = asObject(pack.snapshot), meta = asObject(snapshot.meta)
    return { moduleId: String(module.id), datasheetId: asObject(module.datasheetInfo).datasheetId, name: module.name,
      fields: Object.keys(asObject(meta.fieldMap)).length, records: Object.keys(asObject(snapshot.recordMap)).length }
  }) }
}
