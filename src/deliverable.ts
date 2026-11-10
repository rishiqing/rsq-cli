import { asObject, RsqError, type JsonObject } from './core.js'

// files/project use rishiqing-response-old: DTOs and lists are returned raw.
const data = (value: unknown) => value
const rows = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING', '交付物服务未返回预期列表。', 5)
  return value.map(asObject)
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{32}$/.test(value)) throw new RsqError('CONTEXT_MISSING', '交付物上下文缺少有效的分类、文件或版本 ID。', 5)
  return value
}
function projectId(input: JsonObject, results: JsonObject) {
  const value = input.projectId ?? asObject(results.template).templateKanbanId
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return String(value)
  throw new RsqError('CONTEXT_MISSING', '缺少明确的普通项目或模板项目 ID。', 5)
}
function moduleId(input: JsonObject, results: JsonObject) {
  const modules = rows(results.modules).filter(module => module.type === 'deliverable')
  if (modules.length !== 1) throw new RsqError('CONTEXT_MISSING', '目标需要且只能有一个可见交付物模块；先发现或启用模块。', 2)
  const value = modules[0].id
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return String(value)
  throw new RsqError('CONTEXT_MISSING', '交付物模块 ID 不完整。', 5)
}
type CategoryNode = { node: JsonObject; parent: string | null; ancestors: string[]; siblings: JsonObject[] }
function categories(value: unknown) {
  const output = new Map<string, CategoryNode>()
  const visit = (nodes: JsonObject[], parent: string | null, ancestors: string[]) => {
    if (ancestors.length > 50 || output.size + nodes.length > 10000) throw new RsqError('CONTEXT_MISSING', '交付物分类树过深或过大。', 5)
    for (const node of nodes) {
      const id = identifier(node.categoryId)
      if (output.has(id)) throw new RsqError('CONTEXT_MISSING', '交付物分类树存在重复或循环节点。', 5)
      output.set(id, { node, parent, ancestors, siblings: nodes })
      visit(rows(node.children ?? []), id, [...ancestors, id])
    }
  }
  visit(rows(data(value)), null, []); return output
}
function category(results: JsonObject, id: unknown, common = false) {
  const selected = categories(results.tree).get(identifier(id))
  if (!selected) throw new RsqError('CONTEXT_MISSING', '分类不属于当前项目；先发现分类树。', 2)
  if (common && selected.node.type !== 'common') throw new RsqError('INVALID_INPUT', '系统分类不能修改、删除或作为此操作的目标。', 2)
  return selected
}
function baseline(input: JsonObject, results: JsonObject) {
  const selected = rows(data(results.baselines)).find(item => item.baselineId === input.baselineId)
  if (!selected) throw new RsqError('CONTEXT_MISSING', '基线不属于当前交付物模块。', 2)
  return selected
}
function ownedFile(input: JsonObject, results: JsonObject) {
  const file = asObject(data(results.file))
  if (file.fileId !== input.fileId || String(file.projectId) !== projectId(input, results)) throw new RsqError('CONTEXT_MISSING', '交付物文件不属于指定项目。', 2)
  rows(file.versions)
  return file
}
function taskDeliveryProject(input: JsonObject, results: JsonObject, write = false) {
  const project = asObject(results.project), target = projectId(input, results)
  if (String(project.id) !== target) throw new RsqError('CONTEXT_MISMATCH', '任务交付物项目与当前上下文不符。', 4)
  if (input.coverId !== undefined) {
    const cover = asObject(results.template)
    if (String(cover.id) !== String(input.coverId) || String(project.coverId) !== String(cover.id) || String(cover.templateKanbanId) !== target) throw new RsqError('CONTEXT_MISMATCH', '模板封面、模板项目与任务归属不一致。', 4)
    if (write && cover.withEdit !== true) throw new RsqError('FORBIDDEN', '模板封面未授予编辑权限，不能修改任务交付物。', 4)
  } else if (project.coverId !== null) throw new RsqError('CONTEXT_MISMATCH', '此对象是模板项目，使用 project template deliverable task 命令。', 4)
  moduleId(input, results)
  return target
}
function taskDelivery(input: JsonObject, results: JsonObject, write = false) {
  const target = taskDeliveryProject(input, results, write), task = asObject(results.latestTask ?? results.task)
  if (String(task.id) !== String(input.taskId) || String(asObject(task.from).projectId) !== target) throw new RsqError('CONTEXT_MISMATCH', '任务不属于指定项目。', 4)
  if (write && task.forbidEdit === true) throw new RsqError('FORBIDDEN', '当前任务禁止编辑。', 4)
  return task
}
function deliveryRows(value: unknown) {
  const current = asObject(value)
  if (current.isShow !== true) throw new RsqError('FORBIDDEN', '当前任务 UI 未开启交付物入口。', 4)
  const items = rows(current.tableRows)
  if (items.length > 10000 || new Set(items.map(item => identifier(item.id))).size !== items.length) throw new RsqError('CONTEXT_MISSING', '任务交付物列表不完整或 ID 重复。', 5)
  return items
}
export function prepareDeliverable(kind: string, input: JsonObject, results: JsonObject): JsonObject | null {
  const project = projectId(input, results)
  if (kind === 'deliverable-task-read') return { query: { id: input.taskId, module: 'project', siteId: taskDeliveryProject(input, results) } }
  if (kind.startsWith('deliverable-task-')) {
    taskDelivery(input, results, kind !== 'deliverable-task-context')
    if (kind === 'deliverable-task-context') return { query: { taskId: input.taskId } }
    const before = deliveryRows(results.taskFiles), latest = deliveryRows(results.latestTaskFiles)
    const beforeIds = before.map(item => identifier(item.id)), latestIds = latest.map(item => identifier(item.id))
    if (JSON.stringify([...beforeIds].sort()) !== JSON.stringify([...latestIds].sort())) throw new RsqError('CONTEXT_CONFLICT', '任务交付物集合已变化，请重新读取；未执行关联写入。', 5)
    ownedFile(input, results)
    const fileId = identifier(input.fileId), present = beforeIds.includes(fileId), link = kind === 'deliverable-task-link'
    if (present === link) throw new RsqError('INVALID_INPUT', link ? '任务已关联此交付物，未重复写入。' : '此交付物不在任务的当前关联列表中。', 2)
    results.taskDelivery = { expectedIds: link ? [...beforeIds, fileId] : beforeIds.filter(id => id !== fileId) }
    return { [link ? 'body' : 'query']: { taskId: input.taskId, fileIds: fileId } }
  }
  if (kind.startsWith('deliverable-upload-')) {
    moduleId(input, results)
    const local = asObject(results.localUpload)
    if (typeof local.md5 !== 'string' || typeof local.name !== 'string') throw new RsqError('CONTEXT_MISSING', '缺少本地上传文件的摘要和名称。', 5)
    if (kind === 'deliverable-upload-second-pass') {
      if (input.taskId !== undefined) { taskDelivery(input, results, true); deliveryRows(results.taskFiles) }
      if (input.fileId !== undefined) ownedFile(input, results)
      else if (input.categoryId !== undefined || input.taskId === undefined) category(results, input.categoryId, true)
      return { body: { projectId: project, fileName: local.name, md5: local.md5, ...(input.taskId !== undefined && { taskId: input.taskId }), ...(input.fileId !== undefined ? { fileId: input.fileId } : input.categoryId !== undefined ? { categoryId: input.categoryId } : {}) } }
    }
    const second = asObject(results.secondPass)
    if (typeof second.secondPass !== 'boolean') throw new RsqError('CONTEXT_MISSING', '秒传接口未返回明确结果，停止后续上传，避免重复创建。', 5)
    if (second.secondPass) {
      const fileId = identifier(asObject(second.file).fileId)
      if (input.fileId !== undefined && fileId !== input.fileId) throw new RsqError('CONTEXT_CONFLICT', '秒传返回了不同的文件 ID；停止后续写入并核对。', 5)
      results.prepared = { fileId, resources: { fileId } }
      if (kind !== 'deliverable-upload-readback') return null
    }
    if (kind === 'deliverable-upload-certificate') return { query: { type: 'file' } }
    if (kind === 'deliverable-upload-register' || kind === 'deliverable-upload-replace') {
      const stored = asObject(results.stored)
      if (typeof stored.path !== 'string' || stored.md5 !== local.md5 || stored.size !== local.size) throw new RsqError('CONTEXT_MISSING', '缺少已完成的真实文件上传结果；禁止登记猜测的存储路径。', 5)
      if (kind.endsWith('replace')) { ownedFile(input, results); return { body: { fileId: input.fileId, fileName: local.name, filePath: stored.path } } }
      category(results, input.categoryId, true)
      return { body: { projectId: project, ...(input.categoryId !== undefined && { categoryId: input.categoryId }), fileName: local.name, filePath: stored.path, ...(input.taskId !== undefined && { taskId: input.taskId }) } }
    }
    if (kind === 'deliverable-upload-readback') {
      const fileId = identifier(input.fileId ?? (second.secondPass ? asObject(second.file).fileId : asObject(results.changed).fileId))
      results.prepared = { fileId, resources: { fileId } }; return { query: { fileId } }
    }
    throw new RsqError('INVALID_CONTRACT', '未知文件上传步骤。', 5)
  }
  if (kind === 'deliverable-module-enable' || kind === 'deliverable-module-disable') return { body: { projectId: project } }
  if (kind === 'deliverable-tree') { moduleId(input, results); return { query: { projectId: project } } }
  if (kind === 'deliverable-category-list') {
    moduleId(input, results)
    if (input.parentId != null) category(results, input.parentId)
    if (input.baselineId !== undefined) baseline(input, results)
    return { query: { projectId: project, ...(input.parentId != null && { parentId: input.parentId }), ...(input.baselineId !== undefined && { baselineId: input.baselineId }) } }
  }
  if (kind === 'deliverable-category-create') {
    moduleId(input, results)
    if (input.parentId != null) category(results, input.parentId, true)
    return { body: { projectId: project, name: input.name, parentId: input.parentId ?? null } }
  }
  if (kind === 'deliverable-category-rename' || kind === 'deliverable-category-remove') {
    category(results, input.categoryId, true)
    return kind.endsWith('rename') ? { body: { categoryId: input.categoryId, name: input.name } } : { query: { categoryId: input.categoryId } }
  }
  if (kind === 'deliverable-category-move') {
    const source = category(results, input.categoryId, true), target = input.parentId == null ? null : category(results, input.parentId, true)
    if (target && (input.parentId === input.categoryId || target.ancestors.includes(String(input.categoryId)))) throw new RsqError('INVALID_INPUT', '不能将分类移动到自身或其子分类内。', 2)
    const parent = input.parentId ?? null
    const siblings = (target ? rows(target.node.children ?? []) : rows(data(results.tree))).filter(node => node.categoryId !== input.categoryId)
    const ids = siblings.map(node => identifier(node.categoryId))
    const front = input.frontId == null ? null : identifier(input.frontId), next = input.nextId == null ? null : identifier(input.nextId)
    if (front === input.categoryId || next === input.categoryId || front && !ids.includes(front) || next && !ids.includes(next)
      || front !== null && next !== null && ids.indexOf(front) + 1 !== ids.indexOf(next)
      || front === null && next !== null && ids.indexOf(next) !== 0
      || next === null && front !== null && ids.indexOf(front) !== ids.length - 1
      || front === null && next === null && ids.length) throw new RsqError('CONTEXT_CONFLICT', '排序相邻项与当前同级分类不一致；重新读取分类树后选择。', 5)
    results.prepared = { categoryId: source.node.categoryId, parentId: parent, frontId: front, nextId: next }
    return { body: { categoryId: input.categoryId, parentId: parent, frontId: front, nextId: next } }
  }
  if (kind === 'deliverable-baseline-list') return { query: { planId: moduleId(input, results) } }
  if (kind === 'deliverable-baseline-create') return { body: { planId: moduleId(input, results), name: input.name, draftStrategy: input.draftStrategy } }
  if (kind === 'deliverable-baseline-rename' || kind === 'deliverable-baseline-remove') {
    baseline(input, results)
    return kind.endsWith('rename') ? { body: { baselineId: input.baselineId, name: input.name } } : { query: { baselineId: input.baselineId } }
  }
  if (kind === 'deliverable-category-users' || kind === 'deliverable-files-list') {
    moduleId(input, results); category(results, input.categoryId)
    if (input.baselineId !== undefined) baseline(input, results)
    if (kind === 'deliverable-category-users') return { query: { categoryId: input.categoryId, ...(input.baselineId !== undefined && { baselineId: input.baselineId }) } }
    return { query: Object.fromEntries(Object.entries({ categoryId: input.categoryId, max: input.max ?? 30, offset: input.offset ?? 0,
      searchName: input.searchName, sort: input.sort ?? 'updateDate', order: input.order ?? 'desc', state: input.states === undefined ? undefined : (input.states as string[]).join(','),
      updaterId: input.updaterIds === undefined ? undefined : (input.updaterIds as string[]).join(','), baselineId: input.baselineId }).filter(([, value]) => value !== undefined)) }
  }
  if (kind === 'deliverable-file-membership-list' || kind === 'deliverable-file-removal-list') {
    moduleId(input, results); const file = ownedFile(input, results)
    const latest = rows(file.versions).find(version => version.isLatest === true)
    if (!latest || typeof latest.fileName !== 'string' || !latest.fileName) throw new RsqError('CONTEXT_MISSING', '当前文件缺少可核对的最新版本名称。', 5)
    const target = kind === 'deliverable-file-membership-list' ? category(results, input.categoryId, true).node
      : [...categories(results.tree).values()].find(item => item.node.type === 'all')?.node
    if (!target) throw new RsqError('CONTEXT_MISSING', '缺少当前项目的全部文件分类，无法确认删除结果。', 5)
    return { query: { categoryId: target.categoryId, max: 1000, offset: 0, searchName: latest.fileName, sort: 'updateDate', order: 'desc' } }
  }
  if (kind.startsWith('deliverable-file-') || kind.startsWith('deliverable-version-')) {
    moduleId(input, results); const file = ownedFile(input, results)
    if (kind === 'deliverable-file-verify') return { query: { fileId: file.fileId } }
    if (kind === 'deliverable-file-number') return { body: { fileId: file.fileId, fileNumber: input.fileNumber } }
    if (kind === 'deliverable-file-remove') {
      const present = rows(data(results.membership))
      if (present.length >= 1000 || !present.some(item => item.fileId === file.fileId)) throw new RsqError('CONTEXT_CONFLICT', '删除前文件列表不完整或未找到目标；停止写入并重新发现。', 5)
      return { query: { fileId: file.fileId } }
    }
    if (kind === 'deliverable-file-move') { category(results, input.categoryId, true); return { body: { fileId: file.fileId, categoryId: input.categoryId } } }
    if (kind === 'deliverable-version-snapshot') return { body: { fileId: file.fileId } }
    if (kind === 'deliverable-version-update') {
      const version = rows(file.versions).find(version => version.versionId === input.versionId)
      if (!version) throw new RsqError('CONTEXT_MISSING', '版本不属于指定交付物文件。', 2)
      const patch = asObject(input.patch), numeric = ['versionMajor', 'versionMinor', 'versionPatch'], count = numeric.filter(key => patch[key] !== undefined).length
      if (count !== 0 && count !== 3) throw new RsqError('INVALID_INPUT', '版本号必须同时提供主版本、次版本和修订版本；仅改说明时可全部省略。', 2)
      return { body: { fileId: file.fileId, versionId: version.versionId, ...patch } }
    }
  }
  throw new RsqError('INVALID_CONTRACT', '未知交付物上下文适配。', 5)
}
export function verifyDeliverable(input: JsonObject, results: JsonObject, step: string) {
  if (step === 'verifiedTaskSourceFile') {
    const before = asObject(results.file), actual = ownedFile(input, { ...results, file: results[step] })
    const versions = (file: JsonObject) => rows(file.versions).map(version => Object.fromEntries(['versionId', 'fileName', 'isLatest', 'description', 'versionMajor', 'versionMinor', 'versionPatch'].filter(key => Object.hasOwn(version, key)).map(key => [key, version[key]]))).sort((a, b) => String(a.versionId).localeCompare(String(b.versionId)))
    if (JSON.stringify(versions(before)) !== JSON.stringify(versions(actual))) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务关系写入后源交付物版本与初始状态不同，请核对，不自动重放。', 5)
    return
  }
  if (['taskFiles', 'latestTaskFiles', 'verifiedTaskFiles'].includes(step)) {
    const actual = asObject(results[step])
    if (typeof actual.isShow !== 'boolean') throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务交付物缺少明确 UI 显示状态。', 5)
    const items = actual.isShow ? deliveryRows(actual) : []
    if (step === 'verifiedTaskFiles') {
      const before = deliveryRows(results.taskFiles).map(item => identifier(item.id))
      const expected = asObject(results.taskDelivery).expectedIds ?? [...new Set([...before, identifier(asObject(results.prepared).fileId)])]
      if (!Array.isArray(expected) || JSON.stringify(items.map(item => identifier(item.id)).sort()) !== JSON.stringify([...expected].sort())) throw new RsqError('BUSINESS_ASSERTION_FAILED', '任务交付物关联独立读回不一致；保留资源 ID，请先核对，勿重放。', 5)
    }
    const safeKeys = ['id', 'name', 'version', 'state', 'categoryName', 'contentType', 'commonFileIdOfVersion', 'versionId']
    results[step] = { isShow: actual.isShow, tables: rows(actual.tables ?? []).filter(table => safeKeys.includes(String(table.columnKey))), tableRows: items.map(item => Object.fromEntries(safeKeys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))) }
    return
  }
  const fail = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
  if (step === 'verifiedEnabled' || step === 'verifiedDisabled') {
    const exists = rows(results[step]).some(module => module.type === 'deliverable')
    if (exists !== (step === 'verifiedEnabled')) fail('交付物模块可见状态未按要求持久化。')
  } else if (step === 'verifiedCategory' || step === 'verifiedCategoryRemoved' || step === 'verifiedMove') {
    const all = categories(results[step]), created = asObject(data(results.changed)), id = input.categoryId ?? created.categoryId
    const node = all.get(identifier(id))
    if (step === 'verifiedCategoryRemoved') { if (node) fail('分类删除后仍在当前项目树中。'); return }
    if (!node) fail('修改后的分类未出现在当前项目树中。')
    if (input.name !== undefined && node!.node.name !== input.name) fail('分类名称未按要求持久化。')
    if (step === 'verifiedCategory' && input.categoryId === undefined && node!.parent !== (input.parentId ?? null)) fail('新分类的父级与指定目标不一致。')
    if (step === 'verifiedMove') {
      const expected = asObject(results.prepared), ids = node!.siblings.map(node => identifier(node.categoryId)), position = ids.indexOf(identifier(id))
      if (node!.parent !== expected.parentId || (position > 0 ? ids[position - 1] : null) !== expected.frontId || (position + 1 < ids.length ? ids[position + 1] : null) !== expected.nextId) fail('分类父级或排序相邻项未按要求持久化。')
    }
  } else if (step === 'verifiedBaseline' || step === 'verifiedBaselineRemoved') {
    const changed = asObject(data(results.changed)), id = input.baselineId ?? changed.baselineId, found = rows(data(results[step])).find(baseline => baseline.baselineId === id)
    if (step === 'verifiedBaselineRemoved') { if (found) fail('基线删除后仍在当前模块中。'); return }
    if (!found || input.name !== found.name || input.draftStrategy !== undefined && input.draftStrategy !== found.draftStrategy) fail('交付物基线名称或处理策略未按要求持久化。')
  } else if (step === 'verifiedUpload') {
    const file = asObject(results[step]), expectedId = asObject(results.prepared).fileId
    if (file.fileId !== expectedId || String(file.projectId) !== projectId(input, results)) fail('上传后的文件 ID 或所属项目不一致；停止后续写入并核对。')
    const latest = rows(file.versions).filter(version => version.isLatest === true)
    if (latest.length !== 1 || latest[0].fileName !== asObject(results.localUpload).name) fail('上传后的最新文件名称或版本未按要求持久化。')
  } else if (step === 'verifiedFileMoved' || step === 'verifiedFileRemoved') {
    const files = rows(data(results[step])), present = files.some(file => file.fileId === input.fileId)
    if (files.length >= 1000 || present !== (step === 'verifiedFileMoved')) fail('文件列表未能完整确认移动或删除；写入已发送，先重新发现，不能自动重放。')
  } else if (step === 'verifiedFile' || step === 'verifiedVersion') {
    const before = asObject(data(results.file)), after = asObject(data(results[step]))
    if (after.fileId !== input.fileId || String(after.projectId) !== projectId(input, results)) fail('读回文件的 ID 或项目归属不同。')
    if (input.fileNumber !== undefined && after.fileNumber !== input.fileNumber) fail('交付物编号未按要求持久化。')
    const versions = rows(after.versions)
    if (input.patch !== undefined) {
      const version = versions.find(version => version.versionId === input.versionId)
      if (!version || Object.entries(asObject(input.patch)).some(([key, value]) => version[key] !== value)) fail('版本号或说明未按要求持久化。')
    }
    if (step === 'verifiedVersion' && input.patch === undefined) {
      const old = new Set(rows(before.versions).map(version => identifier(version.versionId))), added = versions.filter(version => !old.has(identifier(version.versionId)))
      if (added.length !== 1 || versions.length !== old.size + 1 || added[0].isLatest !== true) fail('快照未形成唯一新版本，不能自动重试创建。')
    }
  }
}
export function describeDeliverable(input: JsonObject, results: JsonObject, type: string) {
  if (type === 'deliverable-files') {
    const values = rows(data(results.files)), max = Number(input.max ?? 30), offset = Number(input.offset ?? 0)
    return { items: values, page: { max, offset, total: null, nextOffset: values.length === max ? offset + values.length : null } }
  }
  return { projectId: projectId(input, results), moduleId: moduleId(input, results), categories: data(results.tree), baselines: data(results.baselines) }
}
