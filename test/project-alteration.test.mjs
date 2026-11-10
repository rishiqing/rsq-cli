import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow, validateWorkflowWait } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), envelope = value => json({ code: 200, data: value })
const flow = suffix => { const result = workflows.workflows.find(f => f.command === 'project alteration ' + suffix); assert.ok(result, suffix); return result }
const target = { projectId: '101' }
function fixture(options = {}) {
  const calls = [], config = { id: 301, manualApplicationList: [], configList: [] }, apps = [{ id: 401, name: '范围变更' }, { id: 402, name: '时间变更' }]
  let open = options.closed !== true, next = 501, createdFlow, process
  const modules = () => [{ id: 200, name: '任务', type: 'task' }, ...(open ? [{ id: 201, name: '变更', type: 'alteration' }] : []), ...(createdFlow ? [createdFlow] : [])]
  const memberRows = ids => ids ? ids.split(',').map(id => ({ id: Number(id), showName: '成员' })) : []
  const transport = async (url, init) => {
    const q = Object.fromEntries(url.searchParams), method = init.method, body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method, body, query: q })
    if (url.pathname.endsWith('/authAjax')) return json({ id: 81, token: 'fixture', username: 'fixture', success: true, team: { id: options.foreignIdentity ? 8 : 7, name: '公司' } })
    if (url.pathname.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (url.pathname.endsWith('/function/available')) return json([{ funcName: 'PLAN_ALTERATION', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'PLAN_WORKFLOW', status: 'enable' }])
    if (url.pathname.endsWith('/company/current')) return json({ useKanban: true })
    if (url.pathname === '/task/v1/kanbanCrud') return json({ id: 101, coverId: options.template ? 901 : null, editControl: { createKanbanChild: options.noCreate !== true } })
    if (url.pathname === '/task/v1/kanbanChildCrud/list') return json(modules())
    if (url.pathname === '/task/v1/kanbanChildCrud' && method === 'GET') return json(q.id === '202' ? createdFlow : { id: options.foreignModule ? 999 : 201, name: '变更', type: 'alteration', editControl: { configAlterationModule: options.noConfig !== true, manualStartAlteration: options.noStart !== true, removeKanbanChild: true } })
    if (url.pathname === '/task/v1/kanbanChildCrud' || url.pathname === '/task/v4/kanbanChild/copy') {
      createdFlow = { id: 202, name: body.name, type: 'workflow', flowApplicationId: 403 }
      if (!options.unrecognizedCreatedFlow) apps.push({ id: 403, name: body.name })
      return json(url.pathname.endsWith('/copy') ? { type: 'ws' } : createdFlow)
    }
    if (url.pathname.endsWith('/alteration/open')) { open = true; return new Response(null) }
    if (url.pathname.endsWith('/alteration/close')) { open = false; return new Response(null) }
    if (url.pathname === '/task/v1/department/list') return json([{ id: 7, name: '公司', type: 'top', parentId: null, displayOrder: 1, userList: [{ id: 81, showName: '本人' }, { id: 82, showName: '成员' }], childList: [] }])
    if (url.pathname === '/task/v4/template/alterationWorkflowList') return json([{ projectId: 901, projectName: '系统模板', moduleId: 902, moduleName: '模板变更' }])
    if (url.pathname.endsWith('/flowApplicationList')) return envelope(apps)
    if (url.pathname.endsWith('/config/list')) {
      if (options.changedDuringCreate && config.configList.length === 1) config.configList.push({ id: 599, type: 'task', isEffect: false, userList: [{ id: 81 }] })
      return envelope(config)
    }
    if (url.pathname.endsWith('/config/manual')) {
      config.manualApplicationList = options.failedManualReadback ? [{ id: 402, name: '错误应用' }] : body.flowApplicationIds.split(',').filter(Boolean).map(id => structuredClone(apps.find(app => String(app.id) === id)))
      return envelope(null)
    }
    if (url.pathname.endsWith('/alteration/config')) {
      if (method === 'POST') {
        if (options.unknownCreate) throw new Error('connection lost after request')
        const row = { id: next++, flowApplicationId: body.flowApplicationId, type: body.type, isEffect: true, userList: [] }
        config.configList.push(row); return envelope(row)
      }
      if (method === 'DELETE') {
        config.configList = options.deleteEverything ? [] : config.configList.filter(row => String(row.id) !== q.alterationConfigId)
        return envelope(null)
      }
      const row = config.configList.find(row => String(row.id) === String(body.alterationConfigId))
      if (Object.hasOwn(body, 'userIds')) row.userList = memberRows(body.userIds)
      if (Object.hasOwn(body, 'isEffect')) row.isEffect = body.isEffect
      if (Object.hasOwn(body, 'flowApplicationId')) row.flowApplicationId = body.flowApplicationId
      return envelope(row)
    }
    if (url.pathname.endsWith('/header/selectedList')) return envelope(['name', 'alterationFlowApplication', 'status', 'userName', 'startTime', '40', '41'].map(id => ({ id, name: id, selected: true })))
    if (url.pathname.endsWith('/alteration/table/view')) return envelope({ total: 1, list: process ? [{ id: process.id, name: process.name }] : [] })
    if (url.pathname === '/task/workflow/application') return envelope({ id: Number(q.id), name: '范围变更', editControl: { initProcess: options.noInit !== true } })
    if (url.pathname.endsWith('/process/info/start')) { process = { id: 601, flowAppId: body.applicationId, name: body.name, status: 'doing', processInfoStepList: [] }; return envelope(process) }
    if (url.pathname.endsWith('/process/info/details')) return envelope({ ...process, name: options.failedInstanceReadback ? '错误实例' : process.name })
    throw new Error('Unexpected project alteration HTTP: ' + method + ' ' + url.pathname)
  }
  return { transport, calls, config, apps }
}
const run = (suffix, input, f, options = {}) => runWorkflow(ctx, flow(suffix), { ...target, ...input }, session, { transport: f.transport, ...options }).catch(error => { if (process.env.RSQ_FIXTURE_DEBUG) console.error(JSON.stringify(error.details)); throw error })
const mutations = f => f.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method) && !call.path.endsWith('/table/view'))

test('alteration context verifies exact project/module identity and preserves empty manual meaning', async () => {
  const current = await run('context inspect', {}, fixture())
  assert.equal(current.result.moduleId, '201'); assert.equal(current.result.manualSelection, 'all-current-alteration-applications')
  const absent = await run('context inspect', {}, fixture({ closed: true })); assert.equal(absent.result.moduleId, undefined)
  await assert.rejects(run('configuration inspect', {}, fixture({ template: true })), { code: 'FORBIDDEN' })
  const foreign = fixture({ foreignModule: true }); await assert.rejects(run('configuration inspect', {}, foreign), { code: 'FORBIDDEN' }); assert.ok(!foreign.calls.some(call => call.path.endsWith('/config/list')))
})
test('alteration module open is idempotent locally, permissions are stricter than backend view-only checks', async () => {
  const f = fixture({ closed: true }); assert.equal((await run('module open', {}, f)).result.modules.filter(row => row.type === 'alteration').length, 1)
  await run('module open', {}, f); assert.equal(mutations(f).length, 1)
  await assert.rejects(run('module open', {}, fixture({ closed: true, noCreate: true })), { code: 'FORBIDDEN' })
  const closed = fixture(); await assert.rejects(run('module close', {}, closed), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(closed.calls.length, 0)
  assert.equal((await run('module close', {}, closed, { approved: true })).result.modules.length, 1)
})
test('manual application configuration supports explicit selection and empty fallback, verifies real HTTP result', async () => {
  const f = fixture()
  assert.deepEqual((await run('configuration manual set', { applicationIds: ['401'] }, f, { approved: true })).result.configuration.manualApplicationList.map(row => row.id), [401])
  assert.equal((await run('configuration manual set', { applicationIds: [] }, f, { approved: true })).result.manualSelection, 'all-current-alteration-applications')
  assert.equal(mutations(f).at(-1).body.flowApplicationIds, '')
  await assert.rejects(run('configuration manual set', { applicationIds: ['999'] }, f, { approved: true }), { code: 'FORBIDDEN' })
  await assert.rejects(run('configuration manual set', { applicationIds: ['401'] }, fixture({ failedManualReadback: true }), { approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('task configuration creates exact current application then explicit members, with independent membership readback', async () => {
  const f = fixture(), result = await run('configuration task create', { applicationId: '401', memberIds: ['81'] }, f, { approved: true })
  assert.equal(result.resources.configId, '501'); assert.deepEqual(result.result.configuration.configList[0].userList.map(row => row.id), [81])
  const writes = mutations(f); assert.deepEqual(writes[0].body, { alterationId: 301, type: 'task', flowApplicationId: 401 }); assert.equal(writes[1].body.userIds, '81')
  assert.ok(f.calls.findIndex(call => call.path.endsWith('/config/list') && f.calls.indexOf(call) > f.calls.indexOf(writes[0])) < f.calls.indexOf(writes[1]))
})
test('task configuration preserves false, empty member CSV and untouched application', async () => {
  const f = fixture(); await run('configuration task create', { applicationId: '401', memberIds: ['81'] }, f, { approved: true })
  const result = await run('configuration task update', { configId: '501', patch: { enabled: false, memberIds: [] } }, f, { approved: true })
  assert.equal(result.result.configuration.configList[0].isEffect, false); assert.deepEqual(result.result.configuration.configList[0].userList, [])
  assert.deepEqual(mutations(f).at(-1).body, { alterationConfigId: 501, isEffect: false, userIds: '' })
})
test('cross-project config IDs, foreign members and members occupied by disabled configs are blocked before writes', async () => {
  const f = fixture(); f.config.configList.push({ id: 501, type: 'task', isEffect: false, flowApplicationId: 401, userList: [{ id: 81 }] })
  for (const [suffix, input] of [['configuration task update', { configId: '999', patch: { enabled: false } }], ['configuration task create', { applicationId: '401', memberIds: ['999'] }]]) await assert.rejects(run(suffix, input, f, { approved: true }), { code: 'FORBIDDEN' })
  await assert.rejects(run('configuration task create', { applicationId: '401', memberIds: ['81'] }, f, { approved: true }), { code: 'INVALID_INPUT' })
  assert.equal(mutations(f).length, 0)
})
test('a concurrent member conflict after config creation reports the assigned ID and never repeats or rolls back', async () => {
  const f = fixture({ changedDuringCreate: true })
  await assert.rejects(run('configuration task create', { applicationId: '401', memberIds: ['81'] }, f, { approved: true }), error => { assert.equal(error.code, 'INVALID_INPUT'); assert.equal(error.details.resources.configId, '501'); assert.ok(error.details.completedSteps.includes('created')); return true })
  assert.equal(mutations(f).length, 1)
})
test('config deletion verifies the entire remaining ID set rather than only the target absence', async () => {
  for (const deleteEverything of [false, true]) {
    const f = fixture({ deleteEverything }); f.config.configList.push(...[501, 502].map(id => ({ id, type: 'task', isEffect: true, userList: [] })))
    if (deleteEverything) await assert.rejects(run('configuration task remove', { configId: '501' }, f, { approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' })
    else assert.deepEqual((await run('configuration task remove', { configId: '501' }, f, { approved: true })).result.configuration.configList.map(row => row.id), [502])
  }
})
test('new alteration flow uses the exact current module subtype and proves actual application recognition', async () => {
  const f = fixture(), result = await run('flow create', { name: '变更审批' }, f)
  assert.equal(result.result.applicationId, '403'); assert.equal(result.resources.flowModuleId, '202')
  assert.deepEqual(mutations(f)[0].body, { kanbanId: '101', name: '变更审批', type: 'workflow', mode: 'general', workflowModuleSubType: 'alterationWorkflow' })
  await assert.rejects(run('flow create', { name: '变更审批' }, fixture({ unrecognizedCreatedFlow: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('alteration template copying uses only a discovered module ID, never an ordinary application ID', async () => {
  const f = fixture(), result = await run('flow copy-template', { name: '套用变更', templateModuleId: '902' }, f)
  assert.equal(result.result.applicationId, '403'); assert.equal(mutations(f)[0].path, '/task/v4/kanbanChild/copy'); assert.equal(mutations(f)[0].body.id, '902')
  const wrong = fixture(); await assert.rejects(run('flow copy-template', { name: '错误来源', templateModuleId: '401' }, wrong), { code: 'FORBIDDEN' }); assert.equal(mutations(wrong).length, 0)
})
test('project alteration list keeps service total distinct from true total and sends exact page/sort/filter', async () => {
  const f = fixture(), result = await run('instances list', { page: 2, pageSize: 1, sortKey: 'startTime', sortValue: 'desc', filter: [] }, f)
  assert.equal(result.result.total, null); assert.equal(result.result.serviceTotal, 1); assert.equal(result.result.requestedPage, 2); assert.equal(result.result.nextPage, null)
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/table/view')).body, { projectId: '101', pageNum: 2, pageSize: 1, sortKey: 'startTime', sortValue: 'desc', filter: [] })
  await assert.rejects(run('instances list', { sortKey: 'startTime' }, fixture()), { code: 'INVALID_INPUT' })
})
test('manual alteration launch uses configured discovery, actual start permission and independent project/instance readbacks', async () => {
  const f = fixture(), result = await run('instance start', { applicationId: '401', name: '项目范围调整' }, f, { approved: true })
  assert.equal(result.resources.processId, '601'); assert.equal(result.result.instance.flowAppId, '401')
  assert.deepEqual(mutations(f)[0].body, { applicationId: '401', name: '项目范围调整', alterationProjectId: '101' })
  for (const options of [{ noStart: true }, { noInit: true }]) {
    const denied = fixture(options); await assert.rejects(run('instance start', { applicationId: '401', name: '禁止发起' }, denied, { approved: true }), { code: 'FORBIDDEN' }); assert.equal(mutations(denied).length, 0)
  }
  await assert.rejects(run('instance start', { applicationId: '401', name: '核对实例' }, fixture({ failedInstanceReadback: true }), { approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('unknown configuration writes are not retried, and dry-run is completely offline', async () => {
  const f = fixture({ unknownCreate: true })
  await assert.rejects(run('configuration task create', { applicationId: '401', memberIds: ['81'] }, f, { approved: true }), error => { assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.failedStep, 'created'); return true })
  assert.equal(mutations(f).length, 1)
  const dry = fixture(); await run('configuration task create', { applicationId: '401', memberIds: ['81'] }, dry, { dryRun: true }); assert.equal(dry.calls.length, 0)
})
test('public dispatcher blocks expired/over-capacity/disabled companies and bypassing raw alteration mutations', async () => {
  for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY'], [{ disabled: true }, 'FEATURE_DISABLED']]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('module open'), target, session, { transport: f.transport }), { code }); assert.equal(mutations(f).length, 0)
  }
  const f = fixture(), op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/workflow/alteration/config')
  await assert.rejects(executeOperation(ctx, op, { body: { alterationConfigId: '501', isEffect: false } }, session, { transport: f.transport, approved: true }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('manual current-UI resolution exposes the missing PUT while task field GET is correctly classified as writing', () => {
  const update = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/workflow/alteration/processInfo/taskField')
  assert.equal(update.review, 'reviewed'); assert.equal(update.inputSchema.properties.body.properties.newValue.type.includes('object'), true)
  const read = catalog.operations.find(op => op.method === 'GET' && op.route === '/task/workflow/alteration/processInfo/taskFieldList')
  assert.equal(read.effect, 'write'); assert.equal(read.idempotency, 'non-idempotent')
})
test('asynchronous alteration creation has one bounded discovery delay, never repeated writes or an arbitrary sleep contract', async () => {
  const original = flow('flow copy-template'), index = original.steps.findIndex(step => step.id === 'verifiedModules')
  validateWorkflowWait(original, index)
  for (const change of [
    candidate => { candidate.command = 'project alteration instances list' },
    candidate => { candidate.steps[index].waitBeforeMs = 6000 },
    candidate => { candidate.steps[index].readback = { attempts: 2, delayMs: 1 } },
    candidate => { candidate.steps[index - 1].operationId = candidate.steps[0].operationId },
  ]) {
    const candidate = structuredClone(original); change(candidate)
    assert.throws(() => validateWorkflowWait(candidate, index), { code: 'INVALID_CONTRACT' })
  }
  const f = fixture(), output = await run('flow copy-template', { name: '离线复制', templateModuleId: '902' }, f, { dryRun: true })
  assert.equal(f.calls.length, 0)
  assert.equal(output.steps.find(step => step.id === 'verifiedModules').waitBeforeMs, 5000)
})
