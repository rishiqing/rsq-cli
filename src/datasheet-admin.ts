import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { describeDatasheet } from './datasheet.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import type { Workflow } from './workflows.js'

export type DatasheetAdminAction = 'inspect' | 'create' | 'rename' | 'copy' | 'move' | 'remove' | 'link' |
  'role-list' | 'role-inspect' | 'role-create' | 'role-rename' | 'role-remove' | 'role-configure' | 'share-inspect' | 'share-configure'
type Route = [string, string, string]
const moduleRoute = '/task/v1/kanbanChildCrud', permissionRoute = '/task/mt/permission'
const packRoute = '/task/mt/datasheet/{datasheetId}/dataPack'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5)
}
const numericId = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value :
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('资源 ID 必须是精确的正整数字符串。')
const identifier = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : invalid('缺少有效的数据表 ID。')
const list = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : invalid('缺少有界完整列表。')
const name = (value: unknown): string => typeof value === 'string' && value.trim() && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid('名称不能为空，最多 100 字符，不能包含控制字符。')
const allowed = (row: JsonObject, permission: string) => {
  if (asObject(row.editControl)[permission] !== true) throw new RsqError('RESOURCE_FORBIDDEN', '当前业务上下文没有授予操作权限。', 4, { permission })
}
const bodyKeys = ['permissionMode', 'canCreateRecord', 'canDeleteRecord', 'editRecordScope', 'viewRecordScope', 'recordEditFilterInfo', 'recordViewFilterInfo', 'fieldEditMode', 'fieldPermissions', 'manageView', 'viewAccessScope', 'viewPermissions']
const computed = new Set([15, 16, 19, 20, 21, 22, 24])

export function datasheetAdminSteps(action: DatasheetAdminAction): Route[] {
  const base: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['project', 'GET', '/task/v1/kanbanCrud'], ['modules', 'GET', moduleRoute + '/list']]
  const pack: Route = ['context', 'GET', packRoute], verified: Route = ['verifiedModules', 'GET', moduleRoute + '/list']
  const changed = (method: string, route: string): Route => ['changed', method, route]
  if (action === 'create') return [...base, changed('POST', moduleRoute), verified, ['verifiedContext', 'GET', packRoute]]
  if (action === 'inspect') return [...base, pack]
  if (action === 'rename') return [...base, pack, changed('PUT', moduleRoute), verified, ['verifiedContext', 'GET', packRoute]]
  if (action === 'remove') return [...base, pack, changed('DELETE', moduleRoute), verified]
  if (['copy', 'move', 'link'].includes(action)) return [...base, pack,
    ['destinationProject', 'GET', '/task/v1/kanbanCrud'], ['destinationModules', 'GET', moduleRoute + '/list'],
    ...(action === 'link' ? [['shareCandidates', 'GET', '/task/v1/kanbanChild/datasheet/creatableShareList'] as Route] : []),
    changed(action === 'move' ? 'PUT' : 'POST', action === 'copy' ? '/task/v4/kanbanChild/copy' : action === 'move' ? '/task/v1/kanbanChild/move' : moduleRoute),
    verified, ['verifiedDestinationModules', 'GET', moduleRoute + '/list'], ['verifiedContext', 'GET', packRoute]]
  const roles: Route = ['roles', 'GET', permissionRoute + '/{datasheetId}/roleList']
  if (action === 'role-list') return [...base, pack, roles]
  if (action === 'role-create') return [...base, pack, roles, changed('POST', permissionRoute + '/{datasheetId}/role'), ['verifiedRoles', 'GET', roles[2]]]
  if (action === 'role-rename' || action === 'role-remove') return [...base, pack, roles, changed(action === 'role-remove' ? 'DELETE' : 'PUT', permissionRoute + '/role'), ['verifiedRoles', 'GET', roles[2]]]
  const role: Route = ['permission', 'GET', permissionRoute + '/{datasheetId}/permission']
  if (action === 'role-inspect') return [...base, pack, roles, role, ['spareUsers', 'GET', permissionRoute + '/{datasheetId}/spareUserList']]
  if (action === 'role-configure') return [...base, pack, roles, role,
    ['spareUsers', 'GET', permissionRoute + '/{datasheetId}/spareUserList'], ['companyUsers', 'GET', '/task/v1/department/list'], changed('PUT', role[2]),
    ['initializedPermission', 'GET', role[2]], ['configured', 'PUT', role[2]], ['verifiedPermission', 'GET', role[2]]]
  const shared: Route = ['shared', 'GET', permissionRoute + '/{datasheetId}/sharedData']
  if (action === 'share-inspect') return [...base, pack, shared]
  return [...base, pack, shared, ['companyUsers', 'GET', '/task/v1/department/list'], changed('PUT', shared[2]), ['verifiedShared', 'GET', shared[2]]]
}
export function validateDatasheetAdminWorkflow(flow: Workflow) {
  const actions: DatasheetAdminAction[] = ['inspect', 'create', 'rename', 'copy', 'move', 'remove', 'link', 'role-list', 'role-inspect', 'role-create', 'role-rename', 'role-remove', 'role-configure', 'share-inspect', 'share-configure']
  if (!actions.includes(flow.datasheetAdminAction!)) throw new RsqError('INVALID_CONTRACT', '未知数据表管理操作。', 6)
  const expected = datasheetAdminSteps(flow.datasheetAdminAction!)
  if (flow.executor !== 'datasheet-admin' || flow.steps.length !== expected.length || expected.some(([id, method, route], index) => {
    const step = flow.steps[index], operation = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== id || operation?.method !== method || operation.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.readback || step.authentication || step.resources
  })) throw new RsqError('INVALID_CONTRACT', '数据表管理的 HTTP 步骤与已核对契约不一致。', 6)
}
function pack(value: unknown, datasheetId: string): JsonObject {
  const result = asObject(asObject(value).data), snapshot = asObject(result.snapshot), meta = asObject(snapshot.meta)
  assert(asObject(result.datasheet).id === datasheetId && snapshot.datasheetId === datasheetId && Number.isSafeInteger(asObject(result.datasheet).revision), '数据表上下文或 revision 与所选资源不一致。')
  assert(Array.isArray(meta.views) && meta.views.length > 0 && Object.keys(asObject(meta.fieldMap)).length > 0 && snapshot.recordMap != null, '数据表缺少字段、视图或记录上下文。')
  return result
}
function describeModule(row: JsonObject) {
  return { id: numericId(row.id), name: row.name, type: row.type, datasheetInfo: row.datasheetInfo, permissions: row.editControl }
}
function sameIds(a: unknown[], b: unknown[]) {
  return isDeepStrictEqual(a.map(String).sort(), b.map(String).sort())
}
export function prepareDatasheetPermission(current: JsonObject, patch: JsonObject, context: JsonObject, roleId: number, spare: JsonObject[]): JsonObject {
  const meta = asObject(asObject(context.snapshot).meta), fields = asObject(meta.fieldMap), views = list(meta.views)
  const result: JsonObject = { ...Object.fromEntries(bodyKeys.filter(key => Object.hasOwn(current, key)).map(key => [key, structuredClone(current[key])])), ...structuredClone(patch) }
  if (result.permissionMode === 'readOnly') {
    if (Object.keys(patch).some(key => key !== 'permissionMode')) invalid('仅查看模式只修改 permissionMode；成员与自定义权限请在 custom 模式单独配置。')
    return { permissionMode: 'readOnly' }
  }
  if (roleId === -1 && patch.memberIds !== undefined) invalid('全员权限的成员由组织决定，不能显式改写。')
  if (Object.hasOwn(patch, 'fieldPermissions') && result.fieldEditMode !== 'custom') invalid('字段权限配置需要 custom 字段模式。')
  if (Object.hasOwn(patch, 'viewPermissions') && result.viewAccessScope !== 'partial') invalid('视图权限配置需要 partial 视图范围。')
  if (roleId > 0 && current.permissionMode === 'readOnly' && patch.memberIds === undefined) throw new RsqError('CONTEXT_REQUIRED', '当前服务的仅查看角色不返回成员；恢复 custom 时必须显式提供 memberIds，不能猜测原成员。', 2)
  if (patch.memberIds !== undefined) {
    const available = new Set([...spare, ...list(current.members ?? [])].map(row => numericId(row.id)))
    const ids = (patch.memberIds as unknown[]).map(numericId)
    if (ids.some(id => !available.has(id) || !Number.isSafeInteger(Number(id)))) invalid('成员必须来自当前角色成员或 spare-user 发现结果，并保持服务端数字精度。')
    result.memberIds = ids.map(Number)
  } else if (roleId > 0) result.memberIds = list(current.members ?? []).map(member => {
    const id = numericId(member.id)
    if (!Number.isSafeInteger(Number(id))) invalid('角色成员 ID 超出当前服务数字精度。')
    return Number(id)
  })
  for (const key of ['recordEditFilterInfo', 'recordViewFilterInfo']) {
    const scope = result[key === 'recordEditFilterInfo' ? 'editRecordScope' : 'viewRecordScope']
    if (scope !== 'partial') {
      if (Object.hasOwn(patch, key)) invalid('记录条件仅适用于 partial 范围。')
      result[key] = null; continue
    }
    const filter = asObject(result[key]), conditions = list(filter.conditions)
    if (!conditions.length) invalid('部分记录范围需要至少一个明确筛选条件。')
    result[key] = { conjunction: filter.conjunction, conditions: conditions.map(condition => {
      const fieldId = String(condition.fieldId), field = asObject(fields[fieldId])
      if (fieldId !== 'creator' && (![7, 8, 17, 18].includes(Number(field.type)) || condition.fieldType !== field.type)) invalid('记录权限筛选引用了无效或不可用类型的字段。')
      if (fieldId === 'creator' || field.type === 17) return { ...condition, operator: 'contains', value: ['currentUser', ...[...new Set((Array.isArray(condition.value) ? condition.value : []).filter(value => value != null && value !== '' && value !== 'currentUser'))]] }
      if ([7, 8].includes(Number(field.type))) {
        const options = new Set(list(asObject(field.attr).optionList).map(option => String(option.id)))
        if (Array.isArray(condition.value) && condition.value.some(value => !options.has(String(value)))) invalid('记录权限筛选选项必须从当前字段定义发现。')
      }
      return condition
    }) }
  }
  if (result.fieldEditMode !== 'custom') result.fieldPermissions = null
  else {
    const submitted = asObject(result.fieldPermissions), entries = list(submitted.fields ?? []), columns = list(views[0].columns), seen = new Set<string>()
    if (entries.some(entry => { const id = String(entry.fieldId); if (!fields[id] || seen.has(id)) return true; seen.add(id); return false })) invalid('字段权限引用了重复、已删除或不可见的字段。')
    result.fieldPermissions = { newAddFiled: submitted.newAddFiled ?? { canView: true, canEdit: true, canAdd: true }, fields: columns.map((column, index) => {
      const field = asObject(fields[String(column.fieldId)]), entry = entries.find(item => item.fieldId === field.id)
      if (index === 0 && entry?.canView === false) invalid('首列不能隐藏。')
      if (computed.has(Number(field.type)) && (entry?.canEdit === true || entry?.canAdd === true)) invalid('计算字段不能授予编辑或添加值权限。')
      const result = { canView: true, ...(!computed.has(Number(field.type)) && { canEdit: true, canAdd: true }), ...entry, fieldId: field.id, name: field.name, disable: index === 0 }
      if (computed.has(Number(field.type))) { delete result.canEdit; delete result.canAdd }
      return result
    }) }
  }
  if (result.viewAccessScope !== 'partial') result.viewPermissions = null
  else {
    const entries = list(result.viewPermissions ?? []), seen = new Set<string>()
    if (entries.some(entry => !views.some(view => view.id === entry.id) || seen.has(String(entry.id)) || (seen.add(String(entry.id)), false))) invalid('视图权限引用了重复、已删除或不可见的视图。')
    result.viewPermissions = views.map(view => ({ id: view.id, name: view.name, canManage: entries.find(entry => entry.id === view.id)?.canManage ?? true }))
  }
  return result
}

export async function runDatasheetAdmin(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateDatasheetAdminWorkflow(flow)
  const session = requireSession(supplied), action = flow.datasheetAdminAction!, projectId = numericId(input.projectId)
  const resources: Record<string, string> = { projectId }, completed: string[] = []
  let phase = 'identity', pending = false
  const call = async (stepId: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === stepId), operation = catalog.operations.find(op => op.id === step?.operationId)
    if (!operation) throw new RsqError('INVALID_CONTRACT', '数据表调用了未声明的 HTTP 步骤。', 6)
    phase = stepId; pending = false
    const transport: Transport = async (url, init) => {
      pending = operation.effect !== 'read'
      const response = await (options.transport ?? request)(url, init)
      if (response.ok && stepId === 'changed') try {
        const raw = asObject(parseJson(await response.clone().text())), row = operation.route.startsWith(permissionRoute) ? asObject(raw.data) : raw
        if (row.roleId != null) resources.roleId = String(row.roleId)
        if (row.id != null) resources[action === 'link' ? 'destinationModuleId' : 'moduleId'] = numericId(row.id)
        if (asObject(row.datasheetInfo).datasheetId) resources[action === 'link' ? 'destinationDatasheetId' : 'datasheetId'] = identifier(asObject(row.datasheetInfo).datasheetId)
      } catch { /* Preserve raw successful write checkpoints without replaying. */ }
      return response
    }
    const result = await runOperation(ctx, operation, args, session, { ...options, transport })
    pending = false; completed.push(stepId); return result
  }
  const project = async (stepId: string, id: string) => {
    const row = asObject(await call(stepId, { query: { id } }))
    assert(numericId(row.id) === id && Object.hasOwn(row, 'coverId') && row.coverId === null, '目标必须是普通项目，模板使用独立的模板上下文。')
    return row
  }
  const modules = async (stepId: string, id: string) => list(await call(stepId, { query: { kanbanId: id } }))
  const context = async (stepId: string, id: string, owner: string) => pack(await call(stepId, { path: { datasheetId: id }, query: { projectId: owner } }), id)
  const linked = (rows: JsonObject[], id: string) => {
    const matches = rows.filter(row => row.type === 'datasheet' && asObject(row.datasheetInfo).datasheetId === id)
    if (matches.length !== 1) throw new RsqError(matches.length ? 'AMBIGUOUS_CONTEXT' : 'CONTEXT_NOT_FOUND', '项目中没有唯一的目标数据表模块。', 2)
    return matches[0]
  }
  try {
    const actor = asObject(await call('identity'))
    assert(numericId(actor.id) === session.identity.userId && numericId(asObject(actor.team).id) === session.identity.teamId, '数据表管理的身份或公司与当前 profile 不一致。')
    const owner = await project('project', projectId), before = await modules('modules', projectId)
    if (action === 'create') {
      allowed(owner, 'createKanbanChild')
      const expectedName = name(input.name), row = asObject(await call('changed', { body: { kanbanId: projectId, name: expectedName, type: 'datasheet' } }))
      resources.moduleId = numericId(row.id); resources.datasheetId = identifier(asObject(row.datasheetInfo).datasheetId)
      assert(!before.some(item => numericId(item.id) === resources.moduleId), '创建返回了原有模块，不能作为新建成功。')
      const after = linked(await modules('verifiedModules', projectId), resources.datasheetId)
      assert(numericId(after.id) === resources.moduleId && after.name === expectedName && numericId(asObject(after.datasheetInfo).mainProjectId) === projectId, '新数据表的名称、主项目或模块不一致。')
      const data = await context('verifiedContext', resources.datasheetId, projectId)
      assert(asObject(data.datasheet).name === expectedName, '新表实际名称与项目模块不一致。')
      return { workflow: flow.id, completedSteps: completed, resources, result: { module: describeModule(after), table: describeDatasheet({ context: { data } }) } }
    }
    const datasheetId = identifier(input.datasheetId), module = linked(before, datasheetId), main = numericId(asObject(module.datasheetInfo).mainProjectId)
    resources.datasheetId = datasheetId; resources.moduleId = numericId(module.id)
    const initial = await context('context', datasheetId, projectId), snapshot = asObject(initial.snapshot)
    if (action === 'inspect') return { workflow: flow.id, completedSteps: completed, resources, result: { module: describeModule(module), mainProjectId: main, sharedReference: main !== projectId, table: describeDatasheet({ context: { data: initial } }, main !== projectId) } }
    if (action === 'rename' || action === 'remove') {
      allowed(module, action === 'rename' ? 'editKanbanChild' : 'removeKanbanChild')
      if (action === 'remove' && before.length <= 1) invalid('至少保留一个项目模块。')
      await call('changed', action === 'rename' ? { body: { id: resources.moduleId, name: name(input.name) } } : { query: { id: resources.moduleId } })
      const after = await modules('verifiedModules', projectId)
      if (action === 'remove') {
        assert(!after.some(row => numericId(row.id) === resources.moduleId), '删除后模块仍在原项目中。')
        return { workflow: flow.id, completedSteps: completed, resources, result: { removed: true, scope: main === projectId ? 'main-datasheet-and-module' : 'shared-project-reference-only' } }
      }
      const verified = linked(after, datasheetId), data = await context('verifiedContext', datasheetId, projectId)
      assert(verified.name === input.name && (main !== projectId || asObject(data.datasheet).name === input.name), '重命名未在项目模块或实际主数据表持久化。')
      return { workflow: flow.id, completedSteps: completed, resources, result: { module: describeModule(verified), tableName: asObject(data.datasheet).name } }
    }
    if (['copy', 'move', 'link'].includes(action)) {
      const destinationId = numericId(input.destinationProjectId), destination = await project('destinationProject', destinationId)
      allowed(destination, 'createKanbanChild')
      const destinationBefore = destinationId === projectId ? before : await modules('destinationModules', destinationId)
      if (action !== 'link') {
        assert(main === projectId, '只有主数据表模块可复制或移动，共享引用须单独处理。')
        allowed(module, action === 'copy' ? 'copyKanbanChild' : 'moveKanbanChild')
      }
      if (action === 'move' && (destinationId === projectId || before.length <= 1)) invalid('移动须选择不同项目，且原项目至少保留一个模块。')
      if (action === 'link') {
        const candidates = list(await call('shareCandidates', { query: { projectId: destinationId } }))
        if (!candidates.some(row => row.datasheetId === datasheetId) || destinationBefore.some(row => asObject(row.datasheetInfo).datasheetId === datasheetId)) throw new RsqError('RESOURCE_FORBIDDEN', '当前共享范围不允许目标项目引用，或该项目已有引用。', 4)
      }
      const expectedName = action === 'move' ? module.name : name(input.name)
      await call('changed', { body: action === 'link' ? { kanbanId: destinationId, type: 'datasheet', datasheetId, name: expectedName } : { id: resources.moduleId, kanbanId: destinationId, ...(action === 'copy' && { name: expectedName }) } })
      let destinationAfter: JsonObject[] = [], matches: JsonObject[] = []
      // Only read-only module discovery is polled. Never repeat the queued copy.
      for (let attempt = 0; attempt < (action === 'copy' ? 5 : 1); attempt++) {
        destinationAfter = await modules('verifiedDestinationModules', destinationId)
        matches = destinationAfter.filter(row => row.type === 'datasheet' && (action === 'move' ? numericId(row.id) === resources.moduleId : !destinationBefore.some(old => numericId(old.id) === numericId(row.id)) && row.name === expectedName))
        if (matches.length || action !== 'copy') break
        if (attempt < 4) await delay(500)
      }
      if (matches.length !== 1) throw new RsqError(matches.length ? 'CONTEXT_CONFLICT' : 'WRITE_PENDING', '目标项目尚未唯一发现操作结果；不重放写入，请按名称核对。', 5, { candidateModuleIds: matches.map(row => numericId(row.id)), destinationProjectId: destinationId, expectedName })
      const verified = matches[0], targetId = identifier(asObject(verified.datasheetInfo).datasheetId)
      resources.destinationProjectId = destinationId; resources.destinationModuleId = numericId(verified.id); resources.destinationDatasheetId = targetId
      const sourceAfter = await modules('verifiedModules', projectId)
      assert(action === 'move' ? !sourceAfter.some(row => numericId(row.id) === resources.moduleId) : sourceAfter.some(row => numericId(row.id) === resources.moduleId), '操作后源模块存在状态不一致。')
      assert(action === 'copy' ? targetId !== datasheetId : targetId === datasheetId, '复制或引用错误地复用了或更换了数据表 ID。')
      assert(numericId(asObject(verified.datasheetInfo).mainProjectId) === (action === 'link' ? main : destinationId), '目标模块的主项目归属不一致。')
      const after = await context('verifiedContext', targetId, destinationId), targetSnapshot = asObject(after.snapshot)
      if (action === 'copy') {
        const oldFields = asObject(asObject(snapshot.meta).fieldMap), newFields = asObject(asObject(targetSnapshot.meta).fieldMap)
        assert(sameIds(Object.keys(oldFields), Object.keys(newFields)) && sameIds(Object.keys(asObject(snapshot.recordMap)), Object.keys(asObject(targetSnapshot.recordMap))), '复制的数据表缺少源端可见字段或记录。')
        for (const [id, raw] of Object.entries(oldFields)) {
          const expected = structuredClone(asObject(raw))
          if ([16, 23, 24].includes(Number(expected.type))) expected.attr = { ...asObject(expected.attr), datasheetId: targetId }
          assert(isDeepStrictEqual(expected, newFields[id]), '复制后字段定义或引用上下文不一致。')
        }
        for (const [id, raw] of Object.entries(asObject(snapshot.recordMap))) assert(isDeepStrictEqual(asObject(raw).data, asObject(asObject(targetSnapshot.recordMap)[id]).data), '复制后记录的可见单元格不一致。')
      }
      return { workflow: flow.id, completedSteps: completed, resources, result: { module: describeModule(verified), table: describeDatasheet({ context: { data: after } }), verification: action === 'copy' ? 'visible-fields-and-record-cells' : 'resource-and-project-association' } }
    }
    // UI permits these controls only on an ordinary table's main project.
    assert(main === projectId, '权限与共享范围只能在主项目管理，不能通过共享引用提升权限。')
    allowed(module, 'dataManage')
    const args = { path: { datasheetId } }
    if (action.startsWith('share-')) {
      const current = asObject(asObject(await call('shared', args)).data)
      assert(current.dstId === datasheetId, '共享配置不属于当前数据表。')
      if (action === 'share-inspect') return { workflow: flow.id, completedSteps: completed, resources, result: current }
      const patch = asObject(input.patch), expected = { dstId: datasheetId, isOpen: current.isOpen, sharedScope: current.sharedScope, memberIds: current.memberIds, ...patch }
      const users = companyDirectoryUsers(await call('companyUsers', { query: { cliContext: 'fresh' } })), ids = (expected.memberIds as unknown[]).map(numericId)
      if (ids.some(id => !Number.isSafeInteger(Number(id)) || !users.some(user => numericId(user.id) === id))) invalid('共享成员必须来自当前公司通讯录。')
      expected.memberIds = ids.map(Number)
      await call('changed', { ...args, body: expected })
      const verified = asObject(asObject(await call('verifiedShared', args)).data)
      assert(verified.dstId === datasheetId && verified.isOpen === expected.isOpen && verified.sharedScope === expected.sharedScope && Array.isArray(verified.memberIds) && sameIds(verified.memberIds, expected.memberIds as unknown[]), '共享开关、范围或成员未持久化。')
      return { workflow: flow.id, completedSteps: completed, resources, result: verified }
    }
    const roles = list(asObject(await call('roles', args)).data)
    if (action === 'role-list') return { workflow: flow.id, completedSteps: completed, resources, result: { roles } }
    if (action === 'role-create') {
      const expectedName = name(input.name)
      if (roles.some(row => row.name === expectedName)) invalid('该数据表已有同名角色。')
      const created = asObject(asObject(await call('changed', { ...args, body: { name: expectedName } })).data)
      assert(Number.isSafeInteger(created.roleId) && Number(created.roleId) > 0, '角色创建结果缺少有效 roleId。')
      resources.roleId = String(created.roleId)
      const after = list(asObject(await call('verifiedRoles', args)).data)
      assert(!roles.some(row => row.roleId === created.roleId) && after.some(row => row.roleId === created.roleId && row.name === expectedName), '新角色未在该数据表独立读回。')
      return { workflow: flow.id, completedSteps: completed, resources, result: created }
    }
    const roleId = Number(input.roleId)
    if (!Number.isSafeInteger(roleId) || !roles.some(role => role.roleId === roleId)) invalid('角色必须从当前数据表实际 role-list 中选择。')
    resources.roleId = String(roleId)
    if (action === 'role-rename' || action === 'role-remove') {
      if (roleId <= 0) invalid('内置全员角色不能改名或删除。')
      if (action === 'role-rename' && roles.some(row => row.roleId !== roleId && row.name === input.name)) invalid('角色名称重复。')
      await call('changed', action === 'role-remove' ? { query: { roleId } } : { body: { roleId, name: name(input.name) } })
      const after = list(asObject(await call('verifiedRoles', args)).data)
      assert(action === 'role-remove' ? !after.some(row => row.roleId === roleId) : after.some(row => row.roleId === roleId && row.name === input.name), '角色修改未在所属数据表持久化。')
      return { workflow: flow.id, completedSteps: completed, resources, result: { roleId, ...(action === 'role-remove' ? { removed: true } : { name: input.name }) } }
    }
    const query = { ...args, query: { roleId } }, current = asObject(asObject(await call('permission', query)).data)
    assert(current.dstId === datasheetId, '权限不属于当前数据表。')
    const spare = list(asObject(await call('spareUsers', args)).data)
    if (action === 'role-inspect') return { workflow: flow.id, completedSteps: completed, resources, result: { roleId, permission: current, availableMembers: spare.map(user => ({ id: numericId(user.id), showName: user.showName })) } }
    let expected = prepareDatasheetPermission(current, asObject(input.patch), initial, roleId, spare)
    const conditions = ['recordEditFilterInfo', 'recordViewFilterInfo'].flatMap(key => list(asObject(expected[key]).conditions ?? []))
    if (conditions.some(condition => condition.fieldId === 'creator' || [17, 18].includes(Number(condition.fieldType)))) {
      const tree = await call('companyUsers', { query: { cliContext: 'fresh' } }), users = companyDirectoryUsers(tree), units = companyDirectoryUnits(tree)
      for (const condition of conditions) {
        if (condition.fieldId !== 'creator' && ![17, 18].includes(Number(condition.fieldType))) continue
        const available = new Set((condition.fieldType === 18 ? units : users).map(row => numericId(row.id)))
        if (Array.isArray(condition.value) && condition.value.some(value => value !== 'currentUser' && !available.has(String(value)))) invalid('记录权限条件引用了当前公司以外或不存在的成员/部门。')
      }
    }
    const patch = asObject(input.patch), base: JsonObject = {}, nested: JsonObject = {}, recovering = current.permissionMode === 'readOnly' && expected.permissionMode === 'custom'
    for (const key of Object.keys(patch)) {
      if (key === 'fieldPermissions' || key === 'viewPermissions') continue
      if ((key === 'fieldEditMode' || key === 'viewAccessScope') && expected[key] === current[key]) continue
      base[key] = expected[key]
    }
    for (const [scope, filter] of [['editRecordScope', 'recordEditFilterInfo'], ['viewRecordScope', 'recordViewFilterInfo']]) {
      if (Object.hasOwn(base, scope) || Object.hasOwn(patch, filter)) base[filter] = expected[filter]
    }
    // The current UI first switches a mode, then saves its nested controls in
    // another sparse PUT. Sending both in one request makes the legacy Nest
    // service replace restrictions with defaults. Follow the same HTTP-only
    // transition and retain each completed write if a later step fails.
    if (expected.permissionMode !== 'readOnly') {
      if (expected.fieldEditMode === 'custom' && (Object.hasOwn(patch, 'fieldPermissions') || Object.hasOwn(base, 'fieldEditMode'))) nested.fieldPermissions = expected.fieldPermissions
      if (expected.viewAccessScope === 'partial' && (Object.hasOwn(patch, 'viewPermissions') || Object.hasOwn(base, 'viewAccessScope'))) nested.viewPermissions = expected.viewPermissions
    }
    if (Object.keys(base).length) {
      await call('changed', { ...args, body: { dstId: datasheetId, roleId, ...base } })
      if (Object.keys(nested).length || recovering) {
        const initialized = asObject(asObject(await call('initializedPermission', query)).data)
        assert(initialized.dstId === datasheetId && initialized.permissionMode === expected.permissionMode, '权限模式切换未独立持久化，停止后续配置。')
        for (const key of Object.keys(base).filter(key => key !== 'memberIds')) assert(isDeepStrictEqual(initialized[key] ?? null, base[key] ?? null), '权限基础设置未持久化：' + key)
        if (Object.hasOwn(base, 'memberIds')) assert(sameIds(list(initialized.members).map(member => numericId(member.id)), base.memberIds as unknown[]), '基础角色成员设置未持久化。')
        // Read-only responses expose effective restrictions rather than the
        // stored custom settings. After changing back, discover the restored
        // settings and preserve every control the caller did not change.
        if (recovering) expected = prepareDatasheetPermission(initialized, patch, initial, roleId, spare)
      }
    }
    if (Object.keys(nested).length) await call(Object.keys(base).length ? 'configured' : 'changed', { ...args, body: { dstId: datasheetId, roleId, ...nested } })
    const verified = asObject(asObject(await call('verifiedPermission', query)).data)
    assert(verified.dstId === datasheetId && verified.permissionMode === expected.permissionMode, '角色权限身份或模式不一致。')
    if (expected.permissionMode !== 'readOnly') {
      for (const key of bodyKeys) if (Object.hasOwn(expected, key)) assert(isDeepStrictEqual(verified[key] ?? null, expected[key] ?? null), '权限未独立持久化：' + key)
      if (expected.memberIds !== undefined) assert(sameIds(list(verified.members).map(member => numericId(member.id)), expected.memberIds as unknown[]), '角色成员未独立持久化。')
    }
    return { workflow: flow.id, completedSteps: completed, resources, result: { roleId, permission: verified } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '数据表管理未完成。', 5)
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: phase, completedSteps: completed, resources,
      writeOutcome: pending ? 'unknown-do-not-retry' : 'check-completed-steps', automaticRollback: false, retry: 'manual-after-readback', ...(failure.details && { cause: failure.details }) })
  }
}
