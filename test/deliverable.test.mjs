import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { prepareDeliverable, verifyDeliverable } from '../dist/deliverable.js'
const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const envelope = data => data === null ? new Response('') : json(data)
const uid = value => value.repeat(32), allId = uid('a'), parentId = uid('b'), childId = uid('c'), fileId = uid('d'), versionId = uid('e')
const run = (command, input, transport, approved = false, dryRun = false) => runWorkflow(ctx, workflows.workflows.find(f => f.command === command), input, session, { transport, approved, dryRun })
const context = () => ({ modules: [{ id: 8001, name: '交付物', type: 'deliverable' }], tree: [{ categoryId: allId, type: 'all', children: [] }, { categoryId: parentId, name: 'parent', type: 'common', children: [{ categoryId: childId, name: 'child', type: 'common', children: [] }] }],
  baselines: [], file: { fileId, projectId: 9001, fileNumber: '', versions: [{ versionId, fileName: 'fixture.txt', isLatest: true, description: 'keep', versionMajor: null, versionMinor: null, versionPatch: null }] } })

test('ordinary project and project template delivery lifecycles resolve the actual module ID and read back category/baseline writes', async () => {
  const calls = []; let sequence = 1
  for (const template of [false, true]) {
    let enabled = false; const categories = [], baselines = []
    const prefix = template ? 'project template deliverable ' : 'deliverable ', input = template ? { coverId: '6001' } : { projectId: '9001' }, project = template ? '7001' : '9001'
    const transport = async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({ method: init.method, path: url.pathname, body })
      if (url.pathname === '/task/v4/template') return json({ id: 6001, templateKanbanId: 7001, name: 'fixture', withEdit: true })
      if (url.pathname.endsWith('/kanbanChildCrud/list')) {
        assert.equal(url.searchParams.get('kanbanId'), project)
        assert.equal(init.headers.get('Plan-Type'), template ? 'template' : null)
        return json(enabled ? [{ id: 8001, name: '交付物', type: 'deliverable' }] : [])
      }
      if (url.pathname.includes('/plan/deliverable/')) { assert.equal(String(body.projectId), project); enabled = url.pathname.endsWith('/open'); return envelope(null) }
      if (url.pathname.endsWith('/category/tree')) return envelope(categories)
      if (url.pathname.endsWith('/category/list')) return envelope(categories)
      if (url.pathname.endsWith('/baseline/list')) { assert.equal(url.searchParams.get('planId'), '8001'); return envelope(baselines) }
      if (url.pathname.endsWith('/category')) {
        if (init.method === 'POST') { assert.equal(String(body.projectId), project); const item = { categoryId: String(sequence++).padStart(32, '0'), name: body.name, type: 'common', children: [] }; categories.push(item); return envelope(item) }
        const index = categories.findIndex(item => item.categoryId === (body?.categoryId ?? url.searchParams.get('categoryId')))
        if (init.method === 'PUT') { categories[index].name = body.name; return envelope(categories[index]) }
        assert.equal(init.method, 'DELETE'); categories.splice(index, 1); return envelope(null)
      }
      if (url.pathname.endsWith('/baseline')) {
        if (init.method === 'POST') { assert.equal(String(body.planId), '8001'); assert.ok(['ignore', 'snapshot', 'useLatest'].includes(body.draftStrategy)); const item = { baselineId: String(sequence++).padStart(32, '0'), name: body.name, draftStrategy: body.draftStrategy }; baselines.push(item); return envelope(item) }
        const index = baselines.findIndex(item => item.baselineId === (body?.baselineId ?? url.searchParams.get('baselineId')))
        if (init.method === 'PUT') { baselines[index].name = body.name; return envelope(baselines[index]) }
        assert.equal(init.method, 'DELETE'); baselines.splice(index, 1); return envelope(null)
      }
      throw Error('Unexpected ' + url.pathname)
    }
    await run(prefix + 'enable', input, transport)
    const category = (await run(prefix + 'category create', { ...input, name: 'fixture' }, transport)).result
    assert.equal((await run(prefix + 'category rename', { ...input, categoryId: category.categoryId, name: 'updated' }, transport)).result.name, 'updated')
    for (const strategy of ['ignore', 'useLatest', 'snapshot']) {
      const baseline = (await run(prefix + 'baseline create', { ...input, name: 'baseline', draftStrategy: strategy }, transport)).result
      await run(prefix + 'baseline rename', { ...input, baselineId: baseline.baselineId, name: 'updated' }, transport)
      const discovered = (await run(prefix + 'context', input, transport)).result
      assert.equal(discovered.projectId, project); assert.equal(discovered.moduleId, '8001'); assert.equal(discovered.baselines[0].baselineId, baseline.baselineId)
      await run(prefix + 'baseline remove', { ...input, baselineId: baseline.baselineId }, transport, true)
    }
    await run(prefix + 'category remove', { ...input, categoryId: category.categoryId }, transport, true)
    await run(prefix + 'disable', input, transport, true)
    assert.equal(categories.length + baselines.length, 0)
  }
  assert.equal(calls.filter(call => call.path.endsWith('/baseline') && call.method === 'POST').length, 6)
})

test('category moves reject cycles, foreign/system targets and stale adjacency, and use backend frontId', () => {
  const results = context(), base = { projectId: '9001', categoryId: parentId, parentId: childId, frontId: null, nextId: null }
  assert.throws(() => prepareDeliverable('deliverable-category-move', base, results), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareDeliverable('deliverable-category-remove', { ...base, categoryId: allId }, results), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareDeliverable('deliverable-category-move', { ...base, categoryId: childId, parentId: null, frontId: null, nextId: null }, results), { code: 'CONTEXT_CONFLICT' })
  assert.throws(() => prepareDeliverable('deliverable-category-rename', { ...base, categoryId: uid('f') }, results), { code: 'CONTEXT_MISSING' })
  const args = prepareDeliverable('deliverable-category-move', { ...base, categoryId: childId, parentId: null, frontId: parentId, nextId: null }, results)
  assert.deepEqual(args.body, { categoryId: childId, parentId: null, frontId: parentId, nextId: null })
  assert.ok(!Object.hasOwn(args.body, 'previousId'))
  results.verifiedMove = [{ categoryId: allId, type: 'all' }, { categoryId: parentId, type: 'common' }, { categoryId: childId, type: 'common' }]
  verifyDeliverable({ projectId: '9001', categoryId: childId }, results, 'verifiedMove')
  results.verifiedMove.reverse()
  assert.throws(() => verifyDeliverable({ projectId: '9001', categoryId: childId }, results, 'verifiedMove'), { code: 'BUSINESS_ASSERTION_FAILED' })
})

test('file ownership, version membership, clearing and numeric patch completeness are checked before writes', () => {
  const results = context(), input = { projectId: '9001', fileId, versionId, patch: { description: '' } }
  assert.deepEqual(prepareDeliverable('deliverable-version-update', input, results).body, { fileId, versionId, description: '' })
  assert.throws(() => prepareDeliverable('deliverable-version-update', { ...input, patch: { versionMajor: 1 } }, results), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareDeliverable('deliverable-version-update', { ...input, versionId: uid('f') }, results), { code: 'CONTEXT_MISSING' })
  assert.throws(() => prepareDeliverable('deliverable-file-number', { ...input, projectId: '8001', fileNumber: 'x' }, results), { code: 'CONTEXT_MISSING' })
  results.verifiedVersion = { ...results.file, versions: [{ ...results.file.versions[0], description: '' }] }
  verifyDeliverable(input, results, 'verifiedVersion')
  const before = results.file.versions[0]
  results.verifiedVersion.versions = [{ ...before, versionId: uid('f'), isLatest: true }, { ...before, isLatest: false }]
  verifyDeliverable({ projectId: '9001', fileId }, results, 'verifiedVersion')
  assert.throws(() => verifyDeliverable({ projectId: '9001', fileId }, { ...results, verifiedVersion: results.file }, 'verifiedVersion'), { code: 'BUSINESS_ASSERTION_FAILED' })
})

test('delete requires an observed complete current file list; capped or missing readback never proves deletion', () => {
  const results = context(), input = { projectId: '9001', fileId }
  assert.equal(prepareDeliverable('deliverable-file-removal-list', input, results).query.categoryId, allId)
  results.membership = []
  assert.throws(() => prepareDeliverable('deliverable-file-remove', input, results), { code: 'CONTEXT_CONFLICT' })
  results.membership = [{ fileId }]
  assert.deepEqual(prepareDeliverable('deliverable-file-remove', input, results), { query: { fileId } })
  results.verifiedFileRemoved = []; verifyDeliverable(input, results, 'verifiedFileRemoved')
  results.verifiedFileRemoved = Array.from({ length: 1000 }, () => ({ fileId: uid('f') }))
  assert.throws(() => verifyDeliverable(input, results, 'verifiedFileRemoved'), { code: 'BUSINESS_ASSERTION_FAILED' })
})

test('destructive confirmation and offline dry-run precede HTTP; unknown writes are never retried', async () => {
  let writes = 0, reads = 0
  const transport = async (url, init) => {
    if (init.method === 'GET') { reads++; return url.pathname.endsWith('/list') ? json([{ id: 8001, name: '交付物', type: 'deliverable' }]) : envelope(context().tree) }
    writes++; throw Error('network disappeared')
  }
  await assert.rejects(run('deliverable category remove', { projectId: '9001', categoryId: childId }, transport), { code: 'CONFIRMATION_REQUIRED' })
  const dry = await run('deliverable category create', { projectId: '9001', name: 'fixture' }, transport, false, true)
  assert.equal(dry.dryRun, true); assert.equal(reads + writes, 0)
  await assert.rejects(run('deliverable category create', { projectId: '9001', name: 'fixture' }, transport), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.failedStep, 'changed'); assert.equal(error.details.writeOutcome, 'unknown'); assert.deepEqual(error.details.completedSteps, ['modules', 'tree']); return true
  })
  assert.equal(writes, 1)
})
