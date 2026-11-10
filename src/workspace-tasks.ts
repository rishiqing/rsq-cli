import { asObject, RsqError, type JsonObject } from './core.js'
import { requireSession, type Session } from './session.js'
import { prepareAction } from './action.js'
import { prepareExecution } from './execution-context.js'
import { prepareTaskBusiness } from './task-business.js'

// The UI uses Task3 for both workspaces, with different group attachment keys.
// Resolve the real workspace first; an arbitrary group ID is never sufficient.
export function prepareWorkspaceTask(kind: string, input: JsonObject, results: JsonObject, supplied: Session | null): JsonObject {
  const session = requireSession(supplied), action = kind === 'workspace-task-action'
  if (!action && kind !== 'workspace-task-execution') throw new RsqError('INVALID_INPUT', '未知工作区任务操作。', 2)
  const prepared = action
    ? prepareAction('action-group-tasks', input, results)
    : prepareExecution('execution-items', input, results, session)
  const query = asObject(action ? prepared.query : prepared.body), groups = asObject(results.groups)
  if (action && asObject(groups.editControl).createTask !== true || !action && asObject(groups.editControl).createTask === false) throw new RsqError('FORBIDDEN', '当前工作区范围不允许创建任务。', 4)
  const group = (groups.groupList as JsonObject[]).find(item => String(item.id) === String(query.groupId))
  if (!group) throw new RsqError('CONTEXT_MISSING', '任务目标分组不在已发现的工作区中。', 2)
  if (!action && group.groupType === 'custom' && query.group !== 'custom') throw new RsqError('CONTEXT_MISSING', '服务没有返回当前视图请求的固定分组；请重新发现可用视图，不能向回退分组创建任务。', 2)
  if (group.taskTemplateId != null) throw new RsqError('UNSUPPORTED_CONTEXT', '该分组要求指定任务类型及字段；普通任务创建不代替任务类型创建，请先发现模板字段。', 2)
  // A user card supplies its actual executor, exactly as the UI member selector
  // does. The shared task adapter still enforces the current company scope.
  const memberIds = input.memberIds ?? [String(group.userId ?? session.identity.userId)]
  if (group.userId != null && (!Array.isArray(memberIds) || !memberIds.includes(String(group.userId)))) throw new RsqError('INVALID_INPUT', '人员分组中的任务执行人必须包含该分组的实际用户。', 2)
  const task = prepareTaskBusiness('task-business-create-personal', { ...input, memberIds }, results, session)
  const priority = !action && ['priority', 'quad'].includes(String(query.group)) ? group.priorityV2 ?? (/^[1-4]$/.test(String(group.id)) ? Number(group.id) : undefined) : undefined
  if (priority !== undefined && ![1, 2, 3, 4].includes(Number(priority))) throw new RsqError('CONTEXT_MISSING', '分组优先级不在当前任务支持的范围内。', 2)
  if (priority !== undefined) asObject(asObject(results.taskBusiness).expected).priorityV2 = Number(priority)
  return { body: { ...asObject(task?.body), ...(priority !== undefined && { priorityV2: Number(priority) }), [action ? 'groupId' : 'executionGroupId']: query.groupId } }
}
