import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { catalog } from '../dist/operations.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { auditWorkflows } from '../scripts/check-coverage.mjs'
import { businessScope } from '../dist/business.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId: '1', teamId: '7' }, expiresAt: Date.now() + 3600000, cookies: jar.serializeSync() }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const base = { replayId: '91', componentId: '301' }, flow = name => workflows.workflows.find(flow => flow.command === 'replay relations ' + name)
const run = (name, args, mock, approved = true) => runWorkflow(ctx, flow(name), { ...base, ...args }, session, { transport: mock.transport, approved })
const writes = mock => mock.calls.filter(call => call.method !== 'GET' || call.path.endsWith('/latest'))
function fixture(options = {}) {
  const calls = [], owner = { id: '101', name: 'Objective A', progress: 0, progressStart: 0, progressTarget: 200, progressCurrent: 0, progressType: 'manual', allowManualUpdateProgress: true, editControl: { view: true, edit: true, advance: true },
    krList: [{ id: '201', krType: 'normal', name: 'KR A', progress: 0, progressStart: 0, progressTarget: 50, progressCurrent: 0, progressType: 'def', editControl: { advance: !options.noAdvance } }, { id: '203', krType: 'subObjective', name: 'Sub objective', progress: 0 }] }
  const other = { ...structuredClone(owner), id: '102', name: 'Objective B', krList: [{ ...structuredClone(owner.krList[0]), id: '202', name: 'KR B' }] }
  const sources = new Map([['101', owner], ['102', other], ['103', { ...structuredClone(owner), id: '103', name: 'Objective C', krList: [] }], ['203', { ...structuredClone(owner), id: '203', name: 'Sub objective', krList: [] }]])
  if (options.sync) owner.krList[0].isSyncIndicator = true
  const snap = (id, okrId, okrType, isKr, name) => ({ id, okrId, okrType, isKr, isDirectRelate: true, name, editControl: { advance: true }, fieldList: [{ id: '701', type: 'text', openFlag: !options.hiddenText, text: 'keep-' + id }, { id: '702', type: 'progress', openFlag: !options.hiddenProgress, progress: 0 }] })
  let direct = [snap('901', '101', 'objective', false, owner.name), snap('902', '201', 'keyResult', true, owner.krList[0].name), { ...snap('903', '202', 'keyResult', true, other.krList[0].name), parent: '102' }], next = 910, gets = 0, lists = 0
  const source = row => row.okrType === 'objective' ? sources.get(String(row.okrId)) : [...sources.values()].flatMap(root => root.krList).find(kr => kr.id === String(row.okrId))
  const parentId = row => row.parent ?? [...sources.values()].find(root => root.krList.some(kr => kr.id === String(row.okrId)))?.id
  const tree = () => {
    const roots = direct.filter(row => !row.isKr).map(row => ({ ...row, krList: [] }))
    for (const row of direct.filter(row => row.isKr)) {
      const parent = parentId(row); let root = roots.find(root => String(root.okrId) === parent)
      if (!root) { root = { id: null, okrId: parent, okrType: 'objective', isKr: false, isDirectRelate: false, name: sources.get(parent).name, fieldList: [], krList: [] }; roots.push(root) }
      const { parent: ignored, ...item } = row; root.krList.push(item)
    }
    return roots
  }
  const report = () => ({ id: 91, replayCollectId: 51, type: 'day', year: 2026, month: 11, day: 8, status: options.stale && gets > 1 ? 'committed' : 'uncommitted', writer: { id: options.foreignWriter ? 2 : 1 }, editControl: { edit: true },
    componentList: [{ id: 501, replayCollectTemplateComponentId: 301, type: 'importObjective', importObjectiveFieldList: [{ id: 701, type: 'text', isOpen: !options.hiddenText }, { id: 702, type: 'progress', isOpen: !options.hiddenProgress }] }] })
  return { calls, sources, get direct() { return structuredClone(direct) }, transport: async (url, init) => {
    const call = { path: url.pathname, method: init.method, query: Object.fromEntries(url.searchParams), ...(typeof init.body === 'string' && { body: JSON.parse(init.body) }) }; calls.push(call)
    if (call.path === '/task/review/replay') { gets++; return json(report()) }
    if (call.path === '/task/review/replay/collect') return json({ id: 51, type: 'day', name: 'Own fixture' })
    if (call.path === '/task/okr/objective') return json(sources.get(call.query.id))
    if (call.path.endsWith('/okr/list')) {
      lists++; if (options.drift && lists === 2) direct[0].fieldList[0].text = 'concurrent edit'
      return json(tree())
    }
    if (call.path.endsWith('/okr/list/latest')) {
      if (!options.ignoreWrite) direct = direct.map(row => ({ ...row, name: source(row).name, fieldList: row.fieldList.map(field => field.type === 'progress' ? { ...field, progress: Math.round(source(row).progress) } : field) }))
      return json(tree())
    }
    if (options.timeout) throw Error('unknown outcome')
    if (call.path.endsWith('/okr/text')) {
      if (!options.ignoreWrite) direct = direct.map(row => row.id === call.body.replayOkrId ? { ...row, fieldList: row.fieldList.map(field => field.id === call.body.replayFieldId ? { ...field, text: call.body.text } : field) } : row)
      return json(null)
    }
    if (call.path.endsWith('/component/okr')) {
      if (!options.ignoreWrite) {
        if (call.method === 'POST') direct = call.body.okrList.map(item => direct.find(row => row.okrId === item.okrId && row.okrType === item.okrType && row.isKr === item.isKr) ?? { ...snap(String(next++), item.okrId, item.okrType, item.isKr, source(item).name), ...(item.isKr && { parent: parentId(item) }) })
        if (call.method === 'DELETE') direct = direct.filter(row => row.id !== call.query.id)
        if (call.method === 'PUT') {
          const row = direct.find(row => row.id === call.body.replayOkrId), target = source(row)
          target.progressCurrent = call.body.progressCurrent; target.progress = Math.round(100 * (target.progressCurrent - target.progressStart) / (target.progressTarget - target.progressStart))
          row.fieldList.find(field => field.type === 'progress').progress = target.progress
        }
      }
      return json(null)
    }
    throw Error('Unexpected route ' + call.path)
  } }
}
test('replay objective commands have bounded context bindings and entirely offline dry-run/confirmation', async () => {
  assert.deepEqual(auditWorkflows(workflows, catalog, businessScope), [])
  const mock = fixture(), plan = await runWorkflow(ctx, flow('objectives refresh'), base, null, { dryRun: true, transport: mock.transport })
  assert.equal(plan.effect, 'destructive'); assert.equal(mock.calls.length, 0)
  await assert.rejects(run('objective link', { objectiveId: '103' }, mock, false), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(mock.calls.length, 0)
})
test('adding an objective preserves complete selected KR set below virtual parents and custom text', async () => {
  const mock = fixture(), old = mock.direct, result = (await run('objective link', { objectiveId: '103' }, mock)).result
  assert.equal(result.relations.length, 4)
  assert.deepEqual(mock.direct.slice(0, 3), old)
  const post = writes(mock)[0]; assert.equal(post.body.okrList.length, 4)
  assert.deepEqual(post.body.okrList[2], { okrId: '202', okrType: 'keyResult', isKr: true })
  assert.equal(post.body.replayCollectTemplateComponentId, '301'); assert.equal(post.body.day, 8)
})
test('KR types are derived from actual parent detail, not numeric ID or guessed source type', async () => {
  const mock = fixture(); await run('objective link', { objectiveId: '101', resultId: '203' }, mock)
  assert.deepEqual(writes(mock)[0].body.okrList.at(-1), { okrId: '203', okrType: 'objective', isKr: true })
  const other = fixture(); await assert.rejects(run('objective link', { objectiveId: '101', resultId: '202' }, other), { code: 'INVALID_INPUT' }); assert.equal(writes(other).length, 0)
  const duplicate = fixture(); await assert.rejects(run('objective link', { objectiveId: '101', resultId: '201' }, duplicate), { code: 'INVALID_INPUT' }); assert.equal(writes(duplicate).length, 0)
})
test('text clear changes replay only and rejects system fields, virtual parents and hidden fields', async () => {
  const mock = fixture(), before = structuredClone([...mock.sources.values()])
  await run('objective text set', { relationId: '902', fieldId: '701', text: '' }, mock)
  assert.equal(mock.direct[1].fieldList[0].text, ''); assert.deepEqual([...mock.sources.values()], before)
  for (const [args, options] of [[{ relationId: '902', fieldId: '702', text: '' }, {}], [{ relationId: '102', fieldId: '701', text: '' }, {}], [{ relationId: '902', fieldId: '701', text: '' }, { hiddenText: true }]]) {
    const denied = fixture(options); await assert.rejects(run('objective text set', args, denied)); assert.equal(writes(denied).length, 0)
  }
})
test('HTTP refresh persists snapshots, preserves text, and reads actual source data independently', async () => {
  const mock = fixture(); mock.sources.get('101').name = 'Changed'; mock.sources.get('102').krList[0].progress = 36
  const result = (await run('objectives refresh', {}, mock)).result
  assert.equal(result.relations[0].name, 'Changed'); assert.equal(result.relations.find(row => row.okrId === '202').fieldList[1].progress, 36)
  assert.equal(result.relations[0].fieldList[0].text, 'keep-901'); assert.equal(writes(mock).length, 1)
  assert.equal(mock.calls.filter(call => call.path === '/task/okr/objective').length, 2)
})
test('unlinking a direct parent preserves imported children below a virtual parent and actual source', async () => {
  const mock = fixture(), result = (await run('objective unlink', { relationId: '901' }, mock)).result
  assert.equal(result.relations.length, 2); assert.equal(result.tree.find(root => root.okrId === '101').isDirectRelate, false)
  assert.equal(mock.sources.get('101').krList[0].id, '201')
  assert.equal(mock.calls.filter(call => call.path === '/task/okr/objective').length, 2)
})
test('progress intentionally changes source current value and snapshot, with role/sync/visibility restrictions', async () => {
  const mock = fixture(); await run('objective progress set', { relationId: '902', percent: 40 }, mock)
  assert.equal(mock.sources.get('101').krList[0].progressCurrent, 20); assert.equal(mock.direct[1].fieldList[1].progress, 40)
  assert.equal(mock.direct[1].fieldList[0].text, 'keep-902')
  const root = fixture(); await run('objective progress set', { relationId: '901', percent: 25 }, root); assert.equal(root.sources.get('101').progressCurrent, 50)
  for (const options of [{ noAdvance: true }, { sync: true }, { hiddenProgress: true }]) {
    const denied = fixture(options); await assert.rejects(run('objective progress set', { relationId: '902', percent: 40 }, denied)); assert.equal(writes(denied).length, 0)
  }
})
test('write preflight rejects changed status, a foreign writer and changed relationship context', async () => {
  for (const options of [{ stale: true }, { foreignWriter: true }, { drift: true }]) {
    const mock = fixture(options); await assert.rejects(run('objective text set', { relationId: '902', fieldId: '701', text: 'new' }, mock)); assert.equal(writes(mock).length, 0)
  }
})
test('unknown writes are never replayed and independent readback rejects an acknowledged no-op', async () => {
  const timeout = fixture({ timeout: true }); await assert.rejects(run('objective link', { objectiveId: '103' }, timeout)); assert.equal(writes(timeout).length, 1)
  const ignored = fixture({ ignoreWrite: true }); await assert.rejects(run('objective text set', { relationId: '902', fieldId: '701', text: 'new' }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(ignored).length, 1)
})
