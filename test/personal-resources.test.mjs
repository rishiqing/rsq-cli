import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  let favorites = options.favorites ?? [{ id: 101, name: '链接 A', type: 'link', displayOrder: 100, creator: 81, realPath: 'https://a.invalid/' }, { id: 102, name: '链接 B', type: 'link', displayOrder: 200, creator: 81, realPath: 'https://b.invalid/' }]
  let inspirations = options.inspirations ?? [{ id: 201, name: '灵感 A', note: '{"ops":[{"insert":"保留内容\\n"}]}', color: 1, cover: '', displayOrder: 200 }, { id: 202, name: '灵感 B', note: '', color: 2, cover: '', displayOrder: 100 }]
  const calls = []
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}, favorite = url.pathname.includes('myCollection'), list = favorite ? favorites : inspirations
    calls.push({ method: init.method, path: url.pathname + url.search, body })
    if (init.method === 'GET') {
      if (url.pathname.endsWith('/folder/file')) return json({ id: url.searchParams.get('id'), name: '可见.txt', size: 1 })
      if (url.pathname.endsWith('/status')) return json({ isCollected: false })
      return json(list)
    }
    if (options.networkFailure) throw Error('unknown outcome')
    if (init.method === 'DELETE') {
      const id = url.searchParams.get('id')
      if (!options.ignoreWrite) { if (favorite) favorites = favorites.filter(item => String(item.id) !== id); else inspirations = inspirations.filter(item => String(item.id) !== id) }
      return favorite ? new Response(null) : json({ success: true })
    }
    if (init.method === 'POST') {
      const created = favorite ? { id: 103, name: body.name ?? '原资源', type: body.collectedType, displayOrder: 50, creator: 81, invalid: false, fileId: body.fileId, docId: body.docId, realPath: body.realPath } : { id: 203, ...body, displayOrder: 300 }
      if (!options.ignoreWrite) list.unshift(created)
      return json(created)
    }
    const id = body.moveId ?? body.id, item = list.find(item => String(item.id) === id)
    if (!item) throw Error('foreign write was dispatched')
    if (!options.ignoreWrite) {
      for (const [key, value] of Object.entries(body)) if (!['id','moveId','frontId','nextId'].includes(key)) item[key] = value
      if (body.frontId || body.nextId) {
        const front = list.find(row => String(row.id) === body.frontId), next = list.find(row => String(row.id) === body.nextId)
        item.displayOrder = front && next ? (front.displayOrder + next.displayOrder) / 2 : front ? front.displayOrder + (favorite ? 100 : -100) : next.displayOrder + (favorite ? -100 : 100)
        list.sort((a,b) => favorite ? a.displayOrder - b.displayOrder : b.displayOrder - a.displayOrder)
      }
    }
    return json(favorite ? { displayOrder: item.displayOrder } : item)
  }
  return { transport, calls, inspirations: () => inspirations, favorites: () => favorites }
}
const run = (command, input, f, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { approved: true, transport: f.transport, ...options })
test('favorites preserve business references and hide file temporary URLs while links remain usable', async () => {
  const f = fixture({ favorites: [{ id: 101, name: '文件', type: 'file', creator: 81, displayOrder: 100, fileId: 91, realPath: 'https://private.invalid/?signature=secret' }] })
  const listed = await run('favorite list', {}, f)
  assert.equal(listed.result.items[0].fileId, 91)
  assert.ok(!JSON.stringify(listed).includes('signature'))
  const added = await run('favorite add link', { name: '链接', url: 'https://www.rishiqing.com/app/todo' }, f)
  assert.equal(added.result.url, 'https://www.rishiqing.com/app/todo')
  assert.deepEqual(f.calls.find(call => call.method === 'POST').body, { collectedType: 'link', name: '链接', realPath: 'https://www.rishiqing.com/app/todo' })
  await assert.rejects(run('favorite add file', { fileId: '91' }, f), { code: 'ALREADY_EXISTS' })
  await assert.rejects(run('favorite add link', { name: '无效', url: 'https://user:pass@example.invalid/' }, f), { code: 'INVALID_INPUT' })
})
test('personal write targets and neighbor IDs must come from the current user list', async () => {
  for (const [command, input] of [['favorite remove',{ id: '999' }], ['favorite move',{ id: '101', beforeId: '999' }], ['inspiration update',{ id: '999', patch: { name: '不允许' } }], ['inspiration remove',{ id: '999' }]]) {
    const f = fixture()
    await assert.rejects(run(command, input, f), { code: 'FORBIDDEN' })
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0)
  }
  const f = fixture({ favorites: [{ id: 101, type: 'link', creator: 82, displayOrder: 100 }] })
  await assert.rejects(run('favorite remove', { id: '101' }, f), { code: 'CONTEXT_MISSING' })
  assert.equal(f.calls.length, 1)
})
test('move constructs both adjacent IDs from the actual ordering and detects concurrent or ignored updates', async () => {
  for (const [command, id, beforeId] of [['favorite move','102','101'], ['inspiration move','202','201']]) {
    const f = fixture(), result = await run(command, { id, beforeId }, f)
    const body = f.calls.find(call => call.method === 'PUT').body
    assert.equal(body.nextId, beforeId)
    assert.equal(Object.hasOwn(body, 'frontId'), false)
    assert.equal(result.result.order[0], id)
    await assert.rejects(run(command, { id, beforeId }, fixture({ ignoreWrite: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
  }
  await assert.rejects(run('favorite move', { id: '101', beforeId: '102', afterId: '102' }, fixture()), { code: 'INVALID_INPUT' })
})
test('inspiration text becomes the current editor Delta, rich content stays intact, and partial edits preserve fields', async () => {
  const f = fixture(), created = await run('inspiration create', { name: '新灵感', text: '第一行\r\n第二行', color: 3 }, f)
  assert.deepEqual(JSON.parse(created.result.note), { ops: [{ insert: '第一行\n第二行\n' }] })
  const delta = { ops: [{ insert: '有格式', attributes: { bold: true } }, { insert: '\n' }] }
  await run('inspiration update', { id: '201', patch: { delta } }, f)
  assert.deepEqual(JSON.parse(f.inspirations().find(item => item.id === 201).note), delta)
  assert.equal(f.inspirations().find(item => item.id === 201).color, 1)
  await run('inspiration update', { id: '201', patch: { text: '' } }, f)
  assert.deepEqual(JSON.parse(f.inspirations().find(item => item.id === 201).note), { ops: [{ insert: '\n' }] })
  await assert.rejects(run('inspiration create', { text: 'x', delta }, f), { code: 'INVALID_INPUT' })
  await assert.rejects(run('inspiration create', {}, f), { code: 'INVALID_INPUT' })
  await assert.rejects(run('inspiration update', { id: '201', patch: { delta: { ops: [{ delete: 2 }] } } }, f), { code: 'INVALID_INPUT' })
})
test('writes require independent state assertions, never replay unknown outcomes, and expose gated HTTP aliases', async () => {
  const ignored = fixture({ ignoreWrite: true })
  await assert.rejects(run('inspiration update', { id: '201', patch: { name: '未保存' } }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' })
  const f = fixture({ networkFailure: true })
  await assert.rejects(run('favorite add link', { name: '新链接', url: 'https://c.invalid/' }, f), error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown' && error.details.failedStep === 'created')
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  const noNetwork = { transport: async () => { throw Error('offline') } }
  const dry = await run('inspiration create', { text: '草稿' }, noNetwork, { dryRun: true })
  assert.equal(dry.dryRun, true)
  await assert.rejects(run('inspiration remove', { id: '201' }, noNetwork, { approved: false }), { code: 'CONFIRMATION_REQUIRED' })
  const alias = catalog.operations.find(op => op.method === 'DELETE' && op.route === '/task/v3/myCollection/{id}')
  await assert.rejects(executeOperation(ctx, alias, { path: { id: '101' } }, session, { approved: true, transport: noNetwork.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
})
