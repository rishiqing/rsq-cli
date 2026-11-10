import { createHash } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { asObject,parseJson,request,RsqError,send,type Context,type JsonObject,type Transport } from './core.js'
import { catalog,runOperation } from './operations.js'
import { requireSession,sessionOrigin,type Session } from './session.js'
import { collectIndexedPages,collectOperationPages } from './pagination.js'
import { inspectUpload,uploadToStorage,type UploadTransfer } from './storage.js'
import type { Workflow } from './workflows.js'

export type MinderAction = 'list' | 'inspect' | 'create' | 'replace' | 'rename' | 'remove' | 'batch-remove' | 'recycle-list' | 'restore' | 'purge'
const root = '/task/minder/mindMap',maxBytes = 8*1024*1024
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT',message,2) }
const assertion = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED',message,5) }
const idOf = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function minderRevision(value: unknown) {
  const row = asObject(value)
  return hash(JSON.stringify([idOf(row.id),idOf(row.creatorId),row.name,row.path,row.fileSize,row.lastUpdated,row.extName,row.isOnlyCreatorCanEdit]))
}
function metadata(value: unknown) {
  const row = asObject(value)
  return { id: idOf(row.id),creatorId: idOf(row.creatorId),name: row.name,fileSize: row.fileSize,extName: row.extName,lastUpdated: row.lastUpdated,isOnlyCreatorCanEdit: row.isOnlyCreatorCanEdit,revision: minderRevision(row) }
}
/** Preserve the editor's actual data/children protocol and extension data. No
 * DOM, iframe, remote script, image, hyperlink, or embedded URL is executed. */
export function validateMinderDocument(raw: unknown): { document: JsonObject; bytes: Buffer; nodes: number } {
  const document = asObject(raw),ids = new Set<string>(),seen = new Set<object>(),stack: { value: unknown; depth: number; node: boolean }[] = [{ value: document.root,depth: 0,node: true }]
  if (document !== raw || !document.root || Object.keys(document).some(key => !['root','template','theme','version'].includes(key))) invalid('正文须为 KityMinder 的 root、template、theme、version JSON。')
  for (const key of ['template','theme','version']) if (document[key] != null && (typeof document[key] !== 'string' || String(document[key]).length > 128)) invalid('导图模板、主题和协议版本必须为短字符串。')
  let nodes = 0
  while (stack.length) {
    const { value,depth,node } = stack.pop()!
    if (depth > 128) invalid('导图或扩展属性嵌套过深，最多 128 层。')
    if (value === null || typeof value !== 'object') { if (typeof value === 'number' && !Number.isFinite(value) || node) invalid('导图节点或数字非法。');continue }
    if (seen.has(value)) invalid('正文不可包含循环或共享对象引用。');seen.add(value)
    if (node) {
      const row = asObject(value),data = asObject(row.data)
      if (row !== value || data !== row.data || typeof data.text !== 'string' || data.text.length > 100000 || row.children != null && !Array.isArray(row.children) || Object.keys(row).some(key => !['data','children'].includes(key))) invalid('每个节点必须含 data.text 字符串和可选 children 数组。')
      if (++nodes > 10000) invalid('导图最多 10000 个节点。')
      if (data.id != null) { const nodeId = data.id;if (typeof nodeId !== 'string' || !nodeId || ids.has(String(nodeId))) invalid('导图节点 ID 必须为不重复的非空字符串。');ids.add(String(nodeId)) }
      stack.push({ value: data,depth: depth+1,node: false })
      for (const child of row.children as unknown[] ?? []) stack.push({ value: child,depth: depth+1,node: true })
    } else for (const [key,child] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(key) || ['function','symbol','bigint','undefined'].includes(typeof child)) invalid('正文扩展数据必须是普通 JSON，不能含原型字段。')
      stack.push({ value: child,depth: depth+1,node: false })
    }
  }
  const bytes = Buffer.from(JSON.stringify(document),'utf8')
  if (bytes.length > maxBytes) invalid('导图正文最多 8 MiB。')
  return { document,bytes,nodes }
}
function fileName(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) invalid('请指定导图名称。')
  const name = /\.km$/i.test(value as string) ? value as string : value+'.km'
  if (name.length > 100 || /[\x00-\x1f\x7f/\\]/.test(name)) invalid('导图文件名最多 100 字符，不能含路径或控制字符。')
  return name
}
export function minderSteps(action: MinderAction): [string,string,string][] {
  const identity: [string,string,string] = ['identity','GET','/task/login/authAjax'],before: [string,string,string] = ['before','POST',root+'/list'],after: [string,string,string] = ['verified','POST',root+'/list']
  const recycled: [string,string,string] = ['recycled','GET','/task/v1/recycleBin/list']
  if (action === 'recycle-list') return [identity,recycled]
  if (action === 'restore' || action === 'purge') return [identity,before,recycled,['changed',action === 'restore' ? 'POST' : 'DELETE','/task/v1/recycleBin'],['remaining','GET','/task/v1/recycleBin/list'],after]
  if (action === 'list') return [identity,before]
  if (action === 'inspect') return [identity,before]
  if (action === 'create' || action === 'replace') return [identity,before,['certificate','GET','/task/sts/token/oss'],...(action === 'replace' ? [['fresh','POST',root+'/list'] as [string,string,string]] : []),['changed',action === 'create' ? 'POST' : 'PUT',root],after]
  return [identity,before,['fresh','POST',root+'/list'],['changed',action === 'rename' ? 'PUT' : 'DELETE',root+(action === 'batch-remove' ? '/list' : '')],after,...(action === 'rename' ? [] : [['recycled','GET','/task/v1/recycleBin/list'] as [string,string,string]])]
}
export function validateMinderWorkflow(flow: Workflow) {
  const action = flow.minderAction
  if (flow.executor !== 'minder' || !['list','inspect','create','replace','rename','remove','batch-remove','recycle-list','restore','purge'].includes(action ?? '')) throw new RsqError('INVALID_CONTRACT','未知思维导图业务编排。',6)
  const expected = minderSteps(action!)
  if (expected.length !== flow.steps.length || expected.some(([id,method,route],i) => { const step = flow.steps[i],op = catalog.operations.find(op => op.id === step.operationId);return step.id !== id || op?.method !== method || op.route !== route || Object.keys(step.input).length || step.prepare || step.transfer || step.forEach || step.resources || step.collectPages || step.readback || step.authentication })) throw new RsqError('INVALID_CONTRACT','思维导图步骤与已核对的完整上下文协议不符。',6)
}
function contentUrl(value: unknown,site: string,initial: boolean) {
  let url: URL
  try { url = new URL(String(value)) } catch { throw new RsqError('CONTENT_ORIGIN_MISMATCH','正文地址不符合已核对的资源上下文。',5) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (initial ? url.origin !== site || url.pathname !== '/task/v1/folder/file/fileMindMapUrl' || [...url.searchParams.keys()].some(key => key !== 'signature') || !url.searchParams.get('signature') : !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname))) throw new RsqError('CONTENT_ORIGIN_MISMATCH','正文仅可读取本人导图返回的正式签名入口及其 OSS 对象；未向外部地址发送日事清凭证。',5)
  return url
}
export async function readMinderContent(row: JsonObject,site: string,transport: Transport = request) {
  const entry = contentUrl(row.realPath,site,true)
  // The entry is already an expiring resource signature. Never attach the RSQ
  // Token/Cookie, even to the first hop, and never persist or print either URL.
  const redirect = await send(transport,entry,{ method: 'GET',headers: { accept: 'application/json' } })
  if (![301,302,303,307,308].includes(redirect.status)) { await redirect.body?.cancel();throw new RsqError('CONTENT_UNAVAILABLE','正文签名入口没有返回受限对象存储跳转；请重新读取资源上下文。',5) }
  const target = contentUrl(redirect.headers.get('location'),site,false);await redirect.body?.cancel()
  const response = await send(transport,target,{ method: 'GET',headers: { accept: 'application/json' } })
  if (!response.ok) { await response.body?.cancel();throw new RsqError('CONTENT_UNAVAILABLE','无法读取思维导图正文，链接可能已过期；不会重发写请求。',5,{ httpStatus: response.status }) }
  const length = response.headers.get('content-length')
  if (length != null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel();throw new RsqError('CONTENT_TOO_LARGE','正文大小超出 8 MiB，已停止读取。',5) }
  const reader = response.body?.getReader(),chunks: Uint8Array[] = [];let size = 0
  if (!reader) throw new RsqError('CONTENT_UNAVAILABLE','正文响应没有可读内容。',5)
  try { while (true) { const { done,value } = await reader.read();if (done) break;size += value.byteLength;if (size > maxBytes) throw new RsqError('CONTENT_TOO_LARGE','正文大小超出 8 MiB，已停止读取。',5);chunks.push(value) } }
  finally { await reader.cancel().catch(() => {});reader.releaseLock() }
  let data: unknown
  try { data = parseJson(new TextDecoder('utf-8',{ fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new RsqError('CONTENT_FORMAT_UNSUPPORTED','正文不是 UTF-8 KityMinder JSON；不会把 xmind/mm 二进制内容伪装成可编辑节点。',5) }
  const parsed = validateMinderDocument(data)
  return { document: parsed.document,nodes: parsed.nodes,contentHash: hash(parsed.bytes.toString('utf8')) }
}
export async function runMinder(ctx: Context,flow: Workflow,input: JsonObject,supplied: Session | null,options: { transport?: Transport; uploadTransfer?: UploadTransfer; approved?: boolean } = {}) {
  validateMinderWorkflow(flow)
  const session = requireSession(supplied),action = flow.minderAction!,completed: string[] = [],resources: Record<string,string> = {},site = sessionOrigin(ctx,session.method)
  const document = action === 'create' || action === 'replace' ? validateMinderDocument(input.document) : undefined
  const name = input.name != null ? fileName(input.name) : undefined
  let phase = 'identity',writePending = false,temp: string | undefined
  const transport: Transport = async (url,init) => {
    const response = await (options.transport ?? request)(url,init)
    if (action === 'create' && phase === 'changed' && response.ok) try { const row = asObject(asObject(parseJson(await response.clone().text())).data);if (idOf(row.id)) resources.minderId = idOf(row.id)! } catch { /* Preserve a received ID even when normal schema validation fails. */ }
    return response
  }
  const execute = async (id: string,args: JsonObject,all = false) => {
    phase = id;const step = flow.steps.find(step => step.id === id)!,op = catalog.operations.find(op => op.id === step.operationId)!
    writePending = op.effect !== 'read'
    const value = all ? await collectIndexedPages(ctx,op,args,session,transport) : await runOperation(ctx,op,args,session,{ transport,approved: options.approved })
    writePending = false;completed.push(id);return value
  }
  const list = (id: string) => execute(id,{ body: { page: 1,size: 100 } },true) as Promise<JsonObject[]>
  const recycle = async (id: string) => {
    phase = id;const step = flow.steps.find(step => step.id === id)!,op = catalog.operations.find(op => op.id === step.operationId)!
    const rows = await collectOperationPages(ctx,op,{ query: { type: '11',max: 100 } },session,{ limit: 100,cursorParameter: 'lastDataId',cursorField: 'id',pageSizeParameter: 'max' },transport) as JsonObject[]
    if (rows.some(row => idOf(row.userId) !== session.identity.userId || Number(row.type) !== 11)) throw new RsqError('FORBIDDEN','回收列表必须只包含本人思维导图记录。',4)
    completed.push(id);return rows
  }
  const own = (rows: JsonObject[]) => { if (rows.some(row => idOf(row.creatorId) !== session.identity.userId)) throw new RsqError('FORBIDDEN','个人列表返回了不属于当前用户的导图，已停止。',4);return rows }
  const select = (rows: JsonObject[],id: unknown,revision?: unknown) => {
    const row = own(rows).find(row => idOf(row.id) === id)
    if (!row) throw new RsqError('FORBIDDEN','导图必须存在于本人完整列表中；不能凭一个资源 ID 修改其他用户资源。',4)
    if (revision != null && minderRevision(row) !== revision) throw new RsqError('CONTEXT_CONFLICT','导图已被修改，请 inspect 后核对内容，再明确使用新 revision；不会覆盖冲突。',5)
    return row
  }
  try {
    const identity = asObject(await execute('identity',{}))
    if (idOf(identity.id) !== session.identity.userId || idOf(asObject(identity.team).id) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED','导图上下文与当前 profile 身份或公司不符。',3)
    if (action === 'recycle-list') return { command: flow.command,completedSteps: completed,resources,result: { entries: (await recycle('recycled')).map(row => ({ id: idOf(row.id),resourceId: idOf(row.resourceId),name: row.name,dateCreated: row.dateCreated,type: 11 })),complete: true } }
    if (action === 'list') {
      const data = asObject(await execute('before',{ body: { page: input.page ?? 1,size: input.size ?? 20,sortVO: { fieldName: input.sortBy ?? 'lastUpdated',sortType: input.direction ?? 'DESC' } } })),rows = own(data.data as JsonObject[]),ext = asObject(data.ext)
      if (ext.page !== (input.page ?? 1) || ext.size !== (input.size ?? 20) || !Number.isSafeInteger(ext.total) || Number(ext.total) < 0 || ext.totalPages !== Math.ceil(Number(ext.total)/Number(ext.size))) assertion('导图列表实际分页不符。')
      return { command: flow.command,completedSteps: completed,resources,result: { items: rows.map(metadata),pagination: ext } }
    }
    const before = own(await list('before'))
    if (action === 'restore' || action === 'purge') {
      if (before.some(row => idOf(row.id) === input.id)) throw new RsqError('CONTEXT_CONFLICT','目标导图已在活动列表中，请重新核对回收记录，未发送恢复或永久移除请求。',5)
      const entries = await recycle('recycled'),entry = entries.find(row => idOf(row.id) === input.entryId && idOf(row.resourceId) === input.id)
      if (!entry) throw new RsqError('FORBIDDEN','必须同时匹配本人导图回收记录的 entryId 与原资源 id。',4)
      resources.minderId = input.id as string;resources.entryId = input.entryId as string
      const changed = asObject(await execute('changed',action === 'restore' ? { body: { id: input.entryId } } : { query: { id: input.entryId } }))
      if (action === 'restore' && changed.hasParent !== true) assertion('服务端没有确认导图恢复完成。')
      if ((await recycle('remaining')).some(row => idOf(row.id) === input.entryId)) assertion('恢复或移除后回收记录仍存在，需先读回核对，不能重放。')
      const after = own(await list('verified'))
      if (action === 'purge') { if (after.some(row => idOf(row.id) === input.id)) assertion('永久移除后导图意外回到活动列表。');return { command: flow.command,completedSteps: completed,resources,result: { id: input.id,entryId: input.entryId,purged: true,verified: true,scope: '回收记录已移除；不声称服务端物理擦除存储对象。' } } }
      const row = select(after,input.id);phase = 'verified-content';const content = await readMinderContent(row,site,transport);completed.push(phase)
      return { command: flow.command,completedSteps: completed,resources,result: { ...metadata(row),...content,restored: true,verified: true } }
    }
    if (action === 'inspect') {
      const row = select(before,input.id);phase = 'content'
      return { command: flow.command,completedSteps: [...completed,'content'],resources,result: { ...metadata(row),...await readMinderContent(row,site,options.transport),conflictProtection: '写前核对 metadata revision；服务端尚无原子条件更新。' } }
    }
    const targets = action === 'batch-remove' ? input.items as JsonObject[] : action === 'create' ? [] : [{ id: input.id,revision: input.revision }]
    targets.forEach(target => select(before,target.id,target.revision))
    if (targets.length) resources.minderIds = targets.map(target => target.id).join(',')
    let stored: Awaited<ReturnType<UploadTransfer>> | undefined
    if (document) {
      phase = 'prepare-content';temp = await mkdtemp(join(tmpdir(),'rsq-minder-'));const path = join(temp,'content.km');await writeFile(path,document.bytes,{ mode: 0o600 })
      const local = await inspectUpload(path,name ?? String(select(before,input.id).name))
      const certificate = await execute('certificate',{ query: { type: 'file' } })
      phase = 'upload-content';writePending = true
      stored = await (options.uploadTransfer ?? uploadToStorage)(certificate,local,checkpoint => { if (typeof checkpoint.objectPath === 'string') resources.objectPath = checkpoint.objectPath;if (typeof checkpoint.uploadId === 'string') resources.uploadId = checkpoint.uploadId })
      writePending = false;completed.push('upload-content')
    }
    if (action !== 'create') { const fresh = own(await list('fresh'));targets.forEach(target => select(fresh,target.id,target.revision)) }
    const args = action === 'create' ? { body: { creatorId: session.identity.userId,name,path: stored!.path,fileSize: stored!.size,extName: 'km' } }
      : action === 'replace' ? { body: { id: input.id,path: stored!.path,fileSize: stored!.size,extName: 'km' } }
      : action === 'rename' ? { body: { id: input.id,name } }
      : action === 'batch-remove' ? { body: targets.map(target => target.id) } : { query: { id: input.id } }
    const changed = asObject(await execute('changed',args)),created = asObject(changed.data)
    const targetId = action === 'create' ? idOf(created.id) : input.id as string
    if (action === 'create') { if (!targetId || before.some(row => idOf(row.id) === targetId)) assertion('创建结果没有唯一的新导图 ID。');resources.minderId = targetId! }
    const verified = own(await list('verified'))
    if (action === 'remove' || action === 'batch-remove') {
      if (targets.some(target => verified.some(row => idOf(row.id) === target.id))) assertion('删除后本人列表仍有目标导图，未自动重发。')
      phase = 'recycled'
      const recycled = await recycle('recycled')
      const entries = targets.map(target => { const found = recycled.filter(row => idOf(row.resourceId) === target.id && idOf(row.userId) === session.identity.userId && Number(row.type) === 11);if (found.length !== 1) assertion('删除后未唯一确认本人回收站记录，需读回检查，不能重放。');return { id: idOf(found[0].id),resourceId: target.id,type: 11 } })
      return { command: flow.command,completedSteps: completed,resources,result: { removedIds: targets.map(target => target.id),recycleEntries: entries,verified: true } }
    }
    const row = select(verified,targetId)
    const original = action !== 'create' ? select(before,input.id) : undefined
    if (name != null && row.name !== name || stored && (row.path !== stored.path || row.fileSize !== stored.size || row.extName !== 'km') || original && action === 'rename' && ['path','fileSize','extName','isOnlyCreatorCanEdit'].some(key => !isDeepStrictEqual(original[key],row[key])) || original && action === 'replace' && ['name','isOnlyCreatorCanEdit'].some(key => !isDeepStrictEqual(original[key],row[key]))) assertion('导图元信息独立读回不符，或本次未修改的字段发生变化。')
    phase = 'verified-content';const content = await readMinderContent(row,site,options.transport);completed.push(phase)
    if (document && !isDeepStrictEqual(content.document,document.document)) assertion('上传后独立读取的导图节点或内容与请求不符。')
    const { objectPath,uploadId,...publicResources } = resources
    return { command: flow.command,completedSteps: completed,resources: publicResources,result: { ...metadata(row),...content,verified: true,conflictProtection: '写前检查；当前服务端不提供原子条件更新。' } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('MINDER_FAILED','思维导图业务执行失败。',5)
    throw new RsqError(failure.code,failure.message,failure.exit,{ ...failure.details,workflow: flow.id,failedStep: phase,completedSteps: completed,resources,writeOutcome: writePending ? 'unknown' : completed.includes('changed') ? 'check-completed-steps' : 'not-submitted',retry: 'manual-after-readback',automaticRollback: false })
  } finally { if (temp) await rm(temp,{ recursive: true,force: true }) }
}
