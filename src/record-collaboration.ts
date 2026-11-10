import { asObject, type JsonObject } from './core.js'
import { datasheetVisibility } from './datasheet-visibility.js'
import { requireUsage, usageData, usageError, usageHash, usageId, usageRows, usageSnapshotPage, type UsageRuntime } from './usage-runtime.js'

function cursorRead(value: unknown,binding: unknown){
  if(value===undefined)return undefined
  let row:JsonObject
  try{row=asObject(JSON.parse(Buffer.from(String(value),'base64url').toString('utf8')))}catch{usageError('INVALID_INPUT','活动分页游标无效。')}
  if(row!.query!==usageHash(binding)||row!.after===undefined)usageError('INVALID_INPUT','游标与当前对象、身份或查询条件不同。')
  return row!.after
}
const cursorWrite=(after:unknown,binding:unknown)=>Buffer.from(JSON.stringify({query:usageHash(binding),after})).toString('base64url')
const html=(text:string)=>'<p>'+text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replace(/\r?\n/g,'<br>')+'</p>'

export async function runRecordCollaboration(r:UsageRuntime,action:string,input:JsonObject){
  await r.identity()
  if(action==='task-activity'){
    const taskId=usageId(input.taskId);await r.existing('task context inspect',{taskId,...(input.projectId!==undefined&&{projectId:input.projectId})})
    const binding={taskId,projectId:input.projectId??null,identity:r.session.identity},after=cursorRead(input.cursor,binding),limit=Number(input.limit??50)
    if(after!==undefined&&!/^[1-9][0-9]*$/.test(String(after)))usageError('INVALID_INPUT','任务活动游标不是精确事件 ID。')
    const items=usageRows(await r.call('GET','/task/api/v3/action/list',{query:{taskId,max:limit,...(after!==undefined&&{firstId:String(after)})}}))
    requireUsage(items.length<=limit && new Set(items.map(row=>usageId(row.id))).size===items.length,'任务活动出现重复或超出分页。')
    for(let i=0;i<items.length;i++){const id=BigInt(usageId(items[i].id));requireUsage((after===undefined||id<BigInt(String(after)))&&(i===0||id<BigInt(usageId(items[i-1].id))),'任务活动没有保持服务端倒序游标语义。')}
    return {taskId,items,nextCursor:items.length===limit?cursorWrite(usageId(items.at(-1)!.id),binding):null,pagination:'server-action-id-descending'}
  }
  const projectId=usageId(input.projectId),datasheetId=usageId(input.datasheetId),recordId=usageId(input.recordId),target={projectId,datasheetId,recordId}
  // Native record readback establishes the project's actual shared reference,
  // field visibility and current row membership before weak legacy endpoints.
  const record=await r.existing('datasheet record get',target)
  requireUsage(usageRows(record.records).some(row=>String(row.id)===recordId),'当前角色没有可见的目标记录。')
  const data=usageData(await r.call('GET','/task/mt/datasheet/{datasheetId}/dataPack',{path:{datasheetId},query:{projectId}}))
  const visible=datasheetVisibility(data,String(r.resources.mainProjectId)!==projectId)
  if(!visible.recordIds.includes(recordId))usageError('FORBIDDEN','记录已离开当前角色可见范围。')
  const role=visible.role, editable=role.permissionMode!=='readOnly' && ['manageFields','editAll','custom'].includes(String(role.fieldEditMode))&&['all','partial'].includes(String(role.editRecordScope))&&
    (role.editRecordScope!=='partial'||asObject(asObject(role.matchRecordMap)[recordId]).canEdit===true)&&asObject(asObject(role.matchRecordMap)[recordId]).canEdit!==false
  const base={...target,revision:visible.table.revision},comments=()=>r.call('GET','/task/record/comment/list',{query:{datasheetId,recordId}}).then(usageRows)
  if(action==='record-activity'){
    // Historical payloads can include values of formerly visible/deleted fields.
    // Until per-operation redaction is proven, restricted columns fail closed.
    if(visible.fieldIds.size!==Object.keys(asObject(asObject(visible.snapshot.meta).fieldMap)).length || !visible.completeTable)usageError('FORBIDDEN','当前角色为局部字段或视图；历史原始操作可能含隐藏值，暂不开放该分支。')
    const binding={...target,type:input.type??1,identity:r.session.identity},after=cursorRead(input.cursor,binding),limit=Number(input.limit??50)
    if(after!==undefined&&(!Number.isSafeInteger(after)||Number(after)<0))usageError('INVALID_INPUT','记录活动游标 revision 无效。')
    const result=usageData(await r.call('GET','/task/mt/resource/{datasheetId}/records/{recordId}/activity',{path:{datasheetId,recordId},query:{pageSize:limit,type:input.type??1,...(after!==undefined&&{maxRevision:after})}}))
    const items=usageRows(result.changesets)
    requireUsage(items.length<=limit && items.every(row=>Number.isSafeInteger(row.revision)),'记录活动没有返回合法版本。')
    requireUsage(items.every((row,index)=>(after===undefined||Number(row.revision)<Number(after))&&(index===0||Number(row.revision)<Number(items[index-1].revision))),'记录活动没有保持严格倒序 revision 游标，停止以免重复分页。')
    return {...base,items,users:result.users??[],nextCursor:items.length===limit?cursorWrite(items.at(-1)!.revision,binding):null,pagination:'server-revision-descending'}
  }
  const before=await comments()
  if(action==='record-comments')return {...base,...usageSnapshotPage(before,input,{...target,identity:r.session.identity}),canComment:editable,nextCommands:['datasheet record comment add','datasheet record comment remove']}
  if(!editable)usageError('FORBIDDEN','当前角色或逐行权限不允许编辑记录及其评论。')
  if(action==='record-comment-add'){
    const content=html(String(input.text)),created=asObject(await r.call('POST','/task/record/comment',{body:{datasheetId,recordId,content}})),commentId=usageId(created.id)
    r.resources.commentId=commentId
    const actual=(await comments()).find(row=>String(row.id)===commentId)
    requireUsage(actual?.content===content && String(asObject(actual.creator).id)===r.session.identity.userId,'评论正文或作者没有在同一记录中独立读回。')
    return {...base,comment:actual,verified:true}
  }
  if(action==='record-comment-remove'){
    const commentId=usageId(input.commentId),original=before.find(row=>String(row.id)===commentId)
    if(!original)usageError('FORBIDDEN','评论不属于当前可见记录。')
    if(String(asObject(original.creator).id)!==r.session.identity.userId)usageError('FORBIDDEN','只能删除当前账号自己的记录评论。')
    await r.call('DELETE','/task/record/comment',{query:{id:commentId}})
    requireUsage(!(await comments()).some(row=>String(row.id)===commentId),'评论删除后仍能读到。')
    return {...base,removedCommentId:commentId,verified:true}
  }
  usageError('INVALID_CONTRACT','未知记录协作业务。')
}
