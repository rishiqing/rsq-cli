import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkflowGraph, parseWorkflowGraph } from '../dist/workflow-graph.js'
import { prepareWorkflowLifecycle } from '../dist/workflow-lifecycle.js'
const application = { id: '8001', name: '<流程 & "应用">', editControl: { flowConfig: true } }
const steps = [{ id: '8101', name: '<填写 & "内容">' }, { id: '8102', name: '确认' }]
const links = [{ from: 'start', to: '8101' }, { from: '8101', to: '8102' }, { from: '8102', to: 'end' }]
test('workflow graph roundtrip preserves explicit edges and safely escapes names', () => {
  const graph = buildWorkflowGraph(application, steps, links), parsed = parseWorkflowGraph(graph.content)
  assert.deepEqual(parsed.edges, graph.edges)
  assert.equal(parsed.nodes[0].name, steps[0].name)
  assert.match(parsed.version, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(graph.content, /name="<填写/)
})
test('workflow graph refuses foreign steps, duplicate links and disconnected definitions', () => {
  for (const invalid of [
    [...links, { from: '8101', to: '9999' }], [...links, links[0]],
    [{ from: 'start', to: '8101' }, { from: '8101', to: 'end' }],
    [...links, { from: 'end', to: '8101' }],
  ]) assert.throws(() => buildWorkflowGraph(application, steps, invalid), { code: 'INVALID_INPUT' })
})
test('workflow graph rejects entities and checks the current arrangement before replacing it', () => {
  assert.throws(() => parseWorkflowGraph('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><definitions/>'), { code: 'CONTEXT_MISSING' })
  const graph = buildWorkflowGraph(application, steps, links)
  const results = { source: { data: application }, steps: { data: steps }, arrangement: { data: { stepInfoAdjustXml: graph.content } } }
  assert.throws(() => prepareWorkflowLifecycle('workflow-lifecycle-graph-apply', { applicationId: '8001', links, expectedArrangement: '0'.repeat(64) }, results, null), { code: 'CONTEXT_CONFLICT' })
  const actual = prepareWorkflowLifecycle('workflow-lifecycle-graph-apply', { applicationId: '8001', links, expectedArrangement: parseWorkflowGraph(graph.content).version }, results, null)
  assert.equal(actual.body.applicationId, '8001')
  assert.equal(actual.body.conditionIds, undefined)
  assert.deepEqual(parseWorkflowGraph(actual.body.content).edges, graph.edges)
})
