import { asObject, RsqError, type JsonObject } from './core.js'
import { catalog } from './operations.js'
import type { Session } from './session.js'
import type { Workflow } from './workflows.js'

export const datasheetMutationCommands = ['datasheet record create', 'datasheet record update', 'datasheet record delete', 'datasheet view create', 'datasheet view update', 'datasheet view copy', 'datasheet view delete', 'datasheet field create', 'datasheet field configure', 'datasheet field convert', 'datasheet field delete']
export const datasheetTargetSteps = [
  ['targetIdentity', '/task/login/authAjax'], ['targetProject', '/task/v1/kanbanCrud'], ['targetModules', '/task/v1/kanbanChildCrud/list'],
] as const
const mismatch = (message: string): never => { throw new RsqError('CONTEXT_MISMATCH', message, 5) }
const numeric = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : mismatch('数据表项目上下文缺少精确正整数 ID。')

export function validateDatasheetTargetWorkflow(flow: Workflow) {
  if (!datasheetMutationCommands.includes(flow.command)) return
  if (flow.executor || flow.steps.length < 6 || datasheetTargetSteps.some(([id, route], index) => {
    const step = flow.steps[index], operation = catalog.operations.find(operation => operation.id === step?.operationId)
    const expected = id === 'targetIdentity' ? {} : { query: { [id === 'targetProject' ? 'id' : 'kanbanId']: { $input: '/projectId' } } }
    return step.id !== id || operation?.method !== 'GET' || operation.route !== route || JSON.stringify(step.input) !== JSON.stringify(expected) || step.prepare || step.verify || step.transfer || step.forEach || step.authentication || step.resources || step.expectAbsent || step.waitBeforeMs
  })) throw new RsqError('INVALID_CONTRACT', '数据表写入必须先核对当前身份、真实普通项目和完整模块。', 6)
  const context = flow.steps[3], operation = catalog.operations.find(operation => operation.id === context.operationId)
  if (context.id !== 'context' || operation?.method !== 'GET' || operation.route !== '/task/mt/datasheet/{datasheetId}/dataPack' || context.prepare !== 'datasheet-context-bound' || Object.keys(context.input).length || !flow.inputSchema.required?.includes('projectId')) throw new RsqError('INVALID_CONTRACT', '数据表数据包必须绑定已核对项目和真实模块，不能省略 projectId。', 6)
  const action = flow.command.replace('datasheet ', '').replace(' configure', ' update').replace(' ', '-')
  if (['field-create', 'field-update', 'field-convert'].includes(action)) {
    const relatedSteps = [
      ['relatedProject', '/task/v1/kanbanCrud', 'datasheet-related-project'],
      ['relatedModules', '/task/v1/kanbanChildCrud/list', 'datasheet-related-modules'],
      ['related', '/task/mt/datasheet/{datasheetId}/dataPack', 'datasheet-related-context'],
    ]
    if (relatedSteps.some(([id, route, prepare], offset) => {
      const step = flow.steps[4 + offset], operation = catalog.operations.find(operation => operation.id === step?.operationId)
      return step?.id !== id || operation?.method !== 'GET' || operation.route !== route || step.prepare !== prepare || Object.keys(step.input).length || step.forEach || step.transfer || step.authentication || step.verify
    })) throw new RsqError('INVALID_CONTRACT', '数据表关联字段必须先核对目标项目、所属模块和可见字段。', 6)
  }
  const commits = flow.steps.filter(step => step.id === 'commit'), commit = commits[0], transport = catalog.operations.find(operation => operation.id === commit?.operationId)
  const destructive = ['record-delete', 'view-delete', 'field-convert', 'field-delete'].includes(action)
  if (flow.effect !== (destructive ? 'destructive' : 'write') || commits.length !== 1 || commit.prepare !== action || transport?.method !== 'POST' || transport.route !== '/task/mt/resource/apply/changesets') throw new RsqError('INVALID_CONTRACT', '数据表写入的业务动作、确认级别或 changesets 步骤不一致。', 6)
}

export function bindDatasheetTarget(input: JsonObject, results: JsonObject, session: Session | null) {
  if (!session) throw new RsqError('AUTH_REQUIRED', '数据表业务操作需要登录。', 3)
  const actor = asObject(results.targetIdentity), project = asObject(results.targetProject), rows = results.targetModules
  if (numeric(actor.id) !== session.identity.userId || numeric(asObject(actor.team).id) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED', '数据表身份或公司与当前 profile 不一致。', 3)
  const projectId = numeric(input.projectId)
  if (numeric(project.id) !== projectId || !Object.hasOwn(project, 'coverId') || project.coverId !== null) mismatch('此操作必须绑定实际普通项目，项目模板不能混用。')
  if (!Array.isArray(rows) || rows.length > 10000) mismatch('缺少完整项目模块。')
  const matches = (rows as unknown[]).map(asObject).filter(row => row.type === 'datasheet' && asObject(row.datasheetInfo).datasheetId === input.datasheetId)
  if (matches.length !== 1) mismatch('项目中没有唯一关联的目标数据表。')
  const mainProjectId = numeric(asObject(matches[0].datasheetInfo).mainProjectId), moduleId = numeric(matches[0].id)
  results.datasheetTarget = { projectId, mainProjectId, moduleId, datasheetId: input.datasheetId }
  // Record creation uses the actual current project for shared ownership.
  results.project = project; results.modules = rows
  return { path: { datasheetId: input.datasheetId }, query: { projectId } }
}
