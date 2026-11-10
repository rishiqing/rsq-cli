import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { companyDirectoryUsers, companyDirectoryDepartments } from './contact.js'
import { docDelta, equalDelta } from './doc-context.js'
import { prepareTaskFieldMutation, verifyTaskTemplate } from './task-template.js'
import { taskDatesPatch, verifyTaskBusiness } from './task-business.js'
import type { Workflow } from './workflows.js'

export const replayTopicActions = ["list", "filter-context", "context", "body-get", "create", "update", "reaction", "remove", "records", "fields", "field-set", "comments", "comment-create", "comment-remove", "actions", "action-create", "action-create-batch", "action-update", "action-remove", "action-move", "action-fields", "action-field-set", "action-dates", "okr-candidates", "okrs", "okr-get", "okr-link", "okr-unlink", "okr-update", "okr-note", "okr-task-create", "okr-task-remove", "share-inspect"] as const
export type ReplayTopicAction = typeof replayTopicActions[number]
type Route = [string, string, string]
const base = '/task/okr/replay'
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'INVALID_INPUT' ? 2 : code === 'FORBIDDEN' ? 4 : 5) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('专题复盘上下文缺少精确资源 ID。')
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : fail('专题复盘未返回有界完整列表。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const editable = (value: JsonObject) => { if (asObject(value.editControl).edit !== true) fail('当前专题复盘没有 UI 编辑权限。', 'FORBIDDEN') }
const selectedKeys = (value: JsonObject, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const user = (value: unknown) => selectedKeys(asObject(value), ['id', 'showName', 'name'])
const task = (value: JsonObject) => ({ ...selectedKeys(value, ['id', 'name', 'isDone', 'isClose', 'displayOrder', 'responsibilityId', 'cycle', 'startDate', 'endDate', 'realStartDate', 'realEndDate']), members: rows(value.members ?? []).map(user) })
const describe = (value: JsonObject) => ({ ...selectedKeys(value, ['id', 'title', 'isShare', 'isWideScreen', 'isThumbsUp', 'thumbsUp', 'notifyFlag', 'dateCreated', 'lastUpdated', 'editControl']), ...(value.creator != null && { creator: user(value.creator) }), members: rows(value.userList).map(user), nextActions: rows(value.nextActionList ?? []).map(task) })
const version = (value: JsonObject) => hash(describe(value))
const checkVersion = (value: JsonObject, input: JsonObject) => { if (input.expectedVersion != null && input.expectedVersion !== version(value)) fail('专题复盘上下文已变化，请重新读取；服务端没有原子 CAS。', 'CONTEXT_CONFLICT') }
function date(value: unknown) {
  const parsed = new Date(String(value) + 'T00:00:00Z')
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('日期必须为有效 YYYY-MM-DD 日历日期。', 'INVALID_INPUT')
  return value
}
export function validateReplayTopicInput(input: JsonObject) {
  if (input.content != null && input.title != null) docDelta(input.content)
  for (const key of ['startDate', 'endDate']) if (input[key] != null) date(input[key])
  if (input.startDate != null && input.endDate != null && String(input.startDate) > String(input.endDate)) fail('结束日期不能早于开始日期。', 'INVALID_INPUT')
  if (input.dates != null) taskDatesPatch(asObject(input.dates))
  if (input.requireSourceSync === true && input.patch != null && !['progressCurrent', 'grade', 'confident'].some(key => Object.hasOwn(asObject(input.patch), key))) fail('源值同步核对至少需要进度、评分或信心；专题状态只写快照及记录。', 'INVALID_INPUT')
}
export function replayTopicSteps(action: ReplayTopicAction): Route[] {
  const identity: Route = ['identity', 'GET', '/task/login/authAjax'], directory: Route = ['directory', 'GET', '/task/v1/department/list'], visible: Route = ['visible', 'POST', base + '/list'], before: Route = ['before', 'GET', base]
  if (action === 'list') return [identity, directory, ['items', 'POST', base + '/list'], ['objective', 'GET', '/task/okr/objective'], ['objectiveItems', 'POST', base + '/list/byObjectiveId']]
  if (action === 'filter-context') return [identity, ['filters', 'POST', base + '/member/list']]
  if (action === 'create') return [identity, directory, ['changed', 'POST', base], visible, ['verified', 'GET', base], ['body', 'GET', '/task/reditor/client/resource/get-delta']]
  if (action === 'okr-candidates') return [identity, directory, ['candidates', 'POST', base + '/objective/list']]
  const start = [identity, visible, before]
  if (action === 'body-get') return [...start, ['body', 'GET', '/task/reditor/client/resource/get-delta']]
  if (action === 'context') return [...start, ['fields', 'GET', base + '/field/list'], ['relations', 'GET', base + '/okr/list']]
  if (action === 'actions') return [...start, directory, ['templates', 'GET', '/task/v3/taskTemplate/createTemplateList']]
  if (action === 'records') return [...start, ['records', 'GET', base + '/operationRecord/list']]
  if (action === 'fields' || action === 'field-set') return [...start, ['fields', 'GET', base + '/field/list'], ...(action === 'fields' ? [] : [['preflight', 'GET', base], ['changed', 'PUT', base + '/field'], ['verifiedFields', 'GET', base + '/field/list']] as Route[])]
  if (action.startsWith('comment')) return [...start, ['comments', 'GET', base + '/comment/list'], ...(action === 'comments' ? [] : [directory, ['files', 'GET', '/task/v1/folder/file'], ['preflight', 'GET', base], ['changed', action === 'comment-create' ? 'POST' : 'DELETE', base + '/comment'], ['verifiedComments', 'GET', base + '/comment/list']] as Route[])]
  if (action.startsWith('action-')) {
    const context: Route[] = [directory, ['templates', 'GET', '/task/v3/taskTemplate/createTemplateList'], ['nativeTask', 'GET', '/task/api/v3/task'], ['taskPermissions', 'GET', '/task/api/v3/task/editcontrol'], ['values', 'GET', '/task/api/v3/task/template'], ['files', 'GET', '/task/v1/folder/file']]
    if (action === 'action-fields') return [...start, ...context]
    return [...start, ...context, ['target', 'GET', base], ['targetPreflight', 'GET', base], ['preflight', 'GET', base], ['changed', action.startsWith('action-create') ? 'POST' : action === 'action-remove' ? 'DELETE' : 'PUT', action === 'action-field-set' ? '/task/api/v3/task/template/field' : ['action-dates', 'action-update', 'action-remove'].includes(action) ? '/task/api/v3/task' : base + '/nextAction' + (action === 'action-create-batch' ? '/batch' : action === 'action-move' ? '/sort' : '')], ['verified', 'GET', base], ['verifiedTarget', 'GET', base], ['verifiedTask', 'GET', '/task/api/v3/task'], ['verifiedValues', 'GET', '/task/api/v3/task/template']]
  }
  if (action === 'okrs' || action === 'okr-get') return [...start, ['fields', 'GET', base + '/field/list'], ['relations', 'GET', base + '/okr/list'], ...(action === 'okr-get' ? [['relation', 'GET', base + '/okr/item']] as Route[] : [])]
  if (action.startsWith('okr')) return [...start, ['fields', 'GET', base + '/field/list'], ['relations', 'GET', base + '/okr/list'], ['relation', 'GET', base + '/okr/item'], ['objective', 'GET', '/task/okr/objective'], directory, ['templates', 'GET', '/task/v3/taskTemplate/createTemplateList'], ['nativeTask', 'GET', '/task/api/v3/task'], ['taskPermissions', 'GET', '/task/api/v3/task/editcontrol'], ['preflight', 'GET', base], ['preflightRelations', 'GET', base + '/okr/list'], ['changed', ['okr-unlink', 'okr-task-remove'].includes(action) ? 'DELETE' : ['okr-link', 'okr-task-create'].includes(action) ? 'POST' : 'PUT', action === 'okr-task-remove' ? '/task/api/v3/task' : base + '/okr' + (action === 'okr-note' ? '/progressNote' : action === 'okr-task-create' ? '/task' : '')], ['verifiedRelations', 'GET', base + '/okr/list'], ['verifiedObjective', 'GET', '/task/okr/objective'], ['sourceRecords', 'GET', '/task/okr/progressRecord/detail/list'], ['verifiedTask', 'GET', '/task/api/v3/task']]
  if (action === 'share-inspect') return [...start, ['shared', 'GET', base + '/getShareReplay']]
  if (action === 'update') return [...start, directory, ...['Metadata', 'Members', 'Preferences'].flatMap(group => [[group.toLowerCase() + 'Preflight', 'GET', base], ['changed' + group, 'PUT', base], [group.toLowerCase() + 'Verified', 'GET', base]] as Route[])]
  return [...start, ['preflight', 'GET', base], ['changed', action === 'remove' ? 'DELETE' : 'PUT', base], ['verified', 'GET', base], ['remaining', 'POST', base + '/list']]
}
export function validateReplayTopicWorkflow(flow: Workflow) {
  if (!replayTopicActions.includes(flow.replayTopicAction!)) throw new RsqError('INVALID_CONTRACT', '未知专题复盘操作。', 6)
  const expected = replayTopicSteps(flow.replayTopicAction!)
  if (flow.executor !== 'replay-topic' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return name !== step.id || method !== op?.method || route !== op.route || name === 'body' && asObject(op.defaults?.query).type !== 'replay' || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.resources || step.authentication || step.readback || step.waitBeforeMs || step.expectAbsent
  })) throw new RsqError('INVALID_CONTRACT', '专题复盘步骤与已核对 HTTP 协议不一致。', 6)
}
function relations(value: unknown) {
  const output: (JsonObject & { parentObjectiveId?: string; parentDirect?: boolean })[] = [], seen = new Set<string>()
  const add = (row: JsonObject, parent?: string, parentDirect?: boolean) => {
    if (!['objective', 'keyResult'].includes(String(row.okrType)) || typeof row.isKr !== 'boolean' || typeof row.isDirectRelate !== 'boolean') fail('关联 OKR 类型或实际关联标志缺失。')
    id(row.okrId)
    if (row.isDirectRelate) { const key = id(row.id); if (seen.has(key)) fail('专题关联 ID 重复。'); seen.add(key); output.push({ ...row, ...(parent && { parentObjectiveId: parent, parentDirect }) }) }
    for (const field of rows(row.fieldList)) id(field.id)
  }
  for (const root of rows(value)) { add(root); for (const child of rows(root.krList ?? [])) add(child, id(root.okrId), root.isDirectRelate === true) }
  return output
}
const selectRelation = (value: unknown, wanted: unknown) => relations(value).find(row => same(row.id, wanted)) ?? fail('关联 ID 不属于当前专题复盘实际关系，虚拟父目标不能写入。', 'INVALID_INPUT')
export async function runReplayTopic(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateReplayTopicWorkflow(flow)
  const session = requireSession(supplied), action = flow.replayTopicAction!, completed: string[] = [], resources: Record<string, string> = {}
  let phase = 'identity', pending = false, changed = false
  const knownTasks = new Set<string>()
  const call = async (name: string, args: JsonObject = {}) => {
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) throw new RsqError('INVALID_CONTRACT', '未声明的专题复盘 HTTP 步骤。', 6)
    phase = name; pending = op.effect !== 'read'
    const transport: Transport = async (url, init) => {
      const response = await (options.transport ?? request)(url, init)
      // Keep known assigned IDs even if subsequent response validation fails.
      if (name === 'changed' && op.method === 'POST' && response.ok) try {
        const raw = parseJson(await response.clone().text())
        if (action === 'create') resources.replayId = id(asObject(raw).id)
        else if (action === 'comment-create') resources.commentId = id(asObject(raw).id)
        else if (action === 'okr-task-create') resources.taskId = String(asObject(raw).id)
        else if (action.startsWith('action-create')) for (const [index, task] of rows(raw).filter(row => !knownTasks.has(String(row.id))).entries()) resources['taskId' + (index || '')] = String(task.id)
      } catch {}
      return response
    }
    const value = await runOperation(ctx, op, args, session, { transport, approved: options.approved })
    completed.push(name); pending = false; if (name.startsWith('changed') || name === 'nativeChanged') changed = true
    return value
  }
  const done = (result: unknown) => ({ command: flow.command, completedSteps: completed, resources, result })
  const directory = async () => {
    const value = await call('directory', { query: { cliContext: 'fresh' } })
    return { raw: value, users: companyDirectoryUsers(value), departments: companyDirectoryDepartments(value) }
  }
  const memberIds = (value: unknown, people: JsonObject[], fallback?: string[]) => {
    const ids = value == null ? fallback ?? [] : value as string[]
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(key => !people.some(person => same(person.id, key)))) fail('成员必须来自当前公司的实际目录，不能使用外部组织或重复 ID。', 'INVALID_INPUT')
    return ids.map(id)
  }
  // The legacy GET detail does not enforce visible-directory ownership. Walk
  // every authorized page first; do not turn the first 200 items into a scope.
  const visible = async (name = 'visible') => {
    const all: JsonObject[] = [], seen = new Set<string>(); let after: string | undefined
    for (let page = 0; page < 50; page++) {
      const batch = rows(await call(name, { body: { type: 'all', viewType: 'normal', sortKey: 'dateCreated', sortValue: 'desc', max: 200, ...(after && { frontId: after }) } }))
      if (batch.length > 200) fail('专题复盘页超出声明大小。', 'PAGINATION_CHANGED')
      for (const row of batch) { const key = id(row.id); if (seen.has(key)) fail('专题复盘游标出现重复，未将部分目录作为权限依据。', 'PAGINATION_CHANGED'); seen.add(key); all.push(row) }
      if (batch.length < 200) return all
      after = id(batch.at(-1)!.id)
    }
    return fail('专题复盘可见目录超过 10000 条，尚未证明完整范围；停止依赖范围的操作。', 'PAGINATION_LIMIT')
  }
  const readable = async (wanted: unknown, list: JsonObject[], name: string) => {
    if (!list.some(row => same(row.id, wanted))) fail('专题复盘不在当前公司完整可见目录中。', 'FORBIDDEN')
    const value = asObject(await call(name, { query: { id: wanted } }))
    if (!same(value.id, wanted)) fail('专题复盘详情与已发现资源不一致。')
    rows(value.userList); rows(value.nextActionList ?? []); return value
  }
  try {
    const identity = asObject(await call('identity'))
    if (!same(identity.id, session.identity.userId) || !same(asObject(identity.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', 'profile 与服务端当前用户/公司不一致。', 3)
    if (['list', 'filter-context', 'okr-candidates'].includes(action)) {
      if (input.startDate != null) date(input.startDate); if (input.endDate != null) date(input.endDate)
      if (input.startDate != null && input.endDate != null && String(input.startDate) > String(input.endDate)) fail('结束日期不能早于开始日期。', 'INVALID_INPUT')
      if (action === 'filter-context') return done(await call('filters', { body: { type: input.range ?? 'all', ...selectedKeys(input, ['title', 'startDate', 'endDate']) } }))
      const people = await directory()
      if (action === 'okr-candidates') {
        const responsible = input.responsibleUserId == null ? undefined : memberIds([input.responsibleUserId], people.users)[0]
        return done({ items: await call('candidates', { body: { ...selectedKeys(input, ['startDate', 'endDate']), type: input.range ?? 'my', filterType: input.filter ?? 'all', ...(responsible && { responsibleUserId: responsible }) } }), total: null })
      }
      const query: JsonObject = { viewType: input.view ?? 'normal', max: input.limit ?? 30, sortKey: input.sortKey ?? 'dateCreated', sortValue: input.sortOrder ?? 'desc', ...(input.after != null && { frontId: input.after }) }
      if (input.objectiveId != null) {
        const source = asObject(await call('objective', { query: { id: input.objectiveId } })); if (!same(source.id, input.objectiveId) || asObject(source.editControl).view !== true) fail('所选目标不可见。', 'FORBIDDEN')
        Object.assign(query, { objectiveId: input.objectiveId })
      } else {
        Object.assign(query, { type: input.range ?? 'all', ...selectedKeys(input, ['title', 'startDate', 'endDate']) })
        if (input.memberIds != null) query.userIdList = memberIds(input.memberIds, people.users)
        if (input.departmentIds != null) query.deptIdList = memberIds(input.departmentIds, people.departments)
      }
      const result = rows(await call(input.objectiveId == null ? 'items' : 'objectiveItems', { body: query })), ids = result.map(row => id(row.id)), limit = Number(input.limit ?? 30)
      if (result.length > limit || new Set(ids).size !== ids.length || ids.includes(String(input.after))) fail('专题分页返回超量、重复或原游标。', 'PAGINATION_CHANGED')
      return done({ items: result.map(row => describe({ userList: [], ...row })), pagination: { kind: 'frontId', limit, next: result.length === limit ? ids.at(-1)! : null, total: null } })
    }
    if (action === 'create') {
      const people = await directory(), ids = memberIds(input.memberIds, people.users, [session.identity.userId])
      if (!ids.includes(session.identity.userId)) fail('创建者必须保留在专题复盘参与人中。', 'INVALID_INPUT')
      const content = input.content == null ? undefined : docDelta(input.content)
      const created = asObject(await call('changed', { body: { title: input.title, userIds: ids.join(','), ...(content && { content: JSON.stringify(content) }) } }))
      resources.replayId = id(created.id)
      const current = await readable(resources.replayId, await visible(), 'verified')
      if (current.title !== input.title || !isDeepStrictEqual(rows(current.userList).map(row => id(row.id)).sort(), ids.sort())) fail('新建专题的标题或参与人未独立保存。', 'BUSINESS_ASSERTION_FAILED')
      if (content) { const actual = docDelta(await call('body', { query: { id: resources.replayId } })); equalDelta(actual, content) }
      return done({ ...describe(current), contextVersion: version(current), ...(content && { initialContentSubmitted: true, initialContentHash: hash(content), contentReadback: 'independent-http' }) })
    }
    const directoryItems = await visible(), before = await readable(input.replayId, directoryItems, 'before')
    resources.replayId = id(before.id); checkVersion(before, input)
    if (action === 'body-get') { const delta = docDelta(await call('body', { query: { id: input.replayId } })); return done({ replayId: input.replayId, resourceType: 'replay', delta, sha256: hash(delta), concurrency: 'snapshot-without-server-revision', existingBodyWrite: 'collaborative-transport-outside-http-scope' }) }
    const args = { query: { replayId: input.replayId } }
    const fresh = async () => {
      const current = asObject(await call('preflight', { query: { id: input.replayId } }))
      if (!same(current.id, input.replayId) || version(current) !== version(before)) fail('专题复盘在写入前已变化，停止提交。', 'CONTEXT_CONFLICT')
      return current
    }
    if (action === 'records') return done({ replayId: input.replayId, records: await call('records', args) })
    if (action === 'share-inspect') {
      if (before.isShare !== true || typeof before.encryptId !== 'string' || !before.encryptId) fail('当前专题未开启有效分享。', 'FORBIDDEN')
      const shared = asObject(await call('shared', { query: { id: before.encryptId } }))
      if (!same(shared.id, before.id)) fail('分享内容与已可见专题不一致。', 'BUSINESS_ASSERTION_FAILED')
      return done({ replayId: input.replayId, shared })
    }
    if (['context', 'fields', 'field-set'].includes(action)) {
      const fields = rows(await call('fields', args))
      if (action === 'context') return done({ ...describe(before), fields, relations: await call('relations', args), contextVersion: version(before), relatedCommands: ['replay topic body get', 'replay topic fields set', 'replay topic next-action context', 'replay topic okr list', 'doc template inspect'], content: { creation: 'full Delta via --input and independent HTTP readback', read: 'replay topic body get', existingBodyWrite: 'browser collaboration transport excluded from HTTP scope' }, concurrency: 'observed-context-without-server-cas' })
      if (action === 'fields') return done({ replayId: input.replayId, fields, contextVersion: version(before) })
      editable(before); const chosen = fields.find(field => same(field.id, input.fieldId)); if (!chosen) fail('字段 ID 不属于当前专题实例。', 'INVALID_INPUT')
      await fresh(); await call('changed', { body: { id: input.fieldId, openFlag: input.enabled } })
      const verified = rows(await call('verifiedFields', args)), selected = verified.find(row => same(row.id, input.fieldId))
      if (!selected || selected.openFlag !== input.enabled || !isDeepStrictEqual(verified.filter(row => !same(row.id, input.fieldId)), fields.filter(row => !same(row.id, input.fieldId)))) fail('实例字段开关或其他字段独立读回不一致。', 'BUSINESS_ASSERTION_FAILED')
      return done({ replayId: input.replayId, fields: verified })
    }
    if (action.startsWith('comment')) {
      const comments = rows(await call('comments', args))
      if (comments.some(row => !same(row.replayId, before.id))) fail('评论包含其他专题数据。')
      if (action === 'comments') return done({ replayId: input.replayId, comments })
      let request: JsonObject
      if (action === 'comment-remove') {
        const selected = comments.find(row => same(row.id, input.commentId)); if (!selected || !same(asObject(selected.creator).id, session.identity.userId)) fail('只能删除此专题中本人创建的评论。', 'FORBIDDEN')
        resources.commentId = id(selected.id); request = { query: { id: input.commentId } }
      } else {
        const people = await directory(), members = memberIds(input.atMemberIds, people.users), departments = memberIds(input.atDepartmentIds, people.departments), fileIds = (input.fileIds ?? []) as string[]
        for (const fileId of fileIds) { const file = asObject(await call('files', { query: { id: fileId } })); if (!same(file.id, fileId) || !same(file.creatorId ?? asObject(file.creator).id ?? file.creator, session.identity.userId)) fail('新增评论附件须为当前公司本人上传的文件，先用上传命令取得实际文件 ID。', 'FORBIDDEN') }
        request = { body: { replayId: input.replayId, content: input.content, atIds: members.join(','), atDeptIds: departments.join(','), atType: input.mentionScope ?? '', fileIds: fileIds.join(',') } }
      }
      await fresh(); const created = asObject(await call('changed', request)); if (action === 'comment-create') resources.commentId = id(created.id)
      const after = rows(await call('verifiedComments', args))
      if (action === 'comment-create' ? !after.some(row => same(row.id, resources.commentId) && same(row.replayId, before.id) && row.content === input.content) : after.some(row => same(row.id, input.commentId))) fail('评论写入后独立读回不一致。', 'BUSINESS_ASSERTION_FAILED')
      const kept = comments.filter(row => !same(row.id, input.commentId)).map(row => id(row.id))
      if (kept.some(key => !after.some(row => same(row.id, key)))) fail('无关评论未保留。', 'BUSINESS_ASSERTION_FAILED')
      return done({ replayId: input.replayId, comments: after })
    }
    const taskInput = async (value: JsonObject, batch = false) => {
      const people = await directory(), templates = rows(await call('templates')), template = value.taskTemplateId == null ? templates.filter(row => row.isDefault === true) : templates.filter(row => same(row.id, value.taskTemplateId))
      if (template.length !== 1 || template[0].isMilepost === true || template[0].isStop === true) fail('选择当前可创建普通任务模板；默认类型必须唯一。', 'INVALID_INPUT')
      const members = memberIds(value.memberIds, people.users, [session.identity.userId]), responsible = value.responsibilityId == null ? undefined : memberIds([value.responsibilityId], people.users)[0]
      if (responsible != null && !members.includes(responsible)) fail('行动负责人必须来自所选执行成员。', 'INVALID_INPUT')
      const names = batch ? value.names as string[] : [value.name]
      if (!Array.isArray(names) || !names.length || names.length > 100 || names.some(name => typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f]/.test(name))) fail('任务名称须为非空文本，一次最多 100 个。', 'INVALID_INPUT')
      if (value.startDate != null) date(value.startDate); if (value.endDate != null) date(value.endDate)
      if (value.startDate != null && value.endDate != null && String(value.startDate) > String(value.endDate)) fail('任务结束日期早于开始日期。', 'INVALID_INPUT')
      return { taskTemplateId: id(template[0].id), ...(batch ? { nameArr: names } : { name: value.name }), memberIds: members.join(','), ...(responsible && { responsibilityId: responsible }), ...(value.startDate != null && { realStartDate: value.startDate }), ...(value.endDate != null && { realEndDate: value.endDate }), ...(value.priority != null && { priorityV2: value.priority }) }
    }
    if (action === 'actions') {
      const people = await directory(), templates = await call('templates')
      return done({ replayId: input.replayId, tasks: rows(before.nextActionList ?? []).map(task), members: people.users.map(user), taskTemplates: templates, contextVersion: version(before), permissions: before.editControl, relatedCommands: ['replay topic next-action create', 'replay topic next-action update', 'replay topic next-action move'] })
    }
    if (action.startsWith('action-')) {
      if (action !== 'action-fields') editable(before)
      const beforeTasks = rows(before.nextActionList ?? []), selected = beforeTasks.find(row => row.id === input.taskId)
      for (const row of beforeTasks) knownTasks.add(String(row.id))
      if (!action.startsWith('action-create') && !selected) fail('任务 UUID 不属于当前专题下一步行动。', 'INVALID_INPUT')
      const where = { module: 'objectiveReplay' as const, siteId: String(input.replayId) }
      let nativeTask: JsonObject = {}, permissions: JsonObject = {}, values: JsonObject = {}, fieldResults: JsonObject | undefined, datePatch: JsonObject | undefined
      if (!action.startsWith('action-create')) {
        resources.taskId = String(input.taskId)
        nativeTask = asObject(await call('nativeTask', { query: { id: input.taskId, ...where } }))
        if (!same(nativeTask.id, input.taskId)) fail('行动的独立任务详情 ID 不一致。')
        permissions = asObject(await call('taskPermissions', { query: { taskId: input.taskId, ...where } }))
        if (!same(permissions.taskId, input.taskId) || permissions.module !== where.module || !same(permissions.siteId, where.siteId)) fail('行动权限返回的任务、模块和专题上下文不一致。')
      }
      const permit = (key: string) => { if (nativeTask.forbidEdit === true || asObject(permissions.editControl)[key] !== true) fail('当前行动任务没有 UI 操作权限：' + key, 'FORBIDDEN') }
      if (['action-fields', 'action-field-set'].includes(action) || action === 'action-update' && asObject(input.patch).isDone === true) values = asObject(await call('values', { query: { taskId: input.taskId, ...where } }))
      if (action === 'action-fields') { const people = await directory(); return done({ replayId: input.replayId, taskId: input.taskId, task: nativeTask, permissions, ...values, directory: { users: people.users, departments: people.departments }, relatedCommands: ['replay topic next-action fields set', 'replay topic next-action dates set', 'replay topic next-action update'] }) }
      let request: JsonObject, expectedTasks = beforeTasks.map(row => String(row.id)), target: JsonObject | undefined, expectedTarget: string[] | undefined
      if (action.startsWith('action-create')) request = { body: { ...await taskInput(input, action === 'action-create-batch'), replayId: input.replayId } }
      else if (action === 'action-remove') { permit('removeTask'); request = { query: { id: input.taskId, ...where } } }
      else if (action === 'action-field-set') {
        const chosen = rows(values.templateFields).find(field => same(field.id, input.fieldId))
        if (!chosen) fail('字段 ID 不属于此行动的实际任务模板。', 'INVALID_INPUT')
        const people = await directory()
        if ([22, 36].includes(Number(chosen.type)) && input.value != null && input.value !== '') memberIds(String(input.value).split(','), Number(chosen.type) === 22 ? people.users : people.departments)
        if (Number(chosen.type) === 6 && input.value != null && input.value !== '') {
          const existing = rows(chosen.files ?? []).map(file => id(file.id))
          for (const fileId of String(input.value).split(',').filter(key => !existing.includes(key))) { const file = asObject(await call('files', { query: { id: fileId } })); if (!same(file.id, fileId) || !same(file.creatorId ?? asObject(file.creator).id ?? file.creator, session.identity.userId)) fail('新增行动附件须为当前身份上传的真实文件。', 'FORBIDDEN') }
        }
        fieldResults = { task: nativeTask, values, directory: people.raw }
        const prepared = prepareTaskFieldMutation(input, fieldResults, session, where)
        if (!prepared) return done({ replayId: input.replayId, taskId: input.taskId, unchanged: true, fields: values.templateFields })
        request = prepared
      } else if (action === 'action-dates') {
        permit('editTaskDate'); if (nativeTask.rrule) fail('重复行动的日期需先明确整条重复规则和单次实例，不能静默覆盖。', 'INVALID_INPUT')
        datePatch = taskDatesPatch(asObject(input.dates), nativeTask)
        if (asObject(nativeTask.taskTemplate).isMilepost === true) fail('里程碑日期应使用独立的里程碑闭环。', 'INVALID_INPUT')
        request = { body: { id: input.taskId, ...where, ...datePatch } }
      }
      else if (action === 'action-update') {
        const patch = asObject(input.patch), people = await directory(), native = { ...selectedKeys(patch, ['name', 'isDone']) }
        if (Object.hasOwn(patch, 'name')) permit('editTaskName')
        if (Object.hasOwn(patch, 'isDone')) permit('finishTask')
        if (patch.isDone === true) {
          const missing = rows(values.templateFields).filter(field => field.isRequired === true && field.isHidden !== true && (field.value == null || field.value === '') && !['list', 'hours', 'files', 'tableRows', 'recordList'].some(key => Array.isArray(field[key]) && field[key].length))
          if (missing.length) throw new RsqError('INVALID_INPUT', '行动任务仍有必填字段，请先通过 fields list/set 发现并填写。', 2, { fields: missing.map(field => selectedKeys(field, ['id', 'name', 'type'])) })
        }
        const currentMembers = rows(nativeTask.members ?? []).map(row => id(row.id)), finalMembers = patch.memberIds == null ? currentMembers : memberIds(patch.memberIds, people.users)
        if (patch.memberIds != null) { if (finalMembers.some(key => !currentMembers.includes(key))) permit('addTaskMember'); if (currentMembers.some(key => !finalMembers.includes(key))) permit('removeTaskMember'); native.memberIds = finalMembers.join(',') }
        if (Object.hasOwn(patch, 'responsibilityId')) { permit('addTaskMember'); if (patch.responsibilityId !== null && !finalMembers.includes(String(patch.responsibilityId))) fail('负责人必须来自最终执行成员，清空使用 null。', 'INVALID_INPUT'); native.responsibilityId = patch.responsibilityId }
        request = { body: { id: input.taskId, ...where, ...native } }; resources.taskId = String(input.taskId)
      } else {
        permit('taskSort')
        const targetId = input.targetReplayId ?? input.replayId
        target = same(targetId, input.replayId) ? before : await readable(targetId, directoryItems, 'target'); editable(target)
        const ids = rows(target.nextActionList ?? []).map(row => String(row.id)).filter(key => key !== input.taskId), index = ids.indexOf(String(input.relativeTaskId))
        if (index < 0 || input.relativeTaskId === input.taskId) fail('相邻任务必须来自目标专题的实际行动列表。', 'INVALID_INPUT')
        const position = input.position === 'before' ? index : index + 1
        expectedTarget = [...ids.slice(0, position), String(input.taskId), ...ids.slice(position)]
        expectedTasks = same(targetId, input.replayId) ? expectedTarget : expectedTasks.filter(key => key !== input.taskId)
        request = { body: { moveId: input.taskId, toReplayId: targetId, ...(position > 0 && { frontId: expectedTarget[position - 1] }), ...(position + 1 < expectedTarget.length && { behindId: expectedTarget[position + 1] }) } }
      }
      await fresh()
      if (target && !same(target.id, before.id)) { const current = asObject(await call('targetPreflight', { query: { id: target.id } })); if (!same(current.id, target.id) || version(current) !== version(target)) fail('目标专题在移动前发生变化，停止提交。', 'CONTEXT_CONFLICT') }
      const acknowledgement = await call('changed', request)
      if (action.startsWith('action-create')) {
        const assigned = rows(acknowledgement).filter(row => !beforeTasks.some(old => old.id === row.id))
        for (const [index, row] of assigned.entries()) resources['taskId' + (index || '')] = String(row.id)
      }
      const after = asObject(await call('verified', { query: { id: input.replayId } })), afterTasks = rows(after.nextActionList ?? []), ids = afterTasks.map(row => String(row.id))
      if (!same(after.id, before.id)) fail('行动读回专题不符。', 'BUSINESS_ASSERTION_FAILED')
      if (action.startsWith('action-create')) {
        const created = afterTasks.filter(row => !beforeTasks.some(old => old.id === row.id)), names = action === 'action-create-batch' ? input.names : [input.name]
        if (!isDeepStrictEqual(created.map(row => row.name).sort(), [...names as string[]].sort()) || expectedTasks.some(key => !ids.includes(key))) fail('任务创建回执与独立专题任务列表不符，不能重放。', 'BUSINESS_ASSERTION_FAILED')
        const body = asObject(request.body), expectation = { ...selectedKeys(body, ['realStartDate', 'realEndDate', 'priorityV2', 'responsibilityId']), members: String(body.memberIds ?? '').split(',').filter(Boolean) }
        for (const row of created) {
          const value = asObject(await call('verifiedTask', { query: { id: row.id, module: 'objectiveReplay', siteId: input.replayId } }))
          if (!same(value.id, row.id) || value.name !== row.name || !same(asObject(value.taskTemplate).id, body.taskTemplateId)) fail('协作任务的名称、ID 或实际任务类型未能独立读回。', 'BUSINESS_ASSERTION_FAILED')
          verifyTaskBusiness(input, { verifiedTask: value, taskBusiness: { expected: expectation } }, 'verifiedTask')
        }
      } else if (action === 'action-remove') {
        if (ids.includes(String(input.taskId)) || expectedTasks.filter(key => key !== input.taskId).some(key => !ids.includes(key))) fail('删除下一步行动后列表不符。', 'BUSINESS_ASSERTION_FAILED')
      } else if (action === 'action-field-set') {
        const verifiedValues = await call('verifiedValues', { query: { taskId: input.taskId, ...where } })
        verifyTaskTemplate(input, { ...fieldResults, verifiedValues }, 'verifiedValues')
        if (!isDeepStrictEqual(ids, expectedTasks)) fail('填写后行动归属或顺序改变。', 'BUSINESS_ASSERTION_FAILED')
        return done({ replayId: input.replayId, taskId: input.taskId, fields: asObject(verifiedValues).templateFields, contextVersion: version(after) })
      } else if (action === 'action-dates') {
        const verifiedTask = await call('verifiedTask', { query: { id: input.taskId, ...where } })
        if (!same(asObject(verifiedTask).id, input.taskId) || !isDeepStrictEqual(ids, expectedTasks)) fail('日期写入后任务身份或归属改变。', 'BUSINESS_ASSERTION_FAILED')
        verifyTaskBusiness(input, { verifiedTask, taskBusiness: { expected: datePatch } }, 'verifiedTask')
        return done({ replayId: input.replayId, taskId: input.taskId, task: verifiedTask, contextVersion: version(after) })
      } else if (action === 'action-update') {
        const row = afterTasks.find(row => row.id === input.taskId), patch = asObject(input.patch)
        if (!row || !isDeepStrictEqual([...ids].sort(), [...expectedTasks].sort())) fail('修改后任务范围改变。', 'BUSINESS_ASSERTION_FAILED')
        const native = asObject(await call('verifiedTask', { query: { id: input.taskId, ...where } }))
        if (!same(native.id, input.taskId)) fail('行动的原生任务读回 ID 不一致。', 'BUSINESS_ASSERTION_FAILED')
        for (const key of ['name', 'isDone', 'responsibilityId']) if (Object.hasOwn(patch, key) && (String(row[key] ?? '') !== String(patch[key] ?? '') || String(native[key] ?? '') !== String(patch[key] ?? ''))) fail('任务属性读回不符：' + key, 'BUSINESS_ASSERTION_FAILED')
        if (patch.memberIds != null && !isDeepStrictEqual(rows(row.members).map(row => id(row.id)).sort(), [...patch.memberIds as string[]].sort())) fail('任务成员未独立保存。', 'BUSINESS_ASSERTION_FAILED')
      } else {
        if (!isDeepStrictEqual(ids, expectedTasks)) fail('移动后源专题顺序未符合请求。', 'BUSINESS_ASSERTION_FAILED')
        const targetAfter = same(target!.id, before.id) ? after : asObject(await call('verifiedTarget', { query: { id: target!.id } }))
        if (!same(targetAfter.id, target!.id) || !isDeepStrictEqual(rows(targetAfter.nextActionList).map(row => String(row.id)), expectedTarget)) fail('移动后目标专题顺序未符合请求。', 'BUSINESS_ASSERTION_FAILED')
      }
      return done({ replayId: input.replayId, tasks: afterTasks.map(task), contextVersion: version(after), ...(target && { targetReplayId: target.id, targetOrder: expectedTarget }) })
    }
    if (action.startsWith('okr')) {
      const fields = rows(await call('fields', args)), beforeRelations = await call('relations', args)
      if (input.expectedRelationsVersion != null && input.expectedRelationsVersion !== hash(beforeRelations)) fail('关联树或动态字段值已变化，请重新读取。', 'CONTEXT_CONFLICT')
      if (action === 'okrs') return done({ replayId: input.replayId, fields, relations: beforeRelations, contextVersion: version(before), relationsVersion: hash(beforeRelations) })
      const selected = action === 'okr-link' ? undefined : selectRelation(beforeRelations, input.relationId)
      if (action === 'okr-get') { const current = asObject(await call('relation', { query: { id: selected!.id } })); if (!same(current.id, selected!.id)) fail('关联详情与当前专题不符。'); return done({ replayId: input.replayId, relation: current }) }
      editable(before)
      const objectiveId = action === 'okr-link' ? input.objectiveId : selected!.parentObjectiveId ?? (selected!.okrType === 'objective' ? selected!.okrId : input.objectiveId)
      if (objectiveId == null) fail('关联 KR 需要明确父目标 ID 并从实际目标详情核对。', 'INVALID_INPUT')
      const source = asObject(await call('objective', { query: { id: objectiveId } }))
      if (!same(source.id, objectiveId) || asObject(source.editControl).view !== true) fail('源目标当前不可见。', 'FORBIDDEN')
      let sourceTarget = source, relationKey: JsonObject | undefined, intendedLinks: JsonObject[] = [], noteField: JsonObject | undefined, beforeRelatedTasks: JsonObject[] = [], request: JsonObject
      if (action === 'okr-link' && input.resultId != null || selected?.isKr === true) {
        const resultId = action === 'okr-link' ? input.resultId : selected!.okrId
        const found = rows(source.krList).find(row => same(row.id, resultId) && ['normal', 'subObjective'].includes(String(row.krType)) && row.isPrivate !== true)
        if (!found) fail('KR 必须属于实际可见父目标，不能猜 ID 或混用指标。', 'INVALID_INPUT'); sourceTarget = found
      }
      if (action === 'okr-link') {
        relationKey = { okrId: id(sourceTarget.id), okrType: input.resultId != null && sourceTarget.krType === 'normal' ? 'keyResult' : 'objective', isKr: input.resultId != null }
        if (relations(beforeRelations).some(row => same(row.okrId, relationKey!.okrId) && row.okrType === relationKey!.okrType && row.isKr === relationKey!.isKr)) fail('已有关联，不能重复新增。', 'INVALID_INPUT')
        intendedLinks = [relationKey]
        if (input.resultId == null) {
          // Adding a root replaces its selected child set in the service. The
          // UI first accumulates every current KR; retaining already-linked
          // snapshots also prevents an innocent root addition deleting them.
          const children = relations(beforeRelations).filter(row => same(row.parentObjectiveId, objectiveId)).map(row => selectedKeys(row, ['okrId', 'okrType', 'isKr']))
          for (const kr of rows(source.krList)) {
            if (kr.isPrivate === true) continue
            if (!['normal', 'subObjective'].includes(String(kr.krType))) fail('目标含当前专题未核对的 KR 类型，请明确选择可关联的普通/子目标 KR。', 'INVALID_INPUT')
            const key = { okrId: id(kr.id), okrType: kr.krType === 'normal' ? 'keyResult' : 'objective', isKr: true }
            if (!children.some(row => same(row.okrId, key.okrId) && row.okrType === key.okrType)) children.push(key)
          }
          intendedLinks.push(...children)
        }
        request = { body: { replayId: input.replayId, okrList: intendedLinks } }
      } else if (action === 'okr-unlink') {
        if (selected!.parentDirect) fail('此 KR 随直接关联的根目标展示，UI 不允许单独解除；请解除根目标并核对其子关联范围。', 'FORBIDDEN')
        request = { query: { id: selected!.id } }
      }
      else {
        const control = asObject(selected!.editControl), permit = (key: string) => { if (control[selected!.okrType === 'objective' ? 'edit' : key] !== true) fail('关联 OKR 没有所需 UI 权限：' + key, 'FORBIDDEN') }
        const field = (type: string, wanted?: unknown) => fields.find(field => field.type === type && field.openFlag === true && (wanted == null || same(field.id, wanted))) ?? fail('当前专题缺少已开启的实际 ' + type + ' 字段。', 'INVALID_INPUT')
        if (action === 'okr-task-create' || action === 'okr-task-remove') {
          permit('task'); const selectedField = field('keyAction', input.fieldId)
          beforeRelatedTasks = rows(rows(selected!.fieldList).find(row => same(row.id, selectedField.id))?.taskList ?? [])
          if (action === 'okr-task-create') request = { body: { ...await taskInput(input), replayOkrId: selected!.id, replayOkrFieldId: selectedField.id } }
          else {
            if (!beforeRelatedTasks.some(row => same(row.id, input.taskId)) || !rows(sourceTarget.keyActionList ?? []).some(row => same(asObject(row.task).id, input.taskId))) fail('要删除的任务不同时属于当前专题实际字段和源 OKR。', 'INVALID_INPUT')
            const where = { module: 'objectiveReplay', siteId: input.replayId }, native = asObject(await call('nativeTask', { query: { id: input.taskId, ...where } })), control = asObject(await call('taskPermissions', { query: { taskId: input.taskId, ...where } }))
            if (!same(native.id, input.taskId) || !same(control.taskId, input.taskId) || control.module !== where.module || !same(control.siteId, where.siteId)) fail('源 OKR 关键行动的任务权限上下文不一致。')
            if (native.forbidEdit === true || asObject(control.editControl).removeTask !== true) fail('当前原生任务没有删除权限。', 'FORBIDDEN')
            resources.taskId = String(input.taskId); request = { query: { id: input.taskId, ...where } }
          }
        }
        else if (action === 'okr-note') { permit('advance'); noteField = field('progressNote', input.fieldId); if (input.requireSourceSync === true && fields.filter(row => row.type === 'progressNote' && row.name === noteField!.name).length !== 1) fail('源进展记录只返回字段名称，重名字段无法独立证明对应关系。', 'CONTEXT_MISSING'); request = { body: { replayOkrId: selected!.id, replayFieldId: noteField.id, progressNote: input.content } } }
        else {
          const patch = asObject(input.patch), relationFields = rows(selected!.fieldList)
          for (const key of Object.keys(patch)) {
            const type = key === 'progressCurrent' || key === 'state' ? 'progress' : key
            field(type); permit(type === 'grade' ? 'grade' : 'advance')
            const actual = relationFields.find(field => field.type === type)
            if (!actual) fail('关联未返回对应动态字段。')
            if (key === 'grade' && (!Number.isFinite(actual.gradeLimit) || Number(patch.grade) < 0 || Number(patch.grade) > Number(actual.gradeLimit))) fail('评分超出实际 gradeLimit。', 'INVALID_INPUT')
            if (key === 'progressCurrent' && (!['manual', 'def'].includes(String(actual.progressType)) || actual.progressSyncIndicatorFlag === true)) fail('自动、数据表或指标同步进度不能手填。', 'FORBIDDEN')
            if (key === 'confident' && selected!.okrType === 'objective' && selected!.isKr === false) fail('根目标的信心值由下级汇总，UI 不允许手填。', 'FORBIDDEN')
          }
          request = { body: { replayOkrId: selected!.id, ...patch } }
        }
      }
      await fresh(); if (!isDeepStrictEqual(await call('preflightRelations', args), beforeRelations)) fail('专题关联在写入前变化。', 'CONTEXT_CONFLICT')
      const acknowledged = await call('changed', request); if (action === 'okr-task-create') resources.taskId = String(asObject(acknowledged).id)
      const after = await call('verifiedRelations', args)
      if (action === 'okr-link') {
        const actual = relations(after), found = actual.find(row => same(row.okrId, relationKey!.okrId) && row.okrType === relationKey!.okrType && row.isKr === relationKey!.isKr)
        if (!found) fail('新关联未独立保存。', 'BUSINESS_ASSERTION_FAILED'); resources.relationId = id(found.id)
        if (intendedLinks.some(key => !actual.some(row => same(row.okrId, key.okrId) && row.okrType === key.okrType && row.isKr === key.isKr)) || relations(beforeRelations).some(old => !actual.some(row => same(row.id, old.id)))) fail('根目标的实际 KR 未全部保存或既有关联被意外删除。', 'BUSINESS_ASSERTION_FAILED')
      } else if (action === 'okr-unlink') {
        const removed = relations(beforeRelations).filter(row => same(row.id, selected!.id) || selected!.isKr === false && same(row.parentObjectiveId, selected!.okrId)), actual = relations(after)
        if (removed.some(old => actual.some(row => same(row.id, old.id))) || relations(beforeRelations).filter(row => !removed.some(old => same(old.id, row.id))).some(old => !actual.some(row => same(row.id, old.id)))) fail('解除关联后的根/子关联范围或无关关联保留不一致。', 'BUSINESS_ASSERTION_FAILED')
      }
      else {
        const actual = selectRelation(after, input.relationId), values = rows(actual.fieldList)
        if (action === 'okr-note') { if (values.find(field => same(field.id, input.fieldId))?.progressNote !== input.content) fail('进展说明未独立保存。', 'BUSINESS_ASSERTION_FAILED') }
        else if (action === 'okr-task-create' || action === 'okr-task-remove') {
          const tasks = rows(values.find(field => same(field.id, input.fieldId))?.taskList ?? []), expectedId = action === 'okr-task-create' ? resources.taskId : input.taskId
          if (action === 'okr-task-create' ? !tasks.some(row => same(row.id, expectedId)) : tasks.some(row => same(row.id, expectedId))) fail('实际 keyAction 字段的任务增删未独立保存。', 'BUSINESS_ASSERTION_FAILED')
          if (beforeRelatedTasks.filter(row => !same(row.id, expectedId)).some(row => !tasks.some(actual => same(actual.id, row.id)))) fail('其他相关关键行动未保留。', 'BUSINESS_ASSERTION_FAILED')
        }
        else for (const [key, value] of Object.entries(asObject(input.patch))) if (!values.some(field => field[key] === value)) fail('关联属性未独立保存：' + key, 'BUSINESS_ASSERTION_FAILED')
      }
      const verifiedSource = asObject(await call('verifiedObjective', { query: { id: objectiveId } }))
      if (!same(verifiedSource.id, objectiveId)) fail('源目标独立读回不符。', 'BUSINESS_ASSERTION_FAILED')
      const sourceAfter = selected?.isKr ? rows(verifiedSource.krList).find(row => same(row.id, selected!.okrId)) ?? fail('源 KR 未能独立读回。', 'BUSINESS_ASSERTION_FAILED') : verifiedSource
      let synchronization: JsonObject | undefined
      if (action === 'okr-update' || action === 'okr-note') {
        const sourceFields = selectedKeys(asObject(input.patch), ['progressCurrent', 'grade', 'confident']), observations = Object.entries(sourceFields).map(([key, wanted]) => ({ field: key, before: sourceTarget[key], after: sourceAfter[key], wanted, matches: sourceAfter[key] === wanted }))
        const records = rows(await call('sourceRecords', { query: { objectiveId, ...(selected!.isKr === true && { krId: selected!.okrId, krType: selected!.okrType === 'keyResult' ? 'normal' : 'subObjective' }), filterType: 'all' } })).filter(row => same(asObject(row.replay).id, before.id) && (selected!.isKr ? same(asObject(row.kr).krId, selected!.okrId) : row.kr == null))
        const noteMatched = noteField == null ? null : records.some(record => { const matches = rows(record.fieldList ?? []).filter(field => field.name === noteField!.name); return input.content === '' ? matches.length === 0 || matches.length === 1 && matches[0].note === '' : matches.length === 1 && matches[0].note === input.content })
        synchronization = { eligibility: 'server-relation-date-not-exposed', observations, progressRecordIds: records.map(record => id(record.id)), noteMatched, required: input.requireSourceSync === true }
        if (input.requireSourceSync === true && (!records.length || observations.some(row => !row.matches) || action === 'okr-note' && !noteMatched)) fail('专题已写入，但源 OKR/进展记录未满足要求的独立同步断言；不要重放。', 'SOURCE_SYNC_NOT_VERIFIED')
      }
      if (action === 'okr-task-create') {
        const actual = asObject(await call('verifiedTask', { query: { id: resources.taskId, module: 'objectiveReplay', siteId: input.replayId } })), body = asObject(request.body)
        if (!same(actual.id, resources.taskId) || actual.name !== input.name || !same(asObject(actual.taskTemplate).id, body.taskTemplateId)) fail('实际协作任务名称或类型未独立保存。', 'BUSINESS_ASSERTION_FAILED')
        verifyTaskBusiness(input, { verifiedTask: actual, taskBusiness: { expected: { ...selectedKeys(body, ['realStartDate', 'realEndDate', 'priorityV2', 'responsibilityId']), members: String(body.memberIds ?? '').split(',').filter(Boolean) } } }, 'verifiedTask')
      }
      if (action === 'okr-task-create' || action === 'okr-task-remove') {
        const found = rows(sourceAfter.keyActionList ?? []).some(row => same(asObject(row.task).id, resources.taskId))
        if (action === 'okr-task-create' ? !found : found) fail('源 OKR 的关键行动未独立核对增删结果。', 'BUSINESS_ASSERTION_FAILED')
        const preserved = rows(sourceTarget.keyActionList ?? []).filter(row => !same(asObject(row.task).id, resources.taskId))
        if (preserved.some(old => !rows(sourceAfter.keyActionList ?? []).some(row => same(row.id, old.id)))) fail('源 OKR 无关关键行动未保留。', 'BUSINESS_ASSERTION_FAILED')
      }
      return done({ replayId: input.replayId, relations: after, source: { objectiveId, independentReadback: true, synchronizedValues: selectedKeys(sourceAfter, ['progress', 'progressCurrent', 'grade', 'confident']) }, ...(synchronization && { synchronization }), sourceMayHaveChanged: ['okr-update', 'okr-note', 'okr-task-create', 'okr-task-remove'].includes(action), concurrency: 'observed-context-without-server-cas' })
    }
    if (action !== 'reaction') editable(before)
    if (action === 'update') {
      const patch = asObject(input.patch), groups: [string, JsonObject][] = [['Metadata', selectedKeys(patch, ['title', 'isShare', 'isWideScreen'])]]
      if (patch.memberIds != null) {
        const people = await directory(), members = memberIds(patch.memberIds, people.users)
        if (!members.includes(id(asObject(before.creator).id))) fail('专题创建者不能从参与人中移除。', 'INVALID_INPUT')
        groups.push(['Members', { userIds: members.join(',') }])
      }
      groups.push(['Preferences', selectedKeys(patch, ['notifyFlag'])])
      let observed = before
      // The service uses mutually exclusive branches: members > preferences >
      // metadata. A single mixed PUT silently drops fields. Each branch is a
      // separate confirmed write, followed by an independent read, never replayed.
      for (const [group, body] of groups) {
        if (!Object.keys(body).length) continue
        const current = asObject(await call(group.toLowerCase() + 'Preflight', { query: { id: input.replayId } }))
        if (!same(current.id, before.id) || version(current) !== version(observed)) fail('专题复盘在第 ' + group + ' 组写入前已变化。', 'CONTEXT_CONFLICT')
        editable(current)
        await call('changed' + group, { body: { id: input.replayId, ...body } })
        const after = asObject(await call(group.toLowerCase() + 'Verified', { query: { id: input.replayId } }))
        if (!same(after.id, before.id)) fail('分组写入后读回专题不一致。', 'BUSINESS_ASSERTION_FAILED')
        for (const key of ['title', 'isShare', 'isWideScreen', 'notifyFlag']) {
          const wanted = Object.hasOwn(body, key) ? body[key] : observed[key]
          if (after[key] !== wanted) fail('专题分组修改或原值保留未保存：' + key, 'BUSINESS_ASSERTION_FAILED')
        }
        const wantedMembers = body.userIds == null ? rows(observed.userList).map(row => id(row.id)) : String(body.userIds).split(',')
        if (!isDeepStrictEqual(rows(after.userList).map(row => id(row.id)).sort(), wantedMembers.sort())) fail('专题参与人或保留的参与人未独立保存。', 'BUSINESS_ASSERTION_FAILED')
        observed = after
      }
      return done({ ...describe(observed), contextVersion: version(observed), mutationGroups: groups.filter(([, body]) => Object.keys(body).length).map(([name]) => name), atomic: false })
    }
    let body: JsonObject = { id: input.replayId }
    if (action === 'reaction') body.thumbsUp = input.liked
    await fresh(); await call('changed', action === 'remove' ? { query: { id: input.replayId } } : { body })
    if (action === 'remove') {
      if ((await visible('remaining')).some(row => same(row.id, input.replayId))) fail('移至回收站后仍在可见目录。', 'BUSINESS_ASSERTION_FAILED')
      return done({ replayId: input.replayId, removed: true, removal: 'recycle-and-delete-next-action-tasks', sourceOkrDeletion: false })
    }
    const after = asObject(await call('verified', { query: { id: input.replayId } }))
    if (!same(after.id, before.id)) fail('修改后读回资源不符。', 'BUSINESS_ASSERTION_FAILED')
    for (const key of ['title', 'isShare', 'isWideScreen', 'notifyFlag']) if (Object.hasOwn(body, key) && after[key] !== body[key]) fail('专题修改未保存：' + key, 'BUSINESS_ASSERTION_FAILED')
    if (body.thumbsUp !== undefined && after.isThumbsUp !== body.thumbsUp) fail('本人点赞状态未保存。', 'BUSINESS_ASSERTION_FAILED')
    if (body.userIds != null && !isDeepStrictEqual(rows(after.userList).map(row => id(row.id)).sort(), String(body.userIds).split(',').sort())) fail('专题参与人未保存。', 'BUSINESS_ASSERTION_FAILED')
    return done({ ...describe(after), contextVersion: version(after) })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('BUSINESS_ASSERTION_FAILED', '专题业务执行失败。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, resources, cause: original.details, writeOutcome: pending ? 'unknown' : changed ? 'check-completed-steps' : 'not-started', automaticRetry: false, automaticRollback: false })
  }
}
