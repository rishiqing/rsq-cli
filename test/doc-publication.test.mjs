import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'publication-unit' }, root = '/task/v1/corpus', summary = root + '/summary'
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=private-cookie; Path=/; Secure', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'private-token', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'private-username' }, expiresAt: Date.now() + 3600000 }
const spaceUuid = 'a'.repeat(32), ids = { 201: 'b'.repeat(32), 202: 'c'.repeat(32), 301: 'd'.repeat(32) }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const flow = suffix => { const value = workflows.workflows.find(row => row.command === 'doc space publication ' + suffix); assert.ok(value); return value }
const run = (suffix, f, options = {}) => executeWorkflow(ctx, flow(suffix), { spaceId: '101' }, session, { transport: f.transport, ...options })
function fixture(options = {}) {
  const calls = [], space = { id: 101, name: 'Fixture library', type: options.retired ? 'week' : 'essays', canBeShared: true, isRelease: !!options.published, encodeCorpusId: options.published || options.existingUuid ? spaceUuid : null, editControl: { editCorpusPreferences: !options.forbidden } }
  const rows = [
    { id: 201, name: 'Individually shared', corpusId: 101, noteBookId: null, isNoteBook: false, isOpenToMember: !options.private ? false : true, isShare: !!options.individual, displayOrder: 30, editControl: {} },
    { id: 301, name: 'Folder', corpusId: 101, noteBookId: null, isNoteBook: true, isOpenToMember: false, isShare: false, displayOrder: 20, editControl: {} },
    { id: 202, name: 'Nested document', corpusId: 101, noteBookId: 301, isNoteBook: false, isOpenToMember: false, isShare: false, displayOrder: 10, editControl: {} },
  ]
  for (const row of rows) { row.creator = { id: options.notCreator ? 82 : 81 }; row.editControl.editNote = true }
  let spaceReads = 0
  const transport = async (url, init) => {
    const route = url.pathname, query = Object.fromEntries(url.searchParams), headers = new Headers(init.headers), method = init.method
    calls.push({ route, method, query, headers, body: init.body ? JSON.parse(init.body) : undefined })
    if (route === '/task/login/authAjax') return json({ success: true, id: 81, username: session.identity.username, token: session.accessToken, team: { id: 7, name: 'Fixture company' } })
    if (route === '/task/ordercenter/v2/member/state/independent') return json({ vt: 'vt_fixture', mainApp: 'rsq', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 23:59:59', usersCount: options.over ? 11 : 1, userLimit: 10 })
    if (route === '/task/ordercenter/v2/function/available') return json(options.disabled ? [{ funcName: 'KNOWLEDGE', status: 'disable' }] : [])
    if (route === '/task/authority/v3/authorities/company/current') return json({ useCorpus: true })
    if (route === root + '/list') return json(options.invisible ? [] : [space])
    if (route === root + '/101') {
      spaceReads++; if (options.drift && spaceReads === 2) space.name += ' changed'
      return json(space)
    }
    if (route === summary + '/list') { assert.equal(query.allData, 'true'); return json(rows.filter(row => query.noteBookId ? String(row.noteBookId) === query.noteBookId : row.noteBookId === null)) }
    if (route === summary + '/authority') return json({ status: options.previewDenied ? 'noAuth' : '', auth: { viewNote: !options.previewDenied } })
    if (route === summary) { const row = rows.find(row => String(row.id) === query.id); assert.ok(row); return json({ ...row, encodeSummaryId: ids[row.id], isDisplay: true }) }
    if (route === summary + '/201' && method === 'PUT') {
      assert.deepEqual(Object.keys(calls.at(-1).body), ['isOpenToMember'])
      if (!options.ignoreVisibilityWrite) rows[0].isOpenToMember = calls.at(-1).body.isOpenToMember
      return json(rows[0])
    }
    if (route === root + '/updateRelease') {
      assert.equal(method, 'PUT'); assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['corpusId', 'isRelease']); assert.equal(calls.at(-1).body.corpusId, '101')
      if (options.timeoutWrite) throw Error('lost write response')
      if (!options.ignoreWrite) { space.isRelease = calls.at(-1).body.isRelease; space.encodeCorpusId = spaceUuid }
      return json({ id: 101, encodeCorpusId: spaceUuid, isRelease: calls.at(-1).body.isRelease })
    }
    if ([root + '/getShareCorpus', root + '/getSharedSummarylist', summary + '/getShareNote'].includes(route)) {
      for (const key of ['token', 'username', 'cookie']) assert.equal(headers.get(key), null)
      if (options.proxy404) return new Response('not found', { status: 404 })
      if (options.login) return new Response(null, { status: 401 })
      if (route === root + '/getShareCorpus') {
        assert.deepEqual(query, { id: spaceUuid })
        return space.isRelease || options.stillPublic ? json({ id: spaceUuid, name: space.name, teamName: 'Fixture company', cover: null }) : json({ code: 403316 }, 400)
      }
      if (route === root + '/getSharedSummarylist') {
        assert.equal(query.corpusId, spaceUuid); assert.equal(query.allData, 'true')
        const selected = rows.filter(row => !row.isOpenToMember && (query.noteBookId ? ids[row.noteBookId] === query.noteBookId : row.noteBookId === null))
        const result = selected.map(row => ({ ...row, id: ids[row.id], corpusId: spaceUuid, noteBookId: row.noteBookId ? ids[row.noteBookId] : null }))
        if (options.badTree && !query.noteBookId) result.push({ ...result[0], id: 'e'.repeat(32) })
        return json(result)
      }
      const row = rows.find(row => ids[row.id] === query.id); assert.ok(row)
      return space.isRelease || row.isShare || options.stillDocumentPublic ? json({ ...row, id: options.wrongDocument ? 'e'.repeat(32) : query.id, note: '<p>own fixture body</p>' }) : json({ code: 401029 }, 400)
    }
    throw Error('Unexpected route: ' + route)
  }
  return { calls, space, rows, transport }
}
test('whole-library publication independently verifies root, nested full directory and document bodies without credentials', async () => {
  const f = fixture(), result = await run('enable', f, { approved: true })
  assert.equal(result.result.isRelease, true); assert.equal(result.result.publicationStateVerified, true)
  assert.equal(result.result.anonymousAccess.completeVisibleTreeCompared, true)
  assert.equal(result.result.anonymousAccess.nodes, 3); assert.equal(result.result.anonymousAccess.documents.length, 2)
  assert.equal(result.result.anonymousAccess.url, 'https://www.rishiqing.com/collect/' + spaceUuid)
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
  assert.ok(!JSON.stringify(result).includes('private-token')); assert.ok(!JSON.stringify(result).includes('private-cookie'))
})
test('unpublishing verifies same anonymous endpoint and each body, preserving independently shared links and their flags', async () => {
  const f = fixture({ published: true, individual: true }), result = await run('disable', f, { approved: true })
  assert.equal(result.result.isRelease, false); assert.equal(result.result.individualShareFlagsPreserved, true)
  assert.equal(result.result.anonymousAccess.accessible, false); assert.equal(result.result.anonymousAccess.verified, true)
  assert.equal(result.result.anonymousAccess.denialCauseVerified, false)
  assert.deepEqual(result.result.documentAccess.map(row => [row.documentId, row.accessible]), [['201', true], ['202', false]])
  assert.equal(f.rows[0].isShare, true); assert.equal(f.rows[1].isShare, false)
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
})
test('publication blocks the pinned server private-body defect before writing and checks UI permissions, visibility, current business and order restrictions', async () => {
  for (const flag of ['private', 'forbidden', 'expired', 'over', 'disabled', 'invisible', 'retired']) {
    const f = fixture({ [flag]: true }); await assert.rejects(run('enable', f, { approved: true }))
    assert.ok(!f.calls.some(call => call.method === 'PUT'))
  }
  const f = fixture({ private: true }); await assert.rejects(run('enable', f, { approved: true }), { code: 'PRIVATE_PUBLICATION_UNSAFE' })
})
test('publication rejects context drift, incomplete anonymous trees, wrong document identities and ignored writes', async () => {
  const drift = fixture({ drift: true }); await assert.rejects(run('enable', drift, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.ok(!drift.calls.some(call => call.method === 'PUT'))
  for (const flag of ['badTree', 'wrongDocument', 'ignoreWrite']) {
    const f = fixture({ [flag]: true }); await assert.rejects(run('enable', f, { approved: true }), { code: 'VERIFICATION_FAILED' }); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
  }
})
test('proxy errors, authentication denial and public content remaining never demonstrate successful revocation', async () => {
  for (const flag of ['proxy404', 'login', 'stillPublic', 'stillDocumentPublic']) {
    const f = fixture({ published: true, [flag]: true }); await assert.rejects(run('disable', f, { approved: true }))
    assert.ok(f.calls.filter(call => call.method === 'PUT').length <= 1)
  }
  const f = fixture({ timeoutWrite: true }); await assert.rejects(run('enable', f, { approved: true })); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
})
test('publication inspection distinguishes no UUID, ambiguous unavailable service and already published readback', async () => {
  const fresh = await run('inspect', fixture()); assert.equal(fresh.result.anonymousAccess.verified, false); assert.equal(fresh.result.anonymousAccess.reason, 'no-current-publication-uuid')
  const absent = await run('inspect', fixture({ existingUuid: true })); assert.equal(absent.result.anonymousAccess.verified, false); assert.equal(absent.result.anonymousAccess.denialCauseVerified, false)
  const published = fixture({ published: true }), same = await run('enable', published, { approved: true }); assert.equal(same.result.changed, false); assert.equal(same.result.anonymousAccess.verified, true); assert.ok(!published.calls.some(call => call.method === 'PUT'))
})
test('publication confirmation, offline plans and raw guards preserve the same business contract', async () => {
  const f = fixture(); await assert.rejects(run('enable', f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const plan = await executeWorkflow(ctx, flow('enable'), { spaceId: '101' }, null, { dryRun: true, transport: f.transport }); assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
  const op = catalog.operations.find(op => op.method === 'PUT' && op.route === root + '/updateRelease')
  await assert.rejects(executeOperation(ctx, op, { body: { corpusId: '101', isRelease: true } }, session, { approved: true, transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('document visibility uses the actual creator and UI permission, a sparse boolean patch and independent readback, preserving individual shares', async () => {
  const f = fixture({ individual: true }), operation = workflows.workflows.find(row => row.command === 'doc visibility set')
  const result = await executeWorkflow(ctx, operation, { spaceId: '101', id: '201', membersOnly: true }, session, { transport: f.transport, approved: true })
  assert.equal(result.result.document.isOpenToMember, true); assert.equal(result.result.document.isShare, true)
  assert.equal(result.result.anonymousAccessMayRemain, true); assert.equal(result.result.individualSharePreserved, true)
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
  const repeated = await executeWorkflow(ctx, operation, { spaceId: '101', id: '201', membersOnly: true }, session, { transport: f.transport, approved: true })
  assert.equal(repeated.result.changed, false); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
})
test('document visibility refuses a noncreator, lost preview permission and inherited publication, and does not turn ignored writes into success', async () => {
  const operation = workflows.workflows.find(row => row.command === 'doc visibility set')
  for (const flag of ['notCreator', 'previewDenied', 'published']) {
    const f = fixture({ [flag]: true }); await assert.rejects(executeWorkflow(ctx, operation, { spaceId: '101', id: '201', membersOnly: true }, session, { transport: f.transport, approved: true }))
    assert.ok(!f.calls.some(call => call.method === 'PUT'))
  }
  const f = fixture({ ignoreVisibilityWrite: true }); await assert.rejects(executeWorkflow(ctx, operation, { spaceId: '101', id: '201', membersOnly: true }, session, { transport: f.transport, approved: true }), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
})
