import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { catalog, runOperation, flagValue, assignField } from '../dist/operations.js'
import { CookieJar } from 'tough-cookie'
import { origin, responseError } from '../dist/core.js'
import { sessionOrigin } from '../dist/session.js'

const read = name => JSON.parse(readFileSync(new URL('../contracts/' + name, import.meta.url)))
// Build provider-shaped test credentials in memory; stored fixtures contain no credential-shaped values.
const samples = JSON.parse(readFileSync(new URL('./fixtures/requests.json', import.meta.url)), (key, value) => key === 'secretKey' && value === 'fixture-signing-key' ? ['sk', 'live', 'a'.repeat(48)].join('_') : value)
const ctx = { environment: 'production', profile: 'test' }
const session = { version: 1, method: 'password', identity: { userId: '1', username: 'test', teamId: '7' }, accessToken: 'private-token', expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const base = { id: 'test', command: 'test operation', description: 'test', method: 'POST', route: '/task/test', service: 'account', auth: 'token', methods: ['password', 'wecom'], effect: 'write', review: 'reviewed', response: 'json', responseSchema: {}, inputSchema: { type: 'object' }, fields: [], examples: [], sources: [] }

test('workflow formula GET recalculation is a write and a network failure never replays it', async () => {
  const operation = catalog.operations.find(operation => operation.id === 'rsq.4305aec19b6e')
  assert.equal(operation.effect, 'write'); assert.equal(operation.idempotency, 'unknown')
  let calls = 0
  await assert.rejects(runOperation(ctx, operation, { query: { stepId: '8501', fieldIds: '8601,8602', isRecalculateFormula: true } }, session, { transport: async (url, init) => {
    calls++; assert.equal(init.method, 'GET'); assert.equal(url.searchParams.get('isRecalculateFormula'), 'true')
    throw new TypeError('fixture connection lost after request dispatch')
  } }), { code: 'NETWORK_ERROR' })
  assert.equal(calls, 1)
})

test('Grails text errors preserve quota and business codes without exposing bodies or replaying writes', async () => {
  let calls = 0
  await assert.rejects(runOperation(ctx, base, {}, session, { transport: async () => {
    calls++; return new Response('{"code":403401,"message":"private-upstream-content"}', { status: 400, headers: { 'content-type': 'text/html;charset=utf-8' } })
  } }), error => {
    assert.equal(error.code, 'LIMIT_EXCEEDED'); assert.equal(error.details.upstreamCode, '403401')
    assert.ok(!JSON.stringify(error).includes('private-upstream-content')); return true
  })
  assert.equal(calls, 1)
  assert.equal((await responseError(new Response('{"code":401003}', { status: 400 }))).code, 'INVALID_INPUT')
  for (const raw of ['<html>private-proxy-page</html>', '{invalid', '{"code":401003,"message":"' + 'x'.repeat(65536) + '"}']) {
    const error = await responseError(new Response(raw, { status: 502 }))
    assert.equal(error.code, 'HTTP_ERROR'); assert.ok(!JSON.stringify(error).includes('private-'))
  }
})

test('each executable contract matches its recorded fixture; DTO fixtures do not establish business acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsq-contract-files-'))
  const file = join(dir, 'fixture.txt')
  await writeFile(file, 'contract fixture')
  try {
  for (const op of catalog.operations.filter(op => op.review === 'reviewed')) {
    const operationSession = { ...session, method: op.methods[0] }
    const expectedOrigin = op.service === 'account' ? sessionOrigin(ctx, operationSession.method) : origin(ctx.environment, op.service)
    const jar = new CookieJar()
    jar.setCookieSync('JSESSIONID=private-cookie; Secure; HttpOnly; Path=/', expectedOrigin)
    operationSession.cookies = jar.serializeSync()
    for (const sample of samples[op.id]) {
      let calls = 0
      const input = structuredClone(sample.input)
      if (input.files) for (const key of Object.keys(input.files)) {
        const extension = op.inputSchema.properties.files?.properties?.[key]?.['x-rsq-extensions']?.[0]
        input.files[key] = extension ? join(dir, 'fixture' + extension) : file
        if (extension) await writeFile(input.files[key], 'contract fixture')
      }
      const out = join(dir, op.id + '.download')
      const result = await runOperation(ctx, op, input, operationSession, { approved: true, out, transport: async (url, init) => {
        calls++
        assert.equal(url.origin, expectedOrigin, op.command)
        assert.equal(url.pathname + url.search, sample.request.url, op.command)
        assert.equal(init.method, sample.request.method, op.command)
        assert.equal(init.headers.get('token'), ['token', 'both'].includes(op.auth) ? session.accessToken : null, op.command)
        assert.equal(init.headers.get('cookie'), ['cookie', 'both'].includes(op.auth) ? 'JSESSIONID=private-cookie' : null, op.command)
        assert.equal(init.redirect, 'manual')
        for (const [key, value] of Object.entries(sample.request.headers ?? {})) assert.equal(init.headers.get(key), value, op.command)
        if (op.encoding === 'multipart') {
          for (const [key, value] of Object.entries(sample.request.body ?? {})) assert.equal(init.body.get(key), typeof value === 'object' ? JSON.stringify(value) : String(value), op.command)
          for (const key of Object.keys(input.files ?? {})) assert.equal(await init.body.get(key).text(), 'contract fixture', op.command)
        } else if (op.encoding === 'form' && sample.request.body) {
          assert.equal(init.headers.get('content-type'), 'application/x-www-form-urlencoded', op.command)
          assert.ok(init.body instanceof URLSearchParams, op.command)
          assert.equal(init.body.toString(), sample.request.body, op.command)
        } else if (sample.request.body) assert.deepEqual(JSON.parse(init.body), sample.request.body, op.command)
        else assert.equal(init.body, undefined, op.command)
        if (op.response === 'binary') return new Response('download fixture')
        return op.response === 'text' ? new Response(sample.response) : ['empty', 'json-or-empty'].includes(op.response) && sample.response === null ? new Response('') : json(sample.response)
      } }).catch(error => { error.message = op.command + ': ' + error.message; throw error })
      assert.equal(calls, 1)
      if (op.response === 'binary') {
        assert.deepEqual(result, { output: out })
        assert.equal(await readFile(out, 'utf8'), 'download fixture')
      } else assert.deepEqual(result, sample.response, op.command)
    }
  }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('local dry-run needs no session or network and redacts input values', async () => {
  const op = catalog.operations.find(op => op.command === 'doc draft create')
  let calls = 0
  const result = await runOperation(ctx, op, { body: { name: 'private name' } }, null, { dryRun: true, transport: async () => { calls++; throw Error() } })
  assert.equal(calls, 0)
  assert.equal(result.effect, 'write')
  assert.ok(!JSON.stringify(result).includes('private name'))
  assert.deepEqual(result.inputFields.body, ['name', 'isNoteBook'])
  await assert.rejects(runOperation(ctx, op, { body: { unknown: 'x' } }, null, { dryRun: true }), { code: 'INVALID_INPUT' })
})

test('unchecked inference, confirmation and foreign credential routing stop before dispatch', async () => {
  let calls = 0
  const transport = async () => { calls++; return json({}) }
  for (const [op, options, code] of [
    [{ ...base, review: 'inferred' }, {}, 'CONTRACT_UNREVIEWED'],
    [{ ...base, effect: 'destructive' }, {}, 'CONFIRMATION_REQUIRED'],
    [{ ...base, service: 'wecom' }, {}, 'AUTH_ORIGIN_MISMATCH'],
  ]) await assert.rejects(runOperation(ctx, op, {}, session, { ...options, transport }), { code })
  assert.equal(calls, 0)
})

test('route traversal and authentication header overrides cannot escape configured services', async () => {
  for (const id of ['..', '%2e%2e', 'a/b', 'a\\b', 'x\n']) {
    await assert.rejects(runOperation(ctx, { ...base, route: '/task/test/{id}' }, { path: { id } }, session), { code: 'INVALID_INPUT' })
  }
  for (const key of ['Token', 'cookie', 'authorization', 'x-forwarded-host', 'origin']) {
    await assert.rejects(runOperation(ctx, base, { headers: { [key]: 'secret' } }, session), { code: 'INVALID_INPUT' })
  }
  assert.throws(() => flagValue({ option: 'id', schema: { type: 'integer' } }, '9007199254740993'), { code: 'INVALID_INPUT' })
  assert.throws(() => assignField({ body: [] }, { in: 'body', name: 'id', option: 'id' }, '1'), { code: 'INVALID_INPUT' })
})

test('writes are dispatched once on network failure, redirects and permission denial', async () => {
  for (const [response, code] of [[null, 'NETWORK_ERROR'], [new Response(null, { status: 302, headers: { location: 'https://example.com' } }), 'HTTP_ERROR'], [new Response(null, { status: 403 }), 'FORBIDDEN']]) {
    let calls = 0
    await assert.rejects(runOperation(ctx, base, { body: { name: 'private' } }, session, { transport: async () => {
      calls++
      if (!response) throw Error('private-token')
      return response
    } }), error => { assert.equal(error.code, code); assert.ok(!error.message.includes('private-token')); return true })
    assert.equal(calls, 1)
  }
})

test('business errors and drifted response schemas are reported without echoing sensitive payloads', async () => {
  await assert.rejects(runOperation(ctx, base, {}, session, { transport: async () => json({ success: false, msg: 'secret' }) }), { code: 'BUSINESS_ERROR' })
  await assert.rejects(runOperation(ctx, base, {}, session, { transport: async () => json({ errcode: '500', errmsg: 'secret' }) }), { code: 'BUSINESS_ERROR' })
  await assert.rejects(runOperation(ctx, { ...base, responseSchema: { type: 'array' } }, {}, session, { transport: async () => json({ secret: 'value' }) }), { code: 'RESPONSE_SCHEMA_MISMATCH' })
  for (const [code, expected] of [[401002, 'NOT_FOUND'], [401007, 'FORBIDDEN'], [401003, 'INVALID_INPUT']]) {
    await assert.rejects(runOperation(ctx, base, {}, session, { transport: async () => new Response(JSON.stringify({ code, message: 'private' }), { status: 400, headers: { 'content-type': 'application/json' } }) }), { code: expected })
  }
  for (const [code, expected] of [[401002, 'FORBIDDEN'], [401001, 'AUTH_REQUIRED'], [400000, 'INVALID_INPUT']]) {
    await assert.rejects(runOperation(ctx, { ...base, route: '/task/okr/test' }, {}, session, { transport: async () => new Response(JSON.stringify({ code, message: 'private' }), { status: 401, headers: { 'content-type': 'application/json' } }) }), { code: expected })
  }
})

test('multipart reads local files and downloads never overwrite an existing path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsq-files-'))
  const input = join(dir, 'sample.txt'), output = join(dir, 'download.bin')
  try {
    await writeFile(input, 'file contents')
    await runOperation(ctx, { ...base, encoding: 'multipart' }, { body: { label: 'label' }, files: { file: input } }, session, { transport: async (_url, init) => {
      assert.equal(init.headers.get('content-type'), null)
      assert.equal(init.body.get('label'), 'label')
      assert.equal(await init.body.get('file').text(), 'file contents')
      return json({})
    } })
    const options = { out: output, transport: async () => new Response(new Uint8Array([0, 255, 1])) }
    await runOperation(ctx, { ...base, response: 'binary' }, {}, session, options)
    await assert.rejects(runOperation(ctx, { ...base, response: 'binary' }, {}, session, options), { code: 'OUTPUT_EXISTS' })
    assert.deepEqual([...await readFile(output)], [0, 255, 1])
    assert.deepEqual((await readdir(dir)).sort(), ['download.bin', 'sample.txt'])
  } finally { await rm(dir, { force: true, recursive: true }) }
})

test('SSE and NDJSON emit complete events across split UTF-8 chunks', async () => {
  for (const [kind, text, expected] of [
    ['sse', ': comment\r\nevent: update\r\ndata: {"name":"中文"}\r\n\r\ndata: done\n\n', [{ event: 'update', data: { name: '中文' } }, { event: 'message', data: 'done' }]],
    ['ndjson', '{"id":9007199254740993}\n{"name":"中文"}\n', [{ id: '9007199254740993' }, { name: '中文' }]],
  ]) {
    const bytes = Buffer.from(text), events = []
    const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
    await runOperation(ctx, { ...base, response: kind }, {}, session, { emit: value => events.push(value), transport: async () => new Response(stream) })
    assert.deepEqual(events, expected)
  }
})
