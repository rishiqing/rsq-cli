import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeWorkflowTemplates } from '../dist/workflow-templates.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
const longId = '9223372036854775801'
const blank = { id: '1', name: '标准模式', mode: 0, cover: 'https://images.invalid/blank.png' }
const named = { id: longId, name: '项目审批', mode: 1, cover: null }
const consultation = { id: '3', name: '咨询定制', mode: 0, skipUrl: 'https://example.invalid/consult' }
const fixture = () => ({ templates: { data: { custom: [{ id: 'empty', name: '空白模板', childCover: [blank] }], normal: [{ id: '11', name: '业务模板', childCover: [named, consultation] }] } }, covers: { data: [{ cover: 'https://images.invalid/application.jpg', displayOrder: 1 }] } })
test('template context separates catalogue ownership, blank classification and customer application context', () => {
  const result = describeWorkflowTemplates({}, fixture())
  assert.equal(result.groups[0].section, 'custom')
  assert.equal(result.templates[0].catalogueScope, 'platform')
  assert.deepEqual(result.templates[1].application.fixedInput, { templateId: longId })
  assert.equal(result.templates[1].application.creates, 'customer-owned-workflow-application')
  assert.equal(result.maintenance.templateIdIsNotApplicationId, true)
  assert.equal(result.maintenance.customerCatalogueMutationExposed, false)
  assert.equal(result.maintenance.platformGenerationRouteExposed, false)
  for (const command of result.maintenance.appliedApplicationCommands.concat(result.maintenance.definitionCommands)) assert.ok(workflows.workflows.some(flow => flow.command === command), command)
})
test('explicit template inspection retains long IDs and marks consultation entries as inapplicable', () => {
  assert.equal(describeWorkflowTemplates({ templateId: longId }, fixture()).selected.id, longId)
  assert.equal(describeWorkflowTemplates({ templateId: '3' }, fixture()).selected.application.supported, false)
  assert.throws(() => describeWorkflowTemplates({ templateId: '4' }, fixture()), { code: 'RESOURCE_NOT_VISIBLE' })
})
test('templates legitimately assigned to several groups are merged only if their business definition agrees', () => {
  const results = fixture()
  results.templates.data.normal.push({ id: '12', name: '另一分组', childCover: [{ ...named }] })
  assert.deepEqual(describeWorkflowTemplates({}, results).templates.find(row => row.id === longId).groupIds, ['11', '12'])
  results.templates.data.normal[1].childCover[0].mode = 0
  assert.throws(() => describeWorkflowTemplates({}, results), { code: 'CONTEXT_MISSING' })
})
test('missing classification, truncated fields, duplicate group members and unsafe numeric identifiers stop discovery', () => {
  const transforms = [
    r => { delete r.templates.data.normal },
    r => { r.templates.data.normal[0].childCover[0].id = Number(longId) },
    r => { r.templates.data.normal[0].childCover[0].mode = null },
    r => { r.templates.data.normal[0].childCover.push({ ...named }) },
    r => { r.templates.data.normal.push({ id: '11', name: 'duplicate', childCover: [] }) },
    r => { r.covers.data[0].cover = null },
  ]
  for (const transform of transforms) { const results = structuredClone(fixture()); transform(results); assert.throws(() => describeWorkflowTemplates({}, results), { code: 'CONTEXT_MISSING' }) }
})
test('template business commands share the reviewed read contracts, preserve the list command and have zero HTTP dry-run', async () => {
  const results = fixture(), ctx = { environment: 'production', profile: 'fixture' }
  const session = { method: 'password', accessToken: 'private-token', identity: { userId: '7', teamId: '9', username: 'fixture' } }
  const flow = workflows.workflows.find(flow => flow.command === 'workflow template inspect')
  let calls = 0
  const transport = async (url, init) => {
    calls++; assert.equal(init.method, 'GET')
    return new Response(JSON.stringify({ code: 200, data: url.pathname.endsWith('/template/list') ? results.templates.data : results.covers.data }), { headers: { 'content-type': 'application/json' } })
  }
  await runWorkflow(ctx, flow, { templateId: longId }, session, { transport, dryRun: true }); assert.equal(calls, 0)
  assert.equal((await runWorkflow(ctx, flow, { templateId: longId }, session, { transport })).result.selected.id, longId)
  assert.equal(calls, 2)
  assert.equal(workflows.workflows.find(flow => flow.command === 'workflow template list').outputAdapter, undefined)
})
