import test from 'node:test'
import assert from 'node:assert/strict'
import { context } from '../dist/core.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { validateReplaySettings, validateNewReplayCollection, validateReplayCollectionConfigWorkflow } from '../dist/replay-collection-config.js'
const ctx = context('production', 'fixture'), session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, identity: { userId: '81', teamId: '7', username: 'fixture' } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = suffix => workflows.workflows.find(flow => flow.command === 'replay collection ' + suffix)
const run = async (suffix, input, fixture, options = {}) => { try { return await executeWorkflow(ctx, flow(suffix), { collectionId: '7001', ...input }, session, { transport: fixture.transport, approved: true, ...options }) } catch (error) { error.message += ' ' + JSON.stringify(error.details); throw error } }
const tree = [{ id: '7', parentId: null, name: 'company', type: 'top', displayOrder: 1, userList: [{ id: '81', showName: 'Me' }, { id: '82', showName: 'Second' }], leaderList: [], childList: [{ id: '12', parentId: '7', type: 'common', displayOrder: 1, name: 'Dept', userList: [], leaderList: [], childList: [] }] }]
const initialRule = (id = '9001') => ({ id, writerUserList: [{ id: '81' }], writerDeptList: [], writerWhiterList: [], auditorType: 'user', auditorList: [{ id: '81' }], auditType: 'all', viewerUserList: [], viewerDeptList: [] })
const flags = { isSkipHoliday: false, isOpenWriteEarliestTime: false, isOpenCommitDeadline: false, isOpenCommitNotifyTime: false, isOpenWorkStatus: false, isAllowAddViewer: false, isAllowShare: false, isAllowAfterCommitRevert: true, isAllowAfterRefuseCommit: true, isAllowSupplement: true }
const times = { writeEarliestTime: { dateType: 'now', date: '1', time: '09:00' }, commitDeadline: { dateType: 'now', date: '5', time: '18:30' }, commitNotifyTime: { dateType: 'now', date: '5', time: '18:00' } }
function fixture(options = {}) {
  const calls = [], writes = [], state = { ruleSequence: 9003, permissionReads: 0, collectionReads: 0, directoryReads: 0, collection: { id: '7001', name: 'own', type: options.type ?? 'week', template: { id: '8001' }, writeWeekDays: null, ...flags, ...structuredClone(times), ruleList: [initialRule(), initialRule('9002')] } }
  const directory = structuredClone(tree); if (options.longMember) directory[0].userList[1].id = '9007199254740993'
  if (state.collection.type !== 'day') state.collection.isSkipHoliday = null
  if (options.numericMembers) for (const user of directory[0].userList) user.id = Number(user.id)
  if (state.collection.type === 'day') { state.collection.writeWeekDays = [1, 2, 3, 4, 5]; for (const name of Object.keys(times)) state.collection[name].date = null }
  if (state.collection.type === 'month') { state.collection.commitDeadline.date = 'last'; state.collection.commitNotifyTime.date = 'last2' }
  const wires = { writerUserIdList: 'writerUserList', writerDeptIdList: 'writerDeptList', writerWhiterUserIdList: 'writerWhiterList', viewerUserIdList: 'viewerUserList', viewerDeptIdList: 'viewerDeptList', auditorIdList: 'auditorList' }
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method, query, body })
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.foreignIdentity ? 8 : 7, name: 'company' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'REPLAY', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) { state.permissionReads++; return json({ replayManage: !options.denied && !(options.permissionDrift && state.permissionReads > 2) }) }
    if (path === '/task/v1/department/list') { state.directoryReads++; return json(options.memberRemoved && state.directoryReads > 1 ? [] : directory) }
    if (path === '/task/review/replay/config/collect/list') return json(options.foreignCollection ? [] : [{ id: '7001', type: state.collection.type }, { id: '0', type: 'topic' }])
    if (path === '/task/review/replay/collect/member/list') { assert.equal(query.replayCollectId, '7001'); return json({ userList: options.noWriters ? [] : [{ id: '81' }], deptList: [], groupList: [] }) }
    if (path === '/task/review/replay/collect') {
      if (method === 'GET') { state.collectionReads++; if (options.contextDrift && state.collectionReads > 1) state.collection.name = 'concurrently-renamed'; return json(state.collection) }
      assert.equal(method, 'PUT'); assert.equal(body.id, '7001'); writes.push(calls.at(-1))
      for (const [name, value] of Object.entries(body)) if (name !== 'id' && !options.ignoreWrite) state.collection[name === 'writeWeekDayList' ? 'writeWeekDays' : name] = value
      if (options.touchRule) state.collection.ruleList[1].writerUserList = []
      if (options.network) throw Error('uncertain setting write')
      return json(state.collection)
    }
    if (path === '/task/review/replay/collect/member/rule') {
      writes.push(calls.at(-1))
      if (method === 'DELETE') { state.collection.ruleList = state.collection.ruleList.filter(rule => rule.id !== query.id); return new Response('', { status: 200 }) }
      assert.equal(method, 'PUT'); assert.equal(body.replayCollectId, '7001')
      const row = body.ruleId ? state.collection.ruleList.find(rule => rule.id === body.ruleId) : { ...initialRule(String(state.ruleSequence++)), writerUserList: [], auditType: 'anyOne' }
      assert.ok(row)
      for (const [name, field] of Object.entries(wires)) if (Object.hasOwn(body, name)) row[field] = body[name].map(id => ({ id }))
      for (const name of ['auditType', 'auditorType']) if (Object.hasOwn(body, name)) row[name] = body[name]
      if (!body.ruleId) state.collection.ruleList.unshift(row)
      if (options.reorderOther) state.collection.ruleList = [...state.collection.ruleList].reverse()
      if (options.ignoreWrite) row.viewerUserList = []
      if (options.network) throw Error('uncertain rule write')
      return json(row)
    }
    throw Error('Unexpected replay config request ' + method + path)
  }
  return { calls, writes, state, transport }
}
test('replay configuration discovers normalized rules, current directory, dynamic types and effective writers', async () => {
  const f = fixture(), result = await run('configuration', {}, f)
  assert.equal(result.result.collection.rules.length, 2); assert.deepEqual(result.result.effectiveWriterIds, ['81']); assert.equal(result.result.members.departments.length, 2); assert.match(result.result.contextVersion, /^[a-f0-9]{64}$/); assert.equal(f.writes.length, 0)
  const daily = await run('configuration', {}, fixture({ type: 'day' })); assert.equal(daily.result.collection.settings.writeEarliestTime.date, '1')
  const numeric = await run('configuration', {}, fixture({ numericMembers: true })); assert.ok(numeric.result.members.users.every(row => typeof row.id === 'string'))
})
test('replay settings sparse write preserves every other rule, template and option and correctly persists false/empty intent', async () => {
  const f = fixture(), initial = await run('configuration', {}, f), patch = { isAllowShare: true, isAllowAfterCommitRevert: false, isOpenWriteEarliestTime: true, isOpenCommitDeadline: true, commitDeadline: { dateType: 'next', date: '1', time: '09:30' } }
  const result = await run('settings set', { patch, expectedContextVersion: initial.result.contextVersion }, f)
  assert.equal(result.result.verified, true); assert.deepEqual(result.result.collection.rules, initial.result.collection.rules); assert.deepEqual(f.writes[0].body, { id: '7001', ...patch }); assert.equal(result.result.collection.templateId, '8001')
  const noOp = await run('settings set', { patch }, f); assert.equal(noOp.result.changed, false); assert.equal(f.writes.length, 1)
})
test('replay rule create/update/delete keeps separate IDs, explicit clearing, ordered reviewers and other rule precedence', async () => {
  const f = fixture(), before = await run('configuration', {}, f)
  const created = await run('rule add', { rule: { writerUserIds: ['81'], writerDepartmentIds: ['12'], excludedWriterUserIds: ['82'], auditorType: 'user', auditorUserIds: ['82', '81'], auditType: 'oneByOne', viewerUserIds: ['81'] } }, f)
  assert.equal(created.result.verified, true); assert.equal(created.result.ruleId, '9003'); assert.deepEqual(created.result.collection.rules.slice(1), before.result.collection.rules)
  const updated = await run('rule update', { ruleId: '9003', patch: { viewerUserIds: [], excludedWriterUserIds: [], auditType: 'anyOne' } }, f)
  assert.equal(updated.result.verified, true); assert.deepEqual(updated.result.collection.rules[0].auditorUserIds, ['82', '81']); assert.deepEqual(updated.result.collection.rules[0].viewerUserIds, []); assert.deepEqual(f.writes.at(-1).body.auditorIdList, ['82', '81']); assert.equal(f.writes.at(-1).body.auditorType, 'user')
  const dynamic = await run('rule update', { ruleId: '9003', patch: { auditorType: 'writerChoose', auditorUserIds: [] } }, f); assert.equal(dynamic.result.collection.rules[0].auditorType, 'writerChoose'); assert.deepEqual(dynamic.result.collection.rules[0].auditorUserIds, [])
  const removed = await run('rule remove', { ruleId: '9003' }, f); assert.deepEqual(removed.result.collection.rules, before.result.collection.rules); assert.equal(f.writes.length, 4)
})
test('replay settings validate UI calendars, month endings, half-hour choices and dependent time constraints in Beijing', () => {
  const valid = { ...flags, ...structuredClone(times), writeWeekDayList: [1], isOpenWriteEarliestTime: true, isOpenCommitDeadline: true }, now = Date.parse('2028-02-29T16:30:00Z')
  validateReplaySettings('week', valid, now)
  validateReplaySettings('month', { ...valid, writeWeekDayList: null, commitDeadline: { dateType: 'next', date: 'last3', time: '09:30' }, commitNotifyTime: { dateType: 'now', date: 'last2', time: '18:00' } }, now)
  for (const patch of [{ writeWeekDayList: [] }, { writeWeekDayList: [1, 1] }, { writeWeekDayList: [8] }, { commitDeadline: { dateType: 'now', date: '1', time: '09:00' } }, { commitDeadline: { dateType: 'now', date: '1', time: '09:15' } }, { commitDeadline: { dateType: 'yesterday', date: '1', time: '10:00' } }]) assert.throws(() => validateReplaySettings('week', { ...valid, ...patch }, now), { code: 'INVALID_INPUT' })
  assert.throws(() => validateReplaySettings('month', { ...valid, commitDeadline: { dateType: 'now', date: '31', time: '18:00' } }, now), { code: 'INVALID_INPUT' })
  assert.throws(() => validateReplaySettings('day', { ...valid, commitDeadline: { dateType: 'now', date: '1', time: '18:00' }, commitNotifyTime: { dateType: 'now', date: '1', time: '08:30' }, isOpenCommitNotifyTime: true }, now), { code: 'INVALID_INPUT' })
})
test('replay fixed-reviewer order and long IDs remain exact through current HTTP request and response contracts', async () => {
  const f = fixture({ longMember: true }), result = await run('rule add', { rule: { writerUserIds: ['81'], auditorType: 'user', auditorUserIds: ['9007199254740993', '81'], auditType: 'oneByOne' } }, f)
  assert.equal(result.result.verified, true); assert.deepEqual(f.writes[0].body.auditorIdList, ['9007199254740993', '81']); assert.deepEqual(result.result.collection.rules[0].auditorUserIds, ['9007199254740993', '81'])
})
test('replay permissions, subscription, scope, stale context, missing members and wrong rule ownership stop before writes', async () => {
  for (const options of [{ denied: true }, { expired: true }, { over: true }, { disabled: true }, { foreignIdentity: true }, { foreignCollection: true }, { permissionDrift: true }, { contextDrift: true }]) { const f = fixture(options); await assert.rejects(run('settings set', { patch: { isAllowShare: true } }, f)); assert.equal(f.writes.length, 0) }
  for (const args of [{ ruleId: '9999', patch: { viewerUserIds: [] } }, { ruleId: '9001', patch: { viewerUserIds: ['9999'] } }, { ruleId: '9001', patch: { auditorType: 'writerLeader' } }]) { const f = fixture(); await assert.rejects(run('rule update', args, f), { code: 'INVALID_INPUT' }); assert.equal(f.writes.length, 0) }
  const f = fixture(); await assert.rejects(run('settings set', { patch: { isAllowShare: true }, expectedContextVersion: '0'.repeat(64) }, f), { code: 'CONTEXT_CONFLICT' }); assert.equal(f.writes.length, 0)
  const fresh = fixture({ memberRemoved: true }); await assert.rejects(run('rule update', { ruleId: '9001', patch: { viewerUserIds: ['82'] } }, fresh), { code: 'INVALID_INPUT' }); assert.equal(fresh.writes.length, 0)
  const weekly = fixture(); await assert.rejects(run('settings set', { patch: { writeWeekDayList: [1] } }, weekly), { code: 'INVALID_INPUT' }); assert.equal(weekly.writes.length, 0)
  await assert.rejects(run('settings set', { patch: { isSkipHoliday: true } }, weekly), { code: 'INVALID_INPUT' }); assert.equal(weekly.writes.length, 0)
})
test('replay ignored writes or unrelated rule reordering cannot pass independent business readback', async () => {
  for (const options of [{ ignoreWrite: true }, { touchRule: true }]) { const f = fixture(options); await assert.rejects(run('settings set', { patch: { isAllowShare: true } }, f), { code: 'VERIFICATION_FAILED' }); assert.equal(f.writes.length, 1) }
  const f = fixture({ reorderOther: true }); await assert.rejects(run('rule add', { rule: { writerUserIds: ['81'], auditorType: 'user', auditorUserIds: ['81'] } }, f), { code: 'VERIFICATION_FAILED' }); assert.equal(f.writes.length, 1)
})
test('replay uncertain writes are not replayed and report the resource and failed step', async () => {
  const f = fixture({ network: true }); await assert.rejects(run('rule update', { ruleId: '9001', patch: { viewerUserIds: ['82'] } }, f), error => error.details.writeOutcomeUnknown === true && error.details.automaticRetry === false && error.details.resources.collectionId === '7001'); assert.equal(f.writes.length, 1)
})
test('existing replay collection creation obeys visible-directory and UI time constraints too', () => {
  const body = { type: 'week', ...flags, ...times, writeWeekDayList: [1], ruleList: [{ writerUserIdList: ['81'], auditorType: 'user', auditorId: '81', auditType: 'all' }] }
  validateNewReplayCollection(body, tree)
  assert.throws(() => validateNewReplayCollection({ ...body, ruleList: [{ ...body.ruleList[0], writerUserIdList: ['9999'] }] }, tree), { code: 'INVALID_INPUT' })
  assert.throws(() => validateNewReplayCollection({ ...body, commitDeadline: { dateType: 'now', date: '8', time: '18:30' } }, tree), { code: 'INVALID_INPUT' })
})
test('replay configuration Schema and offline plans bind only fixed current HTTP routes', async () => {
  for (const suffix of ['configuration', 'settings set', 'rule add', 'rule update', 'rule remove']) { const current = flow(suffix); assert.ok(current); validateReplayCollectionConfigWorkflow(current); const corrupt = structuredClone(current); corrupt.steps[0].input = { body: {} }; assert.throws(() => validateReplayCollectionConfigWorkflow(corrupt), { code: 'INVALID_CONTRACT' }) }
  const f = fixture(); await run('rule remove', { ruleId: '9001' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('rule remove', { ruleId: '9001' }, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const op = catalog.operations.find(row => row.method === 'PUT' && row.route === '/task/review/replay/collect/member/rule'); await assert.rejects(executeOperation(ctx, op, { body: { replayCollectId: '7001', ruleId: '9001', viewerUserIdList: [] } }, session, { transport: f.transport, approved: true }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
