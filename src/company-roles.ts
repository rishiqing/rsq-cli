import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { validateCompanyState, validateFeatures, validatePermissions } from './access.js'
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : ['FORBIDDEN', 'FEATURE_FORBIDDEN'].includes(code) ? 4 : 5) }
function id(value: unknown): string { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('角色上下文包含不精确的 ID。') }
function rows(value: unknown): JsonObject[] { return Array.isArray(value) ? value.map(asObject) : fail('角色上下文不是完整列表。') }
function roles(value: unknown) {
  const source = asObject(value), all: (JsonObject & { custom: boolean })[] = [...rows(source.defaultRoles).map(role => ({ ...role, custom: false })), ...rows(source.customRoles).map(role => ({ ...role, custom: true }))]
  const result = all.map(role => ({ id: id(role.id), name: role.name, type: role.type, custom: role.custom }))
  if (new Set(result.map(role => role.id)).size !== result.length || result.some(role => typeof role.name !== 'string' || typeof role.type !== 'string' || (role.type === 'custom') !== role.custom)) fail('角色列表重复或自定义类型不一致。')
  return result.sort((a, b) => a.id.localeCompare(b.id))
}
function tree(value: unknown) {
  const groups = rows(value).map(group => ({ name: group.name, group: group.group, authorities: rows(group.authorities).map(field => ({ id: id(field.id), name: field.name, description: field.description, status: field.status,
    ...(field.scopes == null ? {} : { scopes: rows(field.scopes).map(scope => ({ id: id(scope.id), name: scope.name, description: scope.description, status: scope.status })) }) })) }))
  const names = new Set(), scopeNames = new Set()
  for (const group of groups) for (const field of group.authorities) {
    if (typeof group.group !== 'string' || typeof field.name !== 'string' || typeof field.status !== 'boolean' || names.has(field.name)) fail('权限树缺少分组、字段名、布尔值或包含重复字段。')
    names.add(field.name)
    for (const scope of field.scopes ?? []) { if (typeof scope.name !== 'string' || typeof scope.status !== 'boolean' || scopeNames.has(scope.name)) fail('权限范围缺失或重复。'); scopeNames.add(scope.name) }
  }
  return groups
}
function member(value: unknown, target: unknown) { return roles(value).find(role => role.id === target) ?? fail('目标角色不在当前公司对应业务的实际目录中。', 'FORBIDDEN') }
function context(input: JsonObject, results: JsonObject, session: Session | null) {
  const expected = requireSession(session).identity, user = asObject(results.user)
  if (id(user.id) !== expected.userId || id(asObject(user.team).id) !== expected.teamId) fail('角色配置上下文与当前身份不一致。', 'IDENTITY_CHANGED')
  if (input.companyId !== expected.teamId) fail('公司级角色操作须明确提供当前 profile 的 companyId。', 'INVALID_INPUT')
  validateCompanyState(asObject(results.state)); validatePermissions(['viewAuthorityManage'], asObject(results.permissions))
  return user
}
function save(results: JsonObject, value: JsonObject) { results.prepared = { ...asObject(results.prepared), ...value } }
export function prepareCompanyRole(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const [, module, action] = /^company-roles-(company|kanban|corpus|lib|archive)-(.+)$/.exec(kind) ?? []
  if (!module || !action) fail('未知角色配置编排。', 'INVALID_CONTRACT')
  const user = context(input, results, session)
  if (!['list', 'permissions'].includes(action) || !asObject(results.prepared).action) save(results, { module, action, resources: { companyId: input.companyId, ...(input.roleId ? { roleId: input.roleId } : {}) } })
  if (action === 'list') return {}
  if (action === 'permissions') { member(results.roles, input.roleId); return { query: { roleId: input.roleId } } }
  if (!isDeepStrictEqual(roles(results.roles), roles(results.preflightRoles))) fail('角色目录在写前变化，请重新发现；不会覆盖或重放。', 'CONTEXT_CONFLICT')
  validatePermissions(['viewAuthorityManage'], asObject(results.preflightPermissions))
  const freshPermissions = asObject(results.preflightPermissions)
  if (['create', 'rename', 'remove'].includes(action)) {
    if (!['company', 'kanban', 'corpus'].includes(module)) fail('当前界面不允许云盘或档案袋自定义角色。', 'FORBIDDEN')
    validateFeatures(['TEAM_AUTH_MANAGE'], results.features, freshPermissions)
    validatePermissions([action === 'create' ? 'createCustomRole' : action === 'remove' ? 'removeCustomRole' : 'editCustomRole'], freshPermissions)
    if (action !== 'remove' && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\x00-\x1f\x7f]/.test(input.name))) fail('角色名称须为 1 至 200 字且无控制字符。', 'INVALID_INPUT')
    if (action === 'create') { save(results, { expectedName: input.name }); return { body: { name: input.name } } }
    const target = member(results.preflightRoles, input.roleId)
    if (!target.custom) fail('默认角色不能改名或删除。', 'FORBIDDEN')
    save(results, { expectedRole: { ...target, ...(action === 'rename' && { name: input.name }) } })
    return action === 'remove' ? { query: { id: input.roleId } } : target.name === input.name ? null : { body: { id: input.roleId, name: input.name } }
  }
  const target = member(results.preflightRoles, input.roleId), before = tree(results.authorities), latest = tree(results.preflightAuthorities)
  if (!isDeepStrictEqual(before, latest)) fail('权限树或范围在写前变化，不会用旧配置覆盖。', 'CONTEXT_CONFLICT')
  const expected = structuredClone(latest), fields = expected.flatMap(group => group.authorities), names = action === 'batch-set' ? input.names : [input.name]
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) fail('须明确选择不重复的实际权限名。', 'INVALID_INPUT')
  const selected = names.map(name => fields.find(field => field.name === name) ?? fail('权限名不在所选角色实际权限树中。', 'INVALID_INPUT'))
  const scoped = selected.length === 1 && !!selected[0]!.scopes?.length
  if (scoped) {
    if (action === 'batch-set' || module !== 'company' || typeof input.scope !== 'string' || input.enabled !== undefined) fail('范围权限须用单项设置并从实际 scope 选项选择，不能同时提供 enabled。', 'INVALID_INPUT')
    const field = selected[0]!, group = expected.find(group => group.authorities.includes(field))!
    const creator = target.type === 'teamCreator' && asObject(user.userRole).type === 'teamCreator'
    if (!creator) { validateFeatures(['TEAM_AUTH_MANAGE'], results.features, freshPermissions); if (!['task', 'dataManage'].includes(String(group.group))) fail('当前 UI 不允许修改此范围组。', 'FORBIDDEN'); validatePermissions(['editDataManage'], freshPermissions) }
    validatePermissions(['editCustomRole'], freshPermissions)
    if (!field.scopes!.some(scope => scope.name === input.scope)) fail('所选范围不在该权限的实际选项中。', 'INVALID_INPUT')
    for (const scope of field.scopes!) scope.status = scope.name === input.scope
    const body = { roleId: input.roleId, name: field.name, status: field.status, scopes: field.scopes!.map(({ name, status }) => ({ name, status })) }
    save(results, { expectedAuthorities: expected }); return isDeepStrictEqual(expected, latest) ? null : { body }
  }
  if (input.scope !== undefined || selected.some(field => field.scopes?.length) || typeof input.enabled !== 'boolean') fail('普通权限须给出 enabled；scope 不能用于普通或批量权限。', 'INVALID_INPUT')
  if (String(target.type).endsWith('Creator')) fail('当前界面不允许修改创建者的普通权限。', 'FORBIDDEN')
  validateFeatures(['TEAM_AUTH_MANAGE'], results.features, freshPermissions); validatePermissions(['editCustomRole'], freshPermissions)
  // These are re-added unconditionally by the current service. Treating an
  // attempted disable as success would be a false business closure.
  const mandatory = { company: 'quitTeam', kanban: 'quitKanban', corpus: 'quitCorpus', lib: 'quitLib', archive: 'quitArchiveBag' }[module]
  if (input.enabled === false && mandatory && names.includes(mandatory)) fail('服务端固定保留退出权限，不能宣称已取消。', 'INVALID_INPUT')
  for (const field of selected) field.status = input.enabled
  for (const field of fields) if (field.name === mandatory) field.status = true
  save(results, { expectedAuthorities: expected })
  const body = action === 'batch-set' ? { roleId: input.roleId, nameList: names, status: input.enabled } : { roleId: input.roleId, name: input.name, status: input.enabled }
  return isDeepStrictEqual(expected, latest) ? null : { body }
}
export function verifyCompanyRole(input: JsonObject, results: JsonObject, step: string, session: Session | null) {
  context(input, results, session)
  if (step === 'roles') { roles(results.roles); return }
  if (step === 'authorities') { tree(results.authorities); return }
  const prepared = asObject(results.prepared), before = roles(results.preflightRoles)
  if (step === 'verifiedAuthorities') {
    if (!isDeepStrictEqual(tree(results.verifiedAuthorities), prepared.expectedAuthorities)) fail('独立读回权限或未修改范围与预期不符，不会重放。', 'BUSINESS_ASSERTION_FAILED')
    return
  }
  const actual = roles(results.verifiedRoles)
  let expected = before
  if (prepared.action === 'create') {
    const created = asObject(results.changed), added = actual.filter(role => !before.some(item => item.id === role.id))
    if (added.length !== 1 || added[0]!.id !== id(created.id) || !added[0]!.custom || added[0]!.name !== prepared.expectedName) fail('新角色未通过独立目录核对，保留已知 ID，不重发创建。', 'BUSINESS_ASSERTION_FAILED')
    expected = [...before, added[0]!].sort((a, b) => a.id.localeCompare(b.id))
  } else if (prepared.action === 'rename') expected = before.map(role => role.id === input.roleId ? asObject(prepared.expectedRole) as typeof role : role)
  else if (prepared.action === 'remove') expected = before.filter(role => role.id !== input.roleId)
  if (!isDeepStrictEqual(actual, expected)) fail('独立读回角色目录或无关角色变化，请核对已执行状态，不会重放。', 'BUSINESS_ASSERTION_FAILED')
}
export function describeCompanyRole(input: JsonObject, results: JsonObject, session: Session | null) {
  context(input, results, session)
  const prepared = asObject(results.prepared), module = String(prepared.module)
  return { companyId: input.companyId, module, roles: roles(results.verifiedRoles ?? results.roles),
    ...(results.authorities ? { roleId: input.roleId, authorities: tree(results.verifiedAuthorities ?? results.authorities) } : {}),
    ...(prepared.action === 'remove' && { removed: true, roleId: input.roleId, affectedUsers: 'server-reassigns-all-uses-to-default-role', usageEnumerationSupported: false }),
    ...(results.verifiedRoles || results.verifiedAuthorities ? { verified: true } : {}),
    customRolesSupported: ['company', 'kanban', 'corpus'].includes(module),
    scope: 'company-wide-role-configuration', recovery: '写入不自动重放；删除会将全部使用者改为对应默认角色。当前列表不枚举全部资源中的使用情况。' }
}
