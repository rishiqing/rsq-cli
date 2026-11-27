import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { downloadFile, downloadUrl, parseMention, readTaskContext, taskMedia, watchMentions } from '../dist/task-channel.js'

const ctx = { environment: 'production', profile: 'task-fixture' }
const actor = { version: 1, method: 'password', identity: { userId: '1', teamId: '10', username: 'fixture' }, accessToken: 'private-test-token', expiresAt: Date.now() + 60000 }
function service(calls, data, state = {}) {
  return async (url, init) => {
    calls.push(url.pathname)
    assert.equal(init.method, 'GET')
    if (url.pathname === '/task/login/authAjax') return Response.json({ success: true, id: 1, username: 'fixture', team: { id: 10, name: 'Fixture' }, token: actor.accessToken })
    if (url.pathname.endsWith('/member/state/independent')) return Response.json({ deadLine: '2100-01-01 00:00:00', userLimit: 5, usersCount: 2, mainApp: 'rsq', vt: 'fixture', ...state })
    if (url.pathname.endsWith('/function/available')) return Response.json([])
    if (url.pathname.endsWith('/authorities/company/current')) return Response.json({ useKanban: true })
    return data(url, init)
  }
}

test('task media covers HTML, custom Quill blocks and complete comments; mention identity is explicit', () => {
  const result = taskMedia({ basic: { note:'<img src="https://files.rishiqing.com/a.png">' }, fields:[{ value:{ops:[{ insert:{rsqBlock:true},attributes:{blockType:'file',iconType:'video',id:'99',name:'复现.mp4'}}]} }], comments:[{content:'<video src="https://files.rishiqing.com/b.mp4"></video>'}] })
  assert.deepEqual(result.map(x=>x.type), ['image','video','video'])
  assert.equal(result[1].fileId,'99'); assert.match(result[1].source,/fields\/0\/value\/ops\/0/)
  const raw = JSON.stringify({ type:'taskCommentMention', body:{teamId:'10',taskId:'task',commentId:'9223372036854775807',senderId:'1',senderName:'示例用户',mentionIds:['1'],text:'用户 id userabc 的录屏见字段，为什么没有处理？',createdAt:'2026-11-13T00:00:00Z'} })
  const parsed = parseMention(raw,{userId:'1',teamId:'10'})
  assert.equal(parsed.commentId,'9223372036854775807')
  assert.equal(parsed.senderId,'1') // shared account self-mention is allowed
  assert.match(parsed.text,/userabc/)
  assert.equal(parseMention(raw,{userId:'2',teamId:'10'}),null)
  assert.equal(parseMention(raw,{userId:'1',teamId:'11'}),null)
  assert.equal(parseMention({type:'notice',body:{title:'@示例用户'}},{userId:'1',teamId:'10'}),null)
})

test('task context verifies identity and respects exclusion, project binding and company restrictions', async () => {
  const calls = []
  const transport = service(calls, (url) => {
    if (url.pathname === '/task/api/v3/task') {
      assert.equal(url.searchParams.get('siteId'), '45')
      return Response.json({ id: 'task-fixture', from: { projectId: 45 }, note: '<img src="https://files.example.test/hidden.jpg">' })
    }
    if (url.pathname.endsWith('/task/template')) return Response.json({ templateFields: [] })
    if (url.pathname.endsWith('/comment/list')) return Response.json([{ content: '<img src="https://files.example.test/comment.jpg">' }])
    assert.fail('Unexpected request ' + url.pathname)
  })
  const result = await readTaskContext(ctx, actor, 'task-fixture', '45', true, transport)
  assert.equal(result.teamId, '10')
  assert.equal(result.taskId, 'task-fixture')
  assert.equal(Object.hasOwn(result.basic, 'note'), false)
  assert.deepEqual(result.media.map(item => item.url), ['https://files.example.test/comment.jpg'])
  assert.equal(result.comments.length, 1)
  await assert.rejects(readTaskContext(ctx, actor, 'task-fixture', undefined, false,
    service([], () => assert.fail('Unexpected business request'), { userLimit: 1 })), { code: 'COMPANY_OVER_CAPACITY' })
})

test('file download verifies permission and storage redirects, byte count and exclusive output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-file-fixture-'))
  const output = join(directory, 'original.bin'), missing = join(directory, 'short.bin')
  const entry = 'https://www.rishiqing.com/task/v1/folder/file/url?signature=fixture'
  const stored = 'https://rishiqing-file.oss-cn-beijing.aliyuncs.com/content.bin'
  const bytes = Uint8Array.of(4, 2, 1)
  const fixture = ({ downloadFile = true, redirect = stored, size = bytes.length } = {}) =>
    service([], (url, init) => {
      if (url.pathname === '/task/v1/folder/file') {
        assert.equal(url.searchParams.get('id'), '99')
        assert.equal(new Headers(init.headers).get('token'), actor.accessToken)
        return Response.json({ id: 99, name: 'original.bin', size, editControl: { downloadFile }, realPath: entry })
      }
      assert.equal(new Headers(init.headers).get('token'), null)
      assert.equal(new Headers(init.headers).get('cookie'), null)
      assert.equal(init.redirect, 'manual')
      if (url.href === entry) return new Response(null, { status: 302, headers: { location: redirect } })
      assert.equal(url.href, stored)
      return new Response(bytes)
    })
  try {
    assert.equal((await downloadUrl(ctx, actor, '99', fixture())).url, entry)
    await assert.rejects(downloadUrl(ctx, actor, '99', fixture({ downloadFile: false })), { code: 'FORBIDDEN' })
    await assert.rejects(downloadFile(ctx, actor, '99', output, fixture({ redirect: 'https://files.example.test/untrusted' })), { code: 'INVALID_FILE_URL' })
    assert.deepEqual(await downloadFile(ctx, actor, '99', output, fixture()), { id: '99', name: 'original.bin', output })
    await assert.rejects(downloadFile(ctx, actor, '99', output, fixture()), { code: 'OUTPUT_EXISTS' })
    await assert.rejects(downloadFile(ctx, actor, '99', missing, fixture({ size: 10 })), { code: 'DOWNLOAD_FAILED' })
    assert.deepEqual(new Uint8Array(await readFile(output)), bytes)
    assert.deepEqual(await readdir(directory), ['original.bin'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('online socket reconnects and rebinds a replaced profile without requesting history or leaking credentials', async () => {
  let session = { version:1, method:'password', identity:{userId:'1',teamId:'10',username:'first'},accessToken:'private-test-one',expiresAt:Date.now()+60000 }
  const events=[], sockets=[], rooms=[]
  const controller = new AbortController()
  const socket = (url, options) => {
    assert.equal(url, 'https://push.rishiqing.com:441')
    assert.deepEqual(options.transports, ['polling'])
    assert.equal(options.upgrade, false)
    const s = new EventEmitter(); s.open=()=>{s.emit('connect');return s};s.close=()=>{s.closed=true;return s}
    const send=s.emit.bind(s);s.emit=(name,...args)=>{if(name==='join room')rooms.push(args[0]);return send(name,...args)}
    sockets.push(s);return s
  }
  const running=watchMentions({environment:'production',profile:'bugflow'},async e=>events.push(e),controller.signal,{
    socket,load:async()=>session,transport:async (url) => {
      assert.equal(url.pathname, '/task/api/v3/comment/mention/connection')
      return Response.json({ userId: session.identity.userId, teamId: session.identity.teamId,
        url: 'https://push.rishiqing.com:441', room: 'production_userId_' + session.identity.userId, enabled: true })
    },
  })
  try {
    while(sockets.length<1) await delay(5)
    sockets[0].emit('disconnect'); sockets[0].emit('connect')
    assert.deepEqual(rooms,['production_userId_1','production_userId_1'])
    session=undefined
    await delay(2100)
    assert.ok(sockets[0].closed)
    assert.ok(events.some(e=>e.phase==='authentication_required'))
    session={version:1,method:'password',identity:{userId:'2',teamId:'10',username:'next'},accessToken:'private-test-two',expiresAt:Date.now()+60000}
    await delay(2100)
    assert.equal(sockets.length,2); assert.equal(rooms.at(-1),'production_userId_2')
    sockets[1].emit('active',JSON.stringify({type:'taskCommentMention',body:{teamId:'10',taskId:'t',commentId:'5',senderId:'2',mentionIds:['2'],text:'这个处理得怎么样了？',createdAt:new Date().toISOString()}}))
    await delay(5)
    assert.equal(events.filter(e=>e.type==='task_comment_mention').length,1)
    assert.ok(!JSON.stringify(events).includes('private-test'))
    assert.ok(rooms.every(r=>r.startsWith('production_userId_')))
  } finally {controller.abort();await running}
  assert.ok(sockets[1].closed)
})
