import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'

const ctx = { environment: 'production', profile: 'company-lifecycle-unit' }
const token = marker => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, marker })).toString('base64url') + '.signature'
const original = { version: 1, method: 'password', identity: { userId: '101', username: 'fixture-user', teamId: '201' }, accessToken: token('original'), expiresAt: Date.now() + 3600000,
  cookies: { version: 'tough-cookie@6.0.0', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, enableLooseMode: false, allowSpecialUseDomain: true, prefixSecurity: 'silent', cookies: [] } }
const flow = action => workflows.workflows.find(item => item.command === 'organization ' + action)
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const args = { teamId: '201', expectedName: 'Fixture Company' }
function fixture({ creator = true, userFrom = null, state = {}, drift, writeFailure, badReadback, saveFailure = false } = {}) {
  const calls = [], saved = [], changed = { transfer: false, remove: false }
  let identities = 0
  const company = () => ({ id: 201, name: 'Fixture Company', creator: { id: changed.transfer ? 102 : 101 }, status: { teamLevel: 'ultimate' } })
  const transport = async (url, init) => {
    calls.push({ method: init.method, route: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : undefined, headers: new Headers(init.headers) })
    const call = calls.at(-1)
    assert.ok(!String(call.headers.get('cookie')).includes('other-profile-cookie'))
    if (url.pathname === '/task/login/authAjax') {
      identities++
      const team = changed.remove ? null : company()
      if (team && drift === 'name' && identities >= 2 && !changed.transfer) team.name += ' renamed'
      if (team && drift === 'creator' && identities >= 2) team.creator.id = 102
      if (badReadback === 'role' && changed.transfer && team) team.creator.id = 101
      return json({ success: true, id: 101, username: 'fixture-user', token: token('current'), oauth: { userFrom },
        userRole: changed.remove ? null : { type: creator && !changed.transfer ? 'teamCreator' : 'teamCommon' },
        team: changed.remove && badReadback === 'personal' ? company() : team })
    }
    if (url.pathname === '/task/ordercenter/v2/member/state/independent') return json({ vt: 'vt_fixture', mainApp: 'rsq', deadLine: '2100-01-01 23:59:59', usersCount: 2, userLimit: 10, isTrial: true, ...state })
    if (url.pathname === '/task/v1/team/fetchUserSiblings') return json([
      { id: 101, name: 'fixture-user', team: changed.remove ? null : company() },
      { id: '9007199254740993', name: 'another membership', team: { id: changed.remove && badReadback === 'other-membership' ? 999 : '9007199254740995', name: 'Unchanged company' } },
    ])
    if (url.pathname === '/task/v1/department/list') return json([{ id: 301, name: 'Fixture Company', displayOrder: 0, type: 'top', parentId: null, childList: [], userList: identities >= 2 && drift === 'member' ? [{ id: 101 }] : [{ id: 101 }, { id: 102 }] }])
    if (url.pathname === '/task/v1/team/transfer' || init.method === 'DELETE' && url.pathname === '/task/v1/team') {
      if (writeFailure === 'timeout') throw Error('lost response with a private value')
      if (writeFailure === 'membership') return json({ code: 401007, message: '无法删除公司! 您的会员未到期。' }, 400)
      if (init.method === 'POST') { assert.deepEqual(call.body, { teamName: args.expectedName, userId: '102' }); changed.transfer = true }
      else { assert.deepEqual(call.query, { teamName: args.expectedName }); assert.equal(call.body, undefined); changed.remove = true }
      return new Response(null, { status: 200 })
    }
    throw Error('Unexpected route ' + url.pathname)
  }
  return { transport, calls, saved, changed, approved: true, storeSession: async (selected, session) => { if (saveFailure) throw Error('private-path disk failure'); saved.push({ ctx: selected, session }) } }
}
test('company transfer uses the current team name and discovered member, verifies both role changes and preserves other memberships', async () => {
  const service = fixture()
  const out = await runWorkflow(ctx, flow('transfer'), { ...args, userId: '102' }, original, service)
  assert.equal(out.result.creatorId, '102'); assert.equal(out.result.formerCreatorDemoted, true)
  assert.equal(out.result.otherAccountMembershipsPreserved, true)
  assert.equal(service.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(service.saved.length, 1); assert.equal(service.saved[0].session.identity.teamId, '201')
  assert.ok(!JSON.stringify(out).includes(token('current')))
})
test('company removal verifies same-user personal recovery, full account directory and the new token before saving only the selected profile', async () => {
  const service = fixture()
  const out = await runWorkflow(ctx, flow('remove'), args, original, service)
  assert.equal(out.result.companyRemoved, true); assert.equal(out.result.recoveredAs, 'same-user-personal-identity')
  assert.equal(out.result.accountDefaultExplicitlySwitched, false)
  assert.deepEqual(service.saved[0].session.identity, { userId: '101', username: 'fixture-user' })
  assert.equal(service.saved[0].ctx.profile, ctx.profile)
  assert.equal(service.calls.filter(call => call.method === 'DELETE').length, 1)
  assert.equal(original.identity.teamId, '201')
})
test('company lifecycle rejects wrong team, unconfirmed name, noncreator, self/foreign member, platform, expiry and overcapacity before company writes', async () => {
  for (const [action, input, config, session, code] of [
    ['remove', { ...args, teamId: '202' }, {}, original, 'ORGANIZATION_MISMATCH'],
    ['remove', { ...args, expectedName: 'Fixture Company ' }, {}, original, 'COMPANY_NAME_MISMATCH'],
    ['remove', args, { creator: false }, original, 'FORBIDDEN'],
    ['transfer', { ...args, userId: '101' }, {}, original, 'INVALID_INPUT'],
    ['transfer', { ...args, userId: '999' }, {}, original, 'FORBIDDEN'],
    ['remove', args, { userFrom: 'qywx' }, original, 'FORBIDDEN'],
    ['remove', args, {}, { ...original, method: 'wecom' }, 'FORBIDDEN'],
    ['remove', args, { state: { mainApp: 'wps' } }, original, 'FORBIDDEN'],
    ['remove', args, { state: { deadLine: '2000-01-01 00:00:00' } }, original, 'COMPANY_EXPIRED'],
    ['transfer', { ...args, userId: '102' }, { state: { usersCount: 11 } }, original, 'COMPANY_OVER_CAPACITY'],
  ]) {
    const service = fixture(config)
    await assert.rejects(runWorkflow(ctx, flow(action), input, session, service), { code })
    assert.ok(service.calls.every(call => call.method === 'GET')); assert.equal(service.saved.length, 0)
  }
})
test('company lifecycle diagnostics expose restrictions and actual visible member choices without granting write eligibility', async () => {
  const service = fixture({ state: { deadLine: '2000-01-01 00:00:00' } })
  const out = await runWorkflow(ctx, flow('lifecycle context'), { teamId: '201' }, original, service)
  assert.equal(out.result.canTransfer, false); assert.equal(out.result.canRemove, false)
  assert.equal(out.result.restriction.code, 'COMPANY_EXPIRED')
  assert.equal(out.result.visibleMembersAreCompleteCompanyRoster, false)
  assert.deepEqual(out.result.visibleMemberIds, ['101', '102'])
  assert.ok(!JSON.stringify(out).includes(token('current')))
})
test('company context drift stops writes and readback drift never overwrites the saved profile', async () => {
  for (const drift of ['name', 'creator', 'member']) {
    const service = fixture({ drift })
    await assert.rejects(runWorkflow(ctx, flow('transfer'), { ...args, userId: '102' }, original, service), { code: 'CONTEXT_CONFLICT' })
    assert.ok(service.calls.every(call => call.method === 'GET'))
  }
  for (const [action, badReadback] of [['transfer', 'role'], ['remove', 'personal'], ['remove', 'other-membership']]) {
    const service = fixture({ badReadback })
    await assert.rejects(runWorkflow(ctx, flow(action), { ...args, ...(action === 'transfer' && { userId: '102' }) }, original, service), error => {
      assert.ok(['VERIFICATION_FAILED', 'IDENTITY_CHANGED'].includes(error.code)); assert.equal(error.details.writeAcknowledged, true)
      return true
    })
    assert.equal(service.saved.length, 0)
    assert.equal(service.calls.filter(call => call.method !== 'GET').length, 1)
  }
})
test('company deletion preserves explicit server membership denial and unknown results without replaying or revealing private errors', async () => {
  for (const writeFailure of ['timeout', 'membership']) {
    const service = fixture({ writeFailure })
    await assert.rejects(runWorkflow(ctx, flow('remove'), args, original, service), error => {
      assert.equal(error.details.writeOutcome, writeFailure === 'timeout' ? 'unknown' : 'rejected')
      assert.equal(error.details.resources.teamId, '201'); assert.equal(error.details.localSessionUpdated, false)
      assert.equal(error.details.automaticRetry, false); assert.ok(!JSON.stringify(error).includes('private value'))
      return true
    })
    assert.equal(service.calls.filter(call => call.method === 'DELETE').length, 1); assert.equal(service.saved.length, 0)
  }
})
test('company save failure reports the already verified irreversible transition, retaining the original profile and IDs', async () => {
  const service = fixture({ saveFailure: true })
  await assert.rejects(runWorkflow(ctx, flow('remove'), args, original, service), error => {
    assert.equal(error.code, 'SESSION_STORE_FAILED'); assert.equal(error.details.writeAcknowledged, true)
    assert.equal(error.details.writeOutcome, 'check-completed-steps'); assert.equal(error.details.failedStep, 'saveSession')
    assert.ok(error.details.completedSteps.includes('after')); assert.ok(!JSON.stringify(error).includes('private-path'))
    return true
  })
  assert.equal(service.calls.filter(call => call.method === 'DELETE').length, 1)
})
test('company lifecycle commands and guarded transports share offline Schema, confirmation and validated step protocols', async () => {
  let called = false
  const opts = { dryRun: true, transport: async () => { called = true } }
  const plan = await runWorkflow(ctx, flow('remove'), args, null, opts)
  assert.equal(plan.dryRun, true); assert.equal(called, false)
  assert.equal(workflowSchema(flow('remove')).confirmation, 'required')
  await assert.rejects(runWorkflow(ctx, flow('remove'), args, original, { transport: opts.transport }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(called, false)
  const invalid = structuredClone(flow('remove')); invalid.steps[4].operationId = catalog.operations.find(op => op.method === 'PUT' && op.route === '/task/v1/team').id
  await assert.rejects(runWorkflow(ctx, invalid, args, null, opts), { code: 'INVALID_CONTRACT' })
  const remove = catalog.operations.find(op => op.method === 'DELETE' && op.route === '/task/v1/team')
  await assert.rejects(executeOperation(ctx, remove, { query: { teamName: 'Fixture Company' } }, original, { approved: true, transport: opts.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.equal(called, false)
})
