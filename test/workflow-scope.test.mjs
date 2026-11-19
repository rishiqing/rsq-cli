import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import { executeOperation, executeWorkflow } from '../dist/dispatch.js'
import { cliDiagnostic } from '../dist/cli-errors.js'
import { catalog } from '../dist/operations.js'
import { workflows, workflowSchema } from '../dist/workflows.js'

const ctx = { environment: 'production', profile: 'fixture' }
const session = { version: 1, method: 'password', identity: { userId: '81', teamId: '7', username: 'fixture' }, accessToken: 'test-token', expiresAt: Date.now() + 60_000 }
const projectId = '9007199254741133', applicationId = '9007199254741134', formId = '8051', processId = '9101', stepId = '9201', fieldId = '9301'
const projectForm = { projectId, applicationId, formId }
const flow = command => workflows.workflows.find(flow => flow.command === command)
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const business = data => response({ code: 200, data })

function fixture(options = {}) {
  const calls = []
  let value = '已提交的样例'
  const transport = async (url, init) => {
    const path = url.pathname, query = Object.fromEntries(url.searchParams)
    calls.push({ path, query, method: init.method })
    const field = { id: fieldId, name: '示例字段', type: 1, value }
    if (path.endsWith('/authAjax')) return response({ success: true, id: 81, username: 'fixture', team: { id: 7, name: 'Fixture' }, token: 'test-token' })
    if (path.endsWith('/member/state/independent')) return response({ vt: 'fixture', deadLine: '2100-01-01 00:00:00', usersCount: 1, userLimit: 2, mainApp: 'rsq' })
    if (path.endsWith('/function/available')) return response(options.features ?? [{ funcName: 'WORKFLOW', status: 'disable' }])
    if (path.endsWith('/authorities/company/current')) return response({ useKanban: true, useFlow: options.useFlow ?? false })
    if (path.endsWith('/todo/pending/list')) return response({ total: 1, list: [{ id: stepId, pendingType: 'workflow', processInfoId: processId, stepInfoId: stepId }] })
    if (path.endsWith('/todo/pending/count')) return response({ task: 0, workflow: 1, performance: 0 })
    if (path.endsWith('/kanbanGroup/list')) return response([{ id: 'all', name: '全部', parentGroupId: null, displayOrder: 1, groupList: [], kanbanList: [] }])
    if (path.endsWith('/kanbanGroup/kanbanList')) {
      assert.equal(query.kanbanGroupId, 'all')
      return response({ groupList: [], kanbanList: [{ id: projectId, name: '测试项目', coverId: null }] })
    }
    if (path.endsWith('/application/appListForSelector')) return business([
      { id: applicationId, name: options.standalone ? '供应商' : '测试项目-供应商' },
      { id: '333', name: '供应商' },
    ])
    if (path.endsWith('/process/info/search')) {
      const list = '实例'.includes(query.processInfoName) ? [{ id: processId, name: '实例' }] : []
      return business({ list, total: 0, pageNum: 0, pageSize: 0, pages: 0, size: list.length })
    }
    if (path.endsWith('/listByIdsForDataModule')) {
      assert.deepEqual(query, { processInfoIds: processId })
      return business(options.missing ? [] : [{ id: processId, isCanOpen: options.canOpen !== false, isDeleted: options.deleted === true }])
    }
    if (path.endsWith('/application/list')) {
      assert.deepEqual(query, {})
      return business(options.unknownScope ? [{ id: '333', name: '供应商' }] : [
        ...(options.standalone ? [{ id: applicationId, name: '供应商' }] : []), { id: '333', name: '供应商' },
      ])
    }
    if (path.endsWith('/kanbanCrud')) {
      assert.equal(init.headers.has('plan-type'), false)
      assert.deepEqual(query, { id: projectId, isDefault: 'false' })
      return response({ id: projectId, coverId: options.template ? '8000' : null })
    }
    if (path.endsWith('/kanbanChildCrud/list')) {
      assert.deepEqual(query, { kanbanId: projectId })
      return response([{ id: '8001', name: '项目流程', kanbanId: projectId, type: 'workflow', flowApplicationId: options.wrongModule ? '12345' : applicationId }])
    }
    if (path.endsWith('/application')) return business({ id: applicationId, name: '应用', mode: 0, workflowModuleSubType: options.standalone ? null : 'projectWorkflow', editControl: {
      enterTable: true, viewAllProcess: true, viewPrivateSteps: true, flowConfig: true, exportFlow: true, ...options.permissions,
    } })
    if (path.endsWith('/form/list')) return business([{ id: formId, name: '表单' }])
    if (path.endsWith('/form/content/tableHeader')) return business([{ id: 'f-' + fieldId, name: field.name, selected: true }])
    if (path.endsWith('/form/content/tableElement')) {
      assert.deepEqual(query, { formId, pageNum: '2', pageSize: '1' })
      return business({ list: [{ processId, stepId, fields: [{ ...field, id: 'f-' + fieldId }] }], total: 3, pageNum: 2, pageSize: 1 })
    }
    if (path.endsWith('/workflow/form')) return business({ id: formId, name: '表单', fields: [{ id: fieldId, name: '示例字段', type: 1 }] })
    if (path.endsWith('/recursive/tree/list')) return business([{ id: '9501', name: '步骤', formId }])
    if (path.endsWith('/sheet/list')) {
      const body = JSON.parse(init.body)
      if (body.max === 1) assert.equal(body.offset, 1)
      return business(options.unlisted ? [] : [{ id: processId, name: '实例', flowAppId: applicationId, statusName: '进行中' }])
    }
    if (path.endsWith('/process/info/details')) return business({ id: processId, flowAppId: applicationId,
      belongToProjectId: options.standalone ? null : options.wrongProject ? '12345' : projectId,
      name: '实例', status: 'doing', dateCreated: '2026-11-19 08:00:00', processInfoStepList: [{ id: stepId, ...(options.childStep && { stepType: 'childProcess', originId: '9501' }) }] })
    if (path.endsWith('/childProcess/processInfo/list')) {
      assert.equal(query.childProcessStepId, stepId)
      return business([{ id: '9102' }])
    }
    if (path.endsWith('/process/info/step')) return business({ id: stepId, processInfoId: processId, applicationId, formId, editControl: { fillStepForm: true } })
    if (path.endsWith('/auditsAndForms')) return business({ formId, formName: '表单', editControl: { fillStepForm: options.fill !== false }, fields: [
      field, ...(options.exportFields ? [
        { id: '11', type: 1, name: '隐藏字段', value: 'private-hidden-fixture', isHidden: true },
        { id: '12', type: 3, name: '判断', value: '1', selector: [{ value: '1', name: '通过' }] },
        { id: '13', type: 1, name: '原文', value: '=1+1' },
      ] : []),
    ] })
    if (path.endsWith('/operate/status')) return business({ finish: true })
    if (path.endsWith('/process/info/form') && init.method === 'PUT') {
      const body = JSON.parse(init.body)
      assert.deepEqual(body, { fieldId, stepId, value: '已修改' })
      value = body.value
      return business({ ...field, value })
    }
    throw new Error('Unexpected request ' + init.method + ' ' + path)
  }
  return { calls, transport, run: (command, input, extra = {}) => executeWorkflow(ctx, flow(command), input, session, { transport, ...extra }) }
}

test('project-only entitlement supports discovery, paginated visible form data and instance readback through the emitted targets', async () => {
  const f = fixture({ permissions: { enterTable: false, viewPrivateSteps: false, viewAllProcess: false } })
  const module = (await f.run('project workflow modules list', { projectId })).result.modules[0]
  assert.deepEqual(module.target, { command: 'project workflow instances context', projectId, applicationId })
  const discovery = await f.run(module.target.command, { projectId, applicationId })
  assert.equal(discovery.result.forms[0].id, formId)
  const definition = await f.run('project workflow form describe', projectForm)
  assert.equal(definition.result.fields[0].id, fieldId)
  const result = await f.run('project workflow form records list', { ...projectForm, page: 2, limit: 1 })
  assert.deepEqual(result.resources, { projectId, moduleId: '8001', applicationId })
  assert.equal(result.result.items[0].fields[0].value, '已提交的样例')
  assert.equal(result.result.pagination.nextPage, 3)
  const listing = await f.run('project workflow instances list', { projectId, applicationId })
  const target = listing.result.items[0].target
  assert.deepEqual(target, result.result.items[0].target)
  assert.deepEqual(target, { command: 'project workflow instance inspect', projectId, processId })
  const instance = await f.run(target.command, { projectId: target.projectId, processId: target.processId })
  assert.equal(instance.result.steps[0].form.fields[0].value, '已提交的样例')
  assert.equal(instance.result.steps[0].actions.finish, true)
  assert.ok(f.calls.every(call => !call.path.includes('/form/content/')))
  await assert.rejects(f.run('workflow form describe', { applicationId, formId }), error => {
    assert.equal(error.code, 'FEATURE_DISABLED')
    assert.match(cliDiagnostic(error, 'fixture', 'workflow form describe').error.hint, /project workflow/)
    return true
  })
})

test('project binding and project product permission fail before form reads or mutations', async () => {
  for (const [options, code] of [[{ wrongModule: true }, 'FORBIDDEN'], [{ template: true }, 'WORKFLOW_SCOPE_MISMATCH'],
    [{ features: [{ funcName: 'PLAN_WORKFLOW', status: 'disable' }], useFlow: true }, 'FEATURE_DISABLED']]) {
    const f = fixture(options)
    await assert.rejects(f.run('project workflow form describe', projectForm), { code })
    assert.ok(f.calls.every(call => !call.path.includes('/task/workflow/')))
  }
  const wrong = fixture({ wrongProject: true })
  await assert.rejects(wrong.run('project workflow instance fill', { projectId, processId, stepId, fieldId, value: '已修改' }), { code: 'WORKFLOW_SCOPE_MISMATCH' })
  assert.ok(wrong.calls.every(call => call.method === 'GET' && !call.path.endsWith('/process/info/step')))
  const unlisted = fixture({ unlisted: true, permissions: { viewAllProcess: false } })
  await assert.rejects(unlisted.run('project workflow instance inspect', { projectId, processId }), { code: 'FORBIDDEN' })
  assert.ok(unlisted.calls.some(call => call.path.endsWith('/sheet/list')))
  assert.ok(unlisted.calls.every(call => !call.path.endsWith('/auditsAndForms')))
})

test('standalone uses its own entitlement and visible project data cannot borrow that scope', async () => {
  const features = [{ funcName: 'PLAN_WORKFLOW', status: 'disable' }, { funcName: 'WORKFLOW', status: 'enable' }]
  const independent = fixture({ standalone: true, useFlow: true, features })
  assert.equal((await independent.run('workflow form describe', { applicationId, formId })).result.id, formId)
  assert.ok(independent.calls.every(call => !call.path.includes('/kanban')))
  const projectOnly = fixture({ features, useFlow: true })
  await assert.rejects(projectOnly.run('workflow form describe', { applicationId, formId }), { code: 'WORKFLOW_SCOPE_MISMATCH' })
  await assert.rejects(projectOnly.run('workflow instance inspect', { processId }), { code: 'WORKFLOW_SCOPE_MISMATCH' })
  assert.ok(projectOnly.calls.every(call => !call.path.endsWith('/form/list') && !call.path.endsWith('/auditsAndForms')))
})

test('project child relations reuse project instance visibility and return both scope choices for the child', async () => {
  const f = fixture({ childStep: true, permissions: { viewAllProcess: false } })
  const result = (await f.run('project workflow instance children list', { projectId, processId, stepId })).result
  assert.equal(result.relationVerified, true)
  assert.equal(result.items[0].id, '9102')
  assert.ok(result.nextCommands.includes('project workflow instance inspect'))
  assert.ok(f.calls.findIndex(call => call.path.endsWith('/sheet/list')) < f.calls.findIndex(call => call.path.endsWith('/childProcess/processInfo/list')))
})

test('standalone record tables require full visibility while project instance fill uses the current step permission', async () => {
  const standalone = { standalone: true, features: [], useFlow: true }
  const restricted = fixture({ ...standalone, permissions: { viewPrivateSteps: false }, fill: false })
  await assert.rejects(restricted.run('workflow form records list', { applicationId, formId, page: 2, limit: 1 }), error => {
    assert.equal(error.code, 'FORBIDDEN'); assert.equal(error.details.cause.permission, 'viewPrivateSteps'); return true
  })
  assert.ok(restricted.calls.every(call => !call.path.includes('/form/content/')))
  const records = fixture(standalone)
  assert.equal((await records.run('workflow form records list', { applicationId, formId, page: 2, limit: 1 })).result.pagination.total, 3)
  assert.ok(records.calls.findIndex(call => call.path.endsWith('/tableHeader')) < records.calls.findIndex(call => call.path.endsWith('/tableElement')))
  const readOnlyStep = fixture({ fill: false })
  await assert.rejects(readOnlyStep.run('project workflow instance fill', { projectId, processId, stepId, fieldId, value: '已修改' }), { code: 'FORBIDDEN' })
  assert.ok(readOnlyStep.calls.every(call => call.method === 'GET'))
  const allowed = fixture()
  const result = await allowed.run('project workflow instance fill', { projectId, processId, stepId, fieldId, value: '已修改' })
  assert.equal(result.result.fields[0].value, '已修改')
  assert.equal(allowed.calls.filter(call => call.method === 'PUT').length, 1)
})

test('project commands expose scope and offline dry run, and the raw table route requires context', async () => {
  const f = fixture(), project = 'project workflow form records list'
  const schema = workflowSchema(flow(project))
  assert.ok(schema.inputSchema.required.includes('projectId'))
  assert.equal(schema.scope.kind, 'project')
  assert.deepEqual(schema.access.features, ['PLAN', 'PLAN_WORKFLOW'])
  assert.deepEqual(workflowSchema(flow('workflow form records list')).access.features, ['WORKFLOW'])
  await assert.rejects(f.run(project, { applicationId, formId }), { code: 'INVALID_INPUT' })
  assert.equal((await f.run(project, projectForm, { dryRun: true })).dryRun, true)
  const raw = catalog.operations.find(op => op.command === 'workflow form content-table-element get')
  await assert.rejects(executeOperation(ctx, raw, { query: { formId } }, session, { transport: f.transport }), { code: 'BUSINESS_CONTEXT_REQUIRED' })
  assert.equal(f.calls.length, 0)
})

test('the pending row opens and recommends actions without requiring the user to know the workflow scope', async () => {
  const contexts = [
    { options: { permissions: { viewAllProcess: false } }, scope: { kind: 'project', projectId, applicationId }, prefix: 'project workflow' },
    { options: { standalone: true, features: [{ funcName: 'PLAN_WORKFLOW', status: 'disable' }], useFlow: true },
      scope: { kind: 'standalone', applicationId }, prefix: 'workflow' },
  ]
  for (const { options, scope, prefix } of contexts) {
    const f = fixture(options)
    const { command, ...input } = (await f.run('todo pending list', {})).result.list[0].target
    assert.equal(command, 'todo workflow inspect')
    assert.deepEqual(input, { processId, stepId })
    const result = (await f.run(command, input)).result
    assert.deepEqual(result.scope, scope)
    assert.equal(result.step.form.fields[0].value, '已提交的样例')
    assert.deepEqual(result.target, { command: prefix + ' instance inspect', processId, ...(scope.projectId && { projectId }) })
    assert.ok(result.nextCommands.includes(prefix + ' instance fill'))
    assert.ok(result.nextCommands.includes(prefix + ' instance act'))
    assert.ok(f.calls.findIndex(call => call.path.endsWith('/listByIdsForDataModule')) < f.calls.findIndex(call => call.path.endsWith('/process/info/details')))
    assert.equal(f.calls.some(call => call.path.endsWith('/kanbanChildCrud/list')), scope.kind === 'project')
  }
})

test('automatic scope requires a visible instance, a matching step and the actual product entitlement', async () => {
  for (const options of [{ canOpen: false }, { deleted: true }, { missing: true }]) {
    const f = fixture(options)
    await assert.rejects(f.run('todo workflow inspect', { processId, stepId }), { code: 'FORBIDDEN' })
    assert.ok(f.calls.every(call => !call.path.endsWith('/process/info/details')))
  }
  const wrongStep = fixture()
  await assert.rejects(wrongStep.run('todo workflow inspect', { processId, stepId: '123' }), { code: 'FORBIDDEN' })
  assert.ok(wrongStep.calls.every(call => !call.path.endsWith('/auditsAndForms')))
  const unknownScope = fixture({ standalone: true, unknownScope: true, features: [], useFlow: true })
  await assert.rejects(unknownScope.run('todo workflow inspect', { processId }), { code: 'CONTEXT_MISSING' })
  const product = fixture({ standalone: true })
  await assert.rejects(product.run('todo workflow inspect', { processId }), { code: 'FEATURE_DISABLED' })
  assert.ok(product.calls.every(call => !call.path.endsWith('/auditsAndForms')))
  const plan = await product.run('todo workflow inspect', { processId, stepId }, { dryRun: true })
  assert.equal(plan.dryRun, true)
})

test('workflow find resolves names to visible project and standalone targets without requesting the workflow type', async () => {
  const project = fixture()
  const out = (await project.run('workflow find', { name: '供应商' })).result
  assert.equal(out.total, 1)
  assert.equal(out.exact, 1)
  assert.deepEqual(out.items[0].target, { command: 'project workflow configuration inspect', applicationId, projectId })
  assert.deepEqual(out.items[0].exportTarget, { command: 'workflow export', applicationId })
  assert.equal(out.items[0].projectName, '测试项目')
  assert.ok(project.calls.every(call => !call.path.endsWith('/application/list')))
  const standalone = fixture({ standalone: true, features: [{ funcName: 'PLAN_WORKFLOW', status: 'disable' }], useFlow: true })
  const known = (await standalone.run('workflow find', { name: '实例' })).result.items[0]
  assert.deepEqual(known.target, { command: 'workflow instance inspect', processId })
  assert.ok(standalone.calls.every(call => !call.path.includes('/kanban')))
  const invalid = fixture({ wrongModule: true })
  assert.equal((await invalid.run('workflow find', { name: '供应商' })).result.total, 0)
  const denied = fixture({ canOpen: false })
  assert.equal((await denied.run('workflow find', { name: '实例' })).result.total, 0)
  assert.ok(denied.calls.every(call => !call.path.endsWith('/process/info/details')))
})

test('workflow export writes an Excel file for visible records, preserves text, and leaves existing files intact', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rsq-workflow-fixtures-'))
  try {
    const f = fixture({ exportFields: true, permissions: { enterTable: false, viewAllProcess: false, viewPrivateSteps: false } })
    const out = (await f.run('workflow export', { name: '供应商', formName: '表单', output: folder, createdBetween: ['2026-11-19', '2026-11-19'] })).result
    assert.equal(out.scope.kind, 'project')
    assert.deepEqual([out.instances, out.steps, out.records], [1, 1, 1])
    const bytes = await readFile(out.output), workbook = unzipSync(bytes)
    assert.equal(bytes.length, out.bytes)
    assert.equal(Object.keys(workbook).filter(path => path.startsWith('xl/worksheets/')).length, 3)
    const strings = strFromU8(workbook['xl/sharedStrings.xml'])
    for (const text of ['实例', '表单', '已提交的样例', '通过', '=1+1']) assert.ok(strings.includes(text))
    assert.ok(!strings.includes('private-hidden-fixture'))
    assert.ok(!strFromU8(workbook['xl/worksheets/sheet3.xml']).includes('<f>'))
    assert.ok(f.calls.every(call => !call.path.includes('/form/content/') && !call.path.includes('/export/record')))
    const before = f.calls.length
    await assert.rejects(f.run('workflow export', { processId, output: out.output }), { code: 'OUTPUT_EXISTS' })
    assert.ok(f.calls.slice(before).every(call => !call.path.includes('/task/workflow/')))
    const another = (await f.run('workflow export', { applicationId, formId, output: folder })).result
    assert.notEqual(another.output, out.output)
    assert.deepEqual(await readFile(out.output), bytes)
    assert.equal((await readdir(folder)).length, 2)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('export separates matching from authorization and only asks about genuine ambiguity', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rsq-workflow-matching-'))
  try {
    const f = fixture({ features: [], useFlow: true })
    await assert.rejects(f.run('workflow export', { name: '供应商', output: folder }), error => {
      assert.equal(error.code, 'AMBIGUOUS_TARGET')
      assert.deepEqual(error.details.candidates.map(row => row.scope.kind).sort(), ['project', 'standalone'])
      return true
    })
    assert.ok(f.calls.every(call => !call.path.endsWith('/application') && !call.path.endsWith('/auditsAndForms')))
    const blocked = fixture({ permissions: { exportFlow: false } })
    await assert.rejects(blocked.run('workflow export', { applicationId, output: folder }), { code: 'FORBIDDEN' })
    assert.ok(blocked.calls.every(call => !call.path.endsWith('/sheet/list')))
    const empty = fixture({ unlisted: true })
    await assert.rejects(empty.run('workflow export', { applicationId, output: folder }), { code: 'NO_RECORDS' })
    const standalone = fixture({ standalone: true, features: [{ funcName: 'PLAN_WORKFLOW', status: 'disable' }], useFlow: true })
    const result = (await standalone.run('workflow export', { processId, output: folder })).result
    assert.equal(result.scope.kind, 'standalone')
    assert.equal(result.instances, 1)
    assert.equal((await readdir(folder)).length, 1)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
