import { asObject, RsqError, type JsonObject } from './core.js'

const missing = (message: string): never => { throw new RsqError('CONTEXT_MISSING', message, 5) }
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : missing('数据表权限上下文必须是对象。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : missing('数据表权限上下文缺少完整列表。')
const modes = ['manageFields', 'editAll', 'readOnly', 'custom']
export const datasheetTypeNames = ['NotSupport', 'Number', 'Text', 'SingleText', 'Currency', 'Percent', 'Rank', 'SingleSelect', 'MultiSelect', 'DateTime', 'Checkbox', 'Attach', 'Url', 'Tel', 'Email', 'AutoNumber', 'Formula', 'Member', 'Dept', 'CreatedMember', 'ModifiedMember', 'CreatedTime', 'ModifiedTime', 'Link', 'LookUp', 'Workflow', 'Project']

function flags(value: unknown) {
  const row = object(value)
  if (typeof row.canView !== 'boolean' || ['canEdit', 'canAdd'].some(key => Object.hasOwn(row, key) && typeof row[key] !== 'boolean')) missing('字段权限缺少明确布尔值。')
  return row
}

/** Reproduce the current UI's field role and server-computed row visibility. */
export function datasheetVisibility(data: JsonObject, sharedReference = false) {
  const table = object(data.datasheet), snapshot = object(data.snapshot), meta = object(snapshot.meta)
  const fields = object(meta.fieldMap), recordMap = object(snapshot.recordMap), role = object(data.datasheetPermission)
  if (typeof table.id !== 'string' || snapshot.datasheetId !== table.id || !Number.isSafeInteger(table.revision) || Number(table.revision) < 0) missing('数据表身份或 revision 不一致。')
  if (role.dstId !== undefined && role.dstId !== table.id) missing('数据表角色属于其他表。')
  if (!['custom', 'readOnly'].includes(String(role.permissionMode)) || !['all', 'partial'].includes(String(role.viewRecordScope)) || !['all', 'partial', 'none'].includes(String(role.editRecordScope)) || !modes.includes(String(role.fieldEditMode)) || !['all', 'partial'].includes(String(role.viewAccessScope))) missing('数据表缺少完整行、列和视图权限。')
  if (role.permissionMode === 'readOnly' && (role.fieldEditMode !== 'readOnly' || role.editRecordScope !== 'none')) missing('仅查看权限与字段或记录权限相矛盾。')
  if (Object.keys(fields).length > 1000 || Object.keys(recordMap).length > 100000) missing('数据表超出有界 HTTP 读取范围。')
  const configuration = role.fieldEditMode === 'custom' ? object(role.fieldPermissions) : undefined
  const entries = configuration ? rows(configuration.fields) : [], seen = new Set<string>()
  if (configuration) flags(configuration.newAddFiled)
  for (const entry of entries) {
    if (typeof entry.fieldId !== 'string' || seen.has(entry.fieldId)) missing('字段权限 ID 缺失或重复。')
    seen.add(String(entry.fieldId)); flags(entry)
  }
  const fieldRoles: Record<string, string> = Object.create(null)
  const visibleFields = Object.entries(fields).filter(([key, raw]) => {
    const field = object(raw)
    if (field.id !== key || typeof field.name !== 'string' || !Number.isInteger(field.type) || Number(field.type) < 0 || Number(field.type) > 26) missing('数据表字段定义不完整。')
    let fieldRole = ({ manageFields: 'manage', editAll: 'editor', readOnly: 'reader' } as Record<string, string>)[String(role.fieldEditMode)]
    if (configuration) {
      const permission = flags(entries.find(entry => entry.fieldId === key) ?? configuration.newAddFiled)
      // This is the actual fieldPermissionsToRole fallback, including old DTOs.
      fieldRole = (Object.hasOwn(permission, 'canEdit') ? permission.canEdit : permission.canView) === true ? 'editor' :
        (Object.hasOwn(permission, 'canAdd') ? permission.canAdd : permission.canView) === true ? 'add' : permission.canView === true ? 'reader' : 'none'
    }
    if (role.editRecordScope === 'none' && fieldRole !== 'none') fieldRole = 'reader'
    fieldRoles[key] = fieldRole
    return fieldRole !== 'none'
  }).map(([, field]) => object(field))
  const visibleFieldIds = new Set(visibleFields.map(field => String(field.id)))
  const shared = asObject(data.sharedData)
  if (sharedReference && shared.isOpen !== true) throw new RsqError('RESOURCE_FORBIDDEN', '数据表共享引用当前没有开放。', 4)
  const requiresMatches = role.viewRecordScope === 'partial' || role.editRecordScope === 'partial' || shared.isOpen === true || sharedReference
  const matches = Object.hasOwn(role, 'matchRecordMap') ? object(role.matchRecordMap) : undefined
  if (requiresMatches && !matches) missing('局部记录或共享数据表缺少服务端逐行权限，不可退化为全表读取。')
  const recordIds = Object.keys(recordMap).filter(key => {
    const record = object(recordMap[key])
    if (record.id !== key || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) missing('数据表记录身份或数据不完整。')
    if (!matches) return true
    const match = Object.hasOwn(matches, key) ? object(matches[key]) : missing('逐行权限未覆盖当前记录。')
    if (typeof match.canView !== 'boolean') missing('逐行权限缺少明确 canView。')
    return match.canView
  }).sort()
  const permitted = role.viewAccessScope === 'partial' ? rows(role.viewPermissions) : []
  const views = rows(meta.views).filter(view => {
    if (role.viewAccessScope !== 'partial') return true
    const match = permitted.filter(entry => entry.id === view.id)
    if (match.length !== 1 || typeof match[0].canManage !== 'boolean') missing('局部视图权限缺失或重复，请刷新上下文。')
    return match[0].canManage
  })
  const completeTable = role.viewAccessScope === 'all'
  const visibleRecords = new Set(recordIds)
  return { table, snapshot, role, fields: visibleFields, fieldRoles, fieldIds: visibleFieldIds, recordMap, recordIds,
    completeTable, views: views.map(view => ({ ...view,
      columns: rows(view.columns).filter(column => visibleFieldIds.has(String(column.fieldId))),
      // A partial view needs the full UI filter engine; never expose its raw rows.
      rows: completeTable ? rows(view.rows).filter(row => visibleRecords.has(String(row.recordId))) : [],
    } as JsonObject)) }
}

export function datasheetRoleSummary(role: JsonObject) {
  return Object.fromEntries(['roleId', 'permissionMode', 'canCreateRecord', 'canDeleteRecord', 'editRecordScope', 'viewRecordScope', 'fieldEditMode', 'manageView', 'viewAccessScope'].filter(key => Object.hasOwn(role, key)).map(key => [key, role[key]]))
}

const dateFormats = ['YYYY/MM/DD', 'YYYY-MM-DD', 'DD/MM/YYYY', 'YYYY-MM', 'MM-DD', 'YYYY', 'MM', 'DD', 'YYYY年', 'MM月', 'DD日', 'YYYYMMDD', 'YYYYMM', 'MMDD']
function generatedNumber(field: JsonObject, record: JsonObject) {
  const meta = asObject(record.recordMeta), update = asObject(asObject(meta.fieldUpdatedMap)[String(field.id)])
  if (!meta.fieldUpdatedMap || update.autoNumber == null) return null
  const rules = rows(asObject(field.attr).ruleList)
  if (!rules.length) return null
  const result = rules.map(rule => {
    if (rule.rule === 'string') return typeof rule.text === 'string' ? rule.text : ''
    if (rule.rule === 'autoNumber') {
      const digit = rule.digit ?? 0
      if (!Number.isSafeInteger(digit) || Number(digit) < 0 || Number(digit) > 1000) missing('自动编号位数无效。')
      return String(update.autoNumber || '').padStart(Number(digit), '0')
    }
    if (rule.rule !== 'createTime') missing('自动编号包含未知规则。')
    if (!meta.createdAt) return ''
    const format = dateFormats[Number(rule.format ?? 0)]
    if (!format) missing('自动编号日期格式无效。')
    const instant = new Date(Number(meta.createdAt))
    if (!Number.isFinite(instant.valueOf())) missing('自动编号创建时间无效。')
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(part => [part.type, part.value]))
    return format.replace(/YYYY|MM|DD/g, token => parts[{ YYYY: 'year', MM: 'month', DD: 'day' }[token]!])
  }).join('')
  return result || asObject(record.data)[String(field.id)] || null
}

/** Stable CLI values; computed values keep their full result list, not a UI guess. */
export function datasheetReadCell(field: JsonObject, record: JsonObject): JsonObject {
  const meta = asObject(record.recordMeta), updates = asObject(meta.fieldUpdatedMap)
  const stored = () => asObject(record.data)[String(field.id)] ?? null
  if (field.type === 15) return { encoding: 'generated-number', value: generatedNumber(field, record), timeZone: 'Asia/Shanghai' }
  if (field.type === 16 || field.type === 24) {
    const computed = asObject(updates[String(field.id)]).computedValue
    if (computed == null) return { encoding: 'computed-result-list', value: null, computed: false }
    const values = rows(computed)
    return { encoding: 'computed-result-list', value: values.map(item => item.value ?? null), displayValues: values.map(item => item.displayValue ?? null), computed: true }
  }
  if (field.type === 19) return { encoding: 'member-id-list', value: meta.createdBy ? [String(meta.createdBy)] : null }
  if (field.type === 20) {
    let last: JsonObject = { at: 0, by: null }
    for (const raw of Object.values(updates)) { const update = asObject(raw); if (update.at && update.by && !(Number(last.at) > Number(update.at))) last = update }
    return { encoding: 'member-id-list', value: last.by ? [String(last.by)] : null }
  }
  if (field.type === 21) {
    const time = meta.createdAt == null ? null : new Date(meta.createdAt as string | number).valueOf()
    if (time !== null && !Number.isFinite(time)) missing('记录创建时间无效。')
    return { encoding: 'epoch-ms', value: time }
  }
  if (field.type === 22) {
    const times = Object.values(updates).map(value => asObject(value).at).filter(Boolean).map(Number)
    if (times.some(time => !Number.isFinite(time))) missing('记录修改时间无效。')
    return { encoding: 'epoch-ms', value: times.length ? Math.max(...times) : null }
  }
  if (field.type === 26) {
    const projects = meta.projectInfo == null ? [] : Array.isArray(meta.projectInfo) ? rows(meta.projectInfo) : [object(meta.projectInfo)]
    const selected = asObject(field.attr).isMulti ? projects : projects.slice(0, 1)
    return { encoding: 'project-list', value: selected.length ? selected.map(project => ({ id: String(project.id), name: project.name })) : null }
  }
  return { encoding: 'native-stored', value: stored() }
}
