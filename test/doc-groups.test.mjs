import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const base = '/task/v1/corpusGroup', flow = suffix => { const f = workflows.workflows.find(row => row.command === 'doc ' + suffix); assert.ok(f, suffix); return f }
const run = (suffix, input, f, options = {}) => runWorkflow(ctx, flow(suffix), input, session, { approved: true, transport: f.transport, ...options })
const mutate = f => f.calls.filter(row => row.method !== 'GET')
function fixture(options = {}) {
 const calls = [], groups = [{ id: '701', name: '第一组', displayOrder: 100 }, { id: '702', name: '第二组', displayOrder: 200 }]
 const spaces = [{ id: '801', name: '第一文集', type: 'essays', corpusGroupId: '701' }, { id: '802', name: '未分组文集', type: 'essays', corpusGroupId: null }]
 let directoryReads = 0, companyReads = 0, identityReads = 0
 const transport = async (url, init) => {
  const method = init.method, path = url.pathname, body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ method, path, body, query: Object.fromEntries(url.searchParams) })
  if (path.endsWith('/authAjax')) { identityReads++; return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.identityDrift && identityReads >= 3 ? 9 : 7, name: '公司' } }) }
  if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
  if (path.endsWith('/function/available')) return json([{ funcName: 'KNOWLEDGE', status: options.disabled ? 'disable' : 'enable' }])
  if (path.endsWith('/company/current')) { companyReads++; return json({ useCorpus: !options.noUse, editCorpusGroup: !options.noEdit && !(options.permissionDrift && companyReads >= 3) }) }
  if (path === base + '/list') {
   directoryReads++
   if (directoryReads === 2 && options.contextDrift) groups[1].name = '并发改名'
   if (directoryReads === 2 && options.spaceDrift) spaces[0].corpusGroupId = null
   const custom = groups.slice().sort((a,b) => a.displayOrder - b.displayOrder).map(row => ({ ...row, checked: false, corpusCount: spaces.filter(s => s.corpusGroupId === row.id).length }))
   return json([{ id: 'all', name: '全部', displayOrder: 0, checked: true, corpusCount: spaces.length }, { id: 'star', name: '星标', displayOrder: 0, checked: false, corpusCount: 0 }, ...custom, ...(options.duplicate ? [custom[0]] : [])])
  }
  if (path === '/task/v1/corpus/list') return json(spaces)
  if (path === base && method === 'POST') {
   const row = { id: options.longId ? '9223372036854775806' : '703', name: body.name, displayOrder: 300 }
   if (!options.ignoreWrite) groups.push(row)
   if (options.timeoutAfterWrite) throw Error('connection lost after commit')
   return json(row)
  }
  if (path === base + '/sort' && method === 'PUT') {
   const row = groups.find(row => row.id === body.moveId); assert.ok(row)
   assert.ok(body.frontId === null || groups.some(row => row.id === body.frontId))
   assert.ok(body.nextId === null || groups.some(row => row.id === body.nextId))
   const front = groups.find(row => row.id === body.frontId), next = groups.find(row => row.id === body.nextId)
   const value = front && next ? (front.displayOrder + next.displayOrder) / 2 : front ? front.displayOrder + 100 : next ? next.displayOrder - 100 : 100
   if (!options.ignoreWrite) row.displayOrder = value
   return json(options.badSortReceipt ? { flush: true } : { displayOrder: value })
  }
  if (path.startsWith(base + '/') && method === 'PUT') {
   const row = groups.find(row => row.id === path.slice(base.length + 1)); assert.ok(row)
   if (!options.ignoreWrite) row.name = body.name
   return json(row)
  }
  if (path.startsWith(base + '/') && method === 'DELETE') {
   const key = path.slice(base.length + 1), index = groups.findIndex(row => row.id === key); assert.ok(index >= 0)
   if (!options.ignoreWrite) { groups.splice(index, 1); for (const row of spaces) if (row.corpusGroupId === key && !options.keepAssociation) row.corpusGroupId = null }
   if (options.deleteSpace) spaces.splice(0, 1)
   return new Response(null, { status: 200 })
  }
  throw Error('Unexpected doc-group request ' + method + ' ' + path)
 }
 return { calls, groups, spaces, transport }
}
test('company doc-group commands disclose real scope, GET effects and offline context without HTTP', async () => {
 const f = fixture()
 for (const suffix of ['groups list', 'group create', 'group rename', 'group move', 'group remove']) {
  const input = suffix === 'groups list' ? {} : { companyId: '7', ...(suffix.endsWith('create') ? { name: '新组' } : { groupId: '701', ...(suffix.endsWith('rename') ? { name: '新名称' } : suffix === 'group move' ? { placement: 'last' } : { expectedName: '第一组' }) }) }
  const plan = await executeWorkflow(ctx, flow(suffix), input, session, { dryRun: true, transport: f.transport })
  assert.equal(plan.dryRun, true); assert.equal(plan.access.features.includes('KNOWLEDGE'), true)
 }
 assert.equal(f.calls.length, 0)
 const directory = (await run('groups list', {}, f)).result
 assert.equal(flow('groups list').effect, 'write'); assert.deepEqual(directory.groups.map(row => row.id), ['701', '702'])
 assert.deepEqual(directory.virtualGroups.map(row => row.id), ['all', 'star']); assert.equal(directory.hiddenSpacesIndependentlyVerified, false)
 assert.match(directory.contextVersion, /^[a-f0-9]{64}$/)
 const native = catalog.operations.find(row => row.method === 'GET' && row.route === base + '/list')
 await assert.rejects(executeOperation(ctx, native, {}, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
test('create and rename verify exact company catalogue while preserving all document associations', async () => {
 const f = fixture({ longId: true }), before = structuredClone(f.spaces)
 const version = (await run('groups list', {}, f)).result.contextVersion
 const created = await run('group create', { companyId: '7', name: '独立组', expectedVersion: version }, f)
 assert.equal(created.result.group.id, '9223372036854775806'); assert.equal(created.result.verified, true)
 const renamed = await run('group rename', { companyId: '7', groupId: created.result.group.id, name: '新名字', expectedVersion: created.result.contextVersion }, f)
 assert.equal(renamed.result.group.name, '新名字'); assert.deepEqual(f.spaces, before)
 assert.deepEqual(mutate(f).map(row => row.body), [{ name: '独立组' }, { name: '新名字' }])
 const count = mutate(f).length
 await run('group rename', { companyId: '7', groupId: created.result.group.id, name: '新名字' }, f)
 assert.equal(mutate(f).length, count)
})
test('sort derives adjacent real IDs and verifies first/last/before/after, including no-op', async () => {
 const f = fixture()
 await run('group move', { companyId: '7', groupId: '702', placement: 'first' }, f)
 assert.deepEqual(mutate(f).at(-1).body, { moveId: '702', frontId: null, nextId: '701' })
 await run('group move', { companyId: '7', groupId: '702', placement: 'last' }, f)
 assert.deepEqual(mutate(f).at(-1).body, { moveId: '702', frontId: '701', nextId: null })
 await run('group move', { companyId: '7', groupId: '702', beforeId: '701' }, f)
 await run('group move', { companyId: '7', groupId: '702', afterId: '701' }, f)
 assert.equal(mutate(f).length, 4)
 const noop = await run('group move', { companyId: '7', groupId: '702', placement: 'last' }, f)
 assert.equal(noop.result.changed, false); assert.equal(mutate(f).length, 4)
})
test('deleting a company group migrates visible corpora without deleting or changing them', async () => {
 const f = fixture(), result = await run('group remove', { companyId: '7', groupId: '701', expectedName: '第一组' }, f)
 assert.equal(result.result.group.removed, true); assert.equal(result.result.spacesDeleted, false)
 assert.deepEqual(result.result.verifiedVisibleSpaceIds, ['801']); assert.equal(result.result.hiddenSpacesIndependentlyVerified, false)
 assert.equal(f.spaces.length, 2); assert.equal(f.spaces[0].corpusGroupId, null)
 assert.equal(mutate(f).length, 1); assert.equal(mutate(f)[0].method, 'DELETE')
})
test('foreign/virtual IDs, wrong company/name/version and ambiguous sort never send mutation', async () => {
 for (const [suffix, input] of [
  ['group rename', { companyId: '9', groupId: '701', name: '改名' }],
  ['group rename', { companyId: '7', groupId: '999', name: '改名' }],
  ['group remove', { companyId: '7', groupId: '701', expectedName: '不符' }],
  ['group create', { companyId: '7', name: 'x'.repeat(81) }],
  ['group create', { companyId: '7', name: '😀'.repeat(41) }],
  ['group rename', { companyId: '7', groupId: '701', name: '改名', expectedVersion: '0'.repeat(64) }],
  ['group move', { companyId: '7', groupId: '701', beforeId: '701' }],
  ['group move', { companyId: '7', groupId: '701', afterId: '999' }],
  ['group move', { companyId: '7', groupId: '701', placement: 'first', beforeId: '702' }],
 ]) { const f = fixture(); await assert.rejects(run(suffix, input, f)); assert.equal(mutate(f).length, 0) }
 const f = fixture(); await assert.rejects(run('group rename', { companyId: '7', groupId: 'all', name: '改名' }, f)); assert.equal(mutate(f).length, 0)
})
test('actual permissions, fresh drift, expiry, capacity and unavailable app stop before mutation', async () => {
 for (const options of [{ noEdit: true }, { noUse: true }, { permissionDrift: true }, { contextDrift: true }, { spaceDrift: true }, { identityDrift: true }, { expired: true }, { overCapacity: true }, { disabled: true }, { duplicate: true }]) {
  const f = fixture(options)
  await assert.rejects(executeWorkflow(ctx, flow('group rename'), { companyId: '7', groupId: '701', name: '改名' }, session, { transport: f.transport, approved: true }))
  assert.equal(mutate(f).length, 0, JSON.stringify(options))
 }
})
test('independent readback detects ignored create/rename/sort/delete and incomplete migration', async () => {
 for (const [suffix, input, options] of [
  ['group create', { companyId: '7', name: '新组' }, { ignoreWrite: true }],
  ['group rename', { companyId: '7', groupId: '701', name: '新名' }, { ignoreWrite: true }],
  ['group move', { companyId: '7', groupId: '701', placement: 'last' }, { ignoreWrite: true }],
  ['group move', { companyId: '7', groupId: '701', placement: 'last' }, { badSortReceipt: true }],
  ['group remove', { companyId: '7', groupId: '701', expectedName: '第一组' }, { ignoreWrite: true }],
  ['group remove', { companyId: '7', groupId: '701', expectedName: '第一组' }, { keepAssociation: true }],
  ['group remove', { companyId: '7', groupId: '701', expectedName: '第一组' }, { deleteSpace: true }],
 ]) { const f = fixture(options); await assert.rejects(run(suffix, input, f), { code: options.badSortReceipt ? 'RESPONSE_SCHEMA_MISMATCH' : 'BUSINESS_ASSERTION_FAILED' }); assert.equal(mutate(f).length, 1) }
})
test('unknown committed creation is not replayed; confirmation and contracts are enforced offline', async () => {
 const f = fixture({ timeoutAfterWrite: true })
 await assert.rejects(run('group create', { companyId: '7', name: '新组' }, f), error => error.details.writeOutcome === 'unknown-not-replayed' && error.details.autoReplay === false && error.details.resources.companyId === '7')
 assert.equal(f.groups.length, 3); assert.equal(mutate(f).length, 1)
 const denied = fixture()
 await assert.rejects(run('group remove', { companyId: '7', groupId: '701', expectedName: '第一组' }, denied, { approved: false }), { code: 'CONFIRMATION_REQUIRED' })
 assert.equal(denied.calls.length, 0)
 const changed = structuredClone(flow('group create')); changed.steps[0].operationId = changed.steps.at(-1).operationId
 await assert.rejects(runWorkflow(ctx, changed, { companyId: '7', name: '新组' }, session, { transport: denied.transport, approved: true }), { code: 'INVALID_CONTRACT' })
 assert.equal(denied.calls.length, 0)
})
