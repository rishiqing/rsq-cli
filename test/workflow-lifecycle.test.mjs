import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { prepareWorkflowLifecycle, workflowDefinitionVersion, validateWorkflowFields } from '../dist/workflow-lifecycle.js'
const ctx = { environment: 'production', profile: 'fixture' }, userId = '9223372036854775801'
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId, teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = data => new Response(JSON.stringify({ code: 200, data }), { headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, approved = false) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, approved })
const source = { id: '8001', name: 'app', mode: 0, editControl: { flowConfig: true, initProcess: true } }
test('workflow form creation encodes named nested types and explicit options, then independently checks definitions', async () => {
  let form, creates = 0, reads = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/application')) return json(source)
    if (url.pathname.endsWith('/form/list')) return json([{ id: '8101' }])
    if (init.method === 'POST') {
      creates++; const body = JSON.parse(init.body)
      assert.equal(body.fields[0].type, 2); assert.equal(body.fields[0].decimalNum, 0)
      assert.equal(body.fields[1].tables[0].type, 4); assert.equal(body.fields[1].tables[0].selector[0].value, 'approved')
      form = { ...body, id: '8101', fields: body.fields.map((f, i) => ({ ...f, id: String(8201 + i) })) }
      return json(form)
    }
    reads++; return json(form)
  }
  const input = { applicationId: '8001', name: 'fields', fields: [{ name: 'amount', type: 'Number', decimalNum: 0, isRequired: false }, { name: 'rows', type: 'Table', tables: [{ name: 'decision', type: 'Menu', selector: [{ name: 'approved' }] }] }] }
  const flow = workflows.workflows.find(flow => flow.command === 'workflow form define')
  await runWorkflow(ctx, flow, input, null, { dryRun: true, transport: async () => { throw Error('offline') } })
  assert.deepEqual([creates, reads], [0, 0])
  const result = await run('workflow form define', input, transport)
  assert.equal(result.resources.formId, '8101'); assert.deepEqual([creates, reads], [1, 1])
  assert.ok(workflowSchema(flow).inputSchema.$defs)
})
test('a local field edit preserves other definitions, uses expected-version conflicts and never sends VO values', async () => {
  const original = { id: '8101', name: 'form', fields: [{ id: '8201', name: 'text', type: 1, value: 'private-value', factor: 'saved-factor', isRequired: false }, { id: '8202', name: 'formula', type: 24, factor: 'formula-factor', formula: { text: '2', factors: [] } }] }
  let updates = 0, written
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/application')) return json(source)
    if (url.pathname.endsWith('/form/list')) return json([{ id: '8101' }])
    if (init.method === 'PUT') { updates++; written = JSON.parse(init.body); return json(written) }
    return json(written ?? original)
  }
  const input = { applicationId: '8001', formId: '8101', fieldId: '8201', patch: { name: 'changed' }, expectedDefinition: workflowDefinitionVersion(original) }
  await assert.rejects(run('workflow form field configure', { ...input, expectedDefinition: '0'.repeat(64) }, transport, true), { code: 'CONTEXT_CONFLICT' })
  assert.equal(updates, 0)
  await run('workflow form field configure', input, transport, true)
  assert.equal(updates, 1); assert.equal(written.fields[0].value, undefined); assert.equal(written.fields[0].factor, 'saved-factor')
  assert.deepEqual(written.fields[1].formula, original.fields[1].formula); assert.equal(written.fields[1].id, '8202')
})
const process = { id: '9001', flowAppId: '8001', name: 'instance', status: 'doing', processInfoStepList: [{ id: '9101', status: 'doing' }], editControl: { closeProcess: true } }
const instance = { id: '9101', processInfoId: '9001', applicationId: '8001', formId: '8101', status: 'doing', editControl: { fillStepForm: true } }
test('instance fill validates resource ownership, resolves option values and encodes an actual clear', async () => {
  const form = { formId: '8101', editControl: { fillStepForm: true }, fields: [{ id: '8201', type: 4, name: 'state', selector: [{ id: '8301', name: 'approved', value: 'opaque-approved' }], value: '' }] }
  let writes = 0, body, cross = false
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/details')) return json(process)
    if (url.pathname.endsWith('/step')) return json({ ...instance, processInfoId: cross ? '9999' : '9001' })
    if (init.method === 'PUT') { writes++; body = JSON.parse(init.body); form.fields[0].value = body.value; return json(form.fields[0]) }
    return json(form)
  }
  const input = { processId: '9001', stepId: '9101', fieldId: '8201', value: 'approved' }
  await run('workflow instance fill', input, transport); assert.equal(body.value, 'opaque-approved')
  await run('workflow instance fill', { ...input, value: null }, transport); assert.equal(body.value, '')
  await assert.rejects(run('workflow instance fill', { ...input, value: 'missing-option' }, transport), { code: 'INVALID_INPUT' })
  cross = true; await assert.rejects(run('workflow instance fill', input, transport), { code: 'CONTEXT_MISSING' }); assert.equal(writes, 2)
})
test('advancing a workflow requires current action permission, required values and independent final-state readback', async () => {
  let actionAllowed = true, form = { formId: '8101', fields: [{ id: '8201', name: 'required', type: 1, value: '', isRequired: true }] }, operated = 0, validated = 0, final = process
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/details')) return json(final)
    if (url.pathname.endsWith('/step')) return json(instance)
    if (url.pathname.endsWith('/auditsAndForms')) return json(form)
    if (url.pathname.endsWith('/reverse/list')) return json([])
    if (url.pathname.endsWith('/formulaValidate')) { validated++; return json([]) }
    if (init.method === 'PUT') { operated++; final = { ...process, status: 'finished', processInfoStepList: [{ id: '9101', status: 'passed' }] }; return json({ processStatus: 'finished', currentStepStatus: 'passed' }) }
    return json({ finish: actionAllowed, finished: false })
  }
  const input = { processId: '9001', stepId: '9101', action: 'finish' }
  await assert.rejects(run('workflow instance act', input, transport), { code: 'CONFIRMATION_REQUIRED' })
  await assert.rejects(run('workflow instance act', input, transport, true), { code: 'INVALID_INPUT' }); assert.deepEqual([operated, validated], [0, 0])
  form.fields[0].value = 'ready'; actionAllowed = false
  await assert.rejects(run('workflow instance act', input, transport, true), { code: 'FORBIDDEN' }); assert.deepEqual([operated, validated], [0, 0])
  actionAllowed = true
  const result = await run('workflow instance act', input, transport, true)
  assert.equal(result.result.status, 'finished'); assert.deepEqual([operated, validated], [1, 1])
})
test('destructive form removal refuses a live step dependency even when the server would allow it', () => {
  assert.throws(() => prepareWorkflowLifecycle('workflow-lifecycle-form-remove', { applicationId: '8001', formId: '8101' }, { source: { data: source }, forms: { data: [{ id: '8101' }] }, steps: { data: [{ id: '8401', formId: '8101' }] } }, session), { code: 'DEPENDENCY_EXISTS' })
})
test('close sends only the checked instance id and reopen uses the real GET write protocol', async () => {
  let actual = { ...process, editControl: { closeProcess: true, restartProcess: true } }, writes = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/details')) return json(actual)
    writes++
    if (url.pathname.endsWith('/close')) { assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { id: '9001' }); actual = { ...actual, status: 'suspended' } }
    else { assert.ok(url.pathname.endsWith('/activate')); assert.equal(init.method, 'GET'); assert.equal(url.searchParams.get('processInfoId'), '9001'); actual = { ...actual, status: 'doing' } }
    return json('ok')
  }
  await assert.rejects(run('workflow instance close', { processId: '9001' }, transport), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(writes, 0)
  await run('workflow instance close', { processId: '9001' }, transport, true)
  await run('workflow instance reopen', { processId: '9001' }, transport, true)
  assert.equal(writes, 2)
})

test('workflow required table columns cannot be omitted and new cells carry the real id=0 protocol', () => {
 const table = { id: '8201', name: 'rows', type: 20, tables: [{ id: '8301', name: 'required', type: 1, isRequired: true }, { id: '8302', name: 'optional', type: 2 }], tableRows: [{ '2-1': { value: 0 } }] }
 assert.throws(() => validateWorkflowFields([table]), { code: 'INVALID_INPUT' })
 table.tableRows[0]['1-0'] = { value: 'filled' }
 validateWorkflowFields([table])
 const results = { process: { data: { id: '8501', flowAppId: '8001', processInfoStepList: [{ id: '8601' }] } }, instanceStep: { data: { id: '8601', processInfoId: '8501', applicationId: '8001', formId: '8101' } }, instanceForm: { data: { formId: '8101', fields: [table], editControl: { fillStepForm: true } } } }
 const filled = prepareWorkflowLifecycle('workflow-lifecycle-fill', { applicationId: '8001', processId: '8501', stepId: '8601', fieldId: '8201', rows: [{ required: 'filled', optional: 0 }] }, results, session)
 assert.deepEqual(filled.body.tableRows, [{ '1-0': { id: '0', value: 'filled' }, '2-1': { id: '0', value: 0 } }])
})
