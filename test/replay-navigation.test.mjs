import test from 'node:test'
import assert from 'node:assert/strict'
import { context } from '../dist/core.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { accessPlan } from '../dist/access.js'
import { planReplayNavigation, replayNavigationItems, validateReplayNavigationWorkflow } from '../dist/replay-navigation.js'
const ctx = context('production', 'fixture'), session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, identity: { userId: '81', teamId: '7', username: 'fixture' } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = command => workflows.workflows.find(flow => flow.command === command)
const item = (id, isStar = false) => ({ id: String(id), type: 'day', name: 'own-' + id, isStar })
const topic = { id: 0, type: 'topic', name: '目标复盘', isStar: false }
function fixture(options = {}) {
  const calls = [], writes = [], state = { items: [item(11, true), item(12, true), item(13), item(14)], listReads: 0, permissionReads: 0 }
  const transport = async (url, init) => {
    calls.push(url.pathname); const path = url.pathname
    if (path.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', success: true, token: 'fixture', team: { id: 7, name: 'company' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'REPLAY', status: 'enable' }])
    if (path.endsWith('/company/current')) { state.permissionReads++; return json({ useReplay: true, replayManage: options.manager !== false && !(options.permissionDrift && state.permissionReads > 1) }) }
    if (init.method === 'GET' && path.endsWith('/collect/list')) {
      state.listReads++
      const items = structuredClone(options.many ? Array.from({ length: 500 }, (_, i) => item(i + 1)) : state.items)
      if (options.contextDrift && state.listReads > 1) items[0].name += '-changed'
      if (options.mismatch && writes.length) items[0].name += '-wrong'
      return json(path.includes('/config/') ? items.map(({ isStar, ...row }) => row) : [...items, ...(options.many ? [] : [topic])])
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body); writes.push({ path, body })
      if (!options.ignored) {
        if (path.endsWith('/star')) {
          const selected = state.items.find(row => row.id === body.id); selected.isStar = body.isStar
          const rest = state.items.filter(row => row.id !== body.id), starred = rest.filter(row => row.isStar), unstarred = rest.filter(row => !row.isStar)
          state.items = body.isStar ? [selected, ...starred, ...unstarred] : [...starred, selected, ...unstarred]
        } else {
          const selected = state.items.find(row => row.id === body.moveId), rest = state.items.filter(row => row !== selected)
          let index = body.frontId ? rest.findIndex(row => row.id === body.frontId) + 1 : body.nextId ? rest.findIndex(row => row.id === body.nextId) : 0
          state.items = [...rest.slice(0, index), selected, ...rest.slice(index)]
        }
      }
      if (options.timeout) throw Error('lost response')
      return new Response(null, { status: 200 })
    }
    throw Error('Unexpected HTTP ' + path)
  }
  return { transport, state, calls, writes }
}
const run = async (command, input, server, publicDispatch = false, approved = true) => { try { return await (publicDispatch ? executeWorkflow : runWorkflow)(ctx, flow(command), input, session, { transport: server.transport, approved }) } catch (error) { error.message += ' ' + JSON.stringify(error.details); throw error } }
test('sidebar context returns full raw HTTP list and groups with virtual topic and exact long IDs', async () => {
  const server = fixture({ manager: false }); server.state.items.push(item('9007199254740993'))
  const result = (await run('replay sidebar context', {}, server, true)).result
  assert.equal(result.items.length, 6); assert.equal(result.groups.unstarred.at(-1).id, '9007199254740993'); assert.equal(result.virtualTopicMovable, false); assert.equal(server.writes.length, 0)
  assert.throws(() => replayNavigationItems([item(11), item(11)], true), { code: 'CONTEXT_MISSING' })
  assert.throws(() => replayNavigationItems([item(11), item(12, true)], true), { code: 'CONTEXT_MISSING' })
  assert.throws(() => replayNavigationItems([topic, item(11)], true), { code: 'CONTEXT_MISSING' })
})
test('personal reorder preserves star groups and other members and needs no manager permission', async () => {
  const server = fixture({ manager: false }), result = await run('replay sidebar reorder', { collectionId: '14', frontId: null, nextId: '13' }, server, true)
  assert.deepEqual(result.result.items.map(row => row.id), ['11', '12', '14', '13', '0']); assert.equal(server.writes.length, 1)
  assert.deepEqual(server.writes[0].body, { moveId: '14', nextId: '13' }); assert.equal(result.result.scope, 'current-user-sidebar')
})
test('star and unstar move only the target to the top of its new group; same state skips writing', async () => {
  const server = fixture({ manager: false })
  await run('replay sidebar star set', { collectionId: '14', isStar: true }, server, true)
  assert.deepEqual(server.state.items.map(row => row.id), ['14', '11', '12', '13'])
  await run('replay sidebar star set', { collectionId: '11', isStar: false }, server, true)
  assert.deepEqual(server.state.items.map(row => row.id), ['14', '12', '11', '13'])
  const unchanged = await run('replay sidebar star set', { collectionId: '11', isStar: false }, server, true)
  assert.equal(unchanged.result.changed, false); assert.equal(server.writes.length, 2)
})
test('stale adjacent nodes, cross-star drag, virtual topic, truncated HTTP and stale expected versions stop before writing', async () => {
  const cases = [
    ['replay sidebar reorder', { collectionId: '14', frontId: '11', nextId: '13' }, {}],
    ['replay sidebar reorder', { collectionId: '14', frontId: null, nextId: '12' }, {}],
    ['replay sidebar star set', { collectionId: '999', isStar: true }, {}],
    ['replay sidebar star set', { collectionId: '1', isStar: true }, { many: true }],
    ['replay sidebar star set', { collectionId: '14', isStar: true, expectedContextVersion: 'a'.repeat(64) }, {}],
  ]
  for (const [command, input, options] of cases) { const server = fixture(options); await assert.rejects(run(command, input, server)); assert.equal(server.writes.length, 0) }
  const items = replayNavigationItems([item(11), topic], true)
  assert.throws(() => planReplayNavigation('sidebar-star', { collectionId: '0', isStar: true }, items))
})
test('configuration order uses separate company list, confirmation and current replayManage including prewrite drift', async () => {
  const server = fixture(), result = await run('replay collection order set', { collectionId: '14', frontId: null, nextId: '11' }, server)
  assert.equal(result.result.scope, 'company-configuration-order'); assert.deepEqual(server.state.items.map(row => row.id), ['14', '11', '12', '13'])
  assert.ok(server.writes[0].path.endsWith('/all/sort'))
  for (const options of [{ manager: false }, { permissionDrift: true }]) { const denied = fixture(options); await assert.rejects(run('replay collection order set', { collectionId: '14', frontId: null, nextId: '11' }, denied)); assert.equal(denied.writes.length, 0) }
  const unapproved = fixture(); await assert.rejects(run('replay collection order set', { collectionId: '14', frontId: null, nextId: '11' }, unapproved, false, false), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(unapproved.calls.length, 0)
})
test('expired, over-capacity and changing contexts block writes for personal navigation too', async () => {
  for (const options of [{ expired: true }, { overCapacity: true }, { contextDrift: true }]) {
    const server = fixture(options); await assert.rejects(run('replay sidebar star set', { collectionId: '14', isStar: true }, server)); assert.equal(server.writes.length, 0)
  }
})
test('ignored or inconsistent readback and uncertain transport never replay a write and retain resource context', async () => {
  for (const options of [{ ignored: true }, { mismatch: true }, { timeout: true }]) {
    const server = fixture(options)
    await assert.rejects(run('replay sidebar star set', { collectionId: '14', isStar: true }, server), error => {
      assert.equal(error.details.resources.collectionId, '14'); assert.equal(error.details.automaticallyRetried, false)
      assert.equal(error.details.writeOutcome, options.timeout ? 'unknown' : 'accepted-needs-verification'); return true
    }); assert.equal(server.writes.length, 1)
  }
})
test('fixed schema steps, offline plan and guarded raw requests express the distinct permissions', async () => {
  const server = fixture(), command = flow('replay sidebar reorder')
  const result = await runWorkflow(ctx, command, { collectionId: '14', frontId: null, nextId: '13' }, null, { dryRun: true, transport: server.transport })
  assert.equal(result.dryRun, true); assert.equal(server.calls.length, 0)
  const bad = structuredClone(command); bad.steps[2].input = { body: { moveId: '999' } }; assert.throws(() => validateReplayNavigationWorkflow(bad), { code: 'INVALID_CONTRACT' })
  assert.ok(!accessPlan(command, {}).permissions.includes('replayManage')); assert.ok(accessPlan(flow('replay collection order context'), {}).permissions.includes('replayManage'))
  for (const route of ['/task/review/replay/collect/sort', '/task/review/replay/collect/all/sort', '/task/review/replay/collect/star']) {
    const op = catalog.operations.find(row => row.route === route && row.method === 'PUT'), body = route.endsWith('/star') ? { id: '14', isStar: true } : { moveId: '14' }
    await assert.rejects(executeOperation(ctx, op, { body }, session, { transport: server.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  }
  assert.equal(server.calls.length, 0)
})
