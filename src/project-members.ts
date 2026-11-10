import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import { requireSession, type Session } from './session.js'

const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const denied = (message: string): never => { throw new RsqError('RESOURCE_FORBIDDEN', message, 4) }
const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('项目成员上下文缺少精确资源 ID。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : invalid('项目成员上下文缺少有界完整列表。')
const members = (value: unknown) => rows(value).map(row => ({ ...row, userId: id(row.userId), role: asObject(row.role) }))
const equalIds = (actual: unknown[], expected: unknown[]) => isDeepStrictEqual(actual.map(id).sort(), expected.map(id).sort())
const permitted = (project: JsonObject, permission: string) => { if (asObject(project.editControl)[permission] !== true) denied('当前项目未授予 ' + permission + ' 权限。') }
function project(input: JsonObject, results: JsonObject) {
  const row = asObject(results.project)
  if (id(row.id) !== input.projectId || !Object.hasOwn(row, 'coverId') || row.coverId !== null) denied('成员和角色操作必须使用实际普通项目；模板使用独立上下文。')
  return row
}
function department(input: JsonObject, row: JsonObject, results: JsonObject) {
  if (!rows(row.depts).some(item => id(item.id) === input.departmentId) || !companyDirectoryUnits(results.directory).some(item => item.id === input.departmentId)) denied('部门必须是当前公司目录中已关联到此项目的真实部门。')
}
function role(results: JsonObject, roleId: unknown) {
  const result = rows(results.roles).filter(item => id(item.id) === roleId)
  if (result.length !== 1 || !['kanbanCreator', 'kanbanAdmin', 'kanbanCommon', 'kanbanVisitor', 'kanbanCustom', 'custom'].includes(String(result[0].type))) denied('角色必须从本公司的实际项目角色目录发现，不能使用公司管理角色或猜测编号。')
  return result[0]
}
function target(input: JsonObject, row: JsonObject, results: JsonObject) {
  if (input.departmentId != null) department(input, row, results)
  const result = members(input.departmentId == null ? row.members : results.departmentMembers).find(member => member.userId === input.userId)
  if (!result || !companyDirectoryUsers(results.directory).some(member => id(member.id) === input.userId)) denied('目标必须是当前项目直接成员或指定已关联部门内的实际公司成员。')
  return result ?? denied('目标项目成员不存在。')
}

export function prepareProjectMember(action: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject | null {
  const session = requireSession(supplied), row = project(input, results)
  const identity = asObject(results.identity)
  if (id(identity.id) !== session.identity.userId || id(asObject(identity.team).id) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED', '项目成员上下文与当前 profile 公司或用户不一致。', 3)
  results.projectMemberContext = { action, projectId: input.projectId }
  if (action === 'inspect') return {}
  if (action === 'department' || action === 'verify-department') {
    if (input.departmentId == null) return null
    department(input, row, results)
    return { query: { kanbanId: input.projectId, departmentId: input.departmentId } }
  }
  if (action === 'set') {
    const beforeMembers = members(row.members), beforeDepts = rows(row.depts)
    const body: JsonObject = { kanbanId: input.projectId }, expected: JsonObject = { memberIds: beforeMembers.map(member => member.userId), departmentIds: beforeDepts.map(item => id(item.id)) }
    for (const [key, prior, available, out] of [
      ['memberIds', beforeMembers.map(member => member.userId), companyDirectoryUsers(results.directory).map(item => id(item.id)), 'memberIds'],
      ['departmentIds', beforeDepts.map(item => id(item.id)), companyDirectoryUnits(results.directory).map(item => item.id), 'deptIds'],
    ] as [string, string[], string[], string][]) {
      if (!Object.hasOwn(input, key)) continue
      if (!Array.isArray(input[key])) invalid('成员与部门使用 ID 数组；空数组表示明确清空，未提供的集合保持原值。')
      const selected = (input[key] as unknown[]).map(id)
      if (new Set(selected).size !== selected.length || selected.some(item => !available.includes(item))) invalid('选择包含重复或非当前公司的成员、部门 ID。')
      if (selected.some(item => !prior.includes(item))) permitted(row, 'addKanbanMember')
      if (prior.some(item => !selected.includes(item))) permitted(row, 'removeKanbanMember')
      if (key === 'memberIds' && prior.some(item => !selected.includes(item) && (item === session.identity.userId || item === id(row.creatorId) || asObject(beforeMembers.find(member => member.userId === item)?.role).type === 'kanbanCreator'))) denied('与当前 UI 一致，不能从直接成员中移除当前用户或项目拥有者；退出和移交使用各自业务流程。')
      expected[key] = selected; body[out] = selected.join(',')
    }
    if (!Object.hasOwn(body, 'memberIds') && !Object.hasOwn(body, 'deptIds')) invalid('必须明确提供 memberIds 或 departmentIds。')
    results.projectMemberExpected = expected
    return { body }
  }
  const selectedRole = role(results, input.roleId)
  if (action === 'default-role') {
    permitted(row, 'editKanbanMemberDefaultRole')
    if (selectedRole.type === 'kanbanCreator') invalid('拥有者不能作为新成员默认角色。')
    results.projectMemberExpected = { defaultRoleId: input.roleId }
    return { body: { id: input.projectId, defaultTeamRoleId: input.roleId } }
  }
  const selected = target(input, row, results)
  if (asObject(selected.role).type === 'kanbanCreator') denied('当前拥有者角色不能直接改写；请移交给另一真实成员。')
  if (action === 'owner') {
    if (selectedRole.type !== 'kanbanCreator') invalid('移交必须使用实际项目拥有者角色。')
    if (asObject(results.company).editKanbanMemberCreatorRole !== true && asObject(row.editControl).transforKanban !== true) denied('当前 UI 没有授予公司修改项目拥有者或项目移交权限。')
    const owners = members(row.members).filter(member => asObject(member.role).type === 'kanbanCreator')
    if (owners.length !== 1) invalid('必须先发现唯一的当前拥有者，不能猜测移交前状态。')
    results.projectMemberExpected = { userId: input.userId, roleId: input.roleId, previousOwnerId: owners[0].userId, owner: true }
  } else if (action === 'role') {
    permitted(row, 'editKanbanMemberRole')
    if (selectedRole.type === 'kanbanCreator') invalid('拥有者移交必须使用 project owner transfer，并显式确认。')
    results.projectMemberExpected = { userId: input.userId, roleId: input.roleId, departmentId: input.departmentId }
  } else throw new RsqError('INVALID_CONTRACT', '未知项目成员编排。', 6)
  return { body: { id: input.projectId, userId: input.userId, roleId: input.roleId } }
}

export function verifyProjectMember(input: JsonObject, results: JsonObject, step: string) {
  const expected = asObject(results.projectMemberExpected)
  if (step === 'verifiedProject') {
    const row = asObject(results.verifiedProject)
    if (id(row.id) !== input.projectId || row.coverId !== null) fail('成员操作读回了其他资源或模板。')
    if (expected.memberIds && !equalIds(members(row.members).map(member => member.userId), expected.memberIds as string[])) fail('独立读回的直接成员集合不符，可能发生并发修改；不会覆盖或重发。')
    if (expected.departmentIds && !equalIds(rows(row.depts).map(item => item.id), expected.departmentIds as string[])) fail('独立读回的关联部门集合不符，可能发生并发修改；不会覆盖或重发。')
    if (expected.defaultRoleId && id(asObject(row.defaultTeamRole).id) !== expected.defaultRoleId) fail('新成员默认角色未独立保存。')
    if (expected.owner) {
      const after = members(row.members), owners = after.filter(member => asObject(member.role).type === 'kanbanCreator')
      if (owners.length !== 1 || owners[0].userId !== expected.userId || id(asObject(owners[0].role).id) !== expected.roleId || asObject(after.find(member => member.userId === expected.previousOwnerId)?.role).type !== 'kanbanAdmin') fail('移交后拥有者不唯一，或原拥有者未按服务端规则变为管理员。')
    }
    if (expected.userId && !expected.departmentId) verifyRole(row.members, expected)
  } else if (step === 'verifiedDepartment') verifyRole(results.verifiedDepartment, expected)
}
function verifyRole(value: unknown, expected: JsonObject) {
  const member = members(value).find(member => member.userId === expected.userId)
  if (!member || id(asObject(member.role).id) !== expected.roleId) fail('成员角色未在独立 HTTP 读取中保存。')
}
export function describeProjectMembers(input: JsonObject, results: JsonObject) {
  const row = asObject(results.verifiedProject ?? results.project), controls = asObject(row.editControl)
  const publicMember = (member: JsonObject) => ({ userId: id(member.userId), showName: member.showName, role: { ...asObject(member.role), id: id(asObject(member.role).id) } })
  return { projectId: id(row.id), directMembers: members(row.members).map(publicMember),
    departments: rows(row.depts).map(item => ({ id: id(item.id), name: item.name })),
    ...(input.departmentId != null && { departmentId: input.departmentId, departmentMembers: members(results.verifiedDepartment ?? results.departmentMembers).map(publicMember) }),
    defaultRole: row.defaultTeamRole,
    availableRoles: rows(results.roles).map(item => ({ id: id(item.id), name: item.name, type: item.type })),
    availableMembers: companyDirectoryUsers(results.directory).map(member => ({ userId: id(member.id), showName: member.showName })),
    availableDepartments: companyDirectoryUnits(results.directory),
    permissions: Object.fromEntries(['addKanbanMember', 'removeKanbanMember', 'editKanbanMemberRole', 'editKanbanMemberDefaultRole', 'transforKanban'].map(key => [key, controls[key] === true])),
    canChangeOwnerAtCompany: asObject(results.company).editKanbanMemberCreatorRole === true,
    verified: results.verifiedProject != null || results.verifiedDepartment != null }
}
