import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import io from 'socket.io-client'
import { checkBusinessAccess, requirePermission } from './access.js'
import { asObject, origin, parseJson, request, RsqError, send, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation, saveNewOutput } from './operations.js'
import { readPushConnection } from './push-connection.js'
import { loadSession, requireSession, sessionOrigin, type Session } from './session.js'

async function readTaskOperation(ctx: Context, session: Session, command: string, input: JsonObject, transport?: Transport) {
  const op = catalog.operations.find(row => row.command === command)
  if (!op || op.effect !== 'read' || op.review !== 'reviewed') throw new RsqError('CONTEXT_MISSING', '只读任务操作尚未安装。', 5)
  return runOperation(ctx, op, input, session, { transport })
}

export type TaskMedia = { key: string; type: 'image' | 'video' | 'file'; name: string; fileId?: string; url?: string; source: string }
/** HTML, Quill embeds and attachment fields share a single source-preserving catalog. */
export function taskMedia(value: unknown): TaskMedia[] {
  const media = new Map<string, TaskMedia>()
  const add = (item: Omit<TaskMedia, 'key'>) => {
    if (!item.fileId && !item.url) return
    const key = [item.source, item.fileId ?? item.url].join(':')
    media.set(key, { ...item, key })
  }
  const walk = (v: unknown, source: string, depth = 0) => {
    if (depth > 35 || v == null) return
    if (Array.isArray(v)) { v.forEach((entry, i) => walk(entry, source + '/' + i, depth + 1)); return }
    if (typeof v === 'string') {
      if (/^\s*[\[{]/.test(v)) try { walk(parseJson(v), source, depth + 1) } catch { /* plain text */ }
      for (const match of v.matchAll(/<(img|video|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))
        add({ type: match[1].toLowerCase() === 'img' ? 'image' : 'video', name: match[1], url: match[2].replaceAll('&amp;', '&'), source })
      return
    }
    const o = asObject(v), attrs = asObject(o.attributes)
    if (attrs.blockType === 'file' && attrs.id != null)
      add({ type: attrs.iconType === 'video' ? 'video' : /image/.test(String(attrs.iconType)) ? 'image' : 'file', name: String(attrs.name ?? attrs.id), fileId: String(attrs.id), source })
    if (o.fileId != null || (o.id != null && (o.realPath || o.fileName || o.contentType))) {
      const name = String(o.name ?? o.fileName ?? o.id ?? o.fileId)
      const mime = String(o.contentType ?? '')
      add({ type: /^video/.test(mime) || /\.(mp4|mov|webm)$/i.test(name) ? 'video' : /^image/.test(mime) || /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : 'file', name, fileId: String(o.fileId ?? o.id), ...(typeof o.realPath === 'string' ? { url: o.realPath } : {}), source })
    }
    const insert = asObject(o.insert)
    if (typeof insert.image === 'string') add({ type: 'image', name: 'image', url: insert.image, source })
    if (typeof insert.image === 'object' && insert.image) walk(insert.image, source, depth + 1)
    if (typeof insert.video === 'string') add({ type: 'video', name: 'video', url: insert.video, source })
    for (const [key, entry] of Object.entries(o)) if (!['__proto__', 'constructor', 'prototype'].includes(key)) walk(entry, source + '/' + key, depth + 1)
  }
  walk(value, 'task')
  return [...media.values()]
}

export async function readTaskContext(ctx: Context, session: Session, taskId: string, projectId?: string, excludeDetails = false, transport?: Transport) {
  if (!taskId?.trim()) throw new RsqError('INVALID_INPUT', '需要任务 ID。', 2)
  if (projectId !== undefined && !/^[1-9][0-9]*$/.test(projectId)) throw new RsqError('INVALID_INPUT', '需要有效的项目 ID。', 2)
  await checkBusinessAccess(ctx, projectId ? { features: ['PLAN'] } : {}, session, transport)
  const where = projectId ? { module: 'project', siteId: projectId } : { module: 'common', siteId: 'common' }
  const basic = asObject(await readTaskOperation(ctx, session, 'task get', { query: { id: taskId, ...where } }, transport))
  if (String(basic.id) !== taskId) throw new RsqError('CONTEXT_MISMATCH', '读取的任务身份不匹配。', 5)
  const actualProject = asObject(basic.from).projectId
  if (projectId && actualProject != null && String(actualProject) !== projectId) throw new RsqError('CONTEXT_MISMATCH', '任务与指定项目不一致。', 5)
  // Remove details before extracting rich-text media or returning context.
  if (excludeDetails) delete basic.note
  const [fields, comments] = await Promise.all([
    readTaskOperation(ctx, session, 'task-template values get', { query: { taskId, ...where } }, transport),
    readTaskOperation(ctx, session, 'kite-design fetch-other-data', { query: { taskId } }, transport),
  ])
  if (!Array.isArray(comments)) throw new RsqError('CONTEXT_MISSING', '未取得完整评论列表。', 5)
  const data = { basic, fields, comments }
  return { ...data, media: taskMedia(data), readAt: new Date().toISOString(), teamId: session.identity.teamId ?? null, taskId }
}

const fileRedirects = new Set([301, 302, 303, 307, 308])
function fileUrl(value: unknown, entryOrigins: readonly string[] = []) {
  const url = typeof value === 'string' && value.length <= 8192 ? URL.parse(value) : null
  if (url?.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash && url.pathname !== '/') {
    if (/^rishiqing-file\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)) return url
    if (entryOrigins.includes(url.origin) && url.pathname === '/task/v1/folder/file/url' &&
      [...url.searchParams.keys()].length === 1 && url.searchParams.get('signature')) return url
  }
  throw new RsqError('INVALID_FILE_URL', '原文件地址不在已核对的日事清文件服务。', 5)
}

export async function downloadUrl(ctx: Context, session: Session, fileId: string, transport?: Transport) {
  if (!/^[1-9][0-9]*$/.test(fileId ?? '')) throw new RsqError('INVALID_INPUT', '需要有效的 --file-id。', 2)
  await checkBusinessAccess(ctx, {}, session, transport)
  const file = asObject(await readTaskOperation(ctx, session, 'doc get-file-detail', { query: { id: fileId } }, transport))
  if (String(file.id) !== fileId) throw new RsqError('CONTEXT_MISMATCH', '文件详情与请求的 ID 不一致。', 5)
  requirePermission(file.editControl, 'downloadFile', { message: '当前账号没有此文件的下载权限。' })
  const url = fileUrl(file.realPath, [origin(ctx.environment, 'site'), sessionOrigin(ctx, session.method)])
  const size = typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined
  return { id: fileId, ...(typeof file.name === 'string' && { name: file.name }), ...(size !== undefined && { size }), url: url.href }
}
export async function downloadFile(ctx: Context, session: Session, fileId: string, output: string, transport: Transport = request) {
  if (!output?.trim()) throw new RsqError('INVALID_INPUT', '需要 --output 文件路径。', 2)
  const file = await downloadUrl(ctx, session, fileId, transport)
  const entry = new URL(file.url)
  let response = await send(transport, entry, { method: 'GET' }, undefined, 120_000)
  if (entry.pathname === '/task/v1/folder/file/url') {
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!fileRedirects.has(response.status)) throw new RsqError('DOWNLOAD_FAILED', '原文件签名入口未返回文件跳转。', 5, { httpStatus: response.status })
    response = await send(transport, fileUrl(location), { method: 'GET' }, undefined, 120_000)
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new RsqError('DOWNLOAD_FAILED', '日事清文件服务未返回原文件。', 5, { httpStatus: response.status })
  }
  const saved = await saveNewOutput(Readable.fromWeb(response.body), resolve(output), file.size)
  return { id: file.id, ...(file.name !== undefined && { name: file.name }), ...saved }
}

export type Mention = { type: 'task_comment_mention'; teamId: string; taskId: string; commentId: string; senderId: string; senderName: string; mentionIds: string[]; text: string; createdAt: string }
export function parseMention(raw: unknown, identity: { userId: string; teamId?: string }): Mention | null {
  if (typeof raw === 'string' && raw.length > 64 * 1024) return null
  const envelope = asObject(typeof raw === 'string' ? parseJson(raw) : raw)
  const kind = envelope.type ?? envelope.action
  if (kind !== 'taskCommentMention') return null
  const v = asObject(envelope.data ?? envelope.body ?? envelope)
  const mentionIds = Array.isArray(v.mentionIds) ? v.mentionIds.map(String) : []
  if (String(v.teamId) !== identity.teamId || !mentionIds.includes(identity.userId)) return null
  if (![v.taskId, v.commentId, v.senderId].every(x => (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isSafeInteger(x)))) return null
  const createdAt = String(v.createdAt ?? '')
  if (!Number.isFinite(Date.parse(createdAt))) return null
  return { type: 'task_comment_mention', teamId: String(v.teamId), taskId: String(v.taskId), commentId: String(v.commentId), senderId: String(v.senderId), senderName: String(v.senderName ?? ''), mentionIds, text: String(v.text ?? ''), createdAt }
}

/** Online-only Socket.IO subscriber. Reconnect rejoins exactly the new current-user room. */
export async function watchMentions(ctx: Context, emit: (event: unknown) => Promise<void>, signal: AbortSignal, deps: {
  socket?: typeof io; load?: typeof loadSession; transport?: Transport
} = {}) {
  const load = deps.load ?? loadSession, socketFactory = deps.socket ?? io
  let socket: SocketIOClient.Socket | undefined, fingerprint = '', syncing = false
  const state = async (phase: string, extra: JsonObject = {}) => emit({ type: 'connection', phase, profile: ctx.profile, onlineOnly: true, ...extra })
  const sync = async () => {
    if (syncing || signal.aborted) return
    syncing = true
    try {
      const saved = await load(ctx), session = requireSession(saved)
      const key = JSON.stringify([session.identity.userId, session.identity.teamId, session.accessToken, session.expiresAt])
      if (fingerprint === key && socket) return
      socket?.removeAllListeners(); socket?.close(); socket = undefined; fingerprint = ''
      const config = await readPushConnection(ctx, session, signal, deps.transport)
      if (signal.aborted) return
      fingerprint = key
      await state('connecting', { identity: session.identity })
      if (signal.aborted) return
      const active = socket = socketFactory(config.url, {
        autoConnect: false, forceNew: true, reconnection: true, transports: ['polling'], upgrade: false,
        jsonp: false, rejectUnauthorized: true, timeout: 15_000,
      })
      active.on('connect', () => {
        active.emit('join room', config.room)
        void state('connected', { identity: session.identity }).catch(() => {})
      })
      active.on('active', (raw: unknown) => {
        // Persisted stream events never include session tokens; the caller owns durable intake.
        try { const message = parseMention(raw, session.identity); if (message) void emit(message).catch(() => { active.removeAllListeners(); active.close(); if (socket === active) { socket = undefined; fingerprint = '' } }) } catch { void state('protocol_error').catch(() => {}) }
      })
      active.on('disconnect', () => void state('reconnecting', { reason: 'connection_closed' }).catch(() => {}))
      active.on('connect_error', () => void state('reconnecting', { reason: 'connection_failed' }).catch(() => {}))
      active.open()
    } catch (e) {
      socket?.removeAllListeners(); socket?.close(); socket = undefined; fingerprint = ''
      if (!signal.aborted) await state(e instanceof RsqError && ['AUTH_REQUIRED', 'INVALID_SESSION', 'IDENTITY_CHANGED'].includes(e.code) ? 'authentication_required' : 'error', { errorCode: e instanceof RsqError ? e.code : 'CONNECTION_FAILED' })
    } finally { syncing = false }
  }
  await sync()
  const timer = setInterval(() => void sync().catch(() => {}), 2000)
  try { await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), { once: true }) }) }
  finally { clearInterval(timer); socket?.removeAllListeners(); socket?.close() }
}
