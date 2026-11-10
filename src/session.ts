import { constants } from 'node:fs'
import { mkdir, open, lstat, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { configRoot, origin, RsqError, type Context, type Identity, type LoginMethod } from './core.js'

export type Session = {
  version: 1; method: LoginMethod; identity: Identity; accessToken: string; expiresAt: number
  cookies?: ReturnType<CookieJar['serializeSync']>
}

function pathFor(ctx: Context, root: string) {
  return join(root, 'sessions', ctx.environment, ctx.profile + '.json')
}
function assertPrivate(stats: { mode: number; uid: number }) {
  if ((process.getuid && process.getuid() !== stats.uid) || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) {
    throw new RsqError('UNSAFE_SESSION_STORE', '会话文件权限不安全，请修复 rsq-cli 配置目录权限。', 3)
  }
}
async function assertDirectory(file: string, root: string) {
  for (const dir of [root, join(root, 'sessions'), dirname(file)]) {
    const info = await lstat(dir)
    if (!info.isDirectory()) throw new RsqError('UNSAFE_SESSION_STORE', '会话目录不能是符号链接或普通文件。', 3)
    assertPrivate(info)
  }
}
function parseSession(value: unknown): Session {
  const s = value as Session
  if (s?.version !== 1 || (s.method !== 'password' && s.method !== 'wecom')
    || typeof s.identity?.userId !== 'string' || !s.identity.userId || typeof s.identity.username !== 'string' || !s.identity.username
    || (s.identity.teamId !== undefined && typeof s.identity.teamId !== 'string') || typeof s.accessToken !== 'string'
    || !s.accessToken || !Number.isFinite(s.expiresAt)) {
    throw new RsqError('INVALID_SESSION', '会话文件无效，请重新登录。', 3)
  }
  return s
}
export async function loadSession(ctx: Context, root = configRoot()): Promise<Session | null> {
  const file = pathFor(ctx, root)
  try {
    await assertDirectory(file, root)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 1024 * 1024) throw new RsqError('INVALID_SESSION', '会话文件无效，请重新登录。', 3)
      assertPrivate(info)
      return parseSession(JSON.parse(await handle.readFile('utf8')))
    } finally { await handle.close() }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (e instanceof RsqError) throw e
    throw new RsqError('INVALID_SESSION', '无法读取会话文件，请重新登录。', 3)
  }
}
export async function saveSession(ctx: Context, session: Session, root = configRoot()): Promise<void> {
  const file = pathFor(ctx, root)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await assertDirectory(file, root)
  const temp = file + '.' + randomUUID()
  const handle = await open(temp, 'wx', 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(session) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}
export async function removeSession(ctx: Context, root = configRoot()): Promise<void> {
  const file = pathFor(ctx, root)
  try {
    await assertDirectory(file, root)
    await rm(file, { force: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
export function requireSession(session: Session | null): Session {
  if (!session || session.expiresAt <= Date.now()) throw new RsqError('AUTH_REQUIRED', '没有可用会话，请执行 rsq login。', 3)
  return session
}
export function sessionOrigin(ctx: Context, method: LoginMethod): string {
  return origin(ctx.environment, method === 'wecom' ? 'wecom' : 'site')
}
export function cookieJar(session: Session): CookieJar {
  return session.cookies ? CookieJar.deserializeSync(session.cookies) : new CookieJar()
}
export function status(ctx: Context, session: Session | null) {
  return {
    ...ctx,
    state: !session ? 'missing' : session.expiresAt <= Date.now() ? 'expired' : 'active',
    ...(session && { method: session.method, expiresAt: new Date(session.expiresAt).toISOString(), identity: session.identity }),
  }
}
