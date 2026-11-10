import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { context } from '../dist/core.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
const ctx = context('production', 'fixture'), jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture-private-cookie; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture-private-token', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture-private-username' }, expiresAt: Date.now() + 3600000 }
const root = '/task/v1/corpus', summary = root + '/summary', shareId = 'a'.repeat(32), input = { spaceId: '101', id: '201' }, json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const flow = suffix => { const result = workflows.workflows.find(flow => flow.command === 'doc share ' + suffix); assert.ok(result); return result }
const run = (suffix, fixture, options = {}) => executeWorkflow(ctx, flow(suffix), input, session, { transport: fixture.transport, ...options })
function fixture(options = {}) {
  const calls = [], space = { id: 101, type: options.retired ? 'week' : 'essays', name: '知识库', creatorId: 81, canBeShared: !options.noSpaceShare, isRelease: !!options.published, editControl: { createNote: true } }, doc = { id: 201, corpusId: 101, isNoteBook: false, isShare: !!options.shared, encodeSummaryId: options.noUuid ? null : shareId, name: '分享测试', isDisplay: true, isOpenToMember: false, forbidEdit: false, editControl: { editNote: !options.noEdit, shareNote: !options.noShare } }
  let spaceReads = 0
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), headers = new Headers(init.headers), body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ path, method, query, body, headers: Object.fromEntries(headers) })
    if (path.endsWith('/authAjax')) return json({ id: 81, username: 'fixture', token: 'fixture-private-token', success: true, team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.over ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'KNOWLEDGE', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return json({ useCorpus: true })
    if (path === root + '/list') return json(options.notVisible ? [] : [space])
    if (path === root + '/101') { spaceReads++; if (options.spaceDrift && spaceReads >= 2) space.isRelease = true; return json(space) }
    if (path === summary + '/list') { assert.equal(query.corpusId, '101'); assert.equal(query.allData, 'true'); return json([doc]) }
    if (path === summary + '/authority') return json({ status: '', auth: { viewNote: true, editNote: true } })
    if (path === summary && method === 'GET') { assert.equal(query.id, '201'); return json(doc) }
    if (path === summary + '/201' && method === 'PUT') {
      assert.deepEqual(Object.keys(body), ['isShare'])
      if (options.writeTimeout) throw Error('fixture write timeout')
      if (!options.ignoreWrite) { doc.isShare = body.isShare; if (body.isShare && !doc.encodeSummaryId) doc.encodeSummaryId = shareId }
      return json(doc)
    }
    if (path === summary + '/getShareNote') {
      for (const field of ['token', 'username', 'cookie', 'authorization']) assert.equal(headers.get(field), null, 'anonymous ' + field)
      assert.deepEqual(query, { id: shareId })
      if (options.probeTimeout) throw Error('fixture probe timeout')
      if (options.probe404) return json({ code: 401002 }, 400)
      if (options.probeLogin) return json({ code: 401 }, 401)
      const accessible = options.publicStillReadable || !options.publicDenies && (doc.isShare && space.canBeShared || space.isRelease)
      return accessible ? json({ id: options.wrongPublicId ? 'b'.repeat(32) : shareId, name: doc.name, corpusId: 101, isNoteBook: false, isShare: doc.isShare, note: '<p>fixture public body</p>', editControl: {} }) : json({ code: 401029, message: '未分享' }, 400)
    }
    throw Error('Unexpected sharing request ' + method + ' ' + path)
  }
  return { calls, space, doc, transport }
}
test('document sharing enables and revokes through private readback and a credential-free public request', async () => {
  const f = fixture(), enabled = await run('enable', f, { approved: true })
  assert.equal(enabled.result.verified, true); assert.equal(enabled.result.isShare, true); assert.equal(enabled.result.anonymousAccess.accessible, true); assert.equal(enabled.result.anonymousAccess.credentialSent, false); assert.match(enabled.result.anonymousAccess.contentSha256, /^[a-f0-9]{64}$/)
  assert.equal(enabled.result.anonymousAccess.url, 'https://www.rishiqing.com/share/doc/' + shareId)
  const disabled = await run('disable', f, { approved: true }); assert.equal(disabled.result.isShare, false); assert.equal(disabled.result.anonymousAccess.accessible, false); assert.equal(disabled.result.anonymousAccess.verified, true); assert.equal(disabled.result.anonymousAccess.upstreamCode, '401029')
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 2)
  for (const secret of ['fixture-private-token', 'fixture-private-cookie', 'fixture-private-username']) assert.ok(!JSON.stringify(disabled).includes(secret))
})
test('document sharing reports published-space inheritance and blocks misleading single-document revocation', async () => {
  const f = fixture({ published: true }), status = await run('inspect', f)
  assert.equal(status.result.isShare, false); assert.equal(status.result.spacePublished, true); assert.equal(status.result.anonymousAccess.accessible, true); assert.equal(status.result.anonymousAccess.inheritedFromPublishedSpace, true)
  await assert.rejects(run('disable', f, { approved: true }), { code: 'PUBLISHED_SPACE' }); assert.ok(!f.calls.some(call => call.method === 'PUT'))
})
test('document sharing enforces visible current knowledge, space policy and both actual document permissions', async () => {
  for (const flag of ['noSpaceShare', 'noEdit', 'noShare', 'retired', 'notVisible', 'expired', 'over', 'disabled']) {
    const f = fixture({ [flag]: true }); await assert.rejects(run('enable', f, { approved: true })); assert.ok(!f.calls.some(call => call.method === 'PUT'))
  }
  const f = fixture({ spaceDrift: true }); await assert.rejects(run('enable', f, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.ok(!f.calls.some(call => call.method === 'PUT'))
})
test('document sharing never interprets missing data, login failure or timeout as revoked access', async () => {
  for (const flag of ['probe404', 'probeLogin', 'probeTimeout']) { const f = fixture({ shared: true, [flag]: true }); await assert.rejects(run('disable', f, { approved: true })); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1) }
  await assert.rejects(run('disable', fixture({ shared: true, publicStillReadable: true }), { approved: true }), { code: 'PUBLIC_ACCESS_REMAINS' })
  await assert.rejects(run('enable', fixture({ publicDenies: true }), { approved: true }), { code: 'VERIFICATION_FAILED' })
  await assert.rejects(run('enable', fixture({ wrongPublicId: true }), { approved: true }), { code: 'VERIFICATION_FAILED' })
  await assert.rejects(run('enable', fixture({ ignoreWrite: true }), { approved: true }), { code: 'VERIFICATION_FAILED' })
})
test('document sharing initializes current UUID on enable and does not guess legacy share identifiers', async () => {
  const absent = await run('inspect', fixture({ noUuid: true })); assert.equal(absent.result.anonymousAccess.verified, false); assert.equal(absent.result.anonymousAccess.reason, 'no-current-share-uuid')
  const initialized = await run('enable', fixture({ noUuid: true }), { approved: true }); assert.equal(initialized.result.anonymousAccess.shareId, shareId)
  const f = fixture({ shared: true }); const result = await run('enable', f, { approved: true }); assert.equal(result.result.changed, false); assert.equal(result.result.anonymousAccess.verified, true); assert.ok(!f.calls.some(call => call.method === 'PUT'))
})
test('document sharing confirmation, offline plans and raw transport guards cannot bypass business context', async () => {
  const f = fixture(); await assert.rejects(run('enable', f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const dry = await run('disable', f, { dryRun: true }); assert.equal(dry.dryRun, true); assert.equal(f.calls.length, 0)
  const raw = catalog.operations.find(op => op.route === summary + '/getShareNote' && op.method === 'GET'); await assert.rejects(executeOperation(ctx, raw, { query: { id: shareId } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
  const unknown = fixture({ writeTimeout: true }); await assert.rejects(run('enable', unknown, { approved: true }), error => { assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.resources.documentId, '201'); return true }); assert.equal(unknown.calls.filter(call => call.method === 'PUT').length, 1)
})
