// Terminal behavior without a real account, browser, or network request.
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
}
globalThis.fetch = async url => {
  if (!['https://qywx.rishiqing.com/qywxbackauth/cli-auth/device', 'https://lark.rishiqing.com/backauth/cli-auth/device', 'https://wpsisv-plan.rishiqing.com/backauth/cli-auth/device'].includes(String(url))) throw Error('Unexpected network request')
  return new Response(null, { status: 503 })
}
