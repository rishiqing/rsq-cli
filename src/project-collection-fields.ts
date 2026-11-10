import { createHash, randomInt } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

function fail(message: string, code = 'BUSINESS_ASSERTION_FAILED'): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : code === 'INVALID_INPUT' ? 2 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('缺少可精确识别的字段或项目 ID。', 'CONTEXT_MISSING')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('项目集字段上下文不是完整列表。', 'CONTEXT_MISSING')
const types: Record<string, number> = { text: 1, number: 2, radio: 3, dropdown: 4, date: 5, attachment: 6, member: 22 }
const fieldKeys = ['id', 'name', 'type', 'placeholder', 'selector', 'isCheckBox', 'unit', 'decimalNum', 'dataType', 'dataType2', 'factor', 'isRequired', 'isHidden', 'isNotice', 'noticeContent', 'queryQuoteVO']
function text(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('字段或选项名称须为 1 至 200 字且不能为空白或含控制字符。', 'INVALID_INPUT'); return value }
function options(value: unknown) {
  const items = value == null ? [] : rows(value), seen = new Set<string>()
  return items.map(item => {
    const value = id(item.value ?? item.id)
    if (seen.has(value)) fail('字段选项键重复。', 'CONTEXT_MISSING')
    seen.add(value)
    return { name: item.name, value, relation: item.relation ?? [] }
  })
}
function fieldDTO(field: JsonObject) {
  const out = Object.fromEntries(fieldKeys.filter(key => field[key] !== undefined).map(key => [key, field[key]]))
  if (out.id != null) out.id = id(out.id)
  if (out.selector != null) out.selector = options(out.selector)
  // Header VO expands attachment defaults into file objects; DTO expects their
  // IDs in extraInfo. Omitting this would erase defaults on unrelated edits.
  if (field.defaultFileList != null) out.extraInfo = rows(field.defaultFileList).map(file => id(file.id)).join(',')
  else if (field.extraInfo !== undefined) out.extraInfo = field.extraInfo
  for (const key of ['isCheckBox', 'isRequired', 'isHidden']) out[key] ??= false
  return out
}
const headerKey = (header: JsonObject): string => header.isCustomField === true ? 'field:' + id(asObject(header.field).id) : typeof header.key === 'string' && header.key ? 'key:' + header.key : fail('表头缺少实际固定键或字段 ID。', 'CONTEXT_MISSING')
function headers(value: unknown) {
  const list = rows(value), keys = list.map(headerKey)
  if (new Set(keys).size !== keys.length || keys[0] !== 'key:name' || list[0]!.visible !== true || list.some(item => typeof item.visible !== 'boolean' || typeof item.isCustomField !== 'boolean')) fail('表头重复、可见性不明确或项目名称不是首个可见列。', 'CONTEXT_MISSING')
  return list
}
function wire(list: JsonObject[]) {
  return list.map(header => ({ key: header.isCustomField ? null : header.key, isCustomField: header.isCustomField, visible: header.visible,
    // The assembler derives a custom field's isHidden from header.visible.
    field: header.isCustomField ? { ...fieldDTO(asObject(header.field)), isHidden: header.visible === false } : null }))
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
const version = (list: JsonObject[]) => createHash('sha256').update(JSON.stringify(canonical(wire(list)))).digest('hex')
function collection(input: JsonObject, results: JsonObject, session: Session | null) {
  const current = asObject(results.collection), identity = requireSession(session).identity
  if (id(current.id) !== input.collectionId || !rows(current.members).some(member => id(member.userId) === identity.userId)) fail('当前用户不是所选可见项目集的实际成员。', 'FORBIDDEN')
  results.prepared = { ...asObject(results.prepared), resources: { ...asObject(asObject(results.prepared).resources), collectionId: id(current.id) } }
  return current
}
function selected(list: JsonObject[], input: JsonObject) {
  const key = input.fieldId == null ? 'key:' + input.key : 'field:' + id(input.fieldId), row = list.find(header => headerKey(header) === key)
  return row ?? fail('目标列不在项目集当前表头中；先执行 fields context。', 'INVALID_INPUT')
}
function assertUnchanged(input: JsonObject, results: JsonObject) {
  const before = headers(results.headers), current = headers(results.preflight)
  if (version(before) !== version(current) || input.expectedVersion !== undefined && input.expectedVersion !== version(before)) fail('项目集字段定义或顺序已变化；请读取新上下文，不会覆盖或重放。', 'CONTEXT_CONFLICT')
  return structuredClone(current)
}
function configure(source: JsonObject | undefined, patch: JsonObject) {
  const type = source?.type ?? types[String(patch.type)]
  if (!Object.values(types).includes(Number(type))) fail('此字段类型需要独立业务适配；现有定义会完整保留，不能据此任意改写。', 'INVALID_INPUT')
  if (patch.type != null && types[String(patch.type)] !== type) fail('字段类型不能通过补丁变更。', 'INVALID_INPUT')
  const target: JsonObject = source ? fieldDTO(source) : { name: text(patch.name), type, placeholder: null, selector: null, isCheckBox: false, isRequired: false, isHidden: false, dataType: 1, dataType2: 1, decimalNum: 2 }
  if (patch.name !== undefined) target.name = text(patch.name)
  if (patch.required !== undefined) target.isRequired = patch.required
  if (patch.multiple !== undefined) { if (![3, 4].includes(Number(type))) fail('multiple 只适用于当前选择字段。', 'INVALID_INPUT'); target.isCheckBox = patch.multiple }
  if (patch.precision !== undefined || patch.unit !== undefined) {
    if (type !== 2) fail('precision/unit 只适用于数值字段。', 'INVALID_INPUT')
    if (patch.precision !== undefined) target.decimalNum = patch.precision
    if (patch.unit !== undefined) target.unit = patch.unit ?? ''
  }
  if (patch.options !== undefined) {
    if (![3, 4].includes(Number(type))) fail('options 只适用于选择字段。', 'INVALID_INPUT')
    const existing = source ? options(source.selector) : [], used = new Set(existing.map(item => item.value)), chosen = new Set<string>()
    target.selector = rows(patch.options).map(option => {
      let value: string
      if (option.value !== undefined) { value = id(option.value); if (!used.has(value)) fail('现有选项键必须从 fields context 发现；新选项省略 value。', 'INVALID_INPUT') }
      else { do { value = String(randomInt(1, 2 ** 47)) } while (used.has(value) || chosen.has(value)) }
      if (chosen.has(value)) fail('不能重复提交同一个选项。', 'INVALID_INPUT')
      chosen.add(value)
      const original = existing.find(item => item.value === value)
      return { name: text(option.name), value, ...(original?.relation != null && { relation: original.relation }) }
    })
  }
  if ([3, 4].includes(Number(type)) && !options(target.selector).length) fail('选择字段至少需要一个选项。', 'INVALID_INPUT')
  if (patch.defaultValue !== undefined) {
    if (![1, 2, 3, 4].includes(Number(type))) fail('该类型的默认值需要独立配置适配；现有默认值会保留。', 'INVALID_INPUT')
    target.placeholder = patch.defaultValue ?? ''
  }
  if (type === 2 && target.placeholder !== null && target.placeholder !== '' && target.placeholder !== undefined && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(String(target.placeholder))) fail('数值默认值必须是十进制字符串。', 'INVALID_INPUT')
  if ([3, 4].includes(Number(type)) && target.placeholder) {
    const defaults = String(target.placeholder).split(','), available = new Set(options(target.selector).map(option => option.value))
    if (defaults.some(key => !available.has(key)) || new Set(defaults).size !== defaults.length || target.isCheckBox !== true && defaults.length > 1) fail('默认选项必须来自当前实际选项，删除默认选项时须显式清空或修改 defaultValue。', 'INVALID_INPUT')
  }
  return target
}
function assertDependencies(list: JsonObject[], removed: string[]) {
  for (const header of list) for (const option of options(asObject(header.field).selector)) {
    if (Array.isArray(option.relation) && option.relation.some(key => removed.includes(String(key)))) fail('其他选项仍关联已删除的选项；先处理依赖。', 'DEPENDENCY_EXISTS')
  }
}
function valueContext(input: JsonObject, results: JsonObject) {
  const field = asObject(selected(headers(results.headers), input).field), project = rows(results.projects).find(row => id(row.kanbanId) === input.projectId)
  if (!project) fail('目标项目不在此项目集的实际关联中。', 'INVALID_INPUT')
  const actual = rows(project.customFieldList).find(row => id(row.id) === input.fieldId)
  if (!actual || actual.type !== field.type) fail('项目实例字段与当前定义不一致。', 'CONTEXT_MISSING')
  return { field, actual }
}
function encodeValue(input: JsonObject, results: JsonObject, field: JsonObject) {
  const type = Number(field.type), value = input.value
  if (type === 34 || ![1, 2, 3, 4, 5, 22].includes(type)) fail('该字段为计算引用或需要专门的附件/业务适配，不能用通用值命令覆盖。', 'INVALID_INPUT')
  if (value === null) { if (field.isRequired === true) fail('必填字段不能清空。', 'INVALID_INPUT'); return type === 5 ? null : '' }
  if (type === 1) { if (typeof value !== 'string' || field.isRequired === true && !value.trim()) fail('文本字段须传字符串，必填字段不能清空。', 'INVALID_INPUT'); return value }
  if (type === 2) {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) fail('数值字段须传十进制字符串，保留长数字和小数精度。', 'INVALID_INPUT')
    // This service's VO converter incorrectly drops scale-zero BigDecimal.ZERO.
    // A decimal zero persists the same number and survives independent readback.
    return /^-?0$/.test(value) ? '0.0' : value
  }
  if (type === 5) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('日期须为有效的 YYYY-MM-DD，不依赖本机时区。', 'INVALID_INPUT')
    return value.replaceAll('-', '.')
  }
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string') || new Set(value).size !== value.length) fail('人员和选项值须为去重的 ID 字符串数组，清空请显式传 null。', 'INVALID_INPUT')
  if (!value.length) { if (field.isRequired === true) fail('必填字段不能清空。', 'INVALID_INPUT'); return '' }
  const available = new Set(type === 22 ? companyDirectoryUsers(results.directory).map(user => id(user.id)) : options(field.selector).map(option => option.value))
  if (value.some(key => !available.has(key))) fail('值必须来自当前公司通讯录或字段实际选项。', 'INVALID_INPUT')
  if (type !== 22 && field.isCheckBox !== true && value.length > 1) fail('当前字段为单选，只能选择一个实际选项。', 'INVALID_INPUT')
  return value.join(',')
}
export function prepareCollectionFields(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  collection(input, results, session)
  const action = kind.slice('collection-fields-'.length)
  if (action === 'context') { headers(results.headers); return null }
  if (action === 'readback') {
    const added = headers(results.changed).filter(header => header.isCustomField === true && !headers(results.headers).some(before => headerKey(before) === headerKey(header)))
    if (added.length === 1) results.prepared = { ...asObject(results.prepared), resources: { ...asObject(asObject(results.prepared).resources), fieldId: id(asObject(added[0]!.field).id) } }
    return { query: { id: input.collectionId } }
  }
  if (action === 'value') {
    const { field, actual } = valueContext(input, results), { actual: before } = valueContext(input, { ...results, projects: results.beforeProjects })
    if (asObject(actual.editControl).canEdit !== true) fail('实例字段的当前 UI 权限不允许编辑。', 'FORBIDDEN')
    if (!isDeepStrictEqual(actual, before) || version(headers(results.headers)) !== version(headers(results.preflight)) || input.expectedVersion !== undefined && input.expectedVersion !== version(headers(results.headers))) fail('字段定义、权限或实例值在写入前已变化。', 'CONTEXT_CONFLICT')
    if (input.time !== undefined && field.type !== 5) fail('time 仅适用于日期字段。', 'INVALID_INPUT')
    if (field.type === 5 && (input.value === null || input.time !== undefined)) fail('当前项目集服务不能持久清空日期或正确读回日期与时间；需要服务端修复，未发送写请求。', 'PERSISTENCE_UNSUPPORTED')
    const value = encodeValue(input, results, field)
    results.prepared = { ...asObject(results.prepared), valueType: field.type, valueExpected: input.value, timeExpected: input.time, otherValues: rows(rows(results.projects).find(row => id(row.kanbanId) === input.projectId)!.customFieldList).filter(row => id(row.id) !== input.fieldId) }
    return { body: { projectId: input.projectId, fieldId: input.fieldId, value, ...(input.time !== undefined && { time: input.time }) } }
  }
  const list = assertUnchanged(input, results)
  if (action === 'create') list.push({ key: null, isCustomField: true, visible: true, field: configure(undefined, asObject(input.definition)) })
  else {
    const current = selected(list, input), index = list.indexOf(current)
    if (action === 'visibility') { if (current.key === 'name') fail('项目名称必须保持可见。', 'INVALID_INPUT'); current.visible = input.visible }
    else if (action === 'move') {
      const anchor = selected(list, { key: input.targetKey, fieldId: input.targetFieldId })
      if (current.key === 'name' || current === anchor || anchor.key === 'name' && input.position === 'before') fail('不能移动项目名称、移到自身或插入名称列之前。', 'INVALID_INPUT')
      list.splice(index, 1); list.splice(list.indexOf(anchor) + (input.position === 'after' ? 1 : 0), 0, current)
    } else {
      if (current.isCustomField !== true) fail('固定业务列不能通过自定义字段命令修改或删除。', 'INVALID_INPUT')
      const original = asObject(current.field), removed = options(original.selector).map(option => option.value)
      if (action === 'update') { current.field = configure(original, asObject(input.patch)); assertDependencies(list, removed.filter(key => !options(asObject(current.field).selector).some(option => option.value === key))) }
      else if (action === 'remove') { list.splice(index, 1); assertDependencies(list, removed) }
      else fail('未知项目集字段操作。', 'INVALID_CONTRACT')
    }
  }
  const payload = wire(list)
  results.prepared = { ...asObject(results.prepared), expectedHeaders: payload, action }
  return { body: { id: input.collectionId, fieldList: payload } }
}
export function describeCollectionFields(input: JsonObject, results: JsonObject, session: Session | null) {
  collection(input, results, session)
  const current = headers(results.verified ?? results.headers), prepared = asObject(results.prepared)
  if (prepared.expectedHeaders) {
    const actual = wire(current), expected = rows(prepared.expectedHeaders)
    if (actual.length !== expected.length) fail('独立读取的完整表头集合不一致；请读回核对，不会重放。')
    for (let index = 0; index < expected.length; index++) {
      const wanted = expected[index]!, found = actual[index]!, wantField = asObject(wanted.field), actualField = asObject(found.field)
      // An empty placeholder must be sent as '' to clear the stored default;
      // null is skipped by the DAO. Only the readback VO converts '' to null.
      if (wanted.key !== found.key || wanted.visible !== found.visible || wanted.isCustomField !== found.isCustomField || Object.entries(wantField).some(([key, value]) => !(key === 'placeholder' && value === '' && actualField[key] === null) && !isDeepStrictEqual(value, actualField[key]))) fail('表头、字段定义、选项或默认配置读回不一致；已完成步骤和资源 ID 可用于核对。')
    }
  }
  if (prepared.valueType !== undefined) {
    const { actual } = valueContext(input, { ...results, projects: results.verifiedProjects }), expected = prepared.valueExpected, value = actual.value
    const matches = expected === null || Array.isArray(expected) && !expected.length ? (value == null || value === '') && (prepared.valueType !== 5 || (actual.date == null || actual.date === '') && (actual.time == null || actual.time === '')) : prepared.valueType === 5 ? actual.date === String(expected).replaceAll('-', '.') && (prepared.timeExpected === undefined ? actual.time == null || actual.time === '' : actual.time === prepared.timeExpected) : Array.isArray(expected) ? isDeepStrictEqual(String(value ?? '').split(',').filter(Boolean).sort(), [...expected].sort()) : prepared.valueType === 2 ? typeof value === 'string' && normalizeDecimal(String(expected)) === normalizeDecimal(value) : value === expected
    const other = rows(rows(results.verifiedProjects).find(row => id(row.kanbanId) === input.projectId)!.customFieldList).filter(row => id(row.id) !== input.fieldId)
    if (!matches || !isDeepStrictEqual(other, prepared.otherValues)) fail('字段值或日期时间读回不一致，或其他实例字段被改变；请核对服务端结果，不会重放。')
    return { collectionId: input.collectionId, projectId: input.projectId, field: actual, contextVersion: version(current) }
  }
  return { collectionId: input.collectionId, contextVersion: version(current), headers: current, supportedDefinitionTypes: types, valueCommands: ['project collection field value get', 'project collection field value set'],
    ...(input.projectId !== undefined && { projectId: input.projectId, values: rows(rows(results.projects).find(row => id(row.kanbanId) === input.projectId)?.customFieldList), ...(input.fieldId !== undefined && { field: valueContext(input, results).actual }) }),
    ...(prepared.resources !== undefined && { resources: prepared.resources }), concurrency: 'fresh HTTP comparison; no atomic server CAS' }
}
function normalizeDecimal(value: string) { const [integer, fraction = ''] = value.split('.'), normalized = integer!.replace(/^(-?)0+(?=\d)/, '$1') + (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : ''); return /^-?0$/.test(normalized) ? '0' : normalized }
