import dns from 'node:dns'
import { cliDiagnostic } from '../../dist/cli-errors.js'

// Reserved test domains resolve locally; no public DNS or service is needed.
const lookup = dns.lookup
dns.lookup = function (host, options, callback) {
  if (!host.endsWith('.rsq.test')) return lookup.apply(this, arguments)
  const done = typeof options === 'function' ? options : callback
  queueMicrotask(() => typeof options === 'object' && options.all
    ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4))
}

const options = JSON.parse(process.argv[2])
try {
  let result
  if (options.operation === 'upgrade') {
    const { upgradeRelease } = await import('../../dist/release.js')
    result = await upgradeRelease(options.check ? { check: true } : {}, { root: options.root, currentVersion: '0.0.1' })
  } else {
    const { send, request } = await import('../../dist/core.js')
    const response = await send(request, new URL(options.url), { method: options.method ?? 'GET' }, undefined, 5000)
    result = { status: response.status, body: await response.json() }
  }
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  const diagnostic = cliDiagnostic(error, 'default', options.operation === 'upgrade' ? 'upgrade' : '')
  process.stderr.write(JSON.stringify({ error: diagnostic.error }))
  process.exitCode = diagnostic.exit
}
