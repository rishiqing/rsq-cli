import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { releaseAsset } from '../dist/release.js'

test('proxy routing and upgrade transfers work over real local HTTP, HTTPS and CONNECT connections', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-network-'))
  const key = join(directory, 'test-key'), cert = join(directory, 'test-cert')
  const servers = [], sockets = new Set()
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:service.rsq.test,DNS:child.service.rsq.test,DNS:other.rsq.test,DNS:raw.githubusercontent.com,DNS:github.com,DNS:release-assets.githubusercontent.com,IP:127.0.0.1'], { stdio: 'ignore' })
    const tls = { key: await readFile(key), cert: await readFile(cert) }
    const observed = { proxy: [], origin: [], proxyAuth: [], leakedAuth: [] }
    let rejectProxy = 0, resetPosts = false, metadataFailures = 0, archiveFailures = 0, release
    function respond(request, response) {
      observed.origin.push({ host: request.headers.host, method: request.method, url: request.url })
      if (request.headers['proxy-authorization']) observed.leakedAuth.push(request.headers['proxy-authorization'])
      if (resetPosts && request.method === 'POST') { request.socket.destroy(); return }
      if (request.url.endsWith('/latest.json')) {
        if (metadataFailures-- > 0) { response.writeHead(503); response.end(); return }
        response.end(JSON.stringify({ version: '0.1.0-preview.2' })); return
      }
      if (release && request.url.endsWith('/SHA256SUMS')) { response.end(release.sums); return }
      if (release && request.url.endsWith('/' + release.asset)) {
        response.writeHead(302, { location: 'https://release-assets.githubusercontent.com/release-archive' }); response.end(); return
      }
      if (release && request.url === '/release-archive') {
        if (archiveFailures-- > 0) { response.writeHead(502); response.end(); return }
        response.end(release.bytes); return
      }
      response.end(JSON.stringify({ ok: true, method: request.method }))
    }
    async function listen(server) {
      servers.push(server)
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      return server.address().port
    }
    const httpPort = await listen(http.createServer(respond)), httpsPort = await listen(https.createServer(tls, respond))
    function tunnel(request, client, head) {
      observed.proxy.push(request.url)
      if (request.headers['proxy-authorization']) observed.proxyAuth.push(request.headers['proxy-authorization'])
      if (rejectProxy) { client.end('HTTP/1.1 ' + rejectProxy + ' Proxy Rejected\r\nContent-Length: 0\r\n\r\n'); return }
      const destination = new URL('http://' + request.url)
      const port = Number(destination.port || 80)
      const target = port === 443 ? httpsPort : port
      if (![httpPort, httpsPort].includes(target)) { client.destroy(); return }
      const upstream = net.connect(target, '127.0.0.1')
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.on('close', () => upstream.destroy())
    }
    const proxy = http.createServer(); proxy.on('connect', tunnel)
    const secureProxy = https.createServer(tls); secureProxy.on('connect', tunnel)
    const proxyPort = await listen(proxy), secureProxyPort = await listen(secureProxy)
    const proxyUrl = 'http://127.0.0.1:' + proxyPort, secureProxyUrl = 'https://localhost:' + secureProxyPort
    const urls = { http: 'http://service.rsq.test:' + httpPort + '/resource', https: 'https://service.rsq.test:' + httpsPort + '/resource' }
    async function run(options, variables = {}, trust = true) {
      observed.proxy.length = 0; observed.origin.length = 0
      const env = { ...process.env }
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) delete env[name]
      Object.assign(env, trust ? { NODE_EXTRA_CA_CERTS: cert } : {}, variables)
      const child = spawn(process.execPath, ['test/fixtures/network-client.mjs', JSON.stringify(options)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
      const [status] = await once(child, 'exit'); clearTimeout(timer)
      return { status, stdout, stderr }
    }
    async function routed(variables, url, expectedProxy) {
      const result = await run({ url }, variables)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).body.ok, true)
      assert.equal(observed.proxy.length > 0, expectedProxy)
      assert.equal(observed.origin.length, 1)
    }
    await t.test('uppercase and lowercase proxies work for HTTP and HTTPS without Node startup flags', async () => {
      for (const protocol of ['http', 'https']) {
        for (const variable of [protocol.toUpperCase() + '_PROXY', protocol + '_proxy']) await routed({ [variable]: proxyUrl }, urls[protocol], true)
        await routed({}, urls[protocol], false)
      }
      await routed({ HTTP_PROXY: proxyUrl }, urls.https, true)
      await routed({ HTTPS_PROXY: secureProxyUrl }, urls.https, true)
    })
    await t.test('lowercase variables take precedence, including an explicitly empty variable', async () => {
      for (const protocol of ['http', 'https']) {
        await routed({ [protocol.toUpperCase() + '_PROXY']: 'http://127.0.0.1:1', [protocol + '_proxy']: proxyUrl }, urls[protocol], true)
        await routed({ [protocol.toUpperCase() + '_PROXY']: proxyUrl, [protocol + '_proxy']: '' }, urls[protocol], false)
      }
    })
    await t.test('NO_PROXY and no_proxy bypass exact hosts, subdomains, ports and wildcard, and preserve non-matches', async () => {
      for (const name of ['NO_PROXY', 'no_proxy']) {
        for (const protocol of ['http', 'https']) {
          const port = protocol === 'http' ? httpPort : httpsPort
          for (const pattern of ['service.rsq.test', '.rsq.test', '*.rsq.test', 'service.rsq.test:' + port, '*', 'other.test, service.rsq.test']) await routed({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, [name]: pattern }, urls[protocol], false)
          for (const pattern of ['other.rsq.test', 'service.rsq.test:1', 'vice.rsq.test']) await routed({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, [name]: pattern }, urls[protocol], true)
        }
        await routed({ HTTPS_PROXY: proxyUrl, [name]: 'service.rsq.test' }, urls.https.replace('service.rsq.test', 'child.service.rsq.test'), false)
      }
      await routed({ HTTPS_PROXY: proxyUrl, NO_PROXY: '*', no_proxy: 'other.rsq.test' }, urls.https, true)
    })
    await t.test('proxy Basic credentials reach only the proxy and never the service', async () => {
      await routed({ HTTPS_PROXY: 'http://sample-user:sample-password@127.0.0.1:' + proxyPort }, urls.https, true)
      assert.equal(observed.proxyAuth.at(-1), 'Basic ' + Buffer.from('sample-user:sample-password').toString('base64'))
      assert.deepEqual(observed.leakedAuth, [])
    })
    await t.test('real invalid-proxy, CONNECT 407 and certificate failures give safe, actionable errors', async () => {
      for (const address of ['socks5://sample-user:sample-password@127.0.0.1:1', 'http://sample-user:sample-password%ZZ@127.0.0.1:1']) {
        const invalid = await run({ operation: 'upgrade', check: true }, { HTTPS_PROXY: address })
        assert.equal(invalid.status, 5)
        assert.equal(JSON.parse(invalid.stderr).error.details.reason, 'proxy_configuration')
        assert.ok(!invalid.stderr.includes('sample-password')); assert.equal(observed.proxy.length, 0)
      }
      for (const status of [407, 403]) {
        rejectProxy = status
        const denied = await run({ operation: 'upgrade', check: true }, { HTTPS_PROXY: proxyUrl })
        rejectProxy = 0
        assert.equal(denied.status, 5, denied.stderr)
        assert.equal(JSON.parse(denied.stderr).error.details.reason, status === 407 ? 'proxy_auth' : 'proxy_http')
        assert.equal(observed.proxy.length, 1)
      }
      const certificate = await run({ operation: 'upgrade', check: true }, { HTTPS_PROXY: proxyUrl }, false)
      assert.equal(certificate.status, 5)
      assert.equal(JSON.parse(certificate.stderr).error.details.reason, 'tls')
      assert.match(JSON.parse(certificate.stderr).error.hint, /NODE_EXTRA_CA_CERTS/)
      assert.equal(observed.proxy.length, 1)
    })
    await t.test('business writes are never replayed after a connection drop', async () => {
      resetPosts = true
      const result = await run({ url: urls.https, method: 'POST' }, { HTTPS_PROXY: proxyUrl })
      resetPosts = false
      assert.equal(result.status, 5)
      assert.equal(JSON.parse(result.stderr).error.code, 'NETWORK_ERROR')
      assert.equal(observed.origin.filter(row => row.method === 'POST').length, 1)
    })
    await t.test('the real upgrade checks metadata through both cases of HTTPS_PROXY', async () => {
      for (const name of ['HTTPS_PROXY', 'https_proxy']) {
        const result = await run({ operation: 'upgrade', check: true }, { [name]: proxyUrl })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).status, 'update_available')
        assert.deepEqual(observed.proxy, ['raw.githubusercontent.com:443'])
      }
    })
    if (process.platform !== 'win32') await t.test('a complete proxied upgrade retries failures, follows the asset redirect and switches only after checksum verification', async () => {
      const root = join(directory, 'managed'), selected = 'original', version = '0.1.0-preview.2'
      await mkdir(join(root, 'versions', selected), { recursive: true }); await writeFile(join(root, 'current'), selected + '\n')
      const staging = join(directory, 'package-release'); await mkdir(join(staging, 'package/dist'), { recursive: true })
      await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch }))
      await writeFile(join(staging, 'package/dist/cli.js'), '')
      await writeFile(join(staging, 'node'), '#!/bin/sh\nprintf ' + "'" + version + "\\n'" + '\n'); await chmod(join(staging, 'node'), 0o755)
      const archive = join(directory, 'release.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', staging, '.'])
      const bytes = await readFile(archive), asset = releaseAsset(version)
      release = { bytes, asset, sums: createHash('sha256').update(bytes).digest('hex') + '  ' + asset + '\n' }
      metadataFailures = 1; archiveFailures = 1
      const result = await run({ operation: 'upgrade', root }, { HTTPS_PROXY: proxyUrl })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).status, 'upgraded')
      assert.equal(observed.origin.filter(row => row.url.endsWith('/latest.json')).length, 2)
      assert.equal(observed.origin.filter(row => row.url === '/release-archive').length, 2)
      assert.ok(observed.proxy.includes('github.com:443'))
      assert.ok(observed.proxy.includes('release-assets.githubusercontent.com:443'))
      assert.notEqual((await readFile(join(root, 'current'), 'utf8')).trim(), selected)
      assert.equal((await readFile(join(root, 'previous'), 'utf8')).trim(), selected)
    })
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    await rm(directory, { recursive: true, force: true })
  }
})
