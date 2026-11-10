import { createHash } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'

export type CopyNode = { task: JsonObject; comments: JsonObject[]; children: CopyNode[] }
type CopyReader = { task: (id: string) => Promise<unknown>; comments: (id: string) => Promise<unknown>; children: (id: string) => Promise<unknown> }
const fail = (message: string): never => { throw new RsqError('CONTEXT_MISSING', message, 5) }
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : fail('复制核对缺少完整 HTTP 列表。')
const numericId = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : fail('复制核对缺少精确数字 ID。')
const taskId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : fail('复制核对缺少真实任务 ID。')
const sorted = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort()
const people = (value: unknown) => list(value ?? []).map(person => numericId(person.id)).sort()
const date = (value: unknown) => value == null ? null : typeof value === 'string' && value.length === 10 ? value : Number.isFinite(Date.parse(String(value))) ? new Date(String(value)).toISOString() : fail('复制核对返回无效日期。')

/** Read every visible node independently; a truncated list is never a proof. */
export async function readCopyForest(roots: JsonObject[], reader: CopyReader, where: { projectId: string; moduleId: string }, observed?: (id: string) => void): Promise<CopyNode[]> {
  const seen = new Set<string>(), commentIds = new Set<string>()
  let commentCount = 0
  const visit = async (value: JsonObject, parent: string | null, depth: number): Promise<CopyNode> => {
    const id = taskId(value.id)
    if (depth >= 20 || seen.size >= 1000 || seen.has(id)) fail('复制子树重复、成环、超过20层或超过1000个任务，未认定完整。')
    if (!Number.isSafeInteger(value.subTaskNum) || Number(value.subTaskNum) < 0 || typeof value.hasSubTask !== 'boolean' || value.hasSubTask !== (Number(value.subTaskNum) > 0)) fail('任务详情缺少一致的真实子任务总数，不能认定已读全子树。')
    seen.add(id); observed?.(id)
    if (String(asObject(value.from).projectId) !== where.projectId || String(asObject(value.from).planId) !== where.moduleId || (value.taskId === '' ? null : value.taskId ?? null) !== parent) fail('复制子任务的真实项目、模块或父任务归属不一致。')
    const comments = list(await reader.comments(id))
    commentCount += comments.length
    if (comments.length > 1000 || commentCount > 10000) fail('复制评论超过单任务1000条或整批10000条核对上限。')
    for (const comment of comments) { const key = numericId(comment.id); if (commentIds.has(key)) fail('评论 HTTP 目录包含重复身份，不能认定完整。'); commentIds.add(key) }
    const directory = list(await reader.children(id)), children: CopyNode[] = []
    if (directory.length > 1000 - seen.size) fail('复制子任务目录超过整批1000个任务核对上限。')
    if (directory.length !== value.subTaskNum) fail('HTTP 可见子任务数量与任务详情总数不符；存在隐藏、未返回或变化的子任务，不能认定子树完整。')
    for (const row of directory) { const childId = taskId(row.id), child = asObject(await reader.task(childId)); if (child.id !== childId) fail('子任务详情与目录 ID 不一致。'); children.push(await visit(child, id, depth + 1)) }
    if (value.hasSubTask === true && !children.length) fail('任务标记仍有子任务但 HTTP 未返回，不能将不可见或不完整子树当作空树。')
    return { task: value, comments, children }
  }
  const result: CopyNode[] = []
  for (const root of roots) result.push(await visit(root, null, 0))
  return result
}

export function copyNodes(forest: CopyNode[]): CopyNode[] { return forest.flatMap(node => [node, ...copyNodes(node.children)]) }
export function copyCommentIds(forest: CopyNode[]) { return copyNodes(forest).flatMap(node => node.comments.map(comment => numericId(comment.id))) }

export function copyContent(node: CopyNode): unknown {
  const task = node.task
  return { name: task.name, note: task.note ?? '', members: people(task.members), participants: people(task.participants), principalId: task.responsibilityId == null || task.responsibilityId === '' ? null : numericId(task.responsibilityId), start: date(task.realStartDate), end: date(task.realEndDate),
    labels: sorted(list(task.labelList ?? []).map(label => { numericId(label.id); if (!['project', 'todo'].includes(String(label.type)) || typeof label.name !== 'string' || !Number.isInteger(label.color)) fail('任务标签缺少当前类型、名称或颜色。'); return { type: label.type, name: label.name, color: label.color } })),
    comments: sorted(node.comments.map(comment => ({ content: comment.content ?? '', creatorId: numericId(asObject(comment.creator).id), dateCreated: comment.dateCreated ?? null, files: list(comment.fileList ?? []).map(file => numericId(file.id)).sort(), locations: list(comment.gaodeList ?? []).map(file => numericId(file.id)).sort() }))),
    children: node.children.map(copyContent) }
}
export function copyContentHash(node: CopyNode) { return createHash('sha256').update(JSON.stringify(copyContent(node))).digest('hex') }

/** Keep IDs and ordering for fresh-preflight/source-preservation comparisons. */
export function copySnapshot(forest: CopyNode[]): unknown {
  return forest.map(node => ({ id: node.task.id, parentId: node.task.taskId ?? null, content: copyContent(node), priorityV2: node.task.priorityV2, labels: list(node.task.labelList ?? []).map(label => numericId(label.id)), comments: node.comments.map(comment => numericId(comment.id)), children: copySnapshot(node.children) }))
}

export function verifyCopiedForest(source: CopyNode[], copied: CopyNode[], targetProjectLabels: JsonObject[]): JsonObject[] {
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
  const previous = copyNodes(source), created = copyNodes(copied), previousIds = new Set(previous.map(node => taskId(node.task.id))), previousComments = new Set(copyCommentIds(source))
  assert(previous.length === created.length && created.every(node => !previousIds.has(taskId(node.task.id))), '复制子树数量或新任务 ID 不符合源树；不会重发。')
  assert(copyCommentIds(copied).every(id => !previousComments.has(id)), '复制评论仍复用了源评论 ID；不会重发。')
  const labels = new Map(targetProjectLabels.filter(label => label.type === 'project').map(label => [numericId(label.id), label]))
  for (const node of created) for (const label of list(node.task.labelList ?? [])) if (label.type === 'project') {
    const member = labels.get(numericId(label.id))
    assert(member && member.name === label.name && member.color === label.color, '复制后的项目标签不属于真实目标项目标签库。')
  }
  const remaining = source.slice(), matches: JsonObject[] = []
  for (const actual of copied) {
    const hash = copyContentHash(actual), index = remaining.findIndex(node => copyContentHash(node) === hash)
    assert(index >= 0, '复制的评论、标签、成员、日期或有序子任务树与源内容不一致；不会重发。')
    const expected = remaining.splice(index, 1)[0]!
    const bind = (before: CopyNode, after: CopyNode) => { matches.push({ sourceTaskId: before.task.id, taskId: after.task.id, parentTaskId: after.task.taskId ?? null, commentCount: after.comments.length, labelCount: list(after.task.labelList ?? []).length, contentSha256: copyContentHash(after) }); for (let i = 0; i < before.children.length; i++) bind(before.children[i]!, after.children[i]!) }
    bind(expected, actual)
  }
  assert(!remaining.length, '复制未匹配全部源根任务。')
  return matches
}
