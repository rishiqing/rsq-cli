import { asObject, type JsonObject } from './core.js'
import { requireUsage, usageData, usageDate, usageError, usageId, usageList, usageRows, usageSnapshotPage, type UsageRuntime } from './usage-runtime.js'

export async function runWorkflowDiscovery(r: UsageRuntime, action: string, input: JsonObject) {
  await r.identity()
  if(action==='workflow-children'||action==='workflow-child-start'){
    if(r.flow.usageProject){const source=usageData(await r.call('GET','/task/workflow/process/info/details',{query:{processInfoId:input.processId}}));if(String(source.belongToProjectId)!==input.projectId)usageError('FORBIDDEN','父流程不属于指定项目。');await r.bindWorkflowProject(usageId(input.projectId),usageId(source.flowAppId))}
    const processId=usageId(input.processId), parent=await r.existing('workflow instance inspect',{processId})
    requireUsage(String(parent.id)===processId,'父流程实例身份不一致。')
    const steps=usageRows(parent.steps), eligible=steps.filter(step=>step.stepType==='childProcess'||asObject(step.detail).stepType==='childProcess')
    if(input.stepId===undefined)return {processId,steps:eligible.map(step=>({id:usageId(step.id),originId:usageId(step.originId),name:step.name,status:step.status})),nextCommand:'workflow instance children list',requires:'从实际父实例选择 stepId；不是步骤定义 originId。'}
    const step=eligible.find(step=>String(step.id)===input.stepId)
    if(!step)usageError('FORBIDDEN','stepId 必须是当前父实例的实际子流程步骤，不能传定义 ID 或其他实例步骤。')
    if(action==='workflow-child-start'){
      if(parent.belongToProjectId!=null)usageError('INVALID_INPUT','显式子流程发起当前支持独立标准流程；项目内子流程先使用项目关系发现与已有办理入口。')
      if(parent.status!=='doing'||step.status!=='doing'||asObject(asObject(step.detail).editControl).fillStepForm!==true)usageError('FORBIDDEN','父实例的当前子流程步骤不允许填写或发起子流程。')
      const config=usageData(await r.call('GET','/task/workflow/childProcess/step/config',{query:{stepInfoId:usageId(step.originId)}})),applicationId=usageId(input.applicationId),mode=Number(config.childProcessMode)
      if(mode===1 && String(asObject(config.singleApplicationInfo).id)!==applicationId || mode===2 && !usageRows(config.applicationInfoList).some(app=>String(app.id)===applicationId) || mode===3 && String(parent.flowAppId)===applicationId || ![1,2,3].includes(mode))usageError('FORBIDDEN','子流程应用不在当前步骤配置允许的范围内。')
      const application=asObject((await r.existing('workflow configuration inspect',{applicationId})).application)
      if(application.mode!==0 || application.workflowModuleSubType!=null || asObject(application.editControl).initProcess!==true)usageError('FORBIDDEN','目标应用不是当前账号可发起的独立标准流程。')
      const created=usageData(await r.call('POST','/task/workflow/process/info/start',{body:{applicationId,name:input.name,userId:r.session.identity.userId,fromWhere:'childProcessStep',fromId:processId+'_'+usageId(step.id)}})),childId=usageId(created.id)
      r.resources.processId=childId
      const relation=usageList(await r.call('GET','/task/workflow/childProcess/processInfo/list',{query:{childProcessStepId:usageId(step.id)}}))
      requireUsage(relation.some(child=>String(child.id)===childId),'新子实例没有在实际父步骤关系中独立读回。')
      const verified=usageData(await r.call('GET','/task/workflow/process/info/details',{query:{processInfoId:childId}}))
      requireUsage(String(verified.id)===childId && String(verified.flowAppId)===applicationId && verified.name===input.name,'新子实例的应用、名称或身份没有读回。')
      return {parentProcessId:processId,parentStepId:usageId(step.id),process:verified,relationVerified:true,nextCommand:'workflow instance inspect'}
    }
    const items=usageList(await r.call('GET','/task/workflow/childProcess/processInfo/list',{query:{childProcessStepId:usageId(step.id)}}))
    // The relation endpoint is bound to the validated parent instance step.
    // Individual inspection still uses the child's current server permissions.
    return {processId,stepId:usageId(step.id),originStepId:usageId(step.originId),...usageSnapshotPage(items,input,{processId,stepId:step.id,identity:r.session.identity}),nextCommands:['workflow instance inspect','workflow instance fill','workflow instance act'],relationVerified:true}
  }
  const applicationId=usageId(input.applicationId)
  if(r.flow.usageProject)await r.bindWorkflowProject(usageId(input.projectId),applicationId)
  const configuration=await r.existing('workflow configuration inspect',{applicationId})
  requireUsage(String(asObject(configuration.application).id)===applicationId,'流程应用上下文不一致。')
  if(action==='workflow-context')return {applicationId,application:configuration.application,fields:usageRows(configuration.forms).flatMap(form=>usageRows(form.fields??[])),steps:configuration.steps,
    filters:{name:'名称包含',status:['all','doing','finished'],createdBetween:'[YYYY-MM-DD,YYYY-MM-DD]，GMT+8 含结束日'},pagination:{mode:'server-offset',maximum:200},nextCommands:['workflow instances list','workflow instance inspect','workflow instance children list']}
  const filters:JsonObject[]=[]
  if(input.name!==undefined)filters.push({key:'name',include:true,value:String(input.name).trim()})
  if(input.status && input.status!=='all')filters.push({key:'isFinished',include:true,value:input.status==='doing'?'3':'2'})
  if(input.createdBetween!==undefined){
    const dates=input.createdBetween as string[],start=usageDate(dates[0]),end=usageDate(dates[1]);if(start>end)usageError('INVALID_INPUT','创建日期开始不能晚于结束。')
    filters.push({key:'dateCreated',include:true,value:start.replaceAll('-','.')+'-'+end.replaceAll('-','.')})
  }
  const max=Number(input.limit??50),offset=Number(input.offset??0)
  const items=usageList(await r.call('POST','/task/workflow/process/info/sheet/list',{body:{flowApplicationId:applicationId,max,offset,filter:filters}}))
  requireUsage(items.length<=max && items.every(row=>String(row.flowAppId)===applicationId),'表格实例结果超出当前应用或分页窗口。')
  return {applicationId,items:items.map(row=>({...row,id:usageId(row.id),target:{command:'workflow instance inspect',processId:usageId(row.id)}})),
    pagination:{mode:'server-offset',offset,limit:max,nextOffset:items.length===max?offset+max:null,total:null},filtersApplied:filters,
    limitations:['finished 筛选沿用 UI 含已完成和已关闭；查看实例 status 区分终态。','offset 分页不是原子快照，列表有新增时建议重新查询。'],nextCommands:['workflow instance inspect','workflow instance fill','workflow instance act','workflow instance children list']}
}
