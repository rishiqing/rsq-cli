import test from 'node:test'
import assert from 'node:assert/strict'
import { CliOutput, outputFormats } from '../dist/output.js'
import { cliDiagnostic } from '../dist/cli-errors.js'
import { RsqError } from '../dist/core.js'

test('default results preserve complete JSON for terminals and scripts', () => {
  const value = { result: { id: '900719925474099312345', enabled: false, members: [], nested: { value: null } }, resources: { taskId: 'own-task' } }
  for (const terminal of [true, false]) {
    assert.deepEqual(JSON.parse(new CliOutput('json', terminal, false).result(value)), value)
    assert.deepEqual(JSON.parse(new CliOutput('pretty', terminal, true).result(value)), value)
  }
  assert.throws(() => new CliOutput('json', false, false).result(undefined), { code: 'OUTPUT_ERROR' })
})

test('table output handles heterogeneous rows, nested values and exact identifiers without terminal control injection', () => {
  const renderer = new CliOutput('table', true, true)
  const output = renderer.result([{ 名称: '中文', id: '900719925474099312345', enabled: false }, { 名称: 'ESC\x1b[2J\nnew line', nested: { a: [1, null] } }])
  for (const text of ['名称', 'id', 'enabled', 'nested', '中文', '900719925474099312345', 'false', '{"a":[1,null]}']) assert.ok(output.includes(text), text)
  assert.ok(!output.includes('\x1b'))
  assert.ok(output.includes('\\u001b[2J\\nnew line'))
  assert.match(renderer.result([]), /空列表/u)
  assert.ok(renderer.result({ id: 'long-id', enabled: false }).includes('long-id'))
  assert.ok(renderer.result(null).includes('null'))
})

test('NDJSON splits only top-level arrays and streaming events remain one JSON line in every format', () => {
  const renderer = new CliOutput('ndjson', false, true)
  assert.deepEqual(renderer.result([{ id: '1' }, { id: '2' }]).trim().split('\n').map(JSON.parse), [{ id: '1' }, { id: '2' }])
  const envelope = { result: [{ id: '1' }], resources: { id: 'context' } }
  assert.deepEqual(JSON.parse(renderer.result(envelope)), envelope)
  assert.equal(renderer.result([]), '')
  for (const format of outputFormats) {
    const event = new CliOutput(format, true, true).event({ id: '1', text: 'first\nsecond' })
    assert.equal(event.split('\n').length, 2)
    assert.deepEqual(JSON.parse(event), { id: '1', text: 'first\nsecond' })
  }
})

test('all machine diagnostics, progress, previews and prompts are independently parseable JSON lines', () => {
  for (const format of ['json', 'ndjson']) {
    const renderer = new CliOutput(format, true, true)
    const events = [renderer.progress('等待确认', { step: 'pending' }), renderer.preview({ writes: false }), renderer.prompt('确认执行？'), renderer.diagnostic(cliDiagnostic(new RsqError('TIMEOUT', '请求超时。', 5)))]
    assert.deepEqual(events.slice(0, 3).map(line => JSON.parse(line).type), ['progress', 'preview', 'prompt'])
    assert.equal(JSON.parse(events[3]).error.code, 'TIMEOUT')
    for (const line of events) assert.equal(line.split('\n').length, 2)
  }
})

test('common business and access errors provide contextual recovery without weakening confirmation or access restrictions', () => {
  for (const code of ['INVALID_INPUT', 'FORBIDDEN', 'COMPANY_EXPIRED', 'COMPANY_OVER_CAPACITY', 'FEATURE_DISABLED', 'CONFIRMATION_REQUIRED', 'TIMEOUT']) {
    const diagnostic = cliDiagnostic(new RsqError(code, '本次操作未完成。', 4), 'work', 'task remove')
    assert.equal(diagnostic.exit, 4)
    assert.ok(diagnostic.error.hint)
    assert.ok(diagnostic.error.actions.length)
    assert.ok(!diagnostic.error.actions.some(command => command.includes(' --yes')))
    if (code === 'INVALID_INPUT') assert.ok(diagnostic.error.actions.includes('rsq schema "task remove"'))
    if (code === 'COMPANY_EXPIRED') assert.ok(diagnostic.error.actions.includes('rsq organization access inspect --profile work'))
  }
})
