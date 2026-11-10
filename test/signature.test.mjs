import { CookieJar } from 'tough-cookie'
const signatureTestJar = new CookieJar(); signatureTestJar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { prepareWorkflowLifecycle } from '../dist/workflow-lifecycle.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: signatureTestJar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.parse('2035-01-01T00:00:00Z') }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
const flow = action => workflows.workflows.find(row => row.command === 'signature ' + action)
function fixture(options = {}) {
  const calls = [], registered = new Map(), files = new Map([['501', { id: 501, name: 'signature.png', size: png.length, creatorId: options.foreignFile ? 82 : 81 }]])
  const state = { deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: 1, userLimit: 10, mainApp: 'rsq', vt: '7', uploadImgSize: options.tooLarge ? 1 : 1048576, uploadFileSize: 1048576, cloudSize: 10485760 }
  const transport = async (url, init) => {
    const body = init.body ? init.headers.get('content-type') === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams), body })
    switch (url.pathname) {
      case '/task/login/authAjax': return json({ success: true, id: options.wrongIdentity ? 82 : 81, username: 'fixture', team: { id: 7, name: '公司' }, token: 'fixture' })
      case '/task/ordercenter/v2/member/state/independent': return json(state)
      case '/task/v1/folder/file/used': return json({ used: options.full ? 10485760 : 0, max: 10485760, percent: options.full ? '100%' : '0%' })
      case '/task/files/file/upload/check': return json({ canUpload: !options.disabledType })
      case '/task/sts/token/oss': return json({ credentials: { AccessKeyId: 'temporary', AccessKeySecret: 'temporary', SecurityToken: 'temporary', Expiration: '2035-01-01T00:00:00Z' }, bucket: 'fixture', prefix: 'fixture', storage: 'oss' })
      case '/task/v1/folder/file/getAliFile': {
        assert.equal(body.folderId, undefined); assert.equal(body.filePath, 'fixture/signature.png')
        const row = { id: 502, name: body.fileName, size: png.length, creatorId: 81 }
        files.set('502', row); return json(options.badReceipt ? { id: 502 } : row)
      }
      case '/task/v1/folder/file': return json(files.get(url.searchParams.get('id')))
      case '/task/file/signature': {
        assert.equal(init.headers.get('content-type'), 'application/json')
        assert.equal(typeof body.fileId, 'number')
        if (options.unknownRegister) throw new Error('disconnected after server acceptance')
        registered.set(body.fromWhere, body.fileId); return new Response(null, { status: 200 })
      }
      case '/task/file/signature/getFront': {
        const fileId = options.conflictLatest ? '503' : registered.get(url.searchParams.get('fromWhere')) ?? '501'
        return json({ fileId, realPath: 'https://private.invalid/signature?secret=signed' })
      }
      default: throw new Error('Unexpected signature HTTP: ' + url.pathname)
    }
  }
  return { calls, transport, registered }
}
const run = (action, input, f, options = {}) => runWorkflow(ctx, flow(action), { businessUnit: 'workflow', ...input }, session, { transport: f.transport, ...options })

test('signature latest verifies actual creator and redacts private paths for all three business scopes', async () => {
  for (const businessUnit of ['task', 'workflow', 'performance']) {
    const f = fixture(), result = await run('latest', { businessUnit }, f)
    assert.equal(result.result.fileId, '501'); assert.equal(result.result.businessUnit, businessUnit)
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/getFront')).query, { fromWhere: businessUnit })
    assert.ok(!JSON.stringify(result).includes('signed')); assert.ok(!JSON.stringify(result).includes('private.invalid'))
  }
  await assert.rejects(run('latest', {}, fixture({ foreignFile: true })), { code: 'FORBIDDEN' })
})
test('signature registration requires confirmation, sends numeric JSON and preserves independent business pointers', async () => {
  const f = fixture()
  await assert.rejects(run('register', { fileId: '501' }, f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const result = await run('register', { fileId: '501' }, f, { approved: true })
  assert.equal(result.result.fileId, '501'); assert.equal(f.calls.filter(call => call.path === '/task/file/signature').length, 1)
  assert.deepEqual(f.calls.find(call => call.path === '/task/file/signature').body, { fromWhere: 'workflow', fileId: 501 })
  assert.equal(f.registered.has('task'), false); assert.equal(f.registered.has('performance'), false)
  const foreign = fixture({ foreignFile: true }); await assert.rejects(run('register', { fileId: '501' }, foreign, { approved: true }), { code: 'FORBIDDEN' })
  assert.ok(!foreign.calls.some(call => call.path === '/task/file/signature'))
})
test('signature dry-run is offline and never reads the image, obtains storage credentials or writes', async () => {
  const f = fixture()
  await run('upload', { localFile: '/no-such-signature.png' }, f, { dryRun: true }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('upload', { localFile: '/no-such-signature.png' }, f), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('signature PNG upload verifies current quotas, standalone file ownership and HTTP registration without sockets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-signature-')), localFile = join(directory, 'signature.png')
  try {
    await writeFile(localFile, png)
    const f = fixture(); let stored = 0
    const result = await run('upload', { localFile }, f, { approved: true, uploadTransfer: async (_certificate, local, progress) => { stored++; progress({ objectPath: 'fixture/signature.png' }); return { path: 'fixture/signature.png', size: local.size, md5: local.md5, mode: 'put' } } })
    assert.equal(stored, 1); assert.equal(result.resources.fileId, '502'); assert.equal(result.result.file.size, png.length)
    assert.equal(f.calls.filter(call => call.path === '/task/v1/folder/file').length, 2)
    assert.equal(f.calls.filter(call => call.path === '/task/file/signature').length, 1)
    assert.ok(!JSON.stringify(result).includes('temporary'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('signature upload blocks image size, full storage, extension policy and malformed PNG before storage writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-signature-')), localFile = join(directory, 'signature.png')
  try {
    await writeFile(localFile, png)
    for (const [options, code] of [[{ tooLarge: true }, 'FILE_SIZE_LIMIT'], [{ full: true }, 'STORAGE_CAPACITY_LIMIT'], [{ disabledType: true }, 'FILE_TYPE_FORBIDDEN']]) {
      const f = fixture(options)
      await assert.rejects(run('upload', { localFile }, f, { approved: true, uploadTransfer: () => { throw Error('must not upload') } }), { code })
      assert.ok(!f.calls.some(call => call.path.includes('/sts/') || call.method === 'POST'))
    }
    await writeFile(localFile, 'not-png')
    const f = fixture(); await assert.rejects(run('upload', { localFile }, f, { approved: true }), { code: 'INVALID_SIGNATURE_FILE' }); assert.equal(f.calls.length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('signature unknown registration and conflicting independent readback retain resource IDs without replay', async () => {
  for (const [options, code] of [[{ unknownRegister: true }, 'NETWORK_ERROR'], [{ conflictLatest: true }, 'CONTEXT_CONFLICT']]) {
    const f = fixture(options)
    await assert.rejects(run('register', { fileId: '501' }, f, { approved: true }), error => { assert.equal(error.code, code); assert.equal(error.details.resources.fileId, '501'); assert.equal(error.details.automaticRollback, false); if (options.unknownRegister) assert.equal(error.details.writeOutcome, 'unknown'); return true })
    assert.equal(f.calls.filter(call => call.path === '/task/file/signature').length, 1)
  }
})
test('signature file creation receipt survives malformed response and is not followed by registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-signature-')), localFile = join(directory, 'signature.png')
  try {
    await writeFile(localFile, png); const f = fixture({ badReceipt: true })
    await assert.rejects(run('upload', { localFile }, f, { approved: true, uploadTransfer: async (_certificate, local) => ({ path: 'fixture/signature.png', size: local.size, md5: local.md5, mode: 'put' }) }), error => { assert.equal(error.code, 'RESPONSE_SCHEMA_MISMATCH'); assert.equal(error.details.resources.fileId, '502'); return true })
    assert.ok(!f.calls.some(call => call.path === '/task/file/signature'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('signature public dispatch applies company expiry and prevents raw registration from bypassing ownership', async () => {
  const f = fixture({ expired: true })
  await assert.rejects(executeWorkflow(ctx, flow('latest'), { businessUnit: 'workflow' }, session, { transport: f.transport }), { code: 'COMPANY_EXPIRED' })
  assert.ok(!f.calls.some(call => call.path.startsWith('/task/file/')))
  const raw = fixture()
  await assert.rejects(executeOperation(ctx, catalog.operations.find(op => op.method === 'POST' && op.route === '/task/file/signature'), { body: { fromWhere: 'workflow', fileId: '501' } }, session, { transport: raw.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.equal(raw.calls.length, 0)
})
test('workflow signing accepts only the current workflow signature and verifies actual file ownership before action', () => {
  const input = { processId: '101', stepId: '201', action: 'agree', useLastSignature: true }
  const results = { process: { data: { id: 101, flowAppId: 301, processInfoStepList: [{ id: 201 }], isAgreeSignature: true } }, instanceStep: { data: { id: 201, applicationId: 301, processInfoId: 101 } }, actions: { data: { agree: true } }, validated: { data: [] }, signature: { fileId: 501, realPath: 'private' }, signatureFile: { id: 501, name: 'signature.png', size: 68, creatorId: 81 } }
  assert.deepEqual(prepareWorkflowLifecycle('workflow-lifecycle-signature', input, results, session), { query: { fromWhere: 'workflow' } })
  assert.deepEqual(prepareWorkflowLifecycle('workflow-lifecycle-signature-file', input, results, session), { query: { id: '501' } })
  assert.equal(prepareWorkflowLifecycle('workflow-lifecycle-act', input, results, session).body.signatureFileId, '501')
  assert.throws(() => prepareWorkflowLifecycle('workflow-lifecycle-signature-file', { ...input, signatureFileId: '502' }, results, session), { code: 'CONTEXT_CONFLICT' })
  assert.throws(() => prepareWorkflowLifecycle('workflow-lifecycle-act', input, { ...results, signatureFile: { ...results.signatureFile, creatorId: 82 } }, session), { code: 'FORBIDDEN' })
  assert.throws(() => prepareWorkflowLifecycle('workflow-lifecycle-signature', { ...input, action: 'finish' }, { ...results, actions: { data: { finish: true } } }, session), { code: 'INVALID_INPUT' })
})
