import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { watchExports } from '../dist/export-watch.js'

const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', identity: { userId: '81', teamId: '7', username: 'fixture' }, accessToken: 'fixture-session', expiresAt: Date.now() + 60_000 }
const connection = { userId: '81', teamId: '7', room: 'fixture-own-account', url: 'https://push.rishiqing.com:441', enabled: true }
const storage = 'https://rishiqing-file.oss-cn-beijing.aliyuncs.com'
const connectionPath = '/task/api/v3/comment/mention/connection'
const exportMessage = url => ({ type: 'export', body: { url } })

function socketFixture(messages, afterJoining = () => {}) {
  return (endpoint, options) => {
    assert.equal(endpoint, connection.url)
    assert.deepEqual(options.transports, ['polling'])
    assert.equal(options.upgrade, false)
    assert.equal(options.jsonp, false)
    assert.equal(options.rejectUnauthorized, true)
    const socket = new EventEmitter()
    socket.io = { engine: new EventEmitter() }
    socket.open = () => queueMicrotask(() => socket.emit('connect'))
    socket.close = () => {}
    socket.on('join room', room => {
      assert.equal(room, connection.room)
      afterJoining()
      socket.io.engine.emit('drain')
      for (const item of messages) socket.emit('active', item)
    })
    return socket
  }
}

test('one polling receiver saves original bytes for each notification and preserves existing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsq-export-watch-'))
  const stop = new AbortController(), events = [], downloads = []
  const first = storage + '/first/导出.xlsx?signature=fixture-a', second = storage + '/second/导出.xlsx?signature=fixture-b'
  const payloads = [Buffer.from([0x50, 0x4b, 1, 2]), Buffer.from([0x50, 0x4b, 3, 4])]
  const transport = async (url, init) => {
    if (url.pathname === connectionPath) {
      assert.equal(init.headers.get('token'), session.accessToken)
      return Response.json(connection)
    }
    assert.equal(url.origin, storage)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'manual')
    const headers = new Headers(init.headers)
    for (const header of ['token', 'authorization', 'cookie']) assert.equal(headers.has(header), false)
    downloads.push(url.href)
    return new Response(url.pathname.startsWith('/first/') ? payloads[0] : payloads[1])
  }
  try {
    // An existing output must survive. The two jobs share the same server file name.
    await writeFile(join(dir, '导出.xlsx'), 'existing')
    await watchExports(ctx, dir, async event => {
      events.push(event)
      if (events.filter(item => item.type === 'file').length === 2) stop.abort()
    }, AbortSignal.any([stop.signal, AbortSignal.timeout(4000)]), {
      load: async () => session, transport,
      socket: socketFixture([
        { type: 'error', body: { message: 'Unrelated task' } },
        JSON.stringify(exportMessage(first)),
        exportMessage(first),
        exportMessage('https://outside.example/export.xlsx?signature=fixture-c'),
        exportMessage(second),
      ]),
    })
    assert.equal(events.find(event => event.type === 'connection').phase, 'listening')
    assert.deepEqual(events.filter(event => event.type === 'download_error').map(event => event.code), ['INVALID_EXPORT_URL'])
    const files = events.filter(event => event.type === 'file')
    assert.deepEqual(downloads.map(url => new URL(url).pathname.split('/')[1]), ['first', 'second'])
    assert.equal(downloads.length, 2)
    assert.equal(files.length, 2)
    assert.deepEqual(await readdir(dir).then(names => names.sort()), ['导出 (2).xlsx', '导出 (3).xlsx', '导出.xlsx'].sort())
    assert.equal(await readFile(join(dir, '导出.xlsx'), 'utf8'), 'existing')
    for (let index = 0; index < files.length; index++) {
      assert.deepEqual(await readFile(files[index].output), payloads[index])
      assert.equal(files[index].bytes, payloads[index].length)
    }
    assert.ok(!JSON.stringify(events).includes('signature='))
  } finally {
    stop.abort()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a receiver validates the current account binding before connecting or saving a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsq-export-watch-binding-'))
  let checkedSession = session, downloaded = false
  try {
    await assert.rejects(watchExports(ctx, dir, async () => {}, AbortSignal.timeout(3000), {
      load: async () => session,
      transport: async () => Response.json({ ...connection, userId: '82' }),
      socket: () => assert.fail('Mismatched accounts must not open a receiver'),
    }), { code: 'IDENTITY_CHANGED' })

    await assert.rejects(watchExports(ctx, dir, async () => {}, AbortSignal.timeout(3000), {
      load: async () => checkedSession,
      transport: async (url) => {
        if (url.pathname === connectionPath) return Response.json(connection)
        downloaded = true
        throw Error('Session changed')
      },
      socket: socketFixture([exportMessage(storage + '/old/export.xlsx')], () => {
        checkedSession = { ...session, identity: { ...session.identity, teamId: '8' } }
      }),
    }), { code: 'IDENTITY_CHANGED' })
    assert.equal(downloaded, false)
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
