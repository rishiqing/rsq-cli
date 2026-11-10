import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workflows, runWorkflow } from '../dist/workflows.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const file = id => ({ id, name: 'fixture.txt', size: 9, realPath: 'https://private.invalid?signature=hidden' })
const input = { projectId: '7001', taskId: 'task-1', fieldId: '7101' }
const fixture = ({ hit = false, concurrent = false, allowed = true } = {}) => {
  const calls = []; let fields = [{ id: '7101', type: 6, name: '附件', editControl: { canEdit: true }, files: [file('7201')] }], reads = 0, transfers = 0
  const transport = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body) })
    if (url.pathname.endsWith('/kanbanCrud')) return json({ id: '7001', coverId: null })
    if (url.pathname.endsWith('/task')) return json({ id: 'task-1', from: { projectId: '7001' } })
    if (url.pathname.endsWith('/task/template')) {
      if (++reads === 2 && concurrent) fields[0].files.push(file('7209'))
      return json({ templateFields: fields })
    }
    if (url.pathname.endsWith('/upload/check')) return json({ canUpload: allowed })
    if (url.pathname.endsWith('/secondPass')) return json({ secondPass: hit, file: hit ? file('7202') : null })
    if (url.pathname.endsWith('/sts/token/oss')) return json({ storage: 'oss', bucket: 'fixture-bucket', prefix: 'file/fixture', credentials: { AccessKeyId: 'fixture', AccessKeySecret: 'secret', SecurityToken: 'fixture-sts', Expiration: new Date(Date.now() + 3600000).toISOString() } })
    if (url.pathname.endsWith('/getAliFile') || url.pathname.endsWith('/folder/file')) return json(file('7202'))
    if (url.pathname.endsWith('/template/field')) { fields[0].files = JSON.parse(init.body).value.split(',').filter(Boolean).map(file); return json(null) }
    throw Error('Unexpected request ' + url.pathname)
  }
  const uploadTransfer = async (_certificate, local) => { transfers++; return { path: 'file/fixture/object.txt', size: local.size, md5: local.md5, mode: 'put' } }
  return { calls, transport, uploadTransfer, transfers: () => transfers }
}
const run = (command, args, f) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), args, session, { transport: f.transport, uploadTransfer: f.uploadTransfer, approved: true })
const withFile = async fn => { const dir = await mkdtemp(join(tmpdir(), 'rsq-attachment-')); try { const path = join(dir, 'fixture.txt'); await writeFile(path, 'file-data'); await fn(path) } finally { await rm(dir, { force: true, recursive: true }) } }
test('task attachment upload preserves existing files and independently reads the association; second-pass skips transfer and registration', async () => withFile(async localFile => {
  for (const hit of [true, false]) {
    const f = fixture({ hit }), result = await run('task attachment upload', { ...input, localFile }, f)
    assert.deepEqual(result.result.files.map(file => file.id), ['7201','7202'])
    assert.equal(result.resources.fileId, '7202')
    assert.equal(f.transfers(), hit ? 0 : 1)
    assert.equal(f.calls.filter(call => call.path.endsWith('/getAliFile')).length, hit ? 0 : 1)
    assert.equal(f.calls.find(call => call.path.endsWith('/secondPass')).body.taskId, input.taskId)
    assert.equal(f.calls.find(call => call.path.endsWith('/template/field')).body.value, '7201,7202')
    assert.ok(!JSON.stringify(result).includes('private.invalid'))
  }
}))
test('extension denial occurs before file creation, and concurrent attachment changes return the saved file without overwriting or replaying', async () => withFile(async localFile => {
  const denied = fixture({ allowed: false })
  await assert.rejects(run('task attachment upload', { ...input, localFile }, denied), { code: 'FORBIDDEN' })
  assert.equal(denied.calls.filter(call => call.method === 'POST').length, 0)
  const conflict = fixture({ hit: true, concurrent: true })
  await assert.rejects(run('task attachment upload', { ...input, localFile }, conflict), error => error.code === 'CONTEXT_CONFLICT' && error.details.resources.fileId === '7202')
  assert.equal(conflict.calls.filter(call => call.path.endsWith('/template/field')).length, 0)
  assert.equal(conflict.calls.filter(call => call.path.endsWith('/secondPass')).length, 1)
}))
test('attachment removal changes only the chosen field reference and requires confirmation', async () => {
  const f = fixture()
  const result = await run('task attachment remove', { ...input, fileId: '7201' }, f)
  assert.deepEqual(result.result.files, [])
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1)
  assert.equal(f.calls.some(call => call.method === 'DELETE'), false)
  await assert.rejects(runWorkflow(ctx, workflows.workflows.find(flow => flow.command === 'task attachment remove'), { ...input, fileId: '7201' }, session, { transport: async () => { throw Error('no request') } }), { code: 'CONFIRMATION_REQUIRED' })
})
