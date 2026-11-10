import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { CookieJar } from 'tough-cookie'
import { asObject, digest, httpError, origin, request, responseJson, RsqError, send, type Context, type Identity, type LoginMethod, type Transport } from './core.js'
import { cookieJar, sessionOrigin, type Session } from './session.js'

const AUTH_AJAX = '/task/login/authAjax'
const DEVICE_ROOT = '/qywxbackauth/cli-auth'

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return undefined
}
function identify(payload: unknown): Identity {
  const data = asObject(payload)
  const userId = text(data.id ?? data.userId)
  const username = text(data.username)
  if (!userId || !username) throw new RsqError('INVALID_IDENTITY', '日事清未返回可验证的登录身份。', 3)
  const teamId = text(asObject(data.team).id ?? data.teamId)
  const userFrom = text(asObject(data.oauth).userFrom ?? data.userFrom)
  const displayName = text(data.showName ?? data.displayName ?? data.name)
  return { userId, username, ...(teamId && { teamId }), ...(displayName && { displayName }), ...(userFrom && { userFrom }) }
}
function expiry(token: string): number {
  try {
    const claims = asObject(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')))
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp * 1000 > Date.now()) return claims.exp * 1000
  } catch { /* token expiration is required */ }
  throw new RsqError('INVALID_SESSION', '服务器返回的会话没有有效的到期时间。', 3)
}
async function addCookies(response: Response, jar: CookieJar, url: URL) {
  for (const value of response.headers.getSetCookie()) {
    await jar.setCookie(value, url.href, { ignoreError: true })
  }
}
async function verify(base: string, transport: Transport, jar: CookieJar, token?: string, signal?: AbortSignal) {
  const url = new URL(AUTH_AJAX, base)
  const cookies = await jar.getCookieString(url.href)
  const headers = new Headers({ accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' })
  if (cookies) headers.set('cookie', cookies)
  if (token) headers.set('token', token)
  const response = await send(transport, url, { headers }, signal)
  if (!response.ok) throw httpError(response)
  const payload = asObject(await responseJson(response))
  if (payload.success !== true) throw new RsqError('AUTH_REQUIRED', '日事清未接受此会话，请重新登录。', 3)
  await addCookies(response, jar, url)
  return { identity: identify(payload), token: text(payload.token) }
}
function makeSession(method: LoginMethod, identity: Identity, token: string, jar: CookieJar): Session {
  return { version: 1, method, identity, accessToken: token, expiresAt: expiry(token), cookies: jar.serializeSync() }
}
// Also used after an explicit organization switch. The caller must verify the
// expected user AND team before committing this session to the local profile.
export function sessionFromIdentityResponse(method: LoginMethod, payload: unknown, jar: CookieJar): Session {
  const data = asObject(payload), token = text(data.token)
  if (data.success !== true || !token) throw new RsqError('INVALID_SESSION', '服务器没有返回可验证的新会话。', 3)
  return makeSession(method, identify(data), token, jar)
}
export async function loginPassword(ctx: Context, username: string, password: string, transport: Transport = request): Promise<Session> {
  if (!username || !password) throw new RsqError('INVALID_INPUT', '请输入日事清账号和密码。', 2)
  const base = origin(ctx.environment, 'site')
  const url = new URL('/task/j_spring_security_check', base)
  const jar = new CookieJar()
  const response = await send(transport, url, {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded', origin: base, referer: base + '/account/login' },
    body: new URLSearchParams({ j_username: username, j_password: password, 'remember-me': 'true' }),
  })
  const location = response.headers.get('location')
  if (response.status >= 500 || response.status === 429) throw httpError(response)
  if (response.status !== 302 || (location !== '/task/login/success' && location !== base + '/task/login/success')) {
    throw new RsqError('LOGIN_FAILED', '日事清未接受账号密码登录。', 3)
  }
  await addCookies(response, jar, url)
  const user = await verify(base, transport, jar)
  if (!user.token) throw new RsqError('INVALID_SESSION', '登录成功响应缺少会话。', 3)
  return makeSession('password', user.identity, user.token, jar)
}
export async function whoami(ctx: Context, session: Session, transport: Transport = request): Promise<Identity> {
  // The token is the source of identity; a stale cookie must not override it.
  const result = await verify(sessionOrigin(ctx, session.method), transport, new CookieJar(), session.accessToken)
  if (result.identity.userId !== session.identity.userId || result.identity.teamId !== session.identity.teamId) {
    throw new RsqError('IDENTITY_CHANGED', '日事清返回的身份或组织发生变化，请重新登录。', 3)
  }
  return result.identity
}
export async function refreshCookie(ctx: Context, session: Session, transport: Transport = request): Promise<CookieJar> {
  const jar = cookieJar(session)
  const user = await verify(sessionOrigin(ctx, session.method), transport, jar, session.accessToken)
  if (user.identity.userId !== session.identity.userId || user.identity.teamId !== session.identity.teamId) {
    throw new RsqError('IDENTITY_CHANGED', '会话身份与当前 profile 不匹配，请重新登录。', 3)
  }
  return jar
}
export function openBrowser(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]]
  const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
  child.on('error', () => { /* the user can copy the already printed URL */ })
  child.unref()
}

type DeviceOptions = {
  notify: (url: string) => void
  transport?: Transport
  signal?: AbortSignal
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}
export async function loginWecom(ctx: Context, options: DeviceOptions): Promise<Session> {
  const base = origin(ctx.environment, 'wecom')
  const transport = options.transport ?? request
  const verifier = randomBytes(32).toString('base64url')
  const post = (action: string, body: object) => send(transport, new URL(DEVICE_ROOT + '/' + action, base), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  }, options.signal, 10000)
  const created = await post('device', { challenge: digest(verifier) })
  if (created.status === 404 || created.status === 503) throw new RsqError('WECOM_LOGIN_UNAVAILABLE', '该环境尚未启用企业微信 CLI 登录。', 5)
  if (!created.ok) throw httpError(created)
  const data = asObject(await responseJson(created))
  const deviceId = text(data.deviceId)
  let url: URL
  try { url = new URL(String(data.verificationUri), base) } catch { throw new RsqError('INVALID_DEVICE_RESPONSE', '企业微信登录链接无效。', 5) }
  const validUrl = url.pathname === DEVICE_ROOT + '/browser' && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('launch') ?? '') && [...url.searchParams].length === 1
  if (!deviceId || !/^[A-Za-z0-9_-]{43}$/.test(deviceId)
    || url.origin !== base || url.username || url.password || url.hash || !validUrl
    || typeof data.expiresIn !== 'number' || data.expiresIn <= 0 || data.expiresIn > 600
    || typeof data.interval !== 'number' || data.interval < 1 || data.interval > 15) {
    throw new RsqError('INVALID_DEVICE_RESPONSE', '企业微信登录服务返回了无效的登录信息。', 5)
  }
  options.notify(url.href)
  const end = Date.now() + data.expiresIn * 1000
  let interval = data.interval
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }))
  while (Date.now() < end) {
    try { await wait(Math.min(interval * 1000, end - Date.now()), options.signal) } catch (e) {
      if (options.signal?.aborted) throw new RsqError('CANCELLED', '登录已取消。', 130)
      throw e
    }
    if (Date.now() >= end) break
    const response = await post('exchange', { deviceId, verifier })
    if (response.status === 404 || response.status === 503) {
      throw new RsqError('WECOM_LOGIN_UNAVAILABLE', '企业微信 CLI 登录服务暂时不可用，请稍后重新发起登录并使用新链接。', 5, { httpStatus: response.status, stage: 'exchange' })
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      interval = Math.max(interval + 1, Number.isFinite(retryAfter) ? retryAfter : 0)
      continue
    }
    if (response.status === 410) break
    const result = asObject(await responseJson(response))
    if (response.status === 202 && result.status === 'pending') continue
    if (response.status === 403 && result.status === 'denied') throw new RsqError('LOGIN_DENIED', '企业微信登录未获授权，或此账号未开通日事清。', 3)
    if (!response.ok) throw httpError(response)
    const token = text(result.accessToken)
    if (result.status !== 'authorized' || !token) throw new RsqError('INVALID_DEVICE_RESPONSE', '企业微信登录服务未返回会话。', 5)
    const jar = new CookieJar()
    const user = await verify(base, transport, jar, token, options.signal)
    if (!user.identity.userFrom?.startsWith('qywx')) throw new RsqError('INVALID_IDENTITY', '该会话不属于企业微信账号。', 3)
    return makeSession('wecom', user.identity, token, jar)
  }
  throw new RsqError('LOGIN_EXPIRED', '企业微信登录链接已过期，请重新执行 rsq login。', 3)
}
