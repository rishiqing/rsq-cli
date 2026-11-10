import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { prepareWorkflowContext } from '../dist/workflow-context.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', accessToken: 'fixture-token', identity: { userId, teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify({ code: 200, data }), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, options = {}) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, ...options })
const groups = [{ id: '7001', type: 'ungrouped', groupList: [] }]
const source = { id: '8001', name: 'original', mode: 0, editControl: { flowConfig: true, copyFlow: true, infoConfig: true, removeFlow: true } }
test('workflow template application discovers IDs and covers, retains the creator and validates copied mode', async () => {
  let writes = 0, calls = 0
  const templates = { custom: [{ childCover: [{ id: '9001', name: 'configured', mode: 0 }] }], normal: [] }
  const transport = async (url, init) => {
    calls++
    if (url.pathname.endsWith('/template/list')) return json(templates)
    if (url.pathname.endsWith('/application/all')) return json(groups)
    if (url.pathname.endsWith('/application/covers')) return json([{ cover: 'server-cover' }])
    if (url.pathname.endsWith('/application') && init.method === 'POST') {
      writes++; const body = JSON.parse(init.body)
      assert.equal(body.templateId, '9001'); assert.equal(body.parentGroupId, '7001'); assert.equal(body.cover, 'server-cover')
      assert.equal(body.memberIds, userId + ',2'); assert.equal(body.deptIds, ''); assert.equal(body.isStar, false)
      return json({ id: '8002', name: 'created' })
    }
    if (url.pathname.endsWith('/application')) return json({ id: '8002', name: 'created', mode: 0 })
    if (url.pathname.endsWith('/form/list') || url.pathname.endsWith('/recursive/tree/list')) return json([])
    throw Error('unexpected request')
  }
  const input = { templateId: '9001', name: 'created', memberIds: '2,2' }
  await run('workflow template apply', input, transport, { dryRun: true }); assert.equal(calls, 0)
  const result = await run('workflow template apply', input, transport)
  assert.equal(result.resources.applicationId, '8002'); assert.equal(writes, 1)
  writes = 0
  await assert.rejects(run('workflow template apply', { ...input, templateId: '9999' }, transport), { code: 'CONTEXT_MISSING' })
  assert.equal(writes, 0)
  templates.custom[0].childCover[0].skipUrl = 'https://example.invalid/consult'
  await assert.rejects(run('workflow template apply', input, transport), { code: 'UNSUPPORTED_BUSINESS_FLOW' })
  assert.equal(writes, 0)
})
test('workflow clone and destructive removal require resource permissions and explicit confirmation', async () => {
  let calls = 0
  await assert.rejects(run('workflow application remove', { applicationId: '8001' }, async () => { calls++; return json(source) }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(calls, 0)
  await assert.rejects(run('workflow application clone', { applicationId: '8001', name: 'copy' }, async url => {
    calls++; return json(url.pathname.endsWith('/all') ? groups : { ...source, editControl: { copyFlow: false } })
  }), { code: 'FORBIDDEN' })
  assert.equal(calls, 2)
  assert.throws(() => prepareWorkflowContext('workflow-application-clone', { applicationId: '8001', name: 'copy', groupId: '9999' }, { source: { data: source }, groups: { data: groups } }, session), { code: 'CONTEXT_MISSING' })
  assert.equal(catalog.operations.find(op => op.method === 'GET' && op.route === '/task/workflow/application').effect, 'write')
  assert.equal(catalog.operations.find(op => op.method === 'GET' && op.route === '/task/workflow/application/all').effect, 'write')
})
test('template application refuses conflicting definitions for the same template ID across catalogue groups', () => {
  const template = { id: '9001', name: 'configured', mode: 0 }
  const results = { templates: { data: { custom: [{ childCover: [template] }], normal: [{ childCover: [{ ...template, mode: 1 }] }] } } }
  assert.throws(() => prepareWorkflowContext('workflow-template-apply', { templateId: '9001', name: 'new' }, results, session), { code: 'CONTEXT_CONFLICT' })
})
test('form cloning rejects cross-application context and retains a new resource ID after readback failure', async () => {
  let copies = 0, forms = [{ id: '8101', name: 'form' }]
  const original = { id: '8101', name: 'form', fields: [{ id: '8201', name: 'text', type: 1 }] }
  const transport = async url => {
    if (url.pathname.endsWith('/application')) return json(source)
    if (url.pathname.endsWith('/form/list')) return json(forms)
    if (url.pathname.endsWith('/form/form/copy')) { copies++; return json({ ...original, id: '8102' }) }
    if (url.pathname.endsWith('/form')) return json(url.searchParams.get('id') === '8101' ? original : { ...original, id: '8102' })
    throw Error('unexpected request')
  }
  await assert.rejects(run('workflow form clone', { applicationId: '8001', formId: '9999' }, transport), { code: 'CONTEXT_MISSING' })
  assert.equal(copies, 0)
  await assert.rejects(run('workflow form clone', { applicationId: '8001', formId: '8101' }, transport), error => {
    assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED'); assert.equal(error.details.resources.formId, '8102'); assert.equal(error.details.failedStep, 'copiedForm'); return true
  })
  assert.equal(copies, 1)
})
