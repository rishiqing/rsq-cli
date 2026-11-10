import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows,runWorkflow } from '../dist/workflows.js'
import { executeWorkflow,executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { projectGroups,prepareProjectContext } from '../dist/project-context.js'
const ctx = { environment: 'production',profile: 'fixture' },session = { version: 1,method: 'password',accessToken: 'fixture',identity: { userId: '81',teamId: '7' },expiresAt: Date.now()+3600000 }
const json = value => new Response(JSON.stringify(value),{ headers: { 'content-type': 'application/json' } }),flow = command => workflows.workflows.find(flow => flow.command === command)
function fixture(options = {}) {
  let groups = [{ id: 101,name: 'A',parentGroupId: null,displayOrder: 100 },{ id: 102,name: 'B',parentGroupId: null,displayOrder: 200 },{ id: 103,name: '子组',parentGroupId: 101,displayOrder: 100 }],next = 104
  let projects = [{ id: '7001',name: '普通项目',coverId: null,attribute: 'company',kanbanGroupId: '101',showView: 'kanban',description: '',isSyncWorkflowTodo: true,isSyncOauthTodo: false,editControl: { editKanbanInfo: true,editKanbanView: true,editKanbanPreferences: true,removeKanban: true,...options.projectPermissions } }],recycle = [],deleted = []
  if (options.template) projects[0].coverId = '301'
  const publicGroup = item => ({ ...item,groupList: [],kanbanList: [] }),sorted = items => items.sort((a,b) => a.displayOrder-b.displayOrder),build = item => ({ ...item,canCreateChildGroup: true,groupList: sorted(groups.filter(g => g.parentGroupId === item.id)).map(build),kanbanList: projects.filter(p => String(p.kanbanGroupId) === String(item.id)) })
  const tree = () => [...sorted(groups.filter(g => g.parentGroupId == null)).map(build),{ id: 'star',name: '星标',groupList: [],kanbanList: [] },{ id: 'ungrouped',name: '未分组',groupList: [],kanbanList: projects.filter(p => p.kanbanGroupId == null) }]
  const calls = [],transport = async (url,init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {},q = Object.fromEntries(url.searchParams);calls.push({ path: url.pathname,method: init.method,body,query: q,headers: init.headers })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true,id: 81,username: 'fixture',token: 'fixture',team: { id: options.otherTeam ? 8 : 7,name: '公司' } })
    if (url.pathname.endsWith('/company/current')) return json({ editKanbanGroup: true,editKanbanTemp: true,createKanban: true,...options.companyPermissions })
    if (url.pathname.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00',usersCount: 1,userLimit: 10,vt: '7',mainApp: 'rsq' })
    if (url.pathname.endsWith('/function/available')) return json([])
    if (url.pathname === '/task/v3/kanbanGroup/list') return json(tree())
    if (url.pathname === '/task/v3/kanbanGroup/kanbanList') return json({ groupList: q.kanbanGroupId === 'all' ? groups.map(publicGroup) : groups.filter(g => String(g.parentGroupId) === q.kanbanGroupId).map(publicGroup),kanbanList: q.kanbanGroupId === 'all' ? projects : projects.filter(p => String(p.kanbanGroupId) === q.kanbanGroupId) })
    if (url.pathname.endsWith('/typeList')) return json([{ id: 'my',name: '个人' }])
    if (url.pathname.endsWith('/detailList')) return json([{ id: 301,name: '模板',needLevelUp: false },{ id: 'empty',name: '空白模板',templateKanbanId: 3001,needLevelUp: false,withEdit: false }])
    if (url.pathname === '/task/v4/template') return json({ id: 301,name: '模板',templateKanbanId: 3001,needLevelUp: options.upgrade ?? false,withEdit: options.templateEditable ?? true })
    if (url.pathname === '/task/v1/department/list') return json([{ id: 100,name: '公司',type: 'top',parentId: null,displayOrder: 0,leaderList: [],childList: [],userList: [{ id: 81,showName: '本人' }] }])
    if (url.pathname === '/task/v1/recycleBin/list') return json(recycle)
    if (url.pathname === '/task/v1/recycleBin') { const entry = recycle.find(row => String(row.id) === String(body.id ?? q.id));if (init.method === 'POST') projects.push(deleted.find(project => project.id === String(entry.resourceId)));recycle = recycle.filter(row => row !== entry);return init.method === 'POST' ? json({ hasParent: true,parentId: null }) : new Response(null) }
    if (url.pathname === '/task/v1/kanbanCrud') {
      if (init.method === 'GET') { const p = projects.find(p => p.id === q.id); return json({ ...p, coverId: init.headers.get('Plan-Type') === 'template' ? p.coverId : null }) }
      if (options.fail) throw Error('Unknown write')
      if (options.ignoreWrite) return json({ id: 7001 })
      if (init.method === 'POST') { const p = { ...projects[0],...body,id: '7002',coverId: null,kanbanGroupId: ['ungrouped','all'].includes(body.kanbanGroupId) ? null : body.kanbanGroupId };projects.push(p);return json(p) }
      const p = projects.find(p => p.id === String(body.id ?? q.id))
      if (init.method === 'PUT') { Object.assign(p,body);if (body.kanbanGroupId === '') p.kanbanGroupId = null;return json(p) }
      projects = projects.filter(row => row !== p);deleted.push(p);recycle.push({ id: 401,resourceId: p.id,userId: 81,type: 2 });return new Response(null)
    }
    if (options.fail) throw Error('Unknown write')
    if (options.ignoreWrite) return init.method === 'DELETE' ? new Response(null) : json({ id: body.id ?? 104,name: body.name ?? 'B',displayOrder: 200 })
    if (url.pathname.endsWith('/kanbanGroup/sort')) { const moving = groups.find(g => String(g.id) === body.moveId),front = groups.find(g => String(g.id) === body.frontId),after = groups.find(g => String(g.id) === body.nextId);moving.displayOrder = front && after ? (front.displayOrder+after.displayOrder)/2 : front ? front.displayOrder+100 : after.displayOrder-100;return json({ displayOrder: moving.displayOrder }) }
    if (url.pathname === '/task/v1/kanbanGroup') {
      if (init.method === 'POST') { const front = groups.find(g => String(g.id) === body.frontId),after = groups.find(g => String(g.id) === body.nextId),created = { id: next++,name: body.name,parentGroupId: body.parentGroupId ? Number(body.parentGroupId) : null,displayOrder: front && after ? (front.displayOrder+after.displayOrder)/2 : front ? front.displayOrder+100 : after ? after.displayOrder-100 : 100 };groups.push(created);return json(publicGroup(created)) }
      const item = groups.find(g => String(g.id) === String(body.id ?? q.id))
      if (init.method === 'PUT') { item.name = body.name;return json(publicGroup(item)) }
      for (const child of groups.filter(g => g.parentGroupId === item.id)) child.parentGroupId = item.parentGroupId
      for (const project of projects.filter(p => p.kanbanGroupId === String(item.id))) project.kanbanGroupId = item.parentGroupId == null ? null : String(item.parentGroupId)
      groups = groups.filter(g => g !== item);return new Response(null)
    }
    throw Error('Unexpected '+url.pathname)
  }
  return { transport,calls }
}
const run = (command,input,f,options = {}) => runWorkflow(ctx,flow(command),input,session,{ transport: f.transport,approved: true,...options })
test('ordinary project creation discovers the visible template, preserves context and independently verifies sparse edits and clear',async () => {
  const f = fixture(),created = (await run('project create',{ templateCategory: 'my',coverId: '301',name: '新项目',attribute: 'company',groupId: '103' },f)).result
  assert.equal(created.project.id,'7002');assert.equal(created.project.coverId,null);assert.equal(created.verified,true)
  assert.deepEqual(f.calls.find(c => c.method === 'POST').body,{ name: '新项目',attribute: 'company',templateKanbanId: '3001',kanbanGroupId: '103' })
  const changed = (await run('project update',{ projectId: '7002',patch: { description: '正文',isSyncOauthTodo: true,groupId: 'ungrouped' } },f)).result
  assert.equal(changed.project.kanbanGroupId,null);assert.equal(changed.project.isSyncWorkflowTodo,true)
  assert.deepEqual(JSON.parse(changed.project.description),{ ops: [{ insert: '正文\n' }] })
  await run('project view set',{ projectId: '7002',view: 'schedule' },f)
  const clear = (await run('project update',{ projectId: '7002',patch: { description: '' } },f)).result;assert.equal(clear.project.description,'')
  const removed = (await run('project remove',{ projectId: '7002' },f)).result;assert.deepEqual(removed.recycleEntries,[{ id: '401',resourceId: '7002',type: 2 }])
  await assert.rejects(run('project recycle restore',{ projectId: '7002',entryId: '7002' },f),{ code: 'FORBIDDEN' })
  const restored = (await run('project recycle restore',{ projectId: '7002',entryId: '401' },f)).result;assert.equal(restored.project.name,'新项目')
  await assert.rejects(run('project recycle restore',{ projectId: '7002',entryId: '401' },f),{ code: 'FORBIDDEN' })
  await run('project remove',{ projectId: '7002' },f)
  const purged = (await run('project recycle purge',{ projectId: '7002',entryId: '401' },f)).result;assert.equal(purged.removedFromRecycleBin,true);assert.match(purged.scope,/not physical/)
})
test('company groups use actual sibling anchors, keep descendants and promote both child groups and direct projects on deletion',async () => {
  const f = fixture(),created = (await run('project group create',{ companyId: '7',name: '新分组',targetId: '102',position: 'before' },f)).result
  assert.equal(created.id,'104');assert.deepEqual(f.calls.find(c => c.method === 'POST').body,{ name: '新分组',frontId: '101',nextId: '102' })
  await run('project group rename',{ companyId: '7',groupId: '104',name: '改名' },f)
  await run('project group move',{ companyId: '7',groupId: '102',targetId: '101',position: 'before' },f)
  const removed = (await run('project group remove',{ companyId: '7',groupId: '101' },f)).result
  assert.equal(removed.groups.find(g => g.id === '103').parentId,null);assert.deepEqual(removed.groups.find(g => g.id === 'ungrouped').projectIds,['7001']);assert.equal(removed.verified,true)
})
test('foreign contexts, missing permissions, templates, hidden covers, builtins and cross-parent ordering are blocked before target writes',async () => {
  for (const [command,input,options] of [
    ['project group rename',{ companyId: '8',groupId: '101',name: 'x' },{}],
    ['project group remove',{ companyId: '7',groupId: '999' },{}],
    ['project group move',{ companyId: '7',groupId: '102',targetId: '103',position: 'before' },{}],
    ['project group create',{ companyId: '7',parentId: '999',name: 'x' },{}],
    ['project group create',{ companyId: '7',name: 'x' },{ companyPermissions: { editKanbanGroup: false } }],
    ['project update',{ projectId: '7001',patch: { name: 'x' } },{ template: true }],
    ['project update',{ projectId: '7001',patch: { name: 'x' } },{ projectPermissions: { editKanbanInfo: false } }],
    ['project view set',{ projectId: '7001',view: 'list' },{ projectPermissions: { editKanbanView: false } }],
    ['project create',{ templateCategory: 'company',coverId: '301',name: 'x',attribute: 'person' },{}],
    ['project create',{ templateCategory: 'my',coverId: '301',name: 'x',attribute: 'person' },{ upgrade: true }],
    ['project create',{ templateCategory: 'my',coverId: '999',name: 'x',attribute: 'person' },{}],
    ['project create',{ templateCategory: 'my',coverId: '301',name: 'x',attribute: 'person',groupId: 'star' },{}],
    ['project list',{ groupId: '999' },{}],
  ]) { const f = fixture(options);await assert.rejects(run(command,input,f));assert.equal(f.calls.filter(c => c.method !== 'GET').length,0) }
  await assert.rejects(run('project group create',{ companyId: '7',name: 'x',position: 'before' },fixture()),{ code: 'INVALID_INPUT' })
  const nested = depth => [{ id: depth,name: '层级',parentGroupId: depth === 1 ? null : depth-1,groupList: depth < 5 ? nested(depth+1) : [],kanbanList: [] }]
  assert.equal(projectGroups(nested(1)).length,5)
  assert.throws(() => prepareProjectContext('project-context-group-create',{ companyId: '7',parentId: '5',name: 'x' },{ identity: { id: 81,team: { id: 7 } },company: { editKanbanGroup: true },groups: nested(1) },session),{ code: 'INVALID_INPUT' })
})
test('independent readback detects ignored writes, writes are never replayed, destructive confirmation and offline plans dispatch no network',async () => {
  const lost = fixture({ ignoreWrite: true });await assert.rejects(run('project update',{ projectId: '7001',patch: { name: 'new' } },lost),{ code: 'BUSINESS_ASSERTION_FAILED' });assert.equal(lost.calls.filter(c => c.method === 'PUT').length,1)
  const failed = fixture({ fail: true });await assert.rejects(run('project group rename',{ companyId: '7',groupId: '101',name: 'new' },failed),{ code: 'NETWORK_ERROR' });assert.equal(failed.calls.filter(c => c.method === 'PUT').length,1)
  const f = fixture();await assert.rejects(run('project group remove',{ companyId: '7',groupId: '101' },f,{ approved: false }),{ code: 'CONFIRMATION_REQUIRED' });assert.equal(f.calls.length,0)
  assert.equal((await run('project group create',{ companyId: '7',name: 'new' },f,{ dryRun: true })).dryRun,true);assert.equal(f.calls.length,0)
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/v1/kanbanGroup/sort');await assert.rejects(executeOperation(ctx,op,{ body: { moveId: '101' } },session,{ transport: f.transport }),{ code: 'BUSINESS_CONTEXT_REQUIRED' })
})
test('public dispatcher enforces expiry and company edit permission before project business context is requested',async () => {
  for (const [options,code] of [[{ expired: true },'COMPANY_EXPIRED'],[{ companyPermissions: { editKanbanGroup: false } },'FEATURE_FORBIDDEN']]) { const f = fixture(options);await assert.rejects(executeWorkflow(ctx,flow('project group create'),{ companyId: '7',name: 'new' },session,{ transport: f.transport }),{ code });assert.equal(f.calls.some(c => c.path.startsWith('/task/v3/kanbanGroup')),false) }
})
test('blank project uses the discovered special catalogue entry, and template write and application honor actual permission and upgrade flags',async () => {
  const f = fixture(),created = (await run('project create',{ templateCategory: 'my',coverId: 'empty',name: '空白',attribute: 'person' },f)).result
  assert.equal(created.project.coverId,null);assert.equal(f.calls.filter(call => call.path === '/task/v4/template').length,0);assert.equal(f.calls.find(call => call.method === 'POST').body.templateKanbanId,'3001')
  for (const [command,input,options] of [
    ['project template update',{ coverId: '301',name: 'x' },{ templateEditable: false }],
    ['project template delete',{ coverId: '301' },{ templateEditable: false }],
    ['project template apply',{ coverId: '301',name: 'x',attribute: 'person' },{ upgrade: true }],
    ['project template apply',{ coverId: '301',name: 'x',attribute: 'person',memberIds: '999' },{}],
    ['project template apply',{ coverId: '301',name: 'x',attribute: 'person',deptIds: '999' },{}],
    ['project template save',{ projectId: '7001',attribute: 'person' },{ companyPermissions: { editKanbanTemp: false } }],
  ]) { const f = fixture(options);await assert.rejects(run(command,input,f));assert.equal(f.calls.some(call => call.method !== 'GET'),false) }
})
