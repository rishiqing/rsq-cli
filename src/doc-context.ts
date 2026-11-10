import { docSharingActions, runDocSharing, type DocSharingAction } from './doc-sharing.js'
import { docPublicationActions, runDocPublication, type DocPublicationAction } from './doc-publication.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { asObject,parseJson,request,RsqError,type Context,type JsonObject,type Transport } from './core.js'
import { catalog,runOperation } from './operations.js'
import { requireSession,type Session } from './session.js'
import { collectOperationPages } from './pagination.js'
import { docCommentContent, docCommentDirectory } from './doc-comments.js'
import { docCollaborationActions, docCollaborationSteps, runDocCollaboration, type DocCollaborationAction } from './doc-collaboration.js'
import { docGroupActions, docGroupSteps, runDocGroups, type DocGroupAction } from './doc-groups.js'
import { docActivityPage, describeDocActivities } from './doc-activities.js'
import type { Workflow } from './workflows.js'

export type DocAction = 'activities' | DocGroupAction | DocPublicationAction | DocSharingAction | DocCollaborationAction | 'visibility-set' | 'body-inspect' | 'spaces' | 'space-inspect' | 'space-create' | 'space-update' | 'space-remove' | 'tree' | 'create' | 'inspect' | 'rename' | 'remove' | 'folder-create' | 'folder-rename' | 'folder-remove' | 'copy' | 'move' | 'comments' | 'comment-context' | 'comment-create' | 'comment-remove' | 'drafts' | 'draft-create' | 'draft-inspect' | 'draft-rename' | 'draft-remove' | 'draft-publish' | 'templates' | 'template-inspect' | 'template-create' | 'template-rename' | 'template-remove' | 'template-apply' | 'template-save'
type Route = [string,string,string,boolean?]
const corpus = '/task/v1/corpus',summary = corpus+'/summary',template = corpus+'/templateSummary'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT',message,2) }
const failed = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED',message,5) }
const idOf = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
const requiredId = (value: unknown): string => idOf(value) ?? invalid('缺少精确资源 ID；不能把超出安全范围的数字转换为 ID。')
const list = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : failed('HTTP 上下文不是有界资源列表。')
const permission = (row: JsonObject,key: string) => { if (asObject(row.editControl)[key] !== true) throw new RsqError('RESOURCE_FORBIDDEN','当前资源权限不允许此操作。',4,{ permission: key }) }
const textName = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid('名称须为 1–200 个非空字符，不能包含控制字符。')

/** A complete Quill snapshot, not an OT mutation. Extension values remain
 * ordinary JSON and are never executed or fetched by the CLI. */
export function docDelta(value: unknown): JsonObject {
  if (typeof value === 'string') return { ops: value ? [{ insert: value.endsWith('\n') ? value : value+'\n' }] : [] }
  const row = Array.isArray(value) ? { ops: value } : asObject(value)
  if (Object.keys(row).length !== 1 || !Array.isArray(row.ops) || row.ops.length > 20000) invalid('正文必须是文本或完整的 {ops:[{insert,attributes?}]} 快照。')
  for (const raw of row.ops as unknown[]) {
    const op = asObject(raw)
    if (!Object.hasOwn(op,'insert') || Object.keys(op).some(key => !['insert','attributes'].includes(key)) || typeof op.insert !== 'string' && (!op.insert || Array.isArray(op.insert) || typeof op.insert !== 'object' || Object.keys(op.insert).length !== 1) || op.attributes != null && (!op.attributes || Array.isArray(op.attributes) || typeof op.attributes !== 'object')) invalid('完整正文仅接受 insert 和可选 attributes；不能把 retain/delete 增量当作快照。')
  }
  const stack: unknown[] = [row];let nodes = 0
  while (stack.length) {
    const node = stack.pop()
    if (++nodes > 100000) invalid('正文结构过大。')
    if (node && typeof node === 'object') for (const [key,child] of Object.entries(node)) { if (['__proto__','constructor','prototype'].includes(key) || ['undefined','function','bigint','symbol'].includes(typeof child)) invalid('正文扩展必须是普通 JSON。');stack.push(child) }
    if (typeof node === 'number' && !Number.isFinite(node)) invalid('正文不能包含非有限数字。')
  }
  if (Buffer.byteLength(JSON.stringify(row)) > 4*1024*1024) invalid('文档正文最多 4 MiB。')
  return row
}
function receivedDelta(value: unknown) {
  const raw = asObject(value).templateDelta
  if (typeof raw !== 'string') failed('正文 HTTP 响应缺少 templateDelta。')
  try { return docDelta(raw ? parseJson(raw as string) : []) } catch { return failed('正文 HTTP 响应不是完整 Delta，未将元信息当作正文。') }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function equalDelta(actual: JsonObject,expected: JsonObject) {
  // Quill merges adjacent compatible strings. Keep attributes and embed data
  // exact while normalizing only that documented representation difference.
  const normalized = (delta: JsonObject) => {
    const ops: JsonObject[] = []
    for (const raw of delta.ops as JsonObject[]) { const op = { ...raw };if (op.attributes && !Object.keys(asObject(op.attributes)).length) delete op.attributes
      const last = ops.at(-1)
      if (typeof last?.insert === 'string' && typeof op.insert === 'string' && isDeepStrictEqual(last.attributes,op.attributes)) last.insert += op.insert
      else if (op.insert !== '') ops.push(op)
    }
    return ops
  }
  if (!isDeepStrictEqual(normalized(actual),normalized(expected))) failed('HTTP 读回正文与提交内容不一致。')
}
const safeKeys = ['id','name','type','attribute','corpusId','corpusType','noteBookId','isNoteBook','isShare','creatorId','displayOrder','isStar','corpusGroupId','isOpenToMember','isDisplay','isReditor','forbidEdit','isWideScreen','canBeShared','showsView','sort','isRelease','dateCreated','lastUpdated','hasChildNote']
export function describeDoc(row: JsonObject) {
  const result: JsonObject = Object.fromEntries(safeKeys.filter(key => Object.hasOwn(row,key)).map(key => [key,/Id$|^id$/.test(key) ? idOf(row[key]) ?? row[key] : row[key]]))
  if (row.creator) result.creator = { id: idOf(asObject(row.creator).id),showName: asObject(row.creator).showName }
  if (row.editControl) result.editControl = Object.fromEntries(Object.entries(asObject(row.editControl)).filter(([,value]) => typeof value === 'boolean'))
  if (Array.isArray(row.members)) result.members = row.members.map(raw => { const member = asObject(raw);return { userId: idOf(member.userId ?? member.id),role: typeof member.role === 'string' ? member.role : { id: idOf(asObject(member.role).id),name: asObject(member.role).name,type: asObject(member.role).type } } })
  if (row.defaultRole) result.defaultRole = { id: idOf(asObject(row.defaultRole).id),name: asObject(row.defaultRole).name,type: asObject(row.defaultRole).type }
  return result
}

export function docSteps(action: DocAction): Route[] {
  if (docGroupActions.includes(action as DocGroupAction)) return docGroupSteps(action as DocGroupAction)
  if (docCollaborationActions.includes(action as DocCollaborationAction)) return docCollaborationSteps(action as DocCollaborationAction)
  const identity: Route = ['identity','GET','/task/login/authAjax'],spaces: Route = ['spaces','GET',corpus+'/list'],space: Route = ['space','GET',corpus+'/{id}'],tree: Route = ['tree','GET',summary+'/list']
  const target: Route[] = [spaces,space,tree,['authority','GET',summary+'/authority'],['before','GET',summary]],delta: Route = ['content','GET',template+'/getTemplateDelta'],verifyDelta: Route = ['verifiedContent','GET',template+'/getTemplateDelta']
  const changed = (method: string,route: string): Route => ['changed',method,route],verified: Route = ['verified','GET',summary],afterTree: Route = ['verifiedTree','GET',summary+'/list'],templates: Route = ['templates','GET',template+'/list'],afterTemplates: Route = ['verifiedTemplates','GET',template+'/list']
  const drafts: Route = ['drafts','GET',summary+'/draftList'],afterDrafts: Route = ['verifiedDrafts','GET',summary+'/draftList'],company: Route = ['company','GET','/task/authority/v3/authorities/company/current']
  if (docPublicationActions.includes(action as DocPublicationAction)) return [identity,spaces,space,tree,['document','GET',summary],...(action === 'publication-inspect' ? [] : [changed('PUT',corpus+'/updateRelease'),['verified','GET',corpus+'/{id}'] as Route]),['publicSpace','GET',corpus+'/getShareCorpus'],['publicTree','GET',corpus+'/getSharedSummarylist'],['publicDocument','GET',summary+'/getShareNote']]
  if (action === 'spaces') return [identity,spaces]
  if (action === 'space-inspect') return [identity,spaces,space]
  if (action === 'space-create') return [identity,company,['groups','GET','/task/v1/corpusGroup/list'],changed('POST',corpus),['verified','GET',corpus+'/{id}'],['verifiedSpaces','GET',corpus+'/list']]
  if (action === 'space-update') return [identity,spaces,space,changed('PUT',corpus+'/{id}'),['verified','GET',corpus+'/{id}']]
  if (action === 'space-remove') return [identity,spaces,space,tree,changed('DELETE',corpus+'/{id}'),['verifiedSpaces','GET',corpus+'/list']]
  if (action === 'tree') return [identity,spaces,space,tree]
  if (action === 'create' || action === 'folder-create' || action === 'template-apply') return [identity,spaces,space,tree,...(action === 'template-apply' ? [templates,delta] : []),['changed','POST',summary,action === 'folder-create'],afterTree,...(action === 'folder-create' ? [] : [verified,verifyDelta])]
  if (action === 'drafts') return [identity,drafts]
  if (action === 'draft-create') return [identity,['changed','POST',summary,false],afterDrafts,verified,verifyDelta]
  if (action.startsWith('draft-')) return [identity,drafts,['before','GET',summary],delta,...(action === 'draft-inspect' ? [] : action === 'draft-publish' ? [spaces,space,tree,changed('POST',summary+'/draftToSummary'),afterDrafts,afterTree,verified,verifyDelta] : [changed(action === 'draft-remove' ? 'DELETE' : 'PUT',summary+'/{id}'),afterDrafts,...(action === 'draft-remove' ? [] : [verified,verifyDelta])])]
  if (action === 'templates') return [identity,templates]
  if (action === 'template-create') return [identity,company,changed('POST',template),afterTemplates,verifyDelta]
  if (action.startsWith('template-') && action !== 'template-save') return [identity,company,templates,delta,...(action === 'template-inspect' ? [] : [changed(action === 'template-remove' ? 'DELETE' : 'PUT',template+'/{id}'),afterTemplates,...(action === 'template-remove' ? [] : [verifyDelta])])]
  if (action === 'folder-rename' || action === 'folder-remove') return [identity,spaces,space,tree,changed(action === 'folder-remove' ? 'DELETE' : 'PUT',summary+'/{id}'),afterTree]
  if (docSharingActions.includes(action as DocSharingAction)) return [identity,...target,...(action === 'share-inspect' ? [] : [changed('PUT',summary+'/{id}'),verified]),['public','GET',summary+'/getShareNote']]
  if (action === 'visibility-set') return [identity,...target,changed('PUT',summary+'/{id}'),verified]
  if (action === 'inspect') return [identity,...target,delta]
  if (action === 'body-inspect') return [identity,...target,['content','GET','/task/reditor/client/resource/get-delta']]
  if (action === 'activities') return [identity,...target,['activities','GET',summary+'/actions'],['moreActivities','GET',summary+'/hasSummaryAction']]
  if (action === 'copy' || action === 'move') return [identity,...target,delta,['destination','GET',corpus+'/{id}'],['destinationTree','GET',summary+'/list'],changed('POST',summary+'/'+action),afterTree,['verifiedDestinationTree','GET',summary+'/list'],verified,verifyDelta]
  if (action === 'template-save') return [identity,company,...target,delta,changed('GET',template+'/noteToTemplate'),afterTemplates,verifyDelta]
  if (action.startsWith('comment') || action === 'comments') return [identity,...target,['comments','GET',summary+'/comments'],...(action === 'comment-context' || action === 'comment-create' ? [['directory','GET','/task/v1/department/list'] as Route] : []),...(['comments','comment-context'].includes(action) ? [] : [changed(action === 'comment-create' ? 'POST' : 'DELETE',summary+'/comment'+(action === 'comment-remove' ? '/{commentId}' : '')),['verifiedComments','GET',summary+'/comments'] as Route])]
  return [identity,...target,changed(action === 'remove' ? 'DELETE' : 'PUT',summary+'/{id}'),afterTree,...(action === 'remove' ? [] : [verified])]
}
export function validateDocWorkflow(flow: Workflow) {
  const actions = [...docPublicationActions,...docSharingActions,'visibility-set','body-inspect','spaces','space-inspect','space-create','space-update','space-remove','tree','create','inspect','rename','remove','folder-create','folder-rename','folder-remove','copy','move','comments','comment-context','comment-create','comment-remove','drafts','draft-create','draft-inspect','draft-rename','draft-remove','draft-publish','templates','template-inspect','template-create','template-rename','template-remove','template-apply','template-save']
  if (![...actions,...docCollaborationActions,...docGroupActions,'activities'].includes(flow.docAction ?? '')) throw new RsqError('INVALID_CONTRACT','未知文档业务。',6)
  const expected = docSteps(flow.docAction!)
  if (flow.executor !== 'document' || !flow.docAction || expected.length !== flow.steps.length || expected.some(([id,method,route,folder],index) => {
    const step = flow.steps[index],op = catalog.operations.find(op => op.id === step.operationId)
    const query = asObject(asObject(op?.inputSchema.properties).query), resourceType = asObject(asObject(query.properties).type).const
    return step.id !== id || op?.method !== method || op.route !== route || route === '/task/reditor/client/resource/get-delta' && resourceType !== 'doc' || folder !== undefined && asObject(op.defaults?.body).isNoteBook !== folder || Object.keys(step.input).length || step.prepare || step.verify || step.transfer || step.forEach || step.resources || step.collectPages || step.readback || step.authentication || step.waitBeforeMs || step.expectAbsent
  })) throw new RsqError('INVALID_CONTRACT','文档上下文步骤与已核对的 HTTP 协议不一致。',6)
}

export async function runDoc(ctx: Context,flow: Workflow,input: JsonObject,supplied: Session | null,options: { transport?: Transport; approved?: boolean } = {}) {
  validateDocWorkflow(flow)
  if (docGroupActions.includes(flow.docAction as DocGroupAction)) return runDocGroups(ctx,flow,input,supplied,options)
  if (docCollaborationActions.includes(flow.docAction as DocCollaborationAction)) return runDocCollaboration(ctx,flow,input,supplied,options)
  const session = requireSession(supplied),action = flow.docAction!,completed: string[] = [],resources: Record<string,string> = {},responses: JsonObject = {}
  let phase = 'identity',pending = false
  const call = async (id: string,args: JsonObject = {}) => {
    const step = flow.steps.find(step => step.id === id),op = catalog.operations.find(op => op.id === step?.operationId)
    if (!op) throw new RsqError('INVALID_CONTRACT','文档业务调用了未声明的操作。',6)
    phase = id;pending = op.effect !== 'read'
    const transport: Transport = async (url,init) => {
      const response = await (options.transport ?? request)(url,init)
      if (id === 'changed' && response.ok) try { const row = asObject(parseJson(await response.clone().text()));if (idOf(row.id) || typeof row.id === 'string' && /^(my|company)-[1-9][0-9]*$/.test(row.id)) resources[action.startsWith('template') && action !== 'template-apply' ? 'templateId' : action.startsWith('space') ? 'spaceId' : 'documentId'] = String(row.id) } catch {}
      return response
    }
    const value = await runOperation(ctx,op,args,session,{ ...options,transport });pending = false;completed.push(id);responses[id] = value
    if (id === 'changed') { const row = asObject(value);if (idOf(row.id) || typeof row.id === 'string' && /^(my|company)-[1-9][0-9]*$/.test(row.id)) resources[action.startsWith('template') && action !== 'template-apply' ? 'templateId' : action.startsWith('space') ? 'spaceId' : 'documentId'] = String(row.id) }
    return value
  }
  const pages = async (stepId: string) => {
    const step = flow.steps.find(step => step.id === stepId),op = catalog.operations.find(op => op.id === step?.operationId)!
    phase = stepId;pending = false
    const rows = await collectOperationPages(ctx,op,{ query: { max: 50 } },session,{ limit: 50,cursorParameter: 'lastId',cursorField: 'id',pageSizeParameter: 'max' },options.transport)
    completed.push(stepId);responses[stepId] = rows;return list(rows)
  }
  const scan = async (stepId: string,spaceId: string) => {
    const found = new Map<string,JsonObject>(),queue: { id?: string;depth: number }[] = [{ depth: 0 }]
    for (let index = 0;index < queue.length;index++) {
      if (queue.length > 1000 || queue[index].depth > 64) failed('目录超过 1000 个文件夹或 64 层；未执行写入。')
      const folder = queue[index],rows = list(await call(stepId,{ query: { ...(folder.id ? { noteBookId: folder.id } : { corpusId: spaceId }),allData: true } }))
      for (const row of rows) {
        const id = requiredId(row.id)
        if (found.has(id) || idOf(row.corpusId) !== spaceId || (idOf(row.noteBookId) ?? null) !== (folder.id ?? null) || typeof row.isNoteBook !== 'boolean') failed('目录存在重复、跨文集或错误父级，已停止。')
        found.set(id,row);if (found.size > 10000) failed('目录超过 10000 项，未将截断结果当作完整上下文。')
        if (row.isNoteBook) queue.push({ id,depth: folder.depth+1 })
      }
    }
    return found
  }
  const visibleSpace = (spaces: JsonObject[],id: string) => { const row = spaces.find(row => idOf(row.id) === id);if (!row) throw new RsqError('RESOURCE_NOT_VISIBLE','目标文集未在当前公司的可见文集中找到。',4);if (row.type !== 'essays') throw new RsqError('RETIRED_BUSINESS','仅支持当前普通知识文集；旧日报/周报/月报请使用复盘。',6);return row }
  const parent = (tree: Map<string,JsonObject>,space: JsonObject,folderId: unknown,createFolder = false) => { const id = folderId == null ? undefined : requiredId(folderId),row = id ? tree.get(id) : space;if (!row || id && row.isNoteBook !== true) invalid('父目录不在当前文集的可见 HTTP 目录中。');permission(row!,createFolder ? 'createNoteBook' : 'createNote');return id ? { noteBookId: id } : { corpusId: requiredId(space.id) } }
  const delta = async (stepId: string,id: string,isTemplate = false) => action === 'body-inspect'
    ? docDelta(list(await call(stepId,{ query: { id,type: 'doc' } })))
    : receivedDelta(await call(stepId,{ query: { id: isTemplate ? id : 'normal-'+id } }))
  const detail = async (stepId: string,id: string,spaceId?: string,draft = false) => {
    const row = asObject(await call(stepId,{ query: { id } }))
    if (idOf(row.id) !== id || row.isNoteBook !== false || row.isDisplay === false || (draft ? !!row.corpusId || idOf(asObject(row.creator).id) !== session.identity.userId : idOf(row.corpusId) !== spaceId)) failed('文档详情与真实归属或创建者不一致。')
    return row
  }
  const catalogue = (value: unknown) => {
    const rows = list(value),ids = new Set()
    for (const row of rows) { if (typeof row.id !== 'string' || !/^(my|company|normal)-[1-9][0-9]*$/.test(row.id) || ids.has(row.id)) failed('模板目录包含无效或重复复合 ID。');ids.add(row.id) }
    return rows
  }
  const templatePermission = (row: JsonObject,company: JsonObject) => { if (String(row.id).startsWith('normal-')) throw new RsqError('RESOURCE_FORBIDDEN','系统模板不可修改或删除。',4);if (String(row.id).startsWith('company-') && input.companyId !== session.identity.teamId) invalid('企业模板写入须明确指定当前 companyId。');if (String(row.id).startsWith('company-') && company.editNoteTemp !== true) throw new RsqError('RESOURCE_FORBIDDEN','企业模板需要 editNoteTemp 公司权限。',4) }
  try {
    const identity = asObject(await call('identity'))
    if (idOf(identity.id) !== session.identity.userId || idOf(asObject(identity.team).id ?? identity.teamId) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED','当前用户或公司与 profile 不一致。',3)
    if (action === 'drafts') { const drafts = await pages('drafts');return { workflow: flow.id,completedSteps: completed,resources,result: { drafts: drafts.map(describeDoc) } } }
    if (action === 'templates') return { workflow: flow.id,completedSteps: completed,resources,result: { templates: catalogue(await call('templates')).map(describeDoc) } }
    let company: JsonObject = {}
    if (flow.steps.some(step => step.id === 'company')) company = asObject(await call('company'))
    if (input.scope === 'company' && input.companyId !== session.identity.teamId) invalid('企业模板写入须明确指定当前 companyId。')
    if (action === 'space-create') {
      if (company.createCorpus !== true) throw new RsqError('RESOURCE_FORBIDDEN','当前公司权限不允许创建知识文集。',4)
      const groups = list(await call('groups'))
      if (input.groupId != null && !groups.some(group => idOf(group.id) === input.groupId)) invalid('分组必须从当前公司真实知识文集分组中发现。')
      const changed = asObject(await call('changed',{ body: { name: textName(input.name),memberIds: session.identity.userId,position: 'bottom',isStar: false,type: 'essays',...(input.groupId != null ? { corpusGroupId: input.groupId } : {}) } })),spaceId = requiredId(changed.id)
      const verified = asObject(await call('verified',{ path: { id: spaceId } })),visible = list(await call('verifiedSpaces'))
      if (idOf(verified.id) !== spaceId || verified.type !== 'essays' || verified.name !== input.name || idOf(verified.creatorId) !== session.identity.userId || idOf(verified.corpusGroupId) !== idOf(input.groupId) || !visible.some(row => idOf(row.id) === spaceId)) failed('创建的文集与当前用户、分组或独立列表不一致。')
      return { workflow: flow.id,completedSteps: completed,resources,result: { space: describeDoc(verified) } }
    }
    if (action.startsWith('template-') && !['template-save','template-apply'].includes(action)) {
      const rows = action === 'template-create' ? [] : catalogue(await call('templates')),target = rows.find(row => row.id === input.templateId)
      if (action !== 'template-create' && !target) invalid('模板须从当前用户/公司及系统目录发现，不能猜复合 ID。')
      const content = action === 'template-create' ? docDelta(input.content ?? '') : await delta('content',String(target!.id),true)
      if (action === 'template-inspect') return { workflow: flow.id,completedSteps: completed,resources,result: { template: describeDoc(target!),content,contentHash: digest(content) } }
      if (action === 'template-create') { if (input.scope === 'company' && company.editNoteTemp !== true) throw new RsqError('RESOURCE_FORBIDDEN','创建企业模板需要 editNoteTemp 公司权限。',4) }
      else { templatePermission(target!,company);resources.templateId = String(target!.id) }
      const changed = asObject(await call('changed',action === 'template-create' ? { body: { name: textName(input.name),type: input.scope ?? 'my',note: JSON.stringify(content) } } : { path: { id: input.templateId },...(action === 'template-rename' && { body: { name: textName(input.name) } }) }))
      const id = action === 'template-create' ? String(changed.id) : String(input.templateId),after = catalogue(await call('verifiedTemplates')),row = after.find(row => row.id === id)
      if (action === 'template-remove' ? !!row : !row || row.name !== input.name) failed('独立模板目录与写入结果不一致。')
      if (action !== 'template-remove') equalDelta(await delta('verifiedContent',id,true),content)
      return { workflow: flow.id,completedSteps: completed,resources,result: { template: row ? describeDoc(row) : { id,removed: true },...(row && { content,contentHash: digest(content) }) } }
    }
    let drafts: JsonObject[] = [],before: JsonObject | undefined,content: JsonObject | undefined
    if (action.startsWith('draft-')) {
      if (action !== 'draft-create') { drafts = await pages('drafts');if (!drafts.some(row => idOf(row.id) === input.id)) invalid('草稿必须在当前用户完整草稿列表中。');resources.documentId = requiredId(input.id);before = await detail('before',requiredId(input.id),undefined,true);content = await delta('content',requiredId(input.id)) }
      else content = docDelta(input.content ?? '')
      if (action === 'draft-inspect') return { workflow: flow.id,completedSteps: completed,resources,result: { document: describeDoc(before!),content,contentHash: digest(content) } }
      if (action !== 'draft-publish') {
        const changed = asObject(await call('changed',action === 'draft-create' ? { body: { isNoteBook: false,name: textName(input.name),note: JSON.stringify(content) } } : { path: { id: input.id },...(action === 'draft-rename' && { body: { name: textName(input.name) } }) }))
        const id = action === 'draft-create' ? requiredId(changed.id) : requiredId(input.id),after = await pages('verifiedDrafts'),row = after.find(row => idOf(row.id) === id)
        if (action === 'draft-remove' ? !!row : !row || row.name !== input.name) failed('草稿列表与操作结果不一致。')
        const verified = action === 'draft-remove' ? undefined : await detail('verified',id,undefined,true)
        if (verified) equalDelta(await delta('verifiedContent',id),content!)
        return { workflow: flow.id,completedSteps: completed,resources,result: { document: verified ? describeDoc(verified) : { id,removed: true },...(verified && { content,contentHash: digest(content) }) } }
      }
    }
    const spaces = list(await call('spaces'))
    if (action === 'spaces') return { workflow: flow.id,completedSteps: completed,resources,result: { spaces: spaces.filter(row => row.type === 'essays').map(describeDoc),excludedRetiredCount: spaces.filter(row => row.type !== 'essays').length } }
    const spaceId = requiredId(input.spaceId);visibleSpace(spaces,spaceId);resources.spaceId = spaceId
    const space = asObject(await call('space',{ path: { id: spaceId } }))
    if (idOf(space.id) !== spaceId || space.type !== 'essays') failed('文集详情与当前可见文集不一致。')
    if (action === 'space-inspect') return { workflow: flow.id,completedSteps: completed,resources,result: { space: describeDoc(space) } }
    if (action === 'space-update') {
      const patch = asObject(input.patch),perms: Record<string,string> = { name: 'editCorpusInfo',canBeShared: 'editCorpusPreferences',attribute: 'editCorpusAttribute',showsView: '',sort: '' }
      if (!Object.keys(patch).length || Object.keys(patch).some(key => !Object.hasOwn(perms,key))) invalid('文集维护只接受 Schema 中声明的稀疏属性。')
      for (const key of Object.keys(patch)) if (perms[key]) permission(space,perms[key])
      if (patch.name != null) textName(patch.name)
      await call('changed',{ path: { id: spaceId },body: patch });const verified = asObject(await call('verified',{ path: { id: spaceId } }))
      for (const key of Object.keys(patch)) if (!isDeepStrictEqual(patch[key],verified[key])) failed('文集独立读回不符合稀疏修改。')
      return { workflow: flow.id,completedSteps: completed,resources,result: { space: describeDoc(verified) } }
    }
    const tree = await scan('tree',spaceId)
    if (docPublicationActions.includes(action as DocPublicationAction)) return { workflow: flow.id,completedSteps: completed,resources,result: await runDocPublication(ctx,action as DocPublicationAction,input,session,space,tree,call,() => scan('tree',spaceId)) }
    if (action === 'tree') return { workflow: flow.id,completedSteps: completed,resources,result: { space: describeDoc(space),items: [...tree.values()].map(describeDoc),complete: true } }
    if (action === 'space-remove') { permission(space,'removeCorpus');await call('changed',{ path: { id: spaceId } });if (list(await call('verifiedSpaces')).some(row => idOf(row.id) === spaceId)) failed('删除后文集仍在可见列表中。');return { workflow: flow.id,completedSteps: completed,resources,result: { spaceId,removed: true,affectedVisibleIds: [...tree.keys()],scope: 'recycle-not-physical-erasure' } } }
    if (['create','folder-create','template-apply','draft-publish'].includes(action)) {
      const destination = parent(tree,space,input.folderId,action === 'folder-create')
      let templateId: string | undefined
      if (action === 'template-apply') { const templates = catalogue(await call('templates')),row = templates.find(row => row.id === input.templateId);if (!row) invalid('模板须先从实际目录发现。');templateId = String(row!.id);content = await delta('content',templateId,true) }
      if (action === 'create') content = docDelta(input.content ?? '')
      const changed = asObject(await call('changed',action === 'draft-publish' ? { body: { draftId: input.id,...destination } } : { body: { ...destination,name: textName(input.name),isNoteBook: action === 'folder-create',...(action !== 'folder-create' && { note: JSON.stringify(content),...(templateId && !templateId.startsWith('normal-') && { tSummaryId: templateId.split('-')[1] }) }) } }))
      const id = requiredId(changed.id)
      if (action === 'draft-publish' && (await pages('verifiedDrafts')).some(row => idOf(row.id) === input.id)) failed('发布后仍存在原草稿。')
      const after = await scan('verifiedTree',spaceId),created = after.get(id)
      if (!created || created.isNoteBook !== (action === 'folder-create') || idOf(created.noteBookId) !== idOf(input.folderId) || action !== 'draft-publish' && created.name !== input.name) failed('新资源未出现在目标目录或父级不一致。')
      if (action !== 'folder-create') { const verified = await detail('verified',id,spaceId);equalDelta(await delta('verifiedContent',id),content!);return { workflow: flow.id,completedSteps: completed,resources,result: { document: describeDoc(verified),content,contentHash: digest(content) } } }
      return { workflow: flow.id,completedSteps: completed,resources,result: { folder: describeDoc(created!) } }
    }
    const id = requiredId(input.id),target = tree.get(id)
    if (!target || target.isNoteBook !== action.startsWith('folder-')) invalid('资源必须是该文集 HTTP 完整目录中正确类型的可见资源。')
    resources.documentId = id
    if (action.startsWith('folder-')) {
      permission(target!,action === 'folder-remove' ? 'removeNoteBook' : 'editNoteBook')
      const affected = new Set([id]);let size = 0;while (size !== affected.size) { size = affected.size;for (const [childId,child] of tree) if (affected.has(idOf(child.noteBookId) ?? '')) affected.add(childId) }
      await call('changed',{ path: { id },...(action === 'folder-rename' && { body: { name: textName(input.name) } }) });const after = await scan('verifiedTree',spaceId)
      if (action === 'folder-remove' ? [...affected].some(id => after.has(id)) : after.get(id)?.name !== input.name) failed('目录独立读回不符合修改或递归删除结果。')
      return { workflow: flow.id,completedSteps: completed,resources,result: { folder: action === 'folder-remove' ? { id,removed: true,affectedVisibleIds: [...affected] } : describeDoc(after.get(id)!) } }
    }
    const authority = asObject(await call('authority',{ query: { id } }))
    if (!['','noEdit'].includes(String(authority.status)) || !authority.auth || !Object.keys(asObject(authority.auth)).length) throw new RsqError('RESOURCE_FORBIDDEN','文档预览权限已失效或资源已删除，未读取正文。',4)
    before = await detail('before',id,spaceId)
    if (action === 'activities') {
      const page = docActivityPage(await call('activities',{ query: { id,...(input.cursor != null && { lastId: input.cursor }) } }),input.cursor)
      let hasMore = false
      if (page.length === 10) { const more = asObject(await call('moreActivities',{ query: { id,lastId: page[0].id } }));if (typeof more.hasSummaryAction !== 'boolean') failed('文档动态续页检查缺少实际布尔结果。');hasMore = more.hasSummaryAction as boolean }
      return { workflow: flow.id,completedSteps: completed,resources,result: { document: describeDoc(before),...describeDocActivities(page,hasMore,input.cursor) } }
    }
    if (action === 'visibility-set') {
      if (idOf(asObject(before.creator).id) !== session.identity.userId) throw new RsqError('RESOURCE_FORBIDDEN','当前 UI 只允许文档创建者修改仅协作者可见设置。',4)
      // This permission is an internal gRPC bit, absent from HTTP editControl.
      // The current UI and authority service both use the actual note creator.
      const currentSpace = asObject(await call('space',{ path: { id: spaceId } })),fresh = await detail('before',id,spaceId)
      if (currentSpace.isRelease !== space.isRelease || currentSpace.canBeShared !== space.canBeShared || ['name','creator','isOpenToMember','isShare','forbidEdit','lastUpdated'].some(key => !isDeepStrictEqual(fresh[key],before[key])) || !isDeepStrictEqual(fresh.editControl,before.editControl)) throw new RsqError('CONTEXT_CONFLICT','文集公开范围、文档权限或可见性在写前变化，未修改。',4)
      if (input.membersOnly === true && currentSpace.isRelease !== false) throw new RsqError('PRIVATE_PUBLICATION_UNSAFE','文集仍已发布；当前服务端不能保护继承发布的受限正文，须先明确取消整库发布。',4)
      const changed = before.isOpenToMember !== input.membersOnly
      if (changed) await call('changed',{ path: { id },body: { isOpenToMember: input.membersOnly } })
      const after = await detail('verified',id,spaceId),afterSpace = asObject(await call('space',{ path: { id: spaceId } }))
      if (afterSpace.isRelease !== currentSpace.isRelease || afterSpace.canBeShared !== currentSpace.canBeShared) throw new RsqError('CONTEXT_CONFLICT','可见性写入后文集公开范围改变；先核对公开访问，不重放。',4)
      if (after.isOpenToMember !== input.membersOnly || ['name','isShare','forbidEdit','isWideScreen','noteBookId'].some(key => !isDeepStrictEqual(after[key],before[key]))) failed('文档可见性独立读回与修改项或应保留字段不符。')
      return { workflow: flow.id,completedSteps: completed,resources,result: { document: describeDoc(after),changed,verified: true,individualSharePreserved: true,anonymousAccessMayRemain: after.isShare === true && currentSpace.canBeShared === true,concurrency: 'fresh-preflight-and-readback; no-atomic-compare-and-swap' } }
    }
    if (docSharingActions.includes(action as DocSharingAction)) return { workflow: flow.id,completedSteps: completed,resources,result: await runDocSharing(ctx,action as DocSharingAction,input,session,before,space,call) }
    if (action === 'inspect' || action === 'body-inspect') { content = await delta('content',id);return { workflow: flow.id,completedSteps: completed,resources,result: { document: describeDoc(before),content,contentHash: digest(content),concurrency: 'HTTP snapshot; no atomic content replacement endpoint verified' } } }
    if (action === 'copy' || action === 'move') {
      permission(before,action === 'copy' ? 'copyNote' : 'moveNote');content = await delta('content',id)
      const destId = requiredId(input.destinationSpaceId);visibleSpace(spaces,destId)
      const destination = asObject(await call('destination',{ path: { id: destId } }));if (idOf(destination.id) !== destId || destination.type !== 'essays') failed('目标文集上下文错误。')
      const destTree = await scan('destinationTree',destId),place = parent(destTree,destination,input.destinationFolderId)
      if (action === 'move' && destId === spaceId && idOf(before.noteBookId) === idOf(input.destinationFolderId)) invalid('文档已经在目标位置。')
      const changed = asObject(await call('changed',{ body: { id,...place } }))
      if (action === 'move' && changed.hasNoteWithSameDate !== false) throw new RsqError('CONTEXT_CONFLICT','目标存在同日期文档；未发送覆盖请求，请核对目标。',5)
      const newId = action === 'move' ? id : requiredId(changed.id),sourceAfter = await scan('verifiedTree',spaceId),destAfter = await scan('verifiedDestinationTree',destId),row = destAfter.get(newId)
      if (!row || row.isNoteBook || idOf(row.noteBookId) !== idOf(input.destinationFolderId) || action === 'copy' && (!sourceAfter.has(id) || newId === id) || action === 'move' && (newId !== id || destId !== spaceId && sourceAfter.has(id))) failed('移动/复制后的真实资源及父级不一致。')
      const verified = await detail('verified',newId,destId);equalDelta(await delta('verifiedContent',newId),content)
      return { workflow: flow.id,completedSteps: completed,resources,result: { document: describeDoc(verified),sourceId: id,contentHash: digest(content) } }
    }
    if (action === 'template-save') {
      content = await delta('content',id);if (input.scope === 'company' && company.editNoteTemp !== true) throw new RsqError('RESOURCE_FORBIDDEN','企业模板需要 editNoteTemp 公司权限。',4)
      const changed = asObject(await call('changed',{ query: { id,type: input.scope ?? 'my' } })),templates = catalogue(await call('verifiedTemplates')),row = templates.find(row => row.id === changed.id)
      if (!row || row.name !== before.name) failed('另存模板未在当前目录发现或名称不一致。');equalDelta(await delta('verifiedContent',String(row!.id),true),content)
      return { workflow: flow.id,completedSteps: completed,resources,result: { template: describeDoc(row!),sourceId: id,contentHash: digest(content) } }
    }
    if (action.startsWith('comment') || action === 'comments') {
      const comments = list(await call('comments',{ query: { id } }))
      const describe = (rows: JsonObject[]) => rows.map(row => ({ id: idOf(row.id),content: row.content,dateCreated: row.dateCreated,creator: { id: idOf(asObject(row.creator).id),showName: asObject(row.creator).showName } }))
      if (action === 'comments') return { workflow: flow.id,completedSteps: completed,resources,result: { comments: describe(comments),complete: true } }
      permission(before,'commentNote')
      const directory = action === 'comment-context' || action === 'comment-create' ? await call('directory', { query: { cliContext: 'fresh' } }) : undefined
      if (action === 'comment-context') return { workflow: flow.id,completedSteps: completed,resources,result: { comments: describe(comments),complete: true,...docCommentDirectory(directory),permissions: { comment: true },replyProtocol: 'mention-author-in-new-comment; no-server-thread-or-edit-operation' } }
      const payload = action === 'comment-create' ? docCommentContent(input,directory,comments,session) : undefined
      if (action === 'comment-remove') { const row = comments.find(row => idOf(row.id) === input.commentId);if (!row || idOf(asObject(row.creator).id) !== session.identity.userId) throw new RsqError('RESOURCE_FORBIDDEN','只允许删除该文档列表中本人创建的指定评论。',4) }
      const changed = asObject(await call('changed',action === 'comment-create' ? { body: { noteId: id,...payload } } : { path: { commentId: input.commentId } })),commentId = action === 'comment-create' ? requiredId(changed.id) : String(input.commentId)
      resources.commentId = commentId
      const after = list(await call('verifiedComments',{ query: { id } })),row = after.find(row => idOf(row.id) === commentId)
      if (action === 'comment-remove' ? !!row : !row || row.content !== payload!.content || idOf(asObject(row.creator).id) !== session.identity.userId) failed('独立评论读取与写入结果不一致。')
      return { workflow: flow.id,completedSteps: completed,resources: { ...resources,commentId },result: { comments: describe(after),commentId,...(action === 'comment-remove' && { removed: true }) } }
    }
    permission(before,action === 'remove' ? 'removeNote' : 'editNote')
    await call('changed',{ path: { id },...(action === 'rename' && { body: { name: textName(input.name) } }) });const after = await scan('verifiedTree',spaceId)
    if (action === 'remove' ? after.has(id) : after.get(id)?.name !== input.name) failed('文档独立目录读回不符合修改。')
    const verified = action === 'remove' ? undefined : await detail('verified',id,spaceId)
    return { workflow: flow.id,completedSteps: completed,resources,result: { document: verified ? describeDoc(verified) : { id,removed: true,scope: 'recycle-not-physical-erasure' } } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED','文档业务未完成。',5)
    throw new RsqError(failure.code,failure.message,failure.exit,{ workflow: flow.id,failedStep: phase,completedSteps: completed,resources,writeOutcome: pending ? 'unknown-do-not-retry' : 'check-completed-steps',retry: 'manual-after-readback',automaticRollback: false,...(failure.details && { cause: failure.details }) })
  }
}
