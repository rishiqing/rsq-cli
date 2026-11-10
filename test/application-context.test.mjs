import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareApplication, verifyApplication, describeApplicationAccess } from '../dist/application-context.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
const session = { version: 1, method: 'password', identity: { userId: '101', teamId: '201', username: 'fixture' }, accessToken: 'private-token', expiresAt: Date.now() + 3600000 }
const identity = { id: '101', team: { id: '201', name: 'Fixture' }, token: 'private-token' }
const input = { teamId: '201' }
test('app setup asserts company before synchronization and respects explicit, department and all-member visibility', () => {
  const results = { identity, synchronized: { rangeRadio: 'part', range: [], rangeDept: [{ id: '401' }] }, departments: [{ id: '301', childList: [{ id: '401', childList: [{ id: '501', userList: [{ id: '101' }] }] }] }] }
  assert.deepEqual(prepareApplication('application-sync', input, results, session), {})
  assert.deepEqual(prepareApplication('application-visible', input, results, session), {})
  assert.throws(() => prepareApplication('application-sync', { teamId: '999' }, results, session), error => error.code === 'ORGANIZATION_MISMATCH')
  results.synchronized.rangeDept = [{ id: '999' }]
  assert.throws(() => prepareApplication('application-visible', input, results, session), error => error.code === 'FORBIDDEN')
  results.synchronized.range = [{ id: '101' }]
  assert.deepEqual(prepareApplication('application-visible', input, results, session), {})
  results.synchronized.rangeRadio = 'all'; results.synchronized.range = []
  assert.deepEqual(prepareApplication('application-visible', input, results, session), {})
})
test('performance initialization is conditional on a real boolean state and independently verified', () => {
  const results = { identity, synchronized: { rangeRadio: 'all' }, before: { data: { hasInit: true } } }
  assert.equal(prepareApplication('application-performance-init', input, results, session), null)
  results.before.data.hasInit = false
  assert.deepEqual(prepareApplication('application-performance-init', input, results, session), {})
  results.before.data.hasInit = null
  assert.throws(() => prepareApplication('application-performance-init', input, results, session), error => error.code === 'CONTEXT_MISSING')
  assert.throws(() => verifyApplication({ performanceReady: { data: { hasInit: false } } }, 'performanceReady'), error => error.code === 'BUSINESS_ASSERTION_FAILED')
  verifyApplication({ performanceReady: { data: { hasInit: true } } }, 'performanceReady')
})
test('OKR initialization requires actual app-visible current user and reads usable cycles afterwards', () => {
  assert.throws(() => prepareApplication('application-okr-init', input, { identity, members: [{ id: '999' }] }, session), error => error.code === 'FORBIDDEN')
  assert.deepEqual(prepareApplication('application-okr-init', input, { identity, members: [{ id: '101' }] }, session), {})
  assert.throws(() => verifyApplication({ okrReady: { currentCycleList: [], pastCycleList: [], futureCycleList: [] } }, 'okrReady'), error => error.code === 'BUSINESS_ASSERTION_FAILED')
  verifyApplication({ okrReady: { currentCycleList: [{ id: '601' }], pastCycleList: [], futureCycleList: [] } }, 'okrReady')
})
test('a lost application synchronization is reported as an unknown write and is never replayed', async () => {
  const definition = workflows.workflows.find(flow => flow.command === 'appraisal setup'), calls = []
  const transport = async (url, init) => {
    calls.push(url.pathname)
    if (url.pathname === '/task/login/authAjax') return new Response(JSON.stringify({ ...identity, username: 'fixture', success: true }))
    if (url.pathname === '/task/v1/performance/list') throw Error('connection lost after dispatch')
    throw Error('unexpected request')
  }
  await assert.rejects(runWorkflow({ environment: 'production', profile: 'fixture' }, definition, input, session, { transport }), error => error.details?.writeOutcome === 'unknown' && error.details?.failedStep === 'synchronized')
  assert.deepEqual(calls, ['/task/login/authAjax', '/task/v1/performance/list'])
})
test('diagnostic workflow output removes credential-bearing identity fields', () => {
  const result = describeApplicationAccess({ identity, state: { vt: 'fixture', deadLine: '2100-01-01 00:00:00', userLimit: 1, usersCount: 1, mainApp: 'rsq' }, functions: [], permissions: {} })
  assert.equal(result.available, true); assert.deepEqual(result.identity, { userId: '101', teamId: '201' })
  assert.ok(!JSON.stringify(result).includes('private-token'))
})
