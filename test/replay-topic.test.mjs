import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), base = '/task/okr/replay'
const flow = suffix => { const found = workflows.workflows.find(flow => flow.command === 'replay topic ' + suffix); assert.ok(found, suffix); return found }
const run = (suffix, input, f, options = {}) => runWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, approved: true, ...options })
const person = { id: '81', showName: '本人' }, other = { id: '82', showName: '同事' }
const nativeTask = (id, name, order) => ({ id, name, displayOrder: order, isDone: false, members: [person], responsibilityId: '81' })
function fixture(options = {}) {
  const calls = [], reports = [
    { id: '51', title: '第一专题', creator: person, userList: [person], editControl: { edit: !options.readonly }, nextActionList: [nativeTask('task-a', '行动 A', 1), nativeTask('task-b', '行动 B', 2)], isShare: false, isWideScreen: true, isThumbsUp: true, notifyFlag: true },
    { id: '52', title: '第二专题', creator: person, userList: [person], editControl: { edit: !options.readonlyTarget }, nextActionList: [nativeTask('task-c', '行动 C', 1)], isShare: true, encryptId: 'private-share-fixture', isWideScreen: false, isThumbsUp: false, notifyFlag: false },
  ]
  const fields = [{ id: '61', type: 'grade', name: '评分', openFlag: true }, { id: '62', type: 'progress', name: '进展', openFlag: true }, { id: '63', type: 'confident', name: '信心', openFlag: true }, { id: '64', type: 'progressNote', name: '说明', openFlag: true }, { id: '65', type: 'keyAction', name: '行动', openFlag: true }]
  const comments = [{ id: '71', replayId: '51', creator: person, content: '本人评论' }, { id: '72', replayId: '51', creator: other, content: '他人评论' }]
  const relationFields = () => fields.map(field => ({ ...field, ...(field.type === 'grade' && { grade: 0, gradeLimit: 5 }), ...(field.type === 'progress' && { progressCurrent: 0, progressType: options.auto ? 'auto' : 'manual', progressSyncIndicatorFlag: options.indicator === true, state: 'normal' }), ...(field.type === 'confident' && { confident: 0 }), ...(field.type === 'progressNote' && { progressNote: '旧说明' }), ...(field.type === 'keyAction' && { taskList: [] }) }))
  const relations = [{ id: '91', okrId: '101', okrType: 'objective', isKr: false, isDirectRelate: !options.virtualRoot, name: '源目标', editControl: { edit: !options.noRelationEdit }, fieldList: relationFields(), krList: [] }]
  const objective = { id: '101', name: '源目标', editControl: { view: !options.noSourceView }, progressCurrent: 0, grade: 0, confident: 0, keyActionList: [], krList: [{ id: '102', name: '普通 KR', krType: 'normal', isPrivate: false, progressCurrent: 0, grade: 0, confident: 0, keyActionList: [], editControl: { advance: true, task: true, grade: true } }] }
  const allRelations = () => relations.flatMap(row => [row, ...row.krList]), relationById = wanted => allRelations().find(row => row.id === wanted)
  const records = []
  const saveRecord = selected => {
    if (options.noSourceSync) return
    let record = records.find(row => row.replay.id === '51' && (selected.isKr ? row.kr?.krId === selected.okrId : row.kr == null))
    if (!record) { record = { id: String(301 + records.length), replay: { id: '51', name: '第一专题' }, kr: selected.isKr ? { krId: selected.okrId, krType: 'normal' } : null, fieldList: [] }; records.push(record) }
    record.fieldList = selected.fieldList.filter(field => field.type === 'progressNote' && field.progressNote).map(field => ({ name: field.name, note: field.progressNote }))
  }
  const taskFields = [{ id: '201', name: '备注', type: 1, value: '', isRequired: options.required === true, isHidden: false, editControl: { canEdit: !options.readonlyField } }, { id: '202', name: '状态', type: 3, value: '', isCheckBox: false, selector: [{ id: '211', name: '开始', value: 'start' }], editControl: { canEdit: true } }]
  const bodies = new Map([['51', [{ insert: '第一专题正文\n' }]], ['52', []]])
  let gets = 0, counter = 0, targetGets = 0
  const directory = [{ id: '7', name: '当前公司', type: 'top', parentId: null, displayOrder: 1, childList: [], userList: [person, other] }]
  const transport = async (url, init) => {
    const path = url.pathname, method = init.method, query = Object.fromEntries(url.searchParams), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, query, body })
    if (path.endsWith('/authAjax')) return json({ id: 81, token: 'fixture', username: 'fixture', success: true, team: { id: options.otherTeam ? 8 : 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'REPLAY', status: options.disabled ? 'disable' : 'enable' }, { funcName: 'TASK_TYPE', status: options.typesDisabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return json({ useReplay: true })
    if (path.endsWith('/department/list')) return json(directory)
    if (path.endsWith('/createTemplateList')) return json([{ id: '111', name: '普通任务', icon: 1, isDefault: true, isMilepost: options.milestone === true, isStop: false }])
    if (path === '/task/reditor/client/resource/get-delta') { assert.equal(query.type, 'replay'); assert.ok(bodies.has(query.id)); return json(options.staleBodyReadback ? [{ insert: '没有保存的正文\n' }] : bodies.get(query.id)) }
    if (path === '/task/v1/folder/file') return json({ id: query.id, name: 'fixture.txt', creatorId: options.otherFileOwner ? '82' : '81' })
    if (path === '/task/api/v3/task/editcontrol') return json({ ...query, editControl: Object.fromEntries(['editTaskName', 'finishTask', 'addTaskMember', 'removeTaskMember', 'removeTask', 'taskSort', 'editTaskDate'].map(key => [key, key !== options.forbiddenTaskPermission])) })
    if (path === '/task/api/v3/task/template') return json({ templateFields: taskFields })
    if (path === '/task/api/v3/task/template/field') { if (!options.staleFieldReadback) Object.assign(taskFields.find(field => field.id === body.taskTemplateFieldId), Object.fromEntries(['value', 'time', 'placeholder', 'list', 'hours', 'tableRows'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]))); return json(null) }
    if (path === '/task/api/v3/task') {
      const task = reports.flatMap(row => row.nextActionList).find(row => row.id === query.id) ?? allRelations().flatMap(row => row.fieldList).flatMap(field => field.taskList ?? []).find(row => row.id === query.id)
      if (method === 'PUT') { const current = reports.flatMap(row => row.nextActionList).find(row => row.id === body.id); Object.assign(current, body); if (body.memberIds != null) current.members = body.memberIds ? body.memberIds.split(',').map(id => directory[0].userList.find(user => user.id === id)) : []; return json(current) }
      if (method === 'DELETE') {
        const parent = reports.find(row => row.nextActionList.includes(task)); if (parent) parent.nextActionList.splice(parent.nextActionList.indexOf(task), 1)
        for (const relation of allRelations()) for (const field of relation.fieldList) if (field.taskList) field.taskList = field.taskList.filter(row => row.id !== query.id)
        for (const owner of [objective, ...objective.krList]) owner.keyActionList = owner.keyActionList.filter(row => row.task.id !== query.id)
        return new Response(null, { status: 200 })
      }
      assert.ok(task, 'Independent native task exists'); return json(task)
    }
    if (path === '/task/okr/objective') return json(objective)
    if (path === '/task/okr/progressRecord/detail/list') return json(records)
    if (path === base + '/list' || path === base + '/list/byObjectiveId') {
      if (options.page) return json(options.page(body, reports))
      return json(reports.map(row => { const { creator, ...simple } = row; return { ...simple, nextActionList: body.viewType === 'task' ? row.nextActionList : [] } }).slice(0, body.max ?? 200))
    }
    if (path === base + '/member/list') return json({ userList: [person], deptList: [], groupList: [] })
    if (path === base + '/objective/list') return json([objective])
    if (path === base && method === 'GET') {
      const row = reports.find(row => row.id === query.id); assert.ok(row)
      if (options.drift && ++gets === 2) row.title = '并发改名'
      if (options.targetDrift && query.id === '52' && ++targetGets === 2) row.title = '目标并发改名'
      return json(row)
    }
    if (path === base && method === 'POST') {
      if (options.timeout) throw Error('transport timeout')
      const row = { ...structuredClone(reports[0]), id: '53', title: body.title, userList: body.userIds.split(',').map(id => directory[0].userList.find(row => row.id === id)), nextActionList: [] }
      reports.push(row)
      bodies.set(row.id, body.content ? JSON.parse(body.content).ops : [])
      if (options.badCreateResponse) return json({ id: '53' })
      return json(row)
    }
    if (path === base && method === 'PUT') {
      const row = reports.find(row => row.id === body.id); assert.ok(row)
      if (body.userIds != null) row.userList = body.userIds.split(',').map(id => directory[0].userList.find(row => row.id === id))
      else if (body.thumbsUp != null || body.notifyFlag != null) { if (options.preferenceTimeout) throw Error('preference transport timeout'); if (body.thumbsUp != null) row.isThumbsUp = body.thumbsUp; if (body.notifyFlag != null) row.notifyFlag = body.notifyFlag }
      else for (const key of ['title', 'isShare', 'isWideScreen']) if (Object.hasOwn(body, key)) row[key] = body[key]
      return json(row)
    }
    if (path === base && method === 'DELETE') { reports.splice(reports.findIndex(row => row.id === query.id), 1); return new Response(null, { status: 200 }) }
    if (path === base + '/field/list') return json(fields)
    if (path === base + '/field') { fields.find(row => row.id === body.id).openFlag = body.openFlag; return json(null) }
    if (path === base + '/comment/list') return json(comments.filter(row => row.replayId === query.replayId))
    if (path === base + '/comment' && method === 'POST') { const row = { id: '73', replayId: body.replayId, content: body.content, creator: person }; comments.push(row); return json(row) }
    if (path === base + '/comment' && method === 'DELETE') { comments.splice(comments.findIndex(row => row.id === query.id), 1); return json(null) }
    if (path === base + '/operationRecord/list') return json([{ id: '121', content: '创建专题' }])
    if (path === base + '/getShareReplay') { assert.equal(query.id, 'private-share-fixture'); return json({ id: '52', title: reports[1].title }) }
    if (path.startsWith(base + '/nextAction')) {
      const row = method === 'POST' ? reports.find(row => row.id === body.replayId) : reports.find(row => row.nextActionList.some(task => task.id === (body?.id ?? body?.moveId ?? query.id))); assert.ok(row)
      if (path.endsWith('/sort')) {
        const selected = row.nextActionList.find(task => task.id === body.moveId), target = reports.find(row => row.id === body.toReplayId)
        row.nextActionList.splice(row.nextActionList.indexOf(selected), 1)
        const position = body.frontId ? target.nextActionList.findIndex(task => task.id === body.frontId) + 1 : 0
        target.nextActionList.splice(position, 0, selected); return json(null)
      }
      if (method === 'POST') for (const name of body.nameArr ?? [body.name]) { row.nextActionList.push({ ...nativeTask('created-task-' + ++counter, name, 99), taskTemplate: { id: body.taskTemplateId }, ...Object.fromEntries(['realStartDate', 'realEndDate', 'priorityV2', 'responsibilityId'].filter(key => Object.hasOwn(body, key) && !(options.ignoredCreateDates && key.startsWith('real'))).map(key => [key, body[key]])), members: body.memberIds ? body.memberIds.split(',').map(id => directory[0].userList.find(row => row.id === id)) : [] }) }
      if (method === 'PUT') { const task = row.nextActionList.find(row => row.id === body.id); Object.assign(task, Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'memberIds'))); if (body.memberIds != null) task.members = body.memberIds ? body.memberIds.split(',').map(id => directory[0].userList.find(row => row.id === id)) : [] }
      if (method === 'DELETE') { row.nextActionList.splice(row.nextActionList.findIndex(row => row.id === query.id), 1); return json(null) }
      return json(row.nextActionList)
    }
    if (path === base + '/okr/list') return json(relations)
    if (path === base + '/okr/item') return json(relationById(query.id))
    if (path === base + '/okr/task') {
      const row = { ...nativeTask('okr-created-task', body.name, 1), taskTemplate: { id: body.taskTemplateId } }, relation = relationById(body.replayOkrId); relation.fieldList.find(field => field.id === body.replayOkrFieldId).taskList.push(row)
      const owner = relation.isKr ? objective.krList.find(kr => kr.id === relation.okrId) : objective
      if (!options.noSourceSync) owner.keyActionList.push({ id: '411', type: 'task', task: row })
      return json(row)
    }
    if (path === base + '/okr/progressNote') { const relation = relationById(body.replayOkrId); relation.fieldList.find(field => field.id === body.replayFieldId).progressNote = body.progressNote; saveRecord(relation); return json(null) }
    if (path === base + '/okr' && method === 'POST') {
      if (body.okrList.some(key => key.okrId === '101' && !key.isKr)) {
        relations[0].isDirectRelate = true; relations[0].id = '93'
        relations[0].krList = relations[0].krList.filter(child => body.okrList.some(key => key.okrId === child.okrId && key.isKr))
      }
      for (const key of body.okrList.filter(key => key.isKr)) if (!relations[0].krList.some(row => row.okrId === key.okrId)) relations[0].krList.push({ id: key.okrId === '102' ? '92' : '94', ...key, isDirectRelate: true, editControl: { advance: true, grade: true, task: true }, fieldList: relationFields(), krList: [] })
      return json(null)
    }
    if (path === base + '/okr' && method === 'DELETE') { const index = relations.findIndex(row => row.id === query.id); if (index >= 0) relations.splice(index, 1); else for (const root of relations) root.krList = root.krList.filter(row => row.id !== query.id); return json(null) }
    if (path === base + '/okr' && method === 'PUT') { const row = relationById(body.replayOkrId), owner = row.isKr ? objective.krList.find(kr => kr.id === row.okrId) : objective; for (const [key, value] of Object.entries(body).filter(([key]) => key !== 'replayOkrId')) { const type = ['progressCurrent', 'state'].includes(key) ? 'progress' : key; row.fieldList.find(field => field.type === type)[key] = value; if (key !== 'state' && !options.noSourceSync) owner[key] = value } saveRecord(row); return json(null) }
    throw Error('Unexpected request ' + method + ' ' + path)
  }
  return { calls, reports, fields, comments, relations, objective, records, transport }
}
const mutations = f => f.calls.filter(call => !['GET', 'HEAD'].includes(call.method) && !call.path.endsWith('/list'))

test('topic has executable HTTP contracts distinct from periodic replay and exposes schemas', () => {
  const actual = workflows.workflows.filter(flow => flow.executor === 'replay-topic'); assert.equal(actual.length, 33)
  for (const item of actual) { assert.ok(item.resultSchema); assert.ok(item.capabilities.includes('replay/topic')); assert.ok(item.steps.length); assert.ok(item.limitations.some(text => text.includes('初始 Delta'))) }
})
test('offline planning has zero HTTP, requires confirmation and rejects protocol tampering', async () => {
  const f = fixture(), input = { title: '专题' }; await run('create', input, f, { dryRun: true, approved: false }); assert.equal(f.calls.length, 0)
  await assert.rejects(run('create', input, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const edited = structuredClone(flow('context')); edited.steps.at(-1).operationId = catalog.operations.find(op => op.route === base && op.method === 'GET').id
  await assert.rejects(runWorkflow(ctx, edited, { replayId: '51' }, session, { dryRun: true, transport: f.transport }), { code: 'INVALID_CONTRACT' })
})
test('raw detail, comments and field routes cannot bypass business visibility', async () => {
  for (const route of ['', '/field/list', '/comment/list']) {
    const f = fixture(), op = catalog.operations.find(op => op.method === 'GET' && op.route === base + route)
    await assert.rejects(executeOperation(ctx, op, { query: route ? { replayId: '51' } : { id: '51' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
  }
})
test('body HTTP uses its fixed replay purpose after visibility; ordinary doc operation cannot substitute', async () => {
  const f = fixture(), output = await run('body get', { replayId: '51' }, f); assert.equal(output.result.delta.ops[0].insert, '第一专题正文\n')
  const denied = fixture(); await assert.rejects(run('body get', { replayId: '999' }, denied), { code: 'FORBIDDEN' }); assert.equal(denied.calls.some(call => call.path.includes('/reditor/')), false)
  const edited = structuredClone(flow('body get')); edited.steps.at(-1).operationId = 'rsq.4594cf138d6c'
  await assert.rejects(runWorkflow(ctx, edited, { replayId: '51' }, session, { dryRun: true, transport: denied.transport }), { code: 'INVALID_CONTRACT' })
  const stale = fixture({ staleBodyReadback: true }); await assert.rejects(run('create', { title: '元信息成功但正文未保存', content: '实际要求的正文' }, stale), error => error.code === 'BUSINESS_ASSERTION_FAILED' && error.details.failedStep === 'body' && error.details.resources.replayId === '53'); assert.equal(mutations(stale).length, 1)
})
test('visibility walks beyond the UI first page and rejects missing or repeated IDs before detail', async () => {
  const f = fixture({ page: body => body.frontId ? [{ ...fixture().reports[0], id: '51' }] : Array.from({ length: 200 }, (_, i) => ({ ...fixture().reports[0], id: String(1000 + i) })) })
  await run('context', { replayId: '51' }, f); assert.equal(f.calls.filter(call => call.path === base + '/list').length, 2)
  const missing = fixture(); await assert.rejects(run('context', { replayId: '999' }, missing), { code: 'FORBIDDEN' }); assert.equal(missing.calls.some(call => call.path === base), false)
  const repeated = fixture({ page: () => Array.from({ length: 200 }, () => ({ ...fixture().reports[0], id: '51' })) })
  await assert.rejects(run('context', { replayId: '51' }, repeated), { code: 'PAGINATION_CHANGED' }); assert.equal(repeated.calls.some(call => call.path === base), false)
})
test('company expiration, overcapacity and entitlement apply before topic HTTP', async () => {
  for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY'], [{ disabled: true }, 'FEATURE_DISABLED']]) {
    const f = fixture(options); await assert.rejects(executeWorkflow(ctx, flow('context'), { replayId: '51' }, session, { transport: f.transport }), { code }); assert.equal(f.calls.some(call => call.path.startsWith(base)), false)
  }
})
test('member filters, cursor and objective-specific listing preserve semantics', async () => {
  const f = fixture(), output = await run('list', { range: 'myIn', memberIds: ['81'], departmentIds: ['7'], limit: 2, view: 'task' }, f)
  assert.equal(output.result.pagination.next, '52'); const wire = f.calls.find(call => call.path === base + '/list').body; assert.deepEqual(wire.userIdList, ['81']); assert.equal(wire.viewType, 'task')
  await run('list', { objectiveId: '101' }, fixture())
  await assert.rejects(run('list', { objectiveId: '101', range: 'all' }, fixture()), { code: 'INVALID_INPUT' })
})
test('creation independently checks members; patch and reaction preserve false and creator', async () => {
  const f = fixture(); const created = await run('create', { title: '新专题', memberIds: ['81', '82'], content: '正文' }, f)
  assert.equal(created.resources.replayId, '53'); const body = f.calls.find(call => call.path === base && call.method === 'POST').body; assert.deepEqual(JSON.parse(body.content), { ops: [{ insert: '正文\n' }] })
  const after = await run('update', { replayId: '53', patch: { title: '更名', isShare: false, notifyFlag: false, isWideScreen: false, memberIds: ['81'] } }, f); assert.equal(after.result.notifyFlag, false); assert.equal(after.result.members.length, 1)
  assert.equal(after.result.title, '更名'); assert.deepEqual(after.result.mutationGroups, ['Metadata', 'Members', 'Preferences']); assert.equal(after.result.atomic, false)
  await run('reaction set', { replayId: '51', liked: false }, f); assert.equal(f.reports[0].isThumbsUp, false)
  const guard = fixture(); await assert.rejects(run('update', { replayId: '51', patch: { memberIds: ['82'] } }, guard), { code: 'INVALID_INPUT' }); assert.equal(mutations(guard).length, 0)
})
test('grouped metadata failure retains completed writes and never replays the timed-out group', async () => {
  const f = fixture({ preferenceTimeout: true })
  await assert.rejects(run('update', { replayId: '51', patch: { title: '已保存名称', memberIds: ['81', '82'], notifyFlag: false } }, f), error => error.details.failedStep === 'changedPreferences' && error.details.completedSteps.includes('metadataVerified') && error.details.completedSteps.includes('membersVerified') && error.details.writeOutcome === 'unknown')
  assert.equal(f.reports[0].title, '已保存名称'); assert.equal(f.reports[0].userList.length, 2); assert.equal(mutations(f).length, 3)
})
test('read-only users can set own reaction but cannot edit metadata or cross-profile identity', async () => {
  const f = fixture({ readonly: true }); await run('reaction set', { replayId: '51', liked: false }, f)
  await assert.rejects(run('update', { replayId: '51', patch: { title: '失败' } }, f), { code: 'FORBIDDEN' })
  const foreign = fixture({ otherTeam: true }); await assert.rejects(run('context', { replayId: '51' }, foreign), { code: 'IDENTITY_CHANGED' }); assert.equal(foreign.calls.some(call => call.path.startsWith(base)), false)
})
test('assigned ID survives invalid create acknowledgement; timeout never replays a mutation', async () => {
  const f = fixture({ badCreateResponse: true }); await assert.rejects(run('create', { title: '新专题' }, f), error => error.code === 'RESPONSE_SCHEMA_MISMATCH' && error.details.resources.replayId === '53'); assert.equal(mutations(f).length, 1)
  const timeout = fixture({ timeout: true }); await assert.rejects(run('create', { title: '新专题' }, timeout), error => error.details.writeOutcome === 'unknown' && error.details.automaticRetry === false); assert.equal(mutations(timeout).length, 1)
})
test('observed context mismatch stops metadata writes instead of overwriting concurrent edits', async () => {
  const f = fixture({ drift: true }); await assert.rejects(run('update', { replayId: '51', patch: { title: '覆盖' } }, f), { code: 'CONTEXT_CONFLICT' }); assert.equal(mutations(f).length, 0)
})
test('field toggles use actual instance IDs and retain unrelated fields', async () => {
  const f = fixture(), result = await run('fields set', { replayId: '51', fieldId: '64', enabled: false }, f); assert.equal(result.result.fields.find(field => field.id === '64').openFlag, false); assert.equal(f.fields[0].openFlag, true)
  const foreign = fixture(); await assert.rejects(run('fields set', { replayId: '51', fieldId: '999', enabled: false }, foreign), { code: 'INVALID_INPUT' }); assert.equal(mutations(foreign).length, 0)
})
test('comments independently read back, validate mentions and prevent deletion of another author', async () => {
  const f = fixture(); await run('comment create', { replayId: '51', content: '<p>HTTP</p>', atMemberIds: ['82'], atDepartmentIds: ['7'] }, f); await run('comment remove', { replayId: '51', commentId: '73' }, f); assert.equal(f.comments.length, 2)
  await assert.rejects(run('comment remove', { replayId: '51', commentId: '72' }, f), { code: 'FORBIDDEN' })
  const foreign = fixture({ otherFileOwner: true }); await assert.rejects(run('comment create', { replayId: '51', content: '附件', fileIds: ['123'] }, foreign), { code: 'FORBIDDEN' }); assert.equal(mutations(foreign).length, 0)
})
test('next actions create and batch use native task IDs and independent Task HTTP readback', async () => {
  const f = fixture(); const output = await run('next-action create', { replayId: '51', name: '新行动', startDate: '2097-01-01', endDate: '2097-01-02' }, f); assert.ok(output.resources.taskId)
  await run('next-action create-batch', { replayId: '51', names: ['批量 1', '批量 2'] }, f)
  const wire = f.calls.find(call => call.path === base + '/nextAction' && call.method === 'POST').body; assert.equal(wire.realStartDate, '2097-01-01'); assert.equal(wire.taskTemplateId, '111')
  assert.equal(f.calls.filter(call => call.path === '/task/api/v3/task').length, 3)
  const milestone = fixture({ milestone: true }); await assert.rejects(run('next-action create', { replayId: '51', name: '错误类型' }, milestone), { code: 'INVALID_INPUT' }); assert.equal(mutations(milestone).length, 0)
  const ignored = fixture({ ignoredCreateDates: true }); await assert.rejects(run('next-action create', { replayId: '51', name: '日期未保存', startDate: '2097-01-01' }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(mutations(ignored).length, 1)
})
test('custom task type and field workflows enforce the UI entitlement before business HTTP', async () => {
  for (const [suffix, input] of [['next-action create', { name: '不创建', taskTemplateId: '111' }], ['next-action fields list', { taskId: 'task-a' }]]) {
    const f = fixture({ typesDisabled: true }); await assert.rejects(executeWorkflow(ctx, flow(suffix), { replayId: '51', ...input }, session, { approved: true, transport: f.transport }), { code: 'FEATURE_DISABLED' }); assert.equal(f.calls.some(call => call.path.startsWith(base)), false)
  }
})
test('next-action update preserves false and empty membership, deletion retains unrelated tasks', async () => {
  const f = fixture(); await run('next-action update', { replayId: '51', taskId: 'task-a', patch: { responsibilityId: null } }, f); assert.equal(f.reports[0].nextActionList[0].responsibilityId, null)
  await run('next-action update', { replayId: '51', taskId: 'task-a', patch: { isDone: false, memberIds: [], name: '修改' } }, f)
  assert.deepEqual(f.reports[0].nextActionList[0].members, []); await run('next-action remove', { replayId: '51', taskId: 'task-a' }, f); assert.deepEqual(f.reports[0].nextActionList.map(row => row.id), ['task-b'])
  const foreign = fixture(); await assert.rejects(run('next-action remove', { replayId: '51', taskId: 'task-c' }, foreign), { code: 'INVALID_INPUT' }); assert.equal(mutations(foreign).length, 0)
})
test('task UI permissions and required fields stop mutations even when parent is editable', async () => {
  for (const [suffix, input, options] of [
    ['next-action update', { patch: { name: '不可写' } }, { forbiddenTaskPermission: 'editTaskName' }],
    ['next-action update', { patch: { isDone: true } }, { required: true }],
    ['next-action remove', {}, { forbiddenTaskPermission: 'removeTask' }],
    ['next-action update', { patch: { memberIds: [] } }, { forbiddenTaskPermission: 'removeTaskMember' }],
    ['next-action update', { patch: { responsibilityId: '82' } }, {}],
  ]) {
    const f = fixture(options); await assert.rejects(run(suffix, { replayId: '51', taskId: 'task-a', ...input }, f), error => ['FORBIDDEN', 'INVALID_INPUT'].includes(error.code)); assert.equal(mutations(f).length, 0)
  }
  const f = fixture({ required: true }); await run('next-action fields set', { replayId: '51', taskId: 'task-a', fieldId: '201', value: '已填' }, f); await run('next-action update', { replayId: '51', taskId: 'task-a', patch: { isDone: true } }, f); assert.equal(f.reports[0].nextActionList[0].isDone, true)
})
test('action field context resolves real options and verifies values independently', async () => {
  const f = fixture(); const context = await run('next-action fields list', { replayId: '51', taskId: 'task-a' }, f); assert.equal(context.result.templateFields[1].selector[0].id, '211')
  await run('next-action fields set', { replayId: '51', taskId: 'task-a', fieldId: '202', value: '开始' }, f)
  const body = f.calls.find(call => call.path === '/task/api/v3/task/template/field').body; assert.equal(body.module, 'objectiveReplay'); assert.equal(body.siteId, '51'); assert.equal(body.value, 'start')
  await run('next-action fields set', { replayId: '51', taskId: 'task-a', fieldId: '202', value: null }, f)
  const stale = fixture({ staleFieldReadback: true }); await assert.rejects(run('next-action fields set', { replayId: '51', taskId: 'task-a', fieldId: '201', value: '未保存' }, stale), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(mutations(stale).length, 1)
  const denied = fixture({ readonlyField: true }); await assert.rejects(run('next-action fields set', { replayId: '51', taskId: 'task-a', fieldId: '201', value: '不写' }, denied), { code: 'FORBIDDEN' }); assert.equal(mutations(denied).length, 0)
})
test('action dates use native ISO date context and preserve omitted endpoints', async () => {
  const f = fixture(); await run('next-action dates set', { replayId: '51', taskId: 'task-a', dates: { start: '2097-01-01', end: '2097-01-03' } }, f)
  await run('next-action dates set', { replayId: '51', taskId: 'task-a', dates: { start: null } }, f)
  assert.equal(f.reports[0].nextActionList[0].realStartDate, null); assert.equal(f.reports[0].nextActionList[0].realEndDate, '2097-01-03')
  const invalid = fixture(); await assert.rejects(run('next-action dates set', { replayId: '51', taskId: 'task-a', dates: { start: '2097-02-30' } }, invalid, { dryRun: true }), { code: 'INVALID_INPUT' }); assert.equal(invalid.calls.length, 0)
  await assert.rejects(run('next-action dates set', { replayId: '51', taskId: 'task-a', dates: { start: '2097-01-04' } }, f), { code: 'INVALID_INPUT' })
})
test('cross-topic movement validates both sides and real neighboring tasks', async () => {
  const f = fixture(); await run('next-action move', { replayId: '51', taskId: 'task-a', targetReplayId: '52', relativeTaskId: 'task-c', position: 'after' }, f)
  assert.deepEqual(f.reports[0].nextActionList.map(row => row.id), ['task-b']); assert.deepEqual(f.reports[1].nextActionList.map(row => row.id), ['task-c', 'task-a'])
  const readonly = fixture({ readonlyTarget: true }); await assert.rejects(run('next-action move', { replayId: '51', taskId: 'task-a', targetReplayId: '52', relativeTaskId: 'task-c', position: 'before' }, readonly), { code: 'FORBIDDEN' }); assert.equal(mutations(readonly).length, 0)
  const changed = fixture({ targetDrift: true }); await assert.rejects(run('next-action move', { replayId: '51', taskId: 'task-a', targetReplayId: '52', relativeTaskId: 'task-c', position: 'before' }, changed), { code: 'CONTEXT_CONFLICT' }); assert.equal(mutations(changed).length, 0)
})
test('related OKR link resolves actual KR semantics and unlink retains source target', async () => {
  const f = fixture({ virtualRoot: true }); await run('okr link', { replayId: '51', objectiveId: '101', resultId: '102' }, f)
  const wire = f.calls.find(call => call.path === base + '/okr' && call.method === 'POST').body; assert.deepEqual(wire.okrList, [{ okrId: '102', okrType: 'keyResult', isKr: true }])
  await run('okr unlink', { replayId: '51', relationId: '92', objectiveId: '101' }, f); assert.equal(f.objective.id, '101')
  const invisible = fixture({ noSourceView: true }); await assert.rejects(run('okr link', { replayId: '51', objectiveId: '101', resultId: '102' }, invisible), { code: 'FORBIDDEN' }); assert.equal(mutations(invisible).length, 0)
})
test('adding a root collects actual KRs and preserves already-linked child snapshots', async () => {
  const f = fixture({ virtualRoot: true })
  await run('okr link', { replayId: '51', objectiveId: '101', resultId: '102' }, f)
  const childId = f.relations[0].krList[0].id
  await run('okr link', { replayId: '51', objectiveId: '101' }, f)
  const body = f.calls.filter(call => call.path === base + '/okr' && call.method === 'POST').at(-1).body
  assert.deepEqual(body.okrList, [{ okrId: '101', okrType: 'objective', isKr: false }, { okrId: '102', okrType: 'keyResult', isKr: true }])
  assert.equal(f.relations[0].krList[0].id, childId)
  const writes = mutations(f).length
  await assert.rejects(run('okr unlink', { replayId: '51', relationId: childId }, f), { code: 'FORBIDDEN' })
  assert.equal(mutations(f).length, writes)
  f.relations.push({ id: '99', okrId: '999', okrType: 'objective', isKr: false, isDirectRelate: true, fieldList: [], krList: [] })
  await run('okr unlink', { replayId: '51', relationId: '93' }, f)
  assert.deepEqual(f.relations.map(row => row.id), ['99']); assert.equal(f.objective.krList.length, 1)
})
test('parent and relation versions are distinct and relation drift stops before mutation', async () => {
  const f = fixture(), context = await run('context', { replayId: '51' }, f), linked = await run('okr list', { replayId: '51' }, f)
  assert.equal(linked.result.contextVersion, context.result.contextVersion)
  assert.notEqual(linked.result.relationsVersion, linked.result.contextVersion)
  f.relations[0].fieldList.find(field => field.type === 'grade').grade = 2
  await assert.rejects(run('okr update', { replayId: '51', relationId: '91', expectedVersion: linked.result.contextVersion, expectedRelationsVersion: linked.result.relationsVersion, patch: { grade: 1 } }, f), { code: 'CONTEXT_CONFLICT' })
  assert.equal(mutations(f).length, 0)
})
test('source synchronization requires independent source values and matching progress record', async () => {
  const f = fixture(), updated = await run('okr update', { replayId: '51', relationId: '91', patch: { grade: 2, progressCurrent: 0.5 }, requireSourceSync: true }, f)
  assert.ok(updated.result.synchronization.progressRecordIds.length)
  assert.ok(updated.result.synchronization.observations.every(row => row.matches))
  await run('okr note set', { replayId: '51', relationId: '91', fieldId: '64', content: '源记录内容', requireSourceSync: true }, f)
  const cleared = await run('okr note set', { replayId: '51', relationId: '91', fieldId: '64', content: '', requireSourceSync: true }, f)
  assert.equal(cleared.result.synchronization.noteMatched, true); assert.deepEqual(f.records[0].fieldList, [])
  const stale = fixture({ noSourceSync: true })
  await assert.rejects(run('okr update', { replayId: '51', relationId: '91', patch: { grade: 2 }, requireSourceSync: true }, stale), { code: 'SOURCE_SYNC_NOT_VERIFIED' })
  assert.equal(mutations(stale).length, 1); assert.equal(stale.objective.grade, 0)
  const onlyState = fixture()
  await assert.rejects(run('okr update', { replayId: '51', relationId: '91', patch: { state: 'risk' }, requireSourceSync: true }, onlyState, { dryRun: true }), { code: 'INVALID_INPUT' })
  assert.equal(onlyState.calls.length, 0)
})
test('key action removal requires both actual associations and bound native delete permission', async () => {
  for (const options of [{ forbiddenTaskPermission: 'removeTask' }, { noSourceSync: true }]) {
    const f = fixture(options)
    try { await run('okr task create', { replayId: '51', relationId: '91', fieldId: '65', name: '仅本次行动' }, f) } catch (error) { assert.equal(error.code, 'BUSINESS_ASSERTION_FAILED') }
    const writes = mutations(f).length
    await assert.rejects(run('okr task remove', { replayId: '51', relationId: '91', fieldId: '65', taskId: 'okr-created-task' }, f), error => ['FORBIDDEN', 'INVALID_INPUT'].includes(error.code))
    assert.equal(mutations(f).length, writes)
  }
})
test('OKR fields enforce live grade limit, auto progress, computed confidence and actual permissions', async () => {
  for (const [options, patch, code] of [[{}, { grade: 6 }, 'INVALID_INPUT'], [{ auto: true }, { progressCurrent: 1 }, 'FORBIDDEN'], [{ indicator: true }, { progressCurrent: 1 }, 'FORBIDDEN'], [{}, { confident: 1 }, 'FORBIDDEN'], [{ noRelationEdit: true }, { grade: 1 }, 'FORBIDDEN']]) {
    const f = fixture(options); await assert.rejects(run('okr update', { replayId: '51', relationId: '91', patch }, f), { code }); assert.equal(mutations(f).length, 0)
  }
  const f = fixture(); await run('okr update', { replayId: '51', relationId: '91', patch: { grade: 0, progressCurrent: 0, state: 'risk' } }, f)
  assert.ok(f.calls.some(call => call.path === '/task/okr/objective' && call.method === 'GET')); assert.equal(f.objective.state, undefined)
})
test('OKR progress note clears actual field and key action is separate from next actions', async () => {
  const f = fixture(); await run('okr note set', { replayId: '51', relationId: '91', fieldId: '64', content: '' }, f); assert.equal(f.relations[0].fieldList.find(field => field.id === '64').progressNote, '')
  await run('okr task create', { replayId: '51', relationId: '91', fieldId: '65', name: '源目标关键行动' }, f); assert.equal(f.reports[0].nextActionList.length, 2)
  await run('okr task remove', { replayId: '51', relationId: '91', fieldId: '65', taskId: 'okr-created-task' }, f); assert.equal(f.objective.keyActionList.length, 0)
  const foreign = fixture(); await assert.rejects(run('okr note set', { replayId: '51', relationId: '91', fieldId: '65', content: 'wrong type' }, foreign), { code: 'INVALID_INPUT' }); assert.equal(mutations(foreign).length, 0)
})
test('records and shared view require original visible topic and actual sharing state', async () => {
  const f = fixture(); assert.equal((await run('records', { replayId: '51' }, f)).result.records.length, 1)
  await assert.rejects(run('sharing inspect', { replayId: '51' }, f), { code: 'FORBIDDEN' }); assert.equal((await run('sharing inspect', { replayId: '52' }, f)).result.shared.id, '52')
})
test('removing a topic verifies visible directory absence without repeating delete or deleting source OKR', async () => {
  const f = fixture(); const result = await run('remove', { replayId: '51' }, f); assert.equal(result.result.removed, true); assert.equal(f.reports.length, 1); assert.equal(f.objective.id, '101'); assert.equal(mutations(f).length, 1)
})
