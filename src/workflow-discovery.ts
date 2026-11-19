import { asObject, type JsonObject } from './core.js'
import { requireUsage, usageData, usageError, usageId, usageList, usageRows, usageSnapshotPage, type UsageRuntime } from './usage-runtime.js'

import { readWorkflowDetail, readWorkflowStepForm, visibleInstances } from './workflow-reads.js'
import { describeWorkflowResource, matchesWorkflowName, workflowResources } from './workflow-resources.js'
import { exportWorkflow } from './workflow-export.js'

async function projectFormRecords(r: UsageRuntime, input: JsonObject, projectId: string, applicationId: string) {
  const formId = usageId(input.formId)
  const definition = await r.existing('project workflow form describe', { projectId, applicationId, formId })
  requireUsage(String(definition.id) === formId, '读取的表单不属于当前查询。')
  const page = Number(input.page ?? 1), limit = Number(input.limit ?? 5), offset = (page - 1) * limit
  const { items: instances, filter } = await visibleInstances(r, applicationId, input, limit, offset)
  const items: JsonObject[] = []
  let visibleSteps = 0
  const scope = { kind: 'project', projectId, applicationId } as const
  for (const instance of instances) {
    const processId = usageId(instance.id)
    const detail = await readWorkflowDetail(r, scope, processId)
    const steps = usageRows(detail.processInfoStepList)
    visibleSteps += steps.length
    if (visibleSteps > 200) usageError('CONTEXT_MISSING', '本页可见步骤超过 200 个，请减少 --limit。')
    for (const summary of steps) {
      const { step, form } = await readWorkflowStepForm(r, scope, processId, summary, formId)
      if (form) items.push({ processId, stepId: usageId(step.id), fields: form.fields, target: { command: 'project workflow instance inspect', projectId, processId } })
    }
  }
  return { projectId, applicationId, formId, form: { id: formId, name: definition.name }, items, filtersApplied: filter,
    pagination: { mode: 'visible-instances', page, limit, nextPage: instances.length === limit ? page + 1 : null, sourceInstanceCount: instances.length },
    nextCommands: ['project workflow instance inspect', 'project workflow instance fill'] }
}

export async function runWorkflowDiscovery(r: UsageRuntime, action: string, input: JsonObject) {
  await r.identity()
  if (action === 'workflow-export') return exportWorkflow(r, input)
  if (action === 'workflow-find') {
    const lookup = await workflowResources(r), resources = await lookup.find(input)
    const page = Number(input.page ?? 1), limit = Number(input.limit ?? 20)
    const name = typeof input.name === 'string' ? input.name : undefined
    const items = resources.slice((page - 1) * limit, page * limit).map(resource => ({
      ...describeWorkflowResource(resource), match: name === undefined || matchesWorkflowName(name, resource) ? 'exact' : 'partial',
    }))
    return { items, total: resources.length, exact: name === undefined ? resources.length : resources.filter(item => matchesWorkflowName(name, item)).length,
      page, limit, nextPage: page * limit < resources.length ? page + 1 : null }
  }
  const project = r.flow.usageProject ? { projectId: usageId(input.projectId) } : {}
  const command = (operation: string) => (r.flow.usageProject ? 'project workflow ' : 'workflow ') + operation
  if(action==='workflow-children'||action==='workflow-child-start'){
    const processId=usageId(input.processId), parent=await r.existing(command('instance inspect'),{...project,processId})
    requireUsage(String(parent.id)===processId,'父流程实例身份不一致。')
    const steps=usageRows(parent.steps), eligible=steps.filter(step=>step.stepType==='childProcess'||asObject(step.detail).stepType==='childProcess')
    if(input.stepId===undefined)return {...project,processId,steps:eligible.map(step=>({id:usageId(step.id),originId:usageId(step.originId),name:step.name,status:step.status})),nextCommand:command('instance children list'),requires:'从实际父实例选择 stepId；不是步骤定义 originId。'}
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
    return {...project,processId,stepId:usageId(step.id),originStepId:usageId(step.originId),...usageSnapshotPage(items,input,{...project,processId,stepId:step.id,identity:r.session.identity}),
      nextCommands:['project workflow instance inspect', 'workflow instance inspect'], childContext:'从子实例自己的应用及所属项目选择命令。父子关系不会改变子实例的所属入口或权限。', relationVerified:true}
  }
  const applicationId=usageId(input.applicationId)
  if (action === 'workflow-form-records') return projectFormRecords(r, input, usageId(project.projectId), applicationId)
  const configuration=await r.existing(command('configuration inspect'),{...project,applicationId})
  requireUsage(String(asObject(configuration.application).id)===applicationId,'流程应用上下文不一致。')
  if(action==='workflow-context')return {...project,applicationId,application:configuration.application,forms:configuration.forms,fields:usageRows(configuration.forms).flatMap(form=>usageRows(form.fields??[])),steps:configuration.steps,
    filters:{name:'名称包含',status:['all','doing','finished'],createdBetween:'[YYYY-MM-DD,YYYY-MM-DD]，GMT+8 含结束日'},pagination:{mode:'server-offset',maximum:200},
    nextCommands:['instances list','form describe','form records list','instance inspect','instance children list'].map(command)}
  const max=Number(input.limit??50),offset=Number(input.offset??0)
  const { items, filter: filters } = await visibleInstances(r, applicationId, input, max, offset)
  return {...project,applicationId,items:items.map(row=>({...row,id:usageId(row.id),target:{command:command('instance inspect'),...project,processId:usageId(row.id)}})),
    pagination:{mode:'server-offset',offset,limit:max,nextOffset:items.length===max?offset+max:null,total:null},filtersApplied:filters,
    limitations:['finished 筛选沿用 UI 含已完成和已关闭；查看实例 status 区分终态。','offset 分页不是原子快照，列表有新增时建议重新查询。'],nextCommands:['instance inspect','instance fill','instance act','instance children list','form records list'].map(command)}
}
