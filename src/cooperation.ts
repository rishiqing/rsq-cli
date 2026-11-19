import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUsers } from './contact.js'
import { validateWorkflowAvailability } from './access.js'
import { todoWorkflowCommand, todoWorkflowTarget } from './workflow-scope.js'
const rows = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '协作服务未返回预期列表。', 5)
  return value.map(asObject)
}
export function prepareCooperation(kind: string, input: JsonObject, results: JsonObject): JsonObject {
  if (kind.startsWith('cooperation-tasks-')) {
    const view = kind.slice('cooperation-tasks-'.length), approved = view === 'approvals', filter = input.status ?? 'all'
    const value = { all: 0, open: 1, done: 2, unreviewed: 1, reviewed: 2 }[String(filter)]
    if (value === undefined) throw new RsqError('INVALID_INPUT', '未知协作列表筛选。', 2)
    const query = { [approved ? 'approved' : 'finish']: value, sort: input.sort ?? 'createLatest', max: input.limit ?? 20, ...(input.cursor != null && { startId: input.cursor }) }
    results.cooperation = { view, filter, query }
    return { query }
  }
  validateWorkflowAvailability(results.features, asObject(results.authorities))
  if (kind === 'cooperation-workflow-discover') return { body: { todoType: input.queue ?? 'pending', from: 'cooperation', pageNum: 1, pageSize: 1 } }
  if (kind !== 'cooperation-workflow-list') throw new RsqError('INVALID_CONTRACT', '未登记的协作业务适配。')
  const body: JsonObject = { todoType: input.queue ?? 'pending', from: 'cooperation', pageNum: input.pageNum ?? 1, pageSize: input.pageSize ?? 20 }
  const page = asObject(asObject(results.available).data), types = page.applicationTypes == null ? [] : rows(page.applicationTypes)
  for (const [key, options] of [['applicationIds', types], ['userIds', companyDirectoryUsers(results.directory)]] as const) if (input[key] !== undefined) {
    const selected = input[key] as unknown[]
    if (!selected.length || selected.some(id => !options.some(row => String(row.id) === id))) throw new RsqError('FORBIDDEN', '筛选目标不在当前协作队列的应用或公司成员中。', 4)
    body[key === 'applicationIds' ? 'typeIds' : 'userIds'] = selected.join(',')
  }
  if ((input.sortKey == null) !== (input.sortValue == null)) throw new RsqError('INVALID_INPUT', '排序字段和方向须成对提供。', 2)
  if (input.operate !== undefined) {
    const allowed = body.todoType === 'finished' ? ['passed', 'finished'] : ['my', 'participant'].includes(String(body.todoType)) ? [] : ['todo', 'pending']
    if (!allowed.includes(String(input.operate))) throw new RsqError('INVALID_INPUT', '此协作队列不提供所选处理状态筛选。', 2)
  }
  for (const key of ['sortKey', 'sortValue', 'operate', 'processPriorityType']) if (input[key] !== undefined) body[key] = input[key]
  results.cooperation = { queue: body.todoType, pageNum: body.pageNum, pageSize: body.pageSize }
  return { body }
}
export function describeCooperation(input: JsonObject, results: JsonObject) {
  const context = asObject(results.cooperation)
  if (context.view) {
    const page = rows(results.page)
    if (page.some(item => typeof item.id !== 'string' || !item.id || item.id === input.cursor)) throw new RsqError('RESPONSE_SCHEMA_MISMATCH', '协作任务列表缺少有效或前进的真实游标。', 5)
    return { view: context.view, filter: context.filter, items: page, nextCursor: page.at(-1)?.id ?? null, limit: asObject(context.query).max, completeness: 'single-page', sideEffects: ['personal-view-filter-preference-saved'] }
  }
  const page = asObject(asObject(results.page ?? results.available).data)
  const queue = input.queue ?? 'pending'
  const isInstanceQueue = queue === 'my' || queue === 'participant'
  const pageInfo = asObject(page.pageInfo)
  const items = Array.isArray(pageInfo.list) ? rows(pageInfo.list).map(row => {
    const stepId = isInstanceQueue ? undefined : row.type === 'audit' ? row.relatedId ?? row.stepInfoId : row.stepInfoId
    const target = todoWorkflowTarget(row.processInfoId, stepId)
    return target ? { ...row, target } : row
  }) : pageInfo.list
  return { queue, page: page.pageInfo == null ? null : { ...pageInfo, list: items }, applications: page.applicationTypes ?? [],
    ...(results.directory !== undefined && { members: companyDirectoryUsers(results.directory).map(user => ({ id: String(user.id), name: user.showName ?? user.name })) }),
    context: { from: 'cooperation', includesProjectWorkflows: true },
    nextCommands: [todoWorkflowCommand] }
}
