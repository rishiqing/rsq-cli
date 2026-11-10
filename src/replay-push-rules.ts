import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { fingerprint } from './fingerprint.js'
import { requireSession, type Session } from './session.js'
import { replayIntelligenceEnabled } from './replay.js'

const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const denied = (message: string): never => { throw new RsqError('FORBIDDEN', message, 4) }
const missing = (message: string): never => { throw new RsqError('CONTEXT_MISSING', message, 5) }
const assertion = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : missing('复盘推送需要实际 HTTP 返回的有界目录。')
const ruleId = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? value : missing('推送规则必须使用实际目录中的 MongoDB 资源 ID。')
function actor(results: JsonObject, supplied: Session | null) {
  const session = requireSession(supplied), user = asObject(results.identity)
  if (!same(user.id, session.identity.userId) || !same(asObject(user.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '复盘推送上下文与当前账号或公司不一致。', 3)
}
function gate(input: JsonObject, results: JsonObject) {
  const permissions = asObject(results[input.application === 'okr' ? 'okrPermissions' : 'companyPermissions'])
  if (permissions.replayManage !== true) denied('当前 UI 未授予复盘管理权限 replayManage。')
  if (!replayIntelligenceEnabled(input, results)) throw new RsqError('FEATURE_FORBIDDEN', '复盘智能推送要求 replayIntelligence 权限及服务端白名单，CLI 遵循当前 UI 限制。', 4)
}
function directory(results: JsonObject) {
  const list = rows(asObject(results.rules).list), keys = list.map(row => ruleId(row.id))
  if (new Set(keys).size !== keys.length) missing('推送规则目录包含重复 ID。')
  return list
}
function current(input: JsonObject, results: JsonObject) {
  if (!directory(results).some(row => row.id === input.ruleId)) denied('所选规则不在当前公司的实际推送目录中。')
  const result = asObject(results.before)
  if (result.id !== input.ruleId) missing('推送规则详情与实际目录不符。')
  if (input.expectedVersion !== undefined && input.expectedVersion !== fingerprint(result)) throw new RsqError('CONTEXT_CONFLICT', '规则已变化，请重新读取后修改；没有发送写入。', 5)
  return result
}
export function replayWebhookPlatform(value: unknown): string {
  if (typeof value !== 'string') invalid('需要服务支持的 HTTPS 机器人 Webhook 地址。')
  let url: URL
  try { url = new URL(value as string) } catch { return invalid('Webhook 地址格式不正确。') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) invalid('Webhook 需要不含用户信息、端口或片段的 HTTPS 地址。')
  if (url.hostname === 'qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send') return 'wecom'
  if (url.hostname === 'oapi.dingtalk.com' && url.pathname === '/robot/send') return 'dingtalk'
  if (url.hostname === 'open.feishu.cn' && url.pathname.startsWith('/open-apis/bot/v2/hook/') && url.pathname.length > '/open-apis/bot/v2/hook/'.length) return 'lark'
  if (url.hostname === 'xz.wps.cn' && url.pathname === '/api/v1/webhook/send') return 'wps'
  return invalid('当前服务只支持企业微信、钉钉、飞书和 WPS 的固定机器人 Webhook 入口。')
}
function collects(value: unknown, results: JsonObject) {
  if (!Array.isArray(value) || !value.length || value.length > 10000 || new Set(value).size !== value.length) invalid('请选择无重复的日报复盘集 ID 数组。')
  const available = rows(results.collections)
  return (value as unknown[]).map(key => {
    if (typeof key !== 'string' || !/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(Number(key))) invalid('复盘集 ID 必须能无损编码为当前 Node 服务要求的数字。')
    const matches = available.filter(row => same(row.id, key) && row.type === 'day')
    if (matches.length !== 1 || typeof matches[0].name !== 'string') denied('推送范围只能包含当前可管理目录中的日报集，不能使用周报、月报或猜测的 ID。')
    return { id: Number(key), name: matches[0].name }
  })
}
function body(input: JsonObject, results: JsonObject, source?: JsonObject) {
  const patch = source ? asObject(input.patch) : input
  const result: JsonObject = source ? Object.fromEntries(['id', 'name', 'status', 'webhookUrl', 'webhookSecret', 'webhookRemark', 'replayCollectList', 'cycleType', 'dataWindow', 'pushTime', 'skipHoliday'].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]))
    : { name: input.name, status: input.enabled === true ? 'enabled' : 'disabled', webhookUrl: input.webhookUrl, webhookSecret: input.webhookSecret ?? '', webhookRemark: input.webhookRemark ?? '', cycleType: 'day', dataWindow: 'yesterday', pushTime: input.pushTime ?? '09:00', skipHoliday: input.skipHoliday ?? false }
  for (const key of ['name', 'webhookUrl', 'webhookSecret', 'webhookRemark', 'pushTime', 'skipHoliday']) if (Object.hasOwn(patch, key)) result[key] = patch[key]
  if (Object.hasOwn(patch, 'enabled')) result.status = patch.enabled === true ? 'enabled' : 'disabled'
  if (typeof result.name !== 'string' || !result.name.trim() || result.name.length > 200) invalid('规则名称不能为空且不能超过 200 字符。')
  if (!['enabled', 'disabled'].includes(String(result.status)) || result.cycleType !== 'day' || result.dataWindow !== 'yesterday' || typeof result.skipHoliday !== 'boolean') missing('当前规则含服务未支持的周期、数据窗口或状态，不覆盖未知配置。')
  if (typeof result.pushTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.pushTime)) invalid('推送时间必须是 GMT+8 的有效 HH:mm。')
  replayWebhookPlatform(result.webhookUrl)
  result.webhookRemark ??= ''
  if (typeof result.webhookSecret !== 'string' || typeof result.webhookRemark !== 'string') missing('规则缺少完整 Webhook 配置，不能用省略参数清空原有密钥。')
  const selected = Object.hasOwn(patch, 'collectionIds') ? patch.collectionIds : source ? rows(source.replayCollectList).map(row => String(row.id)) : input.collectionIds
  result.replayCollectList = collects(selected, results)
  return result
}
export function prepareReplayPushRule(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject | null {
  actor(results, supplied)
  const action = kind.replace('replay-push-rule-', '')
  if (action === 'company-permissions') return input.application === 'okr' ? null : {}
  if (action === 'okr-permissions') return input.application === 'okr' ? {} : null
  if (action === 'intelligence') return {}
  gate(input, results)
  if (action === 'collections' || action === 'list') return {}
  if (action === 'detail') {
    if (!directory(results).some(row => row.id === input.ruleId)) denied('所选规则不在当前公司的实际目录中。')
    return { query: { id: input.ruleId } }
  }
  if (action === 'created-readback') return { query: { id: ruleId(asObject(results.changed).id) } }
  if (action === 'readback') return { query: { id: ruleId(input.ruleId) } }
  const before = action === 'create' ? undefined : current(input, results)
  if (action === 'remove') { results.pushExpected = { removed: input.ruleId, beforeIds: directory(results).map(row => row.id) }; return { query: { id: input.ruleId } } }
  if (!['create', 'update', 'preview', 'test-send'].includes(action)) throw new RsqError('INVALID_CONTRACT', '未知复盘推送规则上下文适配。', 6)
  if (action === 'update' && !Object.keys(asObject(input.patch)).length) invalid('请提供至少一项规则修改。')
  const payload = body(input, results, before)
  results.pushExpected = { payload, beforeIds: directory(results).map(row => row.id) }
  return { body: payload }
}
export function verifyReplayPushRule(input: JsonObject, results: JsonObject, step: string) {
  const expected = asObject(results.pushExpected)
  if (step === 'sent' && asObject(results.sent).success !== true) throw new RsqError('WEBHOOK_SEND_FAILED', '服务端未确认测试消息成功；可能已产生 AI 费用，不自动重试。', 5)
  if (step === 'verified') {
    const actual = asObject(results.verified), payload = asObject(expected.payload)
    if (actual.id !== (input.ruleId ?? asObject(results.changed).id)) assertion('规则读回 ID 不一致。')
    for (const [key, value] of Object.entries(payload)) if (!isDeepStrictEqual(actual[key], value)) assertion('推送规则配置读回不一致：' + key)
  }
  if (step === 'verifiedRules') {
    const list = rows(asObject(results.verifiedRules).list), keys = list.map(row => ruleId(row.id)), old = expected.beforeIds as string[]
    if (new Set(keys).size !== keys.length || expected.removed !== undefined && keys.includes(String(expected.removed))) assertion('规则删除或独立目录读回不一致。')
    if (old.some(key => key !== expected.removed && !keys.includes(key))) assertion('原有其他规则在读回时缺失，结果需要人工核对。')
    if (expected.removed === undefined && !keys.includes(ruleId(asObject(results.changed).id))) assertion('保存的规则没有出现在独立目录。')
  }
}
export function describeReplayPushRules(input: JsonObject, results: JsonObject) {
  const safe = (row: JsonObject) => ({ ...Object.fromEntries(['id', 'name', 'status', 'webhookRemark', 'webhookConfigured', 'cycleType', 'dataWindow', 'pushTime', 'skipHoliday', 'createdAt', 'updatedAt'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])),
    replayCollectList: rows(row.replayCollectList).map(item => ({ id: item.id, name: item.name })),
    version: fingerprint(row), ...(typeof row.webhookUrl === 'string' && { webhookPlatform: replayWebhookPlatform(row.webhookUrl), webhookSecretConfigured: Boolean(row.webhookSecret) }) })
  return { application: input.application ?? 'rishiqing',
    ...(results.collections !== undefined && { collections: rows(results.collections).filter(row => row.type === 'day').map(row => ({ id: String(row.id), name: row.name, type: row.type })) }),
    ...(results.rules !== undefined && { rules: (results.verifiedRules === undefined ? directory(results) : rows(asObject(results.verifiedRules).list)).map(safe) }),
    ...(results.before !== undefined && asObject(results.pushExpected).removed === undefined && { rule: safe(asObject(results.verified ?? results.before)) }),
    ...(results.before === undefined && results.verified !== undefined && { rule: safe(asObject(results.verified)) }),
    ...(results.preview !== undefined && { preview: results.preview, consumesAiCredits: true, sendsMessage: false }),
    ...(results.sent !== undefined && { sent: { success: true }, consumesAiCredits: true, sendsMessage: true }),
    ...(asObject(results.pushExpected).removed !== undefined && { removed: asObject(results.pushExpected).removed }),
    timeZone: 'Asia/Shanghai', dateWindow: 'previous-calendar-day', limitations: ['预览和试发均调用 AI 并记账；试发会向规则配置的机器人发送消息。', '启用规则后服务端定时发送；本地 dry-run 完全离线。', '写请求不会自动重放；前置版本核对没有原子 CAS。'] }
}
