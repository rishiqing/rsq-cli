import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), row = (id, type, resource, order) => ({ id, type, relationId: resource, contribute: 100, displayOrder: order, isDisplay: true, ...(type === 'plan' ? { plan: { id: resource } } : type === 'planModule' ? { planModule: { id: resource } } : { task: { id: resource } }) })
const flow = suffix => { const result = workflows.workflows.find(flow => flow.command === 'okr actions ' + suffix); assert.ok(result); return result }, run = (suffix, input, f, options = {}) => runWorkflow(ctx, flow(suffix), { objectiveId: '101', ...input }, session, { transport: f.transport, approved: true, ...options })
function fixture(options = {}) {
  const calls = [], actions = [row('301', 'plan', '501', 1), row('302', 'plan', '502', 2), row('303', 'todo', 'task-2', 3)], krActions = [row('401', 'plan', '501', 1)]
  const kr = { id: '201', krType: options.sub ? 'subObjective' : 'normal', keyActionList: krActions, editControl: { task: !options.noTask }, progressType: 'def' }
  const objective = { id: '101', cycle: { id: '7' }, editControl: { view: !options.noView, task: !options.noTask }, allowObjectiveAddKeyAction: !options.noKeyAction, allowObjectiveAddRelation: !options.noRelation, progressType: options.auto ? 'auto' : 'manual', keyActionList: actions, krList: [kr] }
  let reads = 0
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, q = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query: q, body })
    if (path.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', token: 'private', success: true, team: { id: options.otherTeam ? 8 : 7, name: 'fixture' } })
    if (path.endsWith('/member/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 3 : 1, userLimit: 2, vt: 'fixture', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'OKR', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'PLAN', status: options.noPlan ? 'disable' : 'enable' }, { funcName: 'PLAN_DATASHEET', status: 'enable' }, { funcName: 'TASK_TYPE', status: options.noTaskType ? 'disable' : 'enable' }])
    if (path.endsWith('/authorities/company/current')) return json({})
    if (path.endsWith('/cycle/list')) return json({ currentCycleList: [{ id: '7', isArchived: false }], futureCycleList: [], pastCycleList: [] })
    if (path === '/task/okr/objective' && method === 'GET') { if (options.drift && ++reads === 2) actions.push(row('999', 'plan', '999', 4)); return json(objective) }
    if (path.endsWith('/kanbanGroup/kanbanList')) return json({ kanbanList: options.inactiveProject ? [] : [{ id: '501', name: 'fixture 1' }, { id: '502', name: 'fixture 2' }, { id: '503', name: 'fixture 3' }], groupList: [] })
    if (path.endsWith('/kanbanCrud')) return json({ id: options.foreignProject ? '900' : q.id, coverId: options.template ? '19' : null })
    if (path.endsWith('/kanbanChildCrud/list')) return json([{ id: options.foreignModule ? '701' : '601', type: options.taskModule ? 'task' : 'datasheet', name: 'fixture', datasheetInfo: { datasheetId: 'dstFixture', viewId: 'viwFixture' } }])
    if (path.endsWith('/createTemplateList')) return json(options.noDefault ? [] : [{ id: '51', name: '任务', icon: 1, isDefault: true, isMilepost: !!options.milestone }, ...(options.duplicateDefault ? [{ id: '52', name: '另一默认任务', icon: 1, isDefault: true }] : [])])
    if (path.endsWith('/department/list')) return json([{ id: '7', name: '当前公司', type: 'top', parentId: null, displayOrder: 1, childList: [], userList: [{ id: '81', showName: '本人' }] }])
    if (path.endsWith('/api/v3/task')) return json({ id: q.id, name: '原生任务', isDisplay: !options.hiddenTask, from: options.projectTask ? { projectId: '503' } : {} })
    const isKr = path.includes('/keyResult/'), list = isKr ? krActions : actions
    if (options.timeout) throw Error('write outcome unknown')
    if ((path === '/task/okr/objective/task' || path === '/task/okr/keyResult/task') && method === 'POST') {
      const value = { ...row('300', 'task', '901', 100), task: { id: 'native-task-uuid', name: body.name, members: options.wrongMembers ? [] : body.memberIds.split(',').map(id => ({ id })), responsibilityId: body.responsibilityId } }
      if (!options.ignoreWrite) list.push(value)
      if (options.concurrentAdd) list.push(row('999', 'plan', '999', 101))
      return json(isKr ? value : list)
    }
    if (path.endsWith('/sort')) {
      const index = list.findIndex(row => row.id === body.moveId), selected = list[index], group = list.filter(item => item.type === selected.type)
      if (!options.ignoreWrite) {
        group.splice(group.indexOf(selected), 1); const at = body.behindId ? group.findIndex(row => row.id === body.behindId) : group.length; group.splice(at, 0, selected); group.forEach((row, index) => { row.displayOrder = index + 1 })
      }
      return isKr ? options.emptyKrSort ? new Response('', { status: 200 }) : json(selected) : new Response(null, { status: 204 })
    }
    if (path.endsWith('/keyAction') || path.endsWith('/relation')) {
      if (method === 'POST') {
        const target = (body.keyActionList ?? body.relationList)[0], value = row('9007199254740993123', target.type, target.relationId, 100)
        if (!options.ignoreWrite) list.push(value)
        return json(isKr ? [value] : list)
      }
      if (method === 'DELETE') { if (!options.ignoreWrite) list.splice(list.findIndex(row => row.id === q.id), 1); return new Response(null, { status: 204 }) }
      const target = list.find(row => row.id === body.id); if (!options.ignoreWrite) target.contribute = body.contribute
      return json(isKr ? target : list)
    }
    throw Error('unexpected ' + method + path)
  }
  return { calls, actions, krActions, objective, transport }
}
test('objective and normal KR action contexts remain distinct and reject sub-objective IDs', async () => {
  const f = fixture(); assert.equal((await run('inspect', {}, f)).result.items.length, 3); assert.equal((await run('inspect', { resultId: '201' }, f)).result.items[0].id, '401')
  await assert.rejects(run('unlink', { resultId: '201', actionId: '301' }, f), { code: 'INVALID_INPUT' })
  await assert.rejects(run('inspect', { resultId: '201' }, fixture({ sub: true })), { code: 'INVALID_INPUT' })
})
test('links resolve actual visible tasks, active ordinary projects and project-owned datasheet modules', async () => {
  for (const resultId of [undefined, '201']) {
    const f = fixture(); const added = await run('link project', { projectId: '503', ...(resultId && { resultId }) }, f)
    assert.equal(added.resources.actionId, '9007199254740993123'); assert.ok(added.result.items.some(row => row.relationId === '503' && row.type === 'plan'))
  }
  const task = fixture(); await run('link task', { taskId: 'task-1' }, task); assert.equal(task.calls.find(call => call.method === 'POST').body.keyActionList[0].type, 'todo')
  const projectTask = fixture({ projectTask: true }); await run('link task', { taskId: 'task-1', projectId: '503' }, projectTask); assert.equal(projectTask.calls.find(call => call.method === 'POST').body.keyActionList[0].type, 'kanbanItem')
  const module = fixture(); await run('link module', { projectId: '503', moduleId: '601' }, module); assert.ok(module.actions.some(row => row.type === 'planModule' && row.relationId === '601'))
})
test('link rejects duplicate, foreign, retired, template, non-datasheet and invisible resources before mutation', async () => {
  for (const options of [{ foreignProject: true }, { inactiveProject: true }, { template: true }, { noRelation: true }]) { const f = fixture(options); await assert.rejects(run('link project', { projectId: '503' }, f)); assert.ok(!f.calls.some(call => call.method === 'POST')) }
  for (const options of [{ foreignModule: true }, { taskModule: true }]) { const f = fixture(options); await assert.rejects(run('link module', { projectId: '503', moduleId: '601' }, f), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!f.calls.some(call => call.method === 'POST')) }
  await assert.rejects(run('link project', { projectId: '501' }, fixture()), { code: 'INVALID_INPUT' })
  await assert.rejects(run('link task', { taskId: 'task-1' }, fixture({ hiddenTask: true })), { code: 'RESOURCE_FORBIDDEN' })
})
test('explicit cancellation removes only actual relation, preserves unrelated resources and requires confirmation', async () => {
  const f = fixture(); const result = await run('unlink', { actionId: '301' }, f); assert.deepEqual(result.result.items.map(row => row.id), ['302', '303']); assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1)
  assert.ok(!f.calls.some(call => call.path.endsWith('/kanbanCrud')))
  const offline = fixture(); await assert.rejects(run('unlink', { actionId: '301' }, offline, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(offline.calls.length, 0)
})
test('contribution supports zero and decimals, follows manual/ordinary-KR display and task permissions', async () => {
  const f = fixture(); await run('contribution set', { actionId: '301', value: 0 }, f); assert.equal(f.actions[0].contribute, 0)
  await run('contribution set', { resultId: '201', actionId: '401', value: 0.29 }, f); assert.equal(f.krActions[0].contribute, 0.29)
  for (const [options, value, code] of [[{ auto: true }, 1, 'RESOURCE_FORBIDDEN'], [{ noTask: true }, 1, 'RESOURCE_FORBIDDEN'], [{}, 0.001, 'INVALID_INPUT']]) { const denied = fixture(options); await assert.rejects(run('contribution set', { actionId: '301', value }, denied), { code }); assert.ok(!denied.calls.some(call => call.method === 'PUT')) }
})
test('sorting uses behindId and allows only same resource category; full final order is read back', async () => {
  const f = fixture(); await run('move', { actionId: '302', beforeActionId: '301' }, f)
  const sent = f.calls.find(call => call.method === 'PUT').body; assert.equal(sent.behindId, '301'); assert.equal(sent.nextId, undefined)
  assert.ok(f.actions.find(row => row.id === '302').displayOrder < f.actions.find(row => row.id === '301').displayOrder)
  const denied = fixture(); await assert.rejects(run('move', { actionId: '303', beforeActionId: '301' }, denied), { code: 'INVALID_INPUT' }); assert.ok(!denied.calls.some(call => call.method === 'PUT'))
})
test('production KR sorting accepts HTTP 200 empty body only with an independent final-order assertion', async () => {
  for (const ignoreWrite of [false, true]) {
    const f = fixture({ emptyKrSort: true, ignoreWrite }); f.krActions.push(row('402', 'plan', '502', 2))
    const pending = run('move', { resultId: '201', actionId: '402', beforeActionId: '401' }, f)
    if (ignoreWrite) await assert.rejects(pending, error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.writeOutcome === 'partial')
    else assert.deepEqual((await pending).result.items.sort((a, b) => a.displayOrder - b.displayOrder).map(row => row.id), ['402', '401'])
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
  }
})
test('context drift, ignored writes and unknown network outcomes stop without automatic replay; dry-run is offline', async () => {
  const drift = fixture({ drift: true }); await assert.rejects(run('link project', { projectId: '503' }, drift), { code: 'CONTEXT_CONFLICT' }); assert.ok(!drift.calls.some(call => call.method === 'POST'))
  const ignored = fixture({ ignoreWrite: true }); await assert.rejects(run('contribution set', { actionId: '301', value: 0 }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' })
  const timeout = fixture({ timeout: true }); await assert.rejects(run('link project', { projectId: '503' }, timeout), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown'); assert.equal(timeout.calls.filter(call => call.method === 'POST').length, 1)
  const offline = fixture(); await run('link project', { projectId: '503' }, offline, { dryRun: true }); assert.equal(offline.calls.length, 0)
})
test('public access enforces company expiry, overcapacity, OKR/PLAN and auto-discovered project task rights', async () => {
  for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY'], [{ disabled: true }, 'FEATURE_DISABLED'], [{ noPlan: true }, 'FEATURE_DISABLED']]) { const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('link project'), { objectiveId: '101', projectId: '503' }, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(call => call.method === 'POST')) }
  const discovered = fixture({ projectTask: true, noPlan: true }); await assert.rejects(run('link task', { taskId: 'task-1' }, discovered), { code: 'FEATURE_DISABLED' }); assert.ok(!discovered.calls.some(call => call.method === 'POST'))
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/okr/keyResult/relation'), f = fixture()
  await assert.rejects(executeOperation(ctx, op, { body: { id: '401', contribute: 0 } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('native task context discovers current default types and company members; native creation is distinct from resource linking', async () => {
  const f = fixture({ noRelation: true }), discovered = await run('tasks context', {}, f)
  assert.equal(discovered.result.taskTemplates[0].id, '51'); assert.deepEqual(discovered.result.members, [{ id: '81', name: '本人' }])
  for (const resultId of [undefined, '201']) {
    const f = fixture({ noRelation: true }), out = await run('task create', { name: '原生任务', ...(resultId && { resultId }), responsibilityId: '81' }, f)
    assert.equal(out.resources.actionId, '300'); assert.equal(out.resources.taskId, 'native-task-uuid')
    const sent = f.calls.filter(call => call.method === 'POST'); assert.equal(sent.length, 1)
    assert.equal(sent[0].path, '/task/okr/' + (resultId ? 'keyResult' : 'objective') + '/task')
    assert.equal(sent[0].body.taskTemplateId, '51'); assert.equal(sent[0].body.memberIds, '81'); assert.equal(sent[0].body.responsibilityId, '81')
    assert.ok(f.calls.some(call => call.path === '/task/api/v3/task' && call.query.id === out.resources.taskId))
    assert.equal(out.result.items.length, resultId ? 2 : 4)
  }
})
test('native creation refuses ambiguous/missing/milestone types, foreign members and missing task-management controls', async () => {
  for (const options of [{ noDefault: true }, { duplicateDefault: true }, { milestone: true }, { noTask: true }, { noKeyAction: true }]) {
    const f = fixture(options); await assert.rejects(run('task create', { name: '原生任务' }, f)); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  }
  for (const input of [{ taskTemplateId: '999' }, { memberIds: ['999'] }, { responsibilityId: '999' }, { name: '  ' }]) {
    const f = fixture(); await assert.rejects(run('task create', { name: '原生任务', ...input }, f)); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  }
})
test('native creation detects concurrent additions and incorrect members without guessing largest ID or retrying', async () => {
  for (const options of [{ concurrentAdd: true }, { wrongMembers: true }, { ignoreWrite: true }]) {
    const f = fixture(options); await assert.rejects(run('task create', { name: '原生任务' }, f), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.writeOutcome === 'partial'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  }
  const timeout = fixture({ timeout: true }); await assert.rejects(run('task create', { name: '原生任务' }, timeout), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown'); assert.equal(timeout.calls.filter(call => call.method === 'POST').length, 1)
})
test('native task selection enforces TASK_TYPE only for explicit types; default creation and dry-run need no type entitlement', async () => {
  const denied = fixture({ noTaskType: true }); await assert.rejects(executeWorkflow(ctx, flow('task create'), { objectiveId: '101', name: '原生任务', taskTemplateId: '51' }, session, { transport: denied.transport }), { code: 'FEATURE_DISABLED' }); assert.equal(denied.calls.filter(call => call.method === 'POST').length, 0)
  const defaultType = fixture({ noTaskType: true, noPlan: true }); await executeWorkflow(ctx, flow('task create'), { objectiveId: '101', name: '原生任务' }, session, { transport: defaultType.transport }); assert.equal(defaultType.calls.filter(call => call.method === 'POST').length, 1)
  const offline = fixture(); await run('task create', { name: '原生任务' }, offline, { dryRun: true }); assert.equal(offline.calls.length, 0)
})
