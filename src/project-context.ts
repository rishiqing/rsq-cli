import { isDeepStrictEqual } from 'node:util'
import { asObject,parseJson,RsqError,type JsonObject } from './core.js'
import { requireSession,type Session } from './session.js'
import { describeContact } from './contact.js'
import { prepareProjectMember, verifyProjectMember, describeProjectMembers } from './project-members.js'
import { prepareProjectRisk, verifyProjectRisk, describeProjectRisk } from './project-risk.js'
import { prepareProjectAlteration, verifyProjectAlteration, describeProjectAlteration } from './project-alteration.js'
const same = (a: unknown,b: unknown) => a != null && b != null && String(a) === String(b)
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT',message,2) }
const assertion = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED',message,5) }
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('CONTEXT_MISSING','项目服务没有返回预期列表。',5);return value.map(asObject) }
const key = (value: unknown) => { if (!(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) throw new RsqError('CONTEXT_MISSING','项目上下文缺少精确的资源 ID。',5);return String(value) }
const builtins = new Set(['all','star','ungrouped'])
type Group = { id: string; parentId: string | null; depth: number; row: JsonObject }
export function projectGroups(value: unknown): Group[] {
  const result: Group[] = [],seen = new Set<string>()
  const walk = (items: JsonObject[],parentId: string | null,depth: number) => {
    if (!items.length) return
    if (depth > 5 || result.length+items.length > 10000) throw new RsqError('CONTEXT_MISSING','项目分组层级或数量超出已核对范围。',5)
    for (const row of items) {
      const id = builtins.has(String(row.id)) ? String(row.id) : key(row.id)
      if (seen.has(id)) throw new RsqError('CONTEXT_MISSING','项目树存在重复分组，不能猜测父级。',5);seen.add(id)
      const actualParent = row.parentGroupId == null ? parentId : key(row.parentGroupId)
      if (actualParent !== parentId) throw new RsqError('CONTEXT_MISSING','项目树父组与节点上下文不一致。',5)
      result.push({ id,parentId,depth,row });walk(row.groupList == null ? [] : rows(row.groupList),id,depth+1)
    }
  }
  walk(rows(value),null,1);return result
}
function group(value: unknown,id: unknown): Group {
  const found = projectGroups(value).find(group => group.id === id)
  if (!found) throw new RsqError('FORBIDDEN','分组必须来自当前公司实际可见树，不能使用其他公司或猜测的分组 ID。',4)
  return found
}
function actor(results: JsonObject,supplied: Session | null,companyId?: unknown) {
  const session = requireSession(supplied),identity = asObject(results.identity)
  if (!same(identity.id,session.identity.userId) || !same(asObject(identity.team).id,session.identity.teamId)) throw new RsqError('IDENTITY_CHANGED','项目上下文与当前 profile 的真实身份或公司不一致。',3)
  if (companyId != null && companyId !== session.identity.teamId) throw new RsqError('ORGANIZATION_MISMATCH','请显式使用当前公司 ID，未发送公司分组写入。',4)
  return session
}
function editableGroup(input: JsonObject,results: JsonObject,supplied: Session | null) {
  actor(results,supplied,input.companyId)
  if (asObject(results.company).editKanbanGroup !== true) throw new RsqError('FORBIDDEN','当前 UI 未授予 editKanbanGroup 权限。',4)
}
function ordinary(input: JsonObject,results: JsonObject,step = 'project') {
  const current = asObject(results[step]),id = step === 'verifiedProject' && results.created ? asObject(results.created).id : input.projectId
  if (!same(current.id,id) || !Object.hasOwn(current,'coverId') || current.coverId !== null) throw new RsqError('CONTEXT_MISMATCH','这里必须是实际普通项目；模板请使用 project template 命令。',4)
  return current
}
function allowed(project: JsonObject,permission: string) { if (asObject(project.editControl)[permission] !== true) throw new RsqError('FORBIDDEN','项目没有授予操作权限：'+permission,4) }
function description(value: unknown) {
  if (value === '') return ''
  let delta: JsonObject
  if (typeof value === 'string') delta = { ops: [{ insert: value.endsWith('\n') ? value : value+'\n' }] }
  else delta = asObject(value)
  if (!Array.isArray(delta.ops) || delta.ops.length > 10000 || delta.ops.some(item => { const op = asObject(item);return !Object.hasOwn(op,'insert') || Object.keys(op).some(key => !['insert','attributes'].includes(key)) || typeof op.insert !== 'string' && !op.insert || op.attributes != null && op.attributes !== asObject(op.attributes) })) invalid('项目说明须为文本或只含 insert/attributes 的完整 Delta，不能传 retain/delete 差量。')
  return JSON.stringify(delta)
}
function sortAnchors(groups: Group[],source: Group | undefined,input: JsonObject,parent: string | null) {
  const siblings = groups.filter(group => !builtins.has(group.id) && group.parentId === parent && group.id !== source?.id)
  if (siblings.some(group => typeof group.row.displayOrder !== 'number' || !Number.isFinite(group.row.displayOrder))) throw new RsqError('CONTEXT_MISSING','分组顺序值不完整，不能构造相邻锚点。',5)
  siblings.sort((a,b) => Number(a.row.displayOrder)-Number(b.row.displayOrder) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  let index = siblings.length
  if (input.targetId != null) {
    if (input.targetId === source?.id) invalid('排序目标不能是分组自身。')
    const at = siblings.findIndex(group => group.id === input.targetId)
    if (at < 0) invalid('排序只能在同一父级的真实分组之间进行；UI 不支持跨父组拖动。')
    index = at+(input.position === 'before' ? 0 : 1)
  }
  const order = [...siblings.slice(0,index).map(group => group.id),'$moving',...siblings.slice(index).map(group => group.id)]
  return { anchors: { ...(siblings[index-1] && { frontId: siblings[index-1].id }),...(siblings[index] && { nextId: siblings[index].id }) },order }
}
export function prepareProjectContext(kind: string,input: JsonObject,results: JsonObject,supplied: Session | null): JsonObject | null {
  const action = kind.replace('project-context-',''),session = actor(results,supplied)
  if (action.startsWith('member-')) return prepareProjectMember(action.slice(7),input,results,supplied)
  if (action.startsWith('risk-')) return prepareProjectRisk(action.slice(5),input,results)
  if (action.startsWith('alteration-')) return prepareProjectAlteration(action.slice(11),input,results)
  if (action === 'template-create') {
    if (asObject(results.company).editKanbanGroup !== true) throw new RsqError('FORBIDDEN','当前新建模板 UI 要求 editKanbanGroup 权限。',4)
    return { headers: { 'Plan-Type': 'template' },body: { name: input.name,attribute: input.attribute,...(input.description != null && { description: description(input.description) }),...(input.cover != null && { cover: input.cover }) } }
  }
  if (action === 'template-update' || action === 'template-remove' || action === 'template-apply') {
    const cover = asObject(results.before)
    if (!same(cover.id,input.coverId)) throw new RsqError('CONTEXT_MISMATCH','封面 ID 必须与当前模板详情相符。',4)
    const projectId = key(cover.templateKanbanId)
    if (action !== 'template-apply' && cover.withEdit !== true) throw new RsqError('FORBIDDEN','模板详情未授予可编辑权限；系统模板或无权限企业模板不可修改。',4)
    if (action === 'template-remove') return { headers: { 'Plan-Type': 'template' },query: { id: projectId } }
    if (action === 'template-update') return { headers: { 'Plan-Type': 'template' },body: { id: projectId,...(input.name != null && { name: input.name }),...(input.description != null && { description: description(input.description) }),...(input.cover != null && { cover: input.cover }) } }
    if (cover.needLevelUp !== false) throw new RsqError('FEATURE_UPGRADE_REQUIRED','该模板包含当前公司未开通的模块，不能绕过 UI 应用。',4)
    const destination = input.kanbanGroupId ?? 'ungrouped'
    if (!['all','star','ungrouped'].includes(String(destination))) group(results.groups,destination)
    const directory = asObject(describeContact({},{ tree: results.directory })),members = new Set(rows(directory.members).map(member => String(member.id))),departments = new Set(rows(directory.departments).map(department => String(department.id)))
    const csv = (value: unknown,allowed: Set<string>) => { if (value == null || value === '') return [];if (typeof value !== 'string') invalid('成员和部门必须为实际目录 ID 的 CSV。');const ids = (value as string).split(',');if (new Set(ids).size !== ids.length || ids.some(id => !/^[1-9][0-9]*$/.test(id) || !allowed.has(id))) invalid('项目成员或部门包含非当前公司目录 ID 或重复项。');return ids }
    const selectedMembers = csv(input.memberIds,members),selectedDepartments = csv(input.deptIds,departments)
    if (!selectedMembers.includes(session.identity.userId)) selectedMembers.unshift(session.identity.userId)
    return { body: { templateKanbanId: projectId,name: input.name,attribute: input.attribute,memberIds: selectedMembers.join(','),deptIds: selectedDepartments.join(','),kanbanGroupId: destination === 'star' ? 'ungrouped' : destination,...(destination === 'star' && { isStar: true }) } }
  }
  if (action === 'template-save') {
    ordinary(input,results)
    if (asObject(results.company).editKanbanTemp !== true) throw new RsqError('FORBIDDEN','保存现有项目为模板要求 editKanbanTemp 权限。',4)
    return { headers: { 'Plan-Type': 'template' },body: { id: input.projectId,attribute: input.attribute } }
  }
  if (action === 'template-verify-catalogue') return { query: { id: input.attribute === 'company' ? 'company' : 'my' } }
  if (action === 'recycle-restore' || action === 'recycle-purge') {
    const entries = rows(results.entries).filter(entry => same(entry.id,input.entryId) && same(entry.resourceId,input.projectId) && same(entry.userId,session.identity.userId) && Number(entry.type) === 2)
    if (entries.length !== 1) throw new RsqError('FORBIDDEN','回收记录 ID 与普通项目资源 ID 必须同时匹配本人的实际 type=2 回收记录。',4)
    if (projectGroups(results.groups).some(group => rows(group.row.kanbanList ?? []).some(project => same(project.id,input.projectId)))) throw new RsqError('CONTEXT_MISMATCH','该项目仍在活动列表中，不能重放恢复或清理操作。',4)
    return action === 'recycle-restore' ? { body: { id: input.entryId } } : { query: { id: input.entryId } }
  }
  if (action === 'list') {
    if (!builtins.has(String(input.groupId ?? 'all'))) group(results.groups,input.groupId)
    return { query: { kanbanGroupId: input.groupId ?? 'all' } }
  }
  if (action.startsWith('group-')) {
    editableGroup(input,results,supplied);const groups = projectGroups(results.groups)
    if (action === 'group-create') {
      const parent = input.parentId != null ? group(results.groups,input.parentId) : undefined
      if (parent && (builtins.has(parent.id) || parent.depth >= 5 || parent.row.canCreateChildGroup === false)) invalid('父分组不能是内置分组，且项目分组最多五级。')
      const { anchors,order } = sortAnchors(groups,undefined,input,parent?.id ?? null)
      results.projectExpected = { parentId: parent?.id ?? null,name: input.name,order }
      return { body: { name: input.name,...(parent && { parentGroupId: parent.id }),...anchors } }
    }
    const source = group(results.groups,input.groupId)
    if (builtins.has(source.id)) invalid('内置分组不能修改、排序或删除。')
    if (action === 'group-rename') { results.projectExpected = { name: input.name,parentId: source.parentId };return { body: { id: source.id,name: input.name } } }
    if (action === 'group-remove') {
      results.projectExpected = { parentId: source.parentId,children: groups.filter(group => group.parentId === source.id).map(group => group.id),projects: rows(source.row.kanbanList ?? []).map(row => key(row.id)) }
      return { query: { id: source.id } }
    }
    if (action === 'group-move') { const { anchors,order } = sortAnchors(groups,source,input,source.parentId);results.projectExpected = { order,parentId: source.parentId };return { body: { moveId: source.id,...anchors } } }
  }
  if (action === 'catalogue') {
    const categoryId = input.templateCategory ?? input.category
    if (!rows(results.categories).some(category => same(category.id,categoryId))) throw new RsqError('FORBIDDEN','模板分类必须先从当前可见分类发现。',4)
    return { query: { id: categoryId } }
  }
  if (action === 'cover') {
    const cover = rows(results.templates).find(template => same(template.id,input.coverId))
    if (!cover) throw new RsqError('FORBIDDEN','所选封面必须来自当前分类可见模板目录。',4)
    if (input.coverId === 'empty') { results.cover = cover;return null }
    return { query: { id: input.coverId } }
  }
  if (action === 'create') {
    const cover = asObject(results.cover)
    if (!same(cover.id,input.coverId) || !key(cover.templateKanbanId)) throw new RsqError('CONTEXT_MISSING','封面与模板项目 ID 不一致。',5)
    if (cover.needLevelUp !== false) throw new RsqError('FEATURE_UPGRADE_REQUIRED','模板包含当前公司未开通的模块，CLI 遵循 UI 的升级限制。',4)
    const destination = input.groupId == null ? 'ungrouped' : input.groupId
    if (destination === 'star') invalid('星标是个人视图，不能作为实际归属分组。')
    if (!['ungrouped','all'].includes(String(destination))) group(results.groups,destination)
    if (input.attribute === 'company' && !session.identity.teamId) invalid('企业项目需要当前公司身份。')
    results.projectExpected = { name: input.name,attribute: input.attribute,groupId: destination }
    return { body: { name: input.name,attribute: input.attribute,templateKanbanId: key(cover.templateKanbanId),kanbanGroupId: destination } }
  }
  const project = ordinary(input,results)
  if (action === 'remove') { allowed(project,'removeKanban');return { query: { id: input.projectId } } }
  if (action === 'update' || action === 'view') {
    const patch = action === 'view' ? { showView: input.view } : asObject(input.patch)
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !['name','description','groupId','showView','isSyncOauthTodo','isSyncWorkflowTodo'].includes(key))) invalid('项目补丁包含未核对属性。')
    const body: JsonObject = { id: input.projectId },expected: JsonObject = {}
    for (const [key,value] of Object.entries(patch)) {
      if (key === 'name' && (typeof value !== 'string' || !value.trim())) invalid('项目名称不能为空。')
      allowed(project,key.startsWith('isSync') ? 'editKanbanPreferences' : key === 'showView' ? 'editKanbanView' : 'editKanbanInfo')
      if (key === 'groupId') { if (value !== 'ungrouped') { if (builtins.has(String(value))) invalid('实际项目归属只能是普通分组或 ungrouped。');group(results.groups,value) }body.kanbanGroupId = value === 'ungrouped' ? '' : value;expected.kanbanGroupId = value === 'ungrouped' ? null : String(value) }
      else { body[key] = key === 'description' ? description(value) : value;expected[key] = body[key] }
    }
    results.projectExpected = expected
    return { body }
  }
  throw new RsqError('INVALID_CONTRACT','未知项目上下文编排。',6)
}
function deltaEqual(actual: unknown,expected: unknown) { if (expected === '') return actual === '' || actual === null;try { return isDeepStrictEqual(typeof actual === 'string' ? parseJson(actual) : actual,typeof expected === 'string' ? parseJson(expected) : expected) } catch { return false } }
export function verifyProjectContext(input: JsonObject,results: JsonObject,step: string) {
  if (results.projectMemberContext) return verifyProjectMember(input,results,step)
  if (results.riskContext) return verifyProjectRisk(input,results,step)
  if (results.alterationContext) return verifyProjectAlteration(input,results,step)
  if (step === 'template' || step === 'verifiedCatalogue') {
    const created = asObject(results.created),before = asObject(results.before),coverId = input.coverId ?? created.coverId,template = asObject(results.template)
    if (!same(template.id,coverId) || !same(template.templateKanbanId,created.id ?? before.templateKanbanId)) assertion('模板封面和实际模板项目 ID 读回不符。')
    for (const key of ['name','description','cover']) if (input[key] !== undefined) {
      const expected = key === 'description' ? description(input[key]) : input[key]
      if (key === 'description' ? !deltaEqual(template[key],expected) : template[key] !== expected) assertion('项目模板属性未独立保存：'+key)
    }
    if (step === 'verifiedCatalogue' && !rows(results.verifiedCatalogue).some(row => same(row.id,coverId) && same(row.templateKanbanId,template.templateKanbanId))) assertion('新模板未在指定个人或企业目录中独立确认。')
    return
  }
  if (step === 'remainingEntries') {
    if (rows(results.remainingEntries).some(entry => same(entry.id,input.entryId))) assertion('项目回收记录仍存在，未确认恢复或清理完成。')
    return
  }
  if (step === 'verifiedGroups') {
    const expected = asObject(results.projectExpected),groups = projectGroups(results.verifiedGroups)
    if (results.removed !== undefined) {
      if (groups.some(group => group.id === input.groupId)) assertion('删除后项目分组仍存在。')
      for (const id of expected.children as string[]) if (groups.find(group => group.id === id)?.parentId !== expected.parentId) assertion('删除分组后，直接子组未迁移到原父组。')
      const destinations = groups.filter(group => expected.parentId == null ? ['ungrouped','all'].includes(group.id) : group.id === expected.parentId).flatMap(group => rows(group.row.kanbanList ?? []))
      for (const id of expected.projects as string[]) if (!destinations.some(row => same(row.id,id))) assertion('删除分组后，原直接项目未在父级独立确认。')
      return
    }
    const id = results.createdGroup ? key(asObject(results.createdGroup).id) : input.groupId as string,found = groups.find(group => group.id === id)
    if (!found || found.parentId !== expected.parentId || expected.name != null && found.row.name !== expected.name) assertion('项目分组名称或实际父级读回不符。')
    if (Array.isArray(expected.order)) {
      const siblings = groups.filter(group => !builtins.has(group.id) && group.parentId === expected.parentId).sort((a,b) => Number(a.row.displayOrder)-Number(b.row.displayOrder) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).map(group => group.id)
      if (!isDeepStrictEqual(siblings,expected.order.map(value => value === '$moving' ? id : value))) assertion('项目分组完整顺序与预期不符，可能并发变化，未重发排序。')
    }
    return
  }
  if (step === 'recycledProjects') {
    const entries = rows(results.recycledProjects).filter(entry => same(entry.resourceId,input.projectId) && Number(entry.type) === 2 && same(entry.userId,asObject(results.identity).id))
    if (entries.length !== 1) assertion('项目删除后没有在本人的回收记录中唯一确认，需先分页读回。')
    if (rows(asObject(results.verifiedList).kanbanList).some(row => same(row.id,input.projectId))) assertion('回收记录已产生，但项目仍在活动列表中。')
    return
  }
  const project = ordinary(input,results,'verifiedProject'),expected = asObject(results.projectExpected)
  for (const [key,value] of Object.entries(expected)) {
    if (key === 'groupId') { const actual = project.kanbanGroupId;if (['all','ungrouped'].includes(String(value)) ? actual != null && actual !== '' : !same(actual,value)) assertion('创建的项目实际分组不符。') }
    else if (key === 'description' ? !deltaEqual(project[key],value) : key === 'kanbanGroupId' ? value == null ? project[key] != null && project[key] !== '' : !same(project[key],value) : !isDeepStrictEqual(project[key],value)) assertion('项目独立读回属性不符：'+key)
  }
}
const projectFields = ['id','name','description','coverId','attribute','isStar','showView','creatorId','kanbanGroupId','memberNum','isSyncOauthTodo','isSyncWorkflowTodo','isArchive','editControl','defaultTeamRole','kanbanChildId','kanbanChildName']
const publicProject = (value: unknown) => { const row = asObject(value);return Object.fromEntries(projectFields.filter(key => Object.hasOwn(row,key)).map(key => [key,/Id$|^id$/.test(key) && row[key] != null && row[key] !== '' ? key === 'kanbanGroupId' && builtins.has(String(row[key])) ? String(row[key]) : key === 'coverId' ? String(row[key]) : keyOf(row[key]) : row[key]])) }
const keyOf = (value: unknown) => key(value)
export function describeProjectContext(input: JsonObject,results: JsonObject) {
  if (results.projectMemberContext) return describeProjectMembers(input,results)
  if (results.riskContext) return describeProjectRisk(input,results)
  if (results.alterationContext) return describeProjectAlteration(input,results)
  if (results.remainingEntries && !results.verifiedProject) return { projectId: input.projectId,entryId: input.entryId,removedFromRecycleBin: true,scope: 'recycle-record-only; not physical project erasure' }
  if (results.recycledProjects) return { removedProjectId: input.projectId,recycleEntries: rows(results.recycledProjects).filter(entry => same(entry.resourceId,input.projectId) && Number(entry.type) === 2 && same(entry.userId,asObject(results.identity).id)).map(entry => ({ id: key(entry.id),resourceId: key(entry.resourceId),type: 2 })),verified: true }
  if (results.verifiedProject || results.project) return { project: publicProject(results.verifiedProject ?? results.project),verified: results.verifiedProject != null }
  if (results.items) return { projects: rows(asObject(results.items).kanbanList).map(publicProject),groups: rows(asObject(results.items).groupList).map(row => ({ id: String(row.id),name: row.name,parentGroupId: row.parentGroupId })),groupId: input.groupId ?? 'all' }
  const tree = results.verifiedGroups ?? results.groups
  return { groups: projectGroups(tree).map(group => ({ id: group.id,name: group.row.name,parentId: group.parentId,depth: group.depth,displayOrder: group.row.displayOrder,canCreateChildGroup: !builtins.has(group.id) && group.depth < 5 && group.row.canCreateChildGroup !== false,projectIds: rows(group.row.kanbanList ?? []).map(project => key(project.id)) })),...(results.createdGroup != null && { id: key(asObject(results.createdGroup).id) }),verified: results.verifiedGroups != null }
}
