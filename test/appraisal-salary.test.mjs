import { test } from 'node:test'
import assert from 'node:assert/strict'
import Big from 'big.js'
import { workflows, runWorkflow, workflowSchema } from '../dist/workflows.js'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { salaryPeriod, salaryFormula } from '../dist/appraisal-salary-data.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xlsxFixture } from '../scripts/xlsx-fixture.mjs'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value)), definition = suffix => workflows.workflows.find(flow => flow.command === 'appraisal salary ' + suffix)
function fixture(options = {}) {
  const calls = [], models = new Map(), fieldsFor = () => [
    { id: '500', name: '用户', type: 'name', isSystem: true, isShow: true, displayOrder: 65536, from: '同步通讯录', formula: null },
    { id: '501', name: '部门', type: 'dept', isSystem: true, isShow: true, displayOrder: 131072, from: '同步通讯录', formula: null },
    { id: '502', name: '直属上级', type: 'leader', isSystem: true, isShow: true, displayOrder: 196608, from: '同步通讯录', formula: null },
    { id: '503', name: '基础工资', type: 'num', isSystem: false, isShow: true, displayOrder: 262144, from: '手动录入', formula: null },
    { id: '504', name: '计算工资', type: 'formula', isSystem: false, isShow: true, displayOrder: 327680, from: '基础工资*2', formula: { id: '604', text: '$_field_503_$*2', factors: ['$_field_503_$'] } },
  ]
  let nextId = 1000
  const base = { id: '401', name: '薪酬报表', users: [{ id: '81', showName: '同名成员' }, { id: '82', showName: '同名成员' }], depts: [], fields: fieldsFor(), data: new Map([['2026-10:81:503', '0'], ['2026-10:82:503', ''], ['2026-11:81:503', '8.25'], ['2026-11:82:503', '9']]) }; models.set(base.id, base)
  const detail = model => ({ id: model.id, name: model.name, users: model.users, depts: model.depts })
  const model = { calls, models, base, directory: [{ id: 70, type: 'top', name: '公司', parentId: null, displayOrder: 0, userList: [], childList: [{ id: 71, type: 'common', name: '部门', parentId: 70, displayOrder: 1, userList: [{ id: 81, name: '同名成员' }, { id: 82, name: '同名成员' }], childList: [] }] }], state: { vt: 'fixture', mainApp: 'TEAM', deadLine: '2099-01-01 23:59:59', usersCount: 2, userLimit: 10 }, features: [{ funcName: 'PERFORMANCE', status: 'enable' }, { funcName: 'PERFORMANCE_SALARY', status: 'enable' }] }
  model.transport = async (url, init) => {
    const path = url.pathname.replace('/task/performance', ''), query = Object.fromEntries(url.searchParams), body = init.body ? JSON.parse(init.body) : {}, call = { path, method: init.method, query, body }; calls.push(call)
    const result = value => json({ code: 200, data: value })
    if (model.hook) { const response = await model.hook(call); if (response) return response }
    if (path.endsWith('/authAjax')) return json({ success: true, id: 81, username: 'fixture', token: 'fixture', team: { id: 7, name: '公司' } })
    if (path.endsWith('/member/state/independent')) return json(model.state)
    if (path.endsWith('/function/available')) return json(model.features)
    if (path.endsWith('/authorities/company/current')) return json({})
    if (path.endsWith('/department/list')) return json(model.directory)
    if (path === '/init') return result({ hasInit: true })
    if (path === '/authority/role') return result({ id: 1, authorities: { performanceManageSalaryData: options.allowed !== false, performanceReportView: false } })
    if (path === '/salaryReport/list') return result([...models.values()].map(row => ({ id: row.id, name: row.name })))
    if (path === '/salaryReport') {
      if (init.method === 'POST') {
        const id = String(++nextId), created = { id, name: body.name, users: body.userIds ? body.userIds.split(',').map(id => ({ id, showName: '成员' })) : [], depts: body.deptIds ? body.deptIds.split(',').map(id => ({ id, name: '部门' })) : [], fields: fieldsFor(), data: new Map() }; models.set(id, created)
        return result(options.invalidCreation ? { id, name: 123 } : detail(created))
      }
      const current = models.get(query.id ?? body.id); assert.ok(current, 'Fixture report must exist')
      if (init.method === 'GET') return result(detail(current))
      if (options.timeout) throw Error('unknown write outcome')
      if (!options.ignore) {
        if (init.method === 'DELETE') models.delete(current.id)
        else { current.name = body.name; current.users = body.userIds ? body.userIds.split(',').map(id => ({ id, showName: '成员' })) : []; current.depts = body.deptIds ? body.deptIds.split(',').map(id => ({ id, name: '部门' })) : [] }
      }
      return result(null)
    }
    if (path === '/salaryField' && init.method === 'GET') return result(models.get(query.id).fields.filter(field => field.type !== 'name').sort((a, b) => a.displayOrder - b.displayOrder))
    if (path.startsWith('/salaryField')) {
      if (options.timeout) throw Error('unknown write outcome')
      const report = init.method === 'POST' ? models.get(body.salaryId) : [...models.values()].find(row => row.fields.some(field => field.id === (query.id ?? body.id))), current = report.fields.find(field => field.id === (query.id ?? body.id))
      if (init.method === 'POST') {
        const field = { id: String(++nextId), name: body.name, type: body.type, isSystem: false, isShow: true, displayOrder: 1000000 + nextId, from: body.formulaText, formula: body.formula ? { id: String(++nextId), text: body.formula.text, factors: body.formula.factors.length ? body.formula.factors : [''] } : null }; if (!options.ignore) report.fields.push(field); return result(field)
      }
      if (!options.ignore) {
        if (init.method === 'DELETE') report.fields = report.fields.filter(field => field !== current)
        else if (path.endsWith('/show')) current.isShow = body.isShow
        else if (path.endsWith('/sort')) { const front = report.fields.find(field => field.id === body.frontId), behind = report.fields.find(field => field.id === body.behindId); current.displayOrder = front && behind ? (front.displayOrder + behind.displayOrder) / 2 : front ? front.displayOrder + 65536 : behind.displayOrder / 2 }
        else { Object.assign(current, { name: body.name, type: body.type, from: body.formulaText }); if (body.formula) current.formula = { ...body.formula } }
      }
      return result(path === '/salaryField' && init.method === 'PUT' ? current : null)
    }
    if (path === '/salaryReport/data' && init.method === 'GET') {
      const report = models.get(query.id), fields = report.fields.filter(field => field.isShow).sort((a, b) => a.displayOrder - b.displayOrder), users = report.users
      return result({ header: fields.map((field, c) => ({ r: 0, c, v: field.name, id: field.id, type: field.type })), body: users.flatMap((user, index) => fields.map((field, c) => {
        let v = report.data.get(query.period + ':' + user.id + ':' + field.id) ?? null
        if (field.type === 'name') v = user.showName
        if (field.type === 'leader') v = '上级'
        if (field.type === 'dept') v = '部门'
        if (field.type === 'formula') { const match = /^\$_field_([0-9]+)_\$\*2$/.exec(field.formula.text); const base = match && report.data.get(query.period + ':' + user.id + ':' + match[1]); v = base != null && base !== '' ? new Big(base).times(2).toFixed(2) : '' }
        return { r: index + 1, c, v, ...(field.type === 'name' ? options.missingUser ? {} : { userId: user.id } : field.type === 'leader' ? { userId: '999' } : {}) }
      })) })
    }
    if (path === '/salaryReport/data/sync') {
      const report = models.get(body.id), previous = body.periodType === 'monthly' ? '2026-10' : body.periodType === 'semiAnnual' ? '2026年上半年' : '2025年全年'
      return result(report.users.filter(user => report.data.has(previous + ':' + user.id + ':' + body.data.id)).map(user => ({ userId: user.id, value: report.data.get(previous + ':' + user.id + ':' + body.data.id) })))
    }
    if (path === '/salaryReport/data') {
      if (options.timeout) throw Error('unknown write outcome')
      if (!options.ignore) for (const cell of body.data) models.get(body.id).data.set(body.period + ':' + cell.userId + ':' + cell.id, cell.value)
      return result([])
    }
    throw Error('Unexpected salary HTTP ' + path)
  }
  return model
}
const run = (suffix, input, f, extra = {}) => runWorkflow(ctx, definition(suffix), input, session, { transport: f.transport, approved: true, ...extra }).catch(error => { error.message += ' ' + JSON.stringify(error.details ?? {}); throw error })
const changes = f => f.calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/data/sync'))
const input = { reportId: '401', period: '2026-11' }
async function excel(rows, execute, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-salary-test-'))
  try { const file = join(directory, 'file-name-can-differ.xlsx'); await writeFile(file, xlsxFixture(rows, extra), { mode: 0o600 }); return await execute(file) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('salary discovery is separate from report-view permission and enforces the salary feature before HTTP business calls', async () => {
  const f = fixture(), result = await executeWorkflow(ctx, definition('context'), {}, session, { transport: f.transport })
  assert.equal(result.result.reports[0].id, '401'); assert.equal(result.result.users[0].id, '81')
  assert.ok(workflowSchema(definition('context')).access.features.includes('PERFORMANCE_SALARY'))
  for (const condition of ['license', 'expiry', 'capacity']) {
    const denied = fixture(); if (condition === 'license') denied.features[1].status = 'disable'; if (condition === 'expiry') denied.state.deadLine = '2000-01-01 00:00:00'; if (condition === 'capacity') denied.state.usersCount = 11
    await assert.rejects(executeWorkflow(ctx, definition('context'), {}, session, { transport: denied.transport }))
    assert.ok(!denied.calls.some(call => call.path.startsWith('/salary')))
  }
  const denied = fixture({ allowed: false }); await assert.rejects(run('context', {}, denied), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!denied.calls.some(call => call.path.startsWith('/salary')))
})
test('report lifecycle scopes actual users and departments, preserves omitted selection and independently verifies removal', async () => {
  const f = fixture(), created = await run('reports create', { name: '新报表', userIds: ['81'], departmentIds: ['71'] }, f), id = created.resources.salaryReportId
  assert.ok(id); assert.deepEqual(created.result.report.userIds, ['81']); assert.deepEqual(created.result.report.departmentIds, ['71'])
  const renamed = await run('reports configure', { reportId: id, patch: { name: '改名' } }, f)
  assert.deepEqual(renamed.result.report.userIds, ['81']); assert.deepEqual(renamed.result.report.departmentIds, ['71'])
  await run('reports configure', { reportId: id, patch: { userIds: [], departmentIds: [] } }, f)
  assert.deepEqual(f.models.get(id).users, []); assert.deepEqual(f.models.get(id).depts, [])
  const removed = await run('reports remove', { reportId: id }, f); assert.equal(removed.result.removed, true); assert.ok(!f.models.has(id)); assert.equal(f.base.name, '薪酬报表')
})
test('unknown resources, duplicate names and foreign user/dept choices stop before any mutation', async () => {
  for (const [suffix, input] of [['reports inspect', { reportId: '999' }], ['reports create', { name: '新报表', userIds: ['999'] }], ['reports configure', { reportId: '401', patch: { departmentIds: ['999'] } }], ['fields configure', { reportId: '401', fieldId: '999', patch: { name: '新名' } }], ['fields create', { reportId: '401', name: '基础工资', type: 'num' }]]) {
    const f = fixture(); await assert.rejects(run(suffix, input, f)); assert.equal(changes(f).length, 0)
  }
})
test('HTTP salary grid identifies rows only from the name column, keeps duplicate names, zero and readonly computed values', async () => {
  const f = fixture(), result = (await run('cells get', input, f)).result
  assert.deepEqual(result.rows.map(row => row.userId), ['81', '82']); assert.ok(result.rows.every(row => row.userId !== '999'))
  assert.equal(result.rows[0].cells['503'], '8.25'); assert.equal(result.rows[0].cells['504'], '16.50')
  assert.equal(result.fields.find(field => field.id === '504').editableCells, false)
  const broken = fixture({ missingUser: true }); await assert.rejects(run('cells get', input, broken), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('cell writes use exact public IDs and decimal strings, preserve unselected cells, refresh formulas and support explicit clearing', async () => {
  const f = fixture(), saved = (await run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '0' }] }, f)).result
  assert.equal(saved.rows[0].cells['503'], '0'); assert.equal(saved.rows[0].cells['504'], '0.00'); assert.equal(saved.rows[1].cells['503'], '9')
  assert.deepEqual(changes(f)[0].body, { id: '401', period: '2026-11', periodType: 'monthly', data: [{ userId: '81', id: '503', value: '0' }] })
  const cleared = (await run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '' }] }, f)).result
  assert.equal(cleared.rows[0].cells['503'], ''); assert.equal(cleared.rows[0].cells['504'], '')
  const noop = changes(f).length; await run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '' }] }, f); assert.equal(changes(f).length, noop)
})
test('hidden, system, formula, foreign and duplicate cell assignments and UI range violations are rejected', async () => {
  for (const values of [[{ userId: '81', fieldId: '504', value: '1' }], [{ userId: '81', fieldId: '501', value: '1' }], [{ userId: '999', fieldId: '503', value: '1' }], [{ userId: '81', fieldId: '503', value: '1' }, { userId: '81', fieldId: '503', value: '2' }], [{ userId: '81', fieldId: '503', value: '10000000000' }], [{ userId: '81', fieldId: '503', value: '1e3' }]]) {
    const f = fixture(); await assert.rejects(run('cells set', { ...input, values }, f), { code: 'INVALID_INPUT' }); assert.equal(changes(f).length, 0)
  }
  const hidden = fixture(); hidden.base.fields.find(field => field.id === '503').isShow = false
  await assert.rejects(run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '1' }] }, hidden), { code: 'INVALID_INPUT' }); assert.equal(changes(hidden).length, 0)
})
test('copying the previous period has a separate readonly preview and a single persisted batch including stored blanks', async () => {
  const f = fixture(), preview = (await run('cells previous', { ...input, fieldId: '503' }, f)).result
  assert.equal(preview.saved, false); assert.equal(preview.previousPeriod, '2026-10'); assert.deepEqual(preview.values.map(row => row.value), ['0', '']); assert.equal(changes(f).length, 0)
  const result = (await run('cells copy-previous', { ...input, fieldId: '503' }, f)).result
  assert.deepEqual(result.rows.map(row => row.cells['503']), ['0', '']); assert.equal(changes(f).length, 1); assert.equal(result.independentlyVerified, true)
})
test('salary Excel preview requires explicit IDs for duplicate names; saving rounds exactly and leaves empty/unselected cells untouched', async () => {
  const f = fixture(), rows = [['姓名', '基础工资'], ['同名成员', '12.345'], ['同名成员', '']]
  await excel(rows, async file => {
    await assert.rejects(run('cells import preview', { ...input, file }, f), { code: 'AMBIGUOUS_RESOURCE' }); assert.equal(changes(f).length, 0)
    const request = { ...input, file, rowUsers: [{ row: 2, userId: '81' }, { row: 3, userId: '82' }] }, preview = (await run('cells import preview', request, f)).result
    assert.equal(preview.saved, false); assert.deepEqual(preview.values, [{ userId: '81', fieldId: '503', value: '12.35' }]); assert.equal(changes(f).length, 0)
    const saved = (await run('cells import save', request, f)).result
    assert.equal(saved.rows[0].cells['503'], '12.35'); assert.equal(saved.rows[0].cells['504'], '24.70'); assert.equal(saved.rows[1].cells['503'], '9')
    assert.equal(saved.batches, 1); assert.equal(saved.independentlyVerified, true); assert.ok(!f.calls.some(call => call.path.endsWith('/template/import')))
  })
})
test('salary Excel validates the full file before mutation and rejects hidden/system/formula fields, unmapped columns, foreign/duplicate users and workbook formulas', async () => {
  for (const [rows, mapping] of [
    [[['姓名', '计算工资'], ['同名成员', '12']], [{ row: 2, userId: '81' }]],
    [[['姓名', '部门'], ['同名成员', '12']], [{ row: 2, userId: '81' }]],
    [[['姓名', '基础工资'], ['同名成员', '12'], ['同名成员', '13']], [{ row: 2, userId: '81' }, { row: 3, userId: '81' }]],
    [[['姓名', '基础工资'], ['同名成员', '12', '15']], [{ row: 2, userId: '81' }]],
    [[['姓名', '基础工资'], ['同名成员', '12']], [{ row: 2, userId: '999' }]],
    [[['姓名', '基础工资'], ['同名成员', '10000000000']], [{ row: 2, userId: '81' }]],
  ]) { const f = fixture(); await excel(rows, file => assert.rejects(run('cells import save', { ...input, file, rowUsers: mapping }, f))); assert.equal(changes(f).length, 0) }
  const hidden = fixture(); hidden.base.fields.find(field => field.id === '503').isShow = false
  await excel([['姓名', '基础工资'], ['同名成员', '12']], file => assert.rejects(run('cells import save', { ...input, file, rowUsers: [{ row: 2, userId: '81' }] }, hidden))); assert.equal(changes(hidden).length, 0)
  const formula = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1" t="inlineStr"><is><t>基础工资</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>同名成员</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'
  const f = fixture(); await excel([], file => assert.rejects(run('cells import save', { ...input, file, rowUsers: [{ row: 2, userId: '81' }] }, f)), { 'xl/worksheets/sheet1.xml': formula }); assert.equal(changes(f).length, 0)
})
test('salary import batches over 1000 cells and reports verified prior batches plus uncertain references when a later write fails', async () => {
  for (const failSecond of [false, true]) {
    const f = fixture(); f.base.users = Array.from({ length: 1001 }, (_, index) => ({ id: String(index + 2000), showName: '独立成员' + index }))
    const rows = [['姓名', '基础工资'], ...f.base.users.map(user => [user.showName, '0'])]; let writes = 0
    f.hook = call => { if (call.path === '/salaryReport/data' && call.method === 'PUT' && ++writes === 2 && failSecond) throw Error('lost response') }
    await excel(rows, async file => {
      if (failSecond) await assert.rejects(run('cells import save', { ...input, file }, f), error => {
        assert.equal(error.details.writeOutcome, 'unknown-do-not-retry'); assert.equal(error.details.resources.completedSalaryCellBatches.length, 1)
        assert.equal(error.details.resources.pendingSalaryCellBatch.length, 1); assert.equal(error.details.resources.completedSalaryCellBatches[0].cells.length, 1000); return true
      })
      else { const saved = (await run('cells import save', { ...input, file }, f)).result; assert.equal(saved.batches, 2); assert.equal(saved.changed, 1001) }
    })
    assert.equal(writes, 2); assert.equal(changes(f)[0].body.data.length, 1000); assert.equal(changes(f)[1].body.data.length, 1)
  }
})
test('quarter copy reads the correct prior quarter and avoids the deployed sync year-replacement defect', async () => {
  const f = fixture(); f.base.data.set('2026年1季度:81:503', '12.50')
  const result = (await run('cells copy-previous', { reportId: '401', fieldId: '503', periodType: 'quarter', period: '2026-Q2' }, f)).result
  assert.equal(result.previousPeriod, '2026年1季度'); assert.equal(result.quarterSyncWorkaround, true); assert.equal(result.rows[0].cells['503'], '12.50')
  assert.ok(!f.calls.some(call => call.path.endsWith('/data/sync'))); assert.equal(changes(f)[0].body.periodType, 'quarter')
  for (const [data, current, previous] of [[{ periodType: 'quarter', period: '2026-Q1' }, '2026年1季度', '2025年4季度'], [{ periodType: 'halfYear', period: '2026-H1' }, '2026年上半年', '2025年下半年'], [{ periodType: 'year', period: '2026' }, '2026年全年', '2025年全年']]) { const value = salaryPeriod(data); assert.equal(value.code, current); assert.equal(value.previousCode, previous) }
})
test('field creation and formula editing construct real factors and retain formula record IDs; numeric conversion without one is blocked', async () => {
  const f = fixture(), created = await run('fields create', { reportId: '401', name: '公式二', type: 'formula', expression: '{{503}}*2' }, f)
  assert.ok(created.resources.salaryFieldId); assert.equal(created.result.field.formula.text, '$_field_503_$*2')
  await run('fields configure', { reportId: '401', fieldId: '504', patch: { name: '公式改名', expression: '{{503}}+{{503}}' } }, f)
  const write = changes(f).at(-1); assert.equal(write.body.formula.id, '604'); assert.deepEqual(write.body.formula.factors, ['$_field_503_$', '$_field_503_$']); assert.equal(write.body.formulaText, '基础工资+基础工资')
  const count = changes(f).length; await assert.rejects(run('fields configure', { reportId: '401', fieldId: '503', patch: { type: 'formula', expression: '{{504}}' } }, f), { code: 'PERSISTENCE_UNSUPPORTED' }); assert.equal(changes(f).length, count)
})
test('formula references validate report membership, hidden editing options, self links and dependency cycles without evaluating JavaScript', async () => {
  const f = fixture(), fields = f.base.fields.filter(field => field.type !== 'name')
  for (const expression of ['{{999}}+1', '{{504}}+1', '$_field_503_$+1', '{{broken}}']) assert.throws(() => salaryFormula(expression, fields, fields.find(field => field.id === '504')), { code: 'INVALID_INPUT' })
  fields.find(field => field.id === '503').isShow = false; assert.throws(() => salaryFormula('{{503}}*2', fields, fields.find(field => field.id === '504')), { code: 'INVALID_INPUT' })
  assert.equal(salaryFormula('{{503}}*2', fields, null).text, '$_field_503_$*2')
  fields.push({ id: '505', name: '反向', type: 'formula', isShow: true, formula: { id: '605', text: '$_field_504_$', factors: ['$_field_504_$'] } })
  assert.throws(() => salaryFormula('{{505}}', fields, fields.find(field => field.id === '504')), { code: 'INVALID_INPUT' })
})
test('field display, same-report moves and removal preserve system and other definitions and expose dependencies', async () => {
  const f = fixture()
  const visibility = (await run('fields visibility set', { reportId: '401', fieldId: '503', isShow: false }, f)).result; assert.equal(visibility.field.isShow, false)
  const moved = (await run('fields move', { reportId: '401', fieldId: '503', beforeFieldId: '501' }, f)).result
  assert.equal(moved.fields[0].id, '503'); assert.equal(changes(f).at(-1).body.frontId, '500'); assert.equal(changes(f).at(-1).body.behindId, '501')
  for (const suffix of ['configure', 'remove']) await assert.rejects(run('fields ' + suffix, { reportId: '401', fieldId: '501', ...(suffix === 'configure' && { patch: { name: '不允许' } }) }, f), { code: 'RESOURCE_FORBIDDEN' })
  const count = changes(f).length; await assert.rejects(run('fields remove', { reportId: '401', fieldId: '503' }, f), { code: 'DEPENDENCY_EXISTS' }); assert.equal(changes(f).length, count)
  const removed = (await run('fields remove', { reportId: '401', fieldId: '503', allowDependentErrors: true }, f)).result
  assert.equal(removed.removed, true); assert.equal(removed.dependencies[0].id, '504'); assert.ok(!removed.fields.some(field => field.id === '503'))
})
test('stale fields or cell data abort before writes and ignored writes fail persistence verification', async () => {
  const stale = fixture(); let reads = 0
  stale.hook = call => { if (call.path === '/salaryField' && call.method === 'GET' && ++reads === 2) stale.base.fields.find(field => field.id === '503').name = '别人已修改' }
  await assert.rejects(run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '0' }] }, stale), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(changes(stale).length, 0)
  const ignored = fixture({ ignore: true }); await assert.rejects(run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '0' }] }, ignored), { code: 'PERSISTENCE_UNSUPPORTED' }); assert.equal(changes(ignored).length, 1)
})
test('failed writes are not replayed and creation IDs survive response validation failures', async () => {
  const timed = fixture({ timeout: true }); await assert.rejects(run('cells set', { ...input, values: [{ userId: '81', fieldId: '503', value: '0' }] }, timed)); assert.equal(changes(timed).length, 1)
  const created = fixture({ invalidCreation: true }); await assert.rejects(run('reports create', { name: '新报表', userIds: ['81'] }, created), error => error.code === 'RESPONSE_SCHEMA_MISMATCH' && error.details.resources.salaryReportId === '1001'); assert.equal(changes(created).length, 1)
})
test('destructive salary writes require confirmation and dry-run resolves context offline; raw requests cannot bypass field guards', async () => {
  const f = fixture(), args = { ...input, values: [{ userId: '81', fieldId: '503', value: '' }] }
  await assert.rejects(run('cells set', args, f, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
  const dry = await run('cells set', args, f, { approved: false, dryRun: true }); assert.equal(dry.dryRun, true); assert.ok(dry.steps.some(step => step.id === 'freshSheet')); assert.equal(f.calls.length, 0)
  const importDry = await run('cells import save', { ...input, file: '/does-not-exist.xlsx' }, f, { approved: false, dryRun: true }); assert.equal(importDry.dryRun, true); assert.ok(importDry.steps.some(step => step.id === 'verifiedSheet')); assert.equal(f.calls.length, 0)
  const op = catalog.operations.find(op => op.route === '/task/performance/salaryReport/data' && op.method === 'PUT')
  await assert.rejects(executeOperation(ctx, op, { body: { id: '401', period: '2026-11', periodType: 'monthly', data: [{ userId: '81', id: '503', value: '' }] } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
