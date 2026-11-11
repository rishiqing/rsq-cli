import test from 'node:test'
import assert from 'node:assert/strict'
import { docDelta, isSerializedEditorDelta } from '../dist/editor-delta.js'
import { catalog, runOperation } from '../dist/operations.js'

const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', identity: { userId: '1', teamId: '7', username: 'fixture' }, accessToken: 'fixture', expiresAt: Date.now() + 3600000 }
const operation = catalog.operations.find(op => op.command === 'replay component question update')
const body = answer => ({ body: { replayCollectId: '7001', year: 2026, month: 11, day: 7, replayCollectTemplateComponentId: '8101', answer } })

test('wire snapshots reject valid JSON of the wrong editor shape and double serialization', async () => {
  let calls = 0
  const transport = async () => { calls++; throw Error('invalid body reached the network') }
  for (const answer of [
    '', 'plain text', '<p>HTML</p>', '{invalid', 'null', '42',
    JSON.stringify({ content: '接口成功但网页空白' }),
    JSON.stringify({ ops: '正文' }), JSON.stringify({ ops: [null] }),
    JSON.stringify([{ insert: 'array is not a wire snapshot\n' }]),
    JSON.stringify('encoded text'), JSON.stringify(JSON.stringify({ ops: [{ insert: 'double encoded\n' }] })),
    JSON.stringify({ ops: [{ retain: 1 }, { insert: 'mutation' }] }),
    JSON.stringify({ ops: [{ delete: 1 }] }),
    '{"ops":[{"insert":"x","attributes":{"__proto__":{}}}]}',
  ]) {
    assert.equal(isSerializedEditorDelta(answer), false)
    for (const dryRun of [false, true]) await assert.rejects(
      runOperation(ctx, operation, body(answer), session, { transport, dryRun }),
      error => error.code === 'INVALID_INPUT' && error.message.includes('replay report question set') && error.details.issues.some(issue => issue.format === 'quill-delta-json'),
    )
  }
  assert.equal(calls, 0)
  assert.deepEqual(operation.fields.find(field => field.name === 'answer').schema, operation.inputSchema.properties.body.properties.answer)
})

test('valid full text, formatted, embedded and empty snapshots keep their exact wire encoding', async () => {
  for (const delta of [
    { ops: [] }, { ops: [{ insert: '\n' }] },
    { ops: [{ insert: '中文 "引号"\n第二行\n' }] },
    { ops: [{ insert: '标题', attributes: { bold: true, color: '#123456' } }, { insert: '\n', attributes: { header: 2 } }] },
    { ops: [{ insert: { image: 'https://example.com/image.png' } }, { insert: '\n' }] },
  ]) {
    const answer = JSON.stringify(delta)
    assert.equal(isSerializedEditorDelta(answer), true)
    assert.deepEqual(docDelta(delta), delta)
    let calls = 0
    await runOperation(ctx, operation, body(answer), session, { transport: async (_url, init) => {
      calls++; assert.equal(JSON.parse(init.body).answer, answer)
      return new Response(JSON.stringify({ id: '9001' }), { headers: { 'content-type': 'application/json' } })
    } })
    assert.equal(calls, 1)
  }
})
