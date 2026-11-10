import { isDeepStrictEqual } from 'node:util'
import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import type { Workflow } from './workflows.js'

export const projectImportActions = ['context', 'list', 'active', 'inspect'] as const
export type ProjectImportAction = typeof projectImportActions[number]
type Route = [string, string, string]
const root = '/task/agent/v1/project-create/tasks'
const statuses = ['generating', 'preview_ready', 'created', 'failed', 'cancelled']
function fail(message: string, code = 'CONTEXT_MISSING'): never { throw new RsqError(code, message, code === 'FORBIDDEN' ? 4 : 5) }
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value
  return fail('项目导入记录没有精确的用户或公司 ID。')
}
function text(value: unknown): string { return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : fail('项目导入记录缺少有效文本。') }
function unwrap(value: unknown): unknown {
  const envelope = asObject(value)
  if (envelope.code !== 200 || !Object.hasOwn(envelope, 'data')) fail('项目导入 HTTP 未返回成功业务回执。', 'BUSINESS_ERROR')
  return envelope.data
}
export function projectImportSteps(action: ProjectImportAction): Route[] {
  const identity: Route = ['identity', 'GET', '/task/login/authAjax'], list: Route = ['tasks', 'GET', root]
  if (action === 'list') return [identity, list]
  if (action === 'active' || action === 'context') return [identity, list, ['active', 'GET', root + '/active']]
  return [identity, list, ['task', 'GET', root + '/{taskId}']]
}
export function validateProjectImportWorkflow(flow: Workflow) {
  if (!projectImportActions.includes(flow.projectImportAction!)) fail('未知项目导入业务操作。', 'INVALID_CONTRACT')
  const expected = projectImportSteps(flow.projectImportAction!)
  if (flow.executor !== 'project-import' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== name || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.collectPages || step.resources || step.transfer || step.authentication || step.readback || step.waitBeforeMs || step.expectAbsent
  })) fail('项目导入步骤与已核对 HTTP 协议不一致。', 'INVALID_CONTRACT')
}

export async function runProjectImport(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateProjectImportWorkflow(flow)
  const session = requireSession(supplied), completed: string[] = [], action = flow.projectImportAction!
  let phase = 'identity'
  const call = async (name: string, args: JsonObject = {}) => {
    phase = name
    const op = catalog.operations.find(op => op.id === flow.steps.find(step => step.id === name)?.operationId)
    if (!op) fail('缺少已核对的项目导入 HTTP 步骤。', 'INVALID_CONTRACT')
    const result = await runOperation(ctx, op, args, session, options); completed.push(name); return result
  }
  const task = (value: unknown) => {
    const row = asObject(value)
    if (id(row.enterpriseId) !== session.identity.teamId || id(row.userId) !== session.identity.userId) fail('导入任务不属于当前用户和公司。', 'FORBIDDEN')
    if (row.mode !== input.mode || !statuses.includes(String(row.status))) fail('导入任务模式或状态与当前请求不一致。')
    if (typeof row.taskId !== 'string' || !/^[a-f0-9]{24}$/.test(row.taskId)) fail('导入任务 ID 格式无效。')
    const source = row.source === 'rishiqing_upload' ? 'local_upload' : row.source === 'wps_current_sheet' ? 'host_current_document' : row.source
    if (source !== 'local_upload' && source !== 'host_current_document') fail('未知项目导入来源。')
    text(row.conversationId)
    for (const field of ['createdAt', 'updatedAt']) if (typeof row[field] !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(String(row[field])) || !Number.isFinite(Date.parse(String(row[field])))) fail('导入任务时间缺少明确时区。')
    if (Date.parse(String(row.updatedAt)) < Date.parse(String(row.createdAt))) fail('导入任务更新时间早于创建时间。')
    const result: JsonObject = Object.fromEntries(['taskId', 'enterpriseId', 'userId', 'conversationId', 'mode', 'status', 'fileName', 'sourceTitle', 'requirement', 'projectName', 'projectJsonItemId', 'createdProjectId', 'stats', 'error', 'createdAt', 'updatedAt'].filter(key => row[key] !== undefined).map(key => [key, row[key]]))
    result.source = source
    if (row.projectJsonItem != null) {
      const preview = asObject(row.projectJsonItem), validation = asObject(preview.validation), project = asObject(preview.project)
      if (preview.id !== row.projectJsonItemId || preview.type !== 'project_json' || preview.status !== 'completed' || preview.partial === true || validation.valid !== true) fail('导入预览缺少一致、完整、有效的项目 JSON；不允许将残缺预览当作可应用项目。', 'PREVIEW_INVALID')
      text(project.name)
      if (!Array.isArray(project.plans)) fail('项目预览缺少模块数组。', 'PREVIEW_INVALID')
      let cardCount = 0, taskCount = 0
      for (const planValue of project.plans) {
        const plan = asObject(planValue); text(plan.name)
        if (!Array.isArray(plan.cards)) fail('项目预览缺少卡片数组。', 'PREVIEW_INVALID')
        cardCount += plan.cards.length
        for (const cardValue of plan.cards) { const card = asObject(cardValue); text(card.name); if (!Array.isArray(card.tasks)) fail('项目预览缺少任务数组。', 'PREVIEW_INVALID'); taskCount += card.tasks.length }
      }
      result.projectJsonItem = Object.fromEntries(['id', 'type', 'status', 'project', 'validation', 'sourceItemId', 'quickReasonCodes', 'quickAssumptions', 'version', 'mergeRisks'].filter(key => preview[key] !== undefined).map(key => [key, preview[key]]))
      result.previewCounts = { moduleCount: project.plans.length, cardCount, taskCount }
      result.previewPersisted = true
    }
    result.businessResultVerified = false
    result.statusAuthority = 'client-writable-task-record'
    return result
  }
  const done = (result: JsonObject) => ({ workflow: flow.command, completedSteps: completed, resources: {}, result })
  try {
    const who = asObject(await call('identity'))
    if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('项目导入身份与当前 profile 不一致。', 'IDENTITY_CHANGED')
    const value = unwrap(await call('tasks', { query: { mode: input.mode } }))
    if (!Array.isArray(value)) fail('项目导入列表不是完整数组。')
    const items = value.map(task), seen = new Set<string>()
    let previous = Infinity
    for (const row of items) {
      if (seen.has(String(row.taskId))) fail('项目导入目录出现重复任务。', 'CONTEXT_CONFLICT')
      seen.add(String(row.taskId))
      const updated = Date.parse(String(row.updatedAt))
      if (updated > previous) fail('项目导入列表不符合服务端更新时间排序。', 'CONTEXT_CONFLICT')
      previous = updated
    }
    if (action === 'list') return done({ mode: input.mode, items, total: items.length, complete: true, pagination: 'unpaginated-owner-and-mode-scoped', businessResultVerified: false })
    if (action === 'inspect') {
      const listed = items.find(row => row.taskId === input.taskId)
      if (!listed) fail('任务不在当前用户、公司和模式的实际目录中。', 'FORBIDDEN')
      const inspected = task(unwrap(await call('task', { path: { taskId: input.taskId } })))
      const { projectJsonItem, previewCounts, previewPersisted, ...directoryFields } = inspected
      if (!isDeepStrictEqual(listed, directoryFields)) fail('导入任务在目录读取后发生变化，请重新查询；不自动重放或更新状态。', 'CONTEXT_CONFLICT')
      return done(inspected)
    }
    const activeValue = unwrap(await call('active', { query: { mode: input.mode } })), active = activeValue === null ? null : task(activeValue)
    const expectedActive = items.find(row => row.status === 'generating') ?? null
    if (active && active.status !== 'generating' || !isDeepStrictEqual(active, expectedActive)) fail('活动导入任务与完整目录不一致，请重新读取。', 'CONTEXT_CONFLICT')
    if (action === 'active') return done({ mode: input.mode, task: active, businessResultVerified: false })
    return done({ mode: input.mode, teamId: session.identity.teamId, userId: session.identity.userId, tasks: items, activeTask: active, modes: ['quick', 'standard'], sources: ['local_upload', 'host_current_document'], completion: 'created 仅是客户端可写任务记录；还须独立核对项目、模块、卡片和任务。', transport: 'https', relatedCommands: ['project import tasks list', 'project import task inspect', 'project import active'], limitations: ['此处只读取 HTTP 任务中心和已持久化预览，不发起或证明模型执行。', '普通项目 Excel/MPP 上传与 Excel 转项目是不同入口，分别验收。', '不读取其他用户、其他公司或另一模式的任务；无权限不会通过人工猜 ID 绕过。'], businessResultVerified: false })
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('BUSINESS_ASSERTION_FAILED', '项目导入上下文读取失败。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, mode: input.mode, taskId: input.taskId ?? null, taskWritesAttempted: false, automaticRetry: false, cause: original.details })
  }
}
