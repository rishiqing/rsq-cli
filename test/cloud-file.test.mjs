import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {workflows,runWorkflow} from '../dist/workflows.js'
import {executeWorkflow} from '../dist/dispatch.js'
import {validateCloudFileWorkflow,validateCloudUpload} from '../dist/cloud-file.js'
const ctx={environment:'production',profile:'fixture'},session={version:1,method:'password',accessToken:'private',identity:{userId:'81',teamId:'7'},expiresAt:Date.now()+3600000}
const base='/task/v1/folder',files=base+'/file',json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
const full={createFolder:true,uploadFile:true,renameFolder:true,editFolderColor:true,moveFolder:true,removeFolder:true,renameFile:true,copyFile:true,moveFile:true,removeFile:true,updateFile:true}
function fixture(options={}){
 let next=10000
 const folders=new Map(),entries=new Map(),calls=[],root=(id,name)=>({id,name,type:'folder',color:1,creator:81,editControl:{...full},userRoles:[{userId:81,role:{id:701,type:'libCreator',name:'拥有者'}}]})
 folders.set('101',root('101','源文件库'));folders.set('102',root('102','目标库'))
 const addFolder=(id,parent='101',name='目录')=>{const row={id,name,type:'folder',color:1,parentFolderId:parent,creator:{id:81},creatorId:81,editControl:{...full,...options.permissions}};folders.set(String(id),row);return row}
 const addFile=(id,parent='202',name='中文.txt')=>{const row={id,name,type:'file',size:11,contentType:'txt',parentFolderId:parent,creator:{id:81},creatorId:81,forbidEdit:false,editControl:{...full,...options.permissions},token:'do-not-emit',realPath:'https://private.invalid/?signature=hidden'};entries.set(String(id),row);return row}
 addFolder('201');addFolder('202','201','子目录');addFile('9007199254740993123');addFile('201','101','数字相同.txt')
 const f={calls,folders,entries,addFolder,addFile,transport:async(url,init)=>{
  const path=url.pathname,method=init.method,q=Object.fromEntries(url.searchParams),data=typeof init.body==='string'?JSON.parse(init.body):undefined;calls.push({path,method,query:q,body:data})
  if(path.endsWith('/authAjax'))return json({id:81,username:'fixture',token:'private',success:true,team:{id:7,name:'fixture'}})
  if(path.endsWith('/member/state/independent'))return json({vt:'custom',deadLine:options.expired?'2000-01-01 00:00:00':'2100-01-01 00:00:00',mainApp:'rsq',usersCount:options.overCapacity?3:1,userLimit:2,uploadImgSize:options.imageLimit??100,uploadFileSize:1000,cloudSize:1000000})
  if(path.endsWith('/function/available'))return json([{funcName:'CLOUD_LIB',status:options.disabled?'disable':'enable'}])
  if(path.endsWith('/authorities/company/current'))return json({})
  if(path===base+'/list')return json([...folders.values()].filter(row=>row.parentFolderId==null).map(row=>({id:row.id,name:row.name,color:row.color,type:'folder',displayOrder:+row.id})))
  if(path===base&&method==='GET'){const row=folders.get(q.id);assert.ok(row);return json(row)}
  if(path===files+'/list'){
   const list=[...[...folders.values()].filter(row=>row.parentFolderId===q.folderId),...[...entries.values()].filter(row=>row.parentFolderId===q.folderId)]
   let at=0;if(q.lastDataId){assert.ok(['folder','file'].includes(q.type));at=list.findIndex(row=>String(row.id)===q.lastDataId&&row.type===q.type)+1;assert.ok(at>0)}
   return json(options.changedPage&&at?list.slice(0,+q.max):list.slice(at,at+(+q.max)))
  }
  if(path===base&&method==='POST'){const row=addFolder(String(++next),data.parentFolderId,data.name);row.color=data.color;return json(options.unknownCreate?{id:row.id,name:row.name,color:'invalid'}:row)}
  const folder=/^\/task\/v1\/folder\/([0-9]+)$/.exec(path)
  if(folder){const row=folders.get(folder[1]);assert.ok(row);if(method==='PUT'){if(options.timeout)throw Error('lost');if(!options.ignored)Object.assign(row,data);return json(row)}if(method==='DELETE'){const removed=new Set([folder[1]]);let count=0;while(count!==removed.size){count=removed.size;for(const [id,child]of folders)if(removed.has(child.parentFolderId))removed.add(id)}for(const id of removed)folders.delete(id);for(const [id,file]of entries)if(removed.has(file.parentFolderId))entries.delete(id);return new Response(null,{status:204})}}
  if(path===base+'/move'){if(options.moveDenied)return json(false);folders.get(data.folderId).parentFolderId=data.parentFolderId;return new Response(null,{status:200})}
  if(path===files&&method==='GET'){const row=entries.get(q.id);assert.ok(row);assert.ok(!row.noteId&&!row.corpusId,'linked resources use current HTTP list metadata');return json(options.foreignDetail?{...row,parentFolderId:'999'}:options.stale&&calls.filter(c=>c.path===files&&c.method==='GET').length>1?{...row,name:'concurrently-renamed.txt'}:row)}
  if(path===files+'/create'){const row=addFile(String(++next),data.folderId,data.fileName);row.contentType=data.extName;delete row.size;row[data.extName==='note'?'noteId':'corpusId']=String(++next);return json(row)}
  const file=/^\/task\/v1\/folder\/file\/([0-9]+)$/.exec(path)
  if(file){const row=entries.get(file[1]);assert.ok(row);if(method==='DELETE'){entries.delete(file[1]);return new Response(null,{status:204})}if(method==='PUT'){if(!options.ignored)Object.assign(row,data);return json(row)}}
  if(path===files+'/copy'){const before=entries.get(data.fileId),copy=structuredClone(before);Object.assign(copy,{id:String(++next),parentFolderId:data.folderId,creatorId:81,creator:{id:81}});entries.set(copy.id,copy);if(options.concurrentCopy)entries.set(String(++next),{...copy,id:String(next)});return new Response(null,{status:204})}
  if(path===files+'/move'){entries.get(data.fileId).parentFolderId=data.folderId;return new Response(null,{status:204})}
  if(path===files+'/used')return json({used:options.full?1000000:0,max:1000000,percent:options.full?'100.00%':'0.00%'})
  if(path==='/task/files/file/upload/check')return json({canUpload:!options.badType})
  if(path===files+'/secondPass'){if(options.secondPass){const row=data.fileId?entries.get(data.fileId):addFile(String(++next),data.folderId,data.fileName);Object.assign(row,{name:data.fileName,size:options.size});return json({secondPass:true,file:row})}return json({secondPass:false,file:null})}
  if(path==='/task/sts/token/oss')return json({storage:'oss',prefix:'fixture/81',bucket:'fixture-bucket',credentials:{AccessKeyId:'fixture',AccessKeySecret:'fixture',SecurityToken:'fixture',Expiration:new Date(Date.now()+3600000).toISOString()}})
  if(path===files+'/getAliFile'){assert.equal(data.filePath,'fixture/81/upload.txt');const row=addFile(String(++next),data.folderId,data.fileName);row.size=options.size;return json(row)}
  if(path===files+'/updateFile'){assert.equal(data.filePath,'fixture/81/upload.txt');assert.match(data.md5,/^[a-f0-9]{32}$/);const row=entries.get(data.fileId);if(options.replaceTimeout)throw Error('lost replacement');if(!options.ignored)Object.assign(row,{name:data.fileName,size:options.size});return json(options.wrongReplaceId?{...row,id:'999'}:row)}
  throw Error('unexpected '+method+' '+path)
 }};return f
}
const flow=command=>{const value=workflows.workflows.find(f=>f.command===command);assert.ok(value,command);return value},run=(command,input,f,options={})=>runWorkflow(ctx,flow(command),input,session,{transport:f.transport,approved:true,...options})
test('ordinary cloud folders and files resolve typed IDs, move complete subtrees and independently read back sparse metadata',async()=>{
 const f=fixture(),initial=(await run('file tree inspect',{libraryId:'101'},f)).result;assert.equal(initial.items.length,4);assert.equal(initial.items.filter(row=>row.id==='201').length,2);assert.ok(!JSON.stringify(initial).includes('signature'))
 const folder=(await run('file folder create',{libraryId:'101',parentFolderId:'202',name:'新目录',color:0},f)).result.folder;assert.equal(folder.color,0)
 await run('file folder update',{libraryId:'101',id:folder.id,patch:{name:'目录更名',color:2}},f)
 await run('file folder move',{libraryId:'101',id:'201',destinationLibraryId:'102'},f);assert.equal(f.folders.get('201').parentFolderId,'102');assert.equal((await run('file tree inspect',{libraryId:'102'},f)).result.items.length,4)
 const target={libraryId:'102',id:'9007199254740993123'}
 assert.equal((await run('file entry inspect',target,f)).result.file.id,target.id)
 await run('file entry rename',{...target,name:'新名称.txt'},f);assert.ok(!workflows.workflows.some(flow=>flow.command==='file entry edit-lock'))
 const copied=(await run('file entry copy',{...target,destinationLibraryId:'101'},f)).result.file;assert.notEqual(copied.id,target.id)
 await run('file entry move',{libraryId:'101',id:copied.id,destinationLibraryId:'102',destinationFolderId:folder.id},f)
 await run('file entry remove',{libraryId:'102',id:copied.id},f);assert.ok(!f.entries.has(copied.id))
 const created=(await run('file entry create',{libraryId:'102',name:'关联文档',type:'note'},f)).result.file;assert.ok(created.noteId);assert.notEqual(created.id,created.noteId)
 const removed=(await run('file folder remove',{libraryId:'102',id:'201'},f)).result;assert.equal(removed.affectedVisibleIds.length,4);assert.ok(!f.entries.has(target.id));assert.ok(f.entries.has('201'))
})
test('mixed directory pagination carries both the ID and type, and never accepts repeated pages as complete',async()=>{
 const f=fixture();for(let n=0;n<105;n++)f.addFile(String(3000+n),'101','page-'+n+'.txt')
 const out=await run('file tree inspect',{libraryId:'101'},f);assert.equal(out.result.items.length,109);assert.ok(f.calls.some(call=>call.query.lastDataId&&call.query.type==='file'))
 const changed=fixture({changedPage:true});for(let n=0;n<105;n++)changed.addFile(String(4000+n),'101');await assert.rejects(run('file folder create',{libraryId:'101',name:'不能创建'},changed),{code:'PAGINATION_CHANGED'});assert.ok(changed.calls.every(call=>call.method==='GET'))
})
test('visibility, per-resource UI permissions and target cycle checks stop unsafe writes',async()=>{
 const input={libraryId:'101',id:'9007199254740993123'}
 const invisible=fixture();await assert.rejects(run('file entry inspect',{...input,libraryId:'999'},invisible),{code:'RESOURCE_NOT_VISIBLE'});assert.ok(!invisible.calls.some(call=>call.path===files))
 const foreign=fixture({foreignDetail:true});await assert.rejects(run('file entry rename',{...input,name:'x'},foreign),{code:'BUSINESS_ASSERTION_FAILED'});assert.ok(!foreign.calls.some(call=>call.method==='PUT'))
 const denied=fixture({permissions:{moveFolder:false,renameFile:false}});await assert.rejects(run('file entry rename',{...input,name:'x'},denied),{code:'RESOURCE_FORBIDDEN'});await assert.rejects(run('file folder move',{libraryId:'101',id:'201',destinationLibraryId:'102'},denied),{code:'RESOURCE_FORBIDDEN'})
 const cycle=fixture();await assert.rejects(run('file folder move',{libraryId:'101',id:'201',destinationLibraryId:'101',destinationFolderId:'202'},cycle),{code:'INVALID_INPUT'});assert.ok(cycle.calls.every(call=>call.method==='GET'))
 for(const [option,code]of[['expired','COMPANY_EXPIRED'],['overCapacity','COMPANY_OVER_CAPACITY'],['disabled','FEATURE_DISABLED']]){const f=fixture({[option]:true});await assert.rejects(executeWorkflow(ctx,flow('file folder create'),{libraryId:'101',name:'受限'},session,{transport:f.transport}),{code});assert.ok(!f.calls.some(call=>call.path===base+'/list'||call.method==='POST'))}
})
test('replacement preserves the original ID, uses second pass or a single upload, and fails on stale or ignored writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rsq-cloud-replace-')),localFile=join(dir,'replacement.txt'),bytes='replacement HTTP 中文 longer\n';await writeFile(localFile,bytes);const size=Buffer.byteLength(bytes),target={libraryId:'101',id:'9007199254740993123',localFile}
 const uploadTransfer=async(_cert,file)=>({path:'fixture/81/upload.txt',size:file.size,md5:file.md5,mode:'put'})
 try{
  for(const secondPass of [false,true]){const f=fixture({size,secondPass}),before=f.entries.size,out=await run('file entry replace',target,f,{uploadTransfer});assert.equal(out.result.file.id,target.id);assert.equal(out.resources.originalFileId,target.id);assert.equal(out.result.file.size,size);assert.equal(out.result.file.name,'replacement.txt');assert.equal(out.result.uploadMode,secondPass?'second-pass':'storage');assert.equal(f.entries.size,before);assert.equal(f.calls.filter(call=>call.path===files+'/updateFile').length,secondPass?0:1);assert.equal(f.calls.filter(call=>call.path===files+'/secondPass').length,1);assert.ok(f.calls.filter(call=>call.path===files+'/secondPass').every(call=>call.body.fileId===target.id))}
  for(const [option,code]of[['stale','CONTEXT_STALE'],['ignored','BUSINESS_ASSERTION_FAILED'],['replaceTimeout','NETWORK_ERROR'],['wrongReplaceId','BUSINESS_ASSERTION_FAILED']]){const f=fixture({size,[option]:true});await assert.rejects(run('file entry replace',target,f,{uploadTransfer}),e=>e.code===code&&e.details.resources.fileId&&(!e.details.resources.originalFileId||e.details.resources.originalFileId===target.id));assert.ok(f.calls.filter(call=>call.path===files+'/updateFile').length<=1);if(option==='stale')assert.ok(f.calls.every(call=>call.method==='GET'))}
  const linked=fixture({size});linked.entries.get(target.id).noteId='901';await assert.rejects(run('file entry replace',target,linked),{code:'INVALID_INPUT'});assert.ok(linked.calls.every(call=>call.method==='GET'))
  const denied=fixture({size,permissions:{updateFile:false}});await assert.rejects(run('file entry replace',target,denied),{code:'RESOURCE_FORBIDDEN'});assert.ok(denied.calls.every(call=>call.method==='GET'))
  const f=fixture();await assert.rejects(run('file entry replace',target,f,{approved:false}),{code:'CONFIRMATION_REQUIRED'});assert.equal(f.calls.length,0)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('cloud upload enforces byte-based order limits, storage capacity, extension and duplicate name before any creating POST',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rsq-cloud-')),localFile=join(dir,'中文.txt');await writeFile(localFile,'HTTP 中文\n');const size=Buffer.byteLength('HTTP 中文\n')
 try{
  for(const [options,code]of[[{full:true},'STORAGE_CAPACITY_LIMIT'],[{badType:true},'FILE_TYPE_FORBIDDEN'],[{imageLimit:1},'FILE_SIZE_LIMIT']]){const f=fixture({...options,size});await assert.rejects(run('file entry upload',{libraryId:'101',localFile,...(options.imageLimit&&{fileName:'tiny.png'})},f),{code});assert.ok(!f.calls.some(call=>call.method==='POST'))}
  const duplicate=fixture();duplicate.addFile('100','101','中文.txt');await assert.rejects(run('file entry upload',{libraryId:'101',localFile},duplicate),{code:'DUPLICATE_RESOURCE'})
  const f=fixture({size}),uploaded=(await run('file entry upload',{libraryId:'101',parentFolderId:'201',localFile},f,{uploadTransfer:async(_cert,file,checkpoint)=>{checkpoint({objectPath:'fixture/81/upload.txt'});return{path:'fixture/81/upload.txt',size:file.size,md5:file.md5,mode:'put'}}})).result
  assert.equal(uploaded.uploadMode,'storage');assert.equal(uploaded.file.size,size);assert.ok(f.calls.some(call=>call.path===files+'/getAliFile'))
  const second=fixture({size,secondPass:true}),out=await run('file entry upload',{libraryId:'101',localFile},second,{uploadTransfer:async()=>{throw Error('must skip bytes')}});assert.equal(out.result.uploadMode,'second-pass');assert.ok(!second.calls.some(call=>call.path.includes('/sts/')||call.path.endsWith('getAliFile')))
 }finally{await rm(dir,{recursive:true,force:true})}
 assert.throws(()=>validateCloudUpload({uploadFileSize:10,cloudSize:100},{used:0,max:100,percent:'0.00%'},{name:'a.txt',size:11}),{code:'FILE_SIZE_LIMIT'})
})
test('unknown writes retain resource checkpoints, ambiguous copies do not replay, and ignored writes fail readback',async()=>{
 const unknown=fixture({unknownCreate:true});await assert.rejects(run('file folder create',{libraryId:'101',name:'已创建'},unknown),e=>e.code==='RESPONSE_SCHEMA_MISMATCH'&&e.details.writeOutcome==='unknown-do-not-retry'&&!!e.details.resources.folderId);assert.equal(unknown.calls.filter(c=>c.method==='POST').length,1)
 const timeout=fixture({timeout:true});await assert.rejects(run('file folder update',{libraryId:'101',id:'201',patch:{name:'未知'}},timeout),e=>e.code==='NETWORK_ERROR'&&e.details.resources.folderId==='201'&&e.details.writeOutcome==='unknown-do-not-retry');assert.equal(timeout.calls.filter(c=>c.method==='PUT').length,1)
 const ignored=fixture({ignored:true});await assert.rejects(run('file entry rename',{libraryId:'101',id:'201',name:'被忽略.txt'},ignored),{code:'BUSINESS_ASSERTION_FAILED'});assert.equal(ignored.calls.filter(c=>c.method==='PUT').length,1)
 const ambiguous=fixture({concurrentCopy:true});await assert.rejects(run('file entry copy',{libraryId:'101',id:'201',destinationLibraryId:'102'},ambiguous),{code:'CONTEXT_CONFLICT'});assert.equal(ambiguous.calls.filter(c=>c.path===files+'/copy').length,1)
 const denied=fixture({moveDenied:true});await assert.rejects(run('file folder move',{libraryId:'101',id:'201',destinationLibraryId:'102'},denied),{code:'RESPONSE_SCHEMA_MISMATCH'})
})
test('offline plans declare HTTP and byte steps, require destructive confirmation and reject modified executor contracts',async()=>{
 const f=fixture(),plan=await run('file entry upload',{libraryId:'101',localFile:'/not/read/offline'},f,{dryRun:true});assert.equal(f.calls.length,0);assert.equal(plan.dryRun,true);assert.ok(plan.steps.some(s=>s.command==='HTTP 对象存储字节上传'))
 await assert.rejects(run('file folder remove',{libraryId:'101',id:'201'},f,{approved:false}),{code:'CONFIRMATION_REQUIRED'});assert.equal(f.calls.length,0)
 const changed=structuredClone(flow('file entry upload'));changed.steps.find(s=>s.id==='stored').transfer=undefined;assert.throws(()=>validateCloudFileWorkflow(changed),{code:'INVALID_CONTRACT'})
})
