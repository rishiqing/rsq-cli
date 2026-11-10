import { asObject,RsqError,type JsonObject } from './core.js'
import { taskDate } from './task-business.js'
const settings = ['tomatoExecuteTime','tomatoRestTime','tomatoFinishedAlert','tomatoAutoNext','tomatoAutoRest']
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT',message,2) }
const assertion = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED',message,5) }
const pickSettings = (value: unknown) => Object.fromEntries(settings.map(key => [key,asObject(value)[key]]))
function validatePatch(patch: JsonObject) {
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !settings.includes(key))) invalid('请指定当前支持的番茄设置。')
  for (const key of settings) if (Object.hasOwn(patch,key)) {
    const value = patch[key]
    if (key === 'tomatoExecuteTime' ? !Number.isInteger(value) || Number(value) < 5 || Number(value) > 180 || Number(value)%5 !== 0 : key === 'tomatoRestTime' ? !Number.isInteger(value) || Number(value) < 1 || Number(value) > 30 : typeof value !== 'boolean') invalid('设置值不在 UI 允许范围：'+key)
  }
}
function task(input: JsonObject,results: JsonObject) {
  if (input.taskId == null) { if (input.projectId != null) invalid('projectId 必须和 taskId 一起指定。'); return }
  if (String(asObject(results.task).id) !== input.taskId || input.projectId != null && (String(asObject(results.project).id) !== input.projectId || String(asObject(asObject(results.task).from).projectId) !== input.projectId)) throw new RsqError('CONTEXT_MISSING','番茄关联任务或项目归属不一致。',4)
}
export function prepareEfficiency(kind: string,input: JsonObject,results: JsonObject): JsonObject | null {
  const action = kind.replace('efficiency-','')
  if (action === 'task-detail') return input.taskId == null ? null : { query: { id: input.taskId,module: input.projectId == null ? 'common' : 'project',siteId: input.projectId ?? 'common' } }
  if (action === 'task-project') return input.projectId == null ? null : { query: { id: input.projectId } }
  if (action === 'settings') { const patch = asObject(input.patch);validatePatch(patch);results.efficiencyExpected = { ...pickSettings(results.before),...patch };return { body: patch } }
  if (action === 'productivity') {
    if (input.startDate == null && input.endDate == null) return {}
    if (input.startDate == null || input.endDate == null) invalid('统计起止日期必须同时指定。')
    const start = taskDate(input.startDate)!,end = taskDate(input.endDate)!
    if (start.length !== 10 || end.length !== 10 || start > end || (Date.parse(end)-Date.parse(start))/86400000 > 100) invalid('效率统计日期须为有效全天日期、开始不晚于结束且跨度不超过 100 天；不能依赖后台静默回退。')
    return { query: { startDate: start,endDate: end } }
  }
  if (['count','complete','abandon'].includes(action)) {
    if (action !== 'count') results.efficiencyKind = action
    task(input,results)
    if (input.date != null && input.taskId != null) invalid('指定任务时统计累计数，不可同时传日期。')
    const date = input.date == null ? undefined : taskDate(input.date)!
    if (date && date.length !== 10) invalid('计数日期须为 YYYY-MM-DD。')
    return { query: { ...(input.taskId != null && { todoId: input.taskId }),...(date && { date: date.replaceAll('-','.') }) } }
  }
  throw new RsqError('INVALID_CONTRACT','未知效率上下文。',6)
}
export function verifyEfficiency(input: JsonObject,results: JsonObject,step: string) {
  if (step === 'verifiedSettings') {
    for (const [key,value] of Object.entries(asObject(results.efficiencyExpected))) if (asObject(results[step])[key] !== value) assertion('独立读取的番茄设置不符；未自动重发，也未覆盖其他偏好。')
  } else if (step === 'verifiedCount') {
    const before = Number(asObject(results.beforeCount).count),after = Number(asObject(results[step]).count)
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after !== before+1) assertion('完成番茄后的独立计数不是预期增加 1；可能并发或跨日，请检查记录 ID，不要重放记账。')
  } else if (step === 'productivity') {
    const data = asObject(results[step]),start = String(data.startDate),end = String(data.endDate)
    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end) || input.startDate != null && (start !== String(input.startDate).replaceAll('-','') || end !== String(input.endDate).replaceAll('-',''))) assertion('统计实际日期范围和请求不符，后台可能回退了默认范围。')
    let expected: string[] = [],cursor = new Date(start.slice(0,4)+'-'+start.slice(4,6)+'-'+start.slice(6)+'T00:00:00Z')
    for (let i = 0;i < 102 && Number.isFinite(cursor.getTime());i++,cursor = new Date(cursor.getTime()+86400000)) { const day = cursor.toISOString().slice(0,10).replaceAll('-','');if (day > end) break;expected.push(day) }
    if (!expected.length || expected.at(-1) !== end || expected.length > 101) assertion('统计返回了无效或超长日期范围。')
    for (const key of ['efficiencyList','finishedList','unFinishedList']) {
      const values = data[key]
      if (!Array.isArray(values) || values.length !== expected.length || values.some((value,index) => { const row = asObject(value);return row.date !== expected[index] || !/^[0-9]+$/.test(String(row.count)) || !Number.isSafeInteger(Number(row.count)) })) assertion('每日统计日期不连续、存在重复或数值非法：'+key)
    }
    if (data.maxEfficiency !== Math.max(...(data.efficiencyList as JsonObject[]).map(row => Number(row.count)))) assertion('效率峰值和逐日序列不一致。')
  }
}
export function describeEfficiency(input: JsonObject,results: JsonObject) {
  if (results.created) return { id: asObject(results.created).id,kind: results.efficiencyKind,acknowledged: true,independentlyVerified: results.verifiedCount != null,...(results.verifiedCount != null ? { completedCount: asObject(results.verifiedCount).count } : { limitation: '当前业务 HTTP 未提供按 ID 查询放弃记录的明细；仅记录服务端受理凭据。' }) }
  if (results.verifiedSettings || results.before) return { settings: pickSettings(results.verifiedSettings ?? results.before),todayCompletedCount: asObject(results.verifiedSettings ?? results.before).todayTomatoNum,verified: results.verifiedSettings != null,initializationPossible: true }
  return results.count ?? results.productivity ?? results.focus ?? results.today
}
