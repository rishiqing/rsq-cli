import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, lstat, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { asObject, parseJson, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { checkAccess } from './access.js'
import { describeContact } from './contact.js'
import { readProjectImportWorkbook, projectImportHeaders, type ProjectImportRow, type ImportDate } from './project-import-workbook.js'
import type { Workflow } from './workflows.js'

export const projectExcelActions = ['inspect', 'apply', 'verify'] as const
export type ProjectExcelAction = typeof projectExcelActions[number]
type Route = [string, string, string]
type ResolvedRow = ProjectImportRow & { principalIds: string[]; memberIds: string[]; participantIds: string[] }
type LocatedTask = { id: string; name: string; module: string; card: string; moduleId: string; cardId: string; parentId: string | null }
type Receipt = { version: 1; type: 'project-excel-import'; runId: string; teamId: string; userId: string; profile: string; projectId: string; moduleId: string;
  fileSha256: string; rows: ResolvedRow[]; before: LocatedTask[]; submission: 'not-sent' | 'unknown' | 'accepted'; createdAt: string; verifiedTaskIds?: string[] }
function fail(code: string, message: string, details?: JsonObject): never { throw new RsqError(code, message, ['INVALID_INPUT', 'INVALID_RECEIPT', 'INVALID_CONTRACT'].includes(code) ? 2 : code === 'FORBIDDEN' ? 4 : 5, details) }
const id = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : fail('CONTEXT_MISSING', '项目导入上下文缺少精确数字 ID。')
const taskId = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : fail('CONTEXT_MISSING', '导入任务缺少完整 ID。')
const rows = (value: unknown, max = 10000): JsonObject[] => Array.isArray(value) && value.length <= max ? value.map(asObject) : fail('CONTEXT_MISSING', '项目导入 HTTP 未返回完整有界数组。')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = (row: { module: string; card: string; name: string; parent?: string }) => JSON.stringify([row.module, row.card, row.parent ?? '', row.name])
export function projectExcelSteps(action: ProjectExcelAction): Route[] {
  return [['identity', 'GET', '/task/login/authAjax'], ['project', 'GET', '/task/v1/kanbanCrud'], ['modules', 'GET', '/task/v1/kanbanChildCrud/list'], ['module', 'GET', '/task/v1/kanbanChildCrud'],
    ...(action !== 'verify' ? [['quota', 'POST', '/task/v1/kanban/remainingNum'], ['directory', 'GET', '/task/v1/department/list']] as Route[] : []),
    ['cards', 'GET', '/task/v1/kanbanCardCrud/list'], ['tasks', 'PUT', '/task/api/v3/projectTask/taskList'], ['subtasks', 'GET', '/task/api/v3/task/subs'],
    ...(action === 'apply' ? [['submitted', 'POST', '/task/v4/kanban/uploadTemplate']] as Route[] : []),
    ...(action !== 'inspect' ? [['detail', 'GET', '/task/api/v3/task']] as Route[] : [])]
}
export function validateProjectExcelWorkflow(flow: Workflow) {
  if (!projectExcelActions.includes(flow.projectExcelAction!) || flow.outputAdapter || Object.keys(flow.output as object).length) fail('INVALID_CONTRACT', '未知项目 Excel 编排。')
  const expected = projectExcelSteps(flow.projectExcelAction!)
  if (flow.steps.length !== expected.length || flow.steps.some((step, i) => {
    const op = catalog.operations.find(op => op.id === step.operationId), [name, method, route] = expected[i]
    return !op || step.id !== name || op.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.verify || step.forEach || step.collectPages || step.transfer || step.authentication
  })) fail('INVALID_CONTRACT', '项目 Excel 编排必须使用当前固定发现、上传及独立读回契约。')
}
async function privateReceipt(path: string): Promise<Receipt> {
  const info = await lstat(path).catch(() => fail('INVALID_RECEIPT', '恢复凭据不存在。'))
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8388608 || info.mode & 0o077 || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('INVALID_RECEIPT', '恢复凭据须为当前用户所有、权限 0600、最多 8 MiB 的普通文件。')
  let receipt: Receipt
  try { receipt = parseJson(await readFile(path, 'utf8')) as Receipt } catch { return fail('INVALID_RECEIPT', '恢复凭据 JSON 不完整；不要重新提交上传。') }
  if (!receipt || typeof receipt !== 'object' || receipt.version !== 1 || receipt.type !== 'project-excel-import' || !/^[a-f0-9-]{36}$/.test(receipt.runId) || !/^[a-f0-9]{64}$/.test(receipt.fileSha256)
    || !['not-sent', 'unknown', 'accepted'].includes(receipt!.submission) || !Array.isArray(receipt!.rows) || !receipt!.rows.length || receipt!.rows.length > 10000 || !Array.isArray(receipt!.before) || receipt!.before.length > 10000) fail('INVALID_RECEIPT', '恢复凭据类型、文件摘要或边界不正确。')
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10000 && value.every(item => typeof item === 'string')
  const exactId = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
  if (![receipt.teamId, receipt.userId, receipt.projectId, receipt.moduleId].every(exactId) || typeof receipt.profile !== 'string' || !receipt.profile || !Number.isFinite(Date.parse(receipt.createdAt))) fail('INVALID_RECEIPT', '恢复凭据缺少精确身份、项目和时间。')
  const date = (value: unknown) => value === null || value !== null && typeof value === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String((value as ImportDate).date)) && /^\d{2}:\d{2}:\d{2}$/.test(String((value as ImportDate).time)) && typeof (value as ImportDate).providedTime === 'boolean'
  for (const row of receipt.rows) if (!row || typeof row.name !== 'string' || typeof row.module !== 'string' || typeof row.card !== 'string' || typeof row.parent !== 'string' || !row.name || !row.module || !row.card || !strings(row.columns)
    || typeof row.note !== 'string' || !Number.isInteger(row.row) || row.row < 2 || !strings(row.labels) || !strings(row.principalIds) || !strings(row.memberIds) || !strings(row.participantIds)
    || ![...row.principalIds, ...row.memberIds, ...row.participantIds].every(exactId) || row.principalIds.length > 1 || ![row.start, row.end, row.finished].every(date) || typeof row.done !== 'boolean' || ![1, 2, 3, 4].includes(row.priority)) fail('INVALID_RECEIPT', '恢复凭据中的任务断言不完整。')
  if (new Set(receipt.rows.map(key)).size !== receipt.rows.length) fail('INVALID_RECEIPT', '恢复凭据含重复任务断言。')
  for (const row of receipt.before) if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.id) || !exactId(row.moduleId) || !exactId(row.cardId) || typeof row.name !== 'string' || typeof row.module !== 'string' || typeof row.card !== 'string' || row.parentId !== null && typeof row.parentId !== 'string') fail('INVALID_RECEIPT', '恢复凭据中的原有任务快照不完整。')
  if (new Set(receipt.before.map(row => row.id)).size !== receipt.before.length) fail('INVALID_RECEIPT', '恢复凭据含重复原有任务 ID。')
  return receipt!
}
async function saveReceipt(path: string, receipt: Receipt, create = false) {
  const serialized = JSON.stringify(receipt) + '\n'
  if (Buffer.byteLength(serialized) > 8388608) fail('INVALID_RECEIPT', '恢复凭据超过 8 MiB，未上传文件。')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const target = create ? path : path + '.' + randomUUID() + '.tmp'
  if (!create && (await privateReceipt(path)).runId !== receipt.runId) fail('INVALID_RECEIPT', '恢复凭据被另一个导入替换，未覆盖。')
  const handle = await open(target, 'wx', 0o600).catch(() => fail('RECEIPT_WRITE_FAILED', '无法建立新的恢复凭据；不会覆盖现有文件。'))
  try { await handle.writeFile(serialized); await handle.sync() } catch (error) { await rm(target, { force: true }); throw error } finally { await handle.close() }
  if (!create) await rename(target, path).catch(async () => { await rm(target, { force: true }); fail('RECEIPT_WRITE_FAILED', '更新恢复凭据失败；请按现有文件独立核对，不重新上传。') })
}
function resolvedRows(source: ProjectImportRow[], directory: unknown): ResolvedRow[] {
  const members = rows(describeContact({}, { tree: directory }).members), names = new Map<string, Set<string>>()
  for (const member of members) if (typeof member.showName === 'string') { const values = names.get(member.showName) ?? new Set(); values.add(id(member.id)); names.set(member.showName, values) }
  const select = (values: string[]) => values.map(name => {
    const matching = names.get(name)
    if (!matching || matching.size !== 1) fail('AMBIGUOUS_MEMBER', 'Excel 成员名称须唯一匹配当前可见公司通讯录；不会使用后台按重名取第一个的兜底。')
    return [...matching][0]
  })
  return source.map(row => { const principalIds = select(row.principal); return { ...row, principalIds, memberIds: [...new Set([...select(row.members), ...principalIds])].sort(), participantIds: select(row.participants).sort() } })
}
function verifyDate(actual: unknown, expected: ImportDate, timed: boolean, end = false, finished = false) {
  if (typeof actual !== 'string') return false
  if (!timed && !finished) return actual === expected.date
  const time = finished ? expected.time : expected.time.slice(0, 5) + (end ? ':59' : ':00')
  const want = Date.parse(expected.date + 'T' + time + '+08:00')
  const normalized = /^\d{4}[.-]\d{2}[.-]\d{2} /.test(actual) ? actual.slice(0, 10).replaceAll('.', '-') + 'T' + actual.slice(11) + '+08:00' : actual
  return Date.parse(normalized) === want
}
export async function runProjectExcel(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean } = {}) {
  validateProjectExcelWorkflow(flow)
  const action = flow.projectExcelAction!, session = requireSession(supplied), completed: string[] = [], resources: JsonObject = {}, path = input.receipt ? resolve(String(input.receipt)) : null
  let phase = 'file', receipt: Receipt | undefined, temporary: string | undefined, pending = false
  const call = async (name: string, args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === name), op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) return fail('INVALID_CONTRACT', '导入缺少固定步骤。')
    phase = name; pending = op.method === 'POST' && name === 'submitted'
    const value = await runOperation(ctx, op, args, session, options); pending = false; completed.push(name); return value
  }
  try {
    const workbook = action === 'verify' ? null : await readProjectImportWorkbook(String(input.file))
    if (action === 'verify') receipt = await privateReceipt(path!)
    if (receipt && (receipt.teamId !== session.identity.teamId || receipt.userId !== session.identity.userId || receipt.profile !== ctx.profile || receipt.submission === 'not-sent')) fail('INVALID_RECEIPT', '恢复凭据必须属于当前 profile、用户和公司，且已有可能提交的请求；不会自动提交未发送请求。')
    const projectId = id(receipt?.projectId ?? input.projectId), who = asObject(await call('identity'))
    resources.projectId = projectId; if (path) resources.receipt = path
    if (id(who.id) !== session.identity.userId || id(asObject(who.team).id) !== session.identity.teamId) fail('IDENTITY_CHANGED', '项目导入身份与当前 profile 不一致。')
    const project = async () => {
      const value = asObject(await call('project', { query: { id: projectId, isDefault: false } }))
      if (id(value.id) !== projectId || value.coverId !== null) fail('FORBIDDEN', 'Excel 导入只允许明确的普通项目；模板和普通项目 ID 不可互换。')
      if (action !== 'verify' && asObject(value.editControl).importKanban !== true) fail('FORBIDDEN', '当前项目 UI 未授予 importKanban 权限。')
      return value
    }
    const current = await project(), moduleList = rows(await call('modules', { query: { kanbanId: projectId } })), anchor = receipt?.moduleId ?? input.moduleId
    const matches = moduleList.filter(row => row.type === 'task' && (anchor == null || id(row.id) === anchor))
    if (matches.length !== 1) fail('INVALID_INPUT', '请选择当前普通项目中唯一的 task 模块作为上传上下文。', { modules: moduleList.filter(row => row.type === 'task').map(row => ({ id: id(row.id), name: row.name })) })
    const moduleId = id(matches[0].id); resources.moduleId = moduleId
    const anchorDetail = asObject(await call('module', { query: { id: moduleId } }))
    // Current module detail omits its parent ID. Membership comes from the
    // independently scoped project directory, never from a guessed DTO field.
    if (id(anchorDetail.id) !== moduleId || anchorDetail.name !== matches[0].name || anchorDetail.type !== 'task' || anchorDetail.kanbanId != null && id(anchorDetail.kanbanId) !== projectId) fail('FORBIDDEN', '上传模块与当前项目目录或详情不一致。')
    let quota: number | undefined, expected: ResolvedRow[]
    if (workbook) {
      const value = asObject(await call('quota')); quota = Number(value.remainingNum)
      if (!Number.isInteger(quota) || quota > 50) fail('CONTEXT_MISSING', '剩余导入次数响应无效。')
      expected = resolvedRows(workbook.rows, await call('directory', { query: { cliContext: 'fresh' } }))
    } else expected = receipt!.rows
    const collect = async (): Promise<LocatedTask[]> => {
      const modules = rows(await call('modules', { query: { kanbanId: projectId } })), output: LocatedTask[] = [], seen = new Set<string>()
      for (const moduleName of new Set(expected.map(row => row.module))) {
        const matching = modules.filter(row => row.type === 'task' && row.name === moduleName)
        if (matching.length > 1) fail('AMBIGUOUS_CONTEXT', '同名任务模块无法独立定位，未猜测后台会选择哪一个。')
        if (!matching.length) continue
        const mid = id(matching[0].id), cards = rows(await call('cards', { query: { kanbanChildId: mid } }))
        for (const cardName of new Set(expected.filter(row => row.module === moduleName).map(row => row.card))) {
          const matchingCards = cards.filter(row => row.name === cardName)
          if (matchingCards.length > 1) fail('AMBIGUOUS_CONTEXT', '同名卡片无法独立定位。')
          if (!matchingCards.length) continue
          const cid = id(matchingCards[0].id), visit = async (items: JsonObject[], parentId: string | null, depth: number): Promise<void> => {
            if (depth > 50) fail('CONTEXT_MISSING', '现有任务子树超过核对上限。')
            for (const row of items) {
              const tid = taskId(row.id)
              if (seen.has(tid) || output.length >= 10000 || typeof row.name !== 'string') fail('CONTEXT_MISSING', '任务列表重复、循环、超出 10000 项或名称缺失。')
              seen.add(tid); output.push({ id: tid, name: row.name, module: moduleName, card: cardName, moduleId: mid, cardId: cid, parentId })
              if (row.hasSubTask === true) await visit(rows(await call('subtasks', { query: { taskId: tid, planId: mid, showView: 'schedule', isNeedTemplateField: true } })), tid, depth + 1)
            }
          }
          for (let offset = 0; ; offset += 200) {
            const page = rows(await call('tasks', { body: { key: cid, planId: mid, planViewId: null, showView: 'schedule', groupType: 'card', sortType: null, filter: [], isNeedTemplateField: true, offset, max: 200 } }), 200)
            await visit(page, null, 0); if (page.length < 200) break
          }
        }
      }
      return output.sort((a, b) => a.id.localeCompare(b.id))
    }
    const before = receipt?.before ?? await collect(), contextVersion = hash({ projectId, moduleId, permission: asObject(current.editControl).importKanban, before })
    if (action === 'inspect') return { workflow: flow.id, completedSteps: completed, resources, result: { projectId, moduleId, fileSha256: workbook!.sha256, contextVersion, remainingImports: quota, canSubmit: quota! > 0,
      rows: expected, visibleExistingTasks: before.length, routing: 'Excel 中的所属任务模块/卡片决定创建位置；moduleId 只确定接收项目。', supportedHeaders: Object.keys(projectImportHeaders),
      sideEffects: ['批量新建任务及子任务', '可能创建模块、卡片及项目标签', '消耗当天导入次数'], relatedCommands: ['project import excel apply', 'project import excel verify'] } }
    if (action === 'apply') {
      if (workbook!.sha256 !== input.expectedFileSha256 || input.expectedContextVersion != null && contextVersion !== input.expectedContextVersion) fail('CONTEXT_CONFLICT', '文件摘要或项目上下文与已检查版本不一致；未上传。')
      if (quota! <= 0) fail('IMPORT_LIMIT_EXCEEDED', '今天的导入次数已用完；不会绕过 UI 上传。')
      const fresh = await project(), freshBefore = await collect(), freshQuota = Number(asObject(await call('quota')).remainingNum)
      if (asObject(fresh.editControl).importKanban !== true || !isDeepStrictEqual(before, freshBefore) || !Number.isInteger(freshQuota) || freshQuota <= 0) fail('CONTEXT_CONFLICT', '上传前项目、可见任务或导入次数改变；未发送上传。')
      receipt = { version: 1, type: 'project-excel-import', runId: randomUUID(), teamId: session.identity.teamId!, userId: session.identity.userId, profile: ctx.profile, projectId, moduleId, fileSha256: workbook!.sha256, rows: expected, before, submission: 'not-sent', createdAt: new Date().toISOString() }
      await saveReceipt(path!, receipt, true)
      const freshRows = resolvedRows(workbook!.rows, await call('directory', { query: { cliContext: 'fresh' } }))
      if (!isDeepStrictEqual(expected, freshRows)) fail('CONTEXT_CONFLICT', '成员名称映射在提交前变化；未上传。')
      await checkAccess(ctx, flow, input, session, options.transport)
      temporary = await mkdtemp(join(tmpdir(), 'rsq-project-import-'))
      const snapshot = join(temporary, 'import.xlsx'), handle = await open(snapshot, 'wx', 0o600)
      try { await handle.writeFile(workbook!.bytes); await handle.sync() } finally { await handle.close() }
      receipt.submission = 'unknown'; await saveReceipt(path!, receipt)
      const accepted = asObject(await call('submitted', { body: { id: moduleId }, files: { fileData: snapshot } }))
      if (accepted.type !== 'ws') fail('UNEXPECTED_RECEIPT', '上传没有返回当前队列受理回执；先读回，不重新上传。')
      receipt.submission = 'accepted'; await saveReceipt(path!, receipt)
    }
    const deadline = Date.now() + Number(input.waitSeconds ?? 30) * 1000, oldIds = new Set(before.map(row => row.id))
    let observed: LocatedTask[] = [], matched: { expected: ResolvedRow; actual: LocatedTask }[] = []
    do {
      observed = await collect()
      if (before.some(row => !observed.some(actual => isDeepStrictEqual(row, actual)))) fail('CONTEXT_CONFLICT', '原有可见任务在导入期间变化；保留已完成资源，不自动清理或重传。')
      const created = observed.filter(row => !oldIds.has(row.id)), byId = new Map(observed.map(row => [row.id, row])), byKey = new Map<string, LocatedTask[]>()
      for (const row of created) { const parent = row.parentId ? byId.get(row.parentId)?.name : ''; const k = key({ ...row, parent }); byKey.set(k, [...byKey.get(k) ?? [], row]) }
      matched = expected.flatMap(row => { const values = byKey.get(key(row)) ?? []; if (values.length > 1) fail('AMBIGUOUS_CONTEXT', '同一位置出现多个同名新增任务，不能归因给本次上传。'); return values.length ? [{ expected: row, actual: values[0] }] : [] })
      resources.observedTaskIds = created.map(row => row.id)
      if (created.length > expected.length) fail('CONTEXT_CONFLICT', '出现超出文件清单的新增任务，不能声称导入已验证。')
      if (matched.length === expected.length) break
      if (Date.now() >= deadline) fail('ASYNC_READBACK_PENDING', '已受理或结果未知，但 HTTP 尚未完整观察到导入结果。使用同一 receipt 继续 verify；不要重传。', { expectedTasks: expected.length, observedTasks: created.length })
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())))
    } while (true)
    for (const { expected: row, actual } of matched) {
      const value = asObject(await call('detail', { query: { id: actual.id, module: 'project', siteId: projectId } })), from = asObject(value.from)
      const assert = (test: boolean, field: string) => { if (!test) fail('VERIFICATION_FAILED', '导入任务已创建，但独立 HTTP 读回未符合文件字段：' + field, { taskId: actual.id, row: row.row }) }
      assert(value.id === actual.id && value.name === row.name && id(from.projectId) === projectId && id(from.planId) === actual.moduleId && from.planType === 'task', 'identity-and-scope')
      assert((value.taskId == null || value.taskId === '' ? null : value.taskId) === actual.parentId, 'parent')
      assert(value.isDone === row.done, 'done'); assert(Number(value.priorityV2) === row.priority, 'priority')
      if (row.columns.includes('note')) assert(typeof value.note === 'string' && value.note === row.note, 'note')
      for (const [field, wanted] of [['members', row.memberIds], ['participants', row.participantIds]] as const) if (row.columns.includes(field) || field === 'members' && row.principalIds.length) assert(isDeepStrictEqual(rows(value[field] ?? []).map(member => id(member.id)).sort(), wanted), field)
      if (row.principalIds.length) assert(id(value.responsibilityId) === row.principalIds[0], 'principal')
      if (row.labels.length) assert(isDeepStrictEqual([...new Set(rows(value.labelList).map(label => label.name))].sort(), [...row.labels].sort()), 'labels')
      const timed = !row.start || !row.end || row.start.providedTime
      if (row.start) assert(verifyDate(value.realStartDate, row.start, timed), 'start')
      if (row.end) assert(verifyDate(value.realEndDate, row.end, timed, true), 'end')
      if (row.finished) assert(verifyDate(value.finishDate, row.finished, true, false, true), 'finished')
    }
    receipt!.verifiedTaskIds = matched.map(row => row.actual.id); await saveReceipt(path!, receipt!)
    return { workflow: flow.id, completedSteps: completed, resources, result: { projectId, moduleId, fileSha256: receipt!.fileSha256, submission: receipt!.submission, verified: true,
      taskIds: receipt!.verifiedTaskIds, tasks: matched.map(row => ({ row: row.expected.row, ...row.actual })), previousVisibleTasksPreserved: true, readbackTransport: 'HTTP', receipt: path } }
  } catch (error) {
    const original = error instanceof RsqError ? error : new RsqError('IMPORT_FAILED', '项目导入步骤失败；使用恢复凭据核对结果，不重新提交。', 5)
    throw new RsqError(original.code, original.message, original.exit, { failedStep: phase, completedSteps: completed, resources, submission: receipt?.submission ?? 'not-sent', uploadOutcomeUnknown: pending || receipt?.submission === 'unknown', automaticRetry: false, cause: original.details })
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {}) }
}
