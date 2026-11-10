import { resolveOwnSignature } from './signature.js'
import { createHash } from 'node:crypto'
import { asObject, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { companyDirectoryUsers } from './contact.js'
import type { Workflow } from './workflows.js'

export type TaskAuditAction = 'inspect' | 'submit' | 'act' | 'reviewers'
type Route = [string, string, string]
const base = '/task/api/v3/task/template/field'
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const failed = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : failed('审核字段上下文不是有界列表。')
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : failed('审核上下文缺少精确 ID。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const permission = (value: JsonObject, key: string) => { if (asObject(value.editControl)[key] !== true) throw new RsqError('RESOURCE_FORBIDDEN', '当前审核字段不允许此操作。', 4, { permission: key }) }

export function taskAuditSteps(action: TaskAuditAction): Route[] {
  const start: Route[] = [['identity', 'GET', '/task/login/authAjax'], ['task', 'GET', '/task/api/v3/task'], ['project', 'GET', '/task/v1/kanbanCrud'], ['permissions', 'GET', '/task/api/v3/task/editcontrol'], ['fields', 'GET', '/task/api/v3/task/template'], ['condition', 'GET', base + '/getComplexId']]
  if (action === 'inspect') return start
  const end: Route[] = [['verifiedFields', 'GET', '/task/api/v3/task/template'], ['verifiedTask', 'GET', '/task/api/v3/task']]
  if (action === 'submit') return [...start, ['check', 'POST', base + '/audit/submit/check'], ['changed', 'PUT', base + '/audit/submit'], ...end]
  if (action === 'reviewers') return [...start, ['directory', 'GET', '/task/v1/department/list'], ['changed', 'PUT', base + '/auditUser'], ...end]
  return [...start, ['signature', 'GET', '/task/file/signature/getFront'], ['signatureFile', 'GET', '/task/v1/folder/file'], ['changed', 'PUT', base + '/audit'], ...end, ['removed', 'DELETE', '/task/api/v3/task'], ['recycle', 'GET', '/task/v1/recycleBin/list']]
}
export function validateTaskAuditWorkflow(flow: Workflow) {
  if (!['inspect', 'submit', 'act', 'reviewers'].includes(flow.taskAuditAction ?? '')) throw new RsqError('INVALID_CONTRACT', '未登记的任务审核业务。', 6)
  const expected = taskAuditSteps(flow.taskAuditAction!)
  if (flow.executor !== 'task-audit' || expected.length !== flow.steps.length || expected.some(([name, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return name !== step.id || method !== op?.method || route !== op.route || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.collectPages || step.resources || step.authentication || step.readback
  })) throw new RsqError('INVALID_CONTRACT', '任务审核步骤与已核对的 HTTP 协议不一致。', 6)
}
function nodeList(config: JsonObject, conditionId?: unknown): JsonObject[] {
  if (config.auditMode !== 1 && config.auditMode !== 'complex') return rows(config.simpleList ?? [])
  if (config.auditStatus && !['pending', 'reject'].includes(String(config.auditStatus))) return rows(config.simpleList ?? [])
  if (conditionId == null) return []
  const group = rows(config.complexList).find(row => same(row.id, conditionId))
  if (!group) failed('服务端匹配的条件分支不属于当前审核字段。')
  return rows(group!.audits)
}
const safeNode = (node: JsonObject) => ({ id: id(node.id), name: node.name, status: node.status, userType: node.userType, nodeType: node.nodeType, editControl: node.editControl, users: rows(node.users ?? []).map(user => ({ id: id(user.id), name: user.showName, status: user.status, content: user.content, isSpecial: user.isSpecial })) })
function selectedField(value: unknown, fieldId: unknown) {
  const field = rows(asObject(value).templateFields).find(field => same(field.id, fieldId))
  if (!field || Number(field.type) !== 31 || field.isHidden === true) throw new RsqError('RESOURCE_NOT_VISIBLE', '指定字段不是当前任务可见的审核字段。', 4)
  return field
}
export async function runTaskAudit(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateTaskAuditWorkflow(flow)
  const session = requireSession(supplied), action = flow.taskAuditAction!, completed: string[] = [], skipped: string[] = [], resources: Record<string, string> = { taskId: String(input.taskId) }
  let phase = 'identity', pending = false, writeCompleted = false
  const call = async (name: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === name), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) throw new RsqError('INVALID_CONTRACT', '调用了未声明的任务审核步骤。', 6)
    phase = name; pending = op.effect !== 'read'
    const result = await runOperation(ctx, op, args, session, { transport: options.transport, approved: options.approved })
    if (name === 'changed' || name === 'removed') writeCompleted = true
    completed.push(name); pending = false; return result
  }
  try {
    const identity = asObject(await call('identity'))
    if (!same(identity.id, session.identity.userId) || !same(asObject(identity.team).id, session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED', '服务端身份或公司与当前 profile 不符，请重新登录。', 3)
    const where = input.projectId == null ? { module: 'common', siteId: 'common' } : { module: 'project', siteId: String(input.projectId) }
    const taskQuery = { id: input.taskId, ...where }, fieldQuery = { taskId: input.taskId, ...where }
    const task = asObject(await call('task', { query: taskQuery }))
    if (!same(task.id, input.taskId) || task.isDisplay === false || input.projectId != null && !same(asObject(task.from).projectId, input.projectId)) failed('任务详情与目标或项目归属不一致。')
    const projectId = input.projectId ?? asObject(task.from).projectId
    if (projectId != null) { const project = asObject(await call('project', { query: { id: id(projectId) } })); if (!same(project.id, projectId)) failed('任务项目与当前可见项目不一致。') } else skipped.push('project')
    const permissions = asObject(await call('permissions', { query: fieldQuery }))
    if (!same(permissions.taskId, input.taskId) || permissions.module !== where.module || !same(permissions.siteId, where.siteId)) failed('独立权限响应不属于当前任务场景。')
    const field = selectedField(await call('fields', { query: fieldQuery }), input.fieldId), config = asObject(asObject(field.audits)[String(input.stage)]), suffix = input.stage === 'confirm' ? 'Confirm' : 'Completion'
    if (input.stage === 'confirm' && config.enable !== true || input.stage === 'completion' && ![0, 1, 'simple', 'complex'].includes(config.auditMode as number | string)) throw new RsqError('RESOURCE_FORBIDDEN', '此任务审核阶段未启用或缺少实际配置。', 4)
    resources.fieldId = id(field.id)
    let conditionId: unknown
    if (input.stage === 'completion' && (config.auditMode === 1 || config.auditMode === 'complex') && ['pending', 'reject'].includes(String(config.auditStatus))) conditionId = asObject(await call('condition', { query: { taskId: input.taskId, fieldId: input.fieldId } })).complexId
    else skipped.push('condition')
    const nodes = nodeList(config, conditionId), version = hash({ fieldId: field.id, stage: input.stage, config, editControl: field.editControl })
    const describe = (currentField = field, currentConfig = config, currentNodes = nodes) => ({ taskId: String(task.id), fieldId: id(currentField.id), name: currentField.name, stage: input.stage, status: currentConfig.auditStatus, contextVersion: hash({ fieldId: currentField.id, stage: input.stage, config: currentConfig, editControl: currentField.editControl }),
      buttons: currentField.editControl, nodes: currentNodes.map(safeNode), conditionId: conditionId == null ? null : id(conditionId), contentRequirement: currentConfig.contentRequirement, signatureRequirement: currentConfig.signatureRequirement,
      effects: { autoActionOnReject: currentConfig.autoActionOnReject ?? null, forbidResubmitAfterPass: currentConfig.forbidResubmitAfterPass === true }, history: Array.isArray(currentConfig.actionList) ? currentConfig.actionList.map(raw => { const item = asObject(raw); return { id: item.id, status: item.status, explanation: item.explanation, dateCreated: item.dateCreated, userId: asObject(item.userVO).id, signatureFileId: asObject(item.fileVO).id } }) : [],
      concurrency: 'fresh-http-context-without-server-compare-and-swap' })
    if (action === 'inspect') return { command: flow.command, completedSteps: completed, skippedSteps: skipped, resources, result: describe() }
    if (input.expectedVersion != null && input.expectedVersion !== version) throw new RsqError('CONTEXT_CONFLICT', '审核上下文已变化；请重新读取当前状态后决定操作。', 5)
    let target: JsonObject | undefined
    if (action === 'submit') {
      permission(field, 'canSubmit' + suffix)
      if (task.isClose === true) throw new RsqError('RESOURCE_FORBIDDEN', '已关闭任务不能提交审核。', 4)
      if (!['pending', 'reject', 'passed'].includes(String(config.auditStatus))) invalid('当前审核状态不能提交。')
      const body = { taskId: input.taskId, taskTemplateFieldId: input.fieldId, stepType: input.stage }
      if (input.stage === 'confirm') { const checked = asObject(await call('check', { body })); if (checked.canSubmit !== true) throw new RsqError('REQUIRED_FIELDS', typeof checked.message === 'string' ? checked.message : '请先补齐审核要求的字段。', 2) } else skipped.push('check')
      if (nodes.some(node => ['memberOptional', 'creatorOptional'].includes(String(node.userType)) && !rows(node.users).length)) invalid('自选审核节点尚未选择审批人；请先执行 task audit reviewers set。')
      await call('changed', { body })
    } else if (action === 'reviewers') {
      target = nodes.find(node => same(node.id, input.nodeId))
      if (!target) invalid('审核节点不属于当前任务、字段和条件分支。')
      permission(target!, 'canChangeMember')
      if (!['memberOptional', 'creatorOptional'].includes(String(target!.userType)) || !['pending', 'reject', 'passed'].includes(String(config.auditStatus))) throw new RsqError('RESOURCE_FORBIDDEN', '此节点不能自选审批人，或已开始审核。', 4)
      const available = companyDirectoryUsers(await call('directory', { query: { cliContext: 'fresh' } }))
      if ((input.userIds as string[]).some(selected => !available.some(user => same(user.id, selected)))) throw new RsqError('RESOURCE_FORBIDDEN', '所选审批人不在当前公司成员中。', 4)
      await call('changed', { body: { auditId: id(target!.id), userIds: (input.userIds as string[]).join(',') } })
    } else {
      const kind = String(input.action), key = kind === 'agree' ? 'canAgree' : kind === 'refuse' ? 'canRefuse' : 'canReverse'
      permission(field, key + suffix)
      const doing = nodes.filter(node => node.status === 'doing')
      if (doing.length !== 1 || config.auditStatus !== 'doing') failed('当前审核没有唯一进行中的节点。')
      target = doing[0]; resources.auditNodeId = id(target.id)
      if (input.nodeId != null && !same(input.nodeId, target.id)) throw new RsqError('CONTEXT_CONFLICT', '正在处理的审核节点已变化。', 5)
      if (kind !== 'reverse' && !rows(target.users).some(user => same(user.id, session.identity.userId) && user.status === 'doing')) throw new RsqError('RESOURCE_FORBIDDEN', '本人不是当前待处理审批人。', 4)
      const needsSignature = ['agree', 'refuse'].includes(kind) && (config.signatureRequirement === 'always' || config.signatureRequirement === (kind === 'agree' ? 'onlyPassed' : 'onlyReject'))
      if (needsSignature && input.useLastSignature !== true) invalid('此操作要求本人签名；请明确设置 useLastSignature 使用本人最近的任务签名。')
      let signatureFileId: string | undefined
      if (kind !== 'reverse' && input.useLastSignature === true) { signatureFileId = (await resolveOwnSignature(call, session.identity.userId, 'task')).fileId; resources.signatureFileId = signatureFileId }
      else skipped.push('signature', 'signatureFile')
      if (kind === 'reverse' && (input.content != null || input.useLastSignature)) invalid('撤回不提交意见或签名。')
      if (kind === 'refuse' && input.stage === 'confirm' && config.autoActionOnReject === 'deleteTask') {
        if (asObject(permissions.editControl).removeTask !== true) throw new RsqError('RESOURCE_FORBIDDEN', '拒绝后按当前配置删除任务，但当前账号没有任务删除权。', 4)
        if (!options.approved) throw new RsqError('CONFIRMATION_REQUIRED', '此审核拒绝会删除任务；非交互调用须使用 --yes。', 2)
      }
      await call('changed', { body: { taskId: input.taskId, auditId: id(target.id), action: kind, ...(input.content != null && { content: input.content }), ...(signatureFileId && { signatureFileId }) } })
    }
    const verifiedField = selectedField(await call('verifiedFields', { query: fieldQuery }), input.fieldId), verifiedConfig = asObject(asObject(verifiedField.audits)[String(input.stage)]), verifiedNodes = nodeList(verifiedConfig, conditionId)
    const verifiedTask = asObject(await call('verifiedTask', { query: taskQuery }))
    if (!same(verifiedTask.id, task.id)) failed('审核后读回了不同任务。')
    if (action === 'submit' && !['doing', 'passed'].includes(String(verifiedConfig.auditStatus))) failed('提交审核后状态未进入审批中或通过，未将空响应当作成功。')
    if (action === 'reviewers') {
      const changed = verifiedNodes.find(node => same(node.id, target!.id))
      if (!changed || JSON.stringify(rows(changed.users).map(user => id(user.id)).sort()) !== JSON.stringify([...(input.userIds as string[])].sort())) failed('审批人独立读回与提交结果不符。')
    }
    if (action === 'act') {
      const changed = verifiedNodes.find(node => same(node.id, target!.id)), user = changed && rows(changed.users).find(user => same(user.id, session.identity.userId))
      if (input.action === 'agree' && (!changed || user?.status !== 'finished' || !['doing', 'passed'].includes(String(changed.status)))) failed('同意审核后本人节点未读回为已处理。')
      if (input.action === 'refuse' && (verifiedConfig.auditStatus !== 'reject' || user?.status !== 'refused')) failed('拒绝审核后未读回拒绝状态。')
      if (input.action === 'refuse' && input.stage === 'confirm' && config.autoActionOnReject === 'closeTask' && verifiedTask.isClose !== true) failed('审核拒绝配置要求关闭任务，但独立读回尚未关闭。')
      if (input.action === 'reverse' && verifiedConfig.auditStatus !== 'pending') failed('撤回审核后未读回待提交状态。')
      if (input.action === 'refuse' && input.stage === 'confirm' && config.autoActionOnReject === 'deleteTask') {
        await call('removed', { query: taskQuery })
        const recycle = rows(await call('recycle', { query: { type: '1,5', max: 200 } }))
        if (!recycle.some(item => same(item.resourceId, input.taskId) && [1, 5].includes(Number(item.type)))) failed('审核拒绝后的任务删除尚未从本人回收站确认。')
        return { command: flow.command, completedSteps: completed, skippedSteps: skipped, resources, result: { ...describe(verifiedField, verifiedConfig, verifiedNodes), taskRemoved: true } }
      }
      skipped.push('removed', 'recycle')
    }
    return { command: flow.command, completedSteps: completed, skippedSteps: skipped, resources, result: { ...describe(verifiedField, verifiedConfig, verifiedNodes), taskState: { isDone: verifiedTask.isDone, isClose: verifiedTask.isClose } } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '任务审核业务执行失败。', 5)
    throw new RsqError(failure.code, failure.message, failure.exit, { ...failure.details, workflow: flow.id, failedStep: phase, completedSteps: completed, resources, writeOutcome: pending ? 'unknown-do-not-retry' : writeCompleted ? 'partially-completed-check-current-state' : 'no-business-write-completed', retry: 'manual-after-readback', automaticRollback: false })
  }
}
