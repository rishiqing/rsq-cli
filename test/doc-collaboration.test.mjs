import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
const base = '/task/v1/corpus/summary', ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = suffix => { const value = workflows.workflows.find(row => row.command === 'doc collaboration ' + suffix); assert.ok(value, suffix); return value }
const run = (suffix, input, f, opts = {}) => runWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, approved: true, ...opts })
function fixture(options = {}) {
  const calls = [], documents = Array.from({ length: options.count ?? 2 }, (_, index) => ({ id: String(index + 101), name: '协作文档' + index, corpusId: '901', corpusType: options.retired && index === 0 ? 'daily' : 'essays', isNoteBook: false, isDisplay: true, members: [{ userId: '81', role: options.creator ? 'creator' : 'write', showName: '本人' }, { userId: '82', role: 'creator', showName: '创建者' }], editControl: { editNote: !options.readonly, commentNote: !options.noComment }, isCorpusMember: options.inSpace === true }))
  let active = documents.map(row => row.id), detailGets = 0
  const messages = [{ id: '501', content: '<p>本人评论</p>', creator: { id: '81' } }, { id: '502', content: '<p>他人评论</p>', creator: { id: '82' } }]
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query, body })
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'KNOWLEDGE', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return json({ useCorpus: true })
    if (path === base + '/cooperateList') {
      const visible = documents.filter(row => active.includes(row.id) && (query.allSummary ? true : !row.isCorpusMember)), index = query.lastId ? visible.findIndex(row => row.id === query.lastId) + 1 : 0
      const page = options.duplicatePages && query.lastId ? visible.slice(0, 50) : visible.slice(index, index + Number(query.max))
      return json(page.map(row => ({ id: row.id, name: row.name, corpusId: row.corpusId, isCorpusMember: row.isCorpusMember, operatorTime: '2026.11.09 12:00:00' })))
    }
    if (path === base + '/authority') return json({ auth: options.noPreview || !active.includes(query.id) && !options.inSpace ? {} : { view: true }, status: options.noPreview || !active.includes(query.id) && !options.inSpace ? 'noPreview' : options.readonly ? 'noEdit' : '' })
    if (path === base && method === 'GET') {
      const row = documents.find(row => row.id === query.id); assert.ok(row)
      if (options.permissionDrift && ++detailGets === 2) row.editControl.editNote = false
      return json(options.foreignSpace ? { ...row, corpusId: '999' } : options.indirectMember ? { ...row, isCorpusMember: true } : row)
    }
    if (path === '/task/reditor/client/resource/get-delta') { assert.equal(query.type, 'doc'); return json([{ insert: '协作正文\n' }]) }
    if (path === '/task/v1/department/list') return json([{ id: '7', name: '公司', type: 'top', parentId: null, displayOrder: 1, childList: [], userList: [{ id: '81', showName: '本人' }, { id: '82', showName: '创建者' }] }])
    if (path === base + '/comments') return json(messages)
    if (path === base + '/comment' && method === 'POST') { const value = { id: '503', content: body.content, creator: { id: '81' } }; if (!options.ignoreWrite) messages.push(value); return json(value) }
    if (path === base + '/comment/501' && method === 'DELETE') { messages.splice(messages.findIndex(row => row.id === '501'), 1); return new Response(null, { status: 204 }) }
    if (path === base + '/quitCooperateSummary') {
      if (options.timeout) throw Error('transport lost')
      if (!options.ignoreWrite) { active = active.filter(id => id !== body.id); if (!options.keepMember) documents.find(row => row.id === body.id).members = documents.find(row => row.id === body.id).members.filter(row => row.userId !== '81') }
      return new Response(null, { status: 200 })
    }
    if (path === base + '/101' && method === 'PUT') { if (!options.ignoreWrite) documents[0].name = body.name; return json(documents[0]) }
    throw Error('Unexpected collaboration request ' + method + ' ' + path)
  }
  return { calls, documents, messages, transport }
}
const writes = f => f.calls.filter(call => call.method !== 'GET')
test('collaboration commands have independent scope and fixed doc-purpose HTTP body', async () => {
  assert.equal(workflows.workflows.filter(row => row.docAction?.startsWith('collaboration-')).length, 10)
  const f = fixture(), current = await run('get', { id: '101' }, f)
  assert.equal(current.result.spaceMembershipRequired, false)
  const content = await run('body get', { id: '101' }, f); assert.equal(content.result.content.ops[0].insert, '协作正文\n')
  assert.ok(!f.calls.some(call => call.path === '/task/v1/corpus/list' || call.path === '/task/v1/corpus/901'))
  const edited = structuredClone(flow('body get')); edited.steps.at(-1).operationId = catalog.operations.find(op => op.defaults?.query?.type === 'replay' && op.route.endsWith('/resource/get-delta')).id
  await assert.rejects(runWorkflow(ctx, edited, { id: '101' }, session, { dryRun: true }), { code: 'INVALID_CONTRACT' })
})
test('collaboration pagination completes native cursor scope and omits false allSummary', async () => {
  const f = fixture({ count: 51 }), first = await run('list', { scope: 'outside-spaces', limit: 1 }, f)
  assert.equal(first.result.hasMore, true); assert.equal(first.result.nextCursor, '101')
  const second = await run('list', { scope: 'outside-spaces', cursor: '101', limit: 1 }, f); assert.equal(second.result.items[0].id, '102')
  assert.ok(f.calls.filter(call => call.path.endsWith('/cooperateList')).every(call => !Object.hasOwn(call.query, 'allSummary')))
  assert.ok(f.calls.some(call => call.query.lastId === '150'))
  await assert.rejects(run('list', { cursor: '999' }, f), { code: 'INVALID_INPUT' })
  const duplicate = fixture({ count: 51, duplicatePages: true }); await assert.rejects(run('get', { id: '101' }, duplicate), { code: 'CONTEXT_MISSING' }); assert.equal(writes(duplicate).length, 0)
})
test('direct corpus filter membership and inherited project or department membership stay distinct', async () => {
  const f = fixture({ indirectMember: true }), result = await run('list', { scope: 'outside-spaces' }, f)
  assert.ok(result.result.items.every(row => row.isCorpusMember === false && row.hasCorpusOrProjectMembership === true))
  const detail = await run('get', { id: '101' }, f)
  assert.equal(detail.result.document.isCorpusMember, false); assert.equal(detail.result.document.hasCorpusOrProjectMembership, true)
})
test('collaboration excludes retired logs and checks real noncreator membership and preview', async () => {
  const f = fixture({ retired: true }), listed = await run('list', {}, f)
  assert.equal(listed.result.excludedRetiredCount, 1); assert.deepEqual(listed.result.items.map(row => row.id), ['102'])
  for (const [options, code] of [[{ noPreview: true }, 'RESOURCE_FORBIDDEN'], [{ creator: true }, 'RESOURCE_NOT_VISIBLE'], [{ foreignSpace: true }, 'CONTEXT_MISSING']]) {
    const denied = fixture(options); await assert.rejects(run('body get', { id: '101' }, denied), { code }); assert.equal(denied.calls.filter(call => call.path.endsWith('/get-delta')).length, 0)
  }
  const unknown = fixture(); await assert.rejects(run('get', { id: '999' }, unknown), { code: 'RESOURCE_NOT_VISIBLE' }); assert.ok(!unknown.calls.some(call => call.path === base))
})
test('collaboration rename uses live document permission and independent readback', async () => {
  const f = fixture(), before = await run('get', { id: '101' }, f)
  await run('rename', { id: '101', name: '新名称', expectedVersion: before.result.contextVersion }, f); assert.equal(f.documents[0].name, '新名称'); assert.equal(f.documents[1].name, '协作文档1')
  for (const [options, code] of [[{ readonly: true }, 'RESOURCE_FORBIDDEN'], [{ permissionDrift: true }, 'CONTEXT_CONFLICT'], [{ ignoreWrite: true }, 'BUSINESS_ASSERTION_FAILED']]) {
    const denied = fixture(options); await assert.rejects(run('rename', { id: '101', name: '不应成功' }, denied), { code }); assert.equal(writes(denied).length, options.ignoreWrite ? 1 : 0)
  }
})
test('collaboration comments use actual comment permission, safe mentions, replies and own deletion', async () => {
  const f = fixture(), context = await run('comments context', { id: '101' }, f); assert.equal(context.result.members.length, 2)
  await run('comment reply', { id: '101', text: '<安全文本>', replyTo: '502' }, f)
  assert.match(f.messages.at(-1).content, /&lt;安全文本&gt;/); assert.match(f.messages.at(-1).content, /data-user-id="82"/)
  await assert.rejects(run('comment remove', { id: '101', commentId: '502' }, f), { code: 'RESOURCE_FORBIDDEN' })
  await run('comment remove', { id: '101', commentId: '501' }, f); assert.ok(!f.messages.some(row => row.id === '501'))
  const readonly = fixture({ noComment: true }); await assert.rejects(run('comment create', { id: '101', text: '拒绝' }, readonly), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(readonly).length, 0)
})
test('collaboration quit removes only own relation and verifies both remaining-access branches', async () => {
  for (const inSpace of [false, true]) {
    const f = fixture({ inSpace }), result = await run('quit', { id: '101' }, f)
    assert.equal(result.result.quit, true); assert.equal(result.result.documentDeleted, false); assert.equal(result.result.remainingAccess, inSpace ? 'preview-through-other-permission' : 'no-preview')
    assert.equal(f.documents.length, 2); assert.equal(f.documents[1].members.length, 2); assert.equal(writes(f).length, 1)
  }
  for (const options of [{ ignoreWrite: true }, { inSpace: true, keepMember: true }]) {
    const f = fixture(options); await assert.rejects(run('quit', { id: '101' }, f), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(f).length, 1)
  }
})
test('collaboration write consent, dry-run and unknown outcome never replay requests', async () => {
  const f = fixture(); await run('quit', { id: '101' }, f, { approved: false, dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('quit', { id: '101' }, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const timeout = fixture({ timeout: true }); await assert.rejects(run('quit', { id: '101' }, timeout), error => error.details.writeOutcome === 'unknown-do-not-retry'); assert.equal(writes(timeout).length, 1)
  const raw = catalog.operations.find(op => op.route.endsWith('/cooperateList') && op.method === 'GET')
  await assert.rejects(executeOperation(ctx, raw, {}, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
test('public collaboration commands enforce knowledge feature, expiry and overcapacity', async () => {
  for (const [options, code] of [[{ disabled: true }, 'FEATURE_DISABLED'], [{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY']]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('list'), {}, session, { transport: f.transport }), { code }); assert.ok(!f.calls.some(call => call.path === base + '/cooperateList'))
  }
})
