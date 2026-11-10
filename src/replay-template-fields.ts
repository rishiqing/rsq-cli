import { asObject, RsqError, type JsonObject } from './core.js'

export const replayComponentFieldTypes = {
  importTask: ['type', 'member', 'date', 'finishTime', 'progress', 'label', 'priority', 'participant', 'from', 'text'],
  importObjective: ['grade', 'progress', 'responsibleUser', 'confident', 'progressNote', 'text', 'keyAction'],
} as const
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
export function replayTemplateComponent(input: JsonObject, current?: JsonObject): JsonObject {
  const type = String(current?.type ?? input.type), result: JsonObject = { ...current, type, name: input.name ?? current?.name, isRequired: false }
  if (!['importTask', 'importObjective', 'file', 'createTask'].includes(type) || typeof result.name !== 'string' || !result.name.trim() || result.name.length > 200) return invalid('请选择当前支持的非问题组件及非空名称；问题组件使用 question 命令。')
  if (type === 'file') {
    if (input.fields !== undefined) return invalid('附件组件不支持导入字段。')
    result.isRequired = input.required ?? current?.isRequired ?? false
  } else if (input.required !== undefined) return invalid('只有附件组件支持此 required 参数。')
  if (type === 'createTask') {
    if (input.fields !== undefined) return invalid('创建任务组件不支持导入字段。')
    return result
  }
  if (type === 'file') return result
  const key = type === 'importTask' ? 'importTaskFieldList' : 'importObjectiveFieldList'
  if (input.fields === undefined && current) return result
  if (!Array.isArray(input.fields) || input.fields.length > 100) return invalid('导入组件须明确提供完整 fields 列表，最多 100 项；空数组表示无额外列。')
  const old = Array.isArray(current?.[key]) ? (current[key] as unknown[]).map(asObject) : [], seenIds = new Set<string>(), seenSystem = new Set<string>()
  result[key] = input.fields.map(value => {
    const field = asObject(value), existing = field.id === undefined ? undefined : old.find(old => String(old.id) === field.id)
    if (field.id !== undefined && (!existing || seenIds.has(String(field.id)))) return invalid('字段 ID 不属于当前组件或重复。')
    if (field.id !== undefined) seenIds.add(String(field.id))
    const kind = field.type ?? existing?.type, name = field.name ?? existing?.name, isOpen = field.isOpen ?? existing?.isOpen ?? true
    const allowed = replayComponentFieldTypes[type as keyof typeof replayComponentFieldTypes] as readonly string[]
    if (typeof kind !== 'string' || !allowed.includes(kind) || existing && existing.type !== kind) return invalid('导入字段类型不合法；已有字段不能原位改变类型。')
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof isOpen !== 'boolean') return invalid('字段须有非空名称和明确的 isOpen。')
    if (!['text', 'keyAction'].includes(kind)) {
      if (seenSystem.has(kind)) return invalid('同一导入组件不能重复配置系统字段。')
      seenSystem.add(kind)
    }
    return { ...(existing && { id: String(existing.id) }), name, type: kind, isOpen }
  })
  return result
}
