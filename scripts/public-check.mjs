import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const rules = [
  /@mt\//,
  /https?:\/\/[^\s"'<>]*\.timetask\.cn(?:[\s"'<>/:]|$)/i,
  /rishiqing(?:-monorepo|BackEnd)/i,
  /@(?:apps|packages)\/[\w-]+\//,
  /https?:\/\/[^\s"'<>]*gitlab\.[^\s"'<>/]+/i,
  /(?:rishiqing-(?:front|backend)|front-and-backend|third-party-backend)\/[\w-]+/,
  /(?:grails-app|rsqBiz)\//,
  /(?:^|[\s\"'(])\/(?:home|Users)\/[^\s\"'<>/]+\//,
  /com\.rishiqing\.[A-Za-z_$]/,
]
export async function checkPublicTree(directory) {
  const issues = []
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const file = resolve(path, entry.name), name = relative(directory, file)
      if (entry.isSymbolicLink()) { issues.push(name + ': unexpected symlink'); continue }
      if (entry.isDirectory()) { await visit(file); continue }
      if (['.env', '.yarnrc'].includes(entry.name) || /\.(?:tgz|patch|pem|key)$/.test(entry.name)) { issues.push(name + ': private or generated artifact'); continue }
      const content = await readFile(file, 'utf8')
      if (entry.name === '.npmrc' && content.split(/\r?\n/).some(line => line.trim() && !/^\s*[#;]/.test(line) && !/^\s*(?:@[a-z0-9_-]+:)?registry\s*=\s*https:\/\/registry\.npmjs\.org\/?\s*$/.test(line))) issues.push(name + ': non-public or authenticated npm configuration')
      if (entry.name === 'package-lock.json') {
        const lock = JSON.parse(content)
        for (const pkg of Object.values(lock.packages ?? {})) if (pkg.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(pkg.resolved)) { issues.push(name + ': dependency outside public npm'); break }
      }
      if (entry.name === 'package.json') {
        const pkg = JSON.parse(content)
        if (pkg.private !== true && (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' || pkg.publishConfig?.access !== 'public')) issues.push(name + ': public npm publishing is not configured')
      }
      if (rules.some(rule => rule.test(content))) issues.push(name + ': internal provenance')
      if (/\b(?:(?:sk|rk)_(?:live|test)_[a-zA-Z0-9]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|glpat-[a-zA-Z0-9_-]{20,})\b/.test(content)) issues.push(name + ': credential-shaped value')
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) issues.push(name + ': private key')
    }
  }
  await visit(resolve(directory))
  return issues
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issues = await checkPublicTree(new URL('..', import.meta.url).pathname)
  if (issues.length) { console.error(JSON.stringify({ issues }, null, 2)); process.exitCode = 1 }
  else console.log('Project contains no internal source references or private artifacts.')
}
