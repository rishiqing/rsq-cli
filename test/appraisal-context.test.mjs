import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { appraisalRuleContent } from '../dist/appraisal-context.js'
import { appraisalTemplateBody, verifyAppraisalTemplateBody, appraisalParticipantNode } from '../dist/appraisal-template.js'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const flow = command => { const value = workflows.workflows.find(flow => flow.command === command); assert.ok(value, command); return value }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const definition = () => ({ calculation: 'sum', isDimensionsWeight: false, dimensions: [{ name: '业务质量', type: 'quantitative', indicators: [{ name: '独立断言', criteria: '交付', weight: '100', scoreLimit: '100', customFieldMap: { custom_fieldTemplate_91: '目标' } }] }] })
const node = () => ({ role: 'object', weight: '100', isVisibleOthers: false, isVisibleOthersExplanation: false, isTotal: false, isExplanation: false })
function fixture(options = {}) {
  const definitions = [{ id: 91, name: '业务字段', isAsFormulaField: true, types: ['quantitative'] }], templates = [], contents = [], nodes = [], confirms = [], resultConfirms = [], groups = [{ id: 'all', name: '全部模板', count: 0 }, { id: 'unassigned', name: '未分组模板', count: 0 }, { id: '201', name: '现有分组', count: 0 }]
  const placements = Object.fromEntries(['quantitative', 'qualitative', 'add', 'sub'].map((type, index) => [type, [{ id: 100 + index * 10, key: 'name', name: '指标名称', type: 'system', isConfigurable: false, isAsFormulaField: null }, { id: 101 + index * 10, key: 'criteria', name: '考核标准', type: 'system', isConfigurable: false, isAsFormulaField: null }, ...(type === 'quantitative' ? [{ id: 109, key: 'custom_fieldTemplate_91', name: '业务字段', type: 'custom', isConfigurable: true, isAsFormulaField: true }] : [])]]))
  const preferences = { fullScore: '100', isAutoReminder: true, isAutoScore: true, scoreType: 'beforeEnd', days: 3, levels: [{ name: 'A', min: 80, max: 100 }] }
  const authorities = { performancePreferencesManage: true, performanceAppraisalTempManage: true, performanceAppraisalContentManage: true, ...options.authorities }
  let sequence = 1000, calls = []
  const clone = value => structuredClone(value), response = value => json({ code: 200, msg: 'ok', data: value, ext: null })
  const content = (body, current = null) => ({ id: current?.id ?? ++sequence, name: body.name, calculation: body.calculation, fullScore: '100', isDimensionsWeight: body.isDimensionsWeight, dimensions: body.dimensions.map((dimension, index) => ({ ...clone(dimension), id: dimension.id ?? ++sequence, displayOrder: index + 1, indicators: dimension.indicators.map((indicator, index) => ({ ...clone(indicator), id: indicator.id ?? ++sequence, displayOrder: index + 1 })) })), tips: [], dimensionsAndTipsOrder: [], named: body.isCreateByAppraisal === false || current?.named === true })
  const transport = async (url, init) => {
    const method = init.method, path = url.pathname, query = Object.fromEntries(url.searchParams), body = init.body ? JSON.parse(init.body) : {}
    calls.push({ method, path, query, body })
    if (path === '/task/login/authAjax') return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: options.foreign ? 8 : 7, name: '公司' } })
    const route = path.replace('/task/performance', '')
    if (route === '/init') return response({ hasInit: options.initialized !== false })
    if (route === '/authority/role') return response({ id: 2, type: 'performanceAdmin', name: '管理员', authorities, menuAuthorities: { template: true, preference: true, authority: true }, salaryReportFunc: false })
    if (route === '/preference' && method === 'GET') return response(preferences)
    if (route === '/preference/fields/all') return response({ allFields: placements })
    if (route === '/preference/fields' && method === 'GET') return response(definitions)
    if (route === '/preference/field/relation') return response({ canDelete: !options.dependency, templates: options.dependency ? [{ id: 800, name: '依赖模板' }] : [], contents: [], indicators: [] })
    if (route === '/preference/rule/list') return response([{ id: 301, name: '百分制', fullScore: '100', levels: [], scoreMode: 'manual', isOpenCoefficient: false, optionList: [] }])
    if (route === '/template/group' && method === 'GET') { for (const row of groups) row.count = templates.filter(template => row.id === 'all' || template.group.id === row.id).length; return response(groups) }
    if (route === '/templates/my') return response(templates.map(template => ({ id: template.id, name: template.name, type: template.type, userVOList: template.objects, group: template.group, isPublic: false, visibleDept: [], availableDeps: [], appraisalSubmit: true, rule: template.rule })))
    if (route === '/template/contents') { const values = contents.filter(content => content.named && (!query.name || content.name.includes(query.name))); return response(values.slice(+query.offset || 0, (+query.offset || 0) + (+query.max || 20)).map(content => ({ id: content.id, name: content.name, calculation: content.calculation, isPublic: false, visibleDept: [], availableDeps: [] }))) }
    if (route === '/template/content' && method === 'GET') return response(contents.find(content => content.id === +query.id))
    if (route === '/template' && method === 'GET') { const value = clone(templates.find(template => template.id === +query.id)); return response({ ...value, ...(options.nullTemplateId && { id: null }), ...options.templateMismatch }) }
    if (route === '/template/nodes') return response(nodes.filter(node => node.templateId === +query.id).map(({ templateId, ...node }) => node))
    if (route === '/template/confirms' || route === '/template/resultConfirms') return response((route === '/template/confirms' ? confirms : resultConfirms).filter(node => node.templateId === +query.appraisalId).map(({ templateId, ...node }) => node))
    if (route === '/template/inviteColleagues/list') return response([])
    if (route === '/member/select') return response([{ id: 81, showName: '本人' }, { id: 82, showName: '同事' }])
    if (options.timeout) throw Error('connection lost after submission')
    if (route === '/preference' && method === 'PUT') { if (!options.ignore) Object.assign(preferences, body); return response(preferences) }
    if (route === '/preference/field/sort') {
      if (!options.ignore) { const values = Object.values(placements).find(values => values.some(row => row.id === body.id)), row = values.find(row => row.id === body.id); values.splice(values.indexOf(row), 1); values.splice(values.findIndex(row => row.id === body.frontId) + 1, 0, row) }; return response(null)
    }
    if (route === '/preference/fields') {
      if (!options.ignore) {
        const previous = definitions.find(row => row.id === +(query.id ?? body.id)), fieldId = previous?.id ?? ++sequence
        if (method === 'DELETE') definitions.splice(definitions.indexOf(previous), 1)
        else { const expected = { id: fieldId, name: body.name, types: body.types.split(',').filter(Boolean), isAsFormulaField: body.isAsFormulaField }; if (previous) Object.assign(previous, expected); else definitions.push(expected) }
        for (const [type, values] of Object.entries(placements)) { const key = 'custom_fieldTemplate_' + fieldId, old = values.find(row => row.key === key), current = definitions.find(row => row.id === fieldId); if (!current?.types.includes(type)) { if (old) values.splice(values.indexOf(old), 1) } else if (old) Object.assign(old, { name: current.name, isAsFormulaField: current.isAsFormulaField }); else values.push({ id: ++sequence, key, name: current.name, type: 'custom', isConfigurable: true, isAsFormulaField: current.isAsFormulaField }) }
      }; return response(null)
    }
    if (route === '/template/group') {
      if (!options.ignore) { if (method === 'DELETE') groups.splice(groups.findIndex(row => row.id === query.id), 1); else if (body.id) groups.find(row => +row.id === body.id).name = body.name; else groups.push({ id: String(++sequence), name: body.name, count: 0 }) }; return response(null)
    }
    if (route === '/template/content') {
      if (method === 'POST') { const value = content(body); if (!options.ignore) contents.push(value); return response(value) }
      const before = contents.find(row => row.id === +(query.id ?? body.id))
      if (method === 'DELETE') { if (!options.ignore) contents.splice(contents.indexOf(before), 1); return response(null) }
      const value = content(body, before); if (!options.ignore) Object.assign(before, value); return response(value)
    }
    if (['/template/node', '/template/confirm', '/template/resultConfirm'].includes(route)) {
      const field = route === '/template/node' ? 'raterIds' : 'confirmorIds', people = route === '/template/node' ? 'raters' : 'confirmors', { [field]: ids, ...properties } = body
      const value = { id: ++sequence, ...properties, [people]: String(ids ?? '').split(',').filter(Boolean).map(id => ({ id: +id })) }; (route === '/template/node' ? nodes : route === '/template/confirm' ? confirms : resultConfirms).push(value); return response(value)
    }
    if (route === '/template/group/move') { if (!options.ignore) templates.find(row => row.id === +body.ids).group = clone(groups.find(row => row.id === body.groupId)); return response(null) }
    if (route === '/template/copy') {
      const previous = templates.find(row => row.id === body.id), oldContent = contents.find(row => row.id === previous.contentId)
      const copied = content({ ...oldContent, dimensions: oldContent.dimensions.map(dimension => ({ ...dimension, id: undefined, indicators: dimension.indicators.map(indicator => ({ ...indicator, id: undefined })) })) })
      const value = { ...clone(previous), id: ++sequence, name: previous.name + '副本', contentId: copied.id }
      if (!options.ignore) { contents.push(copied); templates.push(value); for (const oldNode of nodes.filter(node => node.templateId === previous.id)) nodes.push({ ...clone(oldNode), id: ++sequence, templateId: value.id }) }; return response({ id: value.id })
    }
    if (route === '/template' && ['POST', 'PUT'].includes(method)) {
      const value = { id: body.id ? +body.id : ++sequence, name: body.name, type: body.type, contentId: body.contentId, hasTemplateMange: true, objects: body.objectIds.split(',').map(id => ({ id: +id })), departmentList: [], staffGroupList: [], group: clone(groups.find(row => row.id === body.groupId)), rule: { id: body.ruleId },
        ...Object.fromEntries(['isConfirm', 'isResultConfirm', 'isInviteColleagues', 'startScoreFlag', 'isResultEntryOnlyManual', 'isContentAcknowledgement', 'isResultAcknowledgement', 'isContentSignature', 'isResultSignature', 'isInterview'].map(key => [key, body[key]])),
        score: { isDeduplication: body.isDeduplication, isAnonymous: body.isAnonymous, raterEmpty: body.raterEmpty, isCustomScore: false, usersRaterEmpty: [] }, objectVisible: Object.fromEntries(['isScore', 'isScoreExplanation', 'isCanSeeScoreReview', 'isCanSeeAppraisalScore', 'isCanSeeAppraisalLevel', 'isCanSeeAppraisalCoefficient'].map(key => [key, body[key] ?? false])) }
      if (!options.ignore) { if (method === 'PUT') Object.assign(templates.find(row => row.id === value.id), value); else templates.push(value); for (const [field, values] of [['nodeIds', nodes], ['confirmIds', confirms], ['resultConfirmIds', resultConfirms]]) for (const nodeId of String(body[field] ?? '').split(',').filter(Boolean)) values.find(node => node.id === +nodeId).templateId = value.id }; return response(value)
    }
    if (route === '/template' && method === 'DELETE') { if (!options.ignore) templates.splice(templates.findIndex(row => row.id === +query.id), 1); return response(null) }
    throw Error('unexpected route ' + method + ' ' + path)
  }
  return { transport, calls, definitions, placements, preferences, templates, contents, nodes, groups }
}
const run = (command, input, fixture, options = {}) => runWorkflow(ctx, flow(command), input, session, { transport: fixture.transport, approved: true, ...options })
const writes = f => f.calls.filter(call => call.method !== 'GET')
const createTemplate = f => run('appraisal templates create', { name: '独立新模板', type: 'monthly', ruleId: '301', objectIds: ['81'], content: definition(), nodes: [node()] }, f)

test('participant nodes use actual company members and semantic hierarchy levels; all validation precedes draft writes', async () => {
  const f = fixture(), created = await run('appraisal templates create', { name: '有确认节点的模板', type: 'custom', ruleId: '301', objectIds: ['81'], content: definition(),
    nodes: [{ ...node(), role: 'specified', raterIds: ['82'], weight: '60' }, { ...node(), role: 'higher', level: 2, weight: '40' }], contentConfirms: [{ role: 'object', isCanChangeContent: true }], resultConfirms: [{ role: 'calibrationUser', confirmorIds: ['81'], isResultCalibration: true }], options: { isContentAcknowledgement: true, isResultAcknowledgement: true } }, f)
  assert.equal(created.result.nodes[0].raters[0].id, 82); assert.equal(created.result.nodes[1].raterValue, 'higher2')
  assert.equal(created.result.confirms[0].isCanChangeContent, true); assert.equal(created.result.resultConfirms[0].confirmors[0].id, 81)
  const payload = writes(f).find(call => call.path === '/task/performance/template').body
  assert.equal(payload.isConfirm, true); assert.equal(payload.isResultConfirm, true); assert.equal(payload.isContentAcknowledgement, true)
  assert.ok(f.calls.some(call => call.query.type === 'my')); assert.ok(f.calls.some(call => call.path === '/task/performance/member/select' && call.query.type !== 'my'))
  for (const member of ['999', '82,81']) {
    const blocked = fixture(); await assert.rejects(run('appraisal templates create', { name: '拒绝非法参与人', type: 'custom', ruleId: '301', objectIds: ['81'], content: definition(), nodes: [{ ...node(), role: 'specified', raterIds: [member] }] }, blocked)); assert.equal(writes(blocked).length, 0)
  }
  assert.throws(() => appraisalParticipantNode({ role: 'departmentManager', level: 7 }, [{ id: 81 }], 'content'))
  assert.throws(() => appraisalParticipantNode({ role: 'object', confirmorIds: ['81'] }, [{ id: 81 }], 'content'))
})

test('template sparse configuration preserves node/content IDs, complete visibility and acknowledgement settings', async () => {
  const f = fixture(), created = await createTemplate(f), templateId = created.resources.templateId, oldNodes = structuredClone(created.result.nodes)
  const out = await run('appraisal templates configure', { templateId, patch: { name: '新的模板名称', objectIds: ['82'], options: { isContentAcknowledgement: true, isScoreExplanation: false } } }, f)
  assert.equal(out.result.template.name, '新的模板名称'); assert.equal(out.result.template.objects[0].id, 82)
  assert.deepEqual(out.result.nodes, oldNodes); assert.equal(out.result.content.id, created.result.content.id)
  assert.equal(out.result.template.objectVisible.isScore, true); assert.equal(out.result.template.objectVisible.isScoreExplanation, false)
  assert.equal(out.result.template.isContentAcknowledgement, true); assert.equal(out.result.assessmentLaunched, false)
  const count = writes(f).length
  await assert.rejects(run('appraisal templates configure', { templateId, patch: { objectIds: ['999'] } }, f), { code: 'INVALID_INPUT' }); assert.equal(writes(f).length, count)
})

test('full template payload retains inactive invite limits, custom range, department/group scope, fallback users and interview references', () => {
  const graph = { template: { id: 101, name: '原模板', type: 'monthly', contentId: 501, group: { id: 'unassigned' }, rule: { id: 301 }, objects: [{ id: 81 }], departmentList: [{ id: 9001 }], staffGroupList: [{ id: 9002 }],
    objectVisible: { isScore: true, isScoreExplanation: false, isCanSeeScoreReview: true }, score: { isDeduplication: true, isAnonymous: false, isCustomScore: true, raterEmpty: 'specified', usersRaterEmpty: [{ id: 82 }] },
    isConfirm: true, isResultConfirm: true, isInviteColleagues: true, customScoreRangeType: 'people', inviteColleaguesCountType: 'every', inviteColleaguesCountList: [{ type: 'peer', min: 1, max: 3 }],
    isInterview: true, interview: { id: 6001, appraisalTemplateId: 101, role: 'specified', isCondition: true, conditionType: 2, levelList: [{ id: 401 }], isTemplate: true, reviewTemplateId: 7001, specifyUserIdList: [{ id: 82 }], departmentList: [{ id: 9001 }], viewPermission: 1 } }, nodes: [{ id: 201 }], confirms: [{ id: 202 }], resultConfirms: [{ id: 203 }], content: {} }
  const before = structuredClone(graph), payload = appraisalTemplateBody(graph, [{ id: 204 }])
  assert.deepEqual(graph, before); assert.equal(payload.deptId, '9001'); assert.equal(payload.staffGroupId, '9002'); assert.equal(payload.userIdsRaterEmpty, '82')
  assert.equal(payload.inviteColleagueIds, '204'); assert.equal(payload.customScoreRangeType, 'people'); assert.deepEqual(payload.inviteColleaguesCountList, [{ type: 'peer', min: 1, max: 3 }])
  assert.equal(payload.interviewParams.levelIds, '401'); assert.equal(payload.interviewParams.specifyUserIds, '82'); assert.equal(payload.interviewParams.specifyDeptIds, '9001'); assert.equal(payload.interviewParams.reviewTemplateId, 7001)
  verifyAppraisalTemplateBody(graph, [{ id: 204 }], payload)
  assert.throws(() => verifyAppraisalTemplateBody({ ...graph, template: { ...graph.template, staffGroupList: [] } }, [{ id: 204 }], payload), { code: 'BUSINESS_ASSERTION_FAILED' })
})

test('performance context verifies current identity, initialization and role without granting company rights', async () => {
  const f = fixture(), out = await run('appraisal context inspect', {}, f); assert.equal(out.result.initialized, true); assert.equal(out.result.role.authorities.performancePreferencesManage, true); assert.equal(writes(f).length, 0)
  await assert.rejects(run('appraisal templates list', {}, fixture({ foreign: true })), { code: 'BUSINESS_ASSERTION_FAILED' })
  await assert.rejects(run('appraisal templates list', {}, fixture({ initialized: false })), { code: 'APPLICATION_NOT_INITIALIZED' })
})
test('preference patches preserve false, zero and every unrelated setting; UI role denial precedes sensitive GET and PUT', async () => {
  const f = fixture(), old = structuredClone(f.preferences), out = await run('appraisal preferences set', { patch: { isAutoReminder: false, days: 0 } }, f)
  assert.deepEqual(writes(f)[0].body, { isAutoReminder: false, days: 0 }); assert.deepEqual(out.result.preferences, { ...old, isAutoReminder: false, days: 0 })
  const denied = fixture({ authorities: { performancePreferencesManage: false } }); await assert.rejects(run('appraisal preferences set', { patch: { days: 1 } }, denied), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!denied.calls.some(call => call.path === '/task/performance/preference'))
})
test('custom definition IDs, placement IDs and value keys are distinct; explicit dimension removal and dependency checks are preserved', async () => {
  const f = fixture(), created = await run('appraisal custom-fields create', { name: '新增字段', dimensionTypes: ['quantitative', 'sub'], isAsFormulaField: false }, f), fieldId = created.resources.fieldId
  const placements = Object.values(created.result.placements).flat().filter(row => row.key === 'custom_fieldTemplate_' + fieldId); assert.equal(placements.length, 2); assert.ok(placements.every(row => String(row.id) !== fieldId))
  const changed = await run('appraisal custom-fields configure', { fieldId, patch: { name: '修改名称', dimensionTypes: [], isAsFormulaField: true } }, f)
  assert.deepEqual(changed.result.definitions.find(row => String(row.id) === fieldId).types, []); assert.equal(writes(f)[1].body.types, '')
  const removed = await run('appraisal custom-fields remove', { fieldId }, f); assert.ok(!removed.result.definitions.some(row => String(row.id) === fieldId)); assert.equal(f.definitions[0].id, 91)
  for (const [command, input] of [['appraisal custom-fields remove', { fieldId: '91' }], ['appraisal custom-fields configure', { fieldId: '91', patch: { isAsFormulaField: false } }]]) { const blocked = fixture({ dependency: true }); await assert.rejects(run(command, input, blocked), { code: 'DEPENDENCY_CONFLICT' }); assert.equal(writes(blocked).length, 0) }
  const foreign = fixture(); await assert.rejects(run('appraisal custom-fields remove', { fieldId: '999' }, foreign), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(foreign).length, 0)
})
test('field ordering uses actual same-dimension neighbors, keeps name fixed and does not mutate other dimensions', async () => {
  const f = fixture(), before = structuredClone(f.placements.qualitative), out = await run('appraisal custom-fields order', { dimensionType: 'quantitative', placementIds: ['100', '109', '101'] }, f)
  assert.deepEqual(writes(f)[0].body, { id: 109, frontId: 100, nextId: 101 }); assert.deepEqual(out.result.placements.map(row => row.id), [100, 109, 101]); assert.deepEqual(f.placements.qualitative, before)
  for (const ids of [['109', '100', '101'], ['100', '91', '101'], ['100', '109']]) { const blocked = fixture(); await assert.rejects(run('appraisal custom-fields order', { dimensionType: 'quantitative', placementIds: ids }, blocked)); assert.equal(writes(blocked).length, 0) }
})
test('template groups have independent create/rename/remove readback and protect pseudo groups or groups still containing templates', async () => {
  const f = fixture(), created = await run('appraisal templates groups create', { name: '独立分组' }, f), groupId = created.resources.groupId
  const changed = await run('appraisal templates groups rename', { groupId, name: '改名' }, f); assert.equal(changed.result.groups.find(row => row.id === groupId).name, '改名')
  await run('appraisal templates groups remove', { groupId }, f); assert.ok(!f.groups.some(row => row.id === groupId))
  await assert.rejects(run('appraisal templates groups remove', { groupId: '999' }, fixture()), { code: 'RESOURCE_FORBIDDEN' })
})
test('content lifecycle constructs real dimension keys, preserves IDs on replacement and checks independent field value readback', async () => {
  const f = fixture(), created = await run('appraisal content-templates create', { name: '独立内容', definition: definition() }, f), contentId = created.resources.contentId, actual = created.result.content
  assert.equal(actual.dimensions[0].indicators[0].customFieldMap.custom_fieldTemplate_91, '目标'); assert.equal(actual.named, true)
  assert.equal(writes(f)[0].body.dimensions[0].indicators[0].custom_fieldTemplate_91, '目标'); assert.ok(!Object.hasOwn(writes(f)[0].body.dimensions[0].indicators[0], 'customFieldMap'))
  const replacement = definition(); replacement.dimensions[0].id = String(actual.dimensions[0].id); replacement.dimensions[0].indicators[0].id = String(actual.dimensions[0].indicators[0].id); replacement.dimensions[0].indicators[0].customFieldMap.custom_fieldTemplate_91 = ''
  const updated = await run('appraisal content-templates replace', { contentId, name: '重命名内容', definition: replacement }, f); assert.equal(updated.result.content.dimensions[0].id, actual.dimensions[0].id); assert.equal(updated.result.content.dimensions[0].indicators[0].customFieldMap.custom_fieldTemplate_91, '')
  await run('appraisal content-templates remove', { contentId }, f); assert.equal(f.contents.length, 0)
})
test('templates create independent content and weighted score nodes in actual member scope, copy graph, move and remove without launching assessments', async () => {
  const f = fixture(), created = await createTemplate(f), templateId = created.resources.templateId
  assert.equal(created.result.assessmentLaunched, false); assert.equal(writes(f).find(call => call.path === '/task/performance/template').body.isNeedStart, false)
  assert.equal(created.result.nodes.length, 1); assert.equal(created.result.nodes[0].role, 'object')
  const copied = await run('appraisal templates copy', { templateId }, f); assert.notEqual(copied.resources.templateId, templateId); assert.notEqual(copied.result.content.id, created.result.content.id); assert.notEqual(copied.result.nodes[0].id, created.result.nodes[0].id)
  const moved = await run('appraisal templates move', { templateId, groupId: '201' }, f); assert.equal(moved.result.template.group.id, '201')
  await assert.rejects(run('appraisal templates groups remove', { groupId: '201' }, f), { code: 'INVALID_INPUT' })
  await run('appraisal templates remove', { templateId }, f); await run('appraisal templates remove', { templateId: copied.resources.templateId }, f); assert.equal(f.templates.length, 0)
})
test('missing server template IDs require matching company-list identity and explicit HTTP query; conflicting detail fails closed', async () => {
  const f = fixture({ nullTemplateId: true }), created = await createTemplate(f), templateId = created.resources.templateId
  assert.equal(String(created.result.template.id), templateId)
  const copied = await run('appraisal templates copy', { templateId }, f)
  await run('appraisal templates move', { templateId, groupId: '201' }, f)
  await run('appraisal templates remove', { templateId }, f)
  await run('appraisal templates remove', { templateId: copied.resources.templateId }, f)
  for (const templateMismatch of [{ id: 99999 }, { name: '另一模板' }, { type: 'annual' }, { rule: { id: 999 } }]) {
    const blocked = fixture({ nullTemplateId: true, templateMismatch })
    await assert.rejects(createTemplate(blocked), { code: 'BUSINESS_ASSERTION_FAILED' })
    assert.ok(!writes(blocked).some(call => call.method === 'DELETE'))
  }
})
test('template rule computes indicator limits with exact decimal half-up and respects dimension and add/sub boundaries', () => {
  const input = { calculation: 'sum', isDimensionsWeight: false, dimensions: [{ type: 'quantitative', indicators: [{ weight: '1' }, { weight: '2' }] }, { type: 'sub', indicators: [{ scoreLimit: '7.5' }] }] }
  const out = appraisalRuleContent(input, '100')
  assert.deepEqual(out.dimensions[0].indicators.map(row => row.scoreLimit), ['33.33', '66.67'])
  assert.equal(out.dimensions[1].indicators[0].scoreLimit, '7.5')
  const half = appraisalRuleContent({ ...input, dimensions: [{ type: 'qualitative', indicators: [{ weight: '1' }, { weight: '19999' }] }] }, '100')
  assert.equal(half.dimensions[0].indicators[0].scoreLimit, '0.01')
  const unlimited = appraisalRuleContent(input, '-'); assert.ok(unlimited.dimensions.every(row => row.indicators.every(indicator => indicator.scoreLimit === '-')))
  const weighted = appraisalRuleContent({ ...input, calculation: 'weight' }, '80'); assert.equal(weighted.dimensions[0].indicators[0].scoreLimit, '80')
  assert.equal(weighted.dimensions[1].indicators[0].scoreLimit, '7.5'); assert.equal(input.dimensions[0].indicators[0].scoreLimit, undefined)
})
test('foreign IDs, wrong scope, unknown fields and unsupported protocol combinations fail before creating draft resources', async () => {
  const cases = [value => { value.ruleId = '999' }, value => { value.objectIds = ['999'] }, value => { value.content.dimensions[0].indicators[0].customFieldMap = { custom_fieldTemplate_999: '越界' } }, value => { value.content.dimensions[0].id = '999' }, value => { value.nodes[0].weight = '20' }]
  for (const change of cases) { const f = fixture(), input = { name: '目标', type: 'monthly', ruleId: '301', objectIds: ['81'], content: definition(), nodes: [node()] }; change(input); await assert.rejects(run('appraisal templates create', input, f)); assert.equal(writes(f).length, 0) }
  const denied = fixture({ authorities: { performanceAppraisalTempManage: false } }); await assert.rejects(createTemplate(denied), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(denied).length, 0)
})
test('dry-run performs zero requests, schema forbids guessed protocol fields, confirmation and workflow contract integrity precede HTTP', async () => {
  const f = fixture(); const preview = await run('appraisal templates create', { name: '目标', type: 'monthly', ruleId: '301', objectIds: ['81'], content: definition(), nodes: [node()] }, f, { dryRun: true }); assert.equal(preview.steps[0].context, 'resolve-from-verified-http-context'); assert.equal(f.calls.length, 0)
  await assert.rejects(run('appraisal custom-fields remove', { fieldId: '91' }, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const changed = structuredClone(flow('appraisal custom-fields remove')); changed.steps[4].operationId = catalog.operations.find(op => op.route === '/task/performance/template' && op.method === 'DELETE').id
  await assert.rejects(runWorkflow(ctx, changed, { fieldId: '91' }, session, { transport: f.transport, approved: true }), { code: 'INVALID_CONTRACT' }); assert.equal(f.calls.length, 0)
  const operation = catalog.operations.find(op => op.route === '/task/performance/preference/fields' && op.method === 'POST'); await assert.rejects(executeOperation(ctx, operation, { body: { name: '越权', types: 'quantitative' } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
test('ignored writes fail independent assertions; timeout checkpoints preserve created IDs and never replay writes', async () => {
  const ignored = fixture({ ignore: true }); await assert.rejects(run('appraisal preferences set', { patch: { days: 0 } }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(ignored).length, 1)
  const timeout = fixture({ timeout: true }); await assert.rejects(createTemplate(timeout), error => { assert.equal(error.details.failedStep, 'createdContent'); assert.equal(error.details.writeOutcome, 'unknown-do-not-retry'); return true }); assert.equal(writes(timeout).length, 1)
})
