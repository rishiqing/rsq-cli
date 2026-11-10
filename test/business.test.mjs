import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {catalog,flagValue,runOperation} from '../dist/operations.js'
import {businessCoverage} from '../dist/business.js'
const read=name=>JSON.parse(readFileSync(new URL('../contracts/'+name,import.meta.url)))

test('coverage separates reviewed transport contracts from executable raw commands and contextual adapters',()=>{
 const result=businessCoverage().operationAudit, reviewed=catalog.operations.filter(o=>o.review==='reviewed')
 assert.equal(result.reviewedContracts,reviewed.length)
 assert.equal(result.executable,reviewed.filter(o=>!o.requiresBusinessContext?.length).length)
 assert.equal(result.requiresBusinessContext,reviewed.filter(o=>o.requiresBusinessContext?.length).length)
 assert.equal(result.executable+result.requiresBusinessContext,result.reviewedContracts)
 assert.ok(result.requiresBusinessContext>0)
})

test('Spring reads using PUT/POST remain read operations; irreversible writes require confirmation',()=>{
 for(const route of ['/task/execution/v2/item/list','/task/review/replay/commitStatus/list']){
  const op=catalog.operations.find(o=>o.route===route&&o.review==='reviewed')
  assert.ok(op,route);assert.equal(op.effect,'read',op.command)
 }
 const initializing=catalog.operations.find(o=>o.route==='/task/execution/v2/group/list');assert.equal(initializing.effect,'write');assert.equal(initializing.idempotency,'unknown')
 for(const route of ['/task/performance/appraisal/score','/task/replay-intelligence/replay/push/rule/test-send']){
  const op=catalog.operations.find(o=>o.route===route&&o.review==='reviewed')
  assert.ok(op,route);assert.equal(op.effect,'destructive',op.command)
 }
 for(const route of ['/task/performance/appraisals/score','/task/workflow/statistics/execute','/task/okr/objective/type/scope/list'])assert.equal(catalog.operations.find(o=>o.method==='GET'&&o.route===route).effect,'read',route)
 for(const route of ['/task/okr/approval/commit','/task/okr/approval/revoke'])assert.equal(catalog.operations.find(o=>o.method==='POST'&&o.route===route).effect,'destructive',route)
 const copy=catalog.operations.find(o=>o.route==='/task/workflow/form/form/copy')
 assert.equal(copy.effect,'write');assert.equal(copy.idempotency,'unknown')
})

test('successful OKR deletion accepts the server null response without hiding a returned objective',async()=>{
 const op=catalog.operations.find(o=>o.route==='/task/okr/objective'&&o.method==='DELETE')
 assert.equal(op.response,'json-or-empty')
 const session={method:'password',identity:{userId:'1',username:'fixture'},accessToken:'fixture',expiresAt:Date.now()+60000}
 assert.equal(await runOperation({environment:'production',profile:'fixture'},op,{query:{id:'1'}},session,{approved:true,transport:async()=>new Response('')}),null)
 const unchanged={id:'1',name:'objective retained by server'}
 assert.deepEqual(await runOperation({environment:'production',profile:'fixture'},op,{query:{id:'1'}},session,{approved:true,transport:async()=>new Response(JSON.stringify(unchanged))}),unchanged)
})

test('flags accept referenced DTO objects and nullable booleans without losing long IDs',()=>{
 const field={option:'filter',schema:{$ref:'#/$defs/Filter'}}
 assert.deepEqual(flagValue(field,'{"name":"example"}',{$defs:{Filter:{type:'object'}}}),{name:'example'})
 assert.equal(flagValue({option:'show',schema:{type:['boolean','null']}},'false'),false)
 assert.equal(flagValue({option:'id',schema:{type:['integer','string']}},'9007199254740993'),'9007199254740993')
})

test('workflow insertion constraints fail locally and Spring repeated arrays retain each ID',async()=>{
 const op=catalog.operations.find(o=>o.command==='workflow group create')
 const ctx={environment:'production',profile:'fixture'}
 await assert.rejects(runOperation(ctx,op,{body:{name:'example'}},null,{dryRun:true}),{code:'INVALID_INPUT'})
 assert.equal((await runOperation(ctx,op,{body:{name:'example',frontId:'1',nextId:'2'}},null,{dryRun:true})).dryRun,true)
 const session={method:'password',identity:{userId:'1',username:'fixture'},accessToken:'private-fixture',expiresAt:Date.now()+60000}
 await runOperation(ctx,{...op,method:'GET',queryArray:'repeat',inputSchema:{type:'object'},response:'text',responseSchema:{type:'string'}},{query:{ids:['1','9007199254740993']}},session,{transport:async(url,init)=>{
  assert.deepEqual(url.searchParams.getAll('ids'),['1','9007199254740993']);assert.equal(init.body,undefined)
  return new Response('plain Spring text')
 }})
})
