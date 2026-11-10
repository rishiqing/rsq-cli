import { isDeepStrictEqual } from 'node:util'
import { asObject, type JsonObject } from './core.js'
import { todoFilters } from './todo-usage.js'
import { requireUsage, usageError, usageId, usageRows, usageSnapshotPage, type UsageRuntime } from './usage-runtime.js'

const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b)
function filterMeaning(value: unknown) {
  return usageRows(value).map(row => ({ key:row.key,contentValue:row.contentValue ?? '',
    operators:(Array.isArray(row.operator) ? row.operator.map(asObject) : []).filter(item=>item.selected===true).map(item=>String(item.value)).sort(),
    values:(Array.isArray(row.selector) ? row.selector.map(asObject) : []).filter(item=>item.selected===true && !(['13','14','44'].includes(String(row.key))&&String(item.value)==='1')).map(item=>String(item.value)).sort(),
  })).filter(row=>row.contentValue || row.operators.length || row.values.length).sort((a,b)=>String(a.key).localeCompare(String(b.key)))
}
export async function runProjectViews(r: UsageRuntime, action: string, input: JsonObject) {
  await r.identity()
  const template=r.flow.usageTemplate===true, headers=template?{'Plan-Type':'template'}:undefined
  const legacy=(query: JsonObject)=>({query,...(headers&&{headers})})
  const cover=template?asObject(await r.call('GET','/task/v4/template',{query:{id:input.coverId}})):null
  const projectId=usageId(cover?cover.templateKanbanId:input.projectId), moduleId=usageId(input.moduleId)
  const project=asObject(await r.call('GET','/task/v1/kanbanCrud',legacy({id:projectId,isDefault:false})))
  requireUsage(same(project.id,projectId) && Object.hasOwn(project,'coverId') && (template?same(project.coverId,input.coverId)&&same(cover!.id,input.coverId):project.coverId===null),'普通项目和项目模板必须分别绑定真实目标。')
  const modules=usageRows(await r.call('GET','/task/v1/kanbanChildCrud/list',legacy({kanbanId:projectId})))
  requireUsage(modules.some(row=>same(row.id,moduleId)&&row.type==='task'),'视图目标不是当前项目的实际任务模块。')
  Object.assign(r.resources,{projectId,moduleId,...(template&&{coverId:input.coverId})})
  const base={projectId,moduleId,...(template&&{coverId:input.coverId})}
  const list=()=>r.call('GET','/task/api/plan/view/list',legacy({kanbanChildId:moduleId})).then(usageRows)
  const before=await list()
  if(action==='view-list') return {...base,items:before,nextCommand:(template?'project template':'project')+' view inspect'}
  const targetId=input.viewId==null?null:usageId(input.viewId), target=before.find(row=>same(row.id,targetId))
  if(action!=='view-create'&&!target) usageError('FORBIDDEN','viewId 必须来自当前模块的视图列表。')
  const viewId=targetId ?? usageId(before.find(row=>row.isSelect===true)?.id)
  const definitions=()=>r.call('GET','/task/api/v3/projectTask/filterCondition',{query:{viewId}}).then(value=>usageRows(asObject(value).filter))
  const selected=()=>r.call('GET','/task/api/v3/projectTask/selectedFilterCondition',{query:{viewId}}).then(value=>usageRows(asObject(value).filter))
  const fields=async()=>({available:usageRows(await r.call('GET','/task/api/plan/view/field/list',legacy({kanbanChildViewId:viewId}))),selected:usageRows(await r.call('GET','/task/api/plan/view/field/selectedList',legacy({kanbanChildViewId:viewId})))})
  if(action==='view-inspect') return {...base,view:target,filters:await definitions(),selectedFilters:await selected(),fields:await fields(),permissions:{editView:asObject(project.editControl).editKanbanView===true,editTemplate:cover?.withEdit??null}}
  if(action==='view-tasks') {
    const filter=await selected(), cards=usageRows(await r.call('GET','/task/v1/kanbanCardCrud/list',legacy({kanbanChildId:moduleId}))), items:JsonObject[]=[]
    const wireFilters=filter.map(row=>({...Object.fromEntries(['key','contentValue','operator'].filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])),selector:Array.isArray(row.selector)?row.selector.map(raw=>{const s=asObject(raw);return {value:String(s.value),selected:s.selected===true}}):null}))
    for(const card of cards) for(let offset=0;;offset+=200){
      const page=usageRows(await r.call('PUT','/task/api/v3/projectTask/taskList',{body:{planId:moduleId,key:usageId(card.id),groupType:'card',sortType:target!.sort??null,planViewId:viewId,showView:String(target!.showView),filter:wireFilters,isNeedTemplateField:true,offset,max:200}}))
      if(page.length>200 || items.length+page.length>100000) usageError('CONTEXT_MISSING','视图查询超过有界窗口，请缩小筛选。')
      for(const row of page){if(!items.some(item=>same(item.id,row.id)))items.push({...row,cardId:usageId(card.id)})}
      if(page.length<200)break
    }
    // Each card retains server sorting; cards retain the actual module order.
    const after=await selected();requireUsage(isDeepStrictEqual(filterMeaning(after),filterMeaning(filter)),'查询期间保存的筛选发生变化，请重新开始。')
    return {...base,view:target,selectedFilters:filter,...usageSnapshotPage(items,input,{...base,viewId,filter,sort:target!.sort,identity:r.session.identity}),ordering:'module-card-order-then-server-view-sort',filterApplied:true}
  }
  if(action!=='view-select'&&(asObject(project.editControl).editKanbanView!==true || cover&&cover.withEdit!==true))usageError('FORBIDDEN','当前上下文没有保存视图或编辑模板的权限。')
  if(action==='view-create'){
    const filters=todoFilters(input.filters,await definitions())
    const changed=asObject(await r.call('POST','/task/api/plan/view',{body:{kanbanChildId:moduleId,kanbanChildViewId:viewId,name:input.name,showView:input.display??'list',sort:input.sort??'customSort',filter:filters,cardGroup:'card',isShowEmptyTaskCard:true},...(headers&&{headers})}))
    const id=usageId(changed.id);r.resources.viewId=id
    const actual=(await list()).find(row=>same(row.id,id));requireUsage(actual && actual.name===input.name && actual.showView===(input.display??'list'),'新视图没有按目标模块和名称读回。')
    const stored=asObject(await r.call('GET','/task/api/v3/projectTask/selectedFilterCondition',{query:{viewId:id}})).filter
    requireUsage(isDeepStrictEqual(filterMeaning(stored),filterMeaning(filters)),'新视图筛选没有持久化。')
    return {...base,view:actual,selectedFilters:stored,previousSelectedViewId:before.find(row=>row.isSelect===true)?.id??null,verified:true}
  }
  r.resources.viewId=viewId
  if(action==='view-select'){
    await r.call('GET','/task/api/plan/view',legacy({id:viewId}))
    const after=await list();requireUsage(after.filter(row=>row.isSelect===true).length===1 && after.some(row=>same(row.id,viewId)&&row.isSelect===true),'选择视图没有独立读回。')
    return {...base,view:after.find(row=>same(row.id,viewId)),verified:true}
  }
  if(action==='view-remove'){
    await r.call('DELETE','/task/api/plan/view',legacy({id:viewId}))
    requireUsage(!(await list()).some(row=>same(row.id,viewId)),'删除后视图仍存在。')
    return {...base,removedViewId:viewId,verified:true}
  }
  if(action==='view-fields'){
    const definitions=await fields(), available=[...definitions.selected,...definitions.available.flatMap(group=>usageRows(group.list??[]))]
    const requested=input.fieldIds as string[]
    if(requested[0]!=='taskName')usageError('INVALID_INPUT','与网页一致，显示字段必须保留 taskName 并放在第一位。')
    const list=requested.map(id=>{const row=available.find(field=>same(field.id,id));if(!row)usageError('INVALID_INPUT','显示字段不在当前视图的可用字段目录中。');return row})
    await r.call('PUT','/task/api/plan/view/field',{body:{kanbanChildViewId:viewId,list},...(headers&&{headers})})
    const after=(await fields()).selected;requireUsage(isDeepStrictEqual(after.map(row=>String(row.id)),requested),'显示字段及顺序没有独立读回。')
    return {...base,viewId,fields:after,verified:true}
  }
  if(action==='view-update'){
    if(input.name!==undefined)await r.call('PUT','/task/api/plan/view',{body:{id:viewId,name:input.name},...(headers&&{headers})})
    if(input.filters!==undefined){
      const filters=todoFilters(input.filters,await definitions())
      await r.call('PUT','/task/v3/kanbanItemFilter',{body:{kanbanChildViewId:viewId,filter:filters},...(headers&&{headers})})
      requireUsage(isDeepStrictEqual(filterMeaning(await selected()),filterMeaning(filters)),'筛选请求被受理但没有实际保存；不会重放。')
    }
    const actual=(await list()).find(row=>same(row.id,viewId));requireUsage(actual && (input.name===undefined || actual.name===input.name),'视图名称没有独立读回。')
    return {...base,view:actual,selectedFilters:await selected(),verified:true}
  }
  usageError('INVALID_CONTRACT','未知视图业务。')
}
