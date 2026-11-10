import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile,access } from 'node:fs/promises'
import { workflows,runWorkflow } from '../dist/workflows.js'
import { catalog } from '../dist/operations.js'
import { executeOperation } from '../dist/dispatch.js'
import { validateMinderDocument,readMinderContent,minderRevision } from '../dist/minder.js'
import { collectIndexedPages } from '../dist/pagination.js'
const ctx = { environment: 'production',profile: 'fixture' },session = { version: 1,method: 'password',accessToken: 'fixture',identity: { userId: '81',teamId: '7' },expiresAt: Date.now()+3600000 }
const json = value => new Response(JSON.stringify(value),{ headers: { 'content-type': 'application/json' } })
const doc = { root: { data: { text: '根节点',id: 'root',note: '备注\n中文',hyperlink: 'https://example.com/' },children: [{ data: { text: '子项',id: 'child',progress: 0 },children: [] }] },template: 'default',theme: 'fresh-blue',version: '1.4.43' }
function fixture(options = {}) {
  const records = [],objects = new Map(),calls = [],transfers = [];let next = 1,tick = 0
  const urlFor = row => 'https://www.rishiqing.com/task/v1/folder/file/fileMindMapUrl?signature=private-'+row.id
  const row = id => ({ id,creatorId: options.foreign ? '82' : '81',name: '原始.km',path: 'file/'+id+'.km',fileSize: Buffer.byteLength(JSON.stringify(doc)),extName: 'km',lastUpdated: '2026-11-08 12:00:00',isOnlyCreatorCanEdit: false })
  const add = (id = '9007199254740993123') => { const record = row(id);records.push(record);objects.set(record.path,structuredClone(doc));return record }
  if (options.initial !== false) add()
  const recycled = [],deleted = new Map()
  const f = { calls,records,objects,transfers,add,uploadTransfer: async (_certificate,file,progress) => {
    const bytes = await readFile(file.path);transfers.push(file.path);const path = 'file/upload-'+(++tick)+'.km';objects.set(path,JSON.parse(bytes));progress({ objectPath: path });return { path,size: bytes.length,md5: file.md5,mode: 'put' }
  },transport: async (url,init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;calls.push({ origin: url.origin,path: url.pathname,query: Object.fromEntries(url.searchParams),method: init.method,headers: Object.fromEntries(new Headers(init.headers)),body })
    if (url.pathname.endsWith('/authAjax')) return json({ success: true,id: 81,username: 'fixture',token: 'fixture',team: { id: 7,name: 'fixture' } })
    if (url.pathname.endsWith('/token/oss')) return json({ storage: 'oss',prefix: 'file',bucket: 'fixture',credentials: { AccessKeyId: 'fixture',AccessKeySecret: 'fixture',SecurityToken: 'fixture',Expiration: '2100-01-01T00:00:00Z' } })
    if (url.pathname.endsWith('/fileMindMapUrl')) return new Response(null,{ status: 302,headers: { location: options.redirect ?? 'https://fixture.oss-cn-beijing.aliyuncs.com/'+records.find(row => 'private-'+row.id === url.searchParams.get('signature')).path+'?Signature=secret' } })
    if (url.hostname === 'fixture.oss-cn-beijing.aliyuncs.com') return json(objects.get(url.pathname.slice(1)))
    if (url.pathname === '/task/minder/mindMap/list' && init.method === 'POST') {
      if (options.conflict && calls.filter(call => call.path.endsWith('/mindMap/list')).length > 1) records[0].lastUpdated = '2026-11-08 12:00:01'
      const { page,size } = body;return json({ code: 200,data: records.slice((page-1)*size,page*size).map(row => ({ ...row,realPath: urlFor(row) })),ext: { page,size,total: records.length,totalPages: Math.ceil(records.length/size) } })
    }
    if (url.pathname.endsWith('/recycleBin/list')) return json(recycled)
    if (url.pathname === '/task/v1/recycleBin') {
      const at = recycled.findIndex(row => row.id === (body?.id ?? url.searchParams.get('id')));assert.ok(at >= 0);const [entry] = recycled.splice(at,1)
      if (init.method === 'POST') { records.push(deleted.get(entry.resourceId));return json({ hasParent: true,parentId: null }) }
      return new Response(null,{ status: 200 })
    }
    if (url.pathname === '/task/minder/mindMap' || url.pathname === '/task/minder/mindMap/list') {
      if (init.method === 'POST') { const record = { ...body,id: String(next++),lastUpdated: '2026-11-08 12:00:00',isOnlyCreatorCanEdit: false };records.push(record);return json({ code: 200,data: { ...record,realPath: urlFor(record) } }) }
      if (init.method === 'PUT') { Object.assign(records.find(row => row.id === body.id),body);if (options.unknown) throw Error('unknown result');return json({ code: 200,data: records.find(row => row.id === body.id) }) }
      if (init.method === 'DELETE') {
        for (const id of Array.isArray(body) ? body : [url.searchParams.get('id')]) { const at = records.findIndex(row => row.id === id);assert.ok(at >= 0);const [row] = records.splice(at,1);deleted.set(id,row);recycled.push({ id: String(100+next++),resourceId: id,userId: 81,type: 11,name: row.name });if (options.partial) throw Error('server failed after one deletion') }
        return json({ code: 200,data: null })
      }
    }
    throw Error('Unexpected request '+url.origin+url.pathname)
  } }
  return f
}
const run = (command,input,f,options = {}) => runWorkflow(ctx,workflows.workflows.find(flow => flow.command === command),input,session,{ approved: true,transport: f.transport,uploadTransfer: f.uploadTransfer,...options })
test('KityMinder JSON is uploaded privately and independently read back, preserving nodes, metadata and extension values',async () => {
  const f = fixture({ initial: false }),created = (await run('minder create',{ name: 'CLI 导图',document: doc },f)).result
  assert.deepEqual(created.document,doc);assert.equal(created.nodes,2);assert.equal(created.creatorId,'81');assert.equal(created.verified,true)
  assert.ok(!JSON.stringify(created).includes('signature'));assert.ok(!JSON.stringify(created).includes('realPath'))
  const input = { id: created.id,revision: created.revision,name: '新名称' },renamed = (await run('minder rename',input,f)).result
  assert.equal(renamed.name,'新名称.km');assert.deepEqual(renamed.document,doc)
  const changed = structuredClone(doc);changed.root.children[0].data.progress = 50;changed.root.children.push({ data: { text: '',id: 'new' },children: [] })
  const replaced = (await run('minder content replace',{ id: created.id,revision: renamed.revision,document: changed },f)).result
  assert.deepEqual(replaced.document,changed);assert.equal(replaced.name,'新名称.km');assert.equal(replaced.nodes,3)
  assert.deepEqual(f.calls.filter(call => call.method === 'PUT').map(call => Object.keys(call.body).sort()),[['id','name'],['extName','fileSize','id','path']])
  for (const path of f.transfers) await assert.rejects(access(path),{ code: 'ENOENT' })
  const contentCalls = f.calls.filter(call => call.path.endsWith('/fileMindMapUrl') || call.origin.includes('aliyuncs.com'));assert.ok(contentCalls.length >= 6)
  for (const call of contentCalls) for (const header of ['token','cookie','authorization']) assert.equal(call.headers[header],undefined)
})
test('ownership, explicit revisions and the fresh check protect all writes; unknown and partial writes are never replayed',async () => {
  const foreign = fixture({ foreign: true });await assert.rejects(run('minder rename',{ id: foreign.records[0].id,revision: minderRevision(foreign.records[0]),name: '外人' },foreign),{ code: 'FORBIDDEN' });assert.ok(!foreign.calls.some(call => call.method === 'PUT'))
  const stale = fixture();await assert.rejects(run('minder rename',{ id: stale.records[0].id,revision: '0'.repeat(64),name: '过期' },stale),{ code: 'CONTEXT_CONFLICT' })
  const conflict = fixture({ conflict: true });await assert.rejects(run('minder content replace',{ id: conflict.records[0].id,revision: minderRevision(conflict.records[0]),document: doc },conflict),{ code: 'CONTEXT_CONFLICT' });assert.equal(conflict.transfers.length,1);assert.ok(!conflict.calls.some(call => call.method === 'PUT'))
  const unknown = fixture({ unknown: true });await assert.rejects(run('minder rename',{ id: unknown.records[0].id,revision: minderRevision(unknown.records[0]),name: '可能成功' },unknown),error => error.code === 'NETWORK_ERROR' && error.details.writeOutcome === 'unknown' && error.details.resources.minderIds === '9007199254740993123');assert.equal(unknown.calls.filter(call => call.method === 'PUT').length,1)
  const partial = fixture({ partial: true });partial.add('9007199254740993124');const items = partial.records.map(row => ({ id: row.id,revision: minderRevision(row) }));await assert.rejects(run('minder batch remove',{ items },partial),error => error.code === 'NETWORK_ERROR' && error.details.resources.minderIds.split(',').length === 2);assert.equal(partial.records.length,1);assert.equal(partial.calls.filter(call => call.method === 'DELETE').length,1)
  const removed = fixture(),result = (await run('minder remove',{ id: removed.records[0].id,revision: minderRevision(removed.records[0]) },removed)).result;assert.equal(result.recycleEntries[0].resourceId,'9007199254740993123');assert.notEqual(result.recycleEntries[0].id,result.recycleEntries[0].resourceId)
})
test('content follows only the owned signed entry and OSS redirect, bounds bytes, and validates recursive JSON without executing links',async () => {
  const f = fixture({ redirect: 'https://attacker.invalid/internal' });await assert.rejects(run('minder inspect',{ id: f.records[0].id },f),{ code: 'CONTENT_ORIGIN_MISMATCH' });assert.ok(!f.calls.some(call => call.origin.includes('attacker')))
  await assert.rejects(readMinderContent({ realPath: 'https://www.rishiqing.com/task/v1/folder/file/getMindMapUrl?id=2' },'https://www.rishiqing.com',async () => { throw Error('must remain offline') }),{ code: 'CONTENT_ORIGIN_MISMATCH' })
  const huge = fixture();await assert.rejects(readMinderContent({ realPath: 'https://www.rishiqing.com/task/v1/folder/file/fileMindMapUrl?signature=owned' },'https://www.rishiqing.com',async url => url.hostname === 'www.rishiqing.com' ? new Response(null,{ status: 302,headers: { location: 'https://fixture.oss-cn-beijing.aliyuncs.com/a' } }) : new Response('no',{ headers: { 'content-length': '8388609' } })),{ code: 'CONTENT_TOO_LARGE' })
  const duplicate = structuredClone(doc);duplicate.root.children[0].data.id = 'root'
  for (const value of [{ root: { data: { text: 3 } } },duplicate,JSON.parse('{"root":{"data":{"text":"x","__proto__":{}}}}')]) assert.throws(() => validateMinderDocument(value),{ code: 'INVALID_INPUT' })
  const recursive = { data: { text: 'loop' } };recursive.children = [recursive];assert.throws(() => validateMinderDocument({ root: recursive }),{ code: 'INVALID_INPUT' })
})
test('indexed context pagination rejects changed totals, duplicate IDs and incomplete traversal, and cannot repeat a write',async () => {
  const op = catalog.operations.find(op => op.method === 'POST' && op.route === '/task/minder/mindMap/list'),args = { body: { page: 1,size: 1 } },row = id => ({ id,creatorId: 81,name: 'a.km' })
  const transport = mode => async (_url,init) => { const { page } = JSON.parse(init.body);return json({ code: 200,data: [row(mode === 'duplicate' ? '1' : String(page))],ext: { page,size: 1,total: mode === 'changed' && page === 2 ? 3 : 2,totalPages: mode === 'changed' && page === 2 ? 3 : 2 } }) }
  assert.equal((await collectIndexedPages(ctx,op,args,session,transport('ok'))).length,2)
  for (const mode of ['duplicate','changed']) await assert.rejects(collectIndexedPages(ctx,op,args,session,transport(mode)),{ code: 'PAGINATION_CHANGED' })
  await assert.rejects(collectIndexedPages(ctx,op,args,session,transport('ok'),1),{ code: 'PAGINATION_LIMIT' })
  await assert.rejects(collectIndexedPages(ctx,{ ...op,effect: 'write' },args,session,transport('ok')),{ code: 'INVALID_CONTRACT' })
})
test('dry run is offline, invalid tree fails before any HTTP, confirmation is enforced and raw transport cannot bypass context',async () => {
  const f = fixture(),input = { id: f.records[0].id,revision: minderRevision(f.records[0]) }
  assert.equal((await run('minder remove',input,f,{ dryRun: true })).dryRun,true);assert.equal(f.calls.length,0)
  await assert.rejects(run('minder remove',input,f,{ approved: false }),{ code: 'CONFIRMATION_REQUIRED' });assert.equal(f.calls.length,0)
  await assert.rejects(run('minder create',{ name: 'invalid',document: { root: { data: { text: 'x' },children: [{ data: {} }] } } },f),{ code: 'INVALID_INPUT' });assert.equal(f.calls.length,0)
  const op = catalog.operations.find(op => op.method === 'DELETE' && op.route === '/task/minder/mindMap');await assert.rejects(executeOperation(ctx,op,{ query: { id: input.id } },session,{ transport: f.transport,approved: true }),{ code: 'BUSINESS_CONTEXT_REQUIRED' })
})
test('recycle restore and purge require the exact owned entry and resource pair and independently verify both collections',async () => {
  const f = fixture(),id = f.records[0].id,removed = (await run('minder remove',{ id,revision: minderRevision(f.records[0]) },f)).result,entryId = removed.recycleEntries[0].id
  const listed = (await run('minder recycle list',{},f)).result;assert.equal(listed.entries[0].id,entryId);assert.equal(listed.complete,true)
  await assert.rejects(run('minder recycle restore',{ id,entryId: '999999' },f),{ code: 'FORBIDDEN' })
  const restored = (await run('minder recycle restore',{ id,entryId },f)).result;assert.deepEqual(restored.document,doc);assert.equal(restored.restored,true)
  const removedAgain = (await run('minder remove',{ id,revision: restored.revision },f)).result,next = removedAgain.recycleEntries[0].id
  await assert.rejects(run('minder recycle purge',{ id,entryId: next },f,{ approved: false }),{ code: 'CONFIRMATION_REQUIRED' })
  const purged = (await run('minder recycle purge',{ id,entryId: next },f)).result;assert.equal(purged.purged,true);assert.equal((await run('minder recycle list',{},f)).result.entries.length,0)
})
