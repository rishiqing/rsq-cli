import { asObject, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'
import { resolveExecutionFilters } from './execution-context.js'
import { requireUsage, usageData, usageDate, usageError, usageId, usageRows, usageSnapshotPage, type UsageRuntime } from './usage-runtime.js'

export function todoFilters(value: unknown, available: JsonObject[]): JsonObject[] {
  if (value === undefined) return []
  const changes = usageRows(value), keys = new Set(changes.map(change => String(change.key)))
  return resolveExecutionFilters(changes, available).filter(def => keys.has(String(def.key))).map(def => ({...Object.fromEntries(['key','contentValue','operator'].filter(key => Object.hasOwn(def,key)).map(key => [key,def[key]])),...(Array.isArray(def.selector)&&{selector:def.selector.map(raw=>{const value=asObject(raw);return {value:String(value.value),selected:value.selected===true}})})}))
}
export async function runTodoUsage(r: UsageRuntime, action: string, input: JsonObject) {
  await r.identity()
  if (action === 'todo-pending') {
    const page = usageData(await r.call('GET','/task/api/v3/todo/pending/list',{query:{pageNum:input.page ?? 1,pageSize:input.limit ?? 50}}))
    const counts = usageData(await r.call('GET','/task/api/v3/todo/pending/count'))
    const items=usageRows(page.list),number=Number(input.page??1),limit=Number(input.limit??50)
    requireUsage(Number.isSafeInteger(page.total)&&Number(page.total)>=0 && items.length<=limit,'待处理列表没有返回有效总数或分页。')
    return { ...page,counts,pagination:{page:number,limit,nextPage:number*limit<Number(page.total)?number+1:null},context: { userId:r.session.identity.userId }, nextCommands:['task context inspect','task audit inspect','task audit act','workflow instance inspect','replay list'] }
  }
  const startDate = usageDate(input.startDate), endDate = usageDate(input.endDate)
  if (startDate > endDate) usageError('INVALID_INPUT','开始日期不能晚于结束日期。')
  const view = String(input.view ?? 'dayWork'), userId = String(input.userId ?? r.session.identity.userId)
  if (userId !== r.session.identity.userId) {
    const directory = await r.call('GET','/task/v1/department/list')
    if (!companyDirectoryUsers(directory).some(user => String(user.id) === userId)) usageError('FORBIDDEN','目标不在当前公司的可见成员目录中。')
  }
  const context = {startDate,endDate,view,userId,timezone:'Asia/Shanghai'}
  const definitions = usageRows(usageData(await r.call('GET','/task/api/v3/todo/filterCondition',{query:{startDate,endDate,view}})).filter)
  if (action === 'todo-context') return { ...context, filters:definitions, filterScope:'current-user-and-visible-values', sortOptions:['nameSort','startEarly','startLatest','endEarly','createEarly','createLatest'], nextCommands:['todo list','todo calendar','todo pending list','task context inspect','workflow instance inspect'] }
  if (action === 'todo-calendar') {
    if (userId !== r.session.identity.userId) usageError('INVALID_INPUT','当前日期标记接口仅支持本人；同事任务使用 todo list。')
    const data=usageData(await r.call('POST','/task/api/v3/todo/day',{body:{startDate,endDate,view}}))
    requireUsage(data.date===null || typeof data.date==='string','日历标记没有返回当前协议的日期字符串。')
    const dates=data.date?String(data.date).split(',').filter(Boolean).map(value=>usageDate(value.replaceAll('.','-'))):[]
    requireUsage(dates.every(date=>date>=startDate && date<=endDate),'日历标记超出所选日期范围。')
    return { ...context, dates }
  }
  const filters = todoFilters(input.filters,definitions)
  const route = view === 'dayWork' ? '/task/api/v3/todo/mixture/filterList' : '/task/api/v3/todo/filterList'
  const list = usageRows(await r.call('PUT',route,{body:{startDate,endDate,filter:filters,...(userId !== r.session.identity.userId && {userId})}}))
  if (list.length > 100000) usageError('CONTEXT_MISSING','任务候选超过安全查询窗口，请缩小日期或筛选范围。')
  const seen = new Set<string>(), items:JsonObject[] = list.map(item => {
    const kind = item.processInfoId != null ? 'workflow-step' : 'task', id = usageId(item.id), key = kind + ':' + id
    if (seen.has(key)) usageError('RESPONSE_SCHEMA_MISMATCH','任务列表存在重复的业务对象。')
    seen.add(key)
    return {...item,id,kind,...(kind === 'workflow-step' ? {target:{command:'workflow instance inspect',processId:usageId(item.processInfoId),stepId:usageId(item.processInfoStepId ?? item.id)}} : {target:{command:'task context inspect',taskId:id}})}
  })
  const sort = String(input.sort ?? 'createLatest'), sortKey = {nameSort:'name',startEarly:'fullStartDate',startLatest:'fullStartDate',endEarly:'fullEndDate',createEarly:'dateCreated',createLatest:'dateCreated'}[sort]!
  const numericDate = (item: JsonObject) => {
    const value = item[sortKey] ?? (sortKey === 'fullStartDate' ? item.startDate : sortKey === 'fullEndDate' ? item.endDate : undefined)
    if (value == null) return null
    let wire=String(value).replace(/^(\d{4})\.(\d{2})\.(\d{2})/,'$1-$2-$3').replace(' ','T')
    if(/^\d{4}-\d{2}-\d{2}$/.test(wire))wire+='T00:00:00+08:00'
    else if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(wire))wire+='+08:00'
    const parsed = Date.parse(wire)
    return Number.isFinite(parsed) ? parsed : null
  }
  items.sort((a,b) => {
    let result:number
    if (sortKey === 'name') result=String(a.name ?? '').localeCompare(String(b.name ?? ''),'zh-CN')
    else { const x=numericDate(a),y=numericDate(b); if(x==null || y==null) return x==null && y==null ? String(a.kind+':'+a.id).localeCompare(String(b.kind+':'+b.id)) : x==null ? 1 : -1; result=x-y }
    if (['startLatest','createLatest'].includes(sort)) result=-result
    return result || String(a.kind+':'+a.id).localeCompare(String(b.kind+':'+b.id))
  })
  return {...context,sort,...usageSnapshotPage(items,input,{...context,sort,filters,identity:r.session.identity}),nextCommands:['task context inspect','task change','workflow instance inspect','workflow instance act']}
}
