import assert from 'node:assert/strict'
import test from 'node:test'
import { replayPeriod, replayTextDelta, replayScoreDigest, replayIntelligenceEnabled, prepareReplay, verifyReplay } from '../dist/replay.js'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
const session = { version: 1, method: 'password', accessToken: 'fixture', expiresAt: Date.now() + 3600000, identity: { userId: '1001', teamId: '100', username: 'fixture' } }
const ctx = { environment: 'production', profile: 'fixture' }
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const run = (command, input, transport, approved = false, dryRun = false) => runWorkflow(ctx, workflows.workflows.find(flow => flow.command === command), input, session, { transport, approved, dryRun })
const collection = () => ({ id: 7001, name: 'periodic', type: 'day', template: { id: 8001 }, writeWeekDays: [1, 2, 3, 4, 5, 6, 7], ruleList: [],
  isOpenCommitDeadline: false, isOpenWriteEarliestTime: false, isOpenCommitNotifyTime: false, isOpenWorkStatus: false,
  isAllowAddViewer: false, isAllowShare: false, isAllowAfterCommitRevert: true, isAllowAfterRefuseCommit: true, isAllowSupplement: true })
const report = () => ({ id: 9001, name: '2026-11-07复盘', replayCollectId: 7001, type: 'day', year: 2026, month: 11, day: 7, status: 'uncommitted', writer: { id: 1001 },
  editControl: { edit: true }, auditorList: [{ id: 1001 }, { id: 1002 }], auditType: 'all', isThumbsUp: false,
  componentList: [{ id: 9101, replayCollectTemplateComponentId: 8101, name: '结果', type: 'question', isRequired: true,
    questionAnswer: { templateAnswer: '', answer: '{"ops":[{"insert":"已完成验收\\n"}]}' } },
  { id: 9102, replayCollectTemplateComponentId: 8102, name: '次项', type: 'question', isRequired: false, questionAnswer: { templateAnswer: '', answer: 'unchanged' } }] })

test('replay uses calendar dates, one-day Monday weeks, month boundaries and full text Delta', () => {
  assert.deepEqual(replayPeriod('day', '2024-02-29'), { year: 2024, month: 2, day: 29 })
  assert.deepEqual(replayPeriod('month', '2026-01-31'), { year: 2026, month: 1 })
  assert.deepEqual(replayPeriod('week', '2025-12-29'), { year: 2026, week: 1 })
  assert.deepEqual(replayPeriod('week', '2021-01-01'), { year: 2021, week: 1 })
  assert.deepEqual(replayPeriod('week', '2021-01-04'), { year: 2021, week: 2 })
  assert.throws(() => replayPeriod('day', '2026-02-29'), { code: 'INVALID_INPUT' })
  assert.throws(() => replayPeriod('topic', '2026-11-07'), { code: 'INVALID_INPUT' })
  assert.deepEqual(JSON.parse(replayTextDelta('中文\r\n"引用"')), { ops: [{ insert: '中文\n"引用"\n' }] })
  assert.deepEqual(JSON.parse(replayTextDelta('')), { ops: [{ insert: '\n' }] })
})

test('template rename and question patch preserve unrelated imported fields, IDs and component order', async () => {
  let saved = { id: '9223372036854775801', name: 'original', componentList: [
    { id: 8101, type: 'question', name: '原问题', isRequired: true, displayOrder: 1, answer: '{"ops":[{"insert":"默认\\n"}]}', placeholder: '', isOpenInsertTask: true, isOpenInsertFlowStep: false },
    { id: 8102, type: 'importTask', name: '行动', isRequired: false, displayOrder: 2, importTaskFieldList: [{ id: '9223372036854775802', name: '任务内容', type: 'text', isOpen: false, isCustom: true }] },
  ] }
  const before = structuredClone(saved), writes = []
  const transport = async (_url, init) => {
    if (init.method === 'GET') return json(saved)
    const body = JSON.parse(init.body); writes.push(body)
    assert.equal(body.id, before.id); assert.equal(body.componentList.length, 2)
    assert.equal(body.componentList[1].importTaskFieldList[0].id, '9223372036854775802')
    assert.equal(body.componentList[1].importTaskFieldList[0].isOpen, false)
    saved = { ...body, componentList: body.componentList.map((c, i) => ({ ...c, displayOrder: i + 1 })) }; return new Response(null, { status: 200 })
  }
  const templateId = before.id
  await run('replay template rename', { templateId, name: 'new' }, transport, true)
  assert.equal(saved.name, 'new'); assert.deepEqual(writes[0].componentList[0].answer, before.componentList[0].answer)
  await run('replay template question update', { templateId, componentId: '8101', patch: { text: '', required: false } }, transport, true)
  assert.equal(saved.componentList[0].isRequired, false)
  assert.deepEqual(JSON.parse(saved.componentList[0].answer), { ops: [{ insert: '\n' }] })
  assert.equal(saved.componentList[0].isOpenInsertTask, true)
  const noOp = await run('replay template rename', { templateId, name: 'new' }, transport, true)
  assert.deepEqual(noOp.skippedSteps, ['changed']); assert.equal(writes.length, 2)
})

test('template additions use ID-set discovery and reject cross-template operations and incomplete orders', () => {
  const input = { templateId: '8001', name: 'new', required: false }, template = { id: 8001, name: 't', componentList: [{ id: 8101, type: 'file', name: '保留附件', isRequired: true }] }
  const results = { template }
  const body = prepareReplay('replay-template-question-add', input, results, session).body
  assert.deepEqual(body.componentList[0], { id: '8101', type: 'file', name: '保留附件', isRequired: true })
  results.verified = { id: 8001, name: 't', componentList: [template.componentList[0], { ...body.componentList[1], id: 8100 }] }
  verifyReplay(input, results, 'verified')
  assert.equal(results.replayExpected.addedComponentId, '8100')
  assert.throws(() => prepareReplay('replay-template-component-remove', { ...input, componentId: '9900' }, { template }, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareReplay('replay-template-reorder', { ...input, componentIds: [] }, { template }, session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareReplay('replay-template-remove', input, { template, collections: [{ id: 7001 }], collectionDetails: [{ id: 7001, template: { id: 8001 } }] }, session), { code: 'RESOURCE_IN_USE' })
})

test('cyclic report creation converts virtual context once, checks period and prevents duplicate creation', async () => {
  let value = { ...report(), id: null }, creations = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/collect')) return json(collection())
    if (init.method === 'PUT') {
      assert.deepEqual(JSON.parse(init.body), { replayCollectId: '7001', year: 2026, month: 11, day: 7 }); creations++
      value.id = 9001; return json(value)
    }
    return json(value)
  }
  const input = { collectionId: '7001', date: '2026-11-07' }
  const created = await run('replay report create', input, transport)
  assert.equal(created.resources.replayId, '9001'); assert.equal(creations, 1)
  await assert.rejects(run('replay report create', input, transport), { code: 'CONTEXT_CONFLICT' }); assert.equal(creations, 1)
  value.month = 12
  await assert.rejects(run('replay report context', input, transport), { code: 'CONTEXT_CONFLICT' })
})

test('collection creation supplies disabled time configurations required by the actual service and preserves renamed times', () => {
  const input = { name: 'own', type: 'month', templateId: '8001' }, results = { template: { id: 8001, name: 't', componentList: [] }, directory: [{ id: '100', name: 'company', type: 'top', userList: [{ id: '1001', showName: 'Me' }], leaderList: [], childList: [] }] }
  const body = prepareReplay('replay-collection-create', input, results, session).body
  assert.equal(body.isOpenCommitDeadline, false); assert.equal(body.isOpenCommitNotifyTime, false); assert.equal(body.isOpenWriteEarliestTime, false)
  assert.deepEqual(body.writeEarliestTime, { dateType: 'now', date: '1', time: '09:00' })
  assert.deepEqual(body.commitDeadline, { dateType: 'now', date: 'last', time: '18:30' })
  assert.deepEqual(body.commitNotifyTime, { dateType: 'now', date: 'last', time: '18:00' })
  const current = { ...collection(), type: 'month', writeWeekDays: null, writeEarliestTime: body.writeEarliestTime, commitDeadline: body.commitDeadline, commitNotifyTime: body.commitNotifyTime }
  const renamed = prepareReplay('replay-collection-rename', { collectionId: '7001', name: 'new' }, { collection: current }, session).body
  assert.deepEqual(renamed.commitDeadline, body.commitDeadline); assert.equal(renamed.commitDeadline.timeString, undefined)
  assert.equal(Object.hasOwn(renamed, 'writeWeekDayList'), false)
})

test('question replacement retains other answers, supports empty clearing and respects writer/edit constraints', async () => {
  let value = report(), writes = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/collect')) return json(collection())
    if (init.method === 'PUT') {
      writes++; const body = JSON.parse(init.body)
      assert.equal(body.replayCollectTemplateComponentId, '8101'); assert.equal(body.replayCollectId, '7001')
      value.componentList[0].questionAnswer.answer = body.answer; return json(value)
    }
    return json(value)
  }
  const input = { collectionId: '7001', date: '2026-11-07', componentId: '8101', text: '' }
  await run('replay report question set', input, transport)
  assert.equal(value.componentList[1].questionAnswer.answer, 'unchanged'); assert.equal(writes, 1)
  await run('replay report question set', input, transport); assert.equal(writes, 1)
  value.editControl.edit = false
  await assert.rejects(run('replay report question set', { ...input, text: 'next' }, transport), { code: 'PERMISSION_DENIED' })
  assert.equal(writes, 1)
})

test('day, week and month questions serialize rich content exactly once and independently read it back', async () => {
  const content = { ops: [{ insert: '本期成果', attributes: { bold: true } }, { insert: '\n', attributes: { header: 2 } }, { insert: '第二段。\n' }] }
  for (const type of ['day', 'week', 'month']) {
    const period = replayPeriod(type, '2026-11-07'), collect = { ...collection(), type }
    const value = { ...report(), type, ...period }
    let writes = 0, reads = 0, expectedContent = content
    const transport = async (url, init) => {
      if (url.pathname.endsWith('/collect')) return json(collect)
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body); writes++
        assert.deepEqual(body, { replayCollectId: '7001', ...period, replayCollectTemplateComponentId: '8101', answer: JSON.stringify(expectedContent) })
        value.componentList[0].questionAnswer.answer = body.answer
        return json(value)
      }
      reads++; return json(value)
    }
    const input = { collectionId: '7001', date: '2026-11-07', componentId: '8101', content }
    const result = await run('replay report question set', input, transport)
    assert.deepEqual(JSON.parse(result.result.componentList[0].questionAnswer.answer), content)
    assert.equal(result.result.componentList[1].questionAnswer.answer, 'unchanged')
    assert.equal(writes, 1); assert.equal(reads, 2)
    await run('replay report question set', input, transport)
    assert.equal(writes, 1)
    expectedContent = { ops: [] }
    await run('replay report question set', { ...input, content: { ops: [] } }, transport)
    assert.equal(value.componentList[0].questionAnswer.answer, '{"ops":[]}')
  }
})

test('invalid or ambiguous question content is rejected offline before context reads or writes', async () => {
  let calls = 0
  const transport = async () => { calls++; throw Error('invalid content reached the network') }
  const base = { collectionId: '7001', date: '2026-11-07', componentId: '8101' }
  for (const patch of [{}, { text: 'text', content: { ops: [] } }, { content: { content: 'wrong shape' } }, { content: 'serialized' }, { content: [{ insert: 'array' }] }, { content: { ops: [{ retain: 1 }] } }, { content: { ops: [{ insert: { a: 1, b: 2 } }] } }, { content: JSON.parse('{"ops":[{"insert":"x","attributes":{"constructor":{}}}]}') }]) {
    for (const dryRun of [false, true]) await assert.rejects(run('replay report question set', { ...base, ...patch }, transport, false, dryRun), { code: 'INVALID_INPUT' })
  }
  assert.equal(calls, 0)
})

test('successful write receipts cannot hide missing question content in the independent readback', async () => {
  let writes = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/collect')) return json(collection())
    if (init.method === 'PUT') { writes++; return json({ ...report(), componentList: [{ ...report().componentList[0], questionAnswer: { answer: JSON.parse(init.body).answer } }] }) }
    return json(report())
  }
  await assert.rejects(run('replay report question set', { collectionId: '7001', date: '2026-11-07', componentId: '8101', content: { ops: [{ insert: 'new body\n' }] } }, transport), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(writes, 1)
})

test('approval confirms new audit record without claiming overall terminal state for multiple auditors', async () => {
  const value = { ...report(), status: 'committed', editControl: { edit: false } }, records = []
  let writes = 0
  const transport = async (url, init) => {
    if (url.pathname.endsWith('/collect')) return json(collection())
    if (url.pathname.endsWith('/record/list')) return json(records)
    if (init.method === 'PUT') { writes++; assert.deepEqual(JSON.parse(init.body), { id: '9001', status: 'audited' }); records.push({ id: 9301, type: 3 }); return json(value) }
    return json(value)
  }
  const result = await run('replay report approve', { replayId: '9001' }, transport, true)
  assert.equal(result.result.report.status, 'committed'); assert.equal(writes, 1)
  value.auditorList = [{ id: 1002 }]
  await assert.rejects(run('replay report approve', { replayId: '9001' }, transport, true), { code: 'PERMISSION_DENIED' }); assert.equal(writes, 1)
  value.auditorList = [{ id: 1001 }]
  await assert.rejects(run('replay report approve', { replayId: '9001' }, transport, true), { code: 'BUSINESS_ASSERTION_FAILED' })
})

test('submission blocks incomplete content and AI context instead of bypassing current UI requirements', () => {
  const input = { replayId: '9001' }, results = { collection: collection(), report: report(), records: [], intelligence: { inWhitelist: false }, companyPermissions: { replayIntelligence: true } }
  assert.deepEqual(prepareReplay('replay-submit', input, results, session), { body: { id: '9001', status: 'committed' } })
  results.intelligence.inWhitelist = true
  assert.throws(() => prepareReplay('replay-submit', input, results, session), { code: 'AI_SCORE_CONTEXT_REQUIRED' })
  results.intelligence.inWhitelist = false; results.report.componentList[0].questionAnswer.answer = JSON.stringify({ ops: [{ insert: '\n' }] })
  assert.throws(() => prepareReplay('replay-submit', input, results, session), { code: 'INVALID_INPUT' })
})

test('AI score context follows current editor content and receipt becomes invalid when answers change', async () => {
  const value = report(), collect = collection(), score = { scoreId: 'fixture-score', replayId: 9001, totalScore: 75, grade: 'pass', status: 'success', generatedAt: '2026-11-07T00:00:00Z', dimensions: [{ key: 'completeness', name: '描述完整性', score: 75 }], suggestions: [] }
  let evaluations = 0
  const transport = async (url, init) => {
    if (url.pathname === '/task/authority/v3/authorities/company/current') return json({ replayIntelligence: true })
    if (url.pathname.endsWith('/collect')) return json(collect)
    if (url.pathname.endsWith('/whitelist')) return json({ inWhitelist: true })
    if (url.pathname.endsWith('/evaluate')) {
      evaluations++; const body = JSON.parse(init.body)
      assert.equal(body.replayId, 9001); assert.equal(body.writerId, 1001); assert.equal(body.replayCollectName, 'periodic')
      assert.equal(body.componentList[0].answer, value.componentList[0].questionAnswer.answer)
      assert.equal(body.replayDetail.collectData.id, 7001); return json(score)
    }
    return json(value)
  }
  const evaluated = await run('replay report score evaluate', { replayId: '9001' }, transport, true)
  assert.equal(evaluations, 1); assert.equal(evaluated.resources.scoreId, 'fixture-score')
  const input = { replayId: '9001', scoreReceipt: evaluated.result.receipt }, results = { collection: collect, report: value, intelligence: { inWhitelist: true }, companyPermissions: { replayIntelligence: true }, score, records: [] }
  assert.equal(input.scoreReceipt.contextDigest, replayScoreDigest(value, collect))
  assert.deepEqual(prepareReplay('replay-score-context', input, results, session), { query: { scoreId: 'fixture-score' } })
  assert.deepEqual(prepareReplay('replay-submit', input, results, session), { body: { id: '9001', status: 'committed' } })
  value.componentList[0].questionAnswer.answer = replayTextDelta('已修改内容')
  assert.throws(() => prepareReplay('replay-score-context', input, results, session), { code: 'AI_SCORE_CONTEXT_REQUIRED' })
  assert.throws(() => prepareReplay('replay-submit', input, results, session), { code: 'AI_SCORE_CONTEXT_REQUIRED' })
})

test('replay scoring requires both whitelist and permission in the selected application, without alternate permission fallback', async () => {
  for (const whitelist of [false, true]) for (const permission of [false, true]) {
    const results = { intelligence: { inWhitelist: whitelist }, companyPermissions: { replayIntelligence: permission }, okrPermissions: { replayIntelligence: !permission } }
    assert.equal(replayIntelligenceEnabled({}, results), whitelist && permission)
    assert.equal(replayIntelligenceEnabled({ application: 'okr' }, results), whitelist && !permission)
  }
  assert.throws(() => replayIntelligenceEnabled({}, { intelligence: { inWhitelist: true }, okrPermissions: { replayIntelligence: true } }), { code: 'CONTEXT_MISSING' })
  const paths = []
  const transport = async url => { paths.push(url.pathname); return json(url.pathname.endsWith('/whitelist') ? { inWhitelist: true } : { replayIntelligence: false, useReplay: true }) }
  const normal = await run('replay permissions', {}, transport)
  assert.equal(normal.result.scoreBeforeSubmit, false); assert.equal(normal.result.application, 'rishiqing')
  assert.deepEqual(normal.skippedSteps, ['okrPermissions']); assert.ok(!paths.some(path => path.startsWith('/task/okr/')))
  paths.length = 0
  const standalone = await run('replay permissions', { application: 'okr' }, transport)
  assert.deepEqual(standalone.skippedSteps, ['companyPermissions']); assert.ok(!paths.some(path => path.startsWith('/task/authority/')))
  const value = report(), results = { report: value, collection: collection(), records: [], intelligence: { inWhitelist: true }, companyPermissions: { replayIntelligence: false } }
  assert.deepEqual(prepareReplay('replay-submit', { replayId: '9001' }, results, session), { body: { id: '9001', status: 'committed' } })
  assert.equal(prepareReplay('replay-score-context', { replayId: '9001' }, results, session), null)
  assert.throws(() => prepareReplay('replay-score-evaluate', { replayId: '9001' }, results, session), { code: 'PERMISSION_DENIED' })
})

test('replay offline dry-run, confirmation and unknown outcomes prevent accidental or duplicate writes', async () => {
  let calls = 0, writes = 0
  const transport = async (_url, init) => { calls++; if (init.method === 'PUT') { writes++; throw Error('lost after dispatch') } return json(collection()) }
  assert.equal((await run('replay report create', { collectionId: '7001', date: '2026-11-07' }, transport, false, true)).dryRun, true)
  assert.equal(calls, 0)
  await assert.rejects(run('replay report approve', { replayId: '9001' }, transport), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(calls, 0)
  await assert.rejects(run('replay collection rename', { collectionId: '7001', name: 'new' }, transport), error => {
    assert.equal(error.details.writeOutcome, 'unknown'); assert.deepEqual(error.details.completedSteps, ['collection']); return true
  }); assert.equal(writes, 1)
  for (const [method, route] of [['GET', '/task/review/replay'], ['GET', '/task/review/replay/component/okr/list/latest'], ['GET', '/task/review/replay/component/task/import/list/latest']]) assert.equal(catalog.operations.find(op => op.method === method && op.route === route).effect, 'write')
})
