import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'

const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const entry = { id: 701, resourceId: '91', userId: 81, type: 10, name: 'fixture.txt', realPath: 'https://private.invalid?signature=hidden' }
const run = (command, input, transport, approved = true) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, approved })

test('file removal checks actual removeFile permission and confirms the record without applying the resource-member filter', async () => {
  let removed = false
  const result = await run('file item remove', { fileId: '91' }, async (url, init) => {
    if (url.pathname.endsWith('/folder/file') && init.method === 'GET') return json({ id: '91', name: 'fixture.txt', size: 9, editControl: { removeFile: true } })
    if (url.pathname.endsWith('/folder/file') && init.method === 'DELETE') { assert.equal(url.searchParams.get('id'), '91'); removed = true; return new Response(null) }
    assert.ok(removed)
    assert.equal(url.searchParams.get('type'), '10')
    assert.equal(url.searchParams.has('userId'), false, 'the server already filters by deleting user; userId filters members')
    return json([entry])
  })
  assert.equal(result.result.removedFileId, '91')
  assert.equal(result.result.entries[0].resourceId, '91')
  assert.ok(!JSON.stringify(result).includes('signature'))
  let writes = 0
  await assert.rejects(run('file item remove', { fileId: '91' }, async (_url, init) => {
    if (init.method === 'DELETE') writes++
    return json({ id: '91', name: 'fixture.txt', size: 9, editControl: { removeFile: false } })
  }), { code: 'FORBIDDEN' })
  assert.equal(writes, 0)
})

test('purge binds both IDs and the deleting identity, never sends the type branch and verifies the record disappeared', async () => {
  for (const changed of [{ userId: '82' }, { type: 9 }, { resourceId: '92' }, { id: '702' }]) {
    let writes = 0
    await assert.rejects(run('recycle file purge', { fileId: '91', entryId: '701' }, async (_url, init) => {
      if (init.method === 'DELETE') writes++
      return json([{ ...entry, ...changed }])
    }), { code: 'CONTEXT_MISSING' })
    assert.equal(writes, 0)
  }
  let removed = false, writes = 0
  const result = await run('recycle file purge', { fileId: '91', entryId: '701' }, async (url, init) => {
    if (init.method === 'DELETE') {
      assert.deepEqual([...url.searchParams], [['id', '701']])
      writes++; removed = true; return new Response(null)
    }
    return json(removed ? [] : [entry])
  })
  assert.equal(writes, 1)
  assert.equal(result.result.purgedEntryId, '701')
  await assert.rejects(run('recycle file purge', { fileId: '91', entryId: '701' }, async () => { throw Error('no request before confirmation') }, false), { code: 'CONFIRMATION_REQUIRED' })
})

test('readback uncertainty never repeats file removal and pagination remains explicit', async () => {
  let writes = 0
  await assert.rejects(run('file item remove', { fileId: '91' }, async (url, init) => {
    if (url.pathname.endsWith('/recycleBin/list')) return json([])
    if (init.method === 'DELETE') { writes++; return new Response(null) }
    return json({ id: '91', name: 'fixture.txt', size: 9, editControl: { removeFile: true } })
  }), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.failedStep === 'removedEntry')
  assert.equal(writes, 1)
  const result = await run('recycle file list', { max: 1, cursor: '710' }, async url => {
    assert.equal(url.searchParams.get('lastDataId'), '710')
    return json([entry])
  })
  assert.equal(result.result.cursor, 701)
  assert.equal(result.result.mayHaveMore, true)
})
