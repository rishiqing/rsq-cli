import test from 'node:test'
import assert from 'node:assert/strict'
import { catalog, runOperation } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'
import { workflows } from '../dist/workflows.js'

const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const detail = catalog.operations.find(op => op.method === 'GET' && op.route === '/task/v1/kanbanCrud')
test('project discovery preserves actual resource kind despite the legacy header-dependent projection', async () => {
  const requests = []
  const transport = async (url, init) => {
    requests.push({ id: url.searchParams.get('id'), planType: init.headers.get('Plan-Type') })
    // Independently model the actual server decorator: even a template returns
    // null without the header; the task permission DTO has no template marker.
    const coverId = url.searchParams.get('id') === '7002' && init.headers.get('Plan-Type') === 'template' ? '8001' : null
    return new Response(JSON.stringify({ id: url.searchParams.get('id'), coverId }), { headers: { 'content-type': 'application/json' } })
  }
  for (const headers of [undefined, {}, { 'Plan-Type': 'ordinary' }]) {
    const ordinary = await runOperation(ctx, detail, { query: { id: '7001', isDefault: false }, ...(headers && { headers }) }, session, { transport })
    const template = await runOperation(ctx, detail, { query: { id: '7002', isDefault: false }, ...(headers && { headers }) }, session, { transport })
    assert.equal(ordinary.coverId, null)
    assert.equal(template.coverId, '8001')
  }
  assert.ok(requests.every(row => row.planType === 'template'))
  for (const op of catalog.operations.filter(op => op.method !== 'GET' && op.route === detail.route)) assert.equal(op.defaults?.headers?.['Plan-Type'], undefined, 'read projection must not change mutation semantics')
})
test('native project creation, modification and deletion cannot bypass their ordinary/template context workflows', async () => {
  let requests = 0
  const transport = async () => { requests++; throw Error('must not send HTTP') }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const op = catalog.operations.find(op => op.method === method && op.route === detail.route)
    const input = method === 'DELETE' ? { query: { id: '7001' } } : { body: { ...(method === 'PUT' ? { id: '7001' } : { attribute: 'person', templateKanbanId: '7002' }), name: 'owned-fixture' } }
    assert.ok(op.requiresBusinessContext?.length)
    assert.ok(op.requiresBusinessContext.every(command => workflows.workflows.some(flow => flow.command === command)))
    await assert.rejects(executeOperation(ctx, op, input, session, { approved: true, transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
    const plan = await executeOperation(ctx, op, input, session, { approved: true, dryRun: true, transport })
    assert.equal(plan.dryRun, true)
  }
  assert.equal(requests, 0)
})
