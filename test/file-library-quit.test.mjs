import test from 'node:test'
import assert from 'node:assert/strict'
import { context } from '../dist/core.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { validateFileLibraryQuitWorkflow } from '../dist/file-library-quit.js'
const ctx = context('production', 'fixture'), flow = () => workflows.workflows.find(flow => flow.command === 'file library quit')
const session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, identity: { userId: '81', teamId: '7', username: 'fixture' } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const row = (userId, roleId, type) => ({ userId, role: { id: roleId, name: type, type } })
const base = () => ({ id: 11, creator: 82, color: 1, type: 'folder', name: 'fixture', editControl: { quitLib: true }, userRoles: [row(81, 2, 'libWrite'), row(82, 1, 'libCreator'), row(83, 3, 'libRead')] })
function fixture(options = {}) {
  const requests = []; let details = 0, changed = false
  const transport = async (url, init) => {
    requests.push({ method: init.method, path: url.pathname, body: init.body }); const path = url.pathname
    if (path.endsWith('/authAjax')) return json({ id: options.wrongIdentity ? 83 : 81, username: 'fixture', success: true, token: 'fixture', team: { id: 7, name: 'company' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: '2100-01-01 00:00:00', usersCount: 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'CLOUD_LIB', status: 'enable' }])
    if (path.endsWith('/company/current')) return json({})
    if (path.endsWith('/folder/quit')) {
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { id: '11' }); changed = true
      if (options.timeout) throw Error('network timeout after write')
      return new Response(null, { status: 200 })
    }
    if (path.endsWith('/folder/list')) return json(options.listStillVisible ? [{ id: 11 }] : [])
    if (path.endsWith('/folder')) {
      assert.equal(url.searchParams.get('id'), '11'); details++
      const value = base()
      if (options.owner) value.userRoles = [row(81, 1, 'libCreator'), row(82, 2, 'libWrite')]
      if (options.nonmember) value.userRoles = value.userRoles.filter(row => row.userId !== 81)
      if (options.denied) value.editControl.quitLib = false
      if (options.child) value.parentFolderId = 10
      if (options.drift && details === 2) value.userRoles[2].role.id = 4
      if (changed) {
        if (options.readError) return new Response(JSON.stringify({ code: options.readError, message: 'fixture denial' }), { status: 400, headers: { 'content-type': 'application/json' } })
        if (!options.ignored) value.userRoles = value.userRoles.filter(row => row.userId !== 81)
        if (options.changedOthers) value.userRoles[1].role.id = 4
      }
      return json(value)
    }
    throw Error('Unexpected HTTP ' + path)
  }
  return { transport, requests, writes: () => requests.filter(row => row.method === 'POST') }
}
const run = async (server, approved = true, dryRun = false) => { try { return await runWorkflow(ctx, flow(), { libraryId: '11' }, session, { transport: server.transport, approved, dryRun }) } catch (error) { error.message += ' ' + JSON.stringify(error.details); throw error } }
test('quit removes only this nonowner and independently preserves all other roles without replay', async () => {
  const server = fixture(), result = await run(server)
  assert.equal(result.result.quit, true); assert.deepEqual(result.result.verification, { mode: 'full-membership', membershipReadback: true, otherMembersAndRolesPreserved: true })
  assert.equal(server.writes().length, 1); assert.equal(server.requests.filter(row => row.path.endsWith('/folder')).length, 3)
})
test('ordinary member access revocation is bounded evidence and never claims a full membership readback', async () => {
  const server = fixture({ readError: 401005 }), result = await run(server)
  assert.deepEqual(result.result.verification, { mode: 'current-account-access-revoked', membershipReadback: false, otherMembersAndRolesPreserved: 'unverified', upstreamCode: '401005' })
  assert.equal(server.writes().length, 1)
  for (const options of [{ readError: 401002 }, { readError: 401005, listStillVisible: true }]) {
    const bad = fixture(options); await assert.rejects(run(bad)); assert.equal(bad.writes().length, 1)
  }
})
test('owner, nonmember, hidden quit permission, child folder, identity drift and changed roles stop before writes', async () => {
  for (const options of [{ owner: true }, { nonmember: true }, { denied: true }, { child: true }, { wrongIdentity: true }, { drift: true }]) {
    const server = fixture(options); await assert.rejects(run(server)); assert.equal(server.writes().length, 0)
  }
})
test('ignored quit, modified other members and a lost response remain explicit partial/unknown failures with resource IDs', async () => {
  for (const options of [{ ignored: true }, { changedOthers: true }, { timeout: true }]) {
    const server = fixture(options)
    await assert.rejects(run(server), error => {
      assert.equal(error.details.resources.libraryId, '11'); assert.equal(error.details.automaticallyRetried, false)
      assert.equal(error.details.writeOutcome, options.timeout ? 'unknown' : 'accepted-needs-verification'); return true
    }); assert.equal(server.writes().length, 1)
  }
})
test('quit contract has fixed HTTP steps, offline dry-run and explicit confirmation; raw operation cannot bypass context', async () => {
  const server = fixture(); await assert.rejects(run(server, false), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(server.requests.length, 0)
  const dry = await run(server, false, true); assert.equal(dry.dryRun, true); assert.equal(server.requests.length, 0)
  const changed = structuredClone(flow()); changed.steps[2].input = { body: { id: '99' } }; assert.throws(() => validateFileLibraryQuitWorkflow(changed), { code: 'INVALID_CONTRACT' })
  const op = catalog.operations.find(op => op.route === '/task/v1/folder/quit' && op.method === 'POST')
  await assert.rejects(executeOperation(ctx, op, { body: { id: '11' } }, session, { transport: server.transport, approved: true }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(server.requests.length, 0)
})
