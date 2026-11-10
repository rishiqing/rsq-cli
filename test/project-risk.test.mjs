import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { CookieJar } from 'tough-cookie'
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const flow = command => { const found = workflows.workflows.find(flow => flow.command === command); assert.ok(found, command); return found }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const target = { projectId: '7001', riskId: '7201' }
function fixture(options = {}) {
  let open = options.closed !== true, risks = [{ id: 7201, name: '原风险', kanbanChildId: options.foreignRisk ? 999 : 7101, kanbanCardId: 7301, status: 1, possible: 1, impact: 1, level: 1, cost: true, time: true, quality: false, note: { ops: [{ insert: '原方案\n' }] }, principalId: 81, principal: { id: 81 }, deadline: '2026-11-08 00:00:00', progressList: [] }], next = 7202, progressId = 7401
  const calls = [], tasks = [], users = [{ id: 81, showName: '本人' }, { id: 82, showName: '成员' }]
  const transport = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {}, q = Object.fromEntries(url.searchParams), method = init.method; calls.push({ path: url.pathname, method, body, query: q })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.foreignIdentity ? 8 : 7, name: '公司' } })
    if (url.pathname.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (url.pathname.endsWith('/function/available')) return json([{ funcName: 'PLAN_RISK', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'TASK_TYPE', status: options.taskTypeDisabled ? 'disable' : 'enable' }])
    if (url.pathname.endsWith('/company/current')) return json({ useKanban: true })
    if (url.pathname === '/task/v1/kanbanCrud') return json({ id: 7001, name: '实际项目', coverId: options.template ? 8001 : null, editControl: { createKanbanChild: options.noCreate !== true } })
    if (url.pathname === '/task/v1/kanbanChildCrud/list') return json([{ id: 7100, name: '普通任务', type: 'task' }, ...(open ? [{ id: 7101, name: '风险', type: 'risk-module', editControl: { removeKanbanChild: options.noClose !== true } }] : [])])
    if (url.pathname === '/task/v1/department/list') return json([{ id: 901, name: '公司', type: 'top', parentId: null, displayOrder: 0, childList: [], userList: users }])
    if (url.pathname === '/task/api/v3/template/settingList') return json([{ id: 7501, name: '默认任务', isDefault: !options.noDefault, isStop: false }, { id: 7502, name: '自定义任务', isDefault: false, isStop: false }, { id: 7503, name: '停用类型', isStop: true }])
    if (url.pathname === '/task/api/v3/projectTask/cardEditControl') return json({ createTask: !options.noTaskCreate, modifyTaskType: !options.noTaskType, addTaskMember: !options.noTaskMembers })
    if (url.pathname === '/task/api/v3/projectTask/taskList') return json(tasks.filter(task => task.cardId === +body.key).slice(body.offset, body.offset + body.max))
    if (url.pathname === '/task/api/v3/task' && method === 'GET') return json(tasks.find(task => task.id === q.id))
    if (url.pathname === '/task/v3/kanban/risk/matrix') return json([{ possible: 1, impact: 1, level: 1 }, { possible: 4, impact: 1, level: 1 }, { possible: 4, impact: 4, level: 3 }, ...(options.duplicateMatrix ? [{ possible: 4, impact: 4, level: options.conflictingMatrix ? 2 : 3 }] : [])])
    if (url.pathname === '/task/v3/kanban/risk/list') return json(risks.slice(0, +(q.max ?? 200)))
    const riskId = /\/risk\/(\d+)$/.exec(url.pathname)?.[1], risk = risks.find(row => row.id === +(riskId ?? body.riskId ?? q.riskId ?? q.id))
    if (method === 'GET' && riskId) {
      if (!risk && options.absenceForbidden) return json({ code: 401007, errorMessage: 'denied' }, 400)
      return risk ? json(risk) : json({ code: 401002, errorMessage: 'not found' }, 400)
    }
    if (url.pathname.endsWith('/risk/actions')) return json([])
    if (url.pathname.endsWith('/progress/current')) return json(risk.currentProgress ?? {})
    if (url.pathname.endsWith('/progress/list')) return json(risk.progressList)
    if (options.timeout && method !== 'GET') throw Error('Transport interrupted after submission')
    if (url.pathname === '/task/api/v3/task' && method === 'POST') {
      const task = { id: 'risk-task-' + (tasks.length + 1), name: body.name, cardId: +body.cardId, from: { projectId: +body.projectId, planId: +body.moduleId, cardId: +body.cardId, riskId: options.foreignTask ? 999 : 7201 }, taskTemplate: { id: +body.taskTemplateId } }
      if (!options.ignoreWrite) tasks.push(task)
      return json(task)
    }
    if (url.pathname.endsWith('/risk/open') || url.pathname.endsWith('/risk/close')) { if (!options.ignoreWrite) open = url.pathname.endsWith('/open'); return new Response(null) }
    if (url.pathname === '/task/v3/kanban/risk' && method === 'POST') {
      const created = { ...structuredClone(risks[0]), id: next++, kanbanCardId: 7302, ...body, note: JSON.parse(body.note), kanbanChildId: +body.kanbanChildId, progressList: [] }
      risks.push(created); return json(created)
    }
    if (riskId && method === 'PUT') { if (!options.ignoreWrite) { Object.assign(risk, body); if (body.note !== undefined) risk.note = JSON.parse(body.note); if (body.principalId !== undefined) { risk.principalId = body.principalId || null; risk.principal = body.principalId ? { id: body.principalId } : null } if (body.deadline !== undefined) risk.deadline = body.deadline || null } return json(risk) }
    if (riskId && method === 'DELETE') { if (!options.ignoreWrite) risks = risks.filter(row => row !== risk); return new Response(null) }
    if (url.pathname.endsWith('/risk/progress') && method === 'POST') {
      const progress = { id: progressId++, riskId: risk.id, creatorId: 81, status: body.status, note: JSON.parse(body.note) }
      if (!options.ignoreWrite) { risk.progressList.unshift(progress); risk.currentProgress = progress } return json(progress)
    }
    if (url.pathname.endsWith('/risk/progress') && method === 'DELETE') {
      if (!options.ignoreWrite) for (const row of risks) { row.progressList = row.progressList.filter(progress => progress.id !== +q.id); row.currentProgress = row.progressList[0] ?? null } return new Response(null)
    }
    throw Error('Unexpected route: ' + url.pathname)
  }
  return { transport, calls }
}
const run = (command, input, fixture, options = {}) => runWorkflow(ctx, flow(command), input, session, { transport: fixture.transport, approved: true, ...options })
const writes = f => f.calls.filter(call => call.method !== 'GET')
const taskWrites = f => f.calls.filter(call => call.method === 'POST' && call.path === '/task/api/v3/task')
test('identical production matrix duplicates resolve one level while conflicting duplicates stop before creation', async () => {
  const input = { projectId: '7001', values: { name: '矩阵重复', possible: 4, impact: 4 } }, f = fixture({ duplicateMatrix: true })
  assert.equal((await run('project risk create', input, f)).result.risk.level, 3)
  const conflict = fixture({ duplicateMatrix: true, conflictingMatrix: true }); await assert.rejects(run('project risk create', input, conflict), { code: 'INVALID_INPUT' }); assert.equal(writes(conflict).length, 0)
})
test('risk task discovery and creation use actual task 3.0 module/card/template context and independently read back every association', async () => {
  const f = fixture(), list = await run('project risk task list', { ...target, offset: 0, max: 1 }, f)
  assert.deepEqual(list.result.tasks, [])
  assert.deepEqual(f.calls.at(-1).body, { key: '7301', planId: '7101', planViewId: null, showView: 'kanban', groupType: 'card', sortType: null, filter: [], isNeedTemplateField: true, offset: 0, max: 1 })
  const created = await run('project risk task create', { ...target, name: '风险处理任务', note: '方案', memberIds: ['82'] }, f)
  assert.equal(created.resources.taskId, 'risk-task-1'); assert.equal(created.result.task.from.riskId, 7201)
  assert.deepEqual(taskWrites(f)[0].body, { name: '风险处理任务', projectId: '7001', moduleId: '7101', cardId: '7301', taskTemplateId: '7501', groupType: 'card', note: '{"ops":[{"insert":"方案\\n"}]}', memberIds: '82' })
  assert.equal(created.result.tasks[0].id, 'risk-task-1')
  assert.equal((await run('project risk task create', { ...target, name: '自定义类型任务', templateId: '7502' }, f)).result.task.taskTemplate.id, 7502)
  const query = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/api/v3/projectTask/taskList')
  assert.equal(query.effect, 'read'); assert.equal(query.idempotency, 'idempotent')
})
test('risk task permissions, default/type state, feature truth and member directory are checked before creation', async () => {
  for (const [input, options, code] of [
    [{}, { noTaskCreate: true }, 'RESOURCE_FORBIDDEN'], [{}, { noDefault: true }, 'INVALID_INPUT'],
    [{ templateId: '7502' }, { taskTypeDisabled: true }, 'FEATURE_DISABLED'], [{ templateId: '7502' }, { noTaskType: true }, 'RESOURCE_FORBIDDEN'],
    [{ templateId: '7503' }, {}, 'INVALID_INPUT'], [{ memberIds: ['999'] }, {}, 'RESOURCE_FORBIDDEN'], [{ memberIds: [] }, { noTaskMembers: true }, 'RESOURCE_FORBIDDEN'],
  ]) {
    const f = fixture(options); await assert.rejects(run('project risk task create', { ...target, name: '处理', ...input }, f), { code }); assert.equal(taskWrites(f).length, 0)
  }
  const f = fixture({ taskTypeDisabled: true }); assert.equal((await run('project risk task create', { ...target, name: '默认类型仍可使用' }, f)).result.task.taskTemplate.id, 7501)
})
test('risk task creation fails on independent foreign ownership and does not replay an unknown write', async () => {
  const wrong = fixture({ foreignTask: true }); await assert.rejects(run('project risk task create', { ...target, name: '处理' }, wrong), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(taskWrites(wrong).length, 1)
  const unknown = fixture({ timeout: true }); await assert.rejects(run('project risk task create', { ...target, name: '处理' }, unknown), error => { assert.equal(error.details.failedStep, 'createdTask'); assert.equal(error.details.writeOutcome, 'unknown'); return true }); assert.equal(taskWrites(unknown).length, 1)
})
test('risk creation and sparse updates discover actual module/matrix/principal and preserve false, clear and calendar dates', async () => {
  const f = fixture(), created = await run('project risk create', { projectId: '7001', values: { name: '新风险', possible: 4, impact: 4, cost: false, note: '处理方案', principalId: '82', deadline: '2026-11-09' } }, f)
  assert.equal(created.resources.riskId, '7202'); assert.equal(created.resources.cardId, '7302'); assert.equal(created.result.risk.level, 3)
  assert.deepEqual(writes(f)[0].body, { name: '新风险', possible: 4, impact: 4, cost: false, note: '{"ops":[{"insert":"处理方案\\n"}]}', principalId: '82', deadline: '2026.11.09', level: 3, kanbanChildId: '7101' })
  const changed = await run('project risk update', { ...target, patch: { possible: 4, cost: false, note: '', principalId: null, deadline: null, status: 2 } }, f)
  assert.equal(changed.result.risk.impact, 1); assert.equal(changed.result.risk.level, 1); assert.equal(changed.result.risk.time, true); assert.equal(changed.result.risk.cost, false); assert.deepEqual(changed.result.risk.note, {}); assert.equal(changed.result.risk.principalId, null); assert.equal(changed.result.risk.deadline, null)
})
test('risk progress uses independent detail/current readback and only removes an actually associated progress record', async () => {
  const f = fixture(), added = await run('project risk progress add', { ...target, status: 2, note: '处理进展' }, f)
  assert.equal(added.resources.progressId, '7401'); assert.equal(added.result.currentProgress.riskId, 7201)
  const list = await run('project risk progress list', { ...target, max: 1 }, f); assert.equal(list.result.progress[0].id, '7401')
  const count = writes(f).length; await assert.rejects(run('project risk progress remove', { ...target, progressId: '999' }, f), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(f).length, count)
  const removed = await run('project risk progress remove', { ...target, progressId: '7401' }, f); assert.deepEqual(removed.result.risk.progressList, []); assert.deepEqual(removed.result.currentProgress, {})
})
test('module close preserves risk data and reopen uses the same actual module', async () => {
  const f = fixture(), before = await run('project risk inspect', target, f)
  const closed = await run('project risk module close', { projectId: '7001' }, f); assert.deepEqual(closed.result.modules, [])
  const opened = await run('project risk module open', { projectId: '7001' }, f); assert.equal(opened.result.modules[0].id, '7101')
  assert.deepEqual((await run('project risk inspect', target, f)).result.risk, before.result.risk)
  const count = writes(f).length; await run('project risk module open', { projectId: '7001' }, f); assert.equal(writes(f).length, count)
  for (const [command, options] of [['project risk module open', { noCreate: true, closed: true }], ['project risk module close', { noClose: true }]]) { const blocked = fixture(options); await assert.rejects(run(command, { projectId: '7001' }, blocked), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(blocked).length, 0) }
})
test('delete requires exact independent NOT_FOUND; success receipts, permission errors and tampered resource assertions cannot pass', async () => {
  const f = fixture(), removed = await run('project risk remove', target, f); assert.equal(removed.result.absentFromIndependentDetail, true); assert.equal(removed.result.removedRiskId, '7201')
  await assert.rejects(run('project risk remove', target, fixture({ ignoreWrite: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
  await assert.rejects(run('project risk remove', target, fixture({ absenceForbidden: true })), { code: 'FORBIDDEN' })
  const tampered = structuredClone(flow('project risk remove')); tampered.steps.at(-1).input.path.id = '999'
  const untouched = fixture(); await assert.rejects(runWorkflow(ctx, tampered, target, session, { approved: true, transport: untouched.transport }), { code: 'INVALID_CONTRACT' }); assert.equal(untouched.calls.length, 0)
})
test('foreign identity/module/template, invalid date, absent matrix and foreign principals stop before writes', async () => {
  for (const [input, options] of [[{ patch: { cost: false } }, { foreignIdentity: true }], [{ patch: { cost: false } }, { foreignRisk: true }], [{ patch: { cost: false } }, { template: true }], [{ patch: { deadline: '2026-02-30' } }, {}], [{ patch: { possible: 5, impact: 5 } }, {}], [{ patch: { principalId: '999' } }, {}]]) {
    const f = fixture(options); await assert.rejects(run('project risk update', { ...target, ...input }, f), error => { assert.ok(['RESOURCE_FORBIDDEN', 'INVALID_INPUT', 'IDENTITY_CHANGED', 'CONTEXT_MISMATCH'].includes(error.code), error.code); return true }); assert.equal(writes(f).length, 0)
  }
})
test('dry-run is offline; expiration, overcapacity, disabled feature and unconfirmed destruction cannot bypass UI or raw guards', async () => {
  const f = fixture(); await run('project risk remove', target, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('project risk remove', target, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY'], [{ disabled: true }, 'FEATURE_DISABLED']]) {
    const blocked = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('project risk update'), { ...target, patch: { cost: false } }, session, { transport: blocked.transport, approved: true }), { code }); assert.equal(writes(blocked).length, 0)
  }
  const operation = catalog.operations.find(op => op.method === 'POST' && op.route === '/task/v3/kanban/risk/progress')
  await assert.rejects(executeOperation(ctx, operation, { body: { riskId: '7201', status: 1, note: '{}' } }, session, { approved: true, transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('unknown risk writes are never replayed and false acknowledgements fail actual readback', async () => {
  const f = fixture({ timeout: true }); await assert.rejects(run('project risk update', { ...target, patch: { cost: false } }, f), error => { assert.equal(error.details.failedStep, 'changed'); assert.equal(error.details.writeOutcome, 'unknown'); return true }); assert.equal(writes(f).length, 1)
  await assert.rejects(run('project risk update', { ...target, patch: { cost: false } }, fixture({ ignoreWrite: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
})
