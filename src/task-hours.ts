import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { assertTaskTargetEditable, taskDate } from './task-business.js'
const same = (a: unknown,b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT',message,2) }
const deny = (message: string): never => { throw new RsqError('FORBIDDEN',message,4) }
const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED',message,5) }
function rows(value: unknown): JsonObject[] { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING','任务工时列表缺失。',5); return value.map(asObject) }
function decimal(value: unknown, digits = 12) {
  const text = String(value)
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text) || text.length > 64) return invalid('工时须为非负十进制数字串。')
  const [whole,fraction = ''] = text.split('.'), rest = fraction.replace(/0+$/,'')
  if (rest.length > digits) return invalid('工时小数位超过允许精度。')
  return { units: BigInt(whole!)*10n**BigInt(digits)+BigInt(rest.padEnd(digits,'0') || '0'), value: whole+(rest ? '.'+rest : '') }
}
function today() { const parts = new Intl.DateTimeFormat('en-CA',{ year: 'numeric',month: '2-digit',day: '2-digit' }).formatToParts(new Date()); return ['year','month','day'].map(type => parts.find(part => part.type === type)!.value).join('-') }
function snapshot(record: JsonObject) {
  return { id: String(record.id),userId: String(asObject(record.user).id),creatorId: String(asObject(record.creator).id),type: record.type,time: decimal(record.time).value,startDate: record.startDate,endDate: record.endDate,desc: record.desc ?? '' }
}
function fieldOf(input: JsonObject,results: JsonObject) {
  const task = asObject(results.task)
  if (!same(task.id,input.taskId) || input.projectId != null && (!same(asObject(results.project).id,input.projectId) || !same(asObject(task.from).projectId,input.projectId))) throw new RsqError('CONTEXT_MISSING','工时所属任务或项目上下文不一致。',5)
  const fields = rows(asObject(results.values).templateFields).filter(field => Number(field.type) === 8 && field.isHidden !== true)
  const selected = input.fieldId != null ? fields.find(field => same(field.id,input.fieldId)) : fields.length === 1 ? fields[0] : undefined
  if (!selected) throw new RsqError('CONTEXT_MISSING','当前任务没有可唯一确定的可见工时字段；请先 inspect 并明确 fieldId。',2)
  return selected
}
function permission(field: JsonObject,type: unknown) {
  if (!['planHour','realHour'].includes(String(type))) invalid('工时类型须为 planHour 或 realHour。')
  if (field.editControl != null && asObject(field.editControl)[type === 'planHour' ? 'canEditPlanHour' : 'canEditRealHour'] !== true) deny('当前字段不允许编辑这种工时。')
}
function memberIds(directory: unknown): Set<string> {
  const ids = new Set<string>()
  const walk = (value: unknown,depth = 0) => {
    if (depth > 100) throw new RsqError('CONTEXT_MISSING','部门层级过深。',5)
    for (const department of rows(value)) { for (const user of rows(department.userList)) ids.add(String(user.id)); walk(department.childList,depth+1) }
  }
  walk(directory); return ids
}
/** Hours are appended/removed by record ID; they are not a replacement array. */
export function buildHoursMutation(field: JsonObject,input: JsonObject,results: JsonObject,supplied: Session | null): JsonObject[] | null {
  const session = requireSession(supplied), before = rows(field.hours ?? []), requested = rows(input.hours), removed = new Set<string>(), added: JsonObject[] = [], body: JsonObject[] = []
  if (Number(field.type) !== 8 || field.isHidden === true || asObject(results.task).forbidEdit === true) deny('当前资源不是可编辑的可见工时字段。')
  const proposals: JsonObject[] = requested.length ? requested : before.map(record => ({ id: record.id,remove: true }))
  for (const proposal of proposals) {
    if (proposal.id != null) {
      const existing = before.find(record => same(record.id,proposal.id))
      if (!existing || removed.has(String(proposal.id))) invalid('工时记录不属于当前字段或重复。')
      if (proposal.remove === true) {
        permission(field,existing!.type)
        if (!same(asObject(existing!.creator).id,session.identity.userId)) deny('与 UI 一致，只能删除本人提交的工时记录。')
        removed.add(String(proposal.id)); body.push({ id: String(proposal.id),remove: true })
      } else {
        // Existing IDs are ignored by the service, never pretend an edit was saved.
        const normalized = snapshot(existing!)
        for (const key of ['type','startDate','endDate','desc']) if (Object.hasOwn(proposal,key) && String(proposal[key] ?? '') !== String(normalized[key as keyof typeof normalized] ?? '')) invalid('已有工时不能原地修改；请显式删除本人记录后新增。')
        if (proposal.time != null && decimal(proposal.time).value !== normalized.time || proposal.user != null && !same(asObject(proposal.user).id,normalized.userId)) invalid('已有工时不能更换工作人或工时数。')
      }
      continue
    }
    if (proposal.remove === true) invalid('删除工时必须提供实际记录 ID。')
    permission(field,proposal.type)
    const userId = String(asObject(proposal.user).id), time = decimal(proposal.time,4).value
    if (!/^[1-9][0-9]*$/.test(userId)) invalid('工作人缺少有效 ID。')
    if (userId !== session.identity.userId && (Number(field.dataType) !== 1 || results.directory == null || !memberIds(results.directory).has(userId))) deny('当前工时字段不允许为此工作人填报；他人须在实际公司目录中且 dataType=1。')
    const startDate = taskDate(proposal.startDate),endDate = taskDate(proposal.endDate)
    if (!startDate || !endDate || startDate.length !== 10 || endDate.length !== 10 || startDate > endDate) invalid('工时必须提供有效的全天起止日期，结束日期不能早于开始日期。')
    if (proposal.type === 'realHour' && endDate! > today()) invalid('与 UI 一致，实际工时不能填报本机当前日期之后的日期。')
    const desc = proposal.desc ?? ''
    if (typeof desc !== 'string' || desc.length > 2000 || proposal.type === 'planHour' && desc !== '') invalid('仅实际工时支持描述，且应在 2000 字以内。')
    body.push({ user: { id: userId },type: proposal.type,time,startDate,endDate,desc })
    added.push({ userId,creatorId: session.identity.userId,type: proposal.type,time,startDate,endDate,desc })
  }
  results.taskHours = { fieldId: String(field.id),before: before.map(snapshot),removedIds: [...removed],added }
  return body.length ? body : null
}
export function prepareTaskHours(kind: string,input: JsonObject,results: JsonObject,supplied: Session | null): JsonObject | null {
  assertTaskTargetEditable(input, results)
  const field = fieldOf(input,results), action = kind.replace('task-hours-','')
  let hours: JsonObject[]
  if (action === 'add') hours = [{ user: { id: input.userId ?? requireSession(supplied).identity.userId },type: input.type,time: input.hours,startDate: input.startDate,endDate: input.endDate,desc: input.description ?? '' }]
  else if (action === 'remove') hours = [{ id: input.recordId,remove: true }]
  else if (action === 'clear') hours = []
  else throw new RsqError('INVALID_CONTRACT','未知任务工时上下文适配。',6)
  const mutation = buildHoursMutation(field,{ hours },results,supplied)
  if (!mutation) return null
  return { body: { taskId: input.taskId,taskTemplateFieldId: String(field.id),module: input.projectId == null ? 'common' : 'project',siteId: input.projectId ?? 'common',hours: mutation } }
}
export function verifyTaskHours(input: JsonObject,results: JsonObject,step: string) {
  const context = asObject(results.taskHours), field = rows(asObject(results[step]).templateFields).find(field => same(field.id,context.fieldId))
  if (!field) fail('工时字段未出现在独立读回中。')
  const actual = rows(field!.hours ?? []).map(snapshot), before = rows(context.before),removed = context.removedIds as string[],added = rows(context.added)
  if (actual.some(record => removed.includes(record.id))) fail('已删除工时记录仍存在，未自动重发。')
  for (const previous of before.filter(record => !removed.includes(String(record.id)))) if (!actual.some(record => isDeepStrictEqual(record,previous))) fail('已有工时记录发生并发变化或丢失，未覆盖其他记录。')
  const newRecords = actual.filter(record => !before.some(previous => same(previous.id,record.id))).map(({ id,...record }) => record)
  const canonical = (values: JsonObject[]) => values.map(record => JSON.stringify(record)).sort()
  if (!isDeepStrictEqual(canonical(newRecords),canonical(added))) fail('新增工时的工作人、类型、数值、日期、描述或创建者未完整读回确认。')
}
export function describeTaskHours(input: JsonObject,results: JsonObject) {
  const current = results.verifiedHours ? { ...results,values: results.verifiedHours } : results,field = fieldOf({ ...input,...(asObject(results.taskHours).fieldId != null && { fieldId: asObject(results.taskHours).fieldId }) },current),records = rows(field.hours ?? []).map(snapshot)
  const total = (type: string) => { const units = records.filter(record => record.type === type).reduce((total,record) => total+decimal(record.time).units,0n), base = 10n**12n, fraction = String(units%base).padStart(12,'0').replace(/0+$/,''); return String(units/base)+(fraction ? '.'+fraction : '') }
  return { taskId: input.taskId,fieldId: String(field.id),name: field.name,dataType: field.dataType,editControl: field.editControl,records,totals: { planHour: total('planHour'),realHour: total('realHour') },verified: results.verifiedHours != null,mutation: '仅追加新记录或按真实 ID 删除本人记录；不替换整个工时数组' }
}
