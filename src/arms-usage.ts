import type { Context, JsonObject, Transport } from './core.js'
import type { Session } from './session.js'
import type { Workflow } from './workflows.js'
import { usageRuntime, usageError, validateUsageWorkflow } from './usage-runtime.js'
import { runTodoUsage } from './todo-usage.js'
import { runProjectViews } from './project-views.js'
import { runWorkflowDiscovery } from './workflow-discovery.js'
import { runRecordCollaboration } from './record-collaboration.js'

export async function runArmsUsage(ctx:Context,flow:Workflow,input:JsonObject,session:Session|null,options:{transport?:Transport;approved?:boolean}):Promise<{command:string;completedSteps:string[];resources:JsonObject;result:unknown}>{
  validateUsageWorkflow(flow)
  const r=usageRuntime(ctx,flow,session,options), action=flow.usageAction!
  try {
    const result=action.startsWith('todo-')?await runTodoUsage(r,action,input):action.startsWith('view-')?await runProjectViews(r,action,input):action.startsWith('workflow-')?await runWorkflowDiscovery(r,action,input):['task-activity','record-activity','record-comments','record-comment-add','record-comment-remove'].includes(action)?await runRecordCollaboration(r,action,input):usageError('INVALID_CONTRACT','未知 ARMS 业务命令。')
    return r.finish(result)
  }catch(error){return r.fail(error)}
}
