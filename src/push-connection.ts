import { asObject, request, RsqError, type Context, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import type { Session } from './session.js'

const pushOrigin = 'https://push.rishiqing.com:441'
export type PushConnection = { url: string; room: string }

export async function readPushConnection(ctx: Context, session: Session, signal: AbortSignal, transport: Transport = request): Promise<PushConnection> {
  const operation = catalog.operations.find(op => op.id === 'rsq.task-mention-connection.v1')
  if (!operation) throw new RsqError('INVALID_CONTRACT', '缺少当前账号的消息连接契约。', 6)
  const reply = asObject(await runOperation(ctx, operation, {}, session, { signal, transport }))
  const config = asObject(Object.hasOwn(reply, 'data') ? reply.data : reply)
  if (config.enabled === false) throw new RsqError('PUSH_DISABLED', '当前账号的消息推送未启用。', 5)
  const teamId = config.teamId == null ? undefined : String(config.teamId)
  if (String(config.userId) !== session.identity.userId || teamId !== session.identity.teamId) {
    throw new RsqError('IDENTITY_CHANGED', '消息连接与当前登录账号或公司不一致。', 3)
  }
  const url = typeof config.url === 'string' ? URL.parse(config.url) : null
  if (!url || url.origin !== pushOrigin || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof config.room !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(config.room)) {
    throw new RsqError('INVALID_PUSH_CONNECTION', '当前账号的消息连接配置无效。', 5)
  }
  return { url: url.origin, room: config.room }
}
