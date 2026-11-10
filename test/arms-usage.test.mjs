import test from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { context } from '../dist/core.js'
import { workflows,runWorkflow,workflowSchema } from '../dist/workflows.js'
import { executeWorkflow } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { runRecordCollaboration } from '../dist/record-collaboration.js'
import { runWorkflowDiscovery } from '../dist/workflow-discovery.js'
const ctx=context('production','arms-fixture'),jar=new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Path=/; Secure; HttpOnly','https://www.rishiqing.com')
const session={version:1,method:'password',accessToken:'fixture',cookies:jar.serializeSync(),identity:{userId:'81',teamId:'7'},expiresAt:Date.now()+3600000}
const flow=command=>workflows.workflows.find(f=>f.command===command),response=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}})
const identity={id:81,username:'fixture',token:'fixture',team:{id:7,name:'公司'},success:true}
const filter=[{key:'name',name:'名称',type:'content',contentValue:null,operator:[{value:'1',name:'包含',selected:true}],selector:[]}]
function fixture(options={}){
 const calls=[],state={views:[{id:90,name:'默认',showView:'list',sort:'customSort',isSelect:true}],filters:[],fields:[{id:'taskName',name:'任务名称'},{id:'progress',name:'进度'}],items:[{id:'taskA',name:'a',dateCreated:'2026-11-09 01:00:00'},{id:'taskB',name:'b',dateCreated:'2026-11-09 02:00:00'},{id:'stepA',name:'c',dateCreated:'2026-11-09 03:00:00',processInfoId:801,processInfoStepId:802}]}
 const transport=async(url,init)=>{
  const body=typeof init.body==='string'?JSON.parse(init.body):undefined,path=url.pathname,method=init.method;calls.push({path,method,body})
  if(path.endsWith('/authAjax'))return response(identity)
  if(path.endsWith('/member/state/independent'))return response({mainApp:'rsq',vt:'fixture',deadLine:options.expired?'2000-01-01 00:00:00':'2100-01-01 00:00:00',usersCount:options.overCapacity?3:1,userLimit:2})
  if(path.endsWith('/function/available'))return response([{funcName:'PLAN',status:'enable'}])
  if(path.endsWith('/authorities/company/current'))return response({})
  if(path==='/task/api/v3/todo/filterCondition')return response({filter})
  if(path.endsWith('/filterList')){assert.equal(method,'PUT');assert.equal(body.startDate,'2026-11-09');return response(state.items)}
  if(path==='/task/v1/kanbanCrud')return response({id:70,name:'fixture',coverId:null,editControl:{editKanbanView:!options.noEdit}})
  if(path==='/task/v1/kanbanChildCrud/list')return response([{id:71,name:'fixture',type:'task'}])
  if(path==='/task/api/plan/view/list')return response(state.views)
  if(path.endsWith('/selectedFilterCondition'))return response({filter:state.filters})
  if(path.endsWith('/filterCondition'))return response({filter:filter.map(f=>({...f,key:'1'}))})
  if(path==='/task/api/plan/view'&&method==='POST'){const item={id:91,name:body.name,showView:body.showView,sort:body.sort,isSelect:true};if(!options.ignoredFilter)state.filters=body.filter;state.views.forEach(v=>v.isSelect=false);state.views.push(item);return response(item)}
  if(path==='/task/api/plan/view'&&method==='GET'){state.views.forEach(v=>v.isSelect=String(v.id)===url.searchParams.get('id'));return response(state.views.find(v=>v.isSelect))}
  if(path==='/task/api/plan/view'&&method==='PUT'){state.views.find(v=>String(v.id)===body.id).name=body.name;return response({...state.views.find(v=>String(v.id)===body.id),showView:null})}
  if(path==='/task/v3/kanbanItemFilter'){if(options.timeout)throw Error('lost acknowledgement');if(!options.ignoredFilter)state.filters=body.filter;return response({})}
  if(path==='/task/api/plan/view/field/list')return response([{name:'基本',list:state.fields}])
  if(path==='/task/api/plan/view/field/selectedList')return response(state.fields)
  if(path==='/task/api/plan/view/field'){state.fields=body.list;return response(null)}
  throw Error('Unexpected '+method+' '+path)
 };return{calls,state,transport}
}
const run=(command,input,f,options={})=>runWorkflow(ctx,flow(command),input,session,{transport:f.transport,approved:true,...options})
test('ARMS commands are packaged executable schemas; all offline plans send zero HTTP',async()=>{
 const f=fixture();for(const item of workflows.workflows.filter(f=>f.executor==='arms-usage')){assert.equal(workflowSchema(item).executable,true);assert.ok(item.examples.length);const input=Object.fromEntries((item.inputSchema.required??[]).map(key=>[key,key.includes('Date')?'2026-11-09':key==='fieldIds'?['taskName']:key==='text'?'text':'71']));if(item.command==='project view update'||item.command==='project template view update')input.name='edited';await runWorkflow(ctx,item,input,null,{dryRun:true,transport:f.transport})}assert.equal(f.calls.length,0)
})
test('todo dayWork classifies flow steps and stable snapshot cursors reject changed rows and queries',async()=>{
 const f=fixture(),input={startDate:'2026-11-09',endDate:'2026-11-09',limit:1};const first=(await run('todo list',input,f)).result
 assert.equal(first.items[0].kind,'workflow-step');assert.deepEqual(first.items[0].target,{command:'workflow instance inspect',processId:'801',stepId:'802'})
 const second=(await run('todo list',{...input,cursor:first.nextCursor},f)).result;assert.equal(second.items[0].id,'taskB')
 f.state.items[1].name='changed';await assert.rejects(run('todo list',{...input,cursor:first.nextCursor},f),e=>e.code==='CONTEXT_CONFLICT')
 assert.ok(f.calls.filter(c=>c.path.endsWith('/filterList')).every(c=>c.method==='PUT'))
})
test('view writes verify actual persistence, selection GET is write, and timeouts do not replay',async()=>{
 const target={projectId:'70',moduleId:'71'},f=fixture(),created=(await run('project view create',{...target,name:'mine',filters:[{key:'1',contentValue:'match',operators:['包含']}]},f)).result
 assert.equal(created.verified,true);const selected=catalog.operations.find(o=>o.method==='GET'&&o.route==='/task/api/plan/view');assert.equal(selected.effect,'write');assert.equal(selected.idempotency,'unknown')
 const noEdit=fixture({noEdit:true});await run('project view select',{...target,viewId:'90'},noEdit);await assert.rejects(run('project view create',{...target,name:'denied'},noEdit),e=>e.code==='FORBIDDEN')
 const ignored=fixture({ignoredFilter:true});await assert.rejects(run('project view create',{...target,name:'ignored',filters:[{key:'1',contentValue:'match',operators:['包含']}]},ignored),e=>e.code==='BUSINESS_ASSERTION_FAILED'&&e.details.resources.viewId==='91')
 const timeout=fixture({timeout:true});await assert.rejects(run('project view update',{...target,viewId:'90',filters:[]},timeout),e=>e.details.writeReplay===false);assert.equal(timeout.calls.filter(c=>c.path==='/task/v3/kanbanItemFilter').length,1)
})
test('expired and over-capacity companies stop before ARMS business reads/writes',async()=>{
 for(const options of[{expired:true},{overCapacity:true}]){const f=fixture(options);await assert.rejects(executeWorkflow(ctx,flow('todo list'),{startDate:'2026-11-09',endDate:'2026-11-09'},session,{transport:f.transport}),e=>['COMPANY_EXPIRED','COMPANY_OVER_CAPACITY'].includes(e.code));assert.equal(f.calls.some(c=>c.path.endsWith('/filterList')),false)}
})
function collaborationFixture(options={}){
 const calls=[],state={comments:[{id:'own',content:'<p>old</p>',creator:{id:81}},{id:'other',content:'<p>other</p>',creator:{id:82}}]},data={datasheet:{id:'dstA',revision:3},datasheetPermission:{permissionMode:options.readOnly?'readOnly':'custom',fieldEditMode:options.readOnly?'readOnly':'manageFields',viewRecordScope:'all',editRecordScope:options.readOnly?'none':'all',viewAccessScope:'all'},snapshot:{datasheetId:'dstA',meta:{fieldMap:{fldA:{id:'fldA',name:'Title',type:3}},views:[]},recordMap:{recA:{id:'recA',data:{fldA:'title'}}}}}
 const r={session,flow:{},resources:{mainProjectId:'70'},identity:async()=>identity,existing:async()=>({records:[{id:'recA'}]}),call:async(method,path,args)=>{calls.push({method,path,args});if(path.endsWith('/dataPack'))return{data};if(path.endsWith('/list'))return structuredClone(state.comments);if(method==='POST'){const item={id:'new',content:args.body.content,creator:{id:81}};state.comments.push(item);return item}if(method==='DELETE'){state.comments=state.comments.filter(row=>row.id!==args.query.id);return null}throw Error('Unexpected collaboration request')}}
 return{r,calls,state}
}
test('weak record-comment delete API is guarded by row context, edit permission and actual author',async()=>{
 const target={projectId:'70',datasheetId:'dstA',recordId:'recA'},f=collaborationFixture()
 await assert.rejects(runRecordCollaboration(f.r,'record-comment-remove',{...target,commentId:'other'}),e=>e.code==='FORBIDDEN');assert.equal(f.calls.some(c=>c.method==='DELETE'),false)
 const created=await runRecordCollaboration(f.r,'record-comment-add',{...target,text:'<secret>\nnext'});assert.equal(created.comment.content,'<p>&lt;secret&gt;<br>next</p>');assert.equal(created.verified,true)
 const removed=await runRecordCollaboration(f.r,'record-comment-remove',{...target,commentId:'new'});assert.equal(removed.verified,true);assert.ok(f.state.comments.every(row=>row.id!=='new'))
 const readonly=collaborationFixture({readOnly:true});await assert.rejects(runRecordCollaboration(readonly.r,'record-comment-add',{...target,text:'denied'}),e=>e.code==='FORBIDDEN');assert.equal(readonly.calls.some(c=>c.method==='POST'),false)
})
test('child workflow start binds actual parent step, configured app and independent relation',async()=>{
 const calls=[],parent={id:501,status:'doing',flowAppId:101,steps:[{id:601,originId:201,stepType:'childProcess',status:'doing',detail:{editControl:{fillStepForm:true}}}]},r={flow:{},session,resources:{},identity:async()=>identity,existing:async command=>command==='workflow instance inspect'?parent:{application:{id:102,mode:0,editControl:{initProcess:true}}},call:async(method,path,input)=>{calls.push({method,path,input});if(path.endsWith('/step/config'))return{code:200,data:{childProcessMode:1,singleApplicationInfo:{id:102}}};if(path.endsWith('/start'))return{code:200,data:{id:701}};if(path.endsWith('/processInfo/list'))return{code:200,data:[{id:701}]};if(path.endsWith('/details'))return{code:200,data:{id:701,flowAppId:102,name:'child'}};throw Error(path)}}
 const result=await runWorkflowDiscovery(r,'workflow-child-start',{processId:'501',stepId:'601',applicationId:'102',name:'child'});assert.equal(result.relationVerified,true)
 assert.deepEqual(calls.find(c=>c.path.endsWith('/start')).input.body,{applicationId:'102',name:'child',userId:'81',fromWhere:'childProcessStep',fromId:'501_601'})
 calls.length=0;await assert.rejects(runWorkflowDiscovery(r,'workflow-child-start',{processId:'501',stepId:'201',applicationId:'102',name:'child'}),e=>e.code==='FORBIDDEN');assert.equal(calls.length,0)
 await assert.rejects(runWorkflowDiscovery(r,'workflow-child-start',{processId:'501',stepId:'601',applicationId:'103',name:'child'}),e=>e.code==='FORBIDDEN');assert.equal(calls.some(c=>c.path.endsWith('/start')),false)
})
test('embedded workflow discovery uses PLAN_WORKFLOW and rejects applications outside the actual project',async()=>{
 const calls=[];let wrongModule=false
 const transport=async(url,init)=>{
  calls.push(url.pathname)
  if(url.pathname.endsWith('/authAjax'))return response(identity)
  if(url.pathname.endsWith('/member/state/independent'))return response({mainApp:'rsq',vt:'fixture',deadLine:'2100-01-01 00:00:00',usersCount:1,userLimit:2})
  if(url.pathname.endsWith('/function/available'))return response([{funcName:'PLAN',status:'enable'},{funcName:'PLAN_WORKFLOW',status:'enable'},{funcName:'WORKFLOW',status:'disable'}])
  if(url.pathname.endsWith('/authorities/company/current'))return response({})
  if(url.pathname==='/task/v1/kanbanCrud')return response({id:70,coverId:null})
  if(url.pathname==='/task/v1/kanbanChildCrud/list')return response([{id:71,name:'flow',type:'workflow',flowApplicationId:wrongModule?102:101}])
  if(url.pathname==='/task/workflow/application')return response({code:200,data:{id:101,name:'embedded',mode:0,workflowModuleSubType:'projectWorkflow'}})
  if(url.pathname==='/task/workflow/form/list'||url.pathname.endsWith('/recursive/tree/list'))return response({code:200,data:[]})
  if(url.pathname.endsWith('/sheet/list'))return response({code:200,data:[{id:501,name:'mine',flowAppId:101,statusName:'进行中'}]})
  throw Error(url.pathname)
 }
 const options={transport,approved:true}
 await assert.rejects(executeWorkflow(ctx,flow('workflow instances list'),{applicationId:'101'},session,options),e=>e.code==='FEATURE_DISABLED')
 const result=(await executeWorkflow(ctx,flow('project workflow instances list'),{projectId:'70',applicationId:'101'},session,options)).result;assert.equal(result.items[0].id,'501')
 wrongModule=true;calls.length=0;await assert.rejects(executeWorkflow(ctx,flow('project workflow instances list'),{projectId:'70',applicationId:'101'},session,options),e=>e.code==='FORBIDDEN');assert.equal(calls.includes('/task/workflow/application'),false)
})
