import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows,runWorkflow } from '../dist/workflows.js'
import { describeSearch,prepareSearch } from '../dist/search.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'
const ctx = { environment: 'production',profile: 'fixture' },session = { version: 1,method: 'password',accessToken: 'fixture',identity: { userId: '81',teamId: '7' },expiresAt: Date.now()+3600000 }
const json = value => new Response(JSON.stringify(value),{ headers: { 'content-type': 'application/json' } })
const row = (type,selfId,extra = {}) => ({ type,selfId,name: '验收',parentIds: {},...extra })
function fixture(options = {}) {
  const calls = [],user = { success: true,id: 81,username: 'fixture',token: 'fixture',team: { id: 7,name: 'fixture' },isSimpleUiUser: options.simple === true },functions = options.functions ?? [],authorities = options.permissions ?? {}
  return { calls,transport: async (url,init) => {
    const query = Object.fromEntries(url.searchParams);calls.push({ path: url.pathname,method: init.method,query })
    if (url.pathname.endsWith('/authAjax')) return json(user)
    if (url.pathname.endsWith('/independent')) return json({ vt: 'current-user-vt',deadLine: '2100-01-01',userLimit: 10,usersCount: 1,mainApp: 'rsq' })
    if (url.pathname.endsWith('/available')) return json(functions)
    if (url.pathname.endsWith('/company/current')) return json(authorities)
    if (url.pathname.endsWith('/preSearch')) return json({ todo: [row('todo','9007199254740993123')],kanban: [row('kanban_item','forbidden-project-task',{ name: 'must never be output' }),row('kanban_item','visible-project-task')],corpus: [],file: [],archive: [],recycleBin: [] })
    if (url.pathname.endsWith('/searchAll')) return json({ from: +query.from,size: +query.size,result: options.items ?? [row('kanban_item','visible-project-task',{ parentIds: { kanban: '9007199254740993124',child_kanban: '7002',unexpectedSecret: 'hide' },filePath: 'https://secret.example/signed',phoneNumber: 'hide',email: 'hide' })] })
    throw Error('unexpected '+url.pathname)
  } }
}
const run = (command,input,f,options = {}) => runWorkflow(ctx,workflows.workflows.find(flow => flow.command === command),input,session,{ transport: f.transport,...options })
test('project search uses the actual membership predicate, retains long identifiers and strips incidental access paths',async () => {
  const f = fixture(),result = (await run('search query',{ keyword: '验收',type: 'project' },f)).result
  const query = f.calls.find(call => call.path.endsWith('/searchAll')).query;assert.deepEqual(query,{ keyword: '验收',from: '0',size: '20' });assert.ok(!Object.hasOwn(query,'type'))
  assert.equal(result.items[0].parentIds.kanban,'9007199254740993124');assert.deepEqual(result.items[0].resource,{ command: 'task context inspect',input: { taskId: 'visible-project-task',projectId: '9007199254740993124' } })
  const raw = JSON.stringify(result);for (const forbidden of ['filePath','phoneNumber','email','unexpectedSecret','signed']) assert.ok(!raw.includes(forbidden))
})
test('quick suggestions cross-check project membership using an independent safe query and never emit the unsafe project hit',async () => {
  const result = (await run('search suggest',{ keyword: '验收' },fixture())).result
  assert.equal(result.groups.project.length,1);assert.equal(result.groups.project[0].selfId,'visible-project-task');assert.ok(!JSON.stringify(result).includes('forbidden-project-task'));assert.equal(result.groups.task[0].selfId,'9007199254740993123');assert.equal(result.previewOnly,true)
  assert.equal(result.projectVerificationWindow.sourceLimit,100)
})
test('entitlements, role permissions, simplified UI and retired brief content constrain all-type search as well as explicit categories',async () => {
  const items = [row('todo','t1'),row('kanban','1'),row('summary','2'),row('summary','3',{ corpusType: 'daily' }),row('file','4'),row('unknownFutureType','5')]
  const f = fixture({ functions: [{ funcName: 'PLAN',status: 'disable' }],permissions: { useCorpus: false },items })
  const result = (await run('search query',{ keyword: '验收' },f)).result;assert.deepEqual(result.items.map(item => item.type),['todo','file'])
  const blocked = fixture({ functions: [{ funcName: 'PLAN',status: 'update' }] });await assert.rejects(run('search query',{ keyword: '验收',type: 'project' },blocked),{ code: 'FEATURE_FORBIDDEN' });assert.ok(!blocked.calls.some(call => call.path.endsWith('/searchAll')))
  assert.deepEqual((await run('search query',{ keyword: '验收' },fixture({ simple: true,items }))).result.items.map(item => item.type),['todo','kanban'])
  assert.throws(() => prepareSearch('search-query',{ keyword: '   ' },{ user: {},functions: [],authorities: {} }),{ code: 'INVALID_INPUT' })
})
test('pagination advances by source rows, including empty filtered pages, and rejects wrong server offsets and exhausted result windows',async () => {
  const f = fixture({ items: [row('summary','1'),row('file','2')] }),result = (await run('search query',{ keyword: '验收',type: 'project',offset: 20,limit: 2 },f)).result
  assert.deepEqual(result.items,[]);assert.equal(result.hasMore,true);assert.equal(result.nextOffset,22);assert.equal(result.exhausted,false)
  const context = { functions: [],authorities: {},user: {} }
  assert.throws(() => describeSearch({ offset: 20,limit: 2 },{ ...context,page: { from: 0,size: 2,result: [] } }),{ code: 'INVALID_RESPONSE' })
  assert.throws(() => describeSearch({ offset: 9900,limit: 100 },{ ...context,page: { from: 9900,size: 100,result: Array.from({ length: 100 },(_,i) => row('todo',String(i+1))) } }),{ code: 'PAGINATION_LIMIT' })
  const off = fixture();assert.equal((await run('search query',{ keyword: '验收' },off,{ dryRun: true })).dryRun,true);assert.equal(off.calls.length,0)
  await assert.rejects(executeOperation(ctx,catalog.operations.find(op => op.route === '/task/v1/search/preSearch'),{ query: { keyword: '验收' } },session,{ transport: off.transport }),{ code: 'BUSINESS_CONTEXT_REQUIRED' })
})
