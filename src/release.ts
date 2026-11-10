import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { RsqError } from './core.js'

export const releaseRepository = 'rishiqing/rsq-cli'
export const releaseDownload = 'https://github.com/' + releaseRepository + '/releases/download/'
export const latestManifest = 'https://raw.githubusercontent.com/' + releaseRepository + '/main/latest.json'
export const installedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string
export const agentSkillPath = fileURLToPath(new URL('../skills/rsq-cli/SKILL.md', import.meta.url))
export type UpgradeOptions = { check?: boolean; list?: boolean; version?: string; rollback?: boolean; force?: boolean; yes?: boolean }
type Services = { fetch?: typeof fetch; root?: string; currentVersion?: string; signal?: AbortSignal; confirm?: (plan: { currentVersion: string; targetVersion: string; rollback: boolean }) => Promise<boolean> }
function fail(code: string, message: string): never { throw new RsqError(code, message, 5) }
export function releaseVersion(value: unknown) {
  const text = typeof value === 'string' ? value.replace(/^v/, '') : ''
  if (text.length > 80 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(text)) fail('INVALID_RELEASE', '版本格式无效。')
  return text
}
export function releasePlatform(platform: string = process.platform, arch: string = process.arch) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) fail('UNSUPPORTED_PLATFORM', '当前平台没有预构建安装包。')
  return platform + '-' + arch
}
export function releaseAsset(version: string, platform = releasePlatform()) {
  return 'rsq-' + releaseVersion(version) + '-' + platform + (platform.startsWith('win32-') ? '.zip' : '.tar.gz')
}
export function compareVersions(a: string, b: string) {
  const parts = (value: string) => { const version = releaseVersion(value), dash = version.indexOf('-'); return { core: (dash < 0 ? version : version.slice(0, dash)).split('.').map(BigInt), pre: dash < 0 ? [] : version.slice(dash + 1).split('.') } }
  const left = parts(a), right = parts(b)
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    return nx && ny ? BigInt(x) > BigInt(y) ? 1 : -1 : nx !== ny ? nx ? -1 : 1 : x > y ? 1 : -1
  }
  return 0
}
async function download(url: string, transport: typeof fetch, limit: number, signal?: AbortSignal) {
  let response: Response
  try { response = await transport(url, { headers: { accept: 'application/octet-stream' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) }) } catch { if (signal?.aborted) throw new RsqError('CANCELLED', '升级已取消，当前安装未切换。', 130); return fail('UPDATE_UNAVAILABLE', '无法连接 GitHub，请稍后重新检查更新。') }
  if (!response.ok) fail('UPDATE_UNAVAILABLE', '无法获取 GitHub Release 文件（HTTP ' + response.status + '）。')
  if (Number(response.headers.get('content-length')) > limit) fail('INVALID_RELEASE', '安装包超过允许大小。')
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  if (!reader) fail('INVALID_RELEASE', 'Release 文件内容为空。')
  let size = 0
  try {
    while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > limit) { await reader.cancel(); fail('INVALID_RELEASE', '安装包超过允许大小。') } chunks.push(result.value) }
  } catch (error) { if (signal?.aborted) throw new RsqError('CANCELLED', '升级已取消，当前安装未切换。', 130); if (error instanceof RsqError) throw error; fail('UPDATE_UNAVAILABLE', 'Release 文件下载未完成，当前安装未切换。') }
  return Buffer.concat(chunks)
}
export function verifyReleaseChecksum(bytes: Uint8Array, sums: string, filename: string) {
  const rows = sums.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(line)).filter(row => row && row[2] === filename)
  if (rows.length !== 1 || createHash('sha256').update(bytes).digest('hex') !== rows[0]![1].toLowerCase()) fail('CHECKSUM_MISMATCH', '安装包 SHA256 校验失败，当前安装未切换。')
}
export function safeArchiveEntry(value: string) {
  const name = value.replace(/^(\.\/)+/, '')
  if (!name || name === '.') return
  if (name.startsWith('/') || /[\\:\x00-\x1f]/.test(name) || name.split('/').includes('..')) fail('INVALID_RELEASE', '安装包包含不安全的文件路径。')
}
async function extractRelease(bytes: Buffer, filename: string, directory: string, temporary: string) {
  await mkdir(directory)
  if (filename.endsWith('.zip')) {
    const files = unzipSync(bytes)
    for (const [name, data] of Object.entries(files)) { safeArchiveEntry(name); if (name.endsWith('/')) { await mkdir(join(directory, name), { recursive: true }); continue } await mkdir(dirname(join(directory, name)), { recursive: true }); await writeFile(join(directory, name), data) }
  } else {
    const file = join(temporary, 'release.tar.gz'); await writeFile(file, bytes)
    const names = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    names.split('\n').filter(Boolean).forEach(safeArchiveEntry)
    const listing = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (listing.split('\n').filter(Boolean).some(line => !/^[d-]/.test(line))) fail('INVALID_RELEASE', '安装包不能包含链接或特殊设备文件。')
    execFileSync('tar', ['-xzf', file, '-C', directory], { stdio: 'pipe' })
  }
}
async function pointer(root: string, name: string) {
  let text: string
  try { text = (await readFile(join(root, name), 'utf8')).trim() } catch { return undefined }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(text)) fail('INVALID_INSTALLATION', '本地安装版本指针无效。')
  return text
}
async function writePointer(root: string, name: string, value: string) {
  const temporary = join(root, '.' + name + '-' + randomUUID())
  try { await writeFile(temporary, value + '\n', { mode: 0o600 }); await rename(temporary, join(root, name)) } finally { await rm(temporary, { force: true }) }
}
async function verifyInstalled(directory: string, version?: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { version: string; platform: string; arch: string }
  if (releaseVersion(manifest.version) !== manifest.version || version && manifest.version !== version || manifest.platform + '-' + manifest.arch !== releasePlatform()) fail('INVALID_RELEASE', '安装包版本或平台不匹配。')
  const node = join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
  if (!(await lstat(node)).isFile()) fail('INVALID_RELEASE', '安装包没有有效运行时。')
  if (process.platform !== 'win32') await chmod(node, 0o755)
  const reported = execFileSync(node, [join(directory, 'package/dist/cli.js'), '--version'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }).trim()
  if (reported !== manifest.version) fail('INVALID_RELEASE', '安装后的版本核对未通过。')
  return manifest.version
}
async function managedRoot(supplied?: string) {
  if (supplied) return resolve(supplied)
  const packageDirectory = resolve(fileURLToPath(new URL('..', import.meta.url))), releaseDirectory = dirname(packageDirectory), versions = dirname(releaseDirectory)
  if (basename(versions) !== 'versions') fail('INSTALLATION_NOT_MANAGED', '请先使用 GitHub 安装脚本安装 rsq，再运行自升级。')
  return dirname(versions)
}
export async function upgradeRelease(options: UpgradeOptions, services: Services = {}) {
  if (options.list && (options.check || options.version || options.rollback || options.force) || options.rollback && (options.check || options.version || options.force)) throw new RsqError('INVALID_INPUT', '升级选项不能组合使用。', 2)
  const transport = services.fetch ?? fetch, currentVersion = services.currentVersion ?? installedVersion
  if (options.list) {
    const data = JSON.parse((await download('https://api.github.com/repos/' + releaseRepository + '/releases?per_page=100', transport, 8 * 1024 * 1024, services.signal)).toString()) as { tag_name: string; draft: boolean; prerelease: boolean; html_url: string; published_at: string }[]
    return { status: 'versions', currentVersion, versions: data.filter(row => !row.draft).map(row => ({ version: releaseVersion(row.tag_name), prerelease: row.prerelease, url: row.html_url, publishedAt: row.published_at })) }
  }
  let root: string | undefined, targetVersion: string, previous: string | undefined
  if (options.rollback) {
    root = await managedRoot(services.root); previous = await pointer(root, 'previous')
    if (!previous) fail('NO_ROLLBACK', '没有可回滚的安装版本。')
    targetVersion = await verifyInstalled(join(root, 'versions', previous))
  } else {
    const data = options.version ? { version: options.version } : JSON.parse((await download(latestManifest, transport, 65536, services.signal)).toString())
    targetVersion = releaseVersion(data.version)
  }
  const plan = { currentVersion, targetVersion, rollback: !!options.rollback }, comparison = compareVersions(targetVersion, currentVersion)
  if (options.check) return { status: comparison > 0 ? 'update_available' : 'up_to_date', ...plan, updateAvailable: comparison > 0 }
  if (!options.rollback && !options.force && (comparison === 0 || comparison < 0 && !options.version)) return { status: 'up_to_date', ...plan }
  root ??= await managedRoot(services.root)
  if (!options.yes && !await services.confirm?.(plan)) throw new RsqError('CONFIRMATION_REQUIRED', '升级或回滚需要确认；非交互调用请使用 --yes。', 2)
  const lock = join(root, '.update-lock')
  try { await mkdir(lock) } catch { fail('UPDATE_IN_PROGRESS', '另一个安装或升级正在运行；请在其完成后重试。') }
  let temporary: string | undefined
  try {
    const before = await pointer(root, 'current')
    if (!before) fail('INVALID_INSTALLATION', '缺少当前安装版本指针。')
    let selected = previous
    if (!options.rollback) {
      const asset = releaseAsset(targetVersion), base = releaseDownload + 'v' + targetVersion + '/'
      const sums = (await download(base + 'SHA256SUMS', transport, 128 * 1024, services.signal)).toString()
      const bytes = await download(base + asset, transport, 250 * 1024 * 1024, services.signal)
      verifyReleaseChecksum(bytes, sums, asset)
      temporary = await mkdtemp(join(root, '.update-'))
      const staging = join(temporary, 'release')
      await extractRelease(bytes, asset, staging, temporary)
      await verifyInstalled(staging, targetVersion)
      selected = targetVersion + '-' + releasePlatform() + '-' + randomUUID().slice(0, 8)
      await rename(staging, join(root, 'versions', selected))
    }
    if (services.signal?.aborted) throw new RsqError('CANCELLED', '升级已取消，当前安装未切换。', 130)
    await writePointer(root, 'previous', before)
    await writePointer(root, 'current', selected!)
    return { status: options.rollback ? 'rolled_back' : 'upgraded', ...plan, skillPath: join(root, 'versions', selected!, 'package/skills/rsq-cli/SKILL.md') }
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }) }
}
