import test from 'node:test'
import assert from 'node:assert/strict'
import { catalog } from '../dist/operations.js'
import { workflows } from '../dist/workflows.js'
import { validateReplayTopicWorkflow } from '../dist/replay-topic.js'
import { readdirSync, readFileSync } from 'node:fs'

test('every related business command resolves to a real command or coverage discovery', () => {
  const commands = new Set(['login', 'logout', 'whoami', 'auth status', ...[...catalog.operations, ...workflows.workflows].map(row => row.command)])
  const missing = workflows.workflows.flatMap(flow => (flow.relatedCommands ?? []).filter(command => !commands.has(command) && !/^rsq coverage [a-z-]+(?: [a-z-]+)?$/.test(command)).map(command => ({ source: flow.command, target: command })))
  assert.deepEqual(missing, [])
})
test('topic protocol rejects unknown action even if its fallback steps match a write action', () => {
  const flow = structuredClone(workflows.workflows.find(row => row.command === 'replay topic remove'))
  flow.replayTopicAction = 'invented-action'
  assert.throws(() => validateReplayTopicWorkflow(flow), { code: 'INVALID_CONTRACT' })
})
test('live acceptance runners use the public dispatcher with company and feature gates', () => {
  const root = new URL('../scripts/', import.meta.url)
  const bypasses = readdirSync(root).filter(name => /^accept-.*\.mjs$/.test(name) && /\brunWorkflow\(/.test(readFileSync(new URL(name, root), 'utf8')))
  assert.deepEqual(bypasses, [])
})
