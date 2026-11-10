import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareTaskTemplate, verifyTaskTemplate, describeTaskTemplate, taskTemplateVersion } from '../dist/task-template.js'
import { runWorkflow, workflows } from '../dist/workflows.js'
const label = { id: '9007199254740993', type: 'project', name: 'current-library', color: 3 }
const retained = { id: '7402', type: 'project', name: 'existing-external-project', color: 4 }
const session = { identity: { userId: '81', teamId: '7' } }
const base = { projectId: '7001', templateId: '7101', labelIds: [label.id] }
function context(template = false) {
  const project = { id: '7001', coverId: template ? '8001' : null, editControl: { kanbanTaskTypeManager: true } }, cover = { id: '8001', templateKanbanId: '7001', withEdit: true }
  const original = { id: '7101', name: 'owned-type', icon: 1, fields: [], auths: { elements: [] }, defaultValues: { note: '<p>preserved</p>', priorityV2: 2, label: { kanbanLabels: [retained] } } }
  return { project, ...(template && { templateBoundary: cover }), company: {}, available: [{ id: '7101', type: 'kanban' }], original, defaultLabels: [label], defaultLabelsFresh: [label], defaultLabelIdentityFresh: { id: '81', team: { id: '7' } }, defaultLabelProjectFresh: structuredClone(project), defaultLabelCoverFresh: template ? structuredClone(cover) : null, defaultLabelCompanyFresh: {}, defaultLabelAvailableFresh: [{ id: '7101', type: 'kanban' }], defaultLabelDefinitionFresh: structuredClone(original) }
}
test('default-label updates use exact project IDs, keep selected external project labels and send only the label patch', () => {
  for (const template of [false, true]) {
    const results = context(template), input = { ...base, labelIds: [label.id, retained.id], expectedDefinition: taskTemplateVersion(results.original) }
    const request = prepareTaskTemplate('task-context-default-labels', input, results, session)
    assert.deepEqual(request, { body: { id: '7101', defaultValues: { label: { kanbanLabelIds: [label.id, retained.id].sort().join(',') } } } })
    results.verifiedTemplate = { ...structuredClone(results.original), defaultValues: { ...results.original.defaultValues, label: { kanbanLabels: [retained, label] } } }
    assert.doesNotThrow(() => verifyTaskTemplate(input, results, 'verifiedTemplate'))
    assert.deepEqual(describeTaskTemplate(results).availableProjectLabels, [label])
    assert.deepEqual(prepareTaskTemplate('task-context-default-labels', { ...base, labelIds: [] }, context(template), session).body.defaultValues.label, { kanbanLabelIds: '' })
  }
})
test('default-label validation refuses foreign IDs, source confusion, imprecise IDs and absent context before writing', () => {
  for (const labelIds of [['9999'], [label.id, label.id], [9007199254740992], null]) assert.throws(() => prepareTaskTemplate('task-context-default-labels', { ...base, labelIds }, context(), session))
  const wrong = context(); wrong.defaultLabels = [{ ...label, type: 'todo' }]; wrong.defaultLabelsFresh = wrong.defaultLabels
  assert.throws(() => prepareTaskTemplate('task-context-default-labels', base, wrong, session), { code: 'FORBIDDEN' })
  const absent = context(); delete absent.defaultLabels
  assert.throws(() => prepareTaskTemplate('task-context-default-labels', base, absent, session))
})
test('definition, library, actor, project kind, management and template edit changes stop default-label mutation', () => {
  const cases = [
    [r => { r.defaultLabelIdentityFresh.id = '82' }, 'IDENTITY_CHANGED'],
    [r => { r.defaultLabelIdentityFresh.team.id = '8' }, 'IDENTITY_CHANGED'],
    [r => { r.defaultLabelProjectFresh.coverId = '8002' }, 'CONTEXT_CONFLICT'],
    [r => { r.defaultLabelDefinitionFresh.defaultValues.note = 'changed' }, 'CONTEXT_CONFLICT'],
    [r => { r.defaultLabelsFresh[0] = { ...label, name: 'renamed' } }, 'CONTEXT_CONFLICT'],
    [r => { r.defaultLabelProjectFresh.editControl.kanbanTaskTypeManager = false }, 'FORBIDDEN'],
    [r => { r.defaultLabelAvailableFresh = [] }, 'CONTEXT_MISSING'],
  ]
  for (const [change, code] of cases) { const results = context(); change(results); assert.throws(() => prepareTaskTemplate('task-context-default-labels', base, results, session), { code }) }
  const readonly = context(true); readonly.defaultLabelCoverFresh.withEdit = false
  assert.throws(() => prepareTaskTemplate('task-context-default-labels', base, readonly, session), { code: 'FORBIDDEN' })
  assert.throws(() => prepareTaskTemplate('task-context-default-labels', { ...base, expectedDefinition: '0'.repeat(64) }, context(), session), { code: 'CONTEXT_CONFLICT' })
})
test('label readback verifies the exact selection and refuses changes to unrelated defaults, fields, permissions, name or icon', () => {
  for (const mutate of [r => { r.defaultValues.note = 'lost' }, r => { r.defaultValues.priorityV2 = 4 }, r => { r.fields = [{ id: '1' }] }, r => { r.auths = {} }, r => { r.name = 'changed' }, r => { r.icon = 2 }, r => { r.defaultValues.label.kanbanLabels = [] }]) {
    const results = context(); prepareTaskTemplate('task-context-default-labels', base, results, session)
    results.verifiedTemplate = { ...structuredClone(results.original), defaultValues: { ...results.original.defaultValues, label: { kanbanLabels: [label] } } }
    mutate(results.verifiedTemplate)
    assert.throws(() => verifyTaskTemplate(base, results, 'verifiedTemplate'), { code: 'BUSINESS_ASSERTION_FAILED' })
  }
})
test('generic configuration validates the same default-label scope and cannot interpret null or omission as clearing', () => {
  for (const raw of [{}, { kanbanLabelIds: null }]) assert.throws(() => prepareTaskTemplate('task-context-configure', { ...base, patch: { defaultValues: { label: raw } } }, context(), session), { code: 'INVALID_INPUT' })
  assert.throws(() => prepareTaskTemplate('task-context-configure', { ...base, patch: { defaultValues: { label: { kanbanLabelIds: '9999' } } } }, context(), session), { code: 'FORBIDDEN' })
  assert.deepEqual(prepareTaskTemplate('task-context-default-label-catalogue', base, context()), { query: { kanbanId: '7001' } })
  assert.equal(prepareTaskTemplate('task-context-default-label-catalogue-if-needed', { ...base, patch: { name: 'name' } }, context()), null)
  assert.throws(() => prepareTaskTemplate('task-context-default-label-catalogue-if-needed', { templateId: '7101', patch: { defaultValues: { label: { kanbanLabelIds: '' } } } }, context()), { code: 'INVALID_INPUT' })
})
test('both project contexts expose executable default-label plans, confirmation and schema validation with zero HTTP', async () => {
  let calls = 0; const transport = async () => { calls++; throw Error('No network allowed') }, ctx = { environment: 'production', profile: 'fixture' }
  for (const prefix of ['task template', 'project template task-type']) {
    for (const suffix of ['labels catalogue', 'labels set']) {
      const flow = workflows.workflows.find(flow => flow.command === prefix + ' ' + suffix); assert.ok(flow)
      const input = { projectId: '7001', templateId: '7101', ...(suffix === 'labels set' && { labelIds: [] }) }
      const result = await runWorkflow(ctx, flow, input, null, { dryRun: true, transport }); assert.equal(result.dryRun, true)
      if (suffix === 'labels set') {
        await assert.rejects(runWorkflow(ctx, flow, input, session, { transport }), { code: 'CONFIRMATION_REQUIRED' })
        await assert.rejects(runWorkflow(ctx, flow, { ...input, labelIds: ['not-id'] }, session, { approved: true, transport }))
      }
    }
  }
  for (const command of ['task template configure', 'company task-type configure']) {
    const flow = workflows.workflows.find(row => row.command === command)
    for (const value of command.startsWith('company') ? [{ kanbanLabelIds: '' }, {}] : [{ kanbanLabelIds: null }, {}]) await assert.rejects(runWorkflow(ctx, flow, { ...(command.startsWith('company') ? {} : { projectId: '7001' }), templateId: '7101', patch: { defaultValues: { label: value } } }, null, { dryRun: true, transport }))
  }
  assert.equal(calls, 0)
})
