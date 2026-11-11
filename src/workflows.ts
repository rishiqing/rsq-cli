import { prepareWorkspaceTask } from './workspace-tasks.js'
import { runArmsUsage } from './arms-usage.js'
import { validateUsageWorkflow } from './usage-runtime.js'
import { runStatisticsDrilldown, validateStatisticsDrilldownWorkflow, type StatisticsDrilldownAction } from './statistics-drilldown.js'
import { runWorkflowTasks, validateWorkflowTaskWorkflow, type WorkflowTaskAction } from './workflow-tasks.js'
import { runWorkflowDatasheet, validateWorkflowDatasheetWorkflow, type WorkflowDatasheetAction } from './workflow-datasheet.js'
import { readCreatedTask, validateTaskCreationVisibility, type TaskCreationVisibility } from './task-creation-readback.js'
import { runTaskTypeTransition, validateTaskTypeTransitionWorkflow, type TaskTypeAction, type TaskTypeTarget } from './task-type-transition.js'
import { runReplayNavigation, validateReplayNavigationWorkflow, type ReplayNavigationAction } from './replay-navigation.js'
import { runFileLibraryQuit, validateFileLibraryQuitWorkflow } from './file-library-quit.js'
import { runProjectCardBatch, validateProjectCardBatchWorkflow, type ProjectCardBatchAction } from './project-card-batch.js'
import { runReplayCollectionConfig, validateReplayCollectionConfigWorkflow, type ReplayCollectionConfigAction } from './replay-collection-config.js'
import { runProjectExcel, validateProjectExcelWorkflow, type ProjectExcelAction } from './project-excel-import.js'
import { describeWorkflowTemplates } from './workflow-templates.js'
import { runProjectImport, validateProjectImportWorkflow, type ProjectImportAction } from './project-import.js'
import { runAiConfig, validateAiConfigWorkflow, type AiConfigAction } from './ai-config.js'
import { describeCompanyOkrStatistics } from './statistics.js'
import { runAutomation, validateAutomationWorkflow, validateAutomationInput, type AutomationAction } from './automation.js'
import { runDeveloper, validateDeveloperWorkflow, type DeveloperAction } from './developer.js'
import { runOkrPerformance, validateOkrPerformanceWorkflow, type OkrPerformanceAction } from './okr-performance.js'
import { runOkrIndicator, validateOkrIndicatorWorkflow, type OkrIndicatorAction } from './okr-indicators.js'
import { prepareCompanyUsage, describeCompanyUsage, verifyCompanyUsage } from './company-usage.js'
import { prepareCollectionFields, describeCollectionFields } from './project-collection-fields.js'
import { prepareArchive, describeArchive, verifyArchive } from './archive.js'
import { prepareCompanyRole, describeCompanyRole, verifyCompanyRole } from './company-roles.js'
import { prepareOkrView, describeOkrView, verifyOkrView } from './okr-views.js'
import { prepareIdentitySettings, describeIdentitySettings, verifyIdentitySettings, validateIdentitySettingsInput } from './identity-settings.js'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import Ajv, { type AnySchema } from 'ajv'
import { asObject, RsqError, type Context, type JsonObject, type Transport, type LoginMethod } from './core.js'
import { catalog, runOperation, validateUploadFiles, type Schema, type Operation } from './operations.js'
import type { Session } from './session.js'
import { prepareDatasheet, verifyDatasheet, describeDatasheet, verifyDatasheetImport, describeDatasheetImport } from './datasheet.js'
import { prepareStatistics, verifyStatistics } from './statistics.js'
import { prepareReplayStatistics, describeReplayStatistics } from './replay-statistics.js'
import { prepareReplayPushRule, verifyReplayPushRule, describeReplayPushRules } from './replay-push-rules.js'
import { prepareReplayRelations, describeReplayRelations } from './replay-relations.js'
import { prepareReplayOkrRelations, describeReplayOkrRelations } from './replay-okr-relations.js'
import { prepareReplayCreatedTasks, describeReplayCreatedTasks } from './replay-created-tasks.js'
import { describeReplayTemplateComponents } from './replay.js'
import { prepareCooperation, describeCooperation } from './cooperation.js'
import { prepareAction, verifyAction, validateActionInput } from './action.js'
import { prepareProjectCollection, verifyProjectCollection, describeProjectCollection } from './project-collection.js'
import { prepareWorkflowContext, verifyWorkflowContext, describeWorkflowConfiguration } from './workflow-context.js'
import { verifyWorkflowLifecycle, describeWorkflowInstance, describeWorkflowArrangement, validateWorkflowStepObservation } from './workflow-lifecycle.js'
import { prepareOkrContext, verifyOkrContext, describeOkrContext } from './okr-context.js'
import { runOkrAction, validateOkrActionWorkflow, type OkrAction } from './okr-actions.js'
import { runReplayTopic, validateReplayTopicWorkflow, validateReplayTopicInput, type ReplayTopicAction } from './replay-topic.js'
import { runAiMarket, validateAiMarketWorkflow, type AiMarketAction } from './ai-market.js'
import { runOkrStatistics, validateOkrStatisticsWorkflow, type OkrStatisticsAction } from './okr-statistics.js'
import { runOkrAlignment, validateOkrAlignmentWorkflow, type OkrAlignmentAction } from './okr-alignment.js'
import { prepareOkrCycle, verifyOkrCycle, describeOkrCycles } from './okr-cycles.js'
import { prepareDeliverable, verifyDeliverable, describeDeliverable } from './deliverable.js'
import { prepareFileLibrary, verifyFileLibrary } from './file-library.js'
import { prepareReplay, verifyReplay, describeReplayTemplate, describeReplayScore, describeReplayFeatures, replayQuestionDelta } from './replay.js'
import { inspectUpload, uploadToStorage, type UploadTransfer, type LocalUpload } from './storage.js'
import { runOrganization, validateOrganizationWorkflow, type OrganizationAction, type OrganizationStore } from './organization.js'
import { prepareApplication, verifyApplication, describeApplicationAccess } from './application-context.js'
import { accessDescription } from './access.js'
import { prepareTaskTemplate, verifyTaskTemplate, describeTaskTemplate, describeTaskAttachments } from './task-template.js'
import { prepareFileItem, verifyFileItem, describeFileItems } from './file-items.js'
import { prepareTaskBusiness, verifyTaskBusiness } from './task-business.js'
import { validateLabelPatch } from './task-personal-labels.js'
import { preparePersonalResource, verifyPersonalResource, describePersonalResources } from './personal-resources.js'
import { validateCursorPages, collectOperationPages, type CursorPages } from './pagination.js'
import { prepareNotification, verifyNotification, describeNotifications } from './notifications.js'
import { prepareContact, verifyContact, describeContact } from './contact.js'
import { prepareTaskHours, verifyTaskHours, describeTaskHours } from './task-hours.js'
import { prepareEfficiency, verifyEfficiency, describeEfficiency } from './efficiency.js'
import { prepareSearch, describeSearch } from './search.js'
import { runMinder,validateMinderWorkflow,validateMinderDocument,type MinderAction } from './minder.js'
import { prepareProjectContext,verifyProjectContext,describeProjectContext } from './project-context.js'
import { runDoc,validateDocWorkflow,docDelta,type DocAction } from './doc-context.js'
import { runTaskAudit,validateTaskAuditWorkflow,type TaskAuditAction } from './task-audit.js'
import { runCloudFile,validateCloudFileWorkflow,type CloudFileAction } from './cloud-file.js'
import { runDatasheetAdmin, validateDatasheetAdminWorkflow, type DatasheetAdminAction } from './datasheet-admin.js'
import { runDatasheetRecords, validateDatasheetRecordsWorkflow, type DatasheetRecordsAction } from './datasheet-records.js'
import { validateDatasheetTargetWorkflow } from './datasheet-target.js'
import { runAppraisal, validateAppraisalWorkflow, type AppraisalAction } from './appraisal-context.js'
import { describeWorkflowStatistics, validateWorkflowStatisticsInput } from './workflow-statistics.js'
import { runSignature, validateSignatureWorkflow, type SignatureAction } from './signature.js'
import { runProjectSchedule, validateProjectScheduleWorkflow, type ProjectScheduleAction } from './project-schedule.js'

import { prepareExecution, verifyExecution, describeExecution, validateExecutionInput } from './execution-context.js'

export type Value = unknown
export type Workflow = {
  usageAction?: string; usageTemplate?: boolean; usageProject?: boolean
  statisticsDrilldownAction?: StatisticsDrilldownAction
  workflowTaskAction?: WorkflowTaskAction; workflowTaskProject?: boolean
  projectCardBatchAction?: ProjectCardBatchAction; projectCardBatchTemplate?: boolean
  id: string; command: string; description: string; effect: Operation['effect']; methods: LoginMethod[]
  inputSchema: Schema; parameters: { option: string; name: string; schema: Schema }[]
  resultSchema?: Schema; recovery?: string
  capabilities: string[]; examples: string[]
  workflowDatasheetAction?: WorkflowDatasheetAction; workflowDatasheetProject?: boolean; taskTypeAction?: TaskTypeAction; taskTypeTarget?: TaskTypeTarget; datasheetRecordsAction?: DatasheetRecordsAction; executor?: 'arms-usage' | 'statistics-drilldown' | 'workflow-tasks' | 'datasheet-records' | 'workflow-datasheet' | 'task-type-transition' | 'project-card-batch' | 'replay-navigation' | 'file-library-quit' | 'replay-collection-config' | 'project-excel' | 'project-import' | 'ai-config' | 'automation' | 'developer' | 'okr-indicators' | 'okr-performance' | 'okr-statistics' | 'ai-market' | 'replay-topic' | 'signature' | 'project-schedule' | 'okr-actions' | 'okr-alignment' | 'organization' | 'minder' | 'document' | 'cloud-file' | 'datasheet-admin' | 'appraisal' | 'task-audit'; replayNavigationAction?: ReplayNavigationAction; replayCollectionConfigAction?: ReplayCollectionConfigAction; projectExcelAction?: ProjectExcelAction; projectImportAction?: ProjectImportAction; aiConfigAction?: AiConfigAction; automationAction?: AutomationAction; developerAction?: DeveloperAction; okrIndicatorAction?: OkrIndicatorAction; okrPerformanceAction?: OkrPerformanceAction; okrStatisticsAction?: OkrStatisticsAction; aiMarketAction?: AiMarketAction; replayTopicAction?: ReplayTopicAction; signatureAction?: SignatureAction; projectScheduleAction?: ProjectScheduleAction; projectScheduleTemplate?: boolean; okrAction?: OkrAction; okrAlignmentAction?: OkrAlignmentAction; taskAuditAction?: TaskAuditAction; appraisalAction?: AppraisalAction; datasheetAdminAction?: DatasheetAdminAction; cloudFileAction?: CloudFileAction; docAction?: DocAction; organizationAction?: OrganizationAction; minderAction?: MinderAction
  steps: { id: string; operationId: string; description: string; input: JsonObject;
    authentication?: 'cookie';
    resources?: Record<string, string>; assertions?: { path: string; equals?: Value; compare?: 'identifier'; exists?: boolean; whenInput?: string; excludes?: { path: string; equals: Value }; contains?: { match: Record<string, Value> } }[];
    creationVisibility?: TaskCreationVisibility; readback?: { attempts: number; delayMs: number }; collectPages?: CursorPages; expectAbsent?: boolean; waitBeforeMs?: number;
    prepare?: string; transfer?: 'storage-upload'; verify?: 'replay-push-rule' | 'company-usage' | 'okr-views' | 'company-role' | 'identity-settings' | 'archive' | 'project-context' | 'efficiency' | 'task-hours' | 'contact' | 'notification' | 'personal-resource' | 'datasheet' | 'statistics' | 'action' | 'datasheet-import' | 'project-collection' | 'workflow-context' | 'workflow-lifecycle' | 'okr-context' | 'okr-cycles' | 'deliverable' | 'file-library' | 'file-item' | 'replay' | 'application' | 'task-template' | 'task-business' | 'execution'; forEach?: { path: string; limit: number } }[]
  output: Value; outputAdapter?: 'workflow-templates' | 'company-okr-statistics' | 'replay-push-rules' | 'workflow-statistics' | 'company-usage' | 'okr-superiors' | 'okr-views' | 'company-role' | 'identity-settings' | 'archive' | 'collection-fields' | 'replay-created-tasks' | 'replay-okr-relations' | 'replay-relations' | 'replay-template-components' | 'replay-statistics' | 'okr-cycles' | 'cooperation' | 'project-context' | 'search' | 'efficiency' | 'task-hours' | 'contact' | 'notifications' | 'personal-resources' | 'datasheet-description' | 'datasheet-import' | 'collection-roadmap' | 'collection-stages' | 'workflow-configuration' | 'workflow-instance' | 'task-template' | 'task-attachments' | 'file-items' | 'workflow-arrangement' | 'okr-objectives' | 'okr-planning' | 'deliverable-context' | 'deliverable-files' | 'replay-template' | 'replay-score' | 'replay-features' | 'access-context' | 'execution-workspace'
}
export const workflows = JSON.parse(readFileSync(new URL('../contracts/workflows.json', import.meta.url), 'utf8')) as { version: number; workflows: Workflow[] }
export function validateWorkflowWait(flow: Workflow, index: number) {
  const step = flow.steps[index]
  if (step.waitBeforeMs === undefined) return
  const operation = catalog.operations.find(op => op.id === step.operationId), previous = flow.steps[index - 1], created = catalog.operations.find(op => op.id === previous?.operationId)
  if (!['project alteration flow create', 'project alteration flow copy-template'].includes(flow.command) || step.id !== 'verifiedModules' || step.waitBeforeMs !== 5000 || operation?.method !== 'GET' || operation.route !== '/task/v1/kanbanChildCrud/list' || previous?.id !== 'created' || created?.method !== 'POST' || !['/task/v1/kanbanChildCrud', '/task/v4/kanbanChild/copy'].includes(created.route) || step.readback || step.collectPages || step.forEach || step.transfer || step.resources) throw new RsqError('INVALID_CONTRACT', '仅当前变更流程的异步创建受理后，可按 UI 协议等待五秒再独立读取一次模块；不能借此重放写请求。', 6)
}
const ajv = new Ajv.default({ strict: false, allErrors: true, ownProperties: true })
const blocked = new Set(['__proto__', 'constructor', 'prototype'])
function at(value: unknown, pointer: string): unknown {
  if (!pointer) return value
  if (!pointer.startsWith('/')) throw new RsqError('INVALID_CONTRACT', '上下文引用必须为 JSON Pointer。')
  return pointer.slice(1).split('/').reduce<unknown>((current, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (blocked.has(key) || !current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    return (current as JsonObject)[key]
  }, value)
}
function resolve(value: unknown, input: JsonObject, results: JsonObject, item?: unknown): unknown {
  if (Array.isArray(value)) return value.map(v => resolve(v, input, results, item))
  if (!value || typeof value !== 'object') return value
  const obj = asObject(value)
  if (Object.keys(obj).length === 1 && typeof obj.$input === 'string') return at(input, obj.$input)
  if (Object.keys(obj).length === 1 && typeof obj.$item === 'string') {
    const value = at(item, obj.$item)
    if (value === undefined) throw new RsqError('CONTEXT_MISSING', '批次结果缺少后续操作需要的上下文。', 5)
    return value
  }
  if (Object.keys(obj).length === 1 && typeof obj.$result === 'string') {
    const result = at(results, obj.$result)
    if (result === undefined) throw new RsqError('CONTEXT_MISSING', '服务端结果缺少后续操作需要的上下文。', 5)
    return result
  }
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !blocked.has(key)).map(([key, v]) => [key, resolve(v, input, results, item)]).filter(([, v]) => v !== undefined))
}
function equivalent(actual: unknown, expected: unknown, identifier = false) {
  const validId = (value: unknown) => typeof value === 'string' && /^[\w.-]+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value)
  return identifier && validId(actual) && validId(expected) ? String(actual) === String(expected) : isDeepStrictEqual(actual, expected)
}
export function workflowSchema(flow: Workflow) {
  return { ...flow, executable: flow.steps.every(s => catalog.operations.some(op => op.id === s.operationId && op.review === 'reviewed')),
    access: accessDescription(flow),
    confirmation: flow.effect === 'destructive' ? 'required' : 'not_required',
    context: flow.steps.map(step => ({ id: step.id, operationId: step.operationId, description: step.description,
      input: step.input, assertions: step.assertions ?? [], resources: step.resources ?? {}, prepare: step.prepare, transfer: step.transfer, verify: step.verify, forEach: step.forEach, authentication: step.authentication, creationVisibility: step.creationVisibility, readback: step.readback, collectPages: step.collectPages, expectAbsent: step.expectAbsent, waitBeforeMs: step.waitBeforeMs })),
    recovery: flow.recovery ?? '逐步执行；失败输出已完成步骤和资源 ID；写入结果未知时先读回核对，不自动重放或回滚。' }
}
export async function runWorkflow(ctx: Context, flow: Workflow, input: JsonObject, session: Session | null,
  options: { dryRun?: boolean; approved?: boolean; transport?: Transport; uploadTransfer?: UploadTransfer; storeSession?: OrganizationStore } = {}) {
  const output = await executeWorkflowSteps(ctx, flow, input, session, options)
  if (!options.dryRun && flow.resultSchema && !ajv.validate(flow.resultSchema as AnySchema, asObject(output).result)) throw new RsqError('RESPONSE_SCHEMA_MISMATCH', '业务结果与已声明的 resultSchema 不符；已完成步骤和资源 ID 保留，勿自动重放。', 5, {
    command: flow.command, failedStep: 'result', completedSteps: asObject(output).completedSteps, resources: asObject(output).resources,
    issues: ajv.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message })),
    writeOutcome: 'check-completed-steps', retry: 'manual-after-readback', automaticRollback: false,
  })
  return output
}
async function executeWorkflowSteps(ctx: Context, flow: Workflow, input: JsonObject, session: Session | null,
  options: { dryRun?: boolean; approved?: boolean; transport?: Transport; uploadTransfer?: UploadTransfer; storeSession?: OrganizationStore } = {}) {
  const validate = ajv.compile(flow.inputSchema)
  if (!validate(input)) throw new RsqError('INVALID_INPUT', '业务参数与 Schema 不符。', 2, {
    issues: validate.errors?.map(e => ({ path: e.instancePath, keyword: e.keyword, message: e.message })),
  })
  for (const step of flow.steps) validateTaskCreationVisibility(flow, step)
  if (flow.steps.some(step => step.prepare?.startsWith('workflow-statistics-'))) validateWorkflowStatisticsInput(input)
  if (flow.steps.some(step => step.prepare?.startsWith('identity-settings-'))) validateIdentitySettingsInput(input)
  if (flow.command.startsWith('task label ')) validateLabelPatch(input.patch == null ? Object.fromEntries(['name','color'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])) : asObject(input.patch))
  if (flow.steps.some(step => step.prepare?.startsWith('action-'))) validateActionInput(input)
  if (flow.steps.some(step => step.prepare?.startsWith('execution-'))) validateExecutionInput(input)
  if (flow.executor === 'arms-usage') validateUsageWorkflow(flow)
  if (flow.executor === 'organization') validateOrganizationWorkflow(flow)
  if (flow.executor === 'replay-navigation') validateReplayNavigationWorkflow(flow)
  if (flow.executor === 'file-library-quit') validateFileLibraryQuitWorkflow(flow)
  if (flow.executor === 'statistics-drilldown') validateStatisticsDrilldownWorkflow(flow)
  if (flow.executor === 'workflow-tasks') validateWorkflowTaskWorkflow(flow)
  if (flow.executor === 'workflow-datasheet') validateWorkflowDatasheetWorkflow(flow)
  if (flow.executor === 'task-type-transition') validateTaskTypeTransitionWorkflow(flow)
  if (flow.executor === 'project-card-batch') validateProjectCardBatchWorkflow(flow)
  if (flow.executor === 'replay-collection-config') validateReplayCollectionConfigWorkflow(flow)
  if (flow.executor === 'project-excel') validateProjectExcelWorkflow(flow)
  if (flow.executor === 'project-import') validateProjectImportWorkflow(flow)
  if (flow.executor === 'ai-config') validateAiConfigWorkflow(flow)
  if (flow.executor === 'developer') validateDeveloperWorkflow(flow)
  if (flow.executor === 'automation') { validateAutomationWorkflow(flow); validateAutomationInput(input) }
  if (flow.executor === 'document') { validateDocWorkflow(flow);if (Object.hasOwn(input,'content')) docDelta(input.content) }
  if (flow.executor === 'cloud-file') validateCloudFileWorkflow(flow)
  if (flow.executor === 'datasheet-admin') validateDatasheetAdminWorkflow(flow)
  if (flow.executor === 'datasheet-records') validateDatasheetRecordsWorkflow(flow)
  validateDatasheetTargetWorkflow(flow)
  if (flow.executor === 'appraisal') validateAppraisalWorkflow(flow)
  if (flow.executor === 'signature') validateSignatureWorkflow(flow)
  if (flow.executor === 'ai-market') validateAiMarketWorkflow(flow)
  if (flow.executor === 'okr-performance') validateOkrPerformanceWorkflow(flow)
  if (flow.executor === 'okr-indicators') validateOkrIndicatorWorkflow(flow)
  if (flow.executor === 'okr-statistics') validateOkrStatisticsWorkflow(flow)
  if (flow.executor === 'project-schedule') validateProjectScheduleWorkflow(flow)
  if (flow.executor === 'task-audit') validateTaskAuditWorkflow(flow)
  if (flow.executor === 'replay-topic') { validateReplayTopicWorkflow(flow); validateReplayTopicInput(input) }
  if (flow.steps.some(step => step.prepare === 'replay-question-set')) replayQuestionDelta(input)
  if (flow.executor === 'okr-alignment') validateOkrAlignmentWorkflow(flow)
  if (flow.executor === 'okr-actions') validateOkrActionWorkflow(flow)
  for (let index = 0; index < flow.steps.length; index++) if (flow.steps[index].expectAbsent) {
    const step = flow.steps[index], previous = flow.steps[index-1], op = catalog.operations.find(op => op.id === step.operationId), removed = catalog.operations.find(op => op.id === previous?.operationId)
    if (op?.method !== 'GET' || op.effect !== 'read' || op.route !== '/task/v3/kanban/risk/{id}' || removed?.method !== 'DELETE' || removed.route !== op.route || previous.prepare || step.prepare || JSON.stringify(previous.input) !== JSON.stringify(step.input) || step.forEach || step.collectPages || step.transfer || step.readback || step.resources) throw new RsqError('INVALID_CONTRACT', '缺失断言必须紧随同一风险资源的删除，仅接受已核对 GET 返回的 NOT_FOUND；不能把权限拒绝或分页缺失当作删除成功。', 6)
  }
  if (flow.executor === 'minder') { validateMinderWorkflow(flow);if (flow.minderAction === 'create' || flow.minderAction === 'replace') validateMinderDocument(input.document) }
  validateWorkflowStepObservation(flow)
  const operations = flow.steps.map(step => catalog.operations.find(op => op.id === step.operationId))
  if (operations.some(op => !op)) throw new RsqError('INVALID_CONTRACT', '业务步骤绑定了不存在的操作。')
  const rank = { read: 0, write: 1, destructive: 2 }
  if (operations.some(op => rank[op!.effect] > rank[flow.effect])) throw new RsqError('INVALID_CONTRACT', '业务编排的副作用不能弱于其步骤。')
  if (flow.steps.some(step => step.transfer) && flow.effect === 'read') throw new RsqError('INVALID_CONTRACT', '文件字节上传必须声明写入副作用。')
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index], op = operations[index]!
    validateWorkflowWait(flow, index)
    if (step.collectPages) { validateCursorPages(op, step.collectPages); if (step.forEach || step.transfer || step.resources || step.readback) throw new RsqError('INVALID_CONTRACT', '分页读取不能混合批次写入、传输或断言重读。', 6) }
    if (step.readback && (op.effect !== 'read' || op.idempotency !== 'idempotent' || !step.verify && !step.assertions?.length || step.forEach || step.transfer || step.resources || !Number.isInteger(step.readback.attempts) || step.readback.attempts < 1 || step.readback.attempts > 5 || !Number.isInteger(step.readback.delayMs) || step.readback.delayMs < 50 || step.readback.delayMs > 2000)) throw new RsqError('INVALID_CONTRACT', '仅可为无资源创建的幂等读取声明有界断言等待。', 6)
  }
  if (options.dryRun) return { dryRun: true, command: flow.command, effect: flow.effect,
    inputFields: Object.keys(input), steps: flow.steps.map((step, index) => ({ id: step.id, description: step.description,
      command: step.transfer ? 'HTTP 对象存储字节上传' : operations[index]!.command, effect: step.transfer ? 'write' : operations[index]!.effect,
      ...(step.creationVisibility && { creationVisibility: step.creationVisibility }), ...(step.collectPages && { collectPages: step.collectPages }), ...(step.readback && { readback: step.readback }), ...(step.waitBeforeMs && { waitBeforeMs: step.waitBeforeMs }),
      context: ['arms-usage', 'statistics-drilldown', 'workflow-tasks', 'datasheet-records', 'workflow-datasheet', 'task-type-transition', 'project-card-batch', 'replay-navigation', 'file-library-quit', 'replay-collection-config', 'project-excel', 'project-import', 'ai-config', 'automation', 'developer', 'okr-indicators', 'okr-performance', 'okr-statistics', 'ai-market', 'replay-topic', 'signature', 'project-schedule', 'document', 'cloud-file', 'datasheet-admin', 'appraisal', 'task-audit', 'okr-alignment', 'okr-actions'].includes(flow.executor ?? '') ? 'resolve-from-verified-http-context' : step.forEach ? 'iterate-fetched-context' : step.prepare ? 'build-from-fetched-context' : JSON.stringify(step.input).includes('$result') ? 'resolve-after-previous-step' : 'resolve-from-input',
    })) }
  if (operations.some(op => op!.review !== 'reviewed')) throw new RsqError('CONTRACT_UNREVIEWED', '业务包含待核对步骤，暂不能执行。', 6)
  if (flow.effect === 'destructive' && !options.approved) throw new RsqError('CONFIRMATION_REQUIRED', '此业务需要 --yes 确认。', 2)
  if (session && !flow.methods.includes(session.method)) throw new RsqError('LOGIN_METHOD_MISMATCH', '此业务不适用于当前登录方式。', 3)
  if (flow.executor === 'arms-usage') return runArmsUsage(ctx, flow, input, session, options)
  if (flow.executor === 'organization') return runOrganization(ctx, flow, input, session, options)
  if (flow.executor === 'replay-navigation') return runReplayNavigation(ctx, flow, input, session, options)
  if (flow.executor === 'file-library-quit') return runFileLibraryQuit(ctx, flow, input, session, options)
  if (flow.executor === 'statistics-drilldown') return runStatisticsDrilldown(ctx, flow, input, session, options)
  if (flow.executor === 'workflow-tasks') return runWorkflowTasks(ctx, flow, input, session, options)
  if (flow.executor === 'workflow-datasheet') return runWorkflowDatasheet(ctx, flow, input, session, options)
  if (flow.executor === 'task-type-transition') return runTaskTypeTransition(ctx, flow, input, session, options)
  if (flow.executor === 'project-card-batch') return runProjectCardBatch(ctx, flow, input, session, options)
  if (flow.executor === 'replay-collection-config') return runReplayCollectionConfig(ctx, flow, input, session, options)
  if (flow.executor === 'project-excel') return runProjectExcel(ctx, flow, input, session, options)
  if (flow.executor === 'project-import') return runProjectImport(ctx, flow, input, session, options)
  if (flow.executor === 'ai-config') return runAiConfig(ctx, flow, input, session, options)
  if (flow.executor === 'developer') return runDeveloper(ctx, flow, input, session, options)
  if (flow.executor === 'automation') return runAutomation(ctx, flow, input, session, options)
  if (flow.executor === 'minder') return runMinder(ctx,flow,input,session,options)
  if (flow.executor === 'document') return runDoc(ctx,flow,input,session,options)
  if (flow.executor === 'cloud-file') return runCloudFile(ctx,flow,input,session,options)
  if (flow.executor === 'datasheet-admin') return runDatasheetAdmin(ctx, flow, input, session, options)
  if (flow.executor === 'datasheet-records') return runDatasheetRecords(ctx, flow, input, session, options)
  if (flow.executor === 'appraisal') return runAppraisal(ctx, flow, input, session, options)
  if (flow.executor === 'signature') return runSignature(ctx, flow, input, session, options)
  if (flow.executor === 'ai-market') return runAiMarket(ctx, flow, input, session, options)
  if (flow.executor === 'okr-performance') return runOkrPerformance(ctx, flow, input, session, options)
  if (flow.executor === 'okr-indicators') return runOkrIndicator(ctx, flow, input, session, options)
  if (flow.executor === 'okr-statistics') return runOkrStatistics(ctx, flow, input, session, options)
  if (flow.executor === 'project-schedule') return runProjectSchedule(ctx, flow, input, session, options)
  if (flow.executor === 'task-audit') return runTaskAudit(ctx, flow, input, session, options)
  if (flow.executor === 'okr-alignment') return runOkrAlignment(ctx, flow, input, session, options)
  if (flow.executor === 'replay-topic') return runReplayTopic(ctx, flow, input, session, options)
  if (flow.executor === 'okr-actions') return runOkrAction(ctx, flow, input, session, options)
  // Validate all input-only steps before dispatching any request. Later steps
  // may depend on server-assigned IDs, and are validated again once resolved.
  for (let i = 0; i < flow.steps.length; i++) if (!flow.steps[i].prepare && !flow.steps[i].transfer && !flow.steps[i].forEach && !JSON.stringify(flow.steps[i].input).includes('$result')) {
    const args = resolve(flow.steps[i].input, input, {}) as JsonObject
    await runOperation(ctx, operations[i]!, args, null, { dryRun: true })
    await validateUploadFiles(operations[i]!, args)
  }
  const results: JsonObject = {}, completed: string[] = [], skipped: string[] = [], resources: Record<string, string> = {}
  if (flow.steps.some(step => step.transfer)) results.localUpload = await inspectUpload(input.localFile, input.fileName)
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i], op = operations[i]!
    const effect = step.transfer ? 'write' : op.effect
    let responseReceived = false, completedIterations = 0
    try {
      if (step.waitBeforeMs) await delay(step.waitBeforeMs)
      if (step.transfer) {
        if (step.transfer !== 'storage-upload' || step.prepare || step.forEach || op.route !== '/task/sts/token/oss' || !results.secondPass) throw new RsqError('INVALID_CONTRACT', '上传步骤缺少明确的临时权限和秒传上下文。', 5)
        if (asObject(results.secondPass).secondPass === true) { skipped.push(step.id); continue }
        results[step.id] = await (options.uploadTransfer ?? uploadToStorage)(results.certificate, results.localUpload as LocalUpload, checkpoint => {
          if (typeof checkpoint.objectPath === 'string') resources.objectPath = checkpoint.objectPath
          if (typeof checkpoint.uploadId === 'string') resources.uploadId = checkpoint.uploadId
        })
        responseReceived = true; completed.push(step.id); continue
      }
      const args = step.prepare ? step.prepare === 'company-usage-list' ? prepareCompanyUsage(input, results, session) : step.prepare.startsWith('okr-views-') ? prepareOkrView(step.prepare, input, results, session) : step.prepare.startsWith('company-roles-') ? prepareCompanyRole(step.prepare, input, results, session) : step.prepare.startsWith('identity-settings-') ? prepareIdentitySettings(step.prepare, input, results, session) : step.prepare.startsWith('archive-') ? prepareArchive(step.prepare, input, results, session) : step.prepare.startsWith('okr-cycle-') ? prepareOkrCycle(step.prepare, input, results) : step.prepare.startsWith('cooperation-') ? prepareCooperation(step.prepare, input, results) : step.prepare.startsWith('project-context-') ? prepareProjectContext(step.prepare,input,results,session) : step.prepare.startsWith('search-') ? prepareSearch(step.prepare, input, results) : step.prepare.startsWith('efficiency-') ? prepareEfficiency(step.prepare, input, results) : step.prepare.startsWith('task-hours-') ? prepareTaskHours(step.prepare, input, results, session) : step.prepare.startsWith('contact-') ? prepareContact(step.prepare, input, results, session) : step.prepare.startsWith('notice-') ? prepareNotification(step.prepare, input, results, session) : step.prepare.startsWith('personal-') ? preparePersonalResource(step.prepare, input, results, session) : step.prepare.startsWith('workspace-task-') ? prepareWorkspaceTask(step.prepare, input, results, session) : step.prepare.startsWith('task-business-') ? prepareTaskBusiness(step.prepare, input, results, session) : step.prepare.startsWith('file-item-') ? prepareFileItem(step.prepare, input, results, session) : step.prepare.startsWith('execution-') ? prepareExecution(step.prepare, input, results, session) : step.prepare.startsWith('task-context-') ? prepareTaskTemplate(step.prepare, input, results, session) : step.prepare.startsWith('application-') ? prepareApplication(step.prepare, input, results, session) : step.prepare.startsWith('replay-created-tasks-') ? prepareReplayCreatedTasks(step.prepare, input, results, session) : step.prepare.startsWith('replay-okr-relations-') ? prepareReplayOkrRelations(step.prepare, input, results, session) : step.prepare.startsWith('replay-relations-') ? prepareReplayRelations(step.prepare, input, results, session) : step.prepare.startsWith('replay-push-rule-') ? prepareReplayPushRule(step.prepare, input, results, session) : step.prepare.startsWith('replay-stat-') ? prepareReplayStatistics(step.prepare, input, results) : step.prepare.startsWith('replay-') ? prepareReplay(step.prepare, input, results, session) : step.prepare.startsWith('library-') ? prepareFileLibrary(step.prepare, input, results, session) : step.prepare.startsWith('deliverable-') ? prepareDeliverable(step.prepare, input, results) : step.prepare.startsWith('okr-') ? prepareOkrContext(step.prepare, input, results, session) : step.prepare.startsWith('workflow-') ? prepareWorkflowContext(step.prepare, input, results, session) : step.prepare.startsWith('collection-fields-') ? prepareCollectionFields(step.prepare, input, results, session) : step.prepare.startsWith('collection-') ? prepareProjectCollection(step.prepare, input, results, session) : step.prepare.startsWith('statistics-') ? prepareStatistics(step.prepare, input, results, session) : step.prepare.startsWith('action-') ? prepareAction(step.prepare, input, results) : prepareDatasheet(step.prepare, input, results, session) : undefined
      if (args === null) { skipped.push(step.id); continue }
      if (step.prepare) {
        Object.assign(resources, asObject(asObject(results.prepared).resources))
        if (typeof asObject(results.prepared).messageId === 'string') resources.messageId = String(asObject(results.prepared).messageId)
      }
      const items = step.forEach ? at(results, step.forEach.path) : [undefined]
      if (!Array.isArray(items) || step.forEach && (step.prepare || !Number.isSafeInteger(step.forEach.limit) || step.forEach.limit < 1 || step.forEach.limit > 1000 || items.length > step.forEach.limit)) throw new RsqError('INVALID_CONTRACT', '批次上下文或迭代数量与契约不符。', 5)
      const responses: unknown[] = []
      if (step.forEach) results[step.id] = responses
      for (const item of items) {
        responseReceived = false
        const resolved = args ?? resolve(step.input, input, results, item) as JsonObject
        let result: unknown
        try {
          result = step.collectPages ? await collectOperationPages(ctx, op, resolved, session, step.collectPages, options.transport) : await readCreatedTask(flow, step, op, resolved, input, results, completed, item, () => runOperation(ctx, op, resolved, session, { approved: options.approved, transport: options.transport }))
          if (step.expectAbsent) throw new RsqError('BUSINESS_ASSERTION_FAILED', '删除后资源仍可独立读取，不能将受理回执当作删除成功。', 5)
        } catch (error) {
          if (!step.expectAbsent || !(error instanceof RsqError) || error.code !== 'NOT_FOUND') throw error
          result = { absent: true }
        }
        responseReceived = true
        responses.push(result)
        if (!step.forEach) results[step.id] = result
        for (const [name, pointer] of Object.entries(step.resources ?? {})) {
          const value = at(result, pointer)
          if ((typeof value === 'string' || typeof value === 'number') && /^[\w.-]{1,128}$/.test(String(value))) resources[step.forEach ? name + completedIterations : name] = String(value)
        }
        completedIterations++
      }
      completed.push(step.id)
      const verify = () => {
        if (step.verify === 'company-usage') verifyCompanyUsage(results, session)
        if (step.verify === 'okr-views') verifyOkrView(input, results, step.id, session)
        if (step.verify === 'company-role') verifyCompanyRole(input, results, step.id, session)
        if (step.verify === 'identity-settings') verifyIdentitySettings(results, step.id, session)
        if (step.verify === 'archive') verifyArchive(input, results, step.id)
        if (step.verify === 'datasheet') verifyDatasheet(results)
        if (step.verify === 'statistics') verifyStatistics(results)
        if (step.verify === 'action') verifyAction(results, step.id)
        if (step.verify === 'datasheet-import') verifyDatasheetImport(input, results)
        if (step.verify === 'project-collection') verifyProjectCollection(input, results, step.id)
        if (step.verify === 'project-context') verifyProjectContext(input,results,step.id)
        if (step.verify === 'workflow-context') verifyWorkflowContext(input, results, step.id)
        if (step.verify === 'workflow-lifecycle') verifyWorkflowLifecycle(input, results, step.id)
        if (step.verify === 'execution') verifyExecution(input, results, step.id)
        if (step.verify === 'task-template') verifyTaskTemplate(input, results, step.id)
        if (step.verify === 'okr-context') verifyOkrContext(input, results, step.id)
        if (step.verify === 'okr-cycles') verifyOkrCycle(input, results)
        if (step.verify === 'deliverable') verifyDeliverable(input, results, step.id)
        if (step.verify === 'file-library') verifyFileLibrary(input, results, step.id)
        if (step.verify === 'notification') verifyNotification(input, results, step.id)
        if (step.verify === 'contact') verifyContact(input, results, step.id)
        if (step.verify === 'efficiency') verifyEfficiency(input, results, step.id)
        if (step.verify === 'task-hours') verifyTaskHours(input, results, step.id)
        if (step.verify === 'personal-resource') verifyPersonalResource(input, results, step.id, session)
        if (step.verify === 'task-business') verifyTaskBusiness(input, results, step.id)
        if (step.verify === 'file-item') verifyFileItem(input, results, step.id, session)
        if (step.verify === 'replay-push-rule') verifyReplayPushRule(input, results, step.id)
        if (step.verify === 'replay') verifyReplay(input, results, step.id)
        if (step.verify === 'application') verifyApplication(results, step.id)
        for (const result of responses) for (const assertion of step.assertions ?? []) {
          if (assertion.whenInput && at(input, assertion.whenInput) === undefined) continue
          const actual = at(result, assertion.path)
          const missing = assertion.exists && (actual === undefined || actual === null)
          const differs = Object.hasOwn(assertion, 'equals') && !equivalent(actual, resolve(assertion.equals, input, results), assertion.compare === 'identifier')
          const excluded = assertion.excludes && (!Array.isArray(actual) || actual.some(item => equivalent(at(item, assertion.excludes!.path), resolve(assertion.excludes!.equals, input, results), /id$/i.test(assertion.excludes!.path))))
          const absent = assertion.contains && (!Array.isArray(actual) || !actual.some(item => Object.entries(assertion.contains!.match).every(([path, expected]) => equivalent(at(item, path), resolve(expected, input, results), /id$/i.test(path)))))
          if (missing || differs || excluded || absent) {
            throw new RsqError('BUSINESS_ASSERTION_FAILED', '读取结果未满足业务断言。', 5)
          }
        }
      }
      for (let attempt = 1; ; attempt++) {
        try { verify(); break }
        catch (error) {
          if (!(error instanceof RsqError) || error.code !== 'BUSINESS_ASSERTION_FAILED' || !step.readback || attempt >= step.readback.attempts) throw error
          await delay(step.readback.delayMs)
          const value = await runOperation(ctx, op, args ?? resolve(step.input, input, results) as JsonObject, session, { transport: options.transport })
          results[step.id] = value; responses[0] = value
        }
      }
    } catch (error) {
      const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '业务步骤未能完成。')
      const uncertain = effect !== 'read' && !responseReceived && (['NETWORK_ERROR', 'TIMEOUT', 'UNEXPECTED_RESPONSE', 'RESPONSE_SCHEMA_MISMATCH', 'STORAGE_TRANSFER_UNKNOWN'].includes(failure.code)
        || failure.code === 'HTTP_ERROR' && Number(failure.details?.httpStatus) >= 500
        || failure.code === 'BUSINESS_ERROR' && /^5\d{5}$/.test(String(failure.details?.upstreamCode)))
      throw new RsqError(failure.code, failure.message, failure.exit, {
        workflow: flow.id, failedStep: step.id, completedSteps: completed, resources,
        ...(step.forEach && { completedIterations, ...(!responseReceived && { failedItemIndex: completedIterations }) }),
        writeOutcome: uncertain ? 'unknown' : responseReceived && effect !== 'read' ? 'response-received' : 'check-completed-steps',
        retry: 'manual-after-readback', automaticRollback: false,
        ...(failure.details && { cause: failure.details }),
      })
    }
  }
  try {
    const output = { command: flow.command, completedSteps: completed, ...(skipped.length && { skippedSteps: skipped }), resources, result: flow.outputAdapter === 'workflow-templates' ? describeWorkflowTemplates(input, results) : flow.outputAdapter === 'company-okr-statistics' ? describeCompanyOkrStatistics(results) : flow.outputAdapter === 'workflow-statistics' ? describeWorkflowStatistics(input, results, session) : flow.outputAdapter === 'company-usage' ? describeCompanyUsage(input, results, session) : flow.outputAdapter === 'okr-views' ? describeOkrView(input, results, session) : flow.outputAdapter === 'company-role' ? describeCompanyRole(input, results, session) : flow.outputAdapter === 'identity-settings' ? describeIdentitySettings(results, session) : flow.outputAdapter === 'archive' ? describeArchive(input, results, session) : flow.outputAdapter === 'collection-fields' ? describeCollectionFields(input, results, session) : flow.outputAdapter === 'replay-created-tasks' ? describeReplayCreatedTasks(input, results, session) : flow.outputAdapter === 'replay-okr-relations' ? describeReplayOkrRelations(input, results, session) : flow.outputAdapter === 'replay-relations' ? describeReplayRelations(input, results, session) : flow.outputAdapter === 'replay-template-components' ? describeReplayTemplateComponents(input, results) : flow.outputAdapter === 'replay-statistics' ? describeReplayStatistics(input, results) : flow.outputAdapter === 'okr-cycles' ? describeOkrCycles(input, results) : flow.outputAdapter === 'cooperation' ? describeCooperation(input, results) : flow.outputAdapter === 'project-context' ? describeProjectContext(input,results) : flow.outputAdapter === 'search' ? describeSearch(input, results) : flow.outputAdapter === 'efficiency' ? describeEfficiency(input, results) : flow.outputAdapter === 'task-hours' ? describeTaskHours(input, results) : flow.outputAdapter === 'contact' ? describeContact(input, results) : flow.outputAdapter === 'notifications' ? describeNotifications(input, results, session, ['okr','workflow','project'].includes(flow.command.split(' ')[1]) ? flow.command.split(' ')[1] : 'common') : flow.outputAdapter === 'personal-resources' ? describePersonalResources(input, results, flow.command.startsWith('favorite ')) : flow.outputAdapter === 'file-items' ? describeFileItems(input, results) : flow.outputAdapter === 'task-attachments' ? describeTaskAttachments(input, results) : flow.outputAdapter === 'execution-workspace' ? describeExecution(input, results, session) : flow.outputAdapter === 'task-template' ? describeTaskTemplate(results) : flow.outputAdapter === 'workflow-arrangement' ? describeWorkflowArrangement(results) : flow.outputAdapter === 'workflow-instance' ? describeWorkflowInstance(results) : flow.outputAdapter === 'access-context' ? describeApplicationAccess(results) : flow.outputAdapter === 'replay-push-rules' ? describeReplayPushRules(input, results) : flow.outputAdapter === 'replay-features' ? describeReplayFeatures(input, results) : flow.outputAdapter === 'replay-score' ? describeReplayScore(results) : flow.outputAdapter === 'replay-template' ? describeReplayTemplate(results) : flow.outputAdapter?.startsWith('deliverable-') ? describeDeliverable(input, results, flow.outputAdapter) : flow.outputAdapter?.startsWith('okr-') ? describeOkrContext(results, ['okr-planning', 'okr-superiors'].includes(flow.outputAdapter), flow.outputAdapter === 'okr-superiors') : flow.outputAdapter === 'workflow-configuration' ? describeWorkflowConfiguration(results) : flow.outputAdapter?.startsWith('collection-') ? describeProjectCollection(results, flow.outputAdapter) : flow.outputAdapter === 'datasheet-description' ? describeDatasheet(results) : flow.outputAdapter === 'datasheet-import' ? describeDatasheetImport(results) : resolve(flow.output, input, results) }
    Object.assign(resources, asObject(asObject(results.prepared).resources))
    return output
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '业务结果无法整理。')
    Object.assign(resources, asObject(asObject(results.prepared).resources))
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: 'output', completedSteps: completed,
      resources, writeOutcome: 'check-completed-steps', retry: 'manual-after-readback', automaticRollback: false })
  }
}
