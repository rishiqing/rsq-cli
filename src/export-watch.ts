import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import io from 'socket.io-client'
import { asObject, digest, parseJson, request, RsqError, send, type Context, type Transport } from './core.js'
import { saveNewOutput } from './operations.js'
import { readPushConnection, type PushConnection } from './push-connection.js'
import { loadSession, requireSession } from './session.js'

const fileOrigin = 'https://rishiqing-file.oss-cn-beijing.aliyuncs.com'

type ExportEvent =
  | { type: 'connection'; phase: 'listening' | 'reconnecting' }
  | { type: 'file'; output: string; bytes: number }
  | { type: 'download_error'; code: string; message: string }
type ReceiverDependencies = { load?: typeof loadSession; socket?: typeof io; transport?: Transport }

async function outputDirectory(output: string) {
  if (!output.trim()) throw new RsqError('INVALID_OUTPUT', '请指定保存导出文件的目录。', 2)
  try {
    const directory = resolve(output)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = await realpath(directory)
    if (!(await stat(path)).isDirectory()) throw Error()
    return path
  } catch {
    throw new RsqError('INVALID_OUTPUT', '无法创建或访问导出目录。', 2)
  }
}

function listen(connection: PushConnection, socketFactory: typeof io, signal: AbortSignal, onReady: () => void, receive: (value: unknown) => void) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const socket = socketFactory(connection.url, {
      autoConnect: false, forceNew: true, reconnection: false, transports: ['polling'],
      upgrade: false, jsonp: false, rejectUnauthorized: true, timeout: 15_000,
    })
    let connected = false, finished = false
    let engine: SocketIOClient.Emitter | undefined
    const ready = () => {
      if (finished) return
      connected = true
      onReady()
    }
    const close = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', close)
      engine?.off('drain', ready)
      socket.removeAllListeners()
      socket.close()
      resolve(connected)
    }
    socket.on('active', receive)
    socket.on('connect', () => {
      // Announce readiness after the polling transport has sent the subscription.
      engine = (socket.io as SocketIOClient.Manager & { engine: SocketIOClient.Emitter }).engine
      engine.once('drain', ready)
      socket.emit('join room', connection.room)
    })
    for (const event of ['disconnect', 'connect_error', 'connect_timeout', 'error']) socket.on(event, close)
    signal.addEventListener('abort', close, { once: true })
    if (signal.aborted) close()
    else socket.open()
  })
}

function receiveUrl(raw: unknown): URL | undefined {
  let message = raw
  if (typeof raw === 'string') {
    if (raw.length > 64 * 1024) return
    try { message = parseJson(raw) } catch { return }
  }
  const event = asObject(message)
  if (event.type !== 'export') return
  const value = asObject(event.body).url
  if (typeof value !== 'string' || value.length > 8192) return
  const url = URL.parse(value)
  if (!url || url.origin !== fileOrigin || url.username || url.password || url.pathname === '/') {
    throw new RsqError('INVALID_EXPORT_URL', '收到的导出链接不在日事清文件服务。', 5)
  }
  url.hash = ''
  return url
}

function decodeFilename(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function filename(response: Response, url: URL) {
  const disposition = response.headers.get('content-disposition') ?? ''
  const utf8 = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1]
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition)
  const raw = utf8 ?? plain?.[1] ?? plain?.[2] ?? url.pathname.split('/').at(-1) ?? ''
  const safe = decodeFilename(raw.trim()).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || '导出文件'
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe) ? '_' + safe : safe
}

async function newFilePath(directory: string, file: string) {
  const extension = extname(file), stem = extension ? file.slice(0, -extension.length) : file
  const base = Array.from(stem).slice(0, 44).join(''), suffix = Array.from(extension).slice(0, 12).join('')
  for (let n = 1; ; n++) {
    const destination = join(directory, base + (n === 1 ? '' : ' (' + n + ')') + suffix)
    try { await lstat(destination) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return destination
      throw new RsqError('INVALID_OUTPUT', '无法访问导出文件路径。', 2)
    }
  }
}

async function downloadExport(url: URL, directory: string, transport: Transport, signal: AbortSignal): Promise<ExportEvent> {
  const response = await send(transport, url, { method: 'GET' }, signal, 30 * 60_000)
  if (response.status !== 200 || !response.body || response.headers.get('content-length') === '0') {
    await response.body?.cancel().catch(() => {})
    throw new RsqError('DOWNLOAD_FAILED', '日事清文件服务未返回导出文件。', 5)
  }
  try {
    const output = await newFilePath(directory, filename(response, url))
    await saveNewOutput(Readable.fromWeb(response.body), output)
    return { type: 'file', output, bytes: (await stat(output)).size }
  } catch (error) {
    if (!response.body.locked) await response.body.cancel().catch(() => {})
    throw error
  }
}

export async function watchExports(ctx: Context, output: string, emit: (event: ExportEvent) => Promise<void>, signal: AbortSignal,
  dependencies: ReceiverDependencies = {}) {
  const load = dependencies.load ?? loadSession, transport = dependencies.transport ?? request
  const initial = requireSession(await load(ctx)), directory = await outputDirectory(output)
  const stop = new AbortController(), stopped = AbortSignal.any([signal, stop.signal])
  const pending = new Set<string>(), saved = new Set<string>()
  let failure: unknown, queue = Promise.resolve(), checkingSession = false
  const fail = (error: unknown) => {
    if (!stopped.aborted) failure = error
    stop.abort()
  }
  const notify = (event: ExportEvent) => emit(event).catch(fail)
  const session = async () => {
    const current = requireSession(await load(ctx))
    if (current.method !== initial.method || current.identity.userId !== initial.identity.userId || current.identity.teamId !== initial.identity.teamId) {
      throw new RsqError('IDENTITY_CHANGED', '当前 profile 的账号或公司已切换，请重新启动导出接收。', 3)
    }
    return current
  }
  const check = setInterval(() => {
    if (checkingSession || stopped.aborted) return
    checkingSession = true
    void session().catch(fail).finally(() => { checkingSession = false })
  }, 3000)
  const reportDownloadError = (error: unknown) => notify({
    type: 'download_error',
    code: error instanceof RsqError ? error.code : 'DOWNLOAD_FAILED',
    message: error instanceof RsqError ? error.message : '无法保存导出文件。',
  })
  const receive = (raw: unknown) => {
    if (stopped.aborted) return
    let url: URL | undefined
    try { url = receiveUrl(raw) } catch (error) { void reportDownloadError(error); return }
    if (!url) return
    const file = url, key = digest(file.href)
    if (pending.has(key) || saved.has(key)) return
    pending.add(key)
    queue = queue.then(async () => {
      if (stopped.aborted) return
      await session().catch(fail)
      if (stopped.aborted) return
      try {
        const result = await downloadExport(file, directory, transport, stopped)
        saved.add(key)
        if (saved.size > 1024) saved.delete(saved.values().next().value!)
        await notify(result)
      } catch (error) {
        if (!stopped.aborted) await reportDownloadError(error)
      }
    }).catch(fail).finally(() => pending.delete(key))
  }

  try {
    let delay = 1000
    while (!stopped.aborted) {
      try {
        const connection = await readPushConnection(ctx, await session(), stopped, transport)
        if (await listen(connection, dependencies.socket ?? io, stopped,
          () => { void notify({ type: 'connection', phase: 'listening' }) }, receive)) delay = 1000
      } catch (error) {
        if (stopped.aborted) break
        if (!(error instanceof RsqError) || !['NETWORK_ERROR', 'TIMEOUT'].includes(error.code)) throw error
      }
      if (stopped.aborted) break
      await notify({ type: 'connection', phase: 'reconnecting' })
      await sleep(delay, undefined, { signal: stopped }).catch(error => { if (!stopped.aborted) throw error })
      delay = Math.min(delay * 2, 30_000)
    }
  } finally {
    stop.abort()
    clearInterval(check)
    await queue
  }
  if (failure) throw failure
}
