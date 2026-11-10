import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'

const fail = (message: string): never => { throw new RsqError('CONTEXT_MISSING', message, 5) }
const id = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : fail('流程模板缺少精确 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('流程模板目录没有返回完整列表。')

/** Global catalogue entries are applied to a new customer application; they
 * are not customer-owned applications and must not be passed to application CRUD. */
export function describeWorkflowTemplates(input: JsonObject, results: JsonObject) {
  const catalogue = asObject(asObject(results.templates).data), templates = new Map<string, JsonObject>(), groups: JsonObject[] = []
  const groupIds = new Set<string>()
  for (const section of ['custom', 'normal']) for (const group of rows(catalogue[section])) {
    const groupId = group.id === 'empty' ? 'empty' : id(group.id)
    if (groupIds.has(groupId) || typeof group.name !== 'string' || !group.name.trim()) fail('流程模板分组重复或名称缺失。')
    groupIds.add(groupId)
    const children = rows(group.childCover ?? []), memberIds = new Set<string>()
    for (const child of children) {
      const templateId = id(child.id)
      if (memberIds.has(templateId) || typeof child.name !== 'string' || !child.name.trim() || ![0, 1].includes(child.mode as number)) fail('模板重复、名称或运行模式不完整，不能猜测应用上下文。')
      memberIds.add(templateId)
      if (child.skipUrl != null && typeof child.skipUrl !== 'string') fail('模板咨询入口格式不正确。')
      const consultationOnly = typeof child.skipUrl === 'string' && child.skipUrl.length > 0
      const definition = { id: templateId, name: child.name, mode: child.mode, cover: child.cover ?? null, consultationOnly }
      const prior = templates.get(templateId)
      if (prior && !isDeepStrictEqual(prior.definition, definition)) fail('同一模板在不同分组的内容冲突，未选择任意一个版本。')
      if (prior) (prior.groupIds as string[]).push(groupId)
      else templates.set(templateId, { definition, groupIds: [groupId] })
      if (templates.size > 10000) fail('流程模板目录超过完整核对上限。')
    }
    groups.push({ id: groupId, name: group.name, section, templateIds: [...memberIds] })
  }
  const describe = (row: JsonObject) => {
    const definition = asObject(row.definition)
    return { ...definition, groupIds: row.groupIds, catalogueScope: 'platform',
      application: definition.consultationOnly ? { supported: false, reason: 'consultation-entry' }
        : { supported: true, command: 'workflow template apply', fixedInput: { templateId: definition.id }, requiredInput: ['name'], optionalInput: ['groupId', 'cover', 'memberIds', 'deptIds', 'introduction', 'isStar'],
          creates: 'customer-owned-workflow-application', readback: ['application', 'forms', 'steps'], definitionCommand: 'workflow configuration inspect' } }
  }
  const available = [...templates.values()].map(describe), covers = rows(asObject(results.covers).data)
  if (covers.some(row => typeof row.cover !== 'string' || !row.cover)) fail('流程封面上下文不完整。')
  let selected
  if (input.templateId !== undefined) {
    const row = templates.get(id(input.templateId))
    if (!row) throw new RsqError('RESOURCE_NOT_VISIBLE', '指定模板不在当前模板目录中；请先查 workflow template context。', 4)
    selected = describe(row)
  }
  return { groups, templates: available, covers: covers.map(row => ({ cover: row.cover })), ...(selected && { selected }),
    maintenance: { catalogueScope: 'platform', customerCatalogueMutationExposed: false, basis: 'pinned-current-customer-entry-and-platform-team-zero-assembler',
      appliedApplicationCommands: ['workflow configuration inspect', 'workflow application rename', 'workflow application clone', 'workflow application remove'],
      definitionCommands: ['workflow form define', 'workflow form field add', 'workflow form field configure', 'workflow form field remove', 'workflow step configure', 'workflow configuration graph apply', 'workflow configuration deploy'],
      applicationIdRequired: true, templateIdIsNotApplicationId: true, platformGenerationRouteExposed: false },
    changed: false }
}
