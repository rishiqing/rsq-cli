import { EnvHttpProxyAgent } from 'undici'

export class ProxyConfigurationError extends Error {
  constructor(public variable: string) { super('代理配置无效。') }
}

let agent: EnvHttpProxyAgent | undefined
let configuration = ''
function proxyAgent() {
  const values = ['http', 'https'].map(protocol => {
    const lower = protocol + '_proxy', upper = lower.toUpperCase()
    const variable = process.env[lower] !== undefined ? lower : upper, value = process.env[variable] || ''
    if (value) {
      try {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash) throw Error()
        decodeURIComponent(url.username); decodeURIComponent(url.password)
      } catch { throw new ProxyConfigurationError(variable) }
    }
    return value
  })
  if (!values.some(Boolean)) return undefined
  const key = JSON.stringify(values)
  if (!agent || key !== configuration) {
    // Closing an old dispatcher allows its in-flight requests to finish.
    void agent?.close().catch(() => {})
    agent = new EnvHttpProxyAgent({ httpProxy: values[0], httpsProxy: values[1] })
    configuration = key
  }
  return agent
}

// Explicit dispatch works on every supported Node 22 runtime, without startup
// switches or changes to the global dispatcher. NO_PROXY is read by the agent.
export const networkFetch: typeof fetch = async (input, init) => {
  const dispatcher = proxyAgent()
  // Node's bundled Undici uses a separate copy of the dispatcher type.
  const options: RequestInit = { ...init, ...(dispatcher && { dispatcher: dispatcher as unknown as RequestInit['dispatcher'] }) }
  return fetch(input, options)
}

export type NetworkFailure = { reason: 'proxy_configuration' | 'proxy_auth' | 'proxy_http' | 'tls' | 'dns' | 'timeout' | 'connection' | 'network'; retryable: boolean; variable?: string; httpStatus?: number }
export function networkFailure(error: unknown): NetworkFailure {
  const queue: unknown[] = [error], seen = new Set<unknown>(), codes = new Set<string>()
  let proxyStatus: number | undefined, timeout = false
  while (queue.length && seen.size < 20) {
    const item = queue.shift()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (item instanceof ProxyConfigurationError) return { reason: 'proxy_configuration', retryable: false, variable: item.variable }
    const value = item as { code?: string; name?: string; message?: string; cause?: unknown; errors?: unknown[] }
    if (typeof value.code === 'string') codes.add(value.code)
    timeout ||= value.name === 'TimeoutError'
    // Undici wraps CONNECT rejection in a nested error, rather than a Response.
    const status = /Proxy (?:response|Authentication Required) \((\d{3})\)/.exec(value.message ?? '')
    if (status) proxyStatus = Number(status[1])
    queue.push(value.cause, ...(Array.isArray(value.errors) ? value.errors : []))
  }
  if (proxyStatus) return { reason: proxyStatus === 407 ? 'proxy_auth' : 'proxy_http', retryable: [408, 429, 500, 502, 503, 504].includes(proxyStatus), httpStatus: proxyStatus }
  if ([...codes].some(code => /^(?:CERT_|ERR_TLS_|ERR_SSL_)/.test(code) || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED'].includes(code))) return { reason: 'tls', retryable: false }
  if (timeout || [...codes].some(code => /TIMEOUT|TIMEDOUT/.test(code))) return { reason: 'timeout', retryable: true }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) return { reason: 'dns', retryable: true }
  if ([...codes].some(code => ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code))) return { reason: 'connection', retryable: true }
  return { reason: 'network', retryable: true }
}
