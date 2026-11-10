import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectUpload, storageOptions, uploadToStorage } from '../dist/storage.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { operationOutput, catalog } from '../dist/operations.js'
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture-rsq-token', identity: { userId: '1', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const uid = c => c.repeat(32), categoryId = uid('a'), fileId = uid('b'), versionId = uid('c')
const certificate = () => ({ bucket: 'fixture-bucket', prefix: 'file/fixture', storage: 'oss', endpoint: 'https://oss-cn-beijing.aliyuncs.com', credentials: { AccessKeyId: 'fixture-id', AccessKeySecret: 'fixture-secret', SecurityToken: 'fixture-sts', Expiration: new Date(Date.now() + 3600000).toISOString() } })
const withFile = async fn => { const dir = await mkdtemp(join(tmpdir(), 'rsq-upload-')); const path = join(dir, '测试.txt'); try { await writeFile(path, 'file-data'); await fn(path, dir) } finally { await rm(dir, { recursive: true, force: true }) } }
const run = (input, transport, uploadTransfer, command = 'deliverable file upload') => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, uploadTransfer })

test('upload preflight hashes real bytes and rejects empty files, directories, missing sources and invalid names', async () => withFile(async (path, dir) => {
  const local = await inspectUpload(path); assert.equal(local.name, '测试.txt'); assert.equal(local.size, 9); assert.match(local.md5, /^[a-f0-9]{32}$/)
  await assert.rejects(inspectUpload(dir), { code: 'INVALID_FILE' })
  await assert.rejects(inspectUpload(path, 'bad/path.txt'), { code: 'INVALID_FILE' })
  await writeFile(path, ''); await assert.rejects(inspectUpload(path), { code: 'INVALID_FILE' })
  let called = false
  await assert.rejects(run({ projectId: '9001', categoryId, localFile: join(dir, 'missing') }, async () => { called = true }), { code: 'FILE_READ_ERROR' })
  assert.equal(called, false)
}))

test('temporary storage credentials have a fixed OSS destination and raw CLI output never contains them', async () => withFile(async path => {
  const raw = certificate(), options = storageOptions(raw)
  assert.equal(options.options.retryMax, 0); assert.equal(options.options.stsToken, 'fixture-sts')
  for (const endpoint of ['https://evil.example', 'http://oss-cn-beijing.aliyuncs.com', 'https://oss-cn-beijing.aliyuncs.com@evil.example', 'https://oss-cn-beijing.aliyuncs.com:444', 'https://oss-cn-beijing.aliyuncs.com/path']) assert.throws(() => storageOptions({ ...raw, endpoint }), { code: 'STORAGE_ORIGIN_MISMATCH' })
  assert.throws(() => storageOptions({ ...raw, storage: 'minio' }), { code: 'STORAGE_UNSUPPORTED' })
  const op = catalog.operations.find(op => op.command === 'file upload context'), output = JSON.stringify(operationOutput(op, raw))
  assert.ok(!output.includes('fixture-secret') && !output.includes('fixture-id') && !output.includes('fixture-sts') && !output.includes('credentials'))
  const local = await inspectUpload(path); await writeFile(path, 'changed')
  await assert.rejects(uploadToStorage(raw, local, () => {}), { code: 'CONTEXT_CONFLICT' })
}))

test('second-pass miss uploads bytes exactly once then registers and reads back; hit skips both storage and registration', async () => withFile(async path => {
  for (const hit of [false, true]) for (const replace of [false, true]) {
    const calls = []; let transfers = 0
    const file = () => ({ fileId, projectId: 9001, versions: [{ versionId, fileName: '测试.txt', isLatest: true }] })
    const transport = async (url, init) => {
      calls.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body) })
      if (url.pathname.endsWith('/kanbanChildCrud/list')) return json([{ id: 8001, name: '交付物', type: 'deliverable' }])
      if (url.pathname.endsWith('/category/tree')) return json([{ categoryId, type: 'common', children: [] }])
      if (url.pathname.endsWith('/secondPass')) return json({ secondPass: hit, file: hit ? { fileId } : null })
      if (url.pathname === '/task/sts/token/oss') return json(certificate())
      if (init.method === 'GET') return json(file())
      if (url.pathname.endsWith('/file/upload') || init.method === 'PUT') return json(file())
      throw Error('Unexpected HTTP')
    }
    const result = await run({ projectId: '9001', ...(replace ? { fileId } : { categoryId }), localFile: path }, transport, async (cert, file, progress) => {
      transfers++; assert.equal(cert.credentials.AccessKeyId, 'fixture-id'); assert.equal(file.size, 9); progress({ objectPath: 'file/fixture/unique.txt' });
      return { path: 'file/fixture/unique.txt', size: file.size, md5: file.md5, mode: 'put' }
    }, replace ? 'deliverable file replace' : 'deliverable file upload')
    assert.equal(result.result.fileId, fileId); assert.equal(result.resources.fileId, fileId); assert.equal(transfers, hit ? 0 : 1)
    assert.equal(calls.filter(call => call.path === '/task/sts/token/oss').length, hit ? 0 : 1)
    assert.equal(calls.filter(call => call.path.endsWith('/file/upload') || call.method === 'PUT').length, hit ? 0 : 1)
    const registered = calls.find(call => call.path.endsWith('/file/upload') || call.method === 'PUT')
    if (registered) { assert.equal(registered.body.filePath, 'file/fixture/unique.txt'); assert.ok(!Object.hasOwn(registered.body, 'md5')) }
    assert.ok(!JSON.stringify(result).includes('fixture-secret'))
  }
}))

test('failed transfer reports partial progress and unknown outcome without registering or replaying', async () => withFile(async path => {
  const { RsqError } = await import('../dist/core.js'); let writes = 0, uploads = 0
  const transport = async (url, init) => {
    if (init.method === 'POST') writes++
    if (url.pathname.endsWith('/list')) return json([{ id: 8001, name: '交付物', type: 'deliverable' }])
    if (url.pathname.endsWith('/tree')) return json([{ categoryId, type: 'common' }])
    if (url.pathname.endsWith('/secondPass')) return json({ secondPass: false, file: null })
    if (url.pathname === '/task/sts/token/oss') return json(certificate())
    throw Error('Registration must not occur')
  }
  await assert.rejects(run({ projectId: '9001', categoryId, localFile: path }, transport, async (_cert, _local, progress) => {
    uploads++; progress({ objectPath: 'file/fixture/unique.txt', uploadId: 'private-upload-id' }); throw new RsqError('STORAGE_TRANSFER_UNKNOWN', 'upload interrupted', 5)
  }), error => {
    assert.equal(error.details.failedStep, 'stored'); assert.equal(error.details.writeOutcome, 'unknown'); assert.equal(error.details.resources.objectPath, 'file/fixture/unique.txt'); assert.equal(error.details.resources.uploadId, 'private-upload-id');
    assert.equal(error.details.automaticRollback, false); assert.ok(!JSON.stringify(error.details).includes('fixture-secret')); return true
  })
  assert.equal(uploads, 1); assert.equal(writes, 1)
}))
