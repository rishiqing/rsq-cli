import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog, runOperation, validateUploadFiles } from '../dist/operations.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const flow = workflows.workflows.find(flow => flow.command === 'datasheet import')
const run = (file, transport, options = {}) => runWorkflow(ctx, flow, { projectId: '7001', file }, session, { transport, ...options })
function fixture({ failureMessage = '', failSecondPack = false } = {}) {
  const calls = [], existing = [{ id: '7002', name: 'task', type: 'task' }], imported = ['dstFirst', 'dstSecond'].map((id, index) => ({ id: String(7101 + index), name: 'sheet-' + index, type: 'datasheet', datasheetInfo: { datasheetId: id, viewId: 'viwFixture' } }))
  let committed = false
  return { calls, transport: async (url, init) => {
    calls.push({ method: init.method, path: url.pathname })
    if (url.pathname === '/task/v1/kanbanCrud') return json({ id: '7001', name: 'fixture project' })
    if (url.pathname === '/task/v1/kanbanChildCrud/list') return json([...existing, ...committed ? imported : []])
    if (url.pathname === '/task/mt/datasheet/import') {
      assert.equal(init.method, 'POST'); assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('projectId'), '7001'); assert.equal(init.body.get('file').name, 'fixture.csv')
      assert.match(await init.body.get('file').text(), /中文/); assert.equal(init.headers.get('content-type'), null)
      committed = true
      return json({ success: true, code: 200, data: { results: imported, failureMessage } })
    }
    const id = url.pathname.split('/')[4]
    assert.ok(['dstFirst', 'dstSecond'].includes(id))
    if (id === 'dstSecond' && failSecondPack) return new Response('', { status: 503 })
    return json({ success: true, code: 200, data: { datasheet: { id, revision: 0, permissions: null }, snapshot: { datasheetId: id,
      meta: { fieldMap: { fldTitle: { id: 'fldTitle', type: 2, name: '标题' } }, views: [{ id: 'viwFixture', rows: [{ recordId: 'recFixture' }], columns: [{ fieldId: 'fldTitle' }] }] },
      recordMap: { recFixture: { id: 'recFixture', data: { fldTitle: [{ type: 1, text: '中文' }] } } } } } })
  } }
}
test('multipart import verifies every returned sheet through project membership and independent HTTP readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-import-')), file = join(directory, 'fixture.csv')
  try {
    await writeFile(file, '标题\n中文\n')
    const server = fixture(), result = await run(file, server.transport)
    assert.deepEqual(result.result.imported.map(item => [item.moduleId, item.datasheetId, item.fields, item.records]), [['7101', 'dstFirst', 1, 1], ['7102', 'dstSecond', 1, 1]])
    assert.equal(result.resources.module0Id, '7101'); assert.equal(result.resources.datasheet1Id, 'dstSecond')
    assert.equal(server.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(server.calls.filter(call => call.path.endsWith('/dataPack')).length, 2)
  } finally { await rm(directory, { recursive: true }) }
})
test('partial sheet success and failed readback retain all resource IDs and iteration progress without replaying the upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-import-')), file = join(directory, 'fixture.csv')
  try {
    await writeFile(file, '标题\n中文\n')
    for (const [options, code] of [[{ failureMessage: 'third sheet exceeds 20000 rows' }, 'PARTIAL_SUCCESS'], [{ failSecondPack: true }, 'HTTP_ERROR']]) {
      const server = fixture(options)
      await assert.rejects(run(file, server.transport), error => {
        assert.equal(error.code, code); assert.equal(error.details.resources.module0Id, '7101'); assert.equal(error.details.resources.module1Id, '7102')
        if (code === 'HTTP_ERROR') { assert.equal(error.details.completedIterations, 1); assert.equal(error.details.failedItemIndex, 1) }
        return true
      })
      assert.equal(server.calls.filter(call => call.method === 'POST').length, 1)
    }
  } finally { await rm(directory, { recursive: true }) }
})
test('invalid local upload formats and sizes stop before any HTTP; dry-run describes the multi-sheet loop offline', async () => {
  let requests = 0
  const transport = async () => { requests++; throw Error('unexpected HTTP') }
  await assert.rejects(run('/tmp/fixture.exe', transport), { code: 'INVALID_FILE' })
  await assert.rejects(run('/tmp/rsq-no-file.csv', transport), { code: 'FILE_READ_ERROR' })
  const directory = await mkdtemp(join(tmpdir(), 'rsq-import-')), file = join(directory, 'fixture.csv')
  try {
    await writeFile(file, '中文')
    const op = structuredClone(catalog.operations.find(op => op.route === '/task/mt/datasheet/import'))
    op.inputSchema.properties.files.properties.file['x-rsq-maxBytes'] = 2
    await assert.rejects(runOperation(ctx, op, { body: { projectId: '7001' }, files: { file } }, session, { transport }), { code: 'INVALID_FILE' })
  } finally { await rm(directory, { recursive: true }) }
  const preview = await run('/tmp/not-opened.csv', transport, { dryRun: true })
  assert.ok(preview.steps.some(step => step.context === 'iterate-fetched-context')); assert.equal(requests, 0)
})
test('CSV upload preserves Chinese with one UTF-8 BOM and leaves the local file untouched; original encoding is explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-import-')), file = join(directory, 'fixture.csv')
  const op = catalog.operations.find(op => op.route === '/task/mt/datasheet/import')
  const upload = async (bytes, encoding) => {
    await writeFile(file, bytes)
    const blobs = await validateUploadFiles(op, { files: { file }, ...(encoding && { fileEncodings: { file: encoding } }) })
    assert.deepEqual(await readFile(file), Buffer.from(bytes))
    return Buffer.from(await blobs.get('file').arrayBuffer())
  }
  try {
    const utf8 = Buffer.from('标题\n中文\n'), bom = Buffer.from([0xef, 0xbb, 0xbf]), expected = Buffer.concat([bom, utf8])
    assert.deepEqual(await upload(utf8), expected)
    assert.deepEqual(await upload(expected), expected)
    assert.deepEqual(await upload(utf8, 'original'), utf8)
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    await assert.rejects(upload(gbk), { code: 'INVALID_FILE' })
    assert.deepEqual(await upload(gbk, 'original'), gbk)
    const limited = structuredClone(op)
    limited.inputSchema.properties.files.properties.file['x-rsq-maxBytes'] = utf8.length
    await writeFile(file, utf8)
    await assert.rejects(validateUploadFiles(limited, { files: { file } }), { code: 'INVALID_FILE' })
    assert.equal((await validateUploadFiles(limited, { files: { file }, fileEncodings: { file: 'original' } })).get('file').size, utf8.length)
  } finally { await rm(directory, { recursive: true }) }
})
