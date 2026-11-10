import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { catalog } from '../dist/operations.js'
import { workflows, workflowSchema } from '../dist/workflows.js'
import { accessPlan, deadlineEpoch, validateCompanyState, validateFeatures, inspectAccess } from '../dist/access.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { origin } from '../dist/core.js'
const ctx = { environment: 'production', profile: 'test' }, session = { version: 1, method: 'password', identity: { userId: '101', teamId: '201', username: 'fixture' }, accessToken: 'private-test-token', expiresAt: Date.now() + 3600000 }
const state = { vt: 'fixture-actual-version', deadLine: '2100-01-01 00:00:00', usersCount: 10, userLimit: 10, mainApp: 'rsq' }
const op = command => catalog.operations.find(op => op.command === command)
const flow = command => workflows.workflows.find(flow => flow.command === command)
test('template operations retain the feature limits of their shared HTTP implementations', async () => {
  for (const command of ['project template deliverable context', 'project template deliverable task context', 'project template deliverable task link', 'project template deliverable task unlink', 'project template deliverable task upload']) {
    const target = flow(command)
    assert.ok(target, command)
    assert.ok(accessPlan(target).features.includes('PLAN_DELIVERABLE'), command)
    const mock = service({ functions: [{ funcName: 'PLAN', status: 'enable' }, { funcName: 'PLAN_DELIVERABLE', status: 'disable' }] })
    const input = { coverId: '1', ...(command.includes(' task ') && { taskId: 't'.repeat(32) }), ...(/ (link|unlink)$/.test(command) && { fileId: 'a'.repeat(32) }), ...(command.endsWith(' upload') && { localFile: '/not-read-before-entitlement' }) }
    await assert.rejects(executeWorkflow(ctx, target, input, session, { approved: true, transport: mock.transport }), { code: 'FEATURE_DISABLED' })
    assert.equal(mock.calls.some(call => /deliverable|kanbanCrud|template$/.test(call.path)), false)
  }
  for (const command of ['project template task field inspect', 'project template task field set']) assert.ok(accessPlan(flow(command)).features.includes('TASK_TYPE'))
  for (const command of ['project task create', 'project template task create']) {
    assert.equal(accessPlan(flow(command)).features.includes('TASK_TYPE'), false)
    assert.equal(accessPlan(flow(command), { templateId: 'type-fixture' }).features.includes('TASK_TYPE'), true)
  }
})
test('indicator feature restrictions cover imported indicator HTTP routes as well as business command names', () => {
  for (const target of [{ command: 'okr import optional-indicator', route: '/task/okr/import/optional/indicator/list', method: 'GET', effect: 'read' }, { command: 'okr import indicator', route: '/task/okr/import/indicator', method: 'POST', effect: 'write' }, flow('okr indicator context')]) assert.ok(accessPlan(target).features.includes('OKR_INDICATOR'))
})
test('current replay configuration writes require UI management permission before any business request', async () => {
  for (const command of ['replay template create', 'replay template question add', 'replay template rename', 'replay collection add', 'replay collection rename', 'replay collection remove']) {
    assert.ok(accessPlan(flow(command), {}).permissions.includes('replayManage'), command)
  }
  assert.equal(accessPlan(flow('replay report question set'), {}).permissions.includes('replayManage'), false)
  const mock = service({ functions: [{ funcName: 'REPLAY', status: 'enable' }], permissions: { replayManage: false } })
  await assert.rejects(executeWorkflow(ctx, flow('replay template create'), { name: 'must-not-create' }, session, { transport: mock.transport }), { code: 'FEATURE_FORBIDDEN' })
  assert.equal(mock.calls.some(call => call.path.startsWith('/task/review/')), false)
})
function service({ patch = {}, functions = [], permissions = {}, teamId = '201', failState = false } = {}) {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ method: init.method, path: url.pathname, search: url.search, body: init.body })
    assert.equal(new Headers(init.headers).get('token'), session.accessToken)
    let value
    if (url.pathname === '/task/login/authAjax') value = { success: true, id: '101', username: 'fixture', token: session.accessToken, team: { id: teamId, name: 'Fixture' } }
    else if (url.pathname === '/task/ordercenter/v2/member/state/independent') { if (failState) throw Error('offline'); value = { ...state, ...patch } }
    else if (url.pathname === '/task/ordercenter/v2/function/available') { assert.equal(url.searchParams.get('vt'), state.vt); value = functions }
    else if (url.pathname === '/task/authority/v3/authorities/company/current') value = permissions
    else throw Error('Unexpected business request')
    return new Response(JSON.stringify(value))
  }
  return { calls, transport }
}
test('public operation and workflow dispatch stop expired and over-capacity companies before business HTTP, including confirmed writes', async () => {
  for (const [patch, code] of [[{ deadLine: '2000-01-01 00:00:00' }, 'COMPANY_EXPIRED'], [{ usersCount: 11 }, 'COMPANY_OVER_CAPACITY']]) {
    for (const target of ['operation', 'workflow']) {
      const mock = service({ patch })
      const execution = target === 'operation' ? executeOperation(ctx, op('project select list'), {}, session, { approved: true, transport: mock.transport })
        : executeWorkflow(ctx, flow('appraisal setup'), { teamId: '201' }, session, { approved: true, transport: mock.transport })
      await assert.rejects(execution, error => error.code === code)
      assert.deepEqual(mock.calls.map(call => call.path), ['/task/login/authAjax', '/task/ordercenter/v2/member/state/independent'])
    }
  }
})
test('upgrade, disabled functions and explicit company permission denial are enforced independently of server business authorization', async () => {
  for (const [functions, permissions, code] of [[[{ funcName: 'PERFORMANCE', status: 'disable' }], {}, 'FEATURE_DISABLED'],
    [[{ funcName: 'PERFORMANCE', status: 'update' }], {}, 'FEATURE_UPGRADE_REQUIRED'], [[], { usePerformance: false }, 'FEATURE_FORBIDDEN'], [[], { usePerformance: null }, 'FEATURE_FORBIDDEN']]) {
    const mock = service({ functions, permissions })
    await assert.rejects(executeWorkflow(ctx, flow('appraisal setup'), { teamId: '201' }, session, { approved: true, transport: mock.transport }), error => error.code === code)
    assert.equal(mock.calls.length, 4)
    assert.ok(!mock.calls.some(call => call.path === '/task/v1/performance/list'))
  }
})
test('ordinary project creation and template application require company permission; raw creation requires business context', async () => {
  for (const permissions of [{ createKanban: false, useKanban: true }, { createKanban: null }, {}]) {
    for (const target of ['create', 'apply']) {
      const mock = service({ permissions })
      const execution = target === 'create' ? executeWorkflow(ctx, flow('project create'), { templateCategory: 'my', coverId: '301', name: 'Fixture', attribute: 'person' }, session, { transport: mock.transport })
        : executeWorkflow(ctx, flow('project template apply'), { coverId: '301', name: 'Fixture', attribute: 'person' }, session, { transport: mock.transport })
      await assert.rejects(execution, error => error.code === 'FEATURE_FORBIDDEN' && error.details.permission === 'createKanban')
      assert.equal(mock.calls.length, 4)
    }
  }
  const raw = service()
  await assert.rejects(executeOperation(ctx, op('project create-plan'), { body: { name: 'Fixture', templateKanbanId: '301' } }, session, { transport: raw.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.equal(raw.calls.length, 0)
  assert.deepEqual(accessPlan(flow('project template create')).permissions, ['editKanbanGroup'])
  assert.deepEqual(accessPlan(op('project create-plan'), { headers: { 'Plan-Type': 'template' } }).permissions, ['editKanbanGroup'])
  assert.deepEqual(accessPlan(flow('project template apply')).permissions, ['createKanban'])
})
test('order state is fresh per command and never reused across profile, team or failures', async () => {
  const mismatch = service({ teamId: '202' })
  await assert.rejects(executeWorkflow(ctx, flow('okr setup'), { teamId: '201' }, session, { transport: mismatch.transport }), error => error.code === 'IDENTITY_CHANGED')
  assert.equal(mismatch.calls.length, 1)
  const unavailable = service({ failState: true })
  await assert.rejects(executeWorkflow(ctx, flow('okr setup'), { teamId: '201' }, session, { transport: unavailable.transport }), error => error.code === 'NETWORK_ERROR')
  assert.equal(unavailable.calls.length, 2)
  const expired = service({ patch: { deadLine: '2000-01-01 00:00:00' } })
  for (let i = 0; i < 2; i++) await assert.rejects(executeWorkflow(ctx, flow('okr setup'), { teamId: '201' }, session, { transport: expired.transport }), error => error.code === 'COMPANY_EXPIRED')
  assert.equal(expired.calls.length, 4)
})
test('password and WeCom identities check their own service; null companies remain personal context', async () => {
  for (const method of ['password', 'wecom']) {
    for (const identity of [{ userId: '101', username: 'fixture' }, session.identity]) {
      const supplied = { ...session, method, identity }, calls = []
      const transport = async (url, init) => {
        calls.push(url.pathname)
        assert.equal(url.origin, origin('production', method === 'wecom' ? 'wecom' : 'site'))
        assert.equal(new Headers(init.headers).get('token'), supplied.accessToken)
        const payload = url.pathname === '/task/login/authAjax' ? { success: true, id: '101', username: 'fixture', token: supplied.accessToken, team: identity.teamId ? { id: identity.teamId, name: 'Fixture' } : null }
          : { ...state, deadLine: '2000-01-01 00:00:00' }
        return new Response(JSON.stringify(payload))
      }
      await assert.rejects(executeOperation(ctx, op('task get'), { query: { id: '301' } }, supplied, { transport }), error => error.code === 'COMPANY_EXPIRED')
      assert.deepEqual(calls, ['/task/login/authAjax', '/task/ordercenter/v2/member/state/independent'])
    }
  }
})
test('offline plans disclose conditional module restrictions and never fetch access context; missing confirmation also stays offline', async () => {
  let calls = 0
  const transport = async () => { calls++; throw Error('must stay offline') }
  const raw = await executeOperation(ctx, op('project add-module'), { body: { kanbanId: '301', name: 'data', type: 'datasheet' } }, null, { dryRun: true, transport })
  assert.ok(raw.access.features.includes('PLAN_DATASHEET'))
  const embedded = await executeOperation(ctx, op('project create-plan'), { body: { name: 'Fixture', openModuleList: ['task', 'workflow', 'datasheet'] }, headers: { 'Plan-Type': 'template' } }, null, { dryRun: true, transport })
  assert.ok(embedded.access.features.includes('PLAN_WORKFLOW')); assert.ok(embedded.access.features.includes('PLAN_DATASHEET'))
  const plan = await executeWorkflow(ctx, flow('appraisal setup'), { teamId: '201' }, null, { dryRun: true, transport })
  assert.ok(plan.access.features.includes('PERFORMANCE'))
  await assert.rejects(executeWorkflow(ctx, flow('organization create'), { name: 'Fixture' }, session, { transport }), error => error.code === 'CONFIRMATION_REQUIRED')
  assert.equal(calls, 0)
})
test('deadlines use Shanghai time with validation, capacity equality is allowed and -1 is unlimited', () => {
  assert.equal(deadlineEpoch('2026-11-08 00:00:00'), Date.parse('2026-11-07T16:00:00Z'))
  assert.equal(deadlineEpoch('2026-11-08T00:00:00+08:00'), Date.parse('2026-11-07T16:00:00Z'))
  validateCompanyState({ ...state, deadLine: '2026-11-08 00:00:00' }, Date.parse('2026-11-07T16:00:00Z'))
  assert.throws(() => validateCompanyState({ ...state, deadLine: '2026-11-08 00:00:00' }, Date.parse('2026-11-07T16:00:00.001Z')), error => error.code === 'COMPANY_EXPIRED')
  validateCompanyState(state); validateCompanyState({ ...state, userLimit: -1, usersCount: 1000000 })
  for (const deadLine of ['', 'invalid', '2026-02-30 00:00:00', '2026-11-08 24:00:00']) assert.throws(() => validateCompanyState({ ...state, deadLine }), error => error.code === 'ENTITLEMENT_UNAVAILABLE')
  for (const patch of [{ userLimit: null }, { userLimit: '-1' }, { usersCount: -1 }, { usersCount: 10.1 }, { userLimit: -2 }]) assert.throws(() => validateCompanyState({ ...state, ...patch }), error => error.code === 'ENTITLEMENT_UNAVAILABLE')
})
test('feature defaults match the shipped UI and malformed or contradictory truth tables never authorize writes', () => {
  validateFeatures(['PLAN'], [], {})
  assert.throws(() => validateFeatures(['PLAN_PROJECT_REPORT'], [], {}), error => error.code === 'FEATURE_DISABLED')
  validateFeatures(['PLAN_PROJECT_REPORT'], [{ funcName: 'PLAN_PROJECT_REPORT', status: 'enable' }], {})
  for (const payload of [null, [{ funcName: 'PLAN', status: null }], [{ funcName: 'PLAN', status: 'enable' }, { funcName: 'PLAN', status: 'disable' }]]) assert.throws(() => validateFeatures(['PLAN'], payload, {}), error => error.code === 'ENTITLEMENT_UNAVAILABLE')
})
test('expired companies retain safe diagnostics, which expose restrictions and never tokens or cookies', async () => {
  const mock = service({ patch: { deadLine: '2000-01-01 00:00:00' } }), output = await inspectAccess(ctx, session, mock.transport)
  assert.equal(output.available, false); assert.equal(output.restriction.code, 'COMPANY_EXPIRED')
  assert.ok(!JSON.stringify(output).includes(session.accessToken)); assert.equal(mock.calls.length, 4)
  for (const command of ['organization context', 'organization list', 'organization create', 'organization switch', 'organization update', 'organization access inspect']) assert.equal(accessPlan(flow(command)).mode, 'recovery')
})
test('runtime and Schema use identical access rules for embedded modules and business contexts', async () => {
  for (const [command, names] of [['datasheet record update', ['PLAN', 'PLAN_DATASHEET']], ['project collection list', ['PLAN', 'PLAN_COLLECTION']], ['statistics project dashboards list', ['PLAN', 'PLAN_STATISTICS']], ['deliverable file upload', ['PLAN', 'PLAN_DELIVERABLE']], ['replay report submit', ['REPLAY']]]) {
    const definition = flow(command)
    assert.ok(definition, command)
    for (const name of names) assert.ok(workflowSchema(definition).access.features.includes(name), command + ' ' + name)
  }
  const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8')
  assert.match(cli, /executeOperation as runOperation, executeWorkflow as runWorkflow/)
  assert.ok(!/import \{[^}]*\brunOperation\b[^}]*\} from '\.\/operations\.js'/.test(cli))
})
