import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectOperationPages } from '../dist/pagination.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const op = catalog.operations.find(op => op.method === 'GET' && op.route === '/task/v1/notification/list')
const config = { limit: 3, cursorParameter: 'frontId', cursorField: 'id', pageSizeParameter: 'max' }
const row = id => ({ id, isRead: false }), json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
test('bounded cursor traversal rejects duplicate rows, unsafe numeric IDs and incomplete exhaustion', async () => {
  const calls = [], transport = async url => { calls.push(url.searchParams.get('frontId')); return json(calls.length === 1 ? [row('9007199254740993'),row('9007199254740992')] : [row('2')]) }
  assert.equal((await collectOperationPages(ctx, op, { query: { max: 2 } }, session, config, transport)).length, 3)
  assert.deepEqual(calls, [null,'9007199254740992'])
  await assert.rejects(collectOperationPages(ctx, op, { query: { max: 1 } }, session, config, async () => json([row('7')])), { code: 'PAGINATION_CHANGED' })
  await assert.rejects(collectOperationPages(ctx, op, { query: { max: 1 } }, session, { ...config, limit: 1 }, async () => json([row('7')])), { code: 'PAGINATION_LIMIT' })
  await assert.rejects(collectOperationPages(ctx, op, { query: { max: 1 } }, session, config, async () => json([row(9007199254740992)])), { code: 'PAGINATION_CHANGED' })
})
test('cursor traversal cannot replay a write or invoke undeclared cursor parameters', async () => {
  const offline = async () => { throw Error('network must remain unused') }
  for (const altered of [{ ...op, method: 'POST' }, { ...op, effect: 'write' }, { ...op, idempotency: 'unknown' }]) await assert.rejects(collectOperationPages(ctx, altered, { query: { max: 1 } }, session, config, offline), { code: 'INVALID_CONTRACT' })
  await assert.rejects(collectOperationPages(ctx, op, { query: { max: 1 } }, session, { ...config, cursorParameter: 'other' }, offline), { code: 'INVALID_CONTRACT' })
})
