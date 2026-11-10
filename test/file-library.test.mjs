import assert from 'node:assert/strict'
import test from 'node:test'
import { context } from '../dist/core.js'
import { prepareFileLibrary, verifyFileLibrary } from '../dist/file-library.js'
import { workflows, runWorkflow } from '../dist/workflows.js'

const owner = { id: 5001, name: '拥有者', type: 'libCreator' }, write = { id: 5002, name: '可编辑', type: 'libWrite' }, read = { id: 5003, name: '仅查看', type: 'libRead' }
const session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, identity: { userId: '1001', teamId: '100', username: 'fixture' } }
const member = (userId, role = write) => ({ id: Number(userId) + 10000, userId: Number(userId), role })
const base = () => ({ id: 7001, name: 'fixture', color: 1, type: 'folder', creator: 1001, defaultRole: write, displayOrder: 1,
  editControl: { renameLib: true, editLibColor: true, addLibMember: true, removeLibMember: true, editLibMemberRole: true, removeLib: true },
  userRoles: [member('1001', owner), member('1002', read), member('1003', write)] })
const run = (command, input, transport, approved = false, dryRun = false) => runWorkflow(context('production', 'fixture'), workflows.workflows.find(flow => flow.command === command), input, session, { transport, approved, dryRun })
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const directory = () => [{ id: 100, name: 'company', type: 'top', parentId: null, displayOrder: 1, leaderList: [], userList: ['1001', '1002', '1003', '1004'].map(id => ({ id: Number(id), username: 'fixture-' + id, realName: 'member-' + id })), childList: [] }]

test('ordinary library create, property update, complete-list reorder and deletion read back business state', async () => {
  let sequence = 7001
  const items = [], writes = [], roles = [owner, write, read]
  const transport = async (url, init) => {
    const path = url.pathname, body = init.body ? JSON.parse(init.body) : null
    if (path.endsWith('/department/list')) return json(directory())
    if (path.endsWith('/listLibRole')) return json(roles)
    if (path.endsWith('/list')) return json(items.map(({ id, name, color, displayOrder, type }) => ({ id, name, color, displayOrder, type })))
    if (init.method === 'GET') return json(items.find(item => String(item.id) === url.searchParams.get('id')))
    writes.push({ method: init.method, path, body })
    if (init.method === 'POST') {
      assert.ok(!Object.hasOwn(body, 'parentFolderId'))
      const item = { ...base(), id: sequence++, ...body, displayOrder: items.length + 1, userRoles: [member('1001', owner)] }
      items.push(item); return json(item)
    }
    if (path.endsWith('/sort')) {
      const item = items.find(item => String(item.id) === body.moveId)
      assert.equal(body.frontId, undefined); assert.equal(body.nextId, '7001'); item.displayOrder = 0; return json({ displayOrder: 0, flush: false })
    }
    const index = items.findIndex(item => item.id === Number(path.split('/').at(-1)))
    if (init.method === 'DELETE') { items.splice(index, 1); return new Response(null, { status: 204 }) }
    Object.assign(items[index], body); return json(items[index])
  }
  const a = (await run('file library create', { name: 'a' }, transport)).result
  const b = (await run('file library create', { name: 'b' }, transport)).result
  assert.equal((await run('file library update', { libraryId: String(a.id), patch: { name: 'renamed', color: 3 } }, transport)).result.color, 3)
  const ordered = (await run('file library reorder', { libraryId: String(b.id), frontId: null, nextId: String(a.id) }, transport)).result
  assert.deepEqual([...ordered].sort((a, b) => a.displayOrder - b.displayOrder).map(item => item.name), ['b', 'renamed'])
  await run('file library remove', { libraryId: String(a.id) }, transport, true)
  await run('file library remove', { libraryId: String(b.id) }, transport, true)
  assert.equal(items.length, 0); assert.equal(writes.filter(request => request.method === 'POST').length, 2)
})

test('member changes use explicit differences, preserve roles and reject removal of self or owner', () => {
  const input = { libraryId: '7001', userIds: ['1004'] }, results = { before: base(), directory: directory() }
  const added = prepareFileLibrary('library-members-add', input, results, session)
  assert.deepEqual(added.body, { memberIds: '1001,1002,1003,1004' })
  results.verified = { ...base(), userRoles: [...base().userRoles, member('1004')] }
  verifyFileLibrary(input, results, 'verified')
  results.verified.userRoles[1].role = write
  assert.throws(() => verifyFileLibrary(input, results, 'verified'), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(prepareFileLibrary('library-members-add', { ...input, userIds: ['1002'] }, results, session), null)
  assert.throws(() => prepareFileLibrary('library-members-remove', { ...input, userIds: ['1001'] }, results, session), { code: 'INVALID_INPUT' })
  const removed = prepareFileLibrary('library-members-remove', { ...input, userIds: ['1002'] }, results, session)
  assert.equal(removed.body.memberIds, '1001,1003')
  assert.throws(() => prepareFileLibrary('library-members-add', { ...input, userIds: ['9001'] }, results, session), { code: 'INVALID_INPUT' })
  results.verified = { ...base(), userRoles: base().userRoles.filter(m => m.userId !== 1002) }; verifyFileLibrary(input, results, 'verified')
})

test('ordinary role changes cannot transfer ownership; transfer discovers the company role and preserves other members', async () => {
  const results = { before: base(), roles: [owner, write, read] }, input = { libraryId: '7001', userId: '1002', roleId: '5001' }
  assert.throws(() => prepareFileLibrary('library-member-role', input, results, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareFileLibrary('library-member-role', { ...input, userId: '1001', roleId: '5002' }, results, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareFileLibrary('library-member-role', { ...input, roleId: '8999' }, results, session), { code: 'INVALID_INPUT' })
  const args = prepareFileLibrary('library-owner-transfer', input, results, session)
  assert.deepEqual(args.body, { folderId: '7001', userId: '1002', roleId: '5001' })
  results.verified = { ...base(), userRoles: [member('1001', write), member('1002', owner), member('1003', write)] }
  verifyFileLibrary(input, results, 'verified')
  results.verified.userRoles[0].role = read
  assert.throws(() => verifyFileLibrary(input, results, 'verified'), { code: 'BUSINESS_ASSERTION_FAILED' })
  results.verified.userRoles[0].role = write
  results.verified.userRoles[2].role = read
  assert.throws(() => verifyFileLibrary(input, results, 'verified'), { code: 'BUSINESS_ASSERTION_FAILED' })
  let requests = 0
  await assert.rejects(run('file library owner transfer', { libraryId: '7001', userId: '1002' }, async () => { requests++; return json(base()) }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(requests, 0)
})

test('context rejects child folders and malformed owner sets; stale neighbours and denied permissions stop before writes', () => {
  const input = { libraryId: '7001' }, results = { before: base(), libraries: [{ id: 7001, displayOrder: 1 }, { id: 7002, displayOrder: 2 }, { id: 7003, displayOrder: 3 }] }
  assert.throws(() => verifyFileLibrary(input, { before: { ...base(), parentFolderId: 6001 } }, 'before'), { code: 'CONTEXT_CONFLICT' })
  assert.throws(() => verifyFileLibrary(input, { before: { ...base(), userRoles: [member('1001', write)] } }, 'before'), { code: 'CONTEXT_MISSING' })
  assert.throws(() => prepareFileLibrary('library-reorder', { ...input, frontId: null, nextId: '7003' }, results, session), { code: 'CONTEXT_CONFLICT' })
  assert.throws(() => prepareFileLibrary('library-reorder', { ...input, frontId: '7001', nextId: '7002' }, results, session), { code: 'CONTEXT_CONFLICT' })
  results.before.editControl.renameLib = false
  assert.throws(() => prepareFileLibrary('library-update', { ...input, patch: { name: 'x' } }, results, session), { code: 'PERMISSION_DENIED', exit: 4 })
})

test('joining verifies the current member and does not replay existing membership', () => {
  const input = { libraryId: '7001' }, before = { ...base(), userRoles: [member('1002', owner)] }, results = { before }
  assert.deepEqual(prepareFileLibrary('library-join', input, results, session), { body: { libId: '7001' } })
  results.verified = { ...before, userRoles: [...before.userRoles, member('1001')] }; verifyFileLibrary(input, results, 'verified')
  results.before = results.verified
  assert.equal(prepareFileLibrary('library-join', input, results, session), null)
})

test('dry-run is offline, irreversible operations confirm before requests, and an unknown write is sent only once', async () => {
  let requests = 0, writes = 0
  const transport = async (url, init) => {
    requests++
    if (init.method === 'GET') return json([owner, write, read])
    writes++; throw Error('connection lost')
  }
  const preview = await run('file library create', { name: 'preview' }, transport, false, true)
  assert.equal(preview.dryRun, true); assert.equal(requests, 0)
  await assert.rejects(run('file library remove', { libraryId: '7001' }, transport), { code: 'CONFIRMATION_REQUIRED' })
  await assert.rejects(run('file library create', { name: 'fixture' }, transport), error => {
    assert.equal(error.details.writeOutcome, 'unknown'); assert.deepEqual(error.details.completedSteps, ['roles']); return true
  })
  assert.equal(writes, 1)
})
