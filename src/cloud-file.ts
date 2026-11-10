import { asObject,parseJson,request,RsqError,type Context,type JsonObject,type Transport } from './core.js'
import { catalog,runOperation } from './operations.js'
import { requireSession,type Session } from './session.js'
import { inspectUpload,uploadToStorage,type UploadTransfer } from './storage.js'
import type { Workflow } from './workflows.js'

export type CloudFileAction = 'tree' | 'folder-inspect' | 'folder-create' | 'folder-update' | 'folder-remove' | 'folder-move' | 'inspect' | 'create' | 'rename' | 'remove' | 'move' | 'copy' | 'upload' | 'replace'
type Route = [string,string,string]
const base = '/task/v1/folder',files = base+'/file'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT',message,2) }
const failed = (message: string): never => { throw new RsqError('BUSINESS_ASSERTION_FAILED',message,5) }
const idOf = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
const id = (value: unknown) => idOf(value) ?? invalid('资源 ID 必须是精确的正整数字符串。')
const rows = (value: unknown): JsonObject[] => Array.isArray(value) && value.length <= 10000 ? value.map(asObject) : failed('文件服务未返回有界完整列表。')
const key = (row: JsonObject) => String(row.type)+':'+id(row.id)
const allowed = (row: JsonObject,permission: string) => { if (asObject(row.editControl)[permission] !== true) throw new RsqError('RESOURCE_FORBIDDEN','当前文件或目录没有此权限。',4,{ permission }) }
const text = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f/\\]/.test(value) ? value : invalid('名称不能为空，最多 200 字符，不能包含路径或控制字符。')
export function describeCloudFile(row: JsonObject): JsonObject {
 const result: JsonObject = Object.fromEntries(['id','name','type','contentType','color','size','parentFolderId','creatorId','corpusId','noteId','noteBookId','lastUpdated','forbidEdit','source'].filter(k=>Object.hasOwn(row,k)).map(k=>[k,/Id$|^id$/.test(k) ? idOf(row[k]) ?? row[k] : row[k]]))
 if (row.creator != null) result.creator = typeof row.creator === 'object' ? { id: idOf(asObject(row.creator).id),showName: asObject(row.creator).showName } : idOf(row.creator)
 if (row.editControl) result.permissions = Object.fromEntries(Object.entries(asObject(row.editControl)).filter(([,v])=>typeof v === 'boolean'))
 return result
}
/** StateVO returns bytes. Applying the UI helper's MB multiplier to this HTTP
 * response would lift the actual limit by 1,048,576 times. */
export function validateCloudUpload(state: JsonObject,usage: JsonObject,file: { name: string;size: number }) {
 const byte = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : failed('套餐或实际用量缺少精确字节数。')
 const image = /\.(?:jpg|bmp|gif|jpeg|jpeg2000|tiff|psd|png|swf|svg)$/i.test(file.name),limit = byte(state[image ? 'uploadImgSize' : 'uploadFileSize']),capacity = Math.min(byte(state.cloudSize),byte(usage.max)),used = byte(usage.used)
 if (file.size > limit) throw new RsqError('FILE_SIZE_LIMIT','文件超过当前套餐的单文件或图片大小限制。',4,{ limitBytes: limit,sizeBytes: file.size,kind: image ? 'image' : 'file' })
 if (used >= capacity || file.size > capacity-used || typeof usage.percent !== 'string' || !/^\d+(?:\.\d+)?%$/.test(usage.percent) || Number.parseFloat(usage.percent).toFixed(0) === '100') throw new RsqError('STORAGE_CAPACITY_LIMIT','本次上传超过可用云盘空间；未执行秒传、存储上传或登记。',4,{ capacityBytes: capacity,usedBytes: used,sizeBytes: file.size })
}
export function cloudFileSteps(action: CloudFileAction): Route[] {
 const context: Route[] = [['identity','GET','/task/login/authAjax'],['libraries','GET',base+'/list'],['library','GET',base],['tree','GET',files+'/list']],after: Route = ['verifiedTree','GET',files+'/list'],folder: Route = ['folder','GET',base],file: Route = ['file','GET',files]
 const changed = (method: string,route: string): Route => ['changed',method,route]
 if (action === 'tree') return context
 if (action === 'folder-inspect') return [...context,folder]
 if (action === 'folder-create') return [...context,['parent','GET',base],changed('POST',base),after,['verified','GET',base]]
 if (action === 'folder-update') return [...context,folder,changed('PUT',base+'/{id}'),after,['verified','GET',base]]
 if (action === 'folder-remove') return [...context,folder,changed('DELETE',base+'/{id}'),after]
 if (action === 'folder-move' || action === 'move' || action === 'copy') return [...context,action === 'folder-move' ? folder : file,['destinationLibrary','GET',base],['destinationTree','GET',files+'/list'],['destination','GET',base],changed('POST',action === 'folder-move' ? base+'/move' : files+'/'+action),after,['verifiedDestinationTree','GET',files+'/list'],['verified','GET',action === 'folder-move' ? base : files]]
 if (action === 'create') return [...context,['parent','GET',base],changed('POST',files+'/create'),after,['verified','GET',files]]
 if (action === 'upload') return [...context,['parent','GET',base],['state','GET','/task/ordercenter/v2/member/state/independent'],['usage','GET',files+'/used'],['uploadCheck','GET','/task/files/file/upload/check'],['secondPass','POST',files+'/secondPass'],['certificate','GET','/task/sts/token/oss'],['stored','GET','/task/sts/token/oss'],changed('POST',files+'/getAliFile'),after,['verified','GET',files]]
 if (action === 'replace') return [...context,file,['parent','GET',base],['state','GET','/task/ordercenter/v2/member/state/independent'],['usage','GET',files+'/used'],['uploadCheck','GET','/task/files/file/upload/check'],['secondPass','POST',files+'/secondPass'],['certificate','GET','/task/sts/token/oss'],['stored','GET','/task/sts/token/oss'],changed('POST',files+'/updateFile'),after,['verified','GET',files]]
 if (action === 'inspect') return [...context,file]
 return [...context,file,changed(action === 'remove' ? 'DELETE' : 'PUT',files+'/{id}'),after,...(action === 'remove' ? [] : [['verified','GET',files] as Route])]
}
export function validateCloudFileWorkflow(flow: Workflow) {
 const actions: CloudFileAction[] = ['tree','folder-inspect','folder-create','folder-update','folder-remove','folder-move','inspect','create','rename','remove','move','copy','upload','replace']
 if (!actions.includes(flow.cloudFileAction!)) throw new RsqError('INVALID_CONTRACT','未知云盘业务操作。',6)
 const expected = cloudFileSteps(flow.cloudFileAction!)
 if (flow.executor !== 'cloud-file' || flow.steps.length !== expected.length || expected.some(([id,method,route],index)=>{ const step=flow.steps[index],op=catalog.operations.find(op=>op.id===step.operationId);return step.id!==id || op?.method!==method || op.route!==route || Object.keys(step.input).length || (id==='stored' ? step.transfer!=='storage-upload' : !!step.transfer) || step.prepare || step.verify || step.forEach || step.resources || step.collectPages || step.readback || step.authentication })) throw new RsqError('INVALID_CONTRACT','云盘业务步骤与已核对 HTTP 契约不一致。',6)
}
export async function runCloudFile(ctx: Context,flow: Workflow,input: JsonObject,supplied: Session | null,options: { transport?: Transport;approved?: boolean;uploadTransfer?: UploadTransfer } = {}) {
 validateCloudFileWorkflow(flow)
 const session=requireSession(supplied),action=flow.cloudFileAction!,completed: string[]=[],skipped: string[]=[],resources: Record<string,string>={ libraryId: id(input.libraryId) }
 let phase='identity',pending=false
 const call=async(stepId: string,args: JsonObject={})=>{
  const step=flow.steps.find(step=>step.id===stepId),op=catalog.operations.find(op=>op.id===step?.operationId)
  if (!op) throw new RsqError('INVALID_CONTRACT','云盘调用了未声明操作。',6)
  phase=stepId;pending=op.effect!=='read'
  const transport: Transport=async(url,init)=>{const response=await(options.transport??request)(url,init);if(response.ok && ['changed','secondPass'].includes(stepId))try{const result=asObject(parseJson(await response.clone().text())),row=stepId==='secondPass'?asObject(result.file):result;if(idOf(row.id))resources[action.startsWith('folder-')?'folderId':'fileId']=id(row.id)}catch{}return response}
  const result=await runOperation(ctx,op,args,session,{...options,transport});pending=false;completed.push(stepId);return result
 }
 const scan=async(stepId: string,libraryId: string)=>{
  const found=new Map<string,JsonObject>(),queue=[{id:libraryId,depth:0}]
  for(let index=0;index<queue.length;index++){
   if(queue.length>1000||queue[index].depth>64)failed('目录超过 1000 个文件夹或 64 层；未把部分目录当完整上下文。')
   const parent=queue[index],seen=new Set<string>();let cursor: {lastDataId:string;type:string}|undefined,finished=false
   for(let page=0;page<100;page++){
    const values=rows(await call(stepId,{query:{folderId:parent.id,max:100,sortType:'lastUpdated_desc',...cursor}}))
    if(values.length>100)failed('目录分页返回条数超出请求上限。')
    for(const row of values){
     if(!['folder','file'].includes(String(row.type))||idOf(row.parentFolderId)!==parent.id)failed('目录项类型或父级与真实目录不一致。')
     const k=key(row);if(seen.has(k)||found.has(k))throw new RsqError('PAGINATION_CHANGED','目录出现重复或循环；未发送后续写入。',5)
     seen.add(k);found.set(k,row);if(found.size>10000)failed('目录超过 10000 项，未将截断结果作为完整上下文。')
     if(row.type==='folder')queue.push({id:id(row.id),depth:parent.depth+1})
    }
    if(values.length<100){finished=true;break}
    const last=values.at(-1)!;cursor={lastDataId:id(last.id),type:String(last.type)}
   }
   if(!finished)throw new RsqError('PAGINATION_LIMIT','目录分页达到上限，完整上下文尚未确认。',5)
  }
  return found
 }
 const folder=async(stepId: string,folderId: string,tree: Map<string,JsonObject>,root: JsonObject)=>{
  const before=folderId===id(root.id)?root:tree.get('folder:'+folderId);if(!before)invalid('目录必须从当前普通文件库的完整目录发现。')
  const row=asObject(await call(stepId,{query:{id:folderId}}))
  if(idOf(row.id)!==folderId||row.type!=='folder'||idOf(row.parentFolderId)!==idOf(before!.parentFolderId))failed('新鲜目录详情与父级不一致。')
  return row
 }
 const detail=async(stepId: string,fileId: string,tree: Map<string,JsonObject>)=>{
  const known=tree.get('file:'+fileId);if(!known)invalid('文件必须从当前文件库完整目录发现，不能只凭同公司任意 ID 读取。')
  // The current cloud UI uses list metadata for linked documents/collections.
  // File.show assumes a FileData row and fails for these associated resources.
  if(known!.noteId!=null||known!.corpusId!=null||known!.noteBookId!=null){if(!skipped.includes(stepId))skipped.push(stepId);return structuredClone(known!)}
  const row=asObject(await call(stepId,{query:{id:fileId}}));if(idOf(row.id)!==fileId||row.type!=='file'||idOf(row.parentFolderId)!==idOf(known!.parentFolderId))failed('文件详情与可见目录归属不一致。');return row
 }
 try{
  const identity=asObject(await call('identity'));if(idOf(identity.id)!==session.identity.userId||idOf(asObject(identity.team).id??identity.teamId)!==session.identity.teamId)throw new RsqError('IDENTITY_CHANGED','当前身份或公司已变化。',3)
  const libraries=rows(await call('libraries')),libraryId=id(input.libraryId)
  if(!libraries.some(row=>idOf(row.id)===libraryId))throw new RsqError('RESOURCE_NOT_VISIBLE','普通文件库不在当前公司可见列表中。',4)
  const library=asObject(await call('library',{query:{id:libraryId}}))
  if(idOf(library.id)!==libraryId||library.type!=='folder'||library.parentFolderId!=null||typeof library.creator==='object'||!Array.isArray(library.userRoles))invalid('目标必须是普通顶级文件库；项目/任务等嵌入目录使用其业务上下文。')
  const tree=await scan('tree',libraryId)
  if(action==='tree')return {workflow:flow.id,completedSteps:completed,resources,result:{library:describeCloudFile(library),items:[...tree.values()].map(describeCloudFile),complete:true}}
  if(['folder-create','create','upload'].includes(action)){
   const parentId=input.parentFolderId==null?libraryId:id(input.parentFolderId),parent=await folder('parent',parentId,tree,library)
   allowed(parent,action==='folder-create'?'createFolder':'uploadFile')
   let changed: JsonObject,expectedName: string,size: number|undefined
   if(action==='upload'){
    const local=await inspectUpload(input.localFile,input.fileName);expectedName=local.name;size=local.size
    if([...tree.values()].some(row=>row.type==='file'&&idOf(row.parentFolderId)===parentId&&row.name===local.name))throw new RsqError('DUPLICATE_RESOURCE','当前目录已有同名文件；请明确改名或选择更新操作。',2)
    const state=asObject(await call('state')),usage=asObject(await call('usage'));validateCloudUpload(state,usage,local)
    if(asObject(await call('uploadCheck',{query:{fileName:local.name}})).canUpload!==true)throw new RsqError('FILE_TYPE_FORBIDDEN','当前扩展名不允许上传。',4)
    const second=asObject(await call('secondPass',{body:{folderId:parentId,fileName:local.name,md5:local.md5}}))
    if(typeof second.secondPass!=='boolean')failed('秒传响应缺少明确结果，不能继续上传或重放。')
    if(second.secondPass){changed=asObject(second.file);skipped.push('certificate','stored','changed')}
    else{
     const certificate=await call('certificate',{query:{type:'file'}});phase='stored';pending=true
     const stored=await(options.uploadTransfer??uploadToStorage)(certificate,local,checkpoint=>{if(typeof checkpoint.objectPath==='string')resources.objectPath=checkpoint.objectPath;if(typeof checkpoint.uploadId==='string')resources.uploadId=checkpoint.uploadId})
     pending=false;completed.push('stored');if(stored.size!==local.size||stored.md5!==local.md5||typeof stored.path!=='string')failed('字节上传结果与本地文件不一致；未登记。')
     changed=asObject(await call('changed',{body:{folderId:parentId,fileName:local.name,filePath:stored.path}}))
    }
   }else{expectedName=text(input.name);changed=asObject(await call('changed',{body:action==='folder-create'?{name:expectedName,color:input.color??1,parentFolderId:parentId}:{folderId:parentId,fileName:expectedName,extName:input.type}}))}
   const createdId=id(changed.id),type=action==='folder-create'?'folder':'file';resources[type==='folder'?'folderId':'fileId']=createdId
   const after=await scan('verifiedTree',libraryId),created=after.get(type+':'+createdId)
   if(!created||idOf(created.parentFolderId)!==parentId||created.name!==expectedName||action==='create'&&created.contentType!==input.type||size!==undefined&&Number(created.size)!==size)failed('新资源未在目标目录正确持久化。')
   const verified=type==='folder'?await folder('verified',createdId,after,library):await detail('verified',createdId,after)
   if(verified.name!==expectedName||size!==undefined&&Number(verified.size)!==size||action==='folder-create'&&verified.color!==(input.color??1))failed('新资源独立详情与提交数据不一致。')
   if(action==='create'&&!idOf(verified[input.type==='note'?'noteId':'corpusId']))failed('新关联文件缺少实际文档或文集 ID。')
   return {workflow:flow.id,completedSteps:completed,skippedSteps:skipped,resources,result:{[type]:describeCloudFile(verified),...(action==='upload'&&{uploadMode:skipped.length?'second-pass':'storage',byteLength:size})}}
  }
  const isFolder=action.startsWith('folder-'),targetId=id(input.id),target=isFolder?await folder('folder',targetId,tree,library):await detail('file',targetId,tree)
  if(isFolder&&targetId===libraryId)invalid('顶级文件库使用 file library 命令，不能作为子目录处理。')
  resources[isFolder?'folderId':'fileId']=targetId
  if(action==='inspect'||action==='folder-inspect')return {workflow:flow.id,completedSteps:completed,resources,result:{[isFolder?'folder':'file']:describeCloudFile(target)}}
  const permissions: Partial<Record<CloudFileAction,string>>={'folder-update':'renameFolder','folder-remove':'removeFolder','folder-move':'moveFolder',rename:'renameFile',remove:'removeFile',move:'moveFile',copy:'copyFile'}
  if(action!=='folder-update'&&permissions[action])allowed(target,permissions[action]!)
  if(action==='replace'){
   allowed(target,'updateFile')
   if(target.noteId!=null||target.corpusId!=null||target.noteBookId!=null||['note','corpus','notebook','mind','mindmap'].includes(String(target.contentType))||target.source!=null&&target.source!=='rishiqing')invalid('内容替换仅适用于日事清存储的普通上传文件；关联文档、文集、导图或外部平台文件使用所属业务。')
   const parentId=id(target.parentFolderId),parent=await folder('parent',parentId,tree,library);allowed(parent,'uploadFile')
   const local=await inspectUpload(input.localFile,input.fileName)
   if([...tree.values()].some(row=>row.type==='file'&&idOf(row.id)!==targetId&&idOf(row.parentFolderId)===parentId&&row.name===local.name))throw new RsqError('DUPLICATE_RESOURCE','目标目录已有同名的其他文件。',2)
   validateCloudUpload(asObject(await call('state')),asObject(await call('usage')),local)
   if(asObject(await call('uploadCheck',{query:{fileName:local.name}})).canUpload!==true)throw new RsqError('FILE_TYPE_FORBIDDEN','当前扩展名不允许上传。',4)
   const fresh=await detail('file',targetId,tree)
   if(['name','size','lastUpdated','contentType','parentFolderId'].some(field=>fresh[field]!==target[field]))throw new RsqError('CONTEXT_STALE','上传前文件元数据已变化，请先重新核对；未替换内容。',5)
   resources.originalFileId=targetId
   const second=asObject(await call('secondPass',{body:{folderId:parentId,fileId:targetId,fileName:local.name,md5:local.md5}}))
   if(typeof second.secondPass!=='boolean')failed('秒传响应缺少明确结果，不能继续上传或重放。')
   let changed: JsonObject
   if(second.secondPass){changed=asObject(second.file);skipped.push('certificate','stored','changed')}
   else{
    const certificate=await call('certificate',{query:{type:'file'}});phase='stored';pending=true
    const stored=await(options.uploadTransfer??uploadToStorage)(certificate,local,checkpoint=>{if(typeof checkpoint.objectPath==='string')resources.objectPath=checkpoint.objectPath;if(typeof checkpoint.uploadId==='string')resources.uploadId=checkpoint.uploadId})
    pending=false;completed.push('stored')
    if(stored.size!==local.size||stored.md5!==local.md5||typeof stored.path!=='string')failed('字节上传结果与本地文件不一致，未替换原文件。')
    changed=asObject(await call('changed',{body:{fileId:targetId,folderId:parentId,fileName:local.name,filePath:stored.path,fileSize:local.size,md5:local.md5}}))
   }
   if(idOf(changed.id)!==targetId)failed('替换响应的文件 ID 与原文件不同；请核对已返回资源，不会重放。')
   const after=await scan('verifiedTree',libraryId),known=after.get('file:'+targetId)
   if(!known||idOf(known.parentFolderId)!==parentId||known.name!==local.name||Number(known.size)!==local.size)failed('替换后的目录元数据与本地文件不一致。')
   const verified=await detail('verified',targetId,after)
   if(verified.name!==local.name||Number(verified.size)!==local.size)failed('内容替换后的独立详情不一致。')
   return {workflow:flow.id,completedSteps:completed,skippedSteps:skipped,resources,result:{file:describeCloudFile(verified),uploadMode:skipped.length?'second-pass':'storage',byteLength:local.size,validation:'storage-upload-and-independent-metadata',concurrency:'no-server-cas-do-not-run-concurrently'}}
  }
  if(action==='folder-update'){const patch=asObject(input.patch);if(Object.hasOwn(patch,'name')){allowed(target,'renameFolder');text(patch.name)}if(Object.hasOwn(patch,'color'))allowed(target,'editFolderColor')}
  const affected=new Set([key(target)]);let n=0;while(n!==affected.size){n=affected.size;for(const [k,row]of tree)if(affected.has('folder:'+id(row.parentFolderId)))affected.add(k)}
  if(['folder-move','move','copy'].includes(action)){
   const destLibraryId=id(input.destinationLibraryId);if(!libraries.some(row=>idOf(row.id)===destLibraryId))invalid('目标文件库未在当前公司可见目录中发现。')
   const destLibrary=asObject(await call('destinationLibrary',{query:{id:destLibraryId}}))
   if(idOf(destLibrary.id)!==destLibraryId||destLibrary.parentFolderId!=null||typeof destLibrary.creator==='object'||!Array.isArray(destLibrary.userRoles))invalid('目标必须是普通文件库。')
   const destTree=destLibraryId===libraryId?tree:await scan('destinationTree',destLibraryId),destId=input.destinationFolderId==null?destLibraryId:id(input.destinationFolderId),dest=await folder('destination',destId,destTree,destLibrary)
   if(isFolder&&(destId===targetId||affected.has('folder:'+destId)))invalid('不能将目录移动到自身或后代。')
   if(action!=='copy'&&idOf(target.parentFolderId)===destId)invalid('资源已经在目标目录。')
   if(action==='copy'&&target.corpusId!=null)invalid('文集文件不支持 UI 复制文件操作；请使用文集业务。')
   allowed(dest,isFolder?'createFolder':'uploadFile')
   const changed=await call('changed',{body:isFolder?{folderId:targetId,parentFolderId:destId}:{fileId:targetId,folderId:destId}})
   if(changed!==null)failed('移动/复制控制器未返回已核对的空响应；请按资源 ID 核对，不会重放。')
   const after=await scan('verifiedTree',libraryId),destAfter=destLibraryId===libraryId?after:await scan('verifiedDestinationTree',destLibraryId)
   let newId=targetId
   if(action==='copy'){
    const added=[...destAfter.values()].filter(row=>row.type==='file'&&!destTree.has(key(row))&&idOf(row.parentFolderId)===destId&&row.name===target.name&&row.contentType===target.contentType&&idOf(row.creatorId??asObject(row.creator).id)===session.identity.userId&&(target.size==null||row.size===target.size))
    if(added.length!==1)throw new RsqError('CONTEXT_CONFLICT','复制后无法唯一确认新文件；已停止，不重放。请检查目标目录。',5,{sourceId:targetId,destinationFolderId:destId,candidateIds:added.map(row=>id(row.id))})
    newId=id(added[0].id);resources.copiedFileId=newId
   }
   const row=destAfter.get((isFolder?'folder:':'file:')+newId)
   if(!row||idOf(row.parentFolderId)!==destId||row.name!==target.name||action==='copy'&&!after.has(key(target))||action!=='copy'&&destLibraryId!==libraryId&&[...affected].some(k=>after.has(k))||action==='folder-move'&&[...affected].some(k=>!destAfter.has(k)))failed('移动/复制后的源、目标、后代或父级不一致。')
   const verified=isFolder?await folder('verified',newId,destAfter,destLibrary):await detail('verified',newId,destAfter)
   if(verified.name!==target.name||!isFolder&&target.size!=null&&verified.size!==target.size)failed('移动/复制后详情与源元数据不一致。')
   return {workflow:flow.id,completedSteps:completed,resources,result:{[isFolder?'folder':'file']:describeCloudFile(verified),sourceId:targetId,...(isFolder&&{affectedVisibleIds:[...affected]})}}
  }
  const patch=action==='folder-update'?asObject(input.patch):action==='rename'?{name:text(input.name)}:undefined
  await call('changed',{path:{id:targetId},...(patch&&{body:patch})})
  const after=await scan('verifiedTree',libraryId)
  if(action==='remove'||action==='folder-remove'){
   if([...affected].some(k=>after.has(k)))failed('删除后仍有应移除的可见资源；不会重放。')
   return {workflow:flow.id,completedSteps:completed,resources,result:{id:targetId,removed:true,affectedVisibleIds:[...affected],scope:'recycle-not-physical-erasure'}}
  }
  const verified=isFolder?await folder('verified',targetId,after,library):await detail('verified',targetId,after)
  for(const [field,value]of Object.entries(patch!))if(verified[field]!==value)throw new RsqError('BUSINESS_ASSERTION_FAILED','属性独立读回未持久化。',5,{field,expected:value,actual:verified[field]??null})
  return {workflow:flow.id,completedSteps:completed,resources,result:{[isFolder?'folder':'file']:describeCloudFile(verified)}}
 }catch(error){const failure=error instanceof RsqError?error:new RsqError('WORKFLOW_FAILED','云盘业务未完成。',5);throw new RsqError(failure.code,failure.message,failure.exit,{workflow:flow.id,failedStep:phase,completedSteps:completed,skippedSteps:skipped,resources,writeOutcome:pending?'unknown-do-not-retry':'check-completed-steps',retry:'manual-after-readback',automaticRollback:false,...(failure.details&&{cause:failure.details})})}
}
