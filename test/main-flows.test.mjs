import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mainFlows, mainFlowCoverage } from '../dist/main-flows.js'
import { catalog } from '../dist/operations.js'
import { workflows } from '../dist/workflows.js'
const commands = [...workflows.workflows, ...catalog.operations]

test('main-path discovery keeps distinct business goals, existing blockers and verification status', () => {
  const root = mainFlowCoverage(commands)
  assert.equal(root.summary.modules, 35)
  for (const id of ['project', 'project-template', 'workflow', 'datasheet', 'replay']) assert.ok(root.modules.some(module => module.id === id))
  const workflow = mainFlowCoverage(commands, 'workflow')
  assert.deepEqual(workflow.flows.map(flow => flow.id), ['configuration', 'execution', 'table-and-children', 'project-discovery'])
  assert.equal(workflow.flows.find(flow => flow.id === 'table-and-children').status, 'verified')
  const ai = mainFlowCoverage(commands, 'ai')
  assert.equal(ai.status, 'blocked')
  assert.match(ai.flows[0].blockers.join(' '), /拒绝分支不算成功/)
  assert.throws(() => mainFlowCoverage(commands, 'brief'), { code: 'UNKNOWN_BUSINESS_AREA' })
})
test('missing business commands require review without changing unrelated modules', () => {
  const omitted = commands.filter(command => command.command !== 'project template create')
  assert.equal(mainFlowCoverage(omitted, 'project-template').status, 'review-required')
  assert.equal(mainFlowCoverage(omitted, 'minder').status, mainFlowCoverage(commands, 'minder').status)
  const recorded = mainFlows.modules.find(module => module.id === 'project-template')
  assert.ok(recorded.flows.some(flow => flow.commands.includes('project template create')))
})
