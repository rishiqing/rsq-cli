import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const companyId = '7'
function fixture(options = {}) {
  const user = { id: 81, showName: '本人', avatar: 'https://private.invalid/?signature=secret', leader: { id: 82, showName: '领导', avatar: 'https://private.invalid/?signature=secret' } }
  let nodes = [
    { id: 100, name: '公司', type: 'top', parentId: null, displayOrder: 0, userList: [] },
    { id: 101, name: '未分配', type: 'unassigned', parentId: 100, displayOrder: 999, userList: [user] },
    { id: 102, name: '部门 A', type: 'common', parentId: 100, displayOrder: 100, userList: [] },
    { id: 103, name: '部门 B', type: 'common', parentId: 100, displayOrder: 200, userList: [] },
    { id: 104, name: 'A 子部门', type: 'common', parentId: 102, displayOrder: 100, userList: [] },
  ].map(node => ({ ...node,leaderList: [] }))
  let groups = [{ id: 201,name: '小组 A',displayOrder: 100,users: [user] },{ id: 202,name: '小组 B',displayOrder: 200,users: [] }]
  const build = node => ({ ...node, level: node.parentId == null ? 1 : node.type === 'unassigned' || node.parentId === 100 ? 2 : 3, childList: nodes.filter(child => child.type === 'common' && child.parentId === node.id).sort((a,b) => a.displayOrder-b.displayOrder).map(build) })
  const detail = group => ({ ...group, userCount: group.users.length })
  const calls = []
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}, match = url.pathname.match(/\/(\d+)$/), id = match?.[1] ?? body.id
    calls.push({ method: init.method,path: url.pathname+url.search,body })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true,id: 81,username: 'fixture',token: 'fixture',team: { id: 7,name: '公司' },oauth: { userFrom: options.origin ?? 'password',isvOuterData: { canModifyDepartment: options.syncEditable ?? false } } })
    if (url.pathname.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 23:59:59' : '2100-01-01 23:59:59',usersCount: 1,userLimit: 10,vt: '7',mainApp: 'rsq' })
    if (url.pathname.endsWith('/function/available')) return json([])
    if (url.pathname.endsWith('/company/current')) return json({ editDept: true,editStaffInfo: true,editStaffGroup: true,editStaffGroupMember: true,...options.permissions })
    const isGroup = url.pathname.includes('staffGroup')
    if (init.method === 'GET') {
      if (isGroup) return json(match ? detail(groups.find(group => String(group.id) === id)) : groups.sort((a,b) => a.displayOrder-b.displayOrder).map(detail))
      assert.equal(url.searchParams.get('cliContext'),'fresh')
      return json(nodes.filter(node => node.type === 'top' || node.type === 'unassigned').map(build))
    }
    if (options.networkFailure) throw Error('unknown outcome')
    if (options.ignoreWrite) return new Response(null)
    if (isGroup) {
      const group = groups.find(group => String(group.id) === String(body.groupId ?? id))
      if (url.pathname.endsWith('/addStaffs')) { for (const key of body.userIds.split(',')) if (!group.users.some(user => String(user.id) === key)) group.users.push(user); return json(detail(group)) }
      if (url.pathname.endsWith('/removeStaffs')) { group.users = group.users.filter(user => !body.userIds.split(',').includes(String(user.id))); return json(detail(group)) }
      if (url.pathname.endsWith('/sort')) { const front = groups.find(group => String(group.id) === body.frontId), next = groups.find(group => String(group.id) === body.lastId); group.displayOrder = front && next ? (front.displayOrder+next.displayOrder)/2 : front ? front.displayOrder+100 : next.displayOrder-100 }
      else if (init.method === 'POST') { const created = { id: 203,...body,displayOrder: 300,users: [] }; groups.push(created); return json(detail(created)) }
      else if (init.method === 'PUT') group.name = body.name
      else groups = groups.filter(group => String(group.id) !== id)
      return new Response(null)
    }
    if (url.pathname.endsWith('/batchChangeDepartment')) {
      const wanted = body.departmentIds ? body.departmentIds.split(',') : ['101']
      for (const node of nodes) { node.userList = node.userList.filter(user => !body.userIds.split(',').includes(String(user.id))); if (wanted.includes(String(node.id))) node.userList.push(user); node.leaderList = node.leaderList.filter(leader => node.userList.some(user => user.id === leader.id)) }
      return new Response(null)
    }
    const node = nodes.find(node => String(node.id) === String(id))
    if (url.pathname.endsWith('/sort')) { const front = nodes.find(node => String(node.id) === body.frontId), next = nodes.find(node => String(node.id) === body.nextId); node.displayOrder = front && next ? (front.displayOrder+next.displayOrder)/2 : front ? front.displayOrder+100 : next.displayOrder-100; return json({ displayOrder: node.displayOrder,flush: false }) }
    if (init.method === 'POST') { const created = { id: 105,...body,parentId: Number(body.parentId),type: 'common',displayOrder: 300,userList: [],leaderList: [] }; nodes.push(created); return json(build(created)) }
    if (init.method === 'PUT') { if (body.name != null) node.name = body.name; if (body.parentId != null) node.parentId = Number(body.parentId); if (body.leaderIds != null) node.leaderList = body.leaderIds ? [user] : []; return json(build(node)) }
    const subtree = root => [root,...nodes.filter(child => child.parentId === root.id).flatMap(subtree)], removed = subtree(node), parent = nodes.find(parent => parent.id === node.parentId)
    parent.userList.push(...removed.flatMap(node => node.userList)); nodes = nodes.filter(node => !removed.includes(node)); return new Response(null)
  }
  return { calls,transport }
}
const flow = command => workflows.workflows.find(flow => flow.command === command)
const run = (command,input,f,options = {}) => runWorkflow(ctx,flow(command),input,session,{ approved: true,transport: f.transport,...options })
test('company directory exposes full business context without temporary avatar URLs or stale cache reads', async () => {
  const result = await run('contact directory inspect',{},fixture())
  assert.equal(result.result.departments.length,5)
  assert.equal(result.result.members[0].id,81)
  assert.ok(!JSON.stringify(result).includes('signature'))
  await assert.rejects(run('contact department inspect',{ id: '999' },fixture()),{ code: 'FORBIDDEN' })
})
test('department creation, multi-department membership, leaders, empty clear and subtree deletion independently read back', async () => {
  const f = fixture(), created = await run('contact department create',{ companyId,parentId: '100',name: '新部门' },f)
  assert.equal(created.result.createdId,'105')
  await run('contact member departments set',{ companyId,userIds: ['81'],departmentIds: ['102','105'] },f)
  await run('contact department update',{ companyId,id: '102',patch: { name: '部门新名称',leaderIds: ['81'] } },f)
  const clear = await run('contact department update',{ companyId,id: '102',patch: { leaderIds: [] } },f)
  assert.deepEqual(clear.result.departments.find(node => node.id === '102').leaderIds,[])
  assert.equal(f.calls.filter(call => call.path === '/task/v1/department/102').at(-1).body.leaderIds,'')
  await run('contact member departments set',{ companyId,userIds: ['81'],departmentIds: ['104'] },f)
  const removed = await run('contact department remove',{ companyId,id: '102' },f)
  assert.deepEqual(removed.result.removedIds,['102','104']); assert.deepEqual(removed.result.relocatedMemberIds,['81'])
  assert.ok(removed.result.departments.find(node => node.id === '100').memberIds.includes('81'))
  const reset = await run('contact member departments set',{ companyId,userIds: ['81'],departmentIds: [] },f)
  assert.deepEqual(reset.result.departments.find(node => node.type === 'unassigned').memberIds,['81'])
})
test('company and platform restrictions reject invalid hierarchy, root operations, foreign targets, members and anchors before writes', async () => {
  for (const [cmd,input] of [['contact department create',{ parentId: '101',name: '无效' }],['contact department update',{ id: '102',patch: { parentId: '104' } }],['contact department update',{ id: '102',patch: { parentId: '102' } }],['contact department remove',{ id: '100' }],['contact department move',{ id: '102',beforeId: '104' }],['contact department update',{ id: '102',patch: { leaderIds: ['81'] } }],['contact member departments set',{ userIds: ['999'],departmentIds: ['102'] }],['contact group move',{ id: '201',afterId: '999' }]]) {
    const f = fixture(); await assert.rejects(run(cmd,{ companyId,...input },f)); assert.equal(f.calls.filter(call => call.method !== 'GET').length,0)
  }
  await assert.rejects(run('contact group create',{ companyId: '8',name: '无效' },fixture()),{ code: 'INVALID_INPUT' })
  await assert.rejects(run('contact department create',{ companyId,parentId: '100',name: '无效' },fixture({ origin: 'qywx' })),{ code: 'FORBIDDEN' })
  await run('contact department update',{ companyId,id: '102',patch: { name: '企微名称' } },fixture({ origin: 'qywx' }))
  await run('contact department create',{ companyId,parentId: '100',name: '企微可编辑' },fixture({ origin: 'qywx',syncEditable: true }))
  await assert.rejects(run('contact department update',{ companyId,id: '102',patch: { name: '钉钉只读' } },fixture({ origin: 'dingtalk' })),{ code: 'FORBIDDEN' })
  await assert.rejects(run('contact group create',{ companyId,name: '无权限' },fixture({ permissions: { editStaffGroup: false } })),{ code: 'FORBIDDEN' })
})
test('department and group ordering uses complete current neighbor context and detects ignored updates', async () => {
  for (const [cmd,id,beforeId] of [['contact department move','103','102'],['contact group move','202','201']]) {
    const f = fixture(), result = await run(cmd,{ companyId,id,beforeId },f), request = f.calls.find(call => call.method !== 'GET')
    assert.equal(request.body[cmd.includes('department') ? 'nextId' : 'lastId'],beforeId)
    assert.equal(result.result.verified,true)
    await assert.rejects(run(cmd,{ companyId,id,beforeId },fixture({ ignoreWrite: true })))
  }
})
test('group lifecycle distinguishes group membership from company membership and independently verifies exact member sets', async () => {
  const f = fixture(), created = await run('contact group create',{ companyId,name: '新小组' },f)
  assert.equal(created.result.createdId,'203')
  await run('contact group rename',{ companyId,id: '203',name: '新小组改名' },f)
  const added = await run('contact group member add',{ companyId,id: '203',userIds: ['81'] },f)
  assert.equal(added.result.group.userCount,1)
  const removed = await run('contact group member remove',{ companyId,id: '203',userIds: ['81'] },f)
  assert.equal(removed.result.group.userCount,0); assert.equal(removed.result.members.length,1)
  await run('contact group remove',{ companyId,id: '203' },f)
  await assert.rejects(run('contact group member add',{ companyId,id: '203',userIds: ['81'] },f),{ code: 'FORBIDDEN' })
})
test('company writes fail safely on subscription denial, unknown outcome, missing confirmation and direct HTTP bypass', async () => {
  const f = fixture({ networkFailure: true })
  await assert.rejects(run('contact department create',{ companyId,parentId: '100',name: '结果未知' },f),error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown')
  assert.equal(f.calls.filter(call => call.method === 'POST').length,1)
  const expired = fixture({ expired: true })
  await assert.rejects(executeWorkflow(ctx,flow('contact group create'),{ companyId,name: '到期' },session,{ transport: expired.transport }),{ code: 'COMPANY_EXPIRED' })
  assert.equal(expired.calls.filter(call => call.method !== 'GET').length,0)
  const offline = { transport: async () => { throw Error('offline') } }
  assert.equal((await run('contact department remove',{ companyId,id: '102' },offline,{ dryRun: true })).dryRun,true)
  await assert.rejects(run('contact group remove',{ companyId,id: '201' },offline,{ approved: false }),{ code: 'CONFIRMATION_REQUIRED' })
  const op = catalog.operations.find(op => op.route === '/task/v1/staffGroup/sort')
  await assert.rejects(executeOperation(ctx,op,{ body: { id: '201',lastId: '202' } },session,{ approved: true,transport: offline.transport }),{ code: 'BUSINESS_CONTEXT_REQUIRED' })
})
