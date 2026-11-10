import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflows, runWorkflow } from '../dist/workflows.js'
import { prepareCollectionFields, describeCollectionFields } from '../dist/project-collection-fields.js'
const userId = '9223372036854775801', collectionId = '7001', projectId = '9001'
const session = { version: 1, method: 'password', accessToken: 'fixture', identity: { userId, teamId: '7', username: 'fixture' }, expiresAt: Date.now() + 3600000 }, ctx = { environment: 'production', profile: 'fixture' }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const collection = { id: collectionId, name: 'fixture', color: '1', members: [{ userId, role: 'creator' }] }
const directory = [{ id: '10', name: 'company', type: 'top', parentId: null, displayOrder: 1, userList: [{ id: userId }, { id: '2' }], childList: [] }]
const fixed = () => [{ key: 'name', field: null, isCustomField: false, visible: true, name: '项目名称', displayOrder: 1 }, { key: 'currentState', field: null, isCustomField: false, visible: true, name: '状态', displayOrder: 2 }]
const field = (id, type = 1, patch = {}) => ({ key: null, isCustomField: true, visible: true, field: { id, name: 'field-' + id, type, placeholder: null, selector: null, isCheckBox: false, isRequired: false, isHidden: false, dataType: 1, dataType2: 1, decimalNum: 2, ...patch } })
function state(extra = [field('801')]) {
  const state = { headers: [...fixed(), ...extra], requests: [], values: extra.map(row => ({ id: row.field.id, type: row.field.type, name: row.field.name, value: null, date: null, time: null, editControl: { canEdit: true } })), counter: 802 }
  state.transport = async (url, init) => {
    state.requests.push({ path: url.pathname, method: init.method, body: init.body })
    if (url.pathname.endsWith('/kanbanCollection/list')) return json([collection])
    if (url.pathname === '/task/v3/kanbanCollection') return json(collection)
    if (url.pathname === '/task/v1/department/list') { assert.equal(url.searchParams.get('cliContext'), 'fresh'); return json(directory) }
    if (url.pathname.endsWith('/projectListHeader')) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body); assert.equal(body.id, collectionId)
        state.headers = body.fieldList.map((row, index) => {
          const previous = state.headers.find(before => before.field?.id === row.field?.id)?.field
          const placeholder = row.field?.placeholder === null ? previous?.placeholder ?? null : row.field?.placeholder
          return { ...row, name: row.field?.name ?? row.key, displayOrder: index + 1, ...(row.field && { field: { ...row.field, id: row.field.id ?? String(state.counter++), isHidden: !row.visible, placeholder: placeholder === '' ? null : placeholder, selector: row.field.selector?.map(option => ({ ...option, relation: option.relation ?? [] })) ?? null } }) }
        })
      }
      return json(state.headers)
    }
    if (url.pathname.endsWith('/collection/project/list')) return json([{ kanbanId: projectId, name: 'project', customFieldList: state.values }])
    if (url.pathname.endsWith('/collection/field/value')) {
      const body = JSON.parse(init.body), value = state.values.find(row => row.id === body.fieldId)
      assert.equal(body.projectId, projectId); assert.ok(value)
      if (value.type === 5) { value.date = body.value; value.time = body.time ?? null }
      else value.value = body.value === '' && [2, 22].includes(value.type) ? null : body.value
      return new Response('')
    }
    throw Error('Unexpected request ' + url.pathname)
  }
  return state
}
const run = (suffix, input, model, options = {}) => runWorkflow(ctx, workflows.workflows.find(f => f.command === 'project collection ' + suffix), { collectionId, ...input }, session, { transport: model.transport, approved: true, ...options })
const writes = model => model.requests.filter(row => !['GET', 'HEAD'].includes(row.method))
test('collection field context and dry-run expose real keys without sending offline requests', async () => {
  const model = state()
  const plan = await run('field create', { definition: { name: 'new', type: 'text' } }, model, { dryRun: true })
  assert.equal(plan.dryRun, true); assert.equal(model.requests.length, 0)
  const result = (await run('fields context', { projectId }, model)).result
  assert.match(result.contextVersion, /^[a-f0-9]{64}$/); assert.equal(result.values[0].id, '801'); assert.equal(result.supportedDefinitionTypes.member, 22)
  assert.equal(writes(model).length, 0)
})
test('field creation preserves other definitions and attachment defaults and records the new ID', async () => {
  const model = state([field('801', 6, { defaultFileList: [{ id: '6001' }] }), field('9007199254740993', 34, { queryQuoteVO: { quoteFrom: 'datasheet', filter: { unchanged: true } } })])
  const result = await run('field create', { definition: { name: 'new', type: 'text', defaultValue: 'default' } }, model)
  const body = JSON.parse(writes(model)[0].body)
  assert.equal(body.fieldList[2].field.extraInfo, '6001')
  assert.deepEqual(body.fieldList[3].field.queryQuoteVO, { quoteFrom: 'datasheet', filter: { unchanged: true } })
  assert.equal(body.fieldList[3].field.id, '9007199254740993'); assert.equal(result.resources.fieldId, '802')
  assert.equal(result.result.headers.length, 5); assert.equal(writes(model).length, 1)
})
test('fixed name protections, target disambiguation and stale versions stop before mutation', async () => {
  for (const [suffix, input] of [['headers visibility set', { key: 'name', visible: false }], ['headers move', { key: 'name', targetKey: 'currentState', position: 'after' }], ['headers move', { fieldId: '801', targetKey: 'name', position: 'before' }], ['field update', { fieldId: '801', patch: { name: 'renamed' }, expectedVersion: '0'.repeat(64) }]]) {
    const model = state(); await assert.rejects(run(suffix, input, model), error => ['INVALID_INPUT', 'CONTEXT_CONFLICT'].includes(error.code)); assert.equal(writes(model).length, 0)
  }
  const model = state()
  await assert.rejects(run('headers visibility set', { key: 'currentState', fieldId: '801', visible: false }, model), { code: 'INVALID_INPUT' }); assert.equal(model.requests.length, 0)
})
test('visibility and movement preserve all fields and independently verify exact order', async () => {
  const model = state()
  await run('headers visibility set', { fieldId: '801', visible: false }, model)
  assert.equal(model.headers.at(-1).field.isHidden, true)
  await run('headers move', { fieldId: '801', targetKey: 'currentState', position: 'before' }, model)
  assert.deepEqual(model.headers.map(row => row.key ?? row.field.id), ['name', '801', 'currentState'])
  assert.equal(model.headers[1].visible, false); assert.equal(writes(model).length, 2)
  await run('headers visibility set', { fieldId: '801', visible: true }, model)
  assert.equal(model.headers[1].field.isHidden, false)
})
test('selection config assigns client keys once and preserves option IDs through updates', async () => {
  const model = state([])
  const created = await run('field create', { definition: { name: 'status', type: 'dropdown', options: [{ name: 'A' }, { name: 'B' }], multiple: true } }, model)
  const actual = created.result.headers.at(-1).field, [a, b] = actual.selector
  assert.match(a.value, /^[1-9][0-9]*$/); assert.notEqual(a.value, b.value)
  await run('field update', { fieldId: actual.id, patch: { name: 'renamed', options: [{ name: 'B2', value: b.value }, { name: 'A', value: a.value }], defaultValue: b.value } }, model)
  assert.deepEqual(model.headers.at(-1).field.selector.map(option => option.value), [b.value, a.value])
  assert.equal(model.headers.at(-1).field.placeholder, b.value)
  assert.deepEqual(model.headers.at(-1).field.selector.map(option => option.relation), [[], []])
  const count = writes(model).length
  await assert.rejects(run('field update', { fieldId: actual.id, patch: { options: [{ name: 'A', value: a.value }] } }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, count)
  await run('field update', { fieldId: actual.id, patch: { defaultValue: '', options: [{ name: 'A', value: a.value }] } }, model)
  assert.equal(model.headers.at(-1).field.placeholder, null)
})
test('field removal protects cross-option dependencies instead of silently deleting relations', () => {
  const list = [...fixed(), field('801', 4, { selector: [{ name: 'A', value: '101' }] }), field('802', 4, { selector: [{ name: 'B', value: '102', relation: ['101'] }] })]
  assert.throws(() => prepareCollectionFields('collection-fields-remove', { collectionId, fieldId: '801' }, { collection, headers: list, preflight: list }, session), { code: 'DEPENDENCY_EXISTS' })
})
test('selection instance values use actual options, single cardinality and explicit clearing', async () => {
  const model = state([field('801', 4, { selector: [{ name: 'A', value: '101' }, { name: 'B', value: '102' }], placeholder: '101' })])
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: ['999'] }, model), { code: 'INVALID_INPUT' })
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: ['101', '102'] }, model), { code: 'INVALID_INPUT' })
  await run('field value set', { projectId, fieldId: '801', value: ['102'] }, model)
  await run('field value set', { projectId, fieldId: '801', value: null }, model)
  assert.equal(JSON.parse(writes(model).at(-1).body).value, ''); assert.equal(model.values[0].value, '')
})
test('numeric values preserve long decimals, encode readable zero and reject a missing persisted value without replay', async () => {
  const model = state([field('801', 2)])
  const value = '90071992547409931234567890.0123456789'
  await run('field value set', { projectId, fieldId: '801', value }, model)
  assert.equal(JSON.parse(writes(model)[0].body).value, value)
  await run('field value set', { projectId, fieldId: '801', value: '0' }, model)
  assert.equal(JSON.parse(writes(model)[1].body).value, '0.0')
  const transport = model.transport; model.transport = async (url, init) => { const response = await transport(url, init); if (init.method === 'PUT') model.values[0].value = null; return response }
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: '0' }, model), { code: 'BUSINESS_ASSERTION_FAILED' })
  assert.equal(writes(model).length, 3)
  await run('field value set', { projectId, fieldId: '801', value: null }, model)
})
test('dates use dotted calendar HTTP syntax and stop unsupported time writes before PUT', async () => {
  const model = state([field('801', 5)])
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: '2026-02-30' }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0)
  await run('field value set', { projectId, fieldId: '801', value: '2026-11-08' }, model)
  assert.equal(JSON.parse(writes(model)[0].body).value, '2026.11.08')
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: '2026-11-08', time: '12:30' }, model), { code: 'PERSISTENCE_UNSUPPORTED' }); assert.equal(writes(model).length, 1)
  const broken = { ...model.values[0], date: '12:30', time: null }
  assert.throws(() => describeCollectionFields({ collectionId, projectId, fieldId: '801' }, { collection, headers: model.headers, verifiedProjects: [{ kanbanId: projectId, customFieldList: [broken] }], prepared: { valueType: 5, valueExpected: '2026-11-08', timeExpected: '12:30', otherValues: [] } }, session), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('unsupported date clearing stops before PUT and a retained-date response can never prove a clear', async () => {
  const model = state([field('801', 5)])
  await run('field value set', { projectId, fieldId: '801', value: '2026-11-08' }, model)
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: null }, model), { code: 'PERSISTENCE_UNSUPPORTED' })
  assert.equal(model.values[0].date, '2026.11.08')
  assert.equal(writes(model).length, 1)
  assert.throws(() => describeCollectionFields({ collectionId, projectId, fieldId: '801' }, { collection, headers: model.headers, verifiedProjects: [{ kanbanId: projectId, customFieldList: model.values }], prepared: { valueType: 5, valueExpected: null, otherValues: [] } }, session), { code: 'BUSINESS_ASSERTION_FAILED' })
})
test('explicit null defaults and units encode clears rather than omitted DAO updates', async () => {
  const model = state([field('801', 2, { placeholder: '10', unit: '分' })])
  await run('field update', { fieldId: '801', patch: { defaultValue: null, unit: null } }, model)
  const saved = JSON.parse(writes(model)[0].body).fieldList.at(-1).field
  assert.equal(saved.placeholder, ''); assert.equal(saved.unit, '')
  assert.equal(model.headers.at(-1).field.placeholder, null)
})
test('member values require fresh company membership and actual instance canEdit', async () => {
  const model = state([field('801', 22)])
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: ['3'] }, model), { code: 'INVALID_INPUT' })
  await run('field value set', { projectId, fieldId: '801', value: [userId, '2'] }, model)
  assert.equal(model.values[0].value, userId + ',2')
  model.values[0].editControl.canEdit = false
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: ['2'] }, model), { code: 'FORBIDDEN' }); assert.equal(writes(model).length, 1)
})
test('calculated reference and attachment values cannot escape their required adapters', async () => {
  for (const type of [6, 34]) { const model = state([field('801', type)]); await assert.rejects(run('field value set', { projectId, fieldId: '801', value: 'arbitrary' }, model), { code: 'INVALID_INPUT' }); assert.equal(writes(model).length, 0) }
})
test('required fields cannot clear and a changed preflight instance stops before a write', async () => {
  const model = state([field('801', 1, { isRequired: true })])
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: null }, model), { code: 'INVALID_INPUT' })
  let projectReads = 0; const transport = model.transport
  model.transport = async (url, init) => { if (url.pathname.endsWith('/collection/project/list') && ++projectReads === 2) model.values[0].value = 'concurrent'; return transport(url, init) }
  await assert.rejects(run('field value set', { projectId, fieldId: '801', value: 'new' }, model), { code: 'CONTEXT_CONFLICT' }); assert.equal(writes(model).length, 0)
})
test('a lost full replacement response is never retried and retains the collection ID', async () => {
  const model = state(), transport = model.transport
  model.transport = async (url, init) => { const response = await transport(url, init); if (init.method === 'POST') throw Error('lost response'); return response }
  await assert.rejects(run('field create', { definition: { name: 'new', type: 'text' } }, model), error => { assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.details.writeOutcome, 'unknown'); assert.equal(error.details.resources.collectionId, collectionId); return true })
  assert.equal(writes(model).length, 1)
})
test('independent readback never hides changes to unrelated instance values', () => {
  const list = [...fixed(), field('801'), field('802')], results = { collection, headers: list, prepared: { valueType: 1, valueExpected: 'new', otherValues: [{ id: '802', type: 1, value: 'preserved' }] }, verifiedProjects: [{ kanbanId: projectId, customFieldList: [{ id: '801', type: 1, value: 'new' }, { id: '802', type: 1, value: 'changed' }] }] }
  assert.throws(() => describeCollectionFields({ collectionId, projectId, fieldId: '801' }, results, session), { code: 'BUSINESS_ASSERTION_FAILED' })
})
