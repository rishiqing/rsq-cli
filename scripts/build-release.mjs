import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'
import { releaseVersion, verifyReleaseChecksum } from '../dist/release.js'
import { checkPublicTree } from './public-check.mjs'
const root = fileURLToPath(new URL('..', import.meta.url)), config = JSON.parse(await readFile(join(root, 'release-config.json'))), pkg = JSON.parse(await readFile(join(root, 'package.json')))
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const output = resolve(option('--output') ?? join(tmpdir(), 'rsq-release-' + pkg.version)), requested = option('--platform')
const targets = requested ? [requested] : config.platforms
if (targets.some(target => !config.platforms.includes(target))) throw Error('Unsupported release target')
const issues = await checkPublicTree(root)
if (issues.length) throw Error(JSON.stringify({ issues }))
const temporary = await mkdtemp(join(tmpdir(), 'rsq-build-'))
try {
  await mkdir(output, { recursive: true })
  const dependencies = join(temporary, 'dependencies'); await mkdir(dependencies)
  await cp(join(root, 'package.json'), join(dependencies, 'package.json')); await cp(join(root, 'package-lock.json'), join(dependencies, 'package-lock.json'))
  const userConfig = join(temporary, 'user.npmrc'), globalConfig = join(temporary, 'global.npmrc')
  await writeFile(userConfig, ''); await writeFile(globalConfig, '')
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_config_|npm_token$|node_auth_token$)/i.test(key)))
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--userconfig', userConfig, '--globalconfig', globalConfig], { cwd: dependencies, env: cleanEnv, stdio: 'pipe' })
  await rm(join(dependencies, 'node_modules/.bin'), { recursive: true, force: true })
  const nodeRoot = 'https://nodejs.org/dist/v' + config.nodeVersion + '/', sums = await (await fetch(nodeRoot + 'SHASUMS256.txt')).text()
  const version = releaseVersion(pkg.version), checksums = []
  for (const target of targets) {
    const [platform, arch] = target.split('-'), windows = platform === 'win32', nodeName = 'node-v' + config.nodeVersion + '-' + (windows ? 'win' : platform) + '-' + arch
    const nodeAsset = nodeName + (windows ? '.zip' : '.tar.gz'), response = await fetch(nodeRoot + nodeAsset, { signal: AbortSignal.timeout(180000) })
    if (!response.ok) throw Error('Cannot download official Node runtime: ' + nodeAsset)
    const nodeBytes = Buffer.from(await response.arrayBuffer()); verifyReleaseChecksum(nodeBytes, sums, nodeAsset)
    const stage = join(temporary, target); await mkdir(stage)
    if (windows) {
      const selected = unzipSync(nodeBytes, { filter: file => [nodeName + '/node.exe', nodeName + '/LICENSE'].includes(file.name) })
      for (const [name, data] of Object.entries(selected)) await writeFile(join(stage, name.endsWith('/node.exe') ? 'node.exe' : 'NODE-LICENSE'), data)
    } else {
      const archive = join(temporary, nodeAsset); await writeFile(archive, nodeBytes)
      execFileSync('tar', ['-xzf', archive, '-C', stage, '--strip-components=1', nodeName + '/bin/node', nodeName + '/LICENSE'])
      await cp(join(stage, 'bin/node'), join(stage, 'node')); await chmod(join(stage, 'node'), 0o755)
      await cp(join(stage, 'LICENSE'), join(stage, 'NODE-LICENSE')); await rm(join(stage, 'bin'), { recursive: true }); await rm(join(stage, 'LICENSE'))
    }
    const app = join(stage, 'package'); await mkdir(app)
    for (const name of [...new Set(['package.json', 'LICENSE', 'NOTICE', ...pkg.files])]) await cp(join(root, name), join(app, name), { recursive: true, dereference: true })
    await cp(join(dependencies, 'node_modules'), join(app, 'node_modules'), { recursive: true, dereference: true })
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ version, platform, arch, nodeVersion: config.nodeVersion }, null, 2) + '\n')
    const filename = 'rsq-' + version + '-' + target + (windows ? '.zip' : '.tar.gz'), destination = join(output, filename)
    if (windows) {
      const files = {}
      async function collect(directory, prefix = '') { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = join(directory, entry.name), name = prefix + entry.name; if (entry.isDirectory()) await collect(file, name + '/'); else { if (!(await lstat(file)).isFile()) throw Error('Unexpected release symlink'); files[name] = new Uint8Array(await readFile(file)) } } }
      await collect(stage); await writeFile(destination, zipSync(files, { level: 6 }))
    } else execFileSync('tar', ['-czf', destination, '-C', stage, '.'])
    checksums.push(createHash('sha256').update(await readFile(destination)).digest('hex') + '  ' + filename)
    console.log('Built ' + filename)
  }
  await writeFile(join(output, 'latest.json'), JSON.stringify({ version }, null, 2) + '\n')
  for (const name of ['install.sh', 'install.ps1']) { await cp(join(root, 'scripts', name), join(output, name)); checksums.push(createHash('sha256').update(await readFile(join(output, name))).digest('hex') + '  ' + name) }
  await writeFile(join(output, 'SHA256SUMS'), checksums.join('\n') + '\n')
  console.log('Release assets: ' + output)
} finally { await rm(temporary, { recursive: true, force: true }) }
