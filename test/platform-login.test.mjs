import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest } from '../dist/core.js'
import { loginBrowser, whoami } from '../dist/auth.js'
import { loadSession, saveSession, sessionOrigin } from '../dist/session.js'
import { catalog } from '../dist/operations.js'

const ctx = { environment: 'production', profile: 'test' }
const key = char => char.repeat(43)
const token = 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
for (const [method, host, userFrom, error] of [
  ['feishu', 'https://lark.rishiqing.com', 'lark', 'FEISHU_LOGIN_UNAVAILABLE'],
  ['wps', 'https://wpsisv-plan.rishiqing.com', 'wp', 'WPS_LOGIN_UNAVAILABLE'],
]) {
  const created = { deviceId: key('a'), verificationUri: host + '/backauth/cli-auth/browser?launch=' + key('b'), expiresIn: 600, interval: 2 }
  const identity = { success: true, id: '9007199254740993', username: 'fixture', team: { id: '7' }, oauth: { userFrom }, token }
  test(method + ' browser authorization restores the correct session and verifies whoami at its own origin', async () => {
    let challenge, polls = 0, displayed
    const transport = async (url, init) => {
      assert.equal(url.origin, host)
      assert.equal(init.redirect, 'manual')
      if (url.pathname.endsWith('/device')) {
        const body = JSON.parse(init.body); challenge = body.challenge
        assert.equal(body.verifier, undefined)
        return json(created, 201)
      }
      if (url.pathname.endsWith('/exchange')) {
        const body = JSON.parse(init.body)
        assert.equal(body.deviceId, created.deviceId)
        assert.equal(digest(body.verifier), challenge)
        return ++polls === 1 ? json({ status: 'pending' }, 202) : json({ status: 'authorized', accessToken: token })
      }
      assert.equal(url.pathname, '/task/login/authAjax')
      assert.equal(new Headers(init.headers).get('token'), token)
      return json(identity)
    }
    const session = await loginBrowser(ctx, method, { transport, wait: async () => {}, notify: url => { displayed = url } })
    assert.equal(displayed, created.verificationUri)
    assert.equal(session.method, method); assert.equal(session.identity.userFrom, userFrom)
    assert.equal(sessionOrigin(ctx, method), host)
    const root = await mkdtemp(join(tmpdir(), 'rsq-platform-session-'))
    try {
      await saveSession(ctx, session, root)
      const restored = await loadSession(ctx, root)
      assert.deepEqual(restored, session)
      assert.deepEqual(await whoami(ctx, restored, transport), session.identity)
    } finally { await rm(root, { recursive: true, force: true }) }
    assert.ok(catalog.operations.find(op => op.command === 'task get').methods.includes(method))
    assert.ok(!catalog.operations.find(op => op.command === 'okr wecom charge-info get').methods.includes(method))
  })
  test(method + ' rejects foreign links, mismatched identities, denial, expiry and uncertain redemption', async () => {
    for (const link of ['https://other.example/backauth/cli-auth/browser?launch=' + key('b'), created.verificationUri + '&token=private', created.verificationUri + '#private']) {
      await assert.rejects(loginBrowser(ctx, method, { notify: () => assert.fail('untrusted URL displayed'), transport: async () => json({ ...created, verificationUri: link }) }), { code: 'INVALID_DEVICE_RESPONSE' })
    }
    for (const status of [404, 503]) await assert.rejects(loginBrowser(ctx, method, { notify() {}, transport: async () => json({}, status) }), { code: error })
    for (const [status, body, code] of [[403, { status: 'denied' }, 'LOGIN_DENIED'], [410, {}, 'LOGIN_EXPIRED'], [200, { status: 'authorized', accessToken: token }, 'INVALID_IDENTITY']]) {
      await assert.rejects(loginBrowser(ctx, method, { notify() {}, wait: async () => {}, transport: async url => url.pathname.endsWith('/device') ? json(created) : url.pathname.endsWith('/exchange') ? json(body, status) : json({ ...identity, oauth: { userFrom: 'rishiqing' } }) }), { code })
    }
    let exchanges = 0
    await assert.rejects(loginBrowser(ctx, method, { notify() {}, wait: async () => {}, transport: async url => {
      if (url.pathname.endsWith('/device')) return json(created)
      exchanges++; throw Error('connection lost')
    } }), { code: 'NETWORK_ERROR' })
    assert.equal(exchanges, 1)
  })
}
