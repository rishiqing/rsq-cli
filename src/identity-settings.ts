import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'

function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'IDENTITY_CHANGED' ? 3 : 5) }
const exactId = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('当前资料缺少精确身份 ID。')
const nullableText = (value: unknown) => value == null || value === '' ? null : typeof value === 'string' ? value : fail('当前资料字段格式未知。')
const keys = ['showTipBox', 'fullPopup', 'themeSkin', 'navigationBarStatus', 'docViewMode', 'showChildDeptUsers'] as const
const skinNames = Array.from({ length: 10 }, (_, i) => 'skin_' + i)
function birthday(value: unknown, input = false): string | null {
  if (value == null || value === '') return null
  const code = input ? 'INVALID_INPUT' : 'CONTEXT_MISSING'
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) fail('生日须为有效 YYYY-MM-DD 日历日期或 null。', code)
  const date = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('生日不是有效日历日期。', code)
  if (input) {
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()))
    if (date.getUTCFullYear() > year || date.getUTCFullYear() < year - 100) fail('生日年份须在当前界面支持的最近 100 年至本年范围内。', code)
  }
  return value
}
function identity(value: unknown, session: Session | null) {
  const user = asObject(value), expected = requireSession(session).identity
  if (exactId(user.id) !== expected.userId || (user.team == null ? undefined : exactId(asObject(user.team).id)) !== expected.teamId || user.username !== expected.username) fail('服务端身份与当前 profile 不一致，请重新登录或显式切换公司。', 'IDENTITY_CHANGED')
  return user
}
function profile(user: JsonObject) {
  if (typeof user.personRealName !== 'string' || !Object.hasOwn(user, 'professional') || !Object.hasOwn(user, 'birth')) fail('当前资料缺少完整姓名、职位或生日上下文。')
  const birth = nullableText(user.birth)
  return { name: user.personRealName, position: nullableText(user.professional), birthday: birthday(birth?.replaceAll('.', '-')) }
}
function settings(user: JsonObject) {
  const setting = asObject(user.setting)
  for (const key of keys) {
    if (!Object.hasOwn(setting, key)) fail('当前设置缺少可独立读回的字段：' + key)
    if (['showTipBox', 'fullPopup', 'showChildDeptUsers'].includes(key) ? typeof setting[key] !== 'boolean' : typeof setting[key] !== 'string') fail('当前设置字段类型未知：' + key)
  }
  return Object.fromEntries(keys.map(key => [key, setting[key]]))
}
function stableSettings(user: JsonObject) {
  // expireAlertFlag is computed from the current date and company order. It is
  // not a persisted preference and is never used as a replacement payload.
  return Object.fromEntries(Object.entries(asObject(user.setting)).filter(([key]) => key !== 'expireAlertFlag'))
}
function save(results: JsonObject, value: JsonObject) { results.prepared = { ...asObject(results.prepared), ...value } }
export function validateIdentitySettingsInput(input: JsonObject) {
  if (Object.hasOwn(input, 'birthday')) birthday(input.birthday, true)
  if (Object.hasOwn(input, 'name') && (typeof input.name !== 'string' || !input.name.trim() || /[\x00-\x1f\x7f]/.test(input.name))) fail('姓名不能为空白或包含控制字符。', 'INVALID_INPUT')
  if (typeof input.position === 'string' && /[\x00-\x1f\x7f]/.test(input.position)) fail('职位不能包含控制字符。', 'INVALID_INPUT')
}
export function prepareIdentitySettings(kind: string, input: JsonObject, results: JsonObject, session: Session | null): JsonObject | null {
  const before = identity(results.current, session), latest = identity(results.preflight, session), action = kind.replace('identity-settings-', '')
  if (!isDeepStrictEqual(profile(before), profile(latest)) || !isDeepStrictEqual(stableSettings(before), stableSettings(latest))) fail('资料或设置在写入前发生变化；请重新发现上下文，不会覆盖或重放。', 'CONTEXT_CONFLICT')
  const expectedProfile = profile(latest), expectedSettings = settings(latest), body: JsonObject = {}
  if (action === 'profile-update') {
    for (const key of Object.keys(input)) if (!['name', 'position', 'birthday'].includes(key)) fail('不支持的资料字段。', 'INVALID_INPUT')
    if (Object.hasOwn(input, 'name')) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\x00-\x1f\x7f]/.test(input.name)) fail('姓名须为 1 至 200 字且不能包含控制字符。', 'INVALID_INPUT')
      expectedProfile.name = input.name
      if (input.name !== profile(latest).name) body.personRealName = input.name
    }
    if (Object.hasOwn(input, 'position')) {
      if (input.position !== null && (typeof input.position !== 'string' || input.position.length > 200 || /[\x00-\x1f\x7f]/.test(input.position))) fail('职位须为最多 200 字或 null。', 'INVALID_INPUT')
      expectedProfile.position = nullableText(input.position)
      if (expectedProfile.position !== profile(latest).position) body.professional = expectedProfile.position ?? ''
    }
    if (Object.hasOwn(input, 'birthday')) {
      expectedProfile.birthday = birthday(input.birthday, true)
      if (expectedProfile.birthday !== profile(latest).birthday) body.birth = expectedProfile.birthday?.replaceAll('-', '.') ?? null
    }
  } else if (action === 'preferences-update' || action === 'contact-display-update') {
    const allowed = action === 'contact-display-update' ? ['showChildDeptUsers'] : keys.filter(key => key !== 'showChildDeptUsers')
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.includes(key as typeof keys[number])) fail('不支持的个人偏好字段；公司可见性和安全设置需独立权限命令。', 'INVALID_INPUT')
      if (['showTipBox', 'fullPopup', 'showChildDeptUsers'].includes(key) ? typeof value !== 'boolean' : key === 'themeSkin' ? !skinNames.includes(String(value)) : key === 'navigationBarStatus' ? !['drawer', 'sidebar', 'topbar'].includes(String(value)) : !['normal', 'wide'].includes(String(value))) fail('个人设置值不在当前界面支持的选项中。', 'INVALID_INPUT')
      if (key === 'docViewMode' && value !== expectedSettings.docViewMode) fail('当前服务端 UserDaoService.updateUserUI 白名单遗漏 docViewMode，HTTP 成功也不持久化；需部署服务端修复后再修改文档宽度。本次全部偏好补丁均未发送。', 'PERSISTENCE_UNSUPPORTED')
      expectedSettings[key] = value
      if (value !== settings(latest)[key]) body[key] = value
    }
  } else fail('未知资料编排。', 'INVALID_CONTRACT')
  if (!Object.keys(input).length) fail('至少明确提供一个需要修改的字段。', 'INVALID_INPUT')
  save(results, { action, expectedProfile, expectedSettings, body, resources: { userId: requireSession(session).identity.userId, ...(requireSession(session).identity.teamId && { teamId: requireSession(session).identity.teamId }) } })
  return Object.keys(body).length ? { body } : null
}
export function verifyIdentitySettings(results: JsonObject, step: string, session: Session | null) {
  const user = identity(results[step], session)
  profile(user); settings(user)
  if (step !== 'verified') return
  const before = identity(results.preflight, session), prepared = asObject(results.prepared)
  if (!isDeepStrictEqual(profile(user), prepared.expectedProfile) || !isDeepStrictEqual(settings(user), prepared.expectedSettings)) fail('独立读回的资料或个人偏好不符合预期；已受理写入不会重放。', 'BUSINESS_ASSERTION_FAILED')
  const expected = prepared.action === 'profile-update' ? stableSettings(before) : { ...stableSettings(before), ...asObject(prepared.body) }
  if (!isDeepStrictEqual(stableSettings(user), expected)) fail('未修改的个人设置发生变化；请检查并发操作，不会静默覆盖。', 'BUSINESS_ASSERTION_FAILED')
  for (const key of ['email', 'phoneNumber', 'hasAvatar', 'avatar']) if (!isDeepStrictEqual(before[key], user[key])) fail('账号绑定或头像发生变化；请核对账号状态，不会重放写入。', 'BUSINESS_ASSERTION_FAILED')
}
export function describeIdentitySettings(results: JsonObject, session: Session | null) {
  const user = identity(results.verified ?? results.current, session)
  return { identity: requireSession(session).identity, profile: profile(user), preferences: settings(user),
    scope: { name: 'account', birthday: 'account', position: 'current-company-user', preferences: 'current-company-user', showChildDeptUsers: 'personal-display-only' },
    options: { themeSkin: skinNames, navigationBarStatus: ['drawer', 'sidebar', 'topbar'], docViewMode: ['normal', 'wide'] },
    persistence: { docViewMode: { writable: false, reason: 'server-update-whitelist-omits-docViewMode', unchangedValueAllowed: true } },
    ...(results.prepared ? { changed: Object.keys(asObject(asObject(results.prepared).body)).length > 0, verified: true } : {}),
    relatedCommands: ['organization list', 'organization context', 'organization switch', 'identity profile update', 'identity preferences update', 'contact display update'] }
}
