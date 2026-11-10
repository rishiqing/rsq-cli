import test from 'node:test'
import assert from 'node:assert/strict'
import { context } from '../dist/core.js'
import { executeWorkflow } from '../dist/dispatch.js'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { buildIndicatorBreakdown, indicatorNumber, indicatorTime, validateOkrIndicatorWorkflow } from '../dist/okr-indicators.js'
const ctx = context('production', 'fixture'), session = { version: 1, method: 'password', token: 'fixture', cookies: [], identity: { userId: '81', teamId: '7' } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), empty = () => new Response(''), clone = value => structuredClone(value)
const flow = suffix => { const result = workflows.workflows.find(item => item.command === 'okr indicator ' + suffix); assert.ok(result, suffix); return result }
const run = (suffix, input, f, extra = {}) => executeWorkflow(ctx, flow(suffix), input, session, { transport: f.transport, ...extra })
const all = { edit: true, view: true, definition: true, startStop: true, delete: true, openClose: true, responsibleUser: true, split: true }
function fixture(options = {}) {
  const calls = [], dimensions = [{ id: 31, name: '渠道', icon: '', itemList: [{ id: 32, name: '直营' }, { id: 33, name: '代理' }] }, { id: 39, name: '无关维度', icon: '', itemList: [{ id: 390, name: '保留' }] }]
  const organization = { type: 'company', id: null, name: '当前公司', childList: [{ type: 'dept', id: 8, name: '部门', childList: [{ type: 'person', id: 81, name: '本人', childList: [] }] }] }
  const source = { id: 41, name: '经营指标', attribution: organization, aggregateMode: 'sum', growDirection: 'bigger', updateManualMode: options.increment ? 'increment' : 'cover', updateAutoMode: 'sum', unit: '', describe: '', rootId: '51', stopped: false, tree: [{ attributionType: 'company', splitMode: 'none', childs: [] }], dimensionIds: [], target: 10, done: 2, records: options.increment ? [{ id: '71', '61': '2', '62': '旧备注' }, { id: '72', '61': '3', '62': '保留' }] : [], fields: [{ id: 60, name: '数据时间', isCustom: false }, { id: 61, name: '完成值', isCustom: false }, { id: 62, name: '备注', isCustom: true }] }
  const metrics = [source], control = () => ({ ...all, ...(options.controls ?? {}) }), valueControl = () => ({ editDoneValue: true, editTargetValue: true, clearDoneValue: true, clearTargetValue: true, ...(options.valueControls ?? {}) })
  const definition = m => Object.fromEntries(['id', 'name', 'attribution', 'aggregateMode', 'growDirection', 'updateManualMode', 'updateAutoMode', 'unit', 'describe'].map(key => [key, m[key]]))
  const root = m => ({ ...definition(m), id: m.rootId, definitionId: m.id, isRoot: true, isPerspective: false, isStop: m.stopped, editControl: control() })
  const library = () => [...metrics.map(m => ({ id: m.id, indicatorId: Number(m.rootId), name: m.name, isStop: m.stopped, editControl: control() })), { id: 99, indicatorId: 199, name: '不可见', editControl: { view: false } }]
  const sum = m => m.updateManualMode === 'increment' ? m.records.length ? m.records.reduce((n, r) => n + Number(r['61']), 0) : null : m.done
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams), body = init.body ? JSON.parse(init.body) : undefined, method = init.method; calls.push({ path, query, body, method })
    if (path.endsWith('/authAjax')) return json({ success: true, id: options.changedIdentity ? 82 : 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: options.overCapacity ? 11 : 1, userLimit: 10, vt: '7', mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return json([{ funcName: 'OKR', status: 'enable' }, { funcName: 'OKR_INDICATOR', status: options.disabled ? 'disable' : 'enable' }])
    if (path.endsWith('/company/current')) return json({ useObjective: true })
    if (path === '/task/okr/objective/sidebar') return json({ editControl: { viewIndicator: !options.noView, createIndicator: !options.noCreate, manageIndicatorDimension: !options.noManage } })
    if (path.endsWith('/library/list')) { if (options.drift && calls.filter(c => c.path.endsWith('/library/list')).length === 3) source.name = '并发修改'; return json(library()) }
    if (path.endsWith('/dimension/list')) return json(dimensions)
    if (path.endsWith('/auth/optional/attribution/list')) return json([organization])
    if (path.endsWith('/dimension') && method === 'POST') { const added = { ...body, id: 35, itemList: body.itemList.map((item, i) => ({ ...item, id: 350 + i })) }; dimensions.push(added); if (options.lostReply) throw Error('lost response'); return json(added) }
    if (path.endsWith('/dimension') && method === 'PUT') { const item = dimensions.find(d => String(d.id) === body.id); Object.assign(item, body, { itemList: body.itemList.map((v, i) => ({ ...v, id: v.id ?? 360 + i })) }); return json(item) }
    if (path.endsWith('/dimension') && method === 'DELETE') { dimensions.splice(dimensions.findIndex(d => String(d.id) === query.id), 1); return empty() }
    if (path === '/task/okr/indicator' && method === 'POST') { const added = { ...clone(source), ...body, id: 43, rootId: '53', attribution: organization, tree: body.tableData, dimensionIds: body.dimensionIds?.split(',') ?? [] }; metrics.push(added); return json(root(added)) }
    const m = metrics.find(m => String(m.id) === String(query.indicatorDefinitionId ?? query.id ?? (body?.id && ['PUT', 'DELETE'].includes(method) && path.includes('/definition') ? body.id : '41'))) ?? source
    if (path.endsWith('/root/byDefinitionId')) return json(root(m))
    if (path.endsWith('/definition') && method === 'GET') return json(definition(m))
    if (path.endsWith('/split/info')) return json({ dimensions: dimensions.filter(d => m.dimensionIds.includes(String(d.id))), tableData: m.tree })
    if (path.endsWith('/definition') && method === 'PUT') { Object.assign(m, Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'id'))); if (body.tableData) { m.tree = body.tableData; m.dimensionIds = body.dimensionIds ? body.dimensionIds.split(',') : [] } return empty() }
    if (path.endsWith('/definition/stop')) { m.stopped = body.isStop; return empty() }
    if (path.endsWith('/definition') && method === 'DELETE') { metrics.splice(metrics.findIndex(m => String(m.id) === query.id), 1); return empty() }
    if (path.endsWith('/field/list')) return json(m.fields)
    if (path.endsWith('/field') && method === 'POST') { const added = { id: 63, name: body.name, isCustom: true }; m.fields.push(added); return json(added) }
    if (path.endsWith('/field') && method === 'PUT') { if (!options.wrongReadback) m.fields.find(f => String(f.id) === body.id).name = body.name; return empty() }
    if (path.endsWith('/field') && method === 'DELETE') { m.fields.splice(m.fields.findIndex(f => String(f.id) === query.id), 1); return empty() }
    if (path.endsWith('/field/sort')) { const moving = m.fields.splice(m.fields.findIndex(f => String(f.id) === body.moveId), 1)[0], index = body.nextId ? m.fields.findIndex(f => String(f.id) === body.nextId) : m.fields.length; m.fields.splice(index, 0, moving); return empty() }
    if (path.endsWith('/value') && method === 'GET') return json({ timeList: [query.selectTime], currentTime: query.selectTime, valueList: [{ time: query.selectTime, targetValue: source.target, doneValue: sum(source), editControl: valueControl() }] })
    if (path.endsWith('/value') && method === 'PUT') { for (const [field, key] of [['targetValue', 'target'], ['doneValue', 'done']]) if (Object.hasOwn(body, field)) source[key] = body[field] === '' ? null : Number(body[field]); return empty() }
    if (path.endsWith('/update/info')) return json({ definitionId: source.id, positionTime: query.time, positionTimeType: 'day', updateManualMode: source.updateManualMode, editControl: { editDoneValue: !options.noRecordEdit } })
    if (path.endsWith('/update/table/data')) return json([{ time: query.selectTime, targetValue: source.target, doneValue: sum(source), recordList: source.records }])
    if (path.endsWith('/record') && method === 'POST') { const added = { id: '73', ...Object.fromEntries(Object.entries(body).filter(([k]) => /^\d+$/.test(k))) }; source.records.push(added); return json(added) }
    if (path.endsWith('/record') && method === 'PUT') { Object.assign(source.records.find(r => r.id === body.id), body); return empty() }
    if (path.endsWith('/record') && method === 'DELETE') { source.records.splice(source.records.findIndex(r => r.id === query.id), 1); return empty() }
    throw Error('Unexpected indicator fixture ' + method + ' ' + path)
  }
  return { calls, transport, dimensions, metrics, source }
}
test('indicator discovery masks hidden source rows and declares definition/root/option IDs independently', async () => {
  const f = fixture(), result = (await run('context', {}, f)).result
  assert.equal(result.library[0].id, 41); assert.equal(result.library[0].indicatorId, 51); assert.deepEqual(result.library[1], { hidden: true, reason: 'view-permission-denied' })
  assert.equal(JSON.stringify(result).includes('不可见'), false); assert.ok(result.idSemantics.optionId); assert.equal(f.calls.some(c => c.method !== 'GET'), false)
  assert.equal((await run('library list', { name: '没有' }, f)).result.items.length, 0)
  await assert.rejects(run('definition inspect', { definitionId: '99' }, f), { code: 'FORBIDDEN' }); assert.equal(f.calls.some(c => c.path.endsWith('/definition') && c.query.id === '99'), false)
})
test('current features, expiry, capacity and menu stop indicator business calls', async () => {
  for (const [options, code] of [[{ disabled: true }, 'FEATURE_DISABLED'], [{ expired: true }, 'COMPANY_EXPIRED'], [{ overCapacity: true }, 'COMPANY_OVER_CAPACITY'], [{ noView: true }, 'FORBIDDEN']]) {
    const f = fixture(options); await assert.rejects(run('context', {}, f), { code }); assert.equal(f.calls.some(c => c.path.includes('/indicator/')), false)
  }
})
test('dimensions create, full option maintenance and deletion preserve unrelated dimensions and stable option IDs', async () => {
  const f = fixture(), created = (await run('dimensions create', { name: '新维度', options: [{ name: 'A' }, { name: 'B' }] }, f)).result
  assert.equal(created.dimension.id, 35); assert.equal(created.verified, true)
  const updated = (await run('dimensions update', { dimensionId: '35', name: '新名称', options: [{ id: '350', name: '改名' }, { name: '新选项' }] }, f, { approved: true })).result
  assert.equal(String(updated.dimension.itemList[0].id), '350'); assert.equal(updated.dimension.itemList[0].name, '改名')
  const removed = (await run('dimensions remove', { dimensionId: '35' }, f, { approved: true })).result; assert.equal(removed.removed, true); assert.equal(f.dimensions.length, 2)
  await assert.rejects(run('dimensions update', { dimensionId: '31', name: '渠道', options: [{ id: '390', name: '外部选项' }] }, f, { approved: true }), { code: 'FORBIDDEN' })
  await assert.rejects(run('dimensions create', { name: '重复选项', options: [{ name: 'A' }, { name: ' A ' }] }, f), { code: 'INVALID_INPUT' })
})
test('definition creation builds a legal dimension tree and verifies actual definition, root and selected options', async () => {
  const f = fixture(), result = await run('definition create', { name: '新指标', attributionType: 'company', dimensionIds: ['31'], breakdown: { by: 'dimension', dimensionId: '31', children: [{ type: 'dimension', id: '32' }] } }, f)
  assert.equal(result.resources.definitionId, '43'); assert.equal(result.resources.indicatorId, '53'); assert.equal(result.result.verified, true)
  const body = f.calls.find(c => c.method === 'POST' && c.path === '/task/okr/indicator').body
  assert.deepEqual(body.tableData, [{ attributionType: 'company', splitMode: 'dimension', splitDimensionId: '31', childs: [{ id: '32', splitMode: 'none', childs: [] }] }]); assert.equal(body.attributionId, undefined)
  assert.ok(f.calls.some(c => c.path.endsWith('/definition') && c.query.id === '43'))
})
test('definition edit, split, state and remove independently verify their distinct business outcomes', async () => {
  const f = fixture(), edited = (await run('definition edit', { definitionId: '41', patch: { name: '已修改', unit: '元' } }, f, { approved: true })).result; assert.equal(edited.definition.unit, '元')
  const split = (await run('definition split', { definitionId: '41', dimensionIds: ['31'], breakdown: { by: 'dimension', dimensionId: '31', children: [{ type: 'dimension', id: '33' }] } }, f, { approved: true })).result; assert.equal(split.split.dimensions[0].id, 31)
  assert.equal((await run('definition state set', { definitionId: '41', stopped: true }, f, { approved: true })).result.root.isStop, true)
  assert.equal((await run('definition remove', { definitionId: '41' }, f, { approved: true })).result.removed, true)
})
test('definition authority, exact context versions and concurrent metadata changes stop before mutation', async () => {
  for (const options of [{ controls: { definition: false } }, { noCreate: true }]) {
    const f = fixture(options); await assert.rejects(run(options.noCreate ? 'definition create' : 'definition edit', options.noCreate ? { name: '不能创建', attributionType: 'company' } : { definitionId: '41', patch: { name: '不能修改' } }, f, { approved: true }), { code: 'FORBIDDEN' }); assert.equal(f.calls.some(c => c.method !== 'GET'), false)
  }
  const old = fixture(); await assert.rejects(run('definition edit', { definitionId: '41', patch: { name: '新名称' }, contextVersion: '0'.repeat(64) }, old, { approved: true }), { code: 'CONTEXT_CONFLICT' })
  const changing = fixture({ drift: true }); await assert.rejects(run('definition edit', { definitionId: '41', patch: { name: '新名称' } }, changing, { approved: true }), { code: 'CONTEXT_CONFLICT' }); assert.equal(changing.calls.some(c => c.method !== 'GET'), false)
})
test('field management respects actual definition membership, system fields and complete ordering', async () => {
  const f = fixture(); assert.equal((await run('fields list', { definitionId: '41' }, f)).result.initializationSideEffect, true)
  assert.equal((await run('fields create', { definitionId: '41', name: '来源' }, f)).result.field.id, 63)
  assert.equal((await run('fields rename', { definitionId: '41', fieldId: '63', name: '数据来源' }, f, { approved: true })).result.field.name, '数据来源')
  const moved = (await run('fields move', { definitionId: '41', fieldId: '63', beforeFieldId: '62' }, f, { approved: true })).result; assert.deepEqual(moved.fields.map(f => f.id), [60, 61, 63, 62])
  await run('fields remove', { definitionId: '41', fieldId: '63' }, f, { approved: true }); assert.deepEqual(f.source.fields.map(f => f.id), [60, 61, 62])
  for (const fieldId of ['61', '999']) await assert.rejects(run('fields remove', { definitionId: '41', fieldId }, f, { approved: true }), { code: 'FORBIDDEN' })
  const wrong = fixture({ wrongReadback: true }); await assert.rejects(run('fields rename', { definitionId: '41', fieldId: '62', name: '应修改' }, wrong, { approved: true }), { code: 'VERIFICATION_FAILED' })
})
test('a single explicit value or clear follows the empty-string wire protocol and preserves the other value', async () => {
  const f = fixture(), input = { definitionId: '41', timeType: 'day', time: '2026-11-09' }
  assert.equal((await run('values set', { ...input, targetValue: '9000000000.125' }, f, { approved: true })).result.selected.targetValue, 9000000000.125)
  const cleared = (await run('values set', { ...input, doneValue: null }, f, { approved: true })).result; assert.equal(cleared.selected.doneValue, null); assert.equal(cleared.selected.targetValue, 9000000000.125)
  const body = f.calls.filter(c => c.path.endsWith('/value') && c.method === 'PUT').at(-1).body; assert.equal(body.doneValue, ''); assert.equal(Object.hasOwn(body, 'targetValue'), false)
  for (const values of [{}, { targetValue: '1', doneValue: '2' }, { doneValue: 'NaN' }]) await assert.rejects(run('values set', { ...input, ...values }, f, { approved: true }), { code: 'INVALID_INPUT' })
})
test('specific cell edit/clear permissions and incremental mode cannot be bypassed through bulk value calls', async () => {
  const input = { definitionId: '41', timeType: 'day', time: '2026-11-09', doneValue: null }, denied = fixture({ valueControls: { clearDoneValue: false } }); await assert.rejects(run('values set', input, denied, { approved: true }), { code: 'FORBIDDEN' })
  const incremental = fixture({ increment: true }); await assert.rejects(run('values set', { ...input, doneValue: '1' }, incremental, { approved: true }), { code: 'INVALID_INPUT' }); assert.equal(incremental.calls.some(c => c.method !== 'GET'), false)
})
test('increment records use discovered field IDs, preserve other records and independently read aggregate values', async () => {
  const f = fixture({ increment: true }), base = { definitionId: '41', time: '2026-11-09' }, directory = (await run('records context', base, f)).result
  assert.equal(directory.doneFieldId, '61'); assert.deepEqual(directory.writableFieldIds, ['61', '62'])
  const created = (await run('records create', { ...base, values: { '61': '4.25', '62': '新增' } }, f)).result; assert.equal(created.recordId, '73'); assert.equal(created.values.doneValue, 9.25)
  const updated = (await run('records update', { ...base, recordId: '73', values: { '61': '6', '62': '' } }, f, { approved: true })).result; assert.equal(updated.records.find(r => r.id === '73')['62'], ''); assert.equal(updated.values.doneValue, 11)
  const removed = (await run('records remove', { ...base, recordId: '73' }, f, { approved: true })).result; assert.equal(removed.records.length, 2); assert.equal(removed.values.doneValue, 5)
  assert.deepEqual(f.source.records.map(r => r.id), ['71', '72'])
})
test('guessed record IDs, system field IDs and absent done values are rejected before writes', async () => {
  const base = { definitionId: '41', time: '2026-11-09' }
  for (const [suffix, input] of [['records remove', { ...base, recordId: '999' }], ['records create', { ...base, values: { '60': '4' } }], ['records create', { ...base, values: { '62': '只有备注' } }]]) {
    const f = fixture({ increment: true }); await assert.rejects(run(suffix, input, f, { approved: true })); assert.equal(f.calls.some(c => c.method !== 'GET'), false)
  }
})
test('tree conversion rejects unknown, cyclic-dimension, duplicate, foreign-option and invalid organization contexts', () => {
  const root = { type: 'company', childList: [{ type: 'dept', id: 8, childList: [] }] }, dims = [{ id: 31, itemList: [{ id: 32 }] }]
  for (const tree of [{ by: 'none', children: [{ type: 'dimension', id: '32' }] }, { by: 'organization', children: [{ type: 'dept', id: '9' }] }, { by: 'dimension', dimensionId: '31', children: [{ type: 'dimension', id: '33' }] }, { by: 'dimension', dimensionId: '31', children: [{ type: 'dimension', id: '32', breakdown: { by: 'dimension', dimensionId: '31', children: [{ type: 'dimension', id: '32' }] } }] }]) assert.throws(() => buildIndicatorBreakdown(root, tree, dims, ['31']))
  assert.deepEqual(buildIndicatorBreakdown(root, { by: 'organization', children: [{ type: 'dept', id: '8' }] }, dims, []), [{ attributionType: 'company', splitMode: 'attribution', childs: [{ id: '8', attributionType: 'dept', splitMode: 'none', childs: [] }] }])
})
test('dates and decimal amounts reject impossible periods, truncation and implicit clearing', () => {
  for (const [type, value] of [['day', '2026-02-30'], ['month', '2026-13'], ['week', '2021-W53'], ['year', '0'], ['quarter', '2026-Q5']]) assert.throws(() => indicatorTime(type, value))
  assert.equal(indicatorTime('week', '2026-W53'), '2026-W53'); assert.equal(indicatorTime('day', '2024-02-29'), '2024-02-29')
  for (const value of [0, '1e2', 'NaN', '10000000000', '0.1234567', '']) assert.throws(() => indicatorNumber(value))
  assert.equal(indicatorNumber(null, true), ''); assert.equal(indicatorNumber('-1.000001'), '-1.000001')
})
test('offline plans do no HTTP; confirmations and exact executor steps cannot be bypassed', async () => {
  const f = fixture(), offline = await run('records create', { definitionId: '41', time: '2026-11-09', values: { '61': '1' } }, f, { dryRun: true }); assert.equal(offline.dryRun, true); assert.equal(f.calls.length, 0)
  for (const item of workflows.workflows.filter(f => f.executor === 'okr-indicators')) { validateOkrIndicatorWorkflow(item); assert.ok(workflowSchema(item).access.features.includes('OKR_INDICATOR')) }
  await assert.rejects(run('definition remove', { definitionId: '41' }, f), { code: 'CONFIRMATION_REQUIRED' })
  const forged = clone(flow('definition inspect')); forged.okrIndicatorAction = 'invented'; await assert.rejects(runWorkflow(ctx, forged, { definitionId: '41' }, session, { transport: f.transport }), { code: 'INVALID_CONTRACT' })
  const wrong = clone(flow('definition create')); wrong.steps.at(-1).input = { body: {} }; assert.throws(() => validateOkrIndicatorWorkflow(wrong), { code: 'INVALID_CONTRACT' })
})
test('a lost creation response sends only one POST and reports the unknown result for recovery', async () => {
  const f = fixture({ lostReply: true }); await assert.rejects(run('dimensions create', { name: '结果未知', options: [{ name: 'A' }] }, f), error => error.details.resultMayBeUnknown === true && error.details.automaticRetry === false)
  assert.equal(f.calls.filter(c => c.path.endsWith('/dimension') && c.method === 'POST').length, 1); assert.ok(f.dimensions.some(d => d.name === '结果未知'))
})
