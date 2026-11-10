// Terminal behavior without a real account, browser, or network request.
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
}
globalThis.fetch = async url => {
  if (String(url) !== 'https://qywx.rishiqing.com/qywxbackauth/cli-auth/device') throw Error('Unexpected network request')
  return new Response(null, { status: 503 })
}
