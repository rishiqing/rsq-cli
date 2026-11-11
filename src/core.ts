import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class RsqError extends Error {
  constructor(public code: string, message: string, public exit = 1, public details?: Record<string, unknown>) {
    super(message)
  }
}

export type Identity = { userId: string; teamId?: string; username: string; displayName?: string; userFrom?: string }
export type LoginMethod = 'password' | 'wecom' | 'dingtalk'
export type Environment = 'production'
export type Context = { environment: Environment; profile: string }
export type JsonObject = Record<string, unknown>
export type Transport = (url: URL, init?: RequestInit) => Promise<Response>
export const request: Transport = (url, init) => fetch(url, { ...init, redirect: 'manual' })

const origins = {
  production: { site: 'https://www.rishiqing.com', wecom: 'https://qywx.rishiqing.com', dingtalk: 'https://app2245.eapps.dingtalkcloud.com' },
} as const
export function origin(env: Environment, type: 'site' | 'wecom' | 'dingtalk'): string { return origins[env][type] }
export function context(environment: string, profile: string): Context {
  if (environment !== 'production') throw new RsqError('INVALID_ENVIRONMENT', '客户 CLI 仅连接日事清正式服务。', 2)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new RsqError('INVALID_PROFILE', '无效的 profile 名称。', 2)
  return { environment, profile }
}

export function configRoot(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rsq-cli') }
export function digest(value: string): string { return createHash('sha256').update(value).digest('base64url') }
export function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}
export function parseJson(text: string): unknown {
  // Preserve integer identifiers that cannot be represented as JavaScript numbers.
  return JSON.parse(text, (_key, value: unknown, info?: { source?: string }) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && /^-?\d+$/.test(info?.source ?? '')
      ? info!.source : value)
}
export async function readJson(file: string): Promise<unknown> {
  if (file !== '-') {
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new RsqError('INPUT_TOO_LARGE', 'JSON 输入最多 8 MiB。', 2)
    return parseJson(await readFile(file, 'utf8'))
  }
  if (process.stdin.isTTY) throw new RsqError('INVALID_INPUT', '--input - 需要从管道读取 JSON。', 2)
  return parseJson(await readStdin(8 * 1024 * 1024))
}

export async function readStdin(max: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buf = Buffer.from(chunk)
    size += buf.length
    if (size > max) throw new RsqError('INPUT_TOO_LARGE', '标准输入超出大小限制。', 2)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function send(transport: Transport, url: URL, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = 30000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    return await transport(url, { ...init, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch {
    if (signal?.aborted) throw new RsqError('CANCELLED', '操作已取消。', 130)
    if (timeout.aborted) throw new RsqError('TIMEOUT', '请求超时，请核对操作结果后再试。', 5)
    throw new RsqError('NETWORK_ERROR', '无法连接日事清服务。', 5)
  }
}
export async function responseJson(response: Response): Promise<unknown> {
  try { return parseJson(await response.text()) } catch {
    throw new RsqError('UNEXPECTED_RESPONSE', '服务返回了无法解析的 JSON。', 5, { httpStatus: response.status })
  }
}
export function httpError(response: Response): RsqError {
  if (response.status === 401) return new RsqError('AUTH_REQUIRED', '会话无效，请重新执行 rsq login。', 3)
  if (response.status === 403) return new RsqError('FORBIDDEN', '当前身份没有执行此操作的权限。', 4)
  return new RsqError('HTTP_ERROR', '日事清服务拒绝了请求。', 5, { httpStatus: response.status })
}
export function businessError(data: JsonObject, httpStatus?: number, domain?: 'okr'): RsqError {
  const code = String(data.code ?? data.errcode ?? '')
  // OKR uses a separate error-code enum; its 401002 means authorization denial,
  // whereas the task service uses the same number for missing data.
  if (domain === 'okr') {
    if (code === '401001') return new RsqError('AUTH_REQUIRED', '会话无效，请重新登录。', 3)
    if (/^40100[0-9]$/.test(code) || code === '401100') return new RsqError('FORBIDDEN', '当前身份没有执行此操作的权限或应用权益。', 4)
    if (['400004', '400005', '400007', '404000'].includes(code)) return new RsqError('NOT_FOUND', '未找到请求的业务数据。', 5)
    if (/^400\d{3}$/.test(code)) return new RsqError('INVALID_INPUT', '服务端未接受请求参数，请核对命令 Schema。', 2)
  }
  if (code === '401' || data.loginStatus === 'fail') return new RsqError('AUTH_REQUIRED', '会话无效，请重新登录。', 3)
  if (code === '403' || code === '401007') return new RsqError('FORBIDDEN', '当前身份没有执行此操作的权限。', 4)
  if (code === '401002') return new RsqError('NOT_FOUND', '未找到请求的业务数据。', 5)
  if (code === '401003' || code === '401010') return new RsqError('INVALID_INPUT', '服务端未接受请求参数，请核对命令 Schema。', 2)
  if (code === '403401') return new RsqError('LIMIT_EXCEEDED', '当前组织的资源数量已达到服务端上限。', 5, { upstreamCode: code, ...(httpStatus && { httpStatus }) })
  return new RsqError('BUSINESS_ERROR', '日事清拒绝了此操作。', 5, {
    ...(httpStatus && { httpStatus }),
    ...(/^[\w-]{1,32}$/.test(code) ? { upstreamCode: data.code } : {}),
  })
}
export async function responseError(response: Response, domain?: 'okr'): Promise<RsqError> {
  if (!domain && (response.status === 401 || response.status === 403)) return httpError(response)
  // Grails can return a JSON business error with text/html content type. Parse
  // only a bounded JSON object; never echo a proxy page or an upstream message.
  try {
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []
    let size = 0
    if (reader) try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 65536) break
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (size <= 65536) {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.startsWith('{')) {
        const data = asObject(parseJson(raw))
        if (data.code !== undefined || data.success === false || data.loginStatus === 'fail') return businessError(data, response.status, domain)
      }
    }
  } catch { /* HTML/proxy errors and invalid JSON still have a stable HTTP error. */ }
  return httpError(response)
}
