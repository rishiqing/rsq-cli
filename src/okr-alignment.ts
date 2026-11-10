import { createHash } from 'node:crypto'
import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { cycleDate } from './okr-cycles.js'
import type { Workflow } from './workflows.js'

export type OkrAlignmentAction = 'inspect' | 'parents-candidates' | 'children-candidates' | 'parents-set' | 'children-add' | 'parent-remove' | 'child-remove' | 'parents-move' | 'children-move'
type Route = [string, string, string]
const base = '/task/okr'
const fail = (message: string, code = 'CONTEXT_MISSING'): never => { throw new RsqError(code, message, code === 'RESOURCE_FORBIDDEN' ? 4 : code === 'INVALID_INPUT' ? 2 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('对齐上下文缺少精确资源 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('对齐上下文必须是有界列表。')
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const key = (row: JsonObject) => String(typeof row.type === 'string' ? row.type : row.okrType) + ':' + id(row.id)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const edge = (row: JsonObject) => ({ id: id(row.id), type: String(row.okrType), control: row.alignEditControl })
const mutation = (action: OkrAlignmentAction) => !['inspect', 'parents-candidates', 'children-candidates'].includes(action)
export function okrAlignmentSteps(action: OkrAlignmentAction): Route[] {
  const context: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['cycles', 'GET', base + '/cycle/list'], ['objective', 'GET', base + '/objective'], ['parents', 'GET', base + '/objective/me/align/list'], ['children', 'GET', base + '/objective/align/me/list']]
  if (action === 'inspect') return context
  const candidates: Route[] = action === 'parents-candidates' || action === 'parents-set' ? [['candidates', 'GET', base + '/objective/select/meAlign/list']] : action === 'children-candidates' || action === 'children-add' ? [['candidates', 'GET', base + '/objective/select/alignMe/list']] : []
  if (!mutation(action)) return [...context, ...candidates]
  const changed: Route = action === 'children-add' ? ['changed', 'POST', base + '/objective/align/add'] : action === 'child-remove' ? ['changed', 'DELETE', base + '/objective/align/cancel'] : action.endsWith('-move') ? ['changed', 'PUT', base + '/objective/align/' + (action === 'parents-move' ? 'meAlign' : 'alignMe') + '/sort'] : ['changed', 'PUT', base + '/objective/align/batch/list']
  return [...context, ...candidates, ...(action === 'child-remove' ? [['childParents', 'GET', base + '/objective/me/align/list'] as Route] : []), ['preflightObjective', 'GET', base + '/objective'], ['preflightParents', 'GET', base + '/objective/me/align/list'], ['preflightChildren', 'GET', base + '/objective/align/me/list'], changed, ['verifiedParents', 'GET', base + '/objective/me/align/list'], ['verifiedChildren', 'GET', base + '/objective/align/me/list']]
}
export function validateOkrAlignmentWorkflow(flow: Workflow) {
  if (!['inspect', 'parents-candidates', 'children-candidates', 'parents-set', 'children-add', 'parent-remove', 'child-remove', 'parents-move', 'children-move'].includes(flow.okrAlignmentAction ?? '')) throw new RsqError('INVALID_CONTRACT', '未登记的目标对齐业务。', 6)
  const expected = okrAlignmentSteps(flow.okrAlignmentAction!)
  if (flow.executor !== 'okr-alignment' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return name !== step.id || method !== op?.method || route !== op.route || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.resources || step.authentication || step.readback
  })) throw new RsqError('INVALID_CONTRACT', '目标对齐步骤与核对后的 HTTP 协议不一致。', 6)
}
function relations(value: unknown) {
  const list = rows(value), seen = new Set<string>()
  for (const row of list) { if (!['objective', 'keyResult'].includes(String(row.okrType)) || seen.has(key(row))) fail('对齐关系类型未知或重复。'); seen.add(key(row)) }
  return list
}
function editable(objective: JsonObject) { if (asObject(objective.editControl).edit !== true) fail('当前目标没有 UI 的编辑权限。', 'RESOURCE_FORBIDDEN') }
function cancellable(row: JsonObject) {
  const ctrl = asObject(row.alignEditControl)
  if (ctrl.disableCancel !== false || ctrl.disableEdit !== false) fail('当前关系不可取消，可能是目标型 KR 的固有父关系或没有编辑权限。', 'RESOURCE_FORBIDDEN')
}
function root(value: unknown, objectiveId: unknown) {
  const objective = asObject(value)
  if (!same(objective.id, objectiveId) || asObject(objective.editControl).view !== true) fail('目标不可见或详情资源不符。', 'RESOURCE_FORBIDDEN')
  return objective
}
const state = (objective: JsonObject, parents: JsonObject[], children: JsonObject[]) => ({ objectiveId: id(objective.id), cycle: objective.cycle, permissions: objective.editControl, parents: parents.map(edge), children: children.map(edge) })
function cycleList(value: unknown) {
  const result = ['currentCycleList', 'futureCycleList', 'pastCycleList'].flatMap(part => rows(asObject(value)[part])), seen = new Set<string>()
  for (const row of result) { if (seen.has(id(row.id)) || row.isArchived !== false) fail('周期目录重复或包含归档周期。'); seen.add(id(row.id)); cycleDate(row.startDate); cycleDate(row.endDate) }
  return result
}
function cycle(cycles: JsonObject[], selected: unknown) { const found = cycles.find(row => same(row.id, selected)); return found ?? fail('周期不属于当前公司的未归档目录。', 'INVALID_INPUT') }
function interval(child: JsonObject, parent: JsonObject) {
  if (cycleDate(parent.startDate) > cycleDate(child.startDate) || cycleDate(parent.endDate) < cycleDate(child.endDate)) fail('父目标周期必须包含子目标周期，不能把父周期目标对齐到子周期。', 'INVALID_INPUT')
}
export async function runOkrAlignment(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateOkrAlignmentWorkflow(flow)
  const session = requireSession(supplied), action = flow.okrAlignmentAction!, resources = { objectiveId: String(input.objectiveId) }, completed: string[] = []
  let phase = 'identity', pending = false, changed = false
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) throw new RsqError('INVALID_CONTRACT', '未声明的对齐步骤。', 6)
    phase = name; pending = op.effect !== 'read'
    const result = await runOperation(ctx, op, args, session, { transport: options.transport, approved: options.approved })
    if (name === 'changed') changed = true
    completed.push(name); pending = false; return result
  }
  const query = { query: { objectiveId: input.objectiveId } }, objectiveQuery = { query: { id: input.objectiveId } }
  try {
    const identity = asObject(await call('identity'))
    if (!same(identity.id, session.identity.userId) || !same(asObject(identity.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '当前账号或公司与 profile 不一致，请重新登录。', 3)
    const cycles = cycleList(await call('cycles')), objective = root(await call('objective', objectiveQuery), input.objectiveId), currentCycle = cycle(cycles, asObject(objective.cycle).id)
    let parents = relations(await call('parents', query)), children = relations(await call('children', query))
    const contextVersion = hash(state(objective, parents, children))
    if (input.expectedVersion != null && input.expectedVersion !== contextVersion) fail('对齐上下文已变化，请重新读取。', 'CONTEXT_CONFLICT')
    const describe = () => ({ objectiveId: input.objectiveId, cycle: currentCycle, canEdit: asObject(objective.editControl).edit === true, parents, children, contextVersion: hash(state(objective, parents, children)), concurrency: 'fresh-http-context-without-server-compare-and-swap' })
    if (action === 'inspect') return { command: flow.command, resources, completedSteps: completed, result: describe() }
    if (mutation(action)) editable(objective)
    // The selector pages OBJECTIVES, then flattens their KRs. Numeric IDs can
    // coincide across types; neither response.length nor a bare id is a cursor.
    const select = async (cycleId: unknown, complete: boolean) => {
      const selectedCycle = cycle(cycles, cycleId), size = complete ? 100 : Number(input.limit ?? 30), items: JsonObject[] = [], seen = new Set<string>(), cursors = new Set<string>()
      let cursor = complete ? undefined : input.after
      for (let page = 0; page < (complete ? 100 : 1); page++) {
        const response = rows(await call('candidates', { query: { cycleId: id(selectedCycle.id), type: 'all', objectiveId: input.objectiveId, max: size, ...(cursor != null && { startId: cursor }), ...(!complete && input.name != null && { name: input.name }) } }))
        const objectives = response.filter(row => row.okrType === 'objective')
        if (objectives.length > size) fail('选择器返回目标数超过请求页大小。', 'PAGINATION_CHANGED')
        for (const row of response) {
          if (!['objective', 'keyResult', 'subObjKeyResult'].includes(String(row.okrType))) fail('选择器返回未知类型。')
          const unique = key(row) + ':' + String(row.parentObjective ?? '')
          if (seen.has(unique)) fail('选择器游标发生重复；未发送写入。', 'PAGINATION_CHANGED')
          seen.add(unique); items.push(row)
          if (row.okrType !== 'objective' && !objectives.some(parent => same(parent.id, row.parentObjective))) fail('选择器 KR 不属于本页父目标。')
        }
        const next = objectives.length === size ? id(objectives.at(-1)!.objectiveId) : null
        if (!complete || next === null) return { items, pagination: { kind: 'objective-cursor', limit: size, next, total: null } }
        if (cursors.has(next) || same(next, cursor)) fail('选择器返回重复游标。', 'PAGINATION_CHANGED')
        cursors.add(next); cursor = next
      }
      return fail('已到选择器遍历上限，未发送依赖完整上下文的写入。', 'PAGINATION_LIMIT')
    }
    if (!mutation(action)) {
      const candidates = await select(input.cycleId, false)
      return { command: flow.command, resources, completedSteps: completed, result: { ...describe(), ...candidates } }
    }
    let request: JsonObject, expected: string[], side: 'parents' | 'children' = action.startsWith('children') || action === 'child-remove' ? 'children' : 'parents', order = false
    if (action === 'parents-set') {
      const targets = rows(input.parents), requested = targets.map(key)
      if (new Set(requested).size !== requested.length) fail('父关系不能重复。', 'INVALID_INPUT')
      for (const old of parents) if (!requested.includes(key(old))) cancellable(old)
      const added = targets.filter(target => !parents.some(old => key(old) === key(target))), byCycle = new Map<string, JsonObject[]>()
      for (const target of added) { const parentCycle = cycle(cycles, target.cycleId); interval(currentCycle, parentCycle); const group = byCycle.get(id(parentCycle.id)) ?? []; group.push(target); byCycle.set(id(parentCycle.id), group) }
      for (const [cycleId, group] of byCycle) {
        const candidates = (await select(cycleId, true)).items
        for (const target of group) if (!candidates.some(row => (row.okrType === 'subObjKeyResult' ? 'objective:' + id(row.id) : key(row)) === key(target))) fail('父目标或 KR 不在实时可选范围，可能形成循环或不允许对齐到 KR。', 'RESOURCE_FORBIDDEN')
      }
      expected = requested; request = { body: { id: input.objectiveId, meAlignList: targets.map(row => ({ id: id(row.id), type: row.type })) } }
    } else if (action === 'parent-remove') {
      const target = asObject(input.parent), selected = parents.find(row => key(row) === key(target))
      if (!selected) fail('指定父关系不存在。', 'INVALID_INPUT')
      cancellable(selected!); const remain = parents.filter(row => row !== selected)
      expected = remain.map(key); request = { body: { id: input.objectiveId, meAlignList: remain.map(row => ({ id: id(row.id), type: row.okrType })) } }
    } else if (action === 'children-add') {
      const targets = rows(input.children), byCycle = new Map<string, JsonObject[]>()
      for (const target of targets) {
        if (same(target.id, input.objectiveId) || children.some(old => same(old.id, target.id))) fail('不能对齐自身或重复添加已有子关系。', 'INVALID_INPUT')
        const childCycle = cycle(cycles, target.cycleId); interval(childCycle, currentCycle)
        const group = byCycle.get(id(childCycle.id)) ?? []; group.push(target); byCycle.set(id(childCycle.id), group)
      }
      for (const [cycleId, group] of byCycle) { const candidates = (await select(cycleId, true)).items; for (const target of group) if (!candidates.some(row => row.okrType === 'objective' && same(row.id, target.id))) fail('子目标不在实时可选范围或没有管理权限。', 'RESOURCE_FORBIDDEN') }
      expected = [...children.map(key), ...targets.map(row => 'objective:' + id(row.id))]
      if (new Set(expected).size !== expected.length) fail('子目标不能重复。', 'INVALID_INPUT')
      request = { body: { parentId: input.objectiveId, parentType: 'objective', objectiveIds: targets.map(row => id(row.id)).join(',') } }
    } else if (action === 'child-remove') {
      const selected = children.find(row => row.okrType === 'objective' && same(row.id, input.childId))
      if (!selected) fail('指定子关系不存在。', 'INVALID_INPUT')
      cancellable(selected!)
      const childParents = relations(await call('childParents', { query: { objectiveId: input.childId } })), direct = childParents.find(row => row.okrType === 'objective' && same(row.id, input.objectiveId))
      if (!direct) fail('该子目标通过下级目标或 KR 间接对齐。请在子目标的 parents inspect 中明确选择实际父关系；不触发接口的批量取消回退。', 'INDIRECT_ALIGNMENT')
      expected = children.filter(row => row !== selected).map(key); request = { query: { objectiveId: input.childId, parentId: input.objectiveId, parentType: 'objective' } }
    } else {
      order = true; const list = side === 'parents' ? parents : children, move = asObject(input.move), before = input.before == null ? null : asObject(input.before), old = list.find(row => key(row) === key(move))
      if (!old || before && (!list.some(row => key(row) === key(before)) || key(before) === key(move))) fail('排序目标或相邻关系不属于当前列表。', 'INVALID_INPUT')
      const reordered = list.filter(row => row !== old), at = before ? reordered.findIndex(row => key(row) === key(before)) : reordered.length
      reordered.splice(at, 0, old!); expected = reordered.map(key)
      const front = reordered[at - 1], next = reordered[at + 1]
      request = { body: { id: input.objectiveId, moveId: id(old!.id), moveOkrType: old!.okrType, ...(front && { frontId: id(front.id), frontOkrType: front.okrType }), ...(next && { nextId: id(next.id), nextOkrType: next.okrType }) } }
    }
    const fresh = root(await call('preflightObjective', objectiveQuery), input.objectiveId), freshParents = relations(await call('preflightParents', query)), freshChildren = relations(await call('preflightChildren', query))
    editable(fresh)
    if (hash(state(fresh, freshParents, freshChildren)) !== contextVersion) fail('依赖读取期间目标或关系变化，未发送写入，请重新读取。', 'CONTEXT_CONFLICT')
    await call('changed', request)
    parents = relations(await call('verifiedParents', query)); children = relations(await call('verifiedChildren', query))
    const actual = (side === 'parents' ? parents : children).map(key)
    if (JSON.stringify(order ? actual : actual.sort()) !== JSON.stringify(order ? expected : [...expected].sort())) fail('对齐操作独立读回未达到请求状态，请核对已有步骤，勿自动重放。', 'BUSINESS_ASSERTION_FAILED')
    return { command: flow.command, resources, completedSteps: completed, result: describe() }
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '目标对齐业务执行失败。', 5)
    throw new RsqError(original.code, original.message, original.exit, { ...original.details, workflow: flow.id, failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown' : changed ? 'partial' : 'not-started', retry: 'manual-after-readback', automaticRollback: false })
  }
}
