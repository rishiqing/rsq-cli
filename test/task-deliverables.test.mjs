import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkflow, workflows } from '../dist/workflows.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), category = 'd'.repeat(32)
const input = { projectId: '7001', taskId: 't'.repeat(32) }
const flow = action => workflows.workflows.find(flow => flow.command === 'deliverable task ' + action)
const templateFlow = action => workflows.workflows.find(flow => flow.command === 'project template deliverable task ' + action)
function fixture(options = {}) {
  const calls = [], writes = []; let ids = [a], reads = 0, fileName = 'fixture.txt'
  const file = id => ({ fileId: id, projectId: options.foreignFile && id === b ? '7002' : '7001', versions: [{ versionId: 'e'.repeat(32), fileName, isLatest: true }] })
  const transport = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(new Headers(init.headers)), body })
    if (url.pathname.endsWith('/v4/template')) return json({ id: options.foreignCover ? 8002 : 8001, templateKanbanId: 7001, name: 'fixture-template', withEdit: options.readonly !== true })
    if (url.pathname.endsWith('/kanbanCrud')) return json({ id: '7001', coverId: options.foreignProjectCover ? '8002' : options.template ? '8001' : null })
    if (url.pathname.endsWith('/kanbanChildCrud/list')) return json(options.noModule ? [] : [{ id: '7101', type: 'deliverable', name: '交付物' }])
    if (url.pathname.endsWith('/api/v3/task')) return json({ id: input.taskId, from: { projectId: options.foreignTask ? '7002' : '7001' }, forbidEdit: options.forbidden === true })
    if (url.pathname.endsWith('/deliverable/files')) {
      if (++reads === 2 && options.conflict) ids.push('f'.repeat(32))
      return json({ isShow: options.hidden !== true, tables: [{ columnKey: 'name', name: 'name' }, { columnKey: 'realPath', name: 'realPath' }], tableRows: ids.map(id => ({ id, name: 'file-' + id[0], version: '最新版本', realPath: 'https://private.invalid?signature=secret' })) })
    }
    if (url.pathname.endsWith('/file/association')) {
      writes.push(calls.at(-1)); if (options.timeout) throw Error('lost after mutation')
      if (!options.badReadback) ids = init.method === 'POST' ? [...ids, body.fileIds] : ids.filter(id => id !== url.searchParams.get('fileIds'))
      return new Response(null, { status: 200 })
    }
    if (url.pathname.endsWith('/category/tree')) return json([{ categoryId: category, type: 'common', name: 'category', children: [] }])
    if (url.pathname.endsWith('/upload/secondPass')) { writes.push(calls.at(-1)); fileName = body.fileName; if (options.hit) ids.push(c); return json({ secondPass: options.hit === true, file: options.hit ? { fileId: c } : null }) }
    if (url.pathname.endsWith('/sts/token/oss')) return json({ storage: 'oss', bucket: 'fixture-bucket', prefix: 'file/fixture', credentials: { AccessKeyId: 'fixture', AccessKeySecret: 'secret', SecurityToken: 'fixture-sts', Expiration: new Date(Date.now() + 3600000).toISOString() } })
    if (url.pathname.endsWith('/file/upload')) { writes.push(calls.at(-1)); ids.push(c); fileName = body.fileName; return json(file(c)) }
    if (url.pathname.endsWith('/deliverable/file')) return json(file(url.searchParams.get('fileId')))
    throw Error('Unexpected HTTP ' + url.pathname)
  }
  return { calls, writes, transport }
}
const run = (action, args, server, extra = {}) => runWorkflow(ctx, flow(action), { ...input, ...args }, session, { transport: server.transport, approved: true, ...extra })
const runTemplate = (action, args, server, extra = {}) => runWorkflow(ctx, templateFlow(action), { coverId: '8001', taskId: input.taskId, ...args }, session, { transport: server.transport, approved: true, ...extra })
test('template associations resolve the cover independently and only legacy project reads receive Plan-Type', async () => {
  const server = fixture({ template: true })
  const linked = await runTemplate('link', { fileId: b }, server)
  assert.deepEqual(linked.result.tableRows.map(row => row.id), [a, b])
  const unlinked = await runTemplate('unlink', { fileId: b }, server)
  assert.deepEqual(unlinked.result.tableRows.map(row => row.id), [a])
  for (const call of server.calls) {
    const legacy = /\/kanbanCrud$|\/kanbanChildCrud\/list$/.test(call.path)
    assert.equal(call.headers['plan-type'], legacy ? 'template' : undefined, call.path)
    if (call.path.endsWith('/api/v3/task')) assert.equal(call.query.siteId, '7001')
  }
})
test('read-only template context is discoverable while maintenance and mismatched covers stop before mutation', async () => {
  const readonly = fixture({ template: true, readonly: true })
  assert.equal((await runTemplate('context', {}, readonly)).result.isShow, true)
  for (const action of ['link', 'unlink', 'upload']) {
    const server = fixture({ template: true, readonly: true })
    await assert.rejects(runTemplate(action, { ...(['link', 'unlink'].includes(action) ? { fileId: b } : { localFile: new URL(import.meta.url).pathname }) }, server), { code: 'BUSINESS_ASSERTION_FAILED' })
    assert.equal(server.calls.length, 1); assert.equal(server.writes.length, 0)
  }
  for (const options of [{ template: true, foreignCover: true }, { template: true, foreignProjectCover: true }, { template: false }, { template: true, foreignTask: true }]) {
    const server = fixture(options)
    await assert.rejects(runTemplate('link', { fileId: b }, server)); assert.equal(server.writes.length, 0)
  }
})
test('task deliverable context removes signed storage links and reports the actual UI entry', async () => {
  for (const hidden of [false, true]) {
    const server = fixture({ hidden }), output = await run('context', {}, server)
    assert.equal(output.result.isShow, !hidden); assert.ok(!JSON.stringify(output.result).includes('private.invalid')); assert.ok(!JSON.stringify(output.result).includes('realPath')); assert.equal(server.writes.length, 0)
  }
})
test('link and unlink preserve other task associations and the source file and versions', async () => {
  const server = fixture(), linked = await run('link', { fileId: b }, server)
  assert.deepEqual(linked.result.tableRows.map(row => row.id), [a, b]); assert.equal(server.writes[0].body.fileIds, b)
  const unlinked = await run('unlink', { fileId: b }, server)
  assert.deepEqual(unlinked.result.tableRows.map(row => row.id), [a]); assert.equal(server.writes[1].query.fileIds, b)
  assert.equal(server.calls.filter(call => call.path.endsWith('/deliverable/file') && call.method === 'DELETE').length, 0)
  assert.equal(server.calls.filter(call => call.path.endsWith('/deliverable/file') && call.method === 'GET').length, 4)
})
test('foreign targets, template projects, UI-hidden and forbidden tasks, duplicates and concurrent collections stop before association writes', async () => {
  for (const options of [{ foreignTask: true }, { foreignFile: true }, { template: true }, { noModule: true }, { hidden: true }, { forbidden: true }, { conflict: true }]) {
    const server = fixture(options); await assert.rejects(run('link', { fileId: b }, server)); assert.equal(server.writes.length, 0)
  }
  const duplicate = fixture(); await assert.rejects(run('link', { fileId: a }, duplicate), { code: 'INVALID_INPUT' }); assert.equal(duplicate.writes.length, 0)
})
test('unknown writes and inconsistent independent readback retain task/file IDs without a replay', async () => {
  for (const options of [{ timeout: true }, { badReadback: true }]) {
    const server = fixture(options)
    await assert.rejects(run('link', { fileId: b }, server), error => error.details.resources.fileId === b && error.details.resources.taskId === input.taskId && (!options.timeout || error.details.writeOutcome === 'unknown'))
    assert.equal(server.writes.length, 1)
  }
})
test('task upload and second-pass both carry the exact task and verify the automatic association', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-task-delivery-'))
  try {
    const localFile = join(directory, 'fixture.txt'); await writeFile(localFile, 'fixture-data')
    for (const template of [false, true]) for (const hit of [false, true]) {
      const server = fixture({ hit, template }); let transfers = 0
      const output = await (template ? runTemplate : run)('upload', { localFile, ...(!hit && { categoryId: category }) }, server, { uploadTransfer: async (_certificate, local) => { transfers++; return { path: 'file/fixture/bytes.txt', size: local.size, md5: local.md5, mode: 'put' } } })
      assert.equal(transfers, hit ? 0 : 1); assert.equal(output.resources.fileId, c)
      assert.deepEqual(output.result.association.tableRows.map(row => row.id), [a, c]); assert.ok(server.writes.every(call => call.body.taskId === input.taskId))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('unlink requires explicit confirmation and all dry-run commands have zero HTTP', async () => {
  await assert.rejects(runWorkflow(ctx, flow('unlink'), { ...input, fileId: b }, session, { transport: async () => { throw Error('No HTTP') } }), { code: 'CONFIRMATION_REQUIRED' })
  for (const action of ['context', 'link', 'unlink', 'upload']) await runWorkflow(ctx, flow(action), { ...input, ...(['link', 'unlink'].includes(action) && { fileId: b }), ...(action === 'upload' && { localFile: '/missing/file', categoryId: category }) }, session, { dryRun: true, transport: async () => { throw Error('No HTTP') } })
})
