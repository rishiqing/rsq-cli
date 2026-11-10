import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows,runWorkflow } from '../dist/workflows.js'
import { prepareEfficiency,verifyEfficiency } from '../dist/efficiency.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'
const ctx = { environment: 'production',profile: 'fixture' },session = { version: 1,method: 'password',accessToken: 'fixture',identity: { userId: '81',teamId: '7' },expiresAt: Date.now()+3600000 }
const json = value => new Response(JSON.stringify(value),{ headers: { 'content-type': 'application/json' } })
const original = { tomatoExecuteTime: 25,tomatoRestTime: 5,tomatoFinishedAlert: true,tomatoAutoNext: false,tomatoAutoRest: false }
function fixture(options = {}) {
  let settings = { ...original },count = 0;const calls = []
  return { calls,transport: async (url,init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;calls.push({ path: url.pathname,method: init.method,query: Object.fromEntries(url.searchParams),body })
    if (url.pathname.endsWith('/getTomatoSettingInfo')) return json({ ...settings,todayTomatoNum: count })
    if (url.pathname.endsWith('/userTodoSetting')) { if (options.fail) throw Error('unknown result');settings = { ...settings,...body };return json(settings) }
    if (url.pathname.endsWith('/tomato/count')) return json({ count: options.stale ? 0 : count })
    if (url.pathname.endsWith('/tomato/add') || url.pathname.endsWith('/tomato/abandon')) { if (url.pathname.endsWith('/add')) count++;return json({ id: '9007199254740993123' }) }
    if (url.pathname.endsWith('/kanbanCrud')) return json({ id: 7001 })
    if (url.pathname.endsWith('/task')) return json({ id: 'task-1',from: { projectId: options.foreign ? 7002 : 7001 } })
    throw Error('Unexpected '+url.pathname)
  } }
}
const run = (command,input,f,options = {}) => runWorkflow(ctx,workflows.workflows.find(flow => flow.command === command),input,session,{ approved: true,transport: f.transport,...options })
test('settings use the current UI values, send a sparse patch and independently preserve all other settings',async () => {
  const f = fixture(),result = (await run('efficiency settings set',{ patch: { tomatoExecuteTime: 30,tomatoAutoRest: true } },f)).result
  assert.equal(result.verified,true);assert.deepEqual(result.settings,{ ...original,tomatoExecuteTime: 30,tomatoAutoRest: true })
  assert.deepEqual(f.calls.filter(call => call.method === 'PUT').map(call => call.body),[{ tomatoExecuteTime: 30,tomatoAutoRest: true }])
  for (const patch of [{ tomatoExecuteTime: 6 },{ tomatoExecuteTime: 185 },{ tomatoRestTime: 0 },{ tomatoRestTime: 31 },{ tomatoAutoNext: null },{ ieName: 'foreign preference' }]) await assert.rejects(run('efficiency settings set',{ patch },fixture()),{ code: 'INVALID_INPUT' })
  const mismatch = { efficiencyExpected: original,verifiedSettings: { ...original,tomatoRestTime: 6 } };assert.throws(() => verifyEfficiency({},mismatch,'verifiedSettings'),{ code: 'BUSINESS_ASSERTION_FAILED' })
})
test('completion uses a visible task, keeps long receipt IDs, and counts independently; abandon reports its actual readback limit',async () => {
  const f = fixture(),completed = (await run('efficiency tomato complete',{ taskId: 'task-1',projectId: '7001' },f)).result
  assert.equal(completed.id,'9007199254740993123');assert.equal(completed.independentlyVerified,true);assert.equal(completed.completedCount,1)
  const created = f.calls.find(call => call.method === 'POST');assert.deepEqual(created.query,{ todoId: 'task-1' });assert.equal(created.body,undefined)
  const abandoned = (await run('efficiency tomato abandon',{},fixture())).result;assert.equal(abandoned.kind,'abandon');assert.equal(abandoned.independentlyVerified,false);assert.match(abandoned.limitation,/受理/)
  await assert.rejects(run('efficiency tomato complete',{ taskId: 'task-1',projectId: '7001' },fixture({ foreign: true })),{ code: 'CONTEXT_MISSING' })
  const stale = fixture({ stale: true });await assert.rejects(run('efficiency tomato complete',{},stale),{ code: 'BUSINESS_ASSERTION_FAILED' });assert.equal(stale.calls.filter(call => call.method === 'POST').length,1)
})
test('statistics forbid silently ignored filters and validate the exact returned dates and contiguous daily data',() => {
  for (const input of [{ startDate: '2026-11-01' },{ startDate: '2026-11-09',endDate: '2026-11-01' },{ startDate: '2026-02-30',endDate: '2026-03-01' },{ startDate: '2026-01-01',endDate: '2026-11-01' }]) assert.throws(() => prepareEfficiency('efficiency-productivity',input,{}),{ code: 'INVALID_INPUT' })
  assert.throws(() => prepareEfficiency('efficiency-count',{ taskId: 'task-1',date: '2026-11-01' },{ task: { id: 'task-1' } }),{ code: 'INVALID_INPUT' })
  assert.deepEqual(prepareEfficiency('efficiency-count',{ date: '2026-11-01' },{}),{ query: { date: '2026.11.01' } })
  const series = [{ date: '20261101',count: '0' },{ date: '20261102',count: '1' }],data = { startDate: '20261101',endDate: '20261102',finishedList: series,unFinishedList: series,efficiencyList: series,maxEfficiency: 1 },input = { startDate: '2026-11-01',endDate: '2026-11-02' }
  verifyEfficiency(input,{ productivity: data },'productivity')
  for (const wrong of [{ ...data,endDate: '20261103' },{ ...data,maxEfficiency: 3 },{ ...data,finishedList: [series[0],series[0]] }]) assert.throws(() => verifyEfficiency(input,{ productivity: wrong },'productivity'),{ code: 'BUSINESS_ASSERTION_FAILED' })
})
test('irreversible bookkeeping requires explicit confirmation, unknown writes are never replayed, and dry run is offline',async () => {
  const f = fixture();await assert.rejects(run('efficiency tomato complete',{},f,{ approved: false }),{ code: 'CONFIRMATION_REQUIRED' });assert.equal(f.calls.length,0)
  assert.equal((await run('efficiency settings set',{ patch: { tomatoRestTime: 6 } },f,{ dryRun: true })).dryRun,true);assert.equal(f.calls.length,0)
  const fail = fixture({ fail: true });await assert.rejects(run('efficiency settings set',{ patch: { tomatoRestTime: 6 } },fail),{ code: 'NETWORK_ERROR' });assert.equal(fail.calls.filter(call => call.method === 'PUT').length,1)
  const op = catalog.operations.find(op => op.method === 'POST' && op.route === '/task/v1/tomato/add');await assert.rejects(executeOperation(ctx,op,{},session,{ transport: f.transport,approved: true }),{ code: 'BUSINESS_CONTEXT_REQUIRED' })
})
