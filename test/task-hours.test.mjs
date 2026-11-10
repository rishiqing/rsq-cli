import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows,runWorkflow } from '../dist/workflows.js'
import { buildHoursMutation,verifyTaskHours } from '../dist/task-hours.js'
import { prepareTaskTemplate } from '../dist/task-template.js'
const ctx = { environment: 'production',profile: 'fixture' },session = { version: 1,method: 'password',accessToken: 'fixture',identity: { userId: '81',teamId: '7' },expiresAt: Date.now()+3600000 }
const json = data => new Response(JSON.stringify(data),{ headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  const task = { id: 'task-1',from: { projectId: 7001 } },field = { id: 7101,name: '工时',type: 8,dataType: options.dataType ?? 1,editControl: { canEditPlanHour: true,canEditRealHour: true,...options.permissions },hours: options.hours ?? [] },calls = []
  const values = () => ({ taskId: 'task-1',templateFields: [field] })
  const transport = async (url,init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; calls.push({ method: init.method,path: url.pathname,body })
    if (init.method === 'GET') {
      if (url.pathname.endsWith('/kanbanCrud')) return json({ id: 7001, coverId: options.template && init.headers.get('Plan-Type') === 'template' ? '8001' : null })
      if (url.pathname.endsWith('/v4/template')) return json({ id: '8001', name: 'template', templateKanbanId: '7001', withEdit: options.readonly !== true })
      if (url.pathname.endsWith('/task')) return json(task)
      if (url.pathname.endsWith('/department/list')) return json([{ id: 1,name: '公司',type: 'top',parentId: null,displayOrder: 0,userList: [{ id: 81 },{ id: 82 }],childList: [] }])
      return json(values())
    }
    if (options.networkFailure) throw Error('unknown outcome')
    if (!options.ignoreWrite) for (const record of body.hours) {
      if (record.remove) field.hours = field.hours.filter(item => String(item.id) !== record.id)
      else if (!record.id) field.hours.push({ id: 7201+field.hours.length,...record,creator: { id: 81 } })
    }
    return new Response(null)
  }
  return { task,field,values,calls,transport }
}
const base = { taskId: 'task-1',projectId: '7001' },add = { ...base,type: 'realHour',hours: '0.0001',startDate: '2026-01-01',endDate: '2026-01-02',description: '边界描述' }
const run = (command,input,f,options = {}) => runWorkflow(ctx,workflows.workflows.find(flow => flow.command === command),input,session,{ approved: true,transport: f.transport,...options })
test('hours inspect is available on a readonly template but writes require fresh cover editing permission', async () => {
  const f = fixture({ template: true, readonly: true })
  assert.equal((await run('task hours inspect', base, f)).result.taskId, base.taskId)
  for (const [command, input] of [['task hours add', add], ['task hours clear', base], ['task hours remove', { ...base, recordId: '7201' }]]) {
    await assert.rejects(run(command, input, f), { code: 'FORBIDDEN' })
    assert.ok(f.calls.every(call => call.method === 'GET'))
  }
})
test('hours are actual append/remove records, preserve exact decimals, and independently validate the full record payload',async () => {
  const f = fixture(),added = await run('task hours add',add,f)
  assert.equal(added.result.totals.realHour,'0.0001'); assert.equal(added.result.records[0].creatorId,'81')
  assert.deepEqual(f.calls.find(call => call.method === 'PUT').body,{ taskId: 'task-1',taskTemplateFieldId: '7101',module: 'project',siteId: '7001',hours: [{ user: { id: '81' },type: 'realHour',time: '0.0001',startDate: '2026-01-01',endDate: '2026-01-02',desc: '边界描述' }] })
  await run('task hours add',{ ...add,hours: '0.1000' },f)
  assert.equal((await run('task hours inspect',base,f)).result.totals.realHour,'0.1001')
  const removed = await run('task hours remove',{ ...base,recordId: String(added.result.records[0].id) },f)
  assert.equal(removed.result.records.length,1); assert.equal(removed.result.totals.realHour,'0.1')
  await run('task hours clear',base,f); assert.equal(f.field.hours.length,0)
})
test('UI creator, plan/actual permissions, delegation policy, date and precision restrictions apply before mutation',async () => {
  const record = { id: 7201,user: { id: 81 },creator: { id: 82 },type: 'realHour',time: '1',startDate: '2026-01-01',endDate: '2026-01-01',desc: '' }
  for (const [cmd,input,options] of [['task hours remove',{ ...base,recordId: '7201' },{ hours: [record] }],['task hours clear',base,{ hours: [record] }],['task hours add',add,{ permissions: { canEditRealHour: false } }],['task hours add',{ ...add,userId: '82' },{ dataType: 0 }],['task hours add',{ ...add,userId: '99' },{}],['task hours add',{ ...add,endDate: '2099-01-01' },{}],['task hours add',{ ...add,startDate: '2026-02-30' },{}]]) {
    const f = fixture(options); await assert.rejects(run(cmd,input,f)); assert.equal(f.calls.filter(call => call.method === 'PUT').length,0)
  }
  const f = fixture(); await run('task hours add',{ ...add,userId: '82' },f)
  assert.equal(f.field.hours[0].user.id,'82')
  await assert.rejects(run('task hours add',{ ...add,hours: '0.00001' },f),{ code: 'INVALID_INPUT' })
  await assert.rejects(run('task hours add',{ ...add,type: 'planHour' },f),{ code: 'INVALID_INPUT' })
})
test('generic field assignment uses the same hours ownership checks and never clears concurrent or foreign records wholesale',async () => {
  const f = fixture({ hours: [{ id: 7201,user: { id: 81 },creator: { id: 81 },type: 'planHour',time: '1',startDate: '2026-01-01',endDate: '2026-01-01',desc: '' }] }),results = { task: f.task,project: { id: 7001 },values: f.values() }
  const request = prepareTaskTemplate('task-context-field-set',{ ...base,fieldId: '7101',hours: [] },results,session)
  assert.deepEqual(request.body.hours,[{ id: '7201',remove: true }])
  assert.throws(() => prepareTaskTemplate('task-context-field-set',{ ...base,fieldId: '7101',value: 8 },results,session),{ code: 'INVALID_INPUT' })
  f.field.hours[0].creator.id = 82
  assert.throws(() => prepareTaskTemplate('task-context-field-set',{ ...base,fieldId: '7101',hours: [] },results,session),{ code: 'FORBIDDEN' })
  assert.throws(() => buildHoursMutation(f.field,{ hours: [{ id: 7201,time: '99' }] },results,session),{ code: 'INVALID_INPUT' })
})
test('full independent assertions detect same-count incorrect values and concurrent changes; unknown writes are never replayed',async () => {
  const f = fixture({ ignoreWrite: true }); await assert.rejects(run('task hours add',add,f),{ code: 'BUSINESS_ASSERTION_FAILED' })
  const results = {},field = fixture().field
  buildHoursMutation(field,{ hours: [{ user: { id: '81' },type: 'realHour',time: '1',startDate: '2026-01-01',endDate: '2026-01-01',desc: '正确' }] },results,session)
  results.verifiedHours = { templateFields: [{ ...field,hours: [{ id: 1,user: { id: '81' },creator: { id: 81 },type: 'realHour',time: '1',startDate: '2026-01-01',endDate: '2026-01-01',desc: '错误' }] }] }
  assert.throws(() => verifyTaskHours(base,results,'verifiedHours'),{ code: 'BUSINESS_ASSERTION_FAILED' })
  const uncertain = fixture({ networkFailure: true }); await assert.rejects(run('task hours add',add,uncertain),error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown')
  assert.equal(uncertain.calls.filter(call => call.method === 'PUT').length,1)
  const offline = { transport: async () => { throw Error('offline') } }
  assert.equal((await run('task hours add',add,offline,{ dryRun: true })).dryRun,true)
  await assert.rejects(run('task hours remove',{ ...base,recordId: '1' },offline,{ approved: false }),{ code: 'CONFIRMATION_REQUIRED' })
})
