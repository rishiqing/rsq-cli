import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, lstat, readFile, chmod, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, parseJson } from '../dist/core.js'
import { loginPassword, loginWecom, whoami } from '../dist/auth.js'
import { loadSession, saveSession, removeSession } from '../dist/session.js'

const token = () => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature'
const identity = (method = 'password') => ({ success: true, id: '9007199254740993', username: 'test-user', team: { id: '7' }, oauth: { userFrom: method === 'wecom' ? 'qywx' : 'rishiqing' }, token: token() })
const ctx = { environment: 'production', profile: 'testing' }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const key = char => char.repeat(43)

test('password login handles form escaping, scoped cookies and never persists a password', async () => {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) {
      const form = new URLSearchParams(init.body)
      assert.equal(form.get('j_username'), 'a&=张')
      assert.equal(form.get('j_password'), 'p+&=密')
      assert.equal(init.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: '/task/login/success', 'set-cookie': 'JSESSIONID=test-cookie; Path=/task; Secure; HttpOnly' } })
    }
    assert.equal(url.href, 'https://www.rishiqing.com/task/login/authAjax')
    assert.equal(init.headers.get('cookie'), 'JSESSIONID=test-cookie')
    return json(identity())
  }
  const session = await loginPassword(ctx, 'a&=张', 'p+&=密', transport)
  assert.equal(session.identity.userId, '9007199254740993')
  assert.equal(session.password, undefined)
  const root = await mkdtemp(join(tmpdir(), 'rsq-session-'))
  try {
    await saveSession(ctx, session, root)
    const file = join(root, 'sessions/production/testing.json')
    assert.equal((await lstat(file)).mode & 0o777, 0o600)
    assert.equal((await lstat(join(root, 'sessions'))).mode & 0o777, 0o700)
    assert.ok(!(await readFile(file, 'utf8')).includes('p+&=密'))
    assert.deepEqual(await loadSession(ctx, root), session)
    assert.equal(await loadSession({ ...ctx, environment: 'beta' }, root), null)
    assert.equal(await loadSession({ ...ctx, profile: 'other' }, root), null)
    await removeSession(ctx, root)
    assert.equal(await loadSession(ctx, root), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('login rejects credential redirects and never follows them', async () => {
  let calls = 0
  await assert.rejects(loginPassword(ctx, 'user', 'secret', async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example/task/login/success' } })
  }), { code: 'LOGIN_FAILED' })
  assert.equal(calls, 1)
})

test('world-readable and symlinked credential stores are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsq-session-'))
  const session = { version: 1, method: 'password', identity: { userId: '1', username: 'test' }, accessToken: token(), expiresAt: Date.now() + 10000 }
  try {
    await saveSession(ctx, session, root)
    const file = join(root, 'sessions/production/testing.json')
    await chmod(file, 0o644)
    await assert.rejects(loadSession(ctx, root), { code: 'UNSAFE_SESSION_STORE' })
    await rm(file)
    await symlink('/etc/passwd', file)
    await assert.rejects(loadSession(ctx, root), { code: 'INVALID_SESSION' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('WeCom uses separate public launch link and polling proof, then verifies the issued identity', async () => {
  let challenge
  let polls = 0
  let notified
  const session = await loginWecom(ctx, {
    notify: url => { notified = { url } },
    wait: async () => {},
    transport: async (url, init) => {
      if (url.pathname.endsWith('/device')) {
        const body = JSON.parse(init.body)
        challenge = body.challenge
        assert.equal(body.verifier, undefined)
        return json({ deviceId: key('a'), verificationUri: 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }, 201)
      }
      if (url.pathname.endsWith('/exchange')) {
        const body = JSON.parse(init.body)
        assert.equal(digest(body.verifier), challenge)
        assert.equal(body.deviceId, key('a'))
        assert.ok(!notified.url.includes(body.verifier))
        assert.ok(!notified.url.includes(body.deviceId))
        return ++polls === 1 ? json({ status: 'pending' }, 202) : json({ status: 'authorized', accessToken: token() })
      }
      assert.equal(url.href, 'https://qywx.rishiqing.com/task/login/authAjax')
      assert.ok(init.headers.get('token'))
      return json(identity('wecom'))
    },
  })
  assert.equal(polls, 2)
  assert.equal(session.method, 'wecom')
  assert.equal(session.identity.teamId, '7')
})

test('WeCom rejects an invalid login URL before displaying it', async () => {
  for (const verificationUri of ['https://qywx.rishiqing.com/qywxbackauth/cli-auth/unknown', 'https://attacker.example/browser', 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/browser?launch=short']) {
    await assert.rejects(loginWecom(ctx, { notify: () => assert.fail('invalid link displayed'), transport: async () => json({ deviceId: key('a'), expiresIn: 600, interval: 2, verificationUri }) }), { code: 'INVALID_DEVICE_RESPONSE' })
  }
})

test('WeCom never opens a foreign login URL', async () => {
  let opened = false
  await assert.rejects(loginWecom(ctx, {
    notify: () => { opened = true },
    transport: async () => json({ deviceId: key('a'), verificationUri: 'https://attacker.example/qywxbackauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }),
  }), { code: 'INVALID_DEVICE_RESPONSE' })
  assert.equal(opened, false)
})

test('WeCom does not replay an exchange after a network failure with an unknown result', async () => {
  let exchanges = 0
  await assert.rejects(loginWecom(ctx, {
    notify: () => {}, wait: async () => {},
    transport: async url => {
      if (url.pathname.endsWith('/device')) return json({ deviceId: key('a'), verificationUri: 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }, 201)
      if (url.pathname.endsWith('/exchange')) { exchanges++; throw new Error('network disconnected after send') }
      throw new Error('Unexpected request')
    },
  }), { code: 'NETWORK_ERROR' })
  assert.equal(exchanges, 1)
})

test('WeCom reports a disappeared exchange service as unavailable and requires a fresh login', async () => {
  for (const status of [404, 503]) {
    let exchanges = 0
    await assert.rejects(loginWecom(ctx, {
      notify: () => {}, wait: async () => {}, transport: async url => {
        if (url.pathname.endsWith('/device')) return json({ deviceId: key('a'), verificationUri: 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }, 201)
        exchanges++
        return json({ error: 'Not Found' }, status)
      },
    }), error => error.code === 'WECOM_LOGIN_UNAVAILABLE' && error.details.httpStatus === status && error.details.stage === 'exchange')
    assert.equal(exchanges, 1)
  }
})

test('WeCom cancellation and denial are explicit failures', async () => {
  const created = { deviceId: key('a'), verificationUri: 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }
  const abort = new AbortController()
  await assert.rejects(loginWecom(ctx, {
    signal: abort.signal,
    notify: () => abort.abort(),
    transport: async () => json(created),
  }), { code: 'CANCELLED' })
  await assert.rejects(loginWecom(ctx, {
    notify: () => {}, wait: async () => {},
    transport: async url => url.pathname.endsWith('/device') ? json(created) : json({ status: 'denied' }, 403),
  }), { code: 'LOGIN_DENIED' })
})

test('WeCom obeys polling slowdown and reports expired or wrong-platform sessions', async () => {
  const created = { deviceId: key('a'), verificationUri: 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }
  const delays = []; let polls = 0
  await assert.rejects(loginWecom(ctx, {
    notify: () => {}, wait: async delay => { delays.push(delay) },
    transport: async url => {
      if (url.pathname.endsWith('/device')) return json(created)
      if (url.pathname.endsWith('/exchange')) return ++polls === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': '4' } })
        : json({ status: 'expired' }, 410)
      throw Error('Unexpected request')
    },
  }), { code: 'LOGIN_EXPIRED' })
  assert.deepEqual(delays, [2000, 4000])
  await assert.rejects(loginWecom(ctx, {
    notify: () => {}, wait: async () => {}, transport: async url => {
      if (url.pathname.endsWith('/device')) return json(created)
      if (url.pathname.endsWith('/exchange')) return json({ status: 'authorized', accessToken: token() })
      return json(identity('password'))
    },
  }), { code: 'INVALID_IDENTITY' })
})

test('whoami uses a token without allowing old cookies to select another identity', async () => {
  const session = { version: 1, method: 'password', identity: { userId: '1', username: 'test-user', teamId: '7' }, accessToken: token(), expiresAt: Date.now() + 10000 }
  await assert.rejects(whoami(ctx, session, async (url, init) => {
    assert.equal(init.headers.get('cookie'), null)
    return json(identity())
  }), { code: 'IDENTITY_CHANGED' })
})

test('large integer JSON identities remain exact strings', () => {
  assert.deepEqual(parseJson('{"id":9007199254740993,"count":42}'), { id: '9007199254740993', count: 42 })
})

test('DingTalk browser login verifies its own origin and identity, persists and restores its session', async () => {
  const { loginDingtalk } = await import('../dist/auth.js')
  const { sessionOrigin } = await import('../dist/session.js')
  let challenge, link, polls = 0
  const transport = async (url, init) => {
    assert.equal(url.origin, 'https://app2245.eapps.dingtalkcloud.com')
    if (url.pathname === '/backauth/cli-auth/device') {
      challenge = JSON.parse(init.body).challenge
      return json({ deviceId: key('a'), verificationUri: url.origin + '/backauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }, 201)
    }
    if (url.pathname === '/backauth/cli-auth/exchange') {
      const body = JSON.parse(init.body)
      assert.equal(digest(body.verifier), challenge)
      assert.ok(!link.includes(body.verifier))
      assert.ok(!link.includes(body.deviceId))
      return ++polls === 1 ? json({ status: 'pending' }, 202) : json({ status: 'authorized', accessToken: token() })
    }
    assert.equal(url.pathname, '/task/login/authAjax')
    assert.ok(init.headers.get('token'))
    return new Response(JSON.stringify({ ...identity(), oauth: { userFrom: 'dingtalk' } }), { headers: { 'set-cookie': 'JSESSIONID=ding-session; Path=/task; Secure; HttpOnly' } })
  }
  const session = await loginDingtalk(ctx, { transport, wait: async () => {}, notify: url => { link = url } })
  assert.equal(session.method, 'dingtalk')
  assert.equal(session.identity.userFrom, 'dingtalk')
  assert.equal(sessionOrigin(ctx, 'dingtalk'), 'https://app2245.eapps.dingtalkcloud.com')
  const root = await mkdtemp(join(tmpdir(), 'rsq-ding-session-'))
  try {
    await saveSession(ctx, session, root)
    const restored = await loadSession(ctx, root)
    assert.deepEqual(restored, session)
    assert.deepEqual(await whoami(ctx, restored, transport), session.identity)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('DingTalk rejects foreign launch links, wrong platforms and does not replay uncertain exchanges', async () => {
  const { loginDingtalk } = await import('../dist/auth.js')
  const created = { deviceId: key('a'), verificationUri: 'https://app2245.eapps.dingtalkcloud.com/backauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }
  for (const link of ['https://qywx.rishiqing.com/backauth/cli-auth/browser?launch=' + key('b'), created.verificationUri + '&token=private', created.verificationUri.replace('/backauth/', '/task/')]) {
    await assert.rejects(loginDingtalk(ctx, { notify: () => assert.fail('untrusted URL displayed'), transport: async () => json({ ...created, verificationUri: link }) }), { code: 'INVALID_DEVICE_RESPONSE' })
  }
  let exchanges = 0
  await assert.rejects(loginDingtalk(ctx, { notify() {}, wait: async () => {}, transport: async url => {
    if (url.pathname.endsWith('/device')) return json(created)
    exchanges++; throw new Error('connection lost')
  } }), { code: 'NETWORK_ERROR' })
  assert.equal(exchanges, 1)
  await assert.rejects(loginDingtalk(ctx, { notify() {}, wait: async () => {}, transport: async url => {
    if (url.pathname.endsWith('/device')) return json(created)
    if (url.pathname.endsWith('/exchange')) return json({ status: 'authorized', accessToken: token() })
    return json(identity('wecom'))
  } }), { code: 'INVALID_IDENTITY' })
  for (const status of [404, 503]) await assert.rejects(loginDingtalk(ctx, { notify() {}, transport: async () => json({}, status) }), { code: 'DINGTALK_LOGIN_UNAVAILABLE' })
})

test('DingTalk-issued sessions can execute shared business operations with scoped credentials', async () => {
  const { runOperation, catalog } = await import('../dist/operations.js')
  const operation = catalog.operations.find(op => op.command === 'task get')
  assert.ok(operation.methods.includes('dingtalk'))
  const session = { version: 1, method: 'dingtalk', identity: { userId: '1', username: 'test', teamId: '7', userFrom: 'dingtalk' }, accessToken: token(), expiresAt: Date.now() + 3600000 }
  let sent = 0
  const result = await runOperation(ctx, operation, { query: { id: '123' } }, session, { transport: async (url, init) => {
    sent++
    assert.equal(url.origin, 'https://app2245.eapps.dingtalkcloud.com')
    assert.equal(init.headers.get('token'), session.accessToken)
    return json({ id: '123', name: 'DingTalk task' })
  } })
  assert.equal(sent, 1)
  assert.equal(result.id, '123')
  assert.ok(!catalog.operations.find(op => op.command === 'okr wecom charge-info get').methods.includes('dingtalk'))
})
