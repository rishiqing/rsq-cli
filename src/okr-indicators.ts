import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { fingerprint } from './fingerprint.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'

export const okrIndicatorActions = ['context', 'library', 'inspect', 'create', 'edit', 'split', 'stop', 'remove', 'dimensions', 'dimension-create', 'dimension-update', 'dimension-remove', 'fields', 'field-create', 'field-rename', 'field-move', 'field-remove', 'values', 'value-set', 'records', 'record-create', 'record-update', 'record-remove'] as const
export type OkrIndicatorAction = typeof okrIndicatorActions[number]
type Route = [string, string, string]
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('指标资源 ID 必须是精确的正整数字符串。', 'INVALID_INPUT')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('指标接口没有返回有界列表。')
const name = (value: unknown): string => typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : fail('名称须为 1 至 200 字符的非空文本。', 'INVALID_INPUT')
const version = (value: unknown) => fingerprint(value)
const ids = (list: JsonObject[]) => list.map(item => id(item.id))
const requireControl = (value: unknown, permission: string) => { if (asObject(asObject(value).editControl)[permission] !== true) fail('当前指标没有 ' + permission + ' 权限。', 'FORBIDDEN') }
const unique = (values: string[], message: string) => { if (new Set(values).size !== values.length) fail(message, 'INVALID_INPUT') }
function assertVersion(before: unknown, after: unknown) { if (version(before) !== version(after)) fail('指标上下文已变化；请重新发现并核对，未重放写请求。', 'CONTEXT_CONFLICT') }
function expect(value: boolean, message: string) { if (!value) fail(message, 'VERIFICATION_FAILED') }
const equalNumber = (actual: unknown, expected: string) => (typeof actual === 'number' && Number.isFinite(actual) || typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual))) && Number(actual) === Number(expected)

export function indicatorTime(type: unknown, value: unknown): string {
  if (typeof value !== 'string') fail('必须显式指定数据时间。', 'INVALID_INPUT')
  const patterns: Record<string, RegExp> = { day: /^\d{4}-\d{2}-\d{2}$/, week: /^\d{4}-W(?:[1-9]|[1-4][0-9]|5[0-3])$/, month: /^\d{4}-(?:0[1-9]|1[0-2])$/, quarter: /^\d{4}-Q[1-4]$/, semiannual: /^\d{4}-H[12]$/, year: /^\d{4}$/ }
  if (!patterns[String(type)]?.test(value) || Number(value.slice(0, 4)) < 1900 || Number(value.slice(0, 4)) > 9999) fail('数据时间与 timeType 不一致。day=YYYY-MM-DD，week=YYYY-W1，month=YYYY-MM，quarter=YYYY-Q1，semiannual=YYYY-H1，year=YYYY。', 'INVALID_INPUT')
  if (type === 'day') { const parsed = new Date(value + 'T00:00:00Z'); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('数据时间不是有效日历日期。', 'INVALID_INPUT') }
  if (type === 'week' && value.endsWith('W53')) { const day = new Date(value.slice(0, 4) + '-01-01T00:00:00Z').getUTCDay(), leap = new Date(value.slice(0, 4) + '-12-31T00:00:00Z').getUTCDay() === 4; if (day !== 4 && !leap) fail('该年份没有第 53 周。', 'INVALID_INPUT') }
  return value
}
export function indicatorNumber(value: unknown, clear = false): string {
  if (clear && value === null) return '' // The backend uses an empty string to clear; JSON null means omitted.
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/.test(value)) fail('指标数值须为十进制字符串，整数最多 10 位、小数最多 6 位；显式 null 才表示清空。', 'INVALID_INPUT')
  return value
}
function attributionKey(value: JsonObject) { return value.type === 'company' ? 'company' : String(value.type) + ':' + id(value.id) }
function attributionTree(value: unknown, depth = 0, seen = new Set<string>()): JsonObject[] {
  if (depth > 20) fail('指标组织树过深。', 'CONTEXT_LIMIT')
  return rows(value).map(item => { if (!['company', 'dept', 'person'].includes(String(item.type))) fail('指标组织类型未知。'); const key = attributionKey(item); if (seen.has(key)) fail('指标组织树出现循环，无法确定上下文。', 'CONTEXT_CONFLICT'); return { ...item, childList: attributionTree(item.childList ?? [], depth + 1, new Set([...seen, key])) } })
}
function findAttribution(list: JsonObject[], type: unknown, target?: unknown): JsonObject | undefined {
  for (const item of list) { if (item.type === type && (type === 'company' || id(item.id) === id(target))) return item; const found = findAttribution(rows(item.childList ?? []), type, target); if (found) return found }
  return undefined
}

// Public breakdown nodes use organization/option IDs, never internal indicator IDs.
// Build the exact current UI HTTP tree after discovering its organizations and dimensions.
export function buildIndicatorBreakdown(root: JsonObject, breakdown: unknown, dimensions: JsonObject[], dimensionIds: string[]): JsonObject[] {
  unique(dimensionIds, '拆解维度不能重复。')
  if (dimensionIds.length > 10 || dimensionIds.some(key => !dimensions.some(item => id(item.id) === key))) fail('拆解维度不属于当前公司，或超过 10 个。', 'INVALID_INPUT')
  let count = 0
  const build = (organization: JsonObject | null, option: JsonObject | null, value: unknown, used: Set<string>, depth: number): JsonObject => {
    if (++count > 2000 || depth > 12) fail('拆解树超过 2000 节点或 12 层。', 'CONTEXT_LIMIT')
    const spec = asObject(value ?? { by: 'none' }), by = spec.by ?? 'none', children = rows(spec.children ?? [])
    if (Object.keys(spec).some(key => !['by', 'dimensionId', 'children'].includes(key)) || !['none', 'organization', 'dimension'].includes(String(by))) fail('拆解结构包含未知属性或方式。', 'INVALID_INPUT')
    const output: JsonObject = { ...(organization && !option && { ...(organization.type !== 'company' && { id: id(organization.id) }), attributionType: organization.type }), ...(option && { id: id(option.id) }), splitMode: by === 'organization' ? 'attribution' : by, childs: [] }
    if (by === 'none') { if (children.length || spec.dimensionId != null) fail('不拆解的节点不能有子节点或维度。', 'INVALID_INPUT'); return output }
    if (!children.length) fail('拆解必须显式选择至少一个子节点。', 'INVALID_INPUT')
    let candidates: JsonObject[], nextUsed = used
    if (by === 'dimension') {
      const key = id(spec.dimensionId)
      if (!dimensionIds.includes(key) || used.has(key)) fail('维度未选中，或在同一路径重复拆解。', 'INVALID_INPUT')
      output.splitDimensionId = key; nextUsed = new Set([...used, key]); candidates = rows(dimensions.find(item => id(item.id) === key)!.itemList)
    } else {
      if (spec.dimensionId != null || !organization || organization.type === 'person') fail('当前节点不能按组织拆解。', 'INVALID_INPUT')
      candidates = rows(organization.childList ?? [])
    }
    const selected = new Set<string>()
    output.childs = children.map(child => {
      if (Object.keys(child).some(key => !['type', 'id', 'breakdown'].includes(key))) fail('拆解子节点包含未知属性。', 'INVALID_INPUT')
      const key = id(child.id), match = candidates.find(item => item.id != null && id(item.id) === key && (by === 'dimension' ? child.type === 'dimension' : item.type === child.type))
      const nodeKey = String(child.type) + ':' + key
      if (!match || selected.has(nodeKey)) fail('子节点不属于当前组织或维度，或重复出现。', 'INVALID_INPUT')
      selected.add(nodeKey)
      return build(by === 'dimension' ? organization : match, by === 'dimension' ? match : null, child.breakdown, nextUsed, depth + 1)
    })
    return output
  }
  return [build(root, null, breakdown, new Set(), 0)]
}
function verifySplit(expected: unknown, actual: unknown, selected: string[], actualDimensions: unknown) {
  const normalized = (list: JsonObject[], depth = 0): unknown => {
    if (depth > 12) fail('拆解读回超过节点深度限制。', 'CONTEXT_LIMIT')
    return list.map(item => ({ ...(item.attributionType !== 'company' && { id: id(item.id) }), attributionType: item.attributionType ?? null, splitMode: item.splitMode, splitDimensionId: item.splitDimensionId == null ? null : id(item.splitDimensionId), childs: normalized(rows(item.childs ?? []), depth + 1) }))
  }
  expect(version(ids(rows(actualDimensions)).sort()) === version(selected.slice().sort()), '指标拆解维度读回不一致。')
  expect(version(normalized(rows(expected))) === version(normalized(rows(actual))), '指标拆解树读回不一致。')
}

export function okrIndicatorSteps(action: OkrIndicatorAction): Route[] {
  const base: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['sidebar', 'GET', '/task/okr/objective/sidebar'], ['library', 'GET', '/task/okr/indicator/library/list'], ['dimensions', 'GET', '/task/okr/indicator/dimension/list'], ['attributions', 'GET', '/task/okr/indicator/auth/optional/attribution/list']]
  if (['context', 'library', 'dimensions'].includes(action)) return base
  if (action.startsWith('dimension-')) return [...base, [action, action === 'dimension-create' ? 'POST' : action === 'dimension-update' ? 'PUT' : 'DELETE', '/task/okr/indicator/dimension']]
  const detail: Route[] = [...base, ['definition', 'GET', '/task/okr/indicator/definition'], ['splitInfo', 'GET', '/task/okr/indicator/split/info'], ['root', 'GET', '/task/okr/indicator/root/byDefinitionId']]
  if (action === 'create') return [...base, ['created', 'POST', '/task/okr/indicator'], ['root', 'GET', '/task/okr/indicator/root/byDefinitionId'], ['definition', 'GET', '/task/okr/indicator/definition'], ['splitInfo', 'GET', '/task/okr/indicator/split/info']]
  if (action === 'inspect') return detail
  if (action === 'edit' || action === 'split') return [...detail, ['mutated', 'PUT', '/task/okr/indicator/definition']]
  if (action === 'stop' || action === 'remove') return [...detail, ['mutated', action === 'stop' ? 'PUT' : 'DELETE', '/task/okr/indicator/definition' + (action === 'stop' ? '/stop' : '')]]
  if (action === 'fields' || action.startsWith('field-')) return [...detail, ['fields', 'GET', '/task/okr/indicator/field/list'], ...(action === 'fields' ? [] : [['mutated', action === 'field-create' ? 'POST' : action === 'field-remove' ? 'DELETE' : 'PUT', '/task/okr/indicator/field' + (action === 'field-move' ? '/sort' : '')] as Route])]
  const values: Route[] = [...detail, ['values', 'GET', '/task/okr/indicator/value']]
  if (action === 'values') return values
  if (action === 'value-set') return [...values, ['mutated', 'PUT', '/task/okr/indicator/value']]
  const records: Route[] = [...values, ['recordInfo', 'GET', '/task/okr/indicator/update/info'], ['fields', 'GET', '/task/okr/indicator/field/list'], ['records', 'GET', '/task/okr/indicator/update/table/data']]
  return action === 'records' ? records : [...records, ['mutated', action === 'record-create' ? 'POST' : action === 'record-update' ? 'PUT' : 'DELETE', '/task/okr/indicator/record']]
}
export function validateOkrIndicatorWorkflow(flow: Workflow) {
  if (!okrIndicatorActions.includes(flow.okrIndicatorAction!)) fail('未知指标业务操作。', 'INVALID_CONTRACT')
  const expected = okrIndicatorSteps(flow.okrIndicatorAction!)
  if (flow.executor !== 'okr-indicators' || expected.length !== flow.steps.length || expected.some(([key, method, route], i) => {
    const step = flow.steps[i], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== key || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.resources || step.authentication || step.transfer || step.readback || step.collectPages || step.forEach || step.expectAbsent || step.waitBeforeMs
  })) fail('指标步骤与经核对的 HTTP 协议不一致。', 'INVALID_CONTRACT')
}

export async function runOkrIndicator(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateOkrIndicatorWorkflow(flow)
  const session = requireSession(supplied), action = flow.okrIndicatorAction!, completed: string[] = [], resources: JsonObject = {}
  let phase = 'identity', writeAttempted = false
  const call = async (key: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === key), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) fail('指标业务调用了未声明的步骤。', 'INVALID_CONTRACT')
    phase = key; if (op.method !== 'GET') writeAttempted = true
    const result = await runOperation(ctx, op, args, session, options); completed.push(key); return result
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources, result })
  const readLibrary = async () => { const list = rows(await call('library')); unique(ids(list), '指标库返回重复定义。'); return list }
  const sameOthers = (before: JsonObject[], after: JsonObject[], excluded: string) => assertVersion(before.filter(item => id(item.id) !== excluded), after.filter(item => id(item.id) !== excluded))
  try {
    const who = asObject(await call('identity'))
    if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('当前用户或公司与 profile 不一致。', 'IDENTITY_CHANGED')
    const permissions = asObject(asObject(await call('sidebar')).editControl)
    if (permissions.viewIndicator !== true) fail('当前角色不能查看指标模块。', 'FORBIDDEN')
    const library = await readLibrary(), dimensions = rows(await call('dimensions')), attributions = attributionTree(await call('attributions'))
    unique(ids(dimensions), '指标维度列表存在重复 ID。')
    const publicLibrary = library.map(item => asObject(item.editControl).view === true ? item : { hidden: true, reason: 'view-permission-denied' })
    if (action === 'context') return done({ companyId: session.identity.teamId, permissions, library: publicLibrary, dimensions, attributions, contextVersion: version({ library: publicLibrary, dimensions, attributions }), idSemantics: { definitionId: 'library[].id', indicatorId: 'library[].indicatorId；运行指标 ID 与定义 ID 分开', dimensionId: 'dimensions[].id', optionId: 'dimensions[].itemList[].id', fieldId: 'fields[].id' }, relatedCommands: ['okr indicator definition inspect', 'okr indicator definition create', 'okr indicator dimensions list', 'okr indicator values get', 'okr indicator records context'], limitations: ['HTTP 读取可能初始化身份和底表字段，不自动重放。', 'values/records 命令当前定位到定义的根指标；子指标、透视、公式引用和导入仍按 coverage 单独验收。'] })
    if (action === 'library') return done({ items: input.name == null ? publicLibrary : publicLibrary.filter(item => !item.hidden && String(item.name).includes(String(input.name))), filteredBy: input.name ?? null, paginated: false, completeServerResult: true })
    if (action === 'dimensions') return done({ items: dimensions, contextVersion: version(dimensions), manage: permissions.manageIndicatorDimension === true })
    if (action.startsWith('dimension-')) {
      if (permissions.manageIndicatorDimension !== true) fail('当前角色不能管理公司指标维度。', 'FORBIDDEN')
      const target = action === 'dimension-create' ? null : dimensions.find(item => id(item.id) === id(input.dimensionId))
      if (action !== 'dimension-create' && !target) fail('目标维度不属于当前公司。', 'FORBIDDEN')
      if (input.contextVersion != null && input.contextVersion !== version(dimensions)) fail('维度上下文已过期。', 'CONTEXT_CONFLICT')
      let body: JsonObject = {}
      if (action !== 'dimension-remove') {
        const items = rows(input.options), names = items.map(item => name(item.name)); unique(names, '维度选项名称不能重复。')
        if (!items.length || items.length > 1000) fail('维度必须有 1 至 1000 个选项。', 'INVALID_INPUT')
        body = { name: name(input.name), icon: input.icon ?? target?.icon ?? '', itemList: items.map((item, i) => {
          if (Object.keys(item).some(key => !['id', 'name'].includes(key))) fail('维度选项包含未知属性。', 'INVALID_INPUT')
          if (item.id != null && (!target || !rows(target.itemList).some(old => id(old.id) === id(item.id)))) fail('维度选项 ID 不属于目标维度。', 'FORBIDDEN')
          return { ...(item.id != null && { id: id(item.id) }), name: names[i] }
        }), ...(target && { id: id(target.id) }) }
        unique(rows(body.itemList).filter(item => item.id != null).map(item => id(item.id)), '维度选项 ID 不能重复。')
        if (dimensions.some(item => item !== target && item.name === body.name)) fail('当前公司已有同名维度。', 'INVALID_INPUT')
      }
      assertVersion(dimensions, rows(await call('dimensions')))
      const response = await call(action, action === 'dimension-remove' ? { query: { id: id(target!.id) } } : { body })
      const key = target ? id(target.id) : id(asObject(response).id); resources.dimensionId = key
      const after = rows(await call('dimensions')), actual = after.find(item => id(item.id) === key)
      sameOthers(dimensions, after, key)
      if (action === 'dimension-remove') expect(!actual, '维度删除后仍存在。')
      else { expect(actual?.name === body.name && String(actual?.icon ?? '') === String(body.icon), '维度名称或图标读回不一致。'); const actualItems = rows(actual!.itemList); unique(ids(actualItems), '维度选项返回重复 ID。'); expect(version(actualItems.map(item => item.name)) === version(rows(body.itemList).map(item => item.name)), '维度选项读回不一致。'); for (const item of rows(body.itemList).filter(item => item.id != null)) expect(actualItems.some(row => id(row.id) === id(item.id) && row.name === item.name), '已有维度选项 ID 未保留。') }
      return done({ dimension: actual ?? null, removed: action === 'dimension-remove', contextVersion: version(after), verified: true })
    }
    const detail = async (key: string) => {
      const source = (await readLibrary()).find(item => id(item.id) === key)
      if (!source || asObject(source.editControl).view !== true) fail('指标定义不在当前可见指标库。', 'FORBIDDEN')
      const definition = asObject(await call('definition', { query: { id: key } })), split = asObject(await call('splitInfo', { query: { id: key } })), root = asObject(await call('root', { query: { indicatorDefinitionId: key } }))
      if (id(definition.id) !== key || id(root.definitionId) !== key || id(root.id) !== id(source.indicatorId) || root.isRoot !== true || root.isPerspective === true) fail('定义与实际根指标不匹配。', 'CONTEXT_CONFLICT')
      requireControl(root, 'view')
      return { source, definition, split, root }
    }
    if (action === 'create') {
      if (permissions.createIndicator !== true) fail('当前角色不能创建指标。', 'FORBIDDEN')
      const type = input.attributionType, selected = findAttribution(attributions, type, input.attributionId)
      if (!['company', 'dept'].includes(String(type)) || !selected || type === 'company' && input.attributionId != null) fail('根指标只能属于可管理的公司或部门；公司不传 attributionId。', 'FORBIDDEN')
      const dimensionIds = (input.dimensionIds ?? []) as string[], tableData = buildIndicatorBreakdown(selected, input.breakdown, dimensions, dimensionIds)
      const body = { name: name(input.name), attributionType: type, ...(type !== 'company' && { attributionId: id(selected.id) }), aggregateMode: input.aggregateMode ?? 'sum', growDirection: input.growDirection ?? 'bigger', updateManualMode: input.updateManualMode ?? 'cover', updateAutoMode: input.updateAutoMode ?? 'sum', ...(input.unit !== undefined && { unit: input.unit }), ...(input.describe !== undefined && { describe: input.describe }), ...(dimensionIds.length && { dimensionIds: dimensionIds.join(',') }), tableData }
      assertVersion(library, await readLibrary()); assertVersion(dimensions, rows(await call('dimensions'))); assertVersion(attributions, attributionTree(await call('attributions')))
      const created = asObject(await call('created', { body })), key = id(created.definitionId); resources.definitionId = key; resources.indicatorId = id(created.id)
      const readback = await detail(key)
      expect(readback.definition.name === body.name && id(readback.root.id) === id(created.id), '新建指标没有独立读回。')
      for (const [field, value] of Object.entries(body).filter(([field]) => ['name', 'aggregateMode', 'growDirection', 'updateManualMode', 'updateAutoMode', 'unit', 'describe'].includes(field))) expect(readback.definition[field] === value, '新建指标定义 ' + field + ' 读回不一致。')
      expect(attributionKey(asObject(readback.definition.attribution)) === attributionKey(selected), '新建指标所属组织读回不一致。')
      verifySplit(tableData, readback.split.tableData, dimensionIds, readback.split.dimensions)
      sameOthers(library, await readLibrary(), key)
      return done({ ...readback, contextVersion: version(readback), verified: true })
    }
    const key = id(input.definitionId), before = await detail(key)
    if (input.contextVersion != null && input.contextVersion !== version(before)) fail('指标定义上下文已过期。', 'CONTEXT_CONFLICT')
    if (action === 'inspect') return done({ ...before, contextVersion: version(before), relatedCommands: ['okr indicator definition edit', 'okr indicator definition split', 'okr indicator fields list', 'okr indicator values get', 'okr indicator records context'] })
    if (['edit', 'split', 'stop', 'remove'].includes(action)) {
      const permission = action === 'stop' ? 'startStop' : action === 'remove' ? 'delete' : 'definition'; requireControl(before.source, permission); requireControl(before.root, permission)
      let body: JsonObject = { id: key }
      if (action === 'edit') { const patch = asObject(input.patch); if (!Object.keys(patch).length || Object.keys(patch).some(k => !['name', 'aggregateMode', 'growDirection', 'updateManualMode', 'updateAutoMode', 'describe', 'unit'].includes(k))) fail('指标定义修改包含未知属性或为空。', 'INVALID_INPUT'); body = { ...body, ...patch, ...(Object.hasOwn(patch, 'name') && { name: name(patch.name) }) } }
      if (action === 'split') { const root = findAttribution(attributions, asObject(before.definition.attribution).type, asObject(before.definition.attribution).id); if (!root) fail('当前根组织不在可管理范围。', 'FORBIDDEN'); const dimensionIds = input.dimensionIds as string[]; body.dimensionIds = dimensionIds.join(','); body.tableData = buildIndicatorBreakdown(root, input.breakdown, dimensions, dimensionIds) }
      if (action === 'stop') body.isStop = input.stopped
      assertVersion(before, await detail(key)); if (action === 'split') { assertVersion(dimensions, rows(await call('dimensions'))); assertVersion(attributions, attributionTree(await call('attributions'))) }
      await call('mutated', action === 'remove' ? { query: { id: key } } : { body }); resources.definitionId = key; resources.indicatorId = id(before.root.id)
      if (action === 'remove') { const after = await readLibrary(); expect(!after.some(row => id(row.id) === key), '删除后定义仍存在于指标库。'); sameOthers(library, after, key); return done({ definitionId: key, removed: true, verified: true }) }
      const after = await detail(key)
      if (action === 'edit') for (const [field, value] of Object.entries(body).filter(([field]) => field !== 'id')) expect(after.definition[field] === value, '指标定义 ' + field + ' 读回不一致。')
      if (action === 'stop') expect(after.root.isStop === input.stopped && after.source.isStop === input.stopped, '定义与根指标启停状态不一致。')
      if (action === 'split') verifySplit(body.tableData, after.split.tableData, input.dimensionIds as string[], after.split.dimensions)
      return done({ ...after, contextVersion: version(after), verified: true })
    }
    const fields = async () => { const list = rows(await call('fields', { query: { id: key } })); unique(ids(list), '指标字段存在重复 ID。'); return list }
    if (action === 'fields' || action.startsWith('field-')) {
      const list = await fields()
      if (action === 'fields') return done({ definitionId: key, fields: list, contextVersion: version(list), initializationSideEffect: true })
      requireControl(before.source, 'edit'); requireControl(before.root, 'edit'); if (before.root.isStop !== false) fail('停用指标不能配置数据底表字段。', 'FORBIDDEN')
      const field = action === 'field-create' ? null : list.find(item => id(item.id) === id(input.fieldId))
      if (action !== 'field-create' && (!field || field.isCustom !== true)) fail('只能修改当前定义中的自定义字段，系统字段不能编辑或删除。', 'FORBIDDEN')
      let body: JsonObject = action === 'field-create' ? { id: key, name: name(input.name) } : { id: id(field!.id), ...(action === 'field-rename' && { name: name(input.name) }) }, expected = ids(list)
      if (['field-create', 'field-rename'].includes(action) && list.some(row => row !== field && row.name === body.name)) fail('字段名称已存在。', 'INVALID_INPUT')
      if (action === 'field-move') {
        const moving = id(field!.id); expected = expected.filter(value => value !== moving)
        const position = input.beforeFieldId == null ? expected.length : expected.indexOf(id(input.beforeFieldId))
        if (position < 0) fail('beforeFieldId 不属于同一底表，或与移动字段相同。', 'INVALID_INPUT')
        expected.splice(position, 0, moving); body = { moveId: moving, ...(position > 0 && { frontId: expected[position - 1] }), ...(position + 1 < expected.length && { nextId: expected[position + 1] }) }
      }
      assertVersion(before, await detail(key)); assertVersion(list, await fields())
      const response = await call('mutated', action === 'field-remove' ? { query: { id: id(field!.id) } } : { body })
      const fieldId = field ? id(field.id) : id(asObject(response).id); resources.definitionId = key; resources.fieldId = fieldId
      const after = await fields(), actual = after.find(item => id(item.id) === fieldId)
      if (action === 'field-remove') { expect(!actual, '字段删除后仍存在。'); expect(version(ids(after)) === version(ids(list).filter(id => id !== fieldId)), '删除字段改变了其他字段。') }
      else if (action === 'field-move') expect(version(ids(after)) === version(expected), '字段顺序读回不一致。')
      else { expect(actual?.name === body.name && actual?.isCustom === true, '自定义字段读回不一致。'); sameOthers(list, after, fieldId) }
      return done({ definitionId: key, fields: after, field: actual ?? null, contextVersion: version(after), verified: true })
    }
    const timeType = input.timeType ?? (action.startsWith('record') ? 'day' : undefined), time = indicatorTime(timeType, input.time), rootId = id(before.root.id)
    const valueContext = async () => { const response = asObject(await call('values', { query: { id: rootId, timeType, selectTime: time, max: 1 } })), list = rows(response.valueList), selected = list.find(row => row.time === time); if (!selected || !Array.isArray(response.timeList) || !response.timeList.includes(time)) fail('指定时间不属于服务端返回的真实数据窗口。'); return { selected, response } }
    const initialValues = await valueContext()
    if (action === 'values') return done({ definitionId: key, indicatorId: rootId, timeType, time, ...initialValues, contextVersion: version(initialValues), rootOnly: true })
    if (before.root.isStop !== false) fail('停用指标不能填报。', 'FORBIDDEN')
    if (action === 'value-set') {
      const keyName = Object.hasOwn(input, 'targetValue') ? 'targetValue' : 'doneValue'
      if (Object.hasOwn(input, 'targetValue') === Object.hasOwn(input, 'doneValue')) fail('一次只更新目标值或完成值；未给出的值保持不变。', 'INVALID_INPUT')
      const value = indicatorNumber(input[keyName], true), control = asObject(initialValues.selected.editControl)
      if (control[keyName === 'targetValue' ? 'editTargetValue' : 'editDoneValue'] !== true || value === '' && control[keyName === 'targetValue' ? 'clearTargetValue' : 'clearDoneValue'] !== true) fail('当前时间格没有修改或清空权限。', 'FORBIDDEN')
      if (keyName === 'doneValue' && before.root.updateManualMode !== 'cover') fail('增量指标的完成值须通过 records 命令维护逐条记录。', 'INVALID_INPUT')
      assertVersion(before, await detail(key)); assertVersion(initialValues, await valueContext())
      await call('mutated', { body: { indicatorId: rootId, time, timeType, [keyName]: value } }); resources.definitionId = key; resources.indicatorId = rootId
      const after = await valueContext(), unchanged = keyName === 'targetValue' ? 'doneValue' : 'targetValue'
      expect(value === '' ? after.selected[keyName] == null : equalNumber(after.selected[keyName], value), '指定指标数值读回不一致。')
      expect(after.selected[unchanged] === initialValues.selected[unchanged], '未修改的指标数值发生变化。')
      return done({ definitionId: key, indicatorId: rootId, timeType, time, ...after, verified: true, rootOnly: true })
    }
    if (timeType !== 'day' || before.root.updateManualMode !== 'increment') fail('逐条记录命令用于按日填报的增量指标；覆盖值使用 values set。', 'INVALID_INPUT')
    const info = asObject(await call('recordInfo', { query: { indicatorId: rootId, timeType, time } }))
    if (id(info.definitionId) !== key || info.updateManualMode !== 'increment') fail('填报上下文与指标定义不一致。', 'CONTEXT_CONFLICT')
    const list = await fields(), doneFields = list.filter(item => item.isCustom === false && item.name === '完成值')
    if (doneFields.length !== 1) fail('当前协议未提供唯一完成值字段，不能猜测系统字段。')
    const doneId = id(doneFields[0].id), writable = new Set([doneId, ...list.filter(item => item.isCustom === true).map(item => id(item.id))])
    const recordContext = async () => { const values = rows(await call('records', { query: { indicatorId: rootId, timeType, selectTime: time, max: 1 } })), row = values.find(row => row.time === time); if (!row) fail('增量填报没有返回指定日期。'); const records = rows(row.recordList); unique(ids(records), '填报记录 ID 重复。'); return { row, records } }
    const initial = await recordContext()
    if (action === 'records') return done({ definitionId: key, indicatorId: rootId, timeType, time, info, fields: list, doneFieldId: doneId, writableFieldIds: [...writable], ...initial, contextVersion: version(initial), rootOnly: true })
    if (asObject(info.editControl).editDoneValue !== true || asObject(initialValues.selected.editControl).editDoneValue !== true) fail('当前角色不能填报此指标完成值。', 'FORBIDDEN')
    const record = action === 'record-create' ? null : initial.records.find(row => id(row.id) === id(input.recordId))
    if (action !== 'record-create' && !record) fail('记录不属于当前指标与日期。', 'FORBIDDEN')
    const patch = asObject(input.values), fieldValues: JsonObject = {}
    if (action !== 'record-remove') {
      if (!Object.keys(patch).length || Object.keys(patch).some(field => !writable.has(field))) fail('填报字段不属于当前可写字段目录。', 'INVALID_INPUT')
      if (action === 'record-create' && !Object.hasOwn(patch, doneId)) fail('新增记录必须含实际完成值字段。', 'INVALID_INPUT')
      for (const [field, value] of Object.entries(patch)) { if (field === doneId) fieldValues[field] = indicatorNumber(value); else if (typeof value === 'string' && value.length <= 10000) fieldValues[field] = value; else fail('自定义字段值须为文本，清空使用空字符串。', 'INVALID_INPUT') }
    }
    assertVersion(before, await detail(key)); assertVersion(list, await fields()); assertVersion(initialValues, await valueContext()); assertVersion(initial, await recordContext())
    const result = await call('mutated', action === 'record-remove' ? { query: { id: id(record!.id) } } : { body: { ...fieldValues, ...(record ? { id: id(record.id) } : { indicatorId: rootId, time }) } })
    const recordId = record ? id(record.id) : id(asObject(result).id); resources.definitionId = key; resources.indicatorId = rootId; resources.recordId = recordId
    const after = await recordContext(), actual = after.records.find(row => id(row.id) === recordId)
    sameOthers(initial.records, after.records, recordId)
    if (action === 'record-remove') expect(!actual, '增量记录删除后仍存在。')
    else { expect(Boolean(actual), '增量记录未独立读回。'); for (const [field, value] of Object.entries(fieldValues)) expect(field === doneId ? equalNumber(actual![field], String(value)) : String(actual![field] ?? '') === value, '增量记录字段读回不一致。') }
    const afterValues = await valueContext()
    expect(after.row.doneValue === afterValues.selected.doneValue, '逐条记录汇总与独立指标值不一致。')
    return done({ definitionId: key, indicatorId: rootId, recordId, timeType, time, ...after, values: afterValues.selected, verified: true, rootOnly: true })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '指标业务未完成。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, resources, writeAttempted, resultMayBeUnknown: writeAttempted, automaticRetry: false, cause: original.details })
  }
}
