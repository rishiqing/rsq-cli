import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkPublicTree } from './public-check.mjs'

const directory = await mkdtemp(join(tmpdir(), 'rsq-package-'))
try {
  const output = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }))[0]
  const archive = join(directory, output.filename), unpacked = join(directory, 'unpacked')
  execFileSync('mkdir', ['-p', unpacked])
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  const issues = await checkPublicTree(join(unpacked, 'package'))
  if (issues.length) throw Error(JSON.stringify({ issues }))
  const consumer = join(directory, 'consumer')
  const userConfig = join(directory, 'user.npmrc'), globalConfig = join(directory, 'global.npmrc')
  await writeFile(userConfig, '', { mode: 0o600 }); await writeFile(globalConfig, '', { mode: 0o600 })
  const installEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_config_|npm_token$|node_auth_token$)/i.test(key)))
  execFileSync('npm', ['install', '--prefix', consumer, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(directory, 'cache'), archive], { encoding: 'utf8', stdio: 'pipe', env: installEnv })
  const cli = resolve(consumer, 'node_modules/@rishiqing/rsq-cli/dist/cli.js')
  const run = args => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config') }, maxBuffer: 8 * 1024 * 1024 })
  for (const args of [['schema'], ['schema', 'login'], ['schema', 'task get'], ['schema', 'project template create'], ['schema', 'workflow'], ['coverage', '--core'], ['auth', 'status']]) JSON.parse(run(args))
  if (!run(['--version']).trim()) throw Error('Missing installed version')
  if (process.platform !== 'win32') execFileSync(join(consumer, 'node_modules/.bin/rsq'), ['--version'], { stdio: 'pipe' })
  const pkg = JSON.parse(await readFile(join(unpacked, 'package/package.json')))
  console.log(JSON.stringify({ package: pkg.name, version: pkg.version, installedDiscovery: 'passed', publicContents: 'passed', anonymousPublicRegistry: 'passed' }))
} finally { await rm(directory, { recursive: true, force: true }) }
