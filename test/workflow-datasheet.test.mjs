import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeWorkflow, executeOperation } from '../dist/dispatch.js'
import { workflowDatasheetPack, validateWorkflowDatasheetWorkflow, workflowDatasheetDefinition } from '../dist/workflow-datasheet.js'
const ctx = { environment: 'production', profile: 'fixture' }, jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure', 'https://www.rishiqing.com')
const session = { version: 1, method: 'password', accessToken: 'fixture', cookies: jar.serializeSync(), identity: { userId: '81', teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }
const input = { processId: '8101', stepId: '8201', fieldId: '8301' }, prefix = '/task/workflow/process-info/8101/fields/8301/datasheet-modify/'
test('definition excludes derived display data materialized by pack but retains every actual target and required setting', () => {
 const a = definition(), b = definition(); b.value = 'materialized-record-ids'; b.datasheetLinkVO.linkContentFieldData = { value: 'materialized-record-ids' }
 assert.deepEqual(workflowDatasheetDefinition(a), workflowDatasheetDefinition(b))
 for (const key of ['projectId', 'datasheetId', 'linkType', 'isAddDatasheetData', 'isAddMultiDatasheetData', 'isShowField', 'datasheetFieldIdList', 'requiredFieldIds']) { const changed = definition(); changed.datasheetLinkVO[key] = 'changed'; assert.notDeepEqual(workflowDatasheetDefinition(a), workflowDatasheetDefinition(changed)) }
})
const definition = () => ({ id: '8301', name: '填表', type: 45, isRequired: true, isHidden: false, datasheetLinkVO: { projectId: '8401', datasheetId: 'dstSource', isAddMultiDatasheetData: true, isShowField: false, isAddDatasheetData: true, datasheetFieldIdList: [], requiredFieldIds: [], linkType: 3 } })
const pack = () => ({ config: { datasheetId: 'dsm_workflow_8301', linkDatasheetId: 'dstSource', projectId: '8401', multipleRecord: true, customField: false, customFieldIds: [], requiredFieldIds: [], canAddRecord: true, linkType: 3 }, value: { recordIds: ['recFirst', 'recSecond'] }, target: { projectId: '8401', datasheetId: 'dstSource', datasheetName: '表' }, snapshot: { datasheetId: 'dsm_workflow_8301', meta: { fieldMap: { fldText: { id: 'fldText', type: 2, name: '名称' }, fldNumber: { id: 'fldNumber', type: 1, name: '数量' }, fldCheck: { id: 'fldCheck', type: 10, name: '完成' }, fldChoice: { id: 'fldChoice', type: 7, name: '阶段', attr: { optionList: [{ id: 'optReady', name: '准备' }] } } }, views: [{ columns: [{ fieldId: 'fldText' }, { fieldId: 'fldNumber' }, { fieldId: 'fldCheck' }, { fieldId: 'fldChoice' }], rows: [{ recordId: 'recFirst' }, { recordId: 'recSecond' }] }] }, recordMap: { recFirst: { id: 'recFirst', data: { fldText: [{ type: 1, text: '第一行' }], fldNumber: 3 } }, recSecond: { id: 'recSecond', data: { fldText: [{ type: 1, text: '第二行' }] } } } }, permissions: { canAddRecord: true, canEditRecord: true, canDeleteRecord: true }, readonlyFieldIds: [], missingFieldIds: [] })
const flow = (suffix, project = false) => { const value = workflows.workflows.find(row => row.command === (project ? 'project ' : '') + 'workflow datasheet ' + suffix); assert.ok(value); return value }
function fixture(options = {}) {
 const calls = [], writes = [], field = definition(), draft = pack(); let packs = 0, forms = 0, permissions = 0
 if (options.single) { field.datasheetLinkVO.isAddMultiDatasheetData = false; draft.config.multipleRecord = false }
 if (options.readonly) draft.readonlyFieldIds = ['fldNumber']
 if (options.missing) draft.missingFieldIds = ['fldNumber']
 if (options.noEdit) draft.permissions.canEditRecord = false
 if (options.noAdd) draft.permissions.canAddRecord = false
 if (options.noDelete) draft.permissions.canDeleteRecord = false
 if (options.custom) { Object.assign(field.datasheetLinkVO, { isShowField: true, datasheetFieldIdList: ['fldText'] }); Object.assign(draft.config, { customField: true, customFieldIds: ['fldText'] }) }
 if (options.fieldType) field.type = options.fieldType
 if (options.hidden) field.isHidden = true
 if (options.computed) draft.snapshot.meta.fieldMap.fldNumber.type = 16
 const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
 const wf = value => json({ code: 200, data: value })
 const transport = async (url, init) => {
  const path = url.pathname, body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ path, method: init.method, body, query: Object.fromEntries(url.searchParams) })
  if (path.endsWith('/authAjax')) return json({ success: true, id: '81', username: 'fixture', team: { id: options.identity ? '8' : '7', name: 'fixture' }, token: 'fixture' })
  if (path.endsWith('/member/state/independent')) return json({ vt: 'fixture', deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00', usersCount: 1, userLimit: options.capacity ? 0 : 2, mainApp: 'rsq' })
  if (path.endsWith('/function/available')) return json(options.features ?? [])
  if (path.endsWith('/authorities/company/current')) { permissions++; return json(options.companyPermissions ?? { useFlow: true, useKanban: true }) }
  if (path.endsWith('/process/info/details')) return wf({ id: '8101', flowAppId: '8001', status: 'doing', belongToProjectId: options.project ? '8501' : null, processInfoStepList: [{ id: '8201' }] })
  if (path.endsWith('/process/info/step')) return wf({ id: '8201', applicationId: '8001', processInfoId: options.wrongStep ? '8999' : '8101', formId: '8601', status: 'doing' })
  if (path.endsWith('/auditsAndForms')) { forms++; return wf({ formId: '8601', editControl: { fillStepForm: options.noFormEdit ? false : !(options.revoked && forms > 1) }, fields: [{ ...field, ...(options.drift && forms > 1 ? { name: 'concurrent configuration' } : {}) }] }) }
  if (path.endsWith('/workflow/application')) return wf({ id: '8001', workflowModuleSubType: options.project ? 'projectWorkflow' : options.ambiguous ? 'projectWorkflow' : null })
  if (path.endsWith('/kanbanCrud')) return json({ id: '8501', coverId: options.template ? '8901' : null })
  if (path === prefix + 'pack') { packs++; return wf(structuredClone(draft)) }
  if (path.startsWith(prefix) && init.method !== 'GET') {
   writes.push({ path, method: init.method, body }); if (options.timeout) throw new TypeError('simulated lost response')
   if (path === prefix + 'records') {
    draft.value.recordIds.splice(body.index, 0, body.recordId); draft.snapshot.recordMap[body.recordId] = { id: body.recordId, data: {} }; draft.snapshot.meta.views[0].rows.splice(body.index, 0, { recordId: body.recordId })
    return wf({ recordId: body.recordId, index: body.index })
   }
   if (path === prefix + 'records/delete') {
    draft.value.recordIds = draft.value.recordIds.filter(key => !body.recordIds.includes(key)); draft.snapshot.meta.views[0].rows = draft.snapshot.meta.views[0].rows.filter(row => !body.recordIds.includes(row.recordId)); for (const key of body.recordIds) delete draft.snapshot.recordMap[key]
    return wf({ recordIds: body.recordIds })
   }
   if (path === prefix + 'validate') return wf({ valid: false, message: '必填字段未完成', errors: [{ recordId: 'recFirst', fieldId: 'fldText', reason: 'REQUIRED', message: '必填' }], eligibleRecordIds: [], skippedRecordIds: ['recFirst'] })
   const match = /\/records\/([^/]+)\/fields\/([^/]+)$/.exec(path); assert.ok(match)
   if (!options.lostReadback) draft.snapshot.recordMap[match[1]].data[match[2]] = body.value
   if (options.overwriteOther) draft.snapshot.recordMap.recSecond.data.fldText = null
   return wf({ recordId: match[1], fieldId: match[2], value: body.value })
  }
  throw Error('Unexpected ' + init.method + ' ' + path)
 }
 return { calls, writes, draft, field, transport, get packs() { return packs } }
}
const run = (suffix, args, f, project = false, options = {}) => executeWorkflow(ctx, flow(suffix, project), { ...input, ...(project && { projectId: '8501' }), ...args }, session, { approved: true, transport: f.transport, ...options })
test('pack binds actual target, configured field scope, ordered internal IDs and complete snapshot', () => {
 const d = pack(), f = definition(); assert.deepEqual(workflowDatasheetPack(d, f).recordIds, ['recFirst', 'recSecond'])
 for (const mutate of [d => { d.target.datasheetId = 'dstOther' }, d => { d.config.linkType = 1 }, d => { d.snapshot.meta.views[0].rows.reverse() }, d => { delete d.snapshot.recordMap.recSecond }, d => { d.config.customFieldIds = ['fldNumber'] }, d => { delete d.permissions.canEditRecord }, d => { d.snapshot.meta.views[0].columns.push({ fieldId: 'fldUnknown' }) }]) { const invalid = pack(); mutate(invalid); assert.throws(() => workflowDatasheetPack(invalid, f)) }
})
test('independent and project inspect discover live field types and disclose draft-side effects', async () => {
 for (const project of [false, true]) { const f = fixture({ project }), result = await run('inspect', {}, f, project); assert.equal(result.result.proofScope, 'workflow-draft-only'); assert.equal(result.result.targetSynchronizationVerified, false); assert.equal(result.result.snapshot.meta.fieldMap.fldNumber.type, 1); assert.equal(f.writes.length, 0); assert.equal(f.packs, 1) }
})
test('zero, false, explicit null and actual option names survive independent cell readback', async () => {
 for (const [targetFieldId, value, encoded] of [['fldNumber', 0, 0], ['fldCheck', false, false], ['fldText', null, null], ['fldChoice', '准备', ['optReady']]]) {
  const f = fixture(), out = await run('cell set', { recordId: 'recFirst', targetFieldId, value }, f)
  assert.deepEqual(f.writes[0].body, { stepInfoId: '8201', value: encoded }); assert.equal(f.writes.length, 1); assert.equal(f.packs, 3); assert.deepEqual(out.result.value, encoded); assert.equal(out.result.proof.independentlyReadBack, true); assert.equal(out.result.proof.targetSynchronizationVerified, false)
 }
})
test('actual readonly, missing, computed, hidden, custom-scope and invalid option fields stop before PUT', async () => {
 for (const options of [{ readonly: true }, { missing: true }, { computed: true }, { hidden: true }, { custom: true }, { noEdit: true }, { fieldType: 35 }]) { const f = fixture(options); await assert.rejects(run('cell set', { recordId: 'recFirst', targetFieldId: 'fldNumber', value: 0 }, f)); assert.equal(f.writes.length, 0) }
 const f = fixture(); await assert.rejects(run('cell set', { recordId: 'recFirst', targetFieldId: 'fldChoice', value: 'not-an-option' }, f)); assert.equal(f.writes.length, 0)
})
test('new internal record is inserted at actual position and other records stay intact', async () => {
 const f = fixture(), result = await run('record add', { recordId: 'recNew', index: 1 }, f)
 assert.deepEqual(result.result.recordIds, ['recFirst', 'recNew', 'recSecond']); assert.equal(f.writes.length, 1); assert.equal(result.resources.recordId, 'recNew')
 for (const [options, args] of [[{ single: true }, {}], [{ noAdd: true }, {}], [{}, { index: 3 }], [{}, { recordId: 'recFirst' }]]) { const f = fixture(options); await assert.rejects(run('record add', args, f)); assert.equal(f.writes.length, 0) }
})
test('remove checks exact remaining order and never claims source rows have been deleted', async () => {
 const f = fixture(), result = await run('record remove', { recordIds: ['recFirst'] }, f)
 assert.deepEqual(result.result.recordIds, ['recSecond']); assert.equal(result.result.proof.sourceRecordsDeleted, false); assert.equal(result.result.proof.stepSubmitted, false)
 for (const [options, recordIds] of [[{ noDelete: true }, ['recFirst']], [{}, ['recUnknown']], [{}, ['recFirst', 'recFirst']]]) { const f = fixture(options); await assert.rejects(run('record remove', { recordIds }, f)); assert.equal(f.writes.length, 0) }
})
test('validate uses current field-required flag and returns structured errors without declaring synchronization', async () => {
 const f = fixture(), out = await run('validate', {}, f); assert.deepEqual(f.writes[0].body, { stepInfoId: '8201', requireRecord: true }); assert.equal(out.result.validation.valid, false); assert.equal(out.result.validation.errors[0].recordId, 'recFirst'); assert.equal(out.result.stepSubmitted, false)
 const invalid = fixture(); await assert.rejects(run('validate', { requireRecord: false }, invalid), { code: 'INVALID_INPUT' }); assert.equal(invalid.calls.length, 0)
})
test('company expiry, capacity, feature and identity restrictions prevent field writes', async () => {
 for (const [options, code] of [[{ expired: true }, 'COMPANY_EXPIRED'], [{ capacity: true }, 'COMPANY_OVER_CAPACITY'], [{ features: [{ funcName: 'PLAN_DATASHEET', status: 'disable' }] }, 'FEATURE_DISABLED'], [{ identity: true }, 'IDENTITY_CHANGED'], [{ noFormEdit: true }, 'FORBIDDEN']]) { const f = fixture(options); await assert.rejects(run('record add', {}, f), { code }); assert.equal(f.writes.length, 0) }
 const f = fixture({ project: true, features: [{ funcName: 'WORKFLOW', status: 'disable' }] }); await run('inspect', {}, f, true)
 const missingProjectGrant = fixture({ project: true, features: [{ funcName: 'PLAN_WORKFLOW', status: 'disable' }] }); await assert.rejects(run('inspect', {}, missingProjectGrant, true), { code: 'FEATURE_DISABLED' })
})
test('resource affiliation, current step and application type cannot be changed by choosing another command', async () => {
 for (const [options, project] of [[{ project: true }, false], [{ ambiguous: true }, false], [{}, true], [{ project: true, template: true }, true], [{ wrongStep: true }, false]]) { const f = fixture(options); await assert.rejects(run('record add', {}, f, project)); assert.equal(f.writes.length, 0) }
})
test('stale preview, definition drift and revoked edit permission reject before mutation', async () => {
 for (const [options, args] of [[{}, { contextVersion: '0'.repeat(64) }], [{ drift: true }, {}], [{ revoked: true }, {}]]) { const f = fixture(options); await assert.rejects(run('record add', args, f)); assert.equal(f.writes.length, 0) }
})
test('unknown write, lost readback and unrelated overwrites retain resource IDs with no replay', async () => {
 for (const options of [{ timeout: true }, { lostReadback: true }, { overwriteOther: true }]) {
  const f = fixture(options); await assert.rejects(run('cell set', { recordId: 'recFirst', targetFieldId: 'fldNumber', value: 0 }, f), error => { assert.equal(error.details.resources.recordId, 'recFirst'); assert.equal(error.details.resources.target.datasheetId, 'dstSource'); assert.equal(error.details.automaticallyRetried, false); assert.equal(error.details.writeOutcome, options.timeout ? 'unknown' : 'accepted-needs-verification'); return true }); assert.equal(f.writes.length, 1)
 }
})
test('offline plans, confirmation, raw context guards and altered routes cannot bypass preflight', async () => {
 const f = fixture(), selected = flow('record add')
 assert.equal((await runWorkflow(ctx, selected, input, null, { dryRun: true, transport: f.transport })).dryRun, true)
 await assert.rejects(executeWorkflow(ctx, selected, input, session, { transport: f.transport }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0)
 const changed = structuredClone(selected); changed.steps.reverse(); assert.throws(() => validateWorkflowDatasheetWorkflow(changed), { code: 'INVALID_CONTRACT' })
 const op = catalog.operations.find(row => row.method === 'POST' && row.route.endsWith('/datasheet-modify/records'))
 await assert.rejects(executeOperation(ctx, op, { path: { processInfoId: '8101', fieldId: '8301' }, body: { stepInfoId: '8201', recordId: 'recNew', index: 0 } }, session, { approved: true, transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' }); assert.equal(f.calls.length, 0)
})
