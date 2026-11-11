import Ajv, { type AnySchema } from 'ajv'
import { createWriteStream, openAsBlob, readFileSync } from 'node:fs'
import { link, rm, stat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { asObject, businessError, origin, parseJson, request, responseError, responseJson, RsqError, send, type Context, type JsonObject, type LoginMethod, type Transport } from './core.js'
import { cookieJar, sessionOrigin, type Session } from './session.js'
import { isSerializedEditorDelta } from './editor-delta.js'

export type Schema = {
  type?: string | string[]; description?: string; properties?: Record<string, Schema>; required?: string[]
  additionalProperties?: boolean | Schema; items?: Schema; enum?: unknown[]; [key: string]: unknown
}
export type Field = { option: string; in: 'path' | 'query' | 'body' | 'headers' | 'files'; name: string; schema: Schema }
export type Operation = {
  id: string; command: string; description: string
  route: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  service: 'account' | 'wecom' | 'site'
  auth: 'token' | 'cookie' | 'both' | 'none'; methods: LoginMethod[]
  effect: 'read' | 'write' | 'destructive'; idempotency: 'idempotent' | 'unknown'
  response: 'json' | 'json-or-empty' | 'business' | 'empty' | 'text' | 'binary' | 'ndjson' | 'sse'; responseSchema: Schema
  encoding?: 'json' | 'form' | 'multipart' | 'text'
  queryArray?: 'brackets' | 'repeat'
  fields: Field[]; inputSchema: Schema; defaults?: JsonObject; examples: string[]
  review: 'reviewed' | 'inferred'
  coverageScope?: 'download' | 'business'
  outputFields?: string[]
  requiresBusinessContext?: string[]
}
type Catalog = { version: number; baseline: string; operations: Operation[] }
export const catalog = JSON.parse(readFileSync(new URL('../contracts/operations.json', import.meta.url), 'utf8')) as Catalog
export function operationOutput(op: Operation, result: unknown): unknown {
  if (!op.outputFields) return result
  if (Array.isArray(result)) return result.map(value => operationOutput(op, value))
  const value = asObject(result)
  return Object.fromEntries(op.outputFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}
const ajv = new Ajv.default({ allErrors: true, strict: false, ownProperties: true })
ajv.addFormat('quill-delta-json', { type: 'string', validate: isSerializedEditorDelta })
const forbiddenHeaders = /^(?:token|logintoken|cookie|authorization|username|host|connection|content-length|transfer-encoding|proxy-.*|origin|referer|forwarded|x-forwarded-.*)$/i
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor'])

export function assignField(input: JsonObject, field: Field, value: unknown) {
  if (Object.hasOwn(input, field.in) && asObject(input[field.in]) !== input[field.in]) throw new RsqError('INVALID_INPUT', field.in + ' 必须是对象。', 2)
  const area = asObject(input[field.in])
  if (Object.hasOwn(area, field.name)) throw new RsqError('DUPLICATE_INPUT', '参数重复：' + field.option, 2)
  input[field.in] = { ...area, [field.name]: value }
}
export function flagValue(field: Field, value: string, root?: Schema): unknown {
  let schema = field.schema
  const visited = new Set<Schema>()
  while (typeof schema.$ref === 'string' && root && !visited.has(schema)) {
    visited.add(schema)
    const key = schema.$ref.replace(/^#\/\$defs\//, '')
    const definitions = root.$defs as Record<string, Schema> | undefined
    if (!definitions?.[key]) break
    schema = definitions[key]
  }
  const variants = (schema.anyOf ?? [schema]) as Schema[]
  const types = [...new Set(variants.flatMap(s => Array.isArray(s.type) ? s.type : s.type ? [s.type] : []))]
  const type = types.includes('object') ? 'object' : types.includes('array') ? 'array' : types.includes('string') ? 'string' : types.find(t => t !== 'null')
  if (type === 'boolean' && (value === 'false' || value === 'true')) return value === 'true'
  if (type === 'number' || type === 'integer') {
    const number = Number(value)
    if (value.trim() && Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number
    throw new RsqError('INVALID_INPUT', '--' + field.option + ' 必须为数字。', 2)
  }
  if (type === 'array' || type === 'object') {
    try { return parseJson(value) } catch { throw new RsqError('INVALID_INPUT', '--' + field.option + ' 必须为 JSON。', 2) }
  }
  return value
}
function normalize(op: Operation, input: unknown): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RsqError('INVALID_INPUT', '输入必须是 JSON 对象。', 2)
  const merged = { ...input } as JsonObject
  for (const [key, value] of Object.entries(op.defaults ?? {})) {
    // Constants mirror the client wrapper and cannot be replaced by the caller.
    if (key === 'body' || key === 'query' || key === 'headers' || key === 'path') {
      if (Object.hasOwn(merged, key) && (typeof merged[key] !== 'object' || !merged[key] || Array.isArray(merged[key]))) {
        throw new RsqError('INVALID_INPUT', key + ' 必须是对象。', 2)
      }
      merged[key] = { ...asObject(merged[key]), ...asObject(value) }
    } else merged[key] = value
  }
  const validate = ajv.compile(op.inputSchema as AnySchema)
  if (!validate(merged)) {
    const issues = validate.errors?.slice(0, 12).map(err => ({ path: err.instancePath, keyword: err.keyword, message: err.message, ...err.params }))
    const message = validate.errors?.some(err => err.keyword === 'format' && err.params.format === 'quill-delta-json')
      ? '正文必须是序列化一次的完整编辑器 Delta（{ops:[{insert,attributes?}]}）。纯文本请使用 replay report question set --text；富文本使用该命令的 --content。'
      : '请求参数与命令 Schema 不符。'
    throw new RsqError('INVALID_INPUT', message, 2, { issues })
  }
  return merged
}
function appendQuery(query: URLSearchParams, values: JsonObject, arrayStyle: Operation['queryArray'] = 'brackets') {
  for (const [key, value] of Object.entries(values)) {
    if (value == null || blockedKeys.has(key)) continue
    if (Array.isArray(value)) {
      for (const entry of value) if (entry != null) query.append(key + (arrayStyle === 'repeat' || key.endsWith('[]') ? '' : '[]'), typeof entry === 'object' ? JSON.stringify(entry) : String(entry))
    } else query.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
}
function offset() {
  const minutes = -new Date().getTimezoneOffset()
  return (minutes < 0 ? '-' : '+') + String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0') + ':' + String(Math.abs(minutes) % 60).padStart(2, '0')
}
function routing(ctx: Context, op: Operation, input: JsonObject, session: Session | null) {
  const args = asObject(input.path)
  if (!/^\/(?!\/)[\w/{}.-]+$/.test(op.route)) throw new RsqError('INVALID_CONTRACT', '接口路径配置无效。')
  const route = op.route.replace(/\{([\w-]+)\}/g, (_, name: string) => {
    const value = args[name]
    if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || /[\\/%\x00-\x1F\x7F]/.test(String(value)) || /^\.{1,2}$/.test(String(value))) {
      throw new RsqError('INVALID_INPUT', '无效的路径参数：' + name, 2)
    }
    return encodeURIComponent(String(value))
  })
  if (route.includes('{') || route.includes('}') || route.split('/').some(part => part === '.' || part === '..')) {
    throw new RsqError('INVALID_CONTRACT', '接口路径配置无效。')
  }
  const base = op.service === 'account' ? sessionOrigin(ctx, session?.method ?? (op.methods.length === 1 ? op.methods[0] : 'password')) : origin(ctx.environment, op.service)
  const url = new URL(route, base)
  if (url.origin !== base || url.protocol !== 'https:') throw new RsqError('INVALID_CONTRACT', '接口服务配置无效。')
  appendQuery(url.searchParams, asObject(input.query), op.queryArray)
  return url
}
async function headersFor(op: Operation, ctx: Context, url: URL, input: JsonObject, session: Session | null) {
  const headers = new Headers({ accept: op.response === 'sse' ? 'text/event-stream' : '*/*' })
  for (const [key, value] of Object.entries(asObject(input.headers))) {
    if (forbiddenHeaders.test(key)) throw new RsqError('INVALID_INPUT', '不允许覆盖认证或传输请求头。', 2)
    if (value != null) headers.set(key, String(value))
  }
  if (op.auth === 'none') return headers
  if (!session || session.expiresAt <= Date.now()) throw new RsqError('AUTH_REQUIRED', '没有可用会话，请执行 rsq login。', 3)
  if (!op.methods.includes(session.method)) throw new RsqError('LOGIN_METHOD_MISMATCH', '此命令不适用于当前 profile 的登录方式。', 3)
  if (url.origin !== sessionOrigin(ctx, session.method)) throw new RsqError('AUTH_ORIGIN_MISMATCH', '禁止将凭证发送至非当前账号的服务。', 3)
  if (op.auth === 'cookie' || op.auth === 'both') {
    const cookies = await cookieJar(session).getCookieString(url.href)
    if (!cookies) throw new RsqError('AUTH_REQUIRED', '此命令需要有效的网页登录会话，请重新登录。', 3)
    headers.set('cookie', cookies)
  }
  if (op.auth === 'token' || op.auth === 'both') {
    headers.set('token', session.accessToken)
    headers.set('username', session.identity.username)
    headers.set('time-zone', offset())
  }
  return headers
}
export async function validateUploadFiles(op: Operation, input: JsonObject) {
  const blobs = new Map<string, Blob>()
  if (op.encoding === 'multipart') {
    for (const [key, value] of Object.entries(asObject(input.body))) {
      const max = op.inputSchema.properties?.body?.properties?.[key]?.['x-rsq-max-integer']
      if (typeof max === 'number' && (!/^[0-9]+$/.test(String(value)) || BigInt(String(value)) > BigInt(max))) throw new RsqError('INVALID_INPUT', '上传参数超出服务端可无损处理的整数范围。', 2, { field: key, maximum: max })
    }
    for (const [key, path] of Object.entries(asObject(input.files))) {
      if (typeof path !== 'string') throw new RsqError('INVALID_INPUT', '上传文件路径必须为字符串。', 2)
      const schema = op.inputSchema.properties?.files?.properties?.[key] ?? {}, extensions = schema['x-rsq-extensions'] as string[] | undefined
      if (extensions && !extensions.includes(extname(path).toLowerCase())) throw new RsqError('INVALID_FILE', '上传文件格式不符合 Schema。', 2, { field: key, extensions })
      try {
        const info = await stat(path)
        if (!info.isFile()) throw new RsqError('INVALID_FILE', '上传路径必须是普通文件。', 2, { field: key })
        if (typeof schema['x-rsq-maxBytes'] === 'number' && info.size > schema['x-rsq-maxBytes']) throw new RsqError('INVALID_FILE', '上传文件超过接口大小限制。', 2, { field: key, maxBytes: schema['x-rsq-maxBytes'] })
        const encoding = asObject(input.fileEncodings)[key] ?? schema['x-rsq-csv-encoding']
        let blob: Blob
        if (extname(path).toLowerCase() === '.csv' && encoding === 'utf8') {
          const bytes = await readFile(path)
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new RsqError('INVALID_FILE', 'CSV 不是有效 UTF-8。请显式选择 original 保留原文件编码。', 2, { field: key }) }
          const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          blob = new Blob(bom ? [bytes] : [new Uint8Array([0xef, 0xbb, 0xbf]), bytes], { type: 'text/csv' })
        } else blob = await openAsBlob(path)
        if (typeof schema['x-rsq-maxBytes'] === 'number' && blob.size > schema['x-rsq-maxBytes']) throw new RsqError('INVALID_FILE', '编码处理后的上传文件超过接口大小限制。', 2, { field: key, maxBytes: schema['x-rsq-maxBytes'] })
        blobs.set(key, blob)
      } catch (error) { if (error instanceof RsqError) throw error; throw new RsqError('FILE_READ_ERROR', '无法读取上传文件。', 2) }
    }
  }
  return blobs
}
async function encodeBody(op: Operation, input: JsonObject, headers: Headers): Promise<RequestInit['body']> {
  if (op.encoding === 'multipart') {
    const blobs = await validateUploadFiles(op, input)
    const data = new FormData()
    for (const [key, value] of Object.entries(asObject(input.body))) {
      if (value != null) data.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    for (const [key, path] of Object.entries(asObject(input.files))) {
      data.append(key, blobs.get(key)!, basename(String(path)))
    }
    return data
  }
  if (input.body === undefined) return undefined
  if (op.encoding === 'form') {
    const form = new URLSearchParams()
    appendQuery(form, asObject(input.body))
    headers.set('content-type', 'application/x-www-form-urlencoded')
    return form
  }
  if (op.encoding === 'text') {
    headers.set('content-type', 'text/plain; charset=utf-8')
    return String(input.body)
  }
  headers.set('content-type', 'application/json')
  return JSON.stringify(wireValue(input.body, op.inputSchema.properties?.body ?? {}, op.inputSchema))
}
function wireValue(value: unknown, schema: Schema, root: Schema): unknown {
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/$defs/')) {
    const definition = (root.$defs as Record<string, Schema> | undefined)?.[schema.$ref.slice('#/$defs/'.length)]
    if (definition) schema = definition
  }
  if (typeof value === 'string' && schema['x-rsq-wire-integer'] === true) {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n) throw new RsqError('INVALID_INPUT', '该参数需要无损的 64 位整数。', 2)
    const rawJSON = (JSON as typeof JSON & { rawJSON?: (value: string) => unknown }).rawJSON
    if (!rawJSON) throw new RsqError('RUNTIME_UNSUPPORTED', '当前 Node 版本无法无损编码整数，请使用 Node 22 或以上版本。', 2)
    return rawJSON(value)
  }
  if (Array.isArray(value)) return value.map(item => wireValue(item, schema.items ?? {}, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    wireValue(item, schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {}), root)]))
  return value
}
async function download(response: Response, out: string) {
  if (!response.body) throw new RsqError('UNEXPECTED_RESPONSE', '服务未返回文件。', 5)
  const temp = out + '.' + randomUUID() + '.part'
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
    // An existing path (including a symlink) is never overwritten.
    await link(temp, out)
    return { output: out }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RsqError('OUTPUT_EXISTS', '输出路径已存在。', 2)
    throw new RsqError('DOWNLOAD_FAILED', '未能保存下载文件。', 5)
  } finally { await rm(temp, { force: true }) }
}
async function stream(response: Response, kind: 'ndjson' | 'sse', emit: (value: unknown) => Promise<void> | void) {
  if (!response.body) throw new RsqError('UNEXPECTED_RESPONSE', '服务未返回数据流。', 5)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  let event = ''
  let eventBytes = 0
  async function flush() {
    if (!data.length) { event = ''; eventBytes = 0; return }
    const payload = data.join('\n')
    let value: unknown = payload
    try { value = parseJson(payload) } catch { /* SSE data may be text */ }
    await emit({ event: event || 'message', data: value })
    data = []; event = ''; eventBytes = 0
  }
  async function line(raw: string) {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (kind === 'ndjson') {
      if (value.trim()) await emit(parseJson(value))
    } else if (!value) await flush()
    else if (value.startsWith('data:')) {
      eventBytes += value.length
      if (eventBytes > 8 * 1024 * 1024) throw new RsqError('STREAM_EVENT_TOO_LARGE', '服务端事件过大。', 5)
      data.push(value.slice(5).replace(/^ /, ''))
    } else if (value.startsWith('event:')) event = value.slice(6).trim()
  }
  try {
    for (;;) {
      const chunk = await reader.read()
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      let index: number
      while ((index = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, index)
        pending = pending.slice(index + 1)
        await line(value)
      }
      if (pending.length > 8 * 1024 * 1024) throw new RsqError('STREAM_EVENT_TOO_LARGE', '服务端事件过大。', 5)
      if (chunk.done) break
    }
    if (pending) await line(pending)
    if (kind === 'sse') await flush()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

type RunOptions = { dryRun?: boolean; out?: string; approved?: boolean; transport?: Transport; emit?: (value: unknown) => Promise<void> | void; signal?: AbortSignal }
export async function runOperation(ctx: Context, op: Operation, raw: unknown, session: Session | null, options: RunOptions = {}) {
  const input = normalize(op, raw)
  const url = routing(ctx, op, input, session)
  if (options.dryRun) return {
    dryRun: true, command: op.command, effect: op.effect, method: op.method, service: op.service,
    origin: op.service === 'account' && !session ? null : url.origin, route: op.route,
    inputFields: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Object.keys(asObject(value))])),
  }
  if (op.review !== 'reviewed') throw new RsqError('CONTRACT_UNREVIEWED', '此接口契约尚未核对，暂时只支持 Schema 和 --dry-run。', 2)
  if (op.effect === 'destructive' && !options.approved) throw new RsqError('CONFIRMATION_REQUIRED', '此操作需要明确确认。先用 --dry-run 核对，再使用 --yes 执行。', 2)
  if (op.response === 'binary' && !options.out) throw new RsqError('OUTPUT_REQUIRED', '请通过 --output 指定保存路径。', 2)
  if ((op.response === 'ndjson' || op.response === 'sse') && !options.emit) throw new RsqError('INVALID_OUTPUT', '命令需要流式输出。', 2)
  const headers = await headersFor(op, ctx, url, input, session)
  const body = await encodeBody(op, input, headers)
  const response = await send(options.transport ?? request, url, { method: op.method, headers, body }, options.signal,
    op.response === 'sse' || op.response === 'ndjson' || op.response === 'binary' ? 30 * 60 * 1000 : 30000)
  const errorDomain = op.route.startsWith('/task/okr/') ? 'okr' : undefined
  if (!response.ok) throw await responseError(response, errorDomain)
  if (op.response === 'binary') return download(response, options.out!)
  if (op.response === 'sse' || op.response === 'ndjson') {
    await stream(response, op.response, options.emit!)
    return undefined
  }
  if (response.status === 204 || op.method === 'HEAD') return null
  let value: unknown
  if (op.response === 'empty' || op.response === 'json-or-empty') {
    const text = await response.text()
    try { value = text.trim() ? parseJson(text) : null } catch { throw new RsqError('UNEXPECTED_RESPONSE', '服务返回了无法解析的响应。', 5) }
  } else if (op.response === 'text') value = await response.text()
  else value = await responseJson(response)
  const data = asObject(value)
  if (data.success === false || data.loginStatus === 'fail' || (data.errcode !== undefined && data.errcode !== 0 && data.errcode !== '0') || (op.response === 'business' && data.code !== undefined && ![0, '0', 200, '200', 200000, '200000'].includes(data.code as never))) throw businessError(data, undefined, errorDomain)
  if (!ajv.validate(op.responseSchema as AnySchema, value)) throw new RsqError('RESPONSE_SCHEMA_MISMATCH', '服务响应与已核对契约不符；写操作请先核对结果，勿自动重试。', 5, {
    issues: ajv.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message })),
  })
  return value
}
