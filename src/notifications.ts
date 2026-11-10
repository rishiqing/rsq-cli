import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '通知服务未返回列表。', 5); return value.map(asObject) }
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
// Current notifyConsts.itemOrderList, including the shared keys used by the
// modern replay service. These names do not enable retired briefing APIs.
const uiKeys = new Set(['createTask','taskFinish','responsibilityTaskFinish','memberTaskFinish','participateTaskFinish','changeTaskName','changeTaskMember','changeTaskDate','commentTask','changeProgress','taskThumbsUp','changeTaskTime','archiveRevertTask','removeRevertTask','resetTask','changeSubTask','subTaskFinish','changeTaskNote','changeTaskPriority','changeTaskLabel','changeTaskAttribution','changeNoteMember','commentNote','archiveRevertNote','removeRevertNote','changeNote','moveNote','changeNoteDate','submitBriefing','revertBriefing','viewBriefing','auditBriefing','refuseBriefing','commentBriefing','joinCompany','changeKanbanMember','changeCorpusMember','archiveRevertKanban','removeRevertKanban','archiveRevertCorpus','removeRevertCorpus','tellInviter','joinDepartment'])
function actor(results: JsonObject, supplied: Session | null) {
  const session = requireSession(supplied), user = asObject(results.user)
  if (!same(user.id, session.identity.userId) || !same(asObject(user.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '通知上下文与当前用户或公司不一致。', 3)
  return { session, user }
}
function visibleSettings(results: JsonObject, supplied: Session | null, app: string) {
  const { user } = actor(results, supplied), settings = asObject(results.settings), result: JsonObject[] = []
  for (const group of ['task','kanban','note','briefing']) for (const [key, value] of Object.entries(asObject(settings[group]))) if (uiKeys.has(key) && [1,2,3,5].includes(Number(value))) result.push({ group, name: key, value, allowedValues: [1,2,3,5] })
  // The customer CLI has a fixed rishiqing.com service allowlist. UI's
  // systemConfig is injected by the page shell, not returned by authAjax.
  const origin = asObject(user.oauth).userFrom, daily = asObject(settings.dailyAlert)
  const channels = [...(app === 'common' ? ['mobile','miniprogram'] : []), ...(origin === 'qywx' ? ['qywx'] : []), ...(origin === 'dingtalk' ? ['dingTalk'] : []), ...(origin === 'lark' ? ['lark'] : [])]
  for (const channel of channels) if (Object.hasOwn(daily, channel)) result.push({ group: 'dailyAlert', name: channel, value: Number(daily[channel]), allowedValues: [0,1] })
  return result
}
export function prepareNotification(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject | null {
  const action = kind.replace('notice-', '')
  if (action === 'page' || action.startsWith('filter-page-')) {
    if (action.startsWith('filter-page-') && action.slice('filter-page-'.length) !== (input.type ?? 'normal')) return null
    return { query: { max: action === 'page' ? input.max ?? 20 : 30, ...(action === 'page' && input.cursor != null && { frontId: input.cursor }) } }
  }
  if (action === 'bulk') return { body: { type: input.type ?? 'normal' } }
  if (action === 'read') {
    const item = rows(results.items).find(item => same(item.id, input.id))
    if (!item) throw new RsqError('FORBIDDEN', '通知必须存在于本人当前应用的指定列表页中；请先分页发现目标。', 4)
    return { body: { id: input.id } }
  }
  if (action.startsWith('setting-')) {
    const entry = visibleSettings(results, supplied, action.slice('setting-'.length)).find(item => item.group === input.group && item.name === input.name)
    if (!entry) throw new RsqError('FORBIDDEN', '此设置不在当前 UI 可见分组、字段或身份平台范围中；请先运行 settings inspect。', 4)
    if (!(entry.allowedValues as unknown[]).includes(input.value)) invalid('设置值不在该字段当前支持的选项中。')
    return { body: { module: input.group, name: input.name, mode: input.value } }
  }
  if (action === 'company') {
    const { session, user } = actor(results, supplied)
    if (!same(input.companyId, session.identity.teamId)) invalid('请明确提供与当前 profile 一致的 companyId。')
    if (!['enterprise','ultimate'].includes(String(asObject(asObject(user.team).status).teamLevel)) || asObject(results.order).mainApp !== 'rsq') throw new RsqError('FEATURE_UPGRADE_REQUIRED', 'UI 仅允许综合应用中的企业版或旗舰版公司统一覆盖通知设置。', 4)
    if (asObject(results.authorities).editAllMemberNotifySettings !== true) throw new RsqError('FORBIDDEN', '当前用户没有统一公司通知设置的权限。', 4)
    return {}
  }
  throw new RsqError('INVALID_CONTRACT', '未知通知上下文适配。', 6)
}
export function verifyNotification(input: JsonObject, results: JsonObject, step: string) {
  if (step === 'verifiedSettings') {
    if (results.reset) {
      if (!isDeepStrictEqual(results[step], results.reset)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '重置后的通知设置与独立读回不一致。', 5)
    } else if (Number(asObject(asObject(results[step])[String(input.group)])[String(input.name)]) !== input.value) throw new RsqError('BUSINESS_ASSERTION_FAILED', '通知设置未在独立读回中确认。', 5)
    return
  }
  const list = rows(results[step])
  if (step === 'verifiedRead') {
    if (!list.some(item => same(item.id, input.id) && item.isRead === true)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '目标通知的已读状态未在本人列表页中确认。', 5)
    return
  }
  if (step.startsWith('verifiedAllRead') && list.some(item => item.isRead !== true)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '仍有未读通知，可能有并发新消息；不自动重放已读操作。', 5)
  if (step.startsWith('verifiedClear') && list.some(item => item.isRead === true)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '仍有已读通知，清理结果尚未确认。', 5)
}
const keys = ['id','type','selfId','senderInfo','content','title','fromWhere','fromBtn','belongTo','numCount','isRead','redBool','dateCreated','titleType','belongToType','taskLineThroughStatus','projectId','planId','stepId','startDate','endDate','replayId','replayCollectId']
export function describeNotifications(input: JsonObject, results: JsonObject, supplied: Session | null, app: string) {
  if (results.settings) return { settings: results.verifiedSettings ?? results.settings, options: visibleSettings({ ...results, settings: results.verifiedSettings ?? results.settings }, supplied, app), sharedReplayKeys: 'briefing 分组是当前复盘通知设置使用的共用存储键，不提供旧简报操作' }
  const allPages = Object.entries(results).find(([key]) => key.startsWith('verifiedAllRead') || key.startsWith('verifiedClear'))
  const list = rows(results.verifiedRead ?? allPages?.[1] ?? results.items)
  const items = list.map(item => Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])))
  if (allPages) return { items, verifiedAllPages: true, ...(allPages[0].startsWith('verifiedAllRead') ? { markedAllRead: true } : { clearedRead: true }) }
  return { items, nextCursor: list.at(-1)?.id ?? null, mayHaveMore: list.length === (input.max ?? 20), ...(input.id != null && { markedReadId: input.id }) }
}
