import test from 'node:test'
import assert from 'node:assert/strict'
import { accessPlan } from '../dist/access.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { workflows } from '../dist/workflows.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, identity: { userId: '81', teamId: '7', username: 'fixture' } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
test('file library company create, join and creator transfer authorities are enforced before any library HTTP', async () => {
  for (const [command, permission, input] of [['file library create', 'createLib', { name: 'own' }], ['file library join', 'joinTeamLib', { libraryId: '1' }], ['file library owner transfer', 'editLibMemberCreatorRole', { libraryId: '1', userId: '82' }]]) {
    const flow = workflows.workflows.find(flow => flow.command === command); assert.ok(accessPlan(flow, input).permissions.includes(permission))
    for (const denied of [false, null, undefined]) {
      const paths = []
      const transport = async url => { paths.push(url.pathname)
        if (url.pathname.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', success: true, token: 'fixture', team: { id: 7, name: 'company' } })
        if (url.pathname.endsWith('/state/independent')) return json({ deadLine: '2100-01-01 00:00:00', usersCount: 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
        if (url.pathname.endsWith('/function/available')) return json([{ funcName: 'CLOUD_LIB', status: 'enable' }])
        if (url.pathname.endsWith('/company/current')) return json({ editLibMemberRole: true, createLib: true, joinTeamLib: true, editLibMemberCreatorRole: true, [permission]: denied })
        throw Error('Library endpoint reached before independent company authority: ' + url.pathname)
      }
      await assert.rejects(executeWorkflow(ctx, flow, input, session, { transport, approved: true }), { code: 'FEATURE_FORBIDDEN' })
      assert.ok(paths.every(path => !path.startsWith('/task/v1/folder')))
    }
  }
})
test('a shared folder endpoint keeps root-library company authority separate from child-folder context', () => {
  const op = catalog.operations.find(op => op.method === 'POST' && op.route === '/task/v1/folder')
  assert.ok(accessPlan(op, { body: { name: 'root' } }).permissions.includes('createLib'))
  assert.ok(!accessPlan(op, { body: { name: 'child', parentFolderId: '1' } }).permissions.includes('createLib'))
})
test('raw library role and join transports cannot bypass their contextual workflows', async () => {
  for (const [method, route, input] of [['POST', '/task/v1/folder', { body: { name: 'own', color: 1 } }], ['POST', '/task/v1/folder/updateUserRole', { body: { folderId: '1', userId: '82', roleId: '3' } }], ['PUT', '/task/v1/folder/join', { body: { libId: '1' } }]]) {
    const op = catalog.operations.find(op => op.method === method && op.route === route); let requests = 0
    await assert.rejects(executeOperation(ctx, op, input, session, { approved: true, transport: async () => { requests++; throw Error('unexpected HTTP') } }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(requests, 0)
  }
})
