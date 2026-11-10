import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import Ajv from 'ajv'
import { asObject, RsqError, type JsonObject } from './core.js'
import type { Schema } from './operations.js'

export type Field = { id: string; name: string; type: number; attr?: JsonObject | null; desc?: string; required?: boolean }
export const fieldContracts = JSON.parse(readFileSync(new URL('../contracts/datasheet-fields.json', import.meta.url), 'utf8')) as {
  types: { name: string; type: number; attrSchema: Schema; defaultAttr: JsonObject | null }[]
}
const ajv = new Ajv.default({ strict: false, ownProperties: true, allErrors: true })
function fail(message: string): never { throw new RsqError('INVALID_FIELD_DEFINITION', message, 2) }
export const newId = (prefix: string) => prefix + randomBytes(8).toString('hex').slice(0, 10)

export function fieldReferences(field: Field): string[] {
  const attr = asObject(field.attr)
  if (field.type === 16) {
    // Pure field operands and $_field_$ operands share the same field IDs.
    const expression = String(attr.expression ?? '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').replace(/\$_([\s\S]*?)_\$/g, '$1')
    return [...new Set(expression.match(/\bfld[A-Za-z0-9_-]+\b/g) ?? [])]
  }
  return []
}

/** Merge into the server's field instead of replacing omitted properties. */
export function configureField(raw: JsonObject, existing: Field | undefined, fields: Field[], datasheetId: string, viewIndex: number): Field {
  const model = fieldContracts.types.find(model => model.name === raw.type || model.type === raw.type || existing && raw.type === undefined && model.type === existing.type)
  if (!model) fail('字段类型必须来自 schema 中的当前数据表类型。')
  const type = model.type
  if (existing && existing.type !== type) fail('变更类型请使用 field convert，显式提供每条非空记录的转换值。')
  const name = raw.name ?? existing?.name
  if (typeof name !== 'string' || !name.trim() || name.length > 100) fail('字段名称需要 1 至 100 个字符。')
  if (fields.some(field => field.id !== existing?.id && field.name === name)) fail('字段名称不能重复。')
  const defaults = structuredClone(model.defaultAttr)
  if (raw.attr !== undefined && raw.attr !== null && (typeof raw.attr !== 'object' || Array.isArray(raw.attr))) fail('字段属性需要对象或 null。')
  const attr: JsonObject | null = defaults === null ? raw.attr === undefined ? null : raw.attr as JsonObject | null : {
    ...defaults, ...asObject(existing?.attr), ...asObject(raw.attr),
  }
  if (defaults === null && attr !== null) fail('该字段类型没有可配置属性。')
  if (attr) {
    if ([16, 23, 24].includes(type)) {
      if (Object.hasOwn(asObject(raw.attr), 'datasheetId') && asObject(raw.attr).datasheetId !== datasheetId) fail('字段的所属数据表必须与目标一致。')
      attr.datasheetId = datasheetId
    }
    if (type === 15 && !existing) attr.viewIdx = viewIndex
    if ([7, 8].includes(type)) {
      if (!Array.isArray(attr.optionList)) fail('选项需要 optionList 数组。')
      const oldOptions = (existing?.attr?.optionList ?? []) as JsonObject[]
      const names = new Set(), ids = new Set()
      attr.optionList = (attr.optionList as unknown[]).map((item, index) => {
        const option = typeof item === 'string' ? { name: item } : asObject(item)
        if (typeof option.name !== 'string' || !option.name.trim() || names.has(option.name)) fail('选项名称不能为空或重复。')
        const id = option.id ?? oldOptions.find(o => o.name === option.name)?.id ?? newId('opt')
        if (ids.has(id)) fail('选项 ID 不能重复。')
        names.add(option.name); ids.add(id)
        return { id, name: option.name, color: option.color ?? oldOptions.find(o => o.id === id)?.color ?? 10 + index % 10 }
      })
      const options = attr.optionList as JsonObject[]
      if (!Array.isArray(attr.defaultValue ?? [])) fail('默认选项需要数组。')
      attr.defaultValue = ((attr.defaultValue ?? []) as unknown[]).map(value => {
        const found = options.find(o => o.id === value) ?? options.find(o => o.name === value)
        if (!found) fail('默认选项必须存在于当前选项列表。')
        return found.id
      })
      if (type === 7 && (attr.defaultValue as unknown[]).length > 1) fail('单选字段只能有一个默认选项。')
    }
    if (typeof attr.timeZone === 'string') {
      try { new Intl.DateTimeFormat('en', { timeZone: attr.timeZone }) } catch { fail('日期字段需要有效 IANA 时区。') }
    }
    if (type === 25 && attr.allowAny === false && !attr.applicationId) fail('限定流程应用时必须给出已发现的 applicationId。')
    if (type === 24 && attr.lookUpTargetType === 'workflow' && (!attr.flowApplicationId || !attr.linkStepId || !attr.lookUpTargetStepFieldId)) fail('流程引用需要应用、步骤与步骤字段 ID。')
    if ([23, 24].includes(type) && !(type === 24 && attr.lookUpTargetType === 'workflow') && !attr.linkDatasheetId) fail('关联或查询引用需要 linkDatasheetId。')
  }
  const validate = ajv.compile(model.attrSchema)
  if (!validate(attr)) throw new RsqError('INVALID_FIELD_DEFINITION', '字段属性与当前类型不符。', 2, { issues: validate.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message })) })
  const field: Field = { ...existing, id: existing?.id ?? newId('fld'), name: name as string, type, attr,
    ...(raw.desc !== undefined && { desc: String(raw.desc) }), ...(raw.required !== undefined && { required: raw.required as boolean }) }
  const map = new Map([...fields.filter(f => f.id !== field.id), field].map(f => [f.id, f]))
  const visit = (id: string, stack: Set<string>) => {
    if (stack.has(id)) fail('公式字段不能循环引用。')
    const current = map.get(id)
    if (!current) fail('公式引用了不存在或不可见的字段：' + id)
    for (const ref of fieldReferences(current)) visit(ref, new Set([...stack, id]))
  }
  visit(field.id, new Set())
  return field
}
