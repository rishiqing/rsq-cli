import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CookieJar } from 'tough-cookie'
import { workflows,runWorkflow } from '../dist/workflows.js'
import { executeWorkflow,executeOperation } from '../dist/dispatch.js'
import { catalog } from '../dist/operations.js'
import { docDelta,validateDocWorkflow } from '../dist/doc-context.js'
import { docCommentContent } from '../dist/doc-comments.js'
const jar = new CookieJar()
jar.setCookieSync('JSESSIONID=fixture; Secure; Path=/', 'https://www.rishiqing.com')
const ctx = { environment: 'production',profile: 'fixture' },session = { version: 1,method: 'password',accessToken: 'fixture',identity: { userId: '81',teamId: '7',username: 'fixture' },expiresAt: Date.now()+3600000,cookies:jar.serializeSync() }
const root = '/task/v1/corpus',base = root+'/summary',tpl = root+'/templateSummary',json = value => new Response(JSON.stringify(value),{ headers: { 'content-type': 'application/json' } })
const body = { ops: [{ insert: '中文\n',attributes: { header: 2 } },{ insert: { custom: { id: '9007199254740993123',url: 'https://example.invalid/never-fetch' } } },{ insert: '\n' }] }
const fullPermissions = { createNote: true,createNoteBook: true,editCorpusInfo: true,editCorpusPreferences: true,editCorpusAttribute: true,removeCorpus: true,editNoteBook: true,removeNoteBook: true,editNote: true,removeNote: true,copyNote: true,moveNote: true,commentNote: true }
function fixture(options = {}) {
 let next = 10000
 const spaces = new Map([['101',{ id: 101,name: '文集',type: options.retired ? 'week' : 'essays',creatorId: 81,attribute: 'company',isStar: false,corpusGroupId: null,canBeShared: true,showsView: 'list',sort: 'default',editControl: { ...fullPermissions,...options.permissions } }],['102',{ id: 102,name: '目标文集',type: 'essays',creatorId: 81,attribute: 'company',corpusGroupId: null,editControl: { ...fullPermissions } }]])
 const docs = new Map(),contents = new Map(),templates = new Map([['normal-911',{ id: 'normal-911',name: '系统模板',type: 'normal-800' }],['company-912',{ id: 'company-912',name: '公司模板',type: 'company' }]]),comments = new Map(),calls = []
 contents.set('normal-911',structuredClone(body));contents.set('company-912',structuredClone(body))
 const add = (id='9007199254740993123',properties={}) => { const row = { id,name: '初始文档',isNoteBook: false,corpusId: '101',noteBookId: null,creator: { id: 81,showName: '当前用户' },isDisplay: true,isReditor: true,editControl: { ...fullPermissions,...options.permissions },...properties };docs.set(String(row.id),row);contents.set('normal-'+row.id,structuredClone(body));return row }
 add('201',{ isNoteBook: true,name: '目录' });add('202',{ isNoteBook: true,name: '子目录',noteBookId: '201' });add(undefined,{ noteBookId: '202' })
 const f = { calls,spaces,docs,contents,templates,comments,add,transport: async (url,init) => {
  const path = url.pathname,method = init.method,q=Object.fromEntries(url.searchParams),data = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ path,method,query: q,body: data,headers: Object.fromEntries(new Headers(init.headers)) })
  if (path.endsWith('/authAjax')) return json({ success: true,id: options.changedIdentity ? 82 : 81,username: 'fixture',token: 'private',team: { id: 7,name: 'fixture' } })
  if (path.endsWith('/authorities/company/current')) return json({ createCorpus: !options.noCreate,editNoteTemp: !options.noCompanyTemplate,useCorpus: true })
  if (path.endsWith('/member/state/independent')) return json({ deadLine: options.expired ? '2000-01-01 00:00:00' : '2100-01-01 00:00:00',usersCount: options.overCapacity ? 3 : 1,userLimit: 2,mainApp: 'rsq',vt: 'enterprise' })
  if (path.endsWith('/function/available')) return json([{ funcName: 'KNOWLEDGE',status: options.disabled ? 'disable' : 'enable' }])
  if (path === '/task/v1/corpusGroup/list') return json([{ id: 'all',name: '全部文集',displayOrder: 0,checked: true,corpusCount: 2 },{ id: 301,name: '分组',displayOrder: 1,checked: false,corpusCount: 0 }])
  if (path === root+'/list') return json([...spaces.values()])
  if (path === root && method === 'POST') { const row = { id: ++next,name: data.name,type: data.type,creatorId: 81,attribute: 'company',corpusGroupId: data.corpusGroupId ?? null,canBeShared: true,editControl: { ...fullPermissions } };spaces.set(String(row.id),row);return json(row) }
  const space = /^\/task\/v1\/corpus\/([0-9]+)$/.exec(path)
  if (space) { const row = spaces.get(space[1]);assert.ok(row);if (method === 'GET') return json(row);if (method === 'PUT') { if (!options.ignoredWrite) Object.assign(row,data);return json(row) }if (method === 'DELETE') { spaces.delete(space[1]);for (const [id,doc] of docs) if (String(doc.corpusId) === space[1]) docs.delete(id);return new Response(null,{ status: 204 }) } }
  if (path === base+'/list') { const parent = q.noteBookId ? docs.get(q.noteBookId) : undefined;assert.ok(!q.noteBookId || parent?.isNoteBook);assert.equal(q.allData,'true');const rows = [...docs.values()].filter(doc => String(doc.corpusId) === (parent ? String(parent.corpusId) : q.corpusId) && (doc.noteBookId == null ? !q.noteBookId : String(doc.noteBookId) === q.noteBookId));return json(options.foreignTree ? rows.map(row => ({ ...row,corpusId: '999' })) : rows) }
  if (path === base+'/draftList') { assert.ok(+q.max >= 1 && +q.max <= 50);const rows = [...docs.values()].filter(row => row.corpusId == null).sort((a,b) => String(a.id).localeCompare(String(b.id))).filter(row => !q.lastId || String(row.id) > q.lastId).slice(0,+q.max).map(row => ({ id: row.id,name: row.name,brief: '' }));return json(rows) }
  if (path === base+'/authority') return json({ auth: fullPermissions,status: options.noPreview ? 'noPreview' : options.deleted ? 'docDelete' : '' })
  if (path === base && method === 'GET') { const row = docs.get(q.id);assert.ok(row && !row.isNoteBook);return json(options.foreignDetail ? { ...row,corpusId: '999' } : row) }
  if (path === base && method === 'POST') { const parent = data.noteBookId ? docs.get(data.noteBookId) : undefined;const row = add(String(++next),{ name: data.name,isNoteBook: data.isNoteBook,corpusId: parent ? parent.corpusId : data.corpusId ?? null,noteBookId: data.noteBookId ?? null });contents.set('normal-'+row.id,data.note ? JSON.parse(data.note) : { ops: [] });if (options.unknownCreate) return json({ id: row.id,isNoteBook: 'invalid' });return json(row) }
  const doc = /^\/task\/v1\/corpus\/summary\/([0-9]+)$/.exec(path)
  if (doc) { const row = docs.get(doc[1]);assert.ok(row);if (method === 'PUT') { if (options.timeout) throw Error('connection lost');if (!options.ignoredWrite) Object.assign(row,data);return json(row) }if (method === 'DELETE') { const removed = new Set([doc[1]]);let count=0;while(count!==removed.size) {count=removed.size;for(const [id,row] of docs) if(removed.has(String(row.noteBookId))) removed.add(id)}for(const id of removed) docs.delete(id);return new Response(null,{ status: 204 }) } }
  if (path === base+'/draftToSummary') { const row = docs.get(data.draftId),parent = data.noteBookId ? docs.get(data.noteBookId) : undefined;assert.equal(row.corpusId,null);row.corpusId = parent?.corpusId ?? data.corpusId;row.noteBookId = data.noteBookId ?? null;return json(row) }
  if (path === base+'/copy' || path === base+'/move') { if(options.moveConflict && path.endsWith('/move')) return json({hasNoteWithSameDate:true});const row = docs.get(data.id),parent = data.noteBookId ? docs.get(data.noteBookId) : undefined,targetId = path.endsWith('/copy') ? String(++next) : data.id;const target = structuredClone(row);Object.assign(target,{ id: targetId,corpusId: parent?.corpusId ?? data.corpusId,noteBookId: data.noteBookId ?? null });docs.set(targetId,target);contents.set('normal-'+targetId,structuredClone(contents.get('normal-'+data.id)));return json(path.endsWith('/move') ? {hasNoteWithSameDate:false} : target) }
  if (path === '/task/v1/department/list') return json([{ id: '101',name: '当前公司',parentId: null,type: 'top',displayOrder: 1,childList: [],userList: [{ id: '81',showName: '当前用户' },{ id: '82',showName: '<成员 & "昵称">' }] }])
  if (path === base+'/comments') return json([...(comments.get(q.id) ?? [])])
  if (path === base+'/comment' && method === 'POST') { if(options.commentTimeout) throw Error('Unknown write outcome');const row = { id: ++next,content: data.content,creator: { id: 81 },dateCreated: '2026.11.08 12:00:00' };if (!options.ignoreCommentWrite) comments.set(data.noteId,[...(comments.get(data.noteId) ?? []),row]);return json(row) }
  const comment = /^\/task\/v1\/corpus\/summary\/comment\/([0-9]+)$/.exec(path)
  if (comment) { for (const [id,rows] of comments) comments.set(id,rows.filter(row => String(row.id) !== comment[1]));return new Response(null,{ status: 204 }) }
  if (path === tpl+'/list') return json([...templates.values()])
  if (path === tpl+'/getTemplateDelta') { assert.ok(contents.has(q.id),q.id);return json({ templateDelta: JSON.stringify(contents.get(q.id).ops) }) }
  if (path === '/task/reditor/client/resource/get-delta') { assert.equal(q.type,'doc');assert.ok(docs.has(q.id));return json(options.invalidEditorResponse ? { data: [] } : contents.get('normal-'+q.id).ops) }
  if (path === tpl && method === 'POST' || path === tpl+'/noteToTemplate') { const scope = data?.type ?? q.type,id = scope+'-'+(++next),row = { id,name: data?.name ?? docs.get(q.id).name,type: scope };templates.set(id,row);contents.set(id,data?.note ? JSON.parse(data.note) : structuredClone(contents.get('normal-'+q.id)));return json(row) }
  const template = /^\/task\/v1\/corpus\/templateSummary\/((?:my|company|normal)-[0-9]+)$/.exec(path)
  if (template) { const row = templates.get(template[1]);assert.ok(row);if (method === 'PUT') { if (!options.ignoredWrite) row.name=data.name;return json(row) }if (method === 'DELETE') { templates.delete(template[1]);return new Response(null,{ status: 204 }) } }
  throw Error('unexpected '+method+' '+path+' '+url.search)
 } };return f
}
const flow = command => { const item=workflows.workflows.find(flow=>flow.command===command);assert.ok(item,command);return item },run = async (command,input,f,options={}) => runWorkflow(ctx,flow(command),input,session,{ transport: f.transport,approved: true,...options })
test('rcode HTTP body reader verifies visible document context before fetching a complete Delta snapshot',async()=>{
 const input={spaceId:'101',id:'9007199254740993123'},f=fixture()
 const result=(await run('doc body get',input,f)).result
 assert.deepEqual(result.content,body);assert.match(result.contentHash,/^[a-f0-9]{64}$/)
 assert.equal(f.calls.filter(call=>call.path==='/task/reditor/client/resource/get-delta').length,1)
 assert.ok(!f.calls.some(call=>call.path===tpl+'/getTemplateDelta'))
 for(const option of ['noPreview','deleted','foreignTree','foreignDetail','retired']){const denied=fixture({[option]:true});await assert.rejects(run('doc body get',input,denied));assert.ok(!denied.calls.some(call=>call.path==='/task/reditor/client/resource/get-delta'))}
 const invalid=fixture({invalidEditorResponse:true});await assert.rejects(run('doc body get',input,invalid),{code:'RESPONSE_SCHEMA_MISMATCH'})
 const raw=catalog.operations.find(op=>op.route==='/task/reditor/client/resource/get-delta');const offline=fixture()
 await assert.rejects(executeOperation(ctx,raw,{query:{type:'doc',id:input.id}},session,{transport:offline.transport}),{code:'BUSINESS_CONTEXT_REQUIRED'});assert.equal(offline.calls.length,0)
})
test('knowledge HTTP closure resolves nested context, creates real initial Delta, and preserves content through copy/move',async()=>{
 const f=fixture(),space=(await run('doc space create',{ name:'新文集',groupId:'301' },f)).result.space;assert.equal(space.creatorId,'81')
 const folder=(await run('doc folder create',{ spaceId:space.id,name:'新目录' },f)).result.folder
 const doc=(await run('doc create',{ spaceId:space.id,folderId:folder.id,name:'正文',content:body },f)).result
 assert.deepEqual(doc.content,body);const input={spaceId:space.id,id:doc.document.id}
 assert.deepEqual((await run('doc inspect',input,f)).result.content,body)
 await run('doc rename',{...input,name:'中文重命名'},f);assert.deepEqual(f.contents.get('normal-'+doc.document.id),body)
 const copied=(await run('doc copy',{...input,destinationSpaceId:'102'},f)).result;assert.notEqual(copied.document.id,input.id)
 const moved=(await run('doc move',{...input,destinationSpaceId:'101',destinationFolderId:'202'},f)).result;assert.equal(moved.document.id,input.id);assert.equal(moved.document.noteBookId,'202')
 await run('doc folder rename',{spaceId:space.id,id:folder.id,name:'目录更名'},f)
 await run('doc remove',{spaceId:'102',id:copied.document.id},f);assert.ok(!f.docs.has(copied.document.id))
 await run('doc space update',{spaceId:space.id,patch:{canBeShared:false,showsView:'sidebar'}},f);assert.equal(f.spaces.get(space.id).canBeShared,false)
 await run('doc space remove',{spaceId:space.id},f);assert.ok(!f.spaces.has(space.id))
 const reads=f.calls.filter(call=>call.path===base+'/list');assert.ok(reads.length>10);assert.ok(reads.every(call=>call.query.allData==='true'))
 assert.ok(f.calls.every(call=>!call.path.includes('reditor')))
})
test('drafts publish with the same full content and templates have independent actual composite IDs',async()=>{
 const f=fixture(),draft=(await run('doc draft new',{name:'草稿',content:body},f)).result.document
 assert.equal((await run('doc drafts list',{},f)).result.drafts.length,1)
 await run('doc draft rename',{id:draft.id,name:'已改名'},f);assert.deepEqual((await run('doc draft inspect',{id:draft.id},f)).result.content,body)
 const published=(await run('doc draft publish',{id:draft.id,spaceId:'101',folderId:'202'},f)).result;assert.equal(published.document.corpusId,'101');assert.deepEqual(published.content,body);assert.equal((await run('doc drafts list',{},f)).result.drafts.length,0)
 const template=(await run('doc template create',{name:'模板',content:body,scope:'my'},f)).result.template;assert.match(template.id,/^my-/)
 await run('doc template rename',{templateId:template.id,name:'模板更名'},f);assert.deepEqual((await run('doc template inspect',{templateId:template.id},f)).result.content,body)
 const applied=(await run('doc template apply',{templateId:template.id,spaceId:'101',folderId:'201',name:'模板生成'},f)).result;assert.deepEqual(applied.content,body);assert.notEqual(applied.document.id,published.document.id)
 const saved=(await run('doc template save',{spaceId:'101',id:applied.document.id,scope:'my'},f)).result;assert.notEqual(saved.template.id,template.id);assert.equal(saved.template.name,'模板生成')
 await run('doc template remove',{templateId:template.id},f);assert.ok(!f.templates.has(template.id))
 const another=(await run('doc draft new',{name:'待删除',content:''},f)).result.document;await run('doc draft remove',{id:another.id},f);assert.ok(!f.docs.has(another.id))
 assert.ok(f.calls.some(call=>call.path===tpl+'/noteToTemplate'&&call.method==='GET'))
})
test('comments bind the actual document and creator; folder deletion verifies every visible descendant',async()=>{
 const f=fixture(),target={spaceId:'101',id:'9007199254740993123'}
 const created=(await run('doc comment create',{...target,text:'<标签> & 中文\n第二行'},f)).result
 assert.equal(created.comments[0].content,'<p>&lt;标签&gt; &amp; 中文<br>第二行</p>')
 f.comments.get(target.id).push({id:9,content:'他人评论',creator:{id:82}})
 await assert.rejects(run('doc comment remove',{...target,commentId:'9'},f),{code:'RESOURCE_FORBIDDEN'})
 await run('doc comment remove',{...target,commentId:created.commentId},f);assert.equal(f.comments.get(target.id).length,1)
 const result=(await run('doc folder remove',{spaceId:'101',id:'201'},f)).result;assert.equal(result.folder.affectedVisibleIds.length,3);assert.equal(f.docs.size,0)
})
test('document comment context and reply resolve actual current-company members and departments without a browser',async()=>{
 const f=fixture(),target={spaceId:'101',id:'9007199254740993123'}
 f.comments.set(target.id,[{id:'9',content:'原评论',creator:{id:'82'}}])
 const context=(await run('doc comments context',target,f)).result
 assert.equal(context.members.length,2);assert.equal(context.departments[0].id,'101');assert.match(context.replyProtocol,/no-server-thread/)
 const reply=(await run('doc comment reply',{...target,replyTo:'9',mentionIds:['82'],mentionDepartmentIds:['101'],text:'<正文> & 中文\r\n下一行'},f)).result
 const sent=f.calls.find(call=>call.path===base+'/comment'&&call.method==='POST').body
 assert.equal(sent.atIds,'82');assert.equal(sent.atDeptIds,'101');assert.equal(sent.atType,'')
 assert.match(sent.content,/data-at-category="people"/);assert.match(sent.content,/data-department-id="101"/)
 assert.match(sent.content,/@&lt;成员 &amp; &quot;昵称&quot;&gt;/);assert.match(sent.content,/&lt;正文&gt; &amp; 中文<br>下一行/)
 assert.ok(!sent.content.includes('<正文>'));assert.ok(!sent.replyTo);assert.equal(reply.comments.length,2)
 assert.ok(flow('doc comment reply').capabilities.includes('doc/comments'))
})
test('document comment reply rejects unknown comments and foreign/departed members before writing; permissions and known IDs survive failures',async()=>{
 const target={spaceId:'101',id:'9007199254740993123'}
 for(const input of [{replyTo:'999'},{mentionIds:['999']},{mentionDepartmentIds:['999']},{replyTo:'9'}]) {
  const f=fixture();f.comments.set(target.id,[{id:'9',content:'离职成员',creator:{id:'999'}}])
  await assert.rejects(run('doc comment create',{...target,text:'测试',...input},f),{code:'INVALID_INPUT'});assert.ok(!f.calls.some(call=>call.path===base+'/comment'&&call.method==='POST'))
 }
 const denied=fixture({permissions:{commentNote:false}});await assert.rejects(run('doc comment create',{...target,text:'测试'},denied),{code:'RESOURCE_FORBIDDEN'});assert.ok(!denied.calls.some(call=>call.method==='POST'))
 const ignored=fixture({ignoreCommentWrite:true});await assert.rejects(run('doc comment create',{...target,text:'测试'},ignored),error=>error.code==='BUSINESS_ASSERTION_FAILED'&&/^[1-9][0-9]*$/.test(error.details.resources.commentId));assert.equal(ignored.calls.filter(call=>call.path===base+'/comment'&&call.method==='POST').length,1)
 const timeout=fixture({commentTimeout:true});await assert.rejects(run('doc comment create',{...target,text:'测试'},timeout),error=>error.code==='NETWORK_ERROR'&&error.details.writeOutcome==='unknown-do-not-retry');assert.equal(timeout.calls.filter(call=>call.path===base+'/comment'&&call.method==='POST').length,1)
})
test('document mentions use actual WeCom open-data markup and reject malformed pure text or duplicate IDs locally',()=>{
 const directory=[{id:'101',name:'department-openid',type:'top',childList:[],userList:[{id:'81',showName:'member-openid'}]}]
 const out=docCommentContent({text:'正文',mentionIds:['81'],mentionDepartmentIds:['101']},directory,[],{...session,method:'wecom'})
 assert.match(out.content,/<ww-open-data type="userName" openid="member-openid">/);assert.match(out.content,/<ww-open-data type="departmentName" openid="department-openid">/)
 assert.equal(out.atIds,'81');assert.equal(out.atDeptIds,'101')
 for(const input of [{text:'\u0000内容'},{text:' '},{text:'正文',mentionIds:['81','81']}]) assert.throws(()=>docCommentContent(input,directory,[],session),{code:'INVALID_INPUT'})
})
test('current visibility, preview permission, company scope and UI restrictions stop writes before unsafe requests',async()=>{
 const target={spaceId:'101',id:'9007199254740993123'}
 for(const options of [{noPreview:true},{deleted:true},{foreignTree:true},{foreignDetail:true},{retired:true}]){const f=fixture(options);await assert.rejects(run('doc inspect',target,f));assert.ok(!f.calls.some(call=>call.path===tpl+'/getTemplateDelta'))}
 const missing=fixture();await assert.rejects(run('doc inspect',{...target,spaceId:'999'},missing),{code:'RESOURCE_NOT_VISIBLE'});assert.ok(!missing.calls.some(call=>call.path===base))
 const role=fixture({permissions:{editNote:false,createNote:false,copyNote:false}});await assert.rejects(run('doc rename',{...target,name:'不允许'},role),{code:'RESOURCE_FORBIDDEN'});assert.ok(!role.calls.some(call=>call.method==='PUT'))
 const foreignDraft=fixture();await assert.rejects(run('doc draft inspect',{id:target.id},foreignDraft),{code:'INVALID_INPUT'})
 for(const command of ['doc template rename','doc template remove']){const f=fixture();await assert.rejects(run(command,{templateId:'normal-911',...(command.endsWith('rename')?{name:'不允许'}:{})},f),{code:'RESOURCE_FORBIDDEN'})}
 const company=fixture({noCompanyTemplate:true});await assert.rejects(run('doc template create',{name:'企业',content:'',scope:'company',companyId:'7'},company),{code:'RESOURCE_FORBIDDEN'});assert.ok(!company.calls.some(call=>call.method==='POST'))
 await assert.rejects(run('doc template rename',{templateId:'company-912',companyId:'8',name:'跨公司'},fixture()),{code:'INVALID_INPUT'})
 const conflict=fixture({moveConflict:true});await assert.rejects(run('doc move',{...target,destinationSpaceId:'102'},conflict),{code:'CONTEXT_CONFLICT'});assert.equal(conflict.calls.filter(call=>call.path===base+'/move').length,1);assert.ok(!conflict.calls.some(call=>call.body?.overRide))
 for(const [option,code] of [['expired','COMPANY_EXPIRED'],['overCapacity','COMPANY_OVER_CAPACITY'],['disabled','FEATURE_DISABLED']]){const f=fixture({[option]:true});await assert.rejects(executeWorkflow(ctx,flow('doc create'),{spaceId:'101',name:'不应创建',content:'x'},session,{transport:f.transport}),{code});assert.ok(!f.calls.some(call=>call.path===root+'/list'||call.method==='POST'))}
})
test('unknown writes retain assigned IDs, ignored writes fail readback, and neither retries or silently rolls back',async()=>{
 const unknown=fixture({unknownCreate:true});await assert.rejects(run('doc create',{spaceId:'101',name:'已创建',content:'x'},unknown),error=>error.details.writeOutcome==='unknown-do-not-retry'&&/^\d+$/.test(error.details.resources.documentId));assert.equal(unknown.calls.filter(call=>call.path===base&&call.method==='POST').length,1)
 const timeout=fixture({timeout:true});await assert.rejects(run('doc rename',{spaceId:'101',id:'9007199254740993123',name:'未知'},timeout),error=>error.code==='NETWORK_ERROR'&&error.details.resources.documentId==='9007199254740993123'&&error.details.writeOutcome==='unknown-do-not-retry');assert.equal(timeout.calls.filter(call=>call.method==='PUT').length,1)
 const ignored=fixture({ignoredWrite:true});await assert.rejects(run('doc rename',{spaceId:'101',id:'9007199254740993123',name:'被忽略'},ignored),{code:'BUSINESS_ASSERTION_FAILED'});assert.equal(ignored.calls.filter(call=>call.method==='PUT').length,1)
 const offline=fixture();const plan=await run('doc create',{spaceId:'101',name:'离线',content:body},offline,{dryRun:true});assert.equal(plan.dryRun,true);assert.equal(offline.calls.length,0);assert.ok(plan.steps.some(step=>step.context==='resolve-from-verified-http-context'))
 await assert.rejects(run('doc remove',{spaceId:'101',id:'9007199254740993123'},offline,{approved:false}),{code:'CONFIRMATION_REQUIRED'});assert.equal(offline.calls.length,0)
 const raw=catalog.operations.find(op=>op.method==='GET'&&op.route===tpl+'/getTemplateDelta');await assert.rejects(executeOperation(ctx,raw,{query:{id:'normal-9007199254740993123'}},session,{transport:offline.transport}),{code:'BUSINESS_CONTEXT_REQUIRED'});assert.equal(offline.calls.length,0)
})
test('full snapshots reject OT increments, unsafe JSON, malformed context contracts and invalid actions',()=>{
 for(const value of [{ops:[{retain:1}]},{ops:[{insert:'x',delete:1}]},JSON.parse('{"ops":[{"insert":{"x":{"__proto__":{}}}}]}'),{ops:[{insert:NaN}]}])assert.throws(()=>docDelta(value),{code:'INVALID_INPUT'})
 assert.deepEqual(docDelta('中文'),{ops:[{insert:'中文\n'}]});assert.deepEqual(docDelta(''),{ops:[]})
 const f=structuredClone(flow('doc inspect'));f.docAction='unknown';assert.throws(()=>validateDocWorkflow(f),{code:'INVALID_CONTRACT'})
 const g=structuredClone(flow('doc create'));g.steps[0].input={query:{id:'1'}};assert.throws(()=>validateDocWorkflow(g),{code:'INVALID_CONTRACT'})
 const h=structuredClone(flow('doc folder create'));h.steps.find(step=>step.id==='changed').operationId=flow('doc create').steps.find(step=>step.id==='changed').operationId;assert.throws(()=>validateDocWorkflow(h),{code:'INVALID_CONTRACT'})
})
