import { CookieJar } from 'tough-cookie'
const signatureTestJar = new CookieJar(); signatureTestJar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly', 'https://www.rishiqing.com')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Big from 'big.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { appraisalTotal } from '../dist/appraisal-assessments.js'
import { runAppraisalEntryImport } from '../dist/appraisal-entry-import.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xlsxFixture } from '../scripts/xlsx-fixture.mjs'
import { unzipSync, strFromU8 } from 'fflate'
const ctx = { environment: 'production', profile: 'fixture' }, session = { version: 1, method: 'password', accessToken: 'fixture', cookies: signatureTestJar.serializeSync(), identity: { userId: '81', teamId: '7' }, expiresAt: Date.now() + 3600000 }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}) {
  const calls = [], authority = { performanceAppraisalMyData: true, performanceAppraisalDeptDataManage: true, performanceAppraisalSubmit: true, ...options.authorities }
  let stage = options.stage ?? 'resultEntry', exists = options.exists ?? true, contentReads = 0, signedStage, signedFileId
  const assessment = { id: 301, type: 'custom', object: { id: 81 }, time: { startDate: '2026.11.08', endDate: '2026.11.09', period: '独立验收' }, isStartScore: false,
    isCanConfirm: true, isCanResultConfirm: true, isContentSignature: false, isResultSignature: false, scoreRule: { fullScore: '100', scoreMode: 'manual', optionList: [] }, ...options.assessment }
  const content = { id: 501, calculation: 'sum', isDimensionsWeight: false, dimensions: [{ id: 601, type: 'quantitative', weight: '100', name: '维度', indicators: [{ id: 701, name: '指标', weight: '100', scoreLimit: '100', isAutoScore: false, resultValue: '', canEntry: true, entryUser: { id: 81 } }] }],
    raters: [{ id: 81, status: 'undone', isTotal: false, isExplanation: false, fullScore: null, scores: [{ indicatorId: 701, score: null, scoreExplanation: '', scoreOptionId: null, canEdit: true, files: [] }] }] }
  const reviews = { reviewList: [] }
  const node = () => ({ stage, status: stage === 'finished' ? 'finished' : 'processing', scoreNodeId: stage === 'scoring' ? 901 : null, assignee: [{ id: options.assignee ?? 81, status: { resultEntry: 'tbe', scoring: 'tbs', resultConfirm: 'tbrc', contentConfirm: 'tbc', contentAcknowledgement: 'await-acknowledgement', resultAcknowledgement: 'await-acknowledgement', unScore: 'tbc', finished: 'rated' }[stage] }] })
  const transport = async (url, init) => {
    const method = init.method, path = url.pathname.replace('/task/performance', ''), query = Object.fromEntries(url.searchParams)
    if (path === '/appraisal/export/entryUpload') {
      assert.ok(init.body instanceof FormData); const blob = init.body.get('fileData'); assert.equal(blob.name, 'entry.xlsx')
      const bytes = Buffer.from(await blob.arrayBuffer()), parts = unzipSync(bytes)
      assert.ok(parts['xl/sharedStrings.xml']); assert.match(strFromU8(parts['xl/worksheets/sheet1.xml']), /r="J3" t="s"/); assert.doesNotMatch(strFromU8(parts['xl/worksheets/sheet1.xml']), /inlineStr/)
      calls.push({ method, path, query, body: { parsedOnly: true } }); return json({ code: 200, data: options.importEntries ?? [{ indicatorId: 701, resultValue: '12.30' }] })
    }
    const body = init.body ? JSON.parse(init.body) : {}
    calls.push({ method, path, query, body })
    const response = (data, ext = null) => json({ code: 200, msg: 'ok', data, ext })
    if (url.pathname === '/task/login/authAjax') return json({ success: true, id: 81, username: 'fixture', team: { id: 7, name: '公司' }, token: 'fixture' })
    if (url.pathname === '/task/file/signature/getFront') return json({ fileId: 1001, realPath: 'https://fixture.invalid/private-signature' })
    if (url.pathname === '/task/v1/folder/file') return json({ id: 1001, name: 'signature.png', size: 68, creatorId: options.foreignSignature ? 82 : 81 })
    if (path === '/init') return response({ hasInit: true })
    if (path === '/authority/role') return response({ id: 1, authorities: authority })
    if (path === '/member/select') return response([{ id: options.foreignScope ? 82 : 81, showName: '可管理成员' }])
    if (path === '/templates/my') return response([{ id: 101, name: '本公司模板', type: 'custom', appraisalSubmit: true, rule: { id: 201 }, group: { id: 'unassigned' } }])
    if (path === '/template') return response({ id: null, name: '本公司模板', type: 'custom', rule: { id: 201 }, group: { id: 'unassigned' }, objects: [{ id: 81 }] })
    if (path === '/appraisal/getUser') return response([])
    if (path === '/appraisal/batchHas') return response({ errorMessage: options.launchError ?? null, warnMessage: options.launchWarning ?? null })
    if (path === '/appraisal/periodList') return response([{ period: '独立验收', type: 'custom' }])
    if (path.startsWith('/appraisals/')) return response(exists ? [{ id: path.endsWith('/resultValue') ? 701 : 301, appraisalId: 301, period: assessment.time.period, object: assessment.object, stage }] : [], path === '/appraisals/all' ? [{ stage, count: exists ? 1 : 0 }] : null)
    if (path === '/appraisal' && method === 'GET') return response(assessment)
    if (path === '/v2/content' && method === 'GET') { if (options.mutateEntryAfterInspect && ++contentReads === 2) content.dimensions[0].indicators[0].resultValue = '77.00'; return response(content) }
    if (path === '/content/flowInfo') return response({ flowInfo: [node(), ...(signedFileId ? [{ stage: signedStage, status: 'done', assignee: [], fileVO: { id: signedFileId, name: 'signature.png' } }] : []), ...(options.automatic ? [{ stage: 'resultEntryTwo', status: stage === 'scoring' ? 'notStart' : 'processing', assignee: [] }] : [])], button: { isShowReset: true, isShowRevocation: false } })
    if (path === '/appraisal/rule') return response({ id: 111, originalRuleId: 201, fullScore: '100', isOpenCoefficient: true, levels: [{ id: 411, levelName: 'A', coefficient: '1.2' }] })
    if (path === '/resultConfirm/calibration') { if (!options.ignore) Object.assign(assessment, { finalScore: body.result[0].calibrationScore, level: body.result[0].calibrationLevel, coefficient: body.result[0].calibrationCoefficient ?? '1.2' }); return response(null) }
    if (path === '/preference/dimension/dictionaries') { assert.equal(query.contentId, '501'); assert.equal(query.isLaunched, 'true'); return response({ 601: [{ id: 1, key: 'name' }] }) }
    if (path === '/appraisal/reviews' && method === 'GET') return response(reviews)
    if (options.timeout) throw Error('submission response lost')
    if (path === '/appraisal/batch') { if (!options.ignore && !options.pending) { exists = true; Object.assign(assessment.time, { period: body.period, startDate: body.startDate, endDate: body.endDate }) }; return response(null) }
    if (path === '/appraisal' && method === 'DELETE') { if (!options.ignore) exists = false; return response(null) }
    if (path === '/appraisal/startScore') { if (!options.ignore) { assessment.isStartScore = true; stage = 'scoring' }; return response(null) }
    if (path === '/appraisal/entry') { if (!options.ignore) { for (const value of body.values) { let formatted; try { formatted = new Big(value.value.trim().replace(/^\+/, '')).toFixed(2) } catch { formatted = value.value }; content.dimensions[0].indicators.find(row => row.id === value.indicatorId).resultValue = formatted }; if (!body.isTemporary) stage = 'unScore' }; return response(null) }
    if (path === '/appraisal/score') { if (!options.ignore) { for (const value of body.scores) Object.assign(content.raters[0].scores.find(row => row.indicatorId === value.indicatorId), { score: value.score == null ? null : new Big(value.score).toFixed(2), scoreOptionId: value.scoreOptionId ?? null, scoreExplanation: value.scoreExplanation ?? null }); if (!body.isTemporary) { content.raters[0].fullScore = body.totalScore; content.raters[0].status = 'submitted'; stage = body.isBeforeResultEntryTwo ? 'resultEntryTwo' : 'finished' } }; return response(null) }
    if (path === '/appraisal/reviews' && method === 'PUT') { if (!options.ignore) reviews.reviewList.find(row => row.id === body.reviewId).reviewContent = body.content; return response(null) }
    if (['/appraisal/confirmSubmit', '/appraisal/resultConfirmSubmit', '/appraisal/contentAcknowledgement', '/appraisal/resultAcknowledgement'].includes(path)) { if (body.fileId !== undefined && !options.ignoreSignature) { signedStage = stage; signedFileId = body.fileId } if (!options.ignore) stage = 'finished'; return response(null) }
    throw Error('unexpected request ' + method + ' ' + path)
  }
  return { transport, calls, assessment, content, reviews }
}
const run = (command, input, f, options = {}) => { const flow = workflows.workflows.find(flow => flow.command === 'appraisal ' + command); assert.ok(flow, command); return runWorkflow(ctx, flow, input, session, { transport: f.transport, approved: true, ...options }) }
const writes = f => f.calls.filter(call => !['GET'].includes(call.method) && !['/appraisal/batchHas', '/appraisal/export/entryUpload'].includes(call.path))
async function entryFile(rows, execute) {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-entry-test-')), bytes = xlsxFixture(rows)
  try { const file = join(directory, 'import.xlsx'); await writeFile(file, bytes, { mode: 0o600 }); return await execute(file, bytes) } finally { await rm(directory, { recursive: true, force: true }) }
}
const entryRows = (id = '701', value = '12.30') => [['说明'], ['指标 ID', null, null, null, null, null, null, null, null, '结果'], [id, null, null, null, null, null, null, null, null, value]]

test('entry import parses immutable multipart bytes, previews actual assignments and persists only temporary values with independent readback', async () => {
  const offline = fixture(), dry = await run('result-entry import save', { file: '/does-not-exist.xlsx', appraisalIds: ['301'] }, offline, { approved: false, dryRun: true })
  assert.equal(dry.dryRun, true); assert.ok(dry.steps.some(step => step.id === 'parsed')); assert.equal(offline.calls.length, 0)
  await assert.rejects(run('result-entry import save', { file: '/does-not-exist.xlsx', appraisalIds: ['301'] }, offline, { approved: false }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(offline.calls.length, 0)
  await entryFile(entryRows(), async (file, bytes) => {
    const f = fixture({ uploadBytes: bytes }), request = { file, appraisalIds: ['301'] }
    const preview = await run('result-entry import preview', request, f)
    assert.equal(preview.result.saved, false); assert.deepEqual(preview.result.plans[0].values, [{ indicatorId: '701', value: '12.30' }]); assert.equal(writes(f).length, 0)
    const saved = await run('result-entry import save', request, f)
    assert.equal(saved.result.independentlyVerified, true); assert.deepEqual(saved.resources.importedAssessmentIds, ['301']); assert.equal(f.content.dimensions[0].indicators[0].resultValue, '12.30')
    assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].body.isTemporary, true)
  })
})
test('entry import rejects foreign indicators, wrong parser results and stale context before saving; permission denial is not a positive import', async () => {
  for (const options of [
    { importEntries: [{ indicatorId: 702, resultValue: '12.30' }] },
    { importEntries: [{ indicatorId: 701, resultValue: '99' }] },
    { assignee: 82 }, { mutateEntryAfterInspect: true },
  ]) await entryFile(entryRows(), async file => { const f = fixture(options); await assert.rejects(run('result-entry import save', { file, appraisalIds: ['301'] }, f)); assert.equal(writes(f).length, 0) })
  await entryFile(entryRows('999'), async file => { const f = fixture({ importEntries: [{ indicatorId: 999, resultValue: '12.30' }] }); await assert.rejects(run('result-entry import save', { file, appraisalIds: ['301'] }, f), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(f).length, 0) })
  await entryFile([...entryRows(), [], ['702', null, null, null, null, null, null, null, null, '9']], async file => {
    const f = fixture(); await assert.rejects(run('result-entry import save', { file, appraisalIds: ['301'] }, f), { code: 'INVALID_INPUT' }); assert.equal(f.calls.filter(call => call.path.endsWith('entryUpload')).length, 0)
  })
})
test('entry import reports completed assessments on partial failure without replay or submission', async () => {
  const rows = [...entryRows('701'), ['702', null, null, null, null, null, null, null, null, '5']], resources = {}, saves = []
  await entryFile(rows, file => assert.rejects(runAppraisalEntryImport('entry-import-save', { file, appraisalIds: ['301', '302'] }, {
    userId: '81', resources,
    call: async () => [{ indicatorId: 701, resultValue: '12.30' }, { indicatorId: 702, resultValue: '5' }],
    inspect: async appraisalId => ({ assessment: { id: appraisalId }, content: { dimensions: [{ id: 601, type: 'quantitative', indicators: [{ id: appraisalId === '301' ? '701' : '702', canEntry: true, entryUser: { id: 81 }, isAutoScore: false, resultValue: '' }] }] }, flow: { flowInfo: [{ stage: 'resultEntry', status: 'processing', assignee: [{ id: 81, status: 'tbe' }] }] } }),
    save: async appraisalId => { saves.push(appraisalId); if (appraisalId === '302') throw Error('uncertain write outcome') },
  })))
  assert.deepEqual(resources.importedAssessmentIds, ['301']); assert.deepEqual(saves, ['301', '302'])
})
test('entry scientific decimal formatting follows the server; automatic scoring precision and huge expanded numbers are checked before writes', async () => {
  const f = fixture(); f.content.dimensions[0].indicators[0].isAutoScore = true
  await run('assessments entry save', { appraisalId: '301', values: [{ indicatorId: '701', value: '+1.2e1' }] }, f); assert.equal(f.content.dimensions[0].indicators[0].resultValue, '12.00')
  const before = writes(f).length
  for (const value of ['1e-3', 'text', '1e5000']) await assert.rejects(run('assessments entry save', { appraisalId: '301', values: [{ indicatorId: '701', value }] }, f), { code: 'INVALID_INPUT' })
  assert.equal(writes(f).length, before)
  const queue = await run('assessments queue result-entry', { isHistory: false }, f); assert.match(queue.result.historySemantics, /false 为待处理，true 为已处理/)
})

test('calibration requires current own task and button permission, resolves snapshot levels and coefficients, and does not submit confirmation', async () => {
  const f = fixture({ stage: 'resultConfirm', assessment: { isResultCalibration: true } })
  const out = await run('assessments calibrate', { appraisalId: '301', calibration: { score: '91.25', level: 'A', coefficient: '1.25' } }, f)
  assert.equal(out.result.assessment.finalScore, '91.25'); assert.equal(out.result.assessment.coefficient, '1.25'); assert.equal(out.result.confirmationSubmitted, false); assert.equal(out.result.flow.flowInfo[0].stage, 'resultConfirm')
  assert.deepEqual(writes(f)[0].body, { result: [{ id: 301, calibrationScore: '91.25', calibrationLevel: 'A', calibrationCoefficient: '1.25' }] })
  for (const options of [{ stage: 'scoring', assessment: { isResultCalibration: true } }, { stage: 'resultConfirm', assignee: 82, assessment: { isResultCalibration: true } }, { stage: 'resultConfirm', assessment: { isResultCalibration: false } }]) { const blocked = fixture(options); await assert.rejects(run('assessments calibrate', { appraisalId: '301', calibration: { score: '0', level: 'A' } }, blocked), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(blocked).length, 0) }
  const ignored = fixture({ stage: 'resultConfirm', assessment: { isResultCalibration: true }, ignore: true }); await assert.rejects(run('assessments calibrate', { appraisalId: '301', calibration: { score: '0', level: 'A' } }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(ignored).length, 1)
})

test('all automatic scoring advances to second entry using the UI shortcut without manufacturing scores', async () => {
  const f = fixture({ stage: 'scoring', automatic: true }); f.content.dimensions[0].indicators[0].isAutoScore = true
  const out = await run('assessments score submit', { appraisalId: '301', scores: [] }, f)
  assert.equal(out.result.awaitingAutomaticResultEntry, true); assert.deepEqual(writes(f)[0].body, { appraisalId: 301, scores: [], totalScore: null, isTemporary: false, isBeforeResultEntryTwo: true })
})

test('assessment discovery keeps scoped roles, current HTTP context, dynamic field IDs, queue ID semantics and envelope statistics', async () => {
  const f = fixture(), out = await run('assessments inspect', { appraisalId: '301' }, f)
  assert.equal(out.result.currentRaterColumns[0].index, 0); assert.equal(out.result.fields[601][0].key, 'name')
  const managed = await run('assessments managed', { offset: 4, max: 5, objectIds: ['81'], period: '独立验收' }, f)
  assert.deepEqual(managed.result.statistics, [{ stage: 'resultEntry', count: 1 }]); assert.equal(f.calls.at(-1).query.userIds, '81'); assert.equal(managed.result.pagination.complete, false)
  const queue = await run('assessments queue result-entry', { isHistory: true }, f); assert.equal(queue.result.assessments[0].id, 701); assert.equal(queue.result.assessments[0].appraisalId, 301)
  const denied = fixture({ authorities: { performanceAppraisalDeptDataManage: false } }); await assert.rejects(run('assessments managed', {}, denied), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(!denied.calls.some(call => call.path === '/appraisals/all'))
})
test('launch validates template and actual member scope, duplicate period and batch checks before async HTTP readback; submits exactly once', async () => {
  const f = fixture({ exists: false }), input = { templateId: '101', objectIds: ['81'], period: '独立验收', startDate: '2026-11-08', endDate: '2026-11-09' }
  const out = await run('assessments launch', input, f)
  assert.deepEqual(out.resources.appraisalIds, ['301']); assert.equal(out.result.assessments[0].assessment.time.startDate, '2026.11.08'); assert.equal(f.calls.filter(call => call.path === '/appraisal/batch').length, 1)
  const duplicate = fixture(); await assert.rejects(run('assessments launch', input, duplicate), { code: 'ALREADY_EXISTS' }); assert.equal(writes(duplicate).length, 0)
  for (const options of [{ foreignScope: true }, { launchWarning: '已有周期' }, { launchError: '重复对象' }]) { const blocked = fixture({ exists: false, ...options }); await assert.rejects(run('assessments launch', input, blocked)); assert.equal(writes(blocked).length, 0) }
})
test('entry save preserves a pending task and explicit clearing; submit reads all own editable indicators and advances', async () => {
  const f = fixture()
  await run('assessments entry save', { appraisalId: '301', values: [{ indicatorId: '701', value: '12.30' }] }, f)
  assert.equal(f.content.dimensions[0].indicators[0].resultValue, '12.30')
  await run('assessments entry save', { appraisalId: '301', values: [{ indicatorId: '701', value: '' }] }, f)
  const submitted = await run('assessments entry submit', { appraisalId: '301', values: [{ indicatorId: '701', value: '99' }] }, f); assert.equal(submitted.result.flow.flowInfo[0].stage, 'unScore')
  await run('assessments start-score', { appraisalId: '301' }, f)
  assert.equal(writes(f).at(-1).body.appraisalId, '301')
  const foreign = fixture(); await assert.rejects(run('assessments entry submit', { appraisalId: '301', values: [{ indicatorId: '999', value: '1' }] }, foreign), { code: 'INVALID_INPUT' }); assert.equal(writes(foreign).length, 0)
})
test('scoring uses actual pending user, independent score and total readback, supports zero and clearing, and never guesses foreign indicators', async () => {
  const f = fixture({ stage: 'scoring' })
  await run('assessments score save', { appraisalId: '301', scores: [{ indicatorId: '701', score: '0', scoreExplanation: '零分说明' }] }, f)
  assert.equal(f.content.raters[0].scores[0].score, '0.00')
  await run('assessments score save', { appraisalId: '301', scores: [{ indicatorId: '701', score: null, scoreExplanation: '' }] }, f)
  assert.equal(f.content.raters[0].scores[0].score, null)
  assert.equal(writes(f).at(-1).body.scores[0].score, null)
  const result = await run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '93.25', scoreExplanation: '独立业务断言' }] }, f)
  assert.equal(result.result.calculatedTotal, '93.25'); assert.equal(result.result.flow.flowInfo[0].stage, 'finished'); assert.equal(f.content.raters[0].fullScore, '93.25')
  await assert.rejects(run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '90' }] }, f), { code: 'RESOURCE_FORBIDDEN' })
  for (const options of [{ assignee: 82 }, {}]) { const blocked = fixture({ stage: 'scoring', ...options }); await assert.rejects(run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '999', score: '80' }] }, blocked)); assert.equal(writes(blocked).length, 0) }
})
test('a deployed service that ignores null clears reports a specific persistence blocker instead of promoting the request to success', async () => {
  const f = fixture({ stage: 'scoring', ignore: true }); f.content.raters[0].scores[0].score = '0.00'
  await assert.rejects(run('assessments score save', { appraisalId: '301', scores: [{ indicatorId: '701', score: null, scoreExplanation: '' }] }, f), error => { assert.equal(error.code, 'PERSISTENCE_UNSUPPORTED'); assert.equal(error.details.cause.field, 'score'); return true })
  assert.equal(writes(f).length, 1)
})
test('UI total math handles precise weighted dimensions, partial values, add/sub and zero denominator without float drift', () => {
  const content = { calculation: 'weight', isDimensionsWeight: true, dimensions: [{ id: 1, type: 'quantitative', weight: '40', indicators: [{ id: 11, weight: '1' }, { id: 12, weight: '3' }] }, { id: 2, type: 'qualitative', weight: '60', indicators: [{ id: 21, weight: '1' }] }, { id: 3, type: 'add', indicators: [{ id: 31 }] }, { id: 4, type: 'sub', indicators: [{ id: 41 }] }] }
  const values = new Map([['11', new Big('10')], ['12', new Big('90')], ['21', new Big('80')], ['31', new Big('0.1')], ['41', new Big('0.2')]])
  assert.equal(appraisalTotal(content, values), '75.90')
  assert.equal(appraisalTotal(content, new Map()), null)
  assert.equal(appraisalTotal({ calculation: 'weight', isDimensionsWeight: false, dimensions: [{ id: 1, type: 'quantitative', indicators: [{ id: 11, weight: '0' }] }] }, values), '0.00')
})
test('mandatory reviews and explanations block stage submission until actual editable review is saved and independently read back', async () => {
  const f = fixture({ stage: 'scoring' }); f.content.raters[0].isExplanation = true; f.reviews.reviewList.push({ id: 801, isRequired: true, canEdit: true, reviewContent: null })
  await assert.rejects(run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '80' }] }, f), { code: 'INVALID_INPUT' }); assert.equal(writes(f).length, 0)
  await assert.rejects(run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '80', scoreExplanation: '依据' }] }, f), { code: 'INVALID_INPUT' }); assert.equal(writes(f).length, 0)
  const content = { ops: [{ insert: '验收总结\n' }] }; await run('assessments reviews set', { appraisalId: '301', reviewId: '801', content }, f)
  await run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '80', scoreExplanation: '依据' }] }, f)
  assert.deepEqual(f.reviews.reviewList[0].reviewContent, content)
})
test('confirmation checks actual task and UI button; signature-required steps cannot be bypassed', async () => {
  for (const [command, stage] of [['confirm-content', 'contentConfirm'], ['confirm-result', 'resultConfirm'], ['acknowledge-content', 'contentAcknowledgement'], ['acknowledge-result', 'resultAcknowledgement']]) {
    const f = fixture({ stage }); const result = await run('assessments ' + command, { appraisalId: '301' }, f); assert.equal(result.result.flow.flowInfo[0].stage, 'finished')
  }
  const denied = fixture({ stage: 'contentAcknowledgement', assessment: { isContentSignature: true } }); await assert.rejects(run('assessments acknowledge-content', { appraisalId: '301' }, denied), { code: 'INVALID_INPUT' }); assert.equal(writes(denied).length, 0)
})
test('delete requires actual managed target scope, proves list absence; ignored writes fail and timeout is never replayed', async () => {
  const foreign = fixture({ foreignScope: true }); await assert.rejects(run('assessments remove', { appraisalId: '301' }, foreign), { code: 'RESOURCE_FORBIDDEN' }); assert.equal(writes(foreign).length, 0)
  const removed = await run('assessments remove', { appraisalId: '301' }, fixture()); assert.equal(removed.result.removed, true)
  const ignored = fixture({ stage: 'scoring', ignore: true }); await assert.rejects(run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '80' }] }, ignored), { code: 'BUSINESS_ASSERTION_FAILED' }); assert.equal(writes(ignored).length, 1)
  const timed = fixture({ stage: 'scoring', timeout: true }); await assert.rejects(run('assessments score submit', { appraisalId: '301', scores: [{ indicatorId: '701', score: '80' }] }, timed), error => { assert.equal(error.details.writeOutcome, 'unknown-do-not-retry'); assert.equal(error.details.resources.appraisalId, '301'); return true }); assert.equal(writes(timed).length, 1)
  const dry = fixture(); const plan = await run('assessments launch', { templateId: '101', objectIds: ['81'], period: '独立验收', startDate: '2026-11-08', endDate: '2026-11-09' }, dry, { dryRun: true }); assert.ok(plan.steps.length > 5); assert.equal(dry.calls.length, 0)
})

test('signed performance acknowledgements bind only the current own signature and independently verify persisted flow file', async () => {
  for (const [suffix, stage, flag] of [['content', 'contentAcknowledgement', 'isContentSignature'], ['result', 'resultAcknowledgement', 'isResultSignature']]) {
    const f = fixture({ stage, assessment: { [flag]: true } })
    const result = await run('assessments acknowledge-' + suffix, { appraisalId: '301', useLastSignature: true }, f)
    assert.equal(result.result.signature.fileId, '1001'); assert.equal(result.resources.signatureFileId, '1001')
    const sent = f.calls.find(call => call.path === '/appraisal/' + stage && call.method === 'POST')
    assert.deepEqual(sent.body, { appraisalId: 301, fileId: '1001' })
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/signature/getFront')).query, { fromWhere: 'performance' })
    assert.ok(result.result.flow.flowInfo.some(node => node.stage === stage && String(node.fileVO?.id) === '1001'))
  }
})
test('performance signature ownership, changed file selection and missing persisted signature cannot masquerade as successful acknowledgement', async () => {
  for (const [options, input, code] of [[{ foreignSignature: true }, { useLastSignature: true }, 'FORBIDDEN'], [{}, { signatureFileId: '1002' }, 'CONTEXT_CONFLICT']]) {
    const f = fixture({ stage: 'contentAcknowledgement', assessment: { isContentSignature: true }, ...options })
    await assert.rejects(run('assessments acknowledge-content', { appraisalId: '301', ...input }, f), { code }); assert.equal(writes(f).length, 0)
  }
  const f = fixture({ stage: 'contentAcknowledgement', assessment: { isContentSignature: true }, ignoreSignature: true })
  await assert.rejects(run('assessments acknowledge-content', { appraisalId: '301', useLastSignature: true }, f), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(writes(f).length, 1)
  const noSignature = fixture({ stage: 'contentAcknowledgement' })
  await assert.rejects(run('assessments acknowledge-content', { appraisalId: '301', useLastSignature: true }, noSignature), { code: 'INVALID_INPUT' }); assert.equal(writes(noSignature).length, 0)
})
