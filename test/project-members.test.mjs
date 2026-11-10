import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const flow = command => { const flow = workflows.workflows.find(flow => flow.command === command); assert.ok(flow, command); return flow }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  const roles = [{ id: 301, type: 'kanbanCreator', name: '拥有者' }, { id: 302, type: 'kanbanAdmin', name: '管理员' }, { id: 303, type: 'kanbanCommon', name: '成员' }, { id: 304, type: 'custom', name: '自定义' }]
  const member = (userId, roleId = 303) => ({ userId, showName: '用户' + userId, role: roles.find(role => role.id === roleId) })
  const project = { id: 7001, coverId: options.template ? 8001 : null, creatorId: 81, name: '实际项目', members: [member(81, 301), member(83)], depts: [{ id: 902, name: '真实关联部门' }], defaultTeamRole: roles[2], editControl: { addKanbanMember: true, removeKanbanMember: true, editKanbanMemberRole: true, editKanbanMemberDefaultRole: true, transforKanban: true, ...options.permissions } }
  const users = [81, 82, 83].map(id => ({ id, showName: '用户' + id }))
  let departmentMembers = [member(82)], calls = []
  const transport = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {}, q = Object.fromEntries(url.searchParams); calls.push({ path: url.pathname, method: init.method, body, query: q })
    if (url.pathname === '/task/login/authAjax') return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.foreignIdentity ? 8 : 7, name: '公司' } })
    if (url.pathname === '/task/authority/v3/authorities/company/current') return json({ editKanbanMemberCreatorRole: options.ownerCompany !== false })
    if (url.pathname === '/task/v1/department/list') return json([{ id: 901, name: '公司', type: 'top', parentId: null, displayOrder: 0, userList: users, childList: [{ id: 902, type: 'common', name: '真实关联部门', parentId: 901, displayOrder: 1, userList: [users[1]], childList: [] }] }])
    if (url.pathname === '/task/v1/kanban/listKanbanRole') return json(roles)
    if (url.pathname === '/task/v1/kanban/getDepartmentUserRoles') return json(departmentMembers)
    if (init.method === 'GET' && url.pathname === '/task/v1/kanbanCrud') return json(project)
    if (options.timeout) throw Error('Transport interrupted after submission')
    if (url.pathname === '/task/v1/kanban/updateMember') {
      if (!options.ignoreWrite) {
        if (Object.hasOwn(body, 'memberIds')) project.members = body.memberIds.split(',').filter(Boolean).map(userId => project.members.find(member => member.userId === +userId) ?? member(+userId, project.defaultTeamRole.id))
        if (Object.hasOwn(body, 'deptIds')) project.depts = body.deptIds.split(',').filter(Boolean).map(id => ({ id: +id, name: '部门' }))
      }
      // The controller returns [] for an omitted collection; verification must
      // use a separate project GET and preserve the actual omitted collection.
      return json({ members: Object.hasOwn(body, 'memberIds') ? project.members : [], depts: Object.hasOwn(body, 'deptIds') ? project.depts : [] })
    }
    if (url.pathname === '/task/v1/kanbanCrud' && init.method === 'PUT') {
      if (!options.ignoreWrite) project.defaultTeamRole = roles.find(role => role.id === +body.defaultTeamRoleId)
      return json(project)
    }
    if (url.pathname === '/task/v1/kanban/updateUserRole') {
      const selected = project.members.find(member => member.userId === +body.userId) ?? departmentMembers.find(member => member.userId === +body.userId)
      if (!options.ignoreWrite) {
        if (+body.roleId === 301) { project.members.find(member => member.role.type === 'kanbanCreator').role = roles[1]; if (!project.members.includes(selected)) project.members.push(selected) }
        selected.role = roles.find(role => role.id === +body.roleId)
      }
      return json(selected)
    }
    throw Error('Unexpected route: ' + url.pathname)
  }
  return { transport, calls, project }
}
const run = (command, input, f, options = {}) => runWorkflow(ctx, flow(command), input, session, { transport: f.transport, approved: true, ...options })
const writes = f => f.calls.filter(call => call.method !== 'GET')
test('project member sets use fresh directory IDs, sparse CSV and independent collections, including explicit department clear', async () => {
  const f = fixture(), out = await run('project members set', { projectId: '7001', memberIds: ['81', '82'] }, f)
  assert.deepEqual(writes(f)[0].body, { kanbanId: '7001', memberIds: '81,82' })
  assert.deepEqual(out.result.directMembers.map(member => member.userId), ['81', '82']); assert.deepEqual(out.result.departments.map(dept => dept.id), ['902']); assert.equal(out.result.verified, true)
  const cleared = await run('project members set', { projectId: '7001', departmentIds: [] }, f)
  assert.deepEqual(writes(f)[1].body, { kanbanId: '7001', deptIds: '' }); assert.deepEqual(cleared.result.departments, []); assert.equal(cleared.result.directMembers.length, 2)
})
test('UI add/remove permissions remain distinct despite permissive backend, with self and creator protected', async () => {
  for (const [input, options] of [
    [{ memberIds: ['81'] }, { permissions: { removeKanbanMember: false } }],
    [{ memberIds: ['81', '82', '83'] }, { permissions: { addKanbanMember: false } }],
    [{ departmentIds: [] }, { permissions: { removeKanbanMember: false } }],
    [{ memberIds: ['82', '83'] }, {}], [{ memberIds: ['81', '999'] }, {}], [{ departmentIds: ['999'] }, {}],
  ]) { const f = fixture(options); await assert.rejects(run('project members set', { projectId: '7001', ...input }, f)); assert.equal(writes(f).length, 0) }
})
test('department members retain their separate inherited context and roles are independently read back', async () => {
  const f = fixture(), listed = await run('project department members list', { projectId: '7001', departmentId: '902' }, f)
  assert.deepEqual(listed.result.directMembers.map(member => member.userId), ['81', '83']); assert.deepEqual(listed.result.departmentMembers.map(member => member.userId), ['82'])
  const changed = await run('project member role set', { projectId: '7001', departmentId: '902', userId: '82', roleId: '304' }, f)
  assert.equal(changed.result.departmentMembers[0].role.id, '304'); assert.deepEqual(changed.result.directMembers.map(member => member.userId), ['81', '83'])
  assert.equal(f.calls.filter(call => call.path.endsWith('getDepartmentUserRoles')).length, 3)
  for (const input of [{ userId: '82', roleId: '304' }, { userId: '82', roleId: '304', departmentId: '901' }, { userId: '83', roleId: '999' }]) { const denied = fixture(); await assert.rejects(run('project member role set', { projectId: '7001', ...input }, denied)); assert.equal(writes(denied).length, 0) }
})
test('default roles exclude owner and preserve existing memberships; owner transfer separately verifies demotion and unique ownership', async () => {
  const f = fixture(), initial = structuredClone(f.project.members)
  const configured = await run('project member default-role set', { projectId: '7001', roleId: '304' }, f)
  assert.equal(configured.result.defaultRole.id, 304); assert.deepEqual(f.project.members, initial)
  const moved = await run('project owner transfer', { projectId: '7001', userId: '83', roleId: '301' }, f)
  assert.equal(moved.result.directMembers.find(member => member.userId === '83').role.type, 'kanbanCreator'); assert.equal(moved.result.directMembers.find(member => member.userId === '81').role.type, 'kanbanAdmin')
  for (const [command, input, options] of [
    ['project member role set', { userId: '83', roleId: '301' }, {}], ['project member role set', { userId: '81', roleId: '303' }, {}],
    ['project member default-role set', { roleId: '301' }, {}], ['project member default-role set', { roleId: '304' }, { permissions: { editKanbanMemberDefaultRole: false } }],
    ['project owner transfer', { userId: '83', roleId: '301' }, { ownerCompany: false, permissions: { transforKanban: false } }],
  ]) { const blocked = fixture(options); await assert.rejects(run(command, { projectId: '7001', ...input }, blocked)); assert.equal(writes(blocked).length, 0) }
})
test('foreign identities and templates are rejected; dry-run is offline and destructive commands require explicit confirmation', async () => {
  for (const options of [{ foreignIdentity: true }, { template: true }]) { const f = fixture(options); await assert.rejects(run('project members set', { projectId: '7001', departmentIds: [] }, f)); assert.equal(writes(f).length, 0) }
  const f = fixture(); await run('project members set', { projectId: '7001', departmentIds: [] }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('project members set', { projectId: '7001', departmentIds: [] }, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  for (const route of ['/task/v1/kanban/updateMember', '/task/v1/kanban/updateMember/', '/task/v1/kanban/updateUserRole']) { const operation = catalog.operations.find(op => op.route === route), body = route.endsWith('updateUserRole') ? { id: '7001', userId: '83', roleId: '304' } : { kanbanId: '7001', memberIds: '81' }; await assert.rejects(executeOperation(ctx, operation, { body }, session, { approved: true, transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }) }
})
test('false write acknowledgements fail independent business assertions and unknown writes are never replayed', async () => {
  const ignored = fixture({ ignoreWrite: true }); await assert.rejects(run('project members set', { projectId: '7001', departmentIds: [] }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(ignored).length, 1)
  const timeout = fixture({ timeout: true }); await assert.rejects(run('project member role set', { projectId: '7001', userId: '83', roleId: '304' }, timeout), error => { assert.equal(error.details.failedStep, 'changed'); return true }); assert.equal(writes(timeout).length, 1)
})
