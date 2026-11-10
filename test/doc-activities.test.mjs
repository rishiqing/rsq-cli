import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { docActivityPage, describeDocActivities } from '../dist/doc-activities.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const row = id => ({ id, comment: '修改了内容', idOrContent: ['<p>HTML只作为数据</p>'], dateCreated: '2026.11.09 12:00', isNote: true, type: 10 })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const jar = new CookieJar(); jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const flow = workflows.workflows.find(row => row.command === 'doc activities list')
function fixture(options = {}) {
 const calls = [], records = Array.from({ length: 23 }, (_, index) => row(String(index + 1)))
 const transport = async (url, init) => {
  const path = url.pathname, query = Object.fromEntries(url.searchParams); calls.push({ method: init.method, path, query })
  if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
  if (path === '/task/v1/corpus/list') return json([{ id: 901, name: '文集', type: options.retired ? 'daily' : 'essays' }])
  if (path === '/task/v1/corpus/901') return json({ id: 901, name: '文集', type: 'essays' })
  if (path === '/task/v1/corpus/summary/list') return json([{ id: 101, name: '当前文档', corpusId: 901, noteBookId: null, isNoteBook: false }])
  if (path === '/task/v1/corpus/summary/authority') return json({ status: options.noPreview ? 'noPreview' : 'noEdit', auth: options.noPreview ? {} : { read: true } })
  if (path === '/task/v1/corpus/summary') return json({ id: 101, name: '当前文档', corpusId: options.foreign ? 999 : 901, corpusType: 'essays', isNoteBook: false, isDisplay: true })
  if (path.endsWith('/summary/actions')) {
   assert.equal(query.id, '101'); assert.equal(query.max, undefined)
   if (options.timeout) throw Error('history trigger failed')
   return json(records.filter(row => !query.lastId || options.ignoredCursor || BigInt(row.id) < BigInt(query.lastId)).slice(-10))
  }
  if (path.endsWith('/hasSummaryAction')) return json(options.badMore ? false : { hasSummaryAction: records.some(row => BigInt(row.id) < BigInt(query.lastId)) })
  throw Error('Unexpected activity HTTP ' + init.method + path)
 }
 return { calls, transport }
}
test('activity pages preserve long IDs and use oldest input ID as older cursor while presenting newest first', () => {
 const page = docActivityPage([row('9223372036854775805'), row('9223372036854775806')])
 const result = describeDocActivities(page, false)
 assert.deepEqual(result.activities.map(row => row.id), ['9223372036854775806', '9223372036854775805']); assert.equal(result.completeHistory, true)
 assert.equal(result.activities[0].contentHistory, true); assert.equal(result.contentHistoryRestoreVerified, false)
 for (const bad of [[row('1'), row('1')], [row('2'), row('1')], [row('9007199254740992' * 1)], [{ ...row('1'), isNote: false }], [{ ...row('1'), idOrContent: [{ script: 'x' }] }]]) assert.throws(() => docActivityPage(bad))
 assert.throws(() => docActivityPage([row('10')], '10')); assert.throws(() => describeDocActivities([], true))
})
test('scoped current-document activity paging independently exhausts 23 records without gaps or duplicates', async () => {
 const f = fixture(), all = []; let cursor
 do {
  const output = await runWorkflow(ctx, flow, { spaceId: '901', id: '101', ...(cursor && { cursor }) }, session, { transport: f.transport })
  all.push(...output.result.activities.map(row => row.id)); cursor = output.result.nextCursor
  assert.equal(output.result.completeHistory, false)
 } while (cursor)
 assert.deepEqual(all, Array.from({ length: 23 }, (_, index) => String(23 - index)))
 const requests = f.calls.filter(row => row.path.endsWith('/summary/actions'))
 assert.deepEqual(requests.map(row => row.query.lastId), [undefined, '14', '4'])
 assert.equal(f.calls.filter(row => row.path.endsWith('/hasSummaryAction')).length, 2)
})
test('activity input, permission, scope, cursor and malformed continuation stop without replay', async () => {
 for (const [options, input] of [[{ noPreview: true }, {}], [{ foreign: true }, {}], [{ retired: true }, {}], [{ ignoredCursor: true }, { cursor: '14' }], [{ badMore: true }, {}]]) {
  const f = fixture(options)
  await assert.rejects(runWorkflow(ctx, flow, { spaceId: '901', id: '101', ...input }, session, { transport: f.transport }))
  assert.ok(f.calls.filter(row => row.path.endsWith('/summary/actions')).length <= 1)
 }
 const failed = fixture({ timeout: true })
 await assert.rejects(runWorkflow(ctx, flow, { spaceId: '901', id: '101' }, session, { transport: failed.transport }))
 assert.equal(failed.calls.filter(row => row.path.endsWith('/summary/actions')).length, 1)
})
test('activity discovery and schema disclose materializing GET; dry-run is offline and native bypass is blocked', async () => {
 const f = fixture(); assert.ok(flow); assert.equal(flow.effect, 'write')
 const plan = await executeWorkflow(ctx, flow, { spaceId: '901', id: '101' }, session, { dryRun: true, transport: f.transport })
 assert.equal(plan.dryRun, true); assert.equal(f.calls.length, 0)
 const op = catalog.operations.find(row => row.method === 'GET' && row.route.endsWith('/summary/actions'))
 assert.equal(op.effect, 'write'); assert.equal(op.idempotency, 'unknown')
 await assert.rejects(executeOperation(ctx, op, { query: { id: '101' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
 assert.equal(f.calls.length, 0)
})
