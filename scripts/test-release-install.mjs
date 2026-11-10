import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const assets = resolve(process.argv[2]), version = JSON.parse(await readFile('package.json')).version
const temporary = await mkdtemp(join(tmpdir(), 'rsq-install-smoke-'))
try {
  const bin = join(temporary, 'bin'), root = join(temporary, "installation's space"), tools = join(temporary, 'tools'); await mkdir(tools)
  const stub = '#!' + process.execPath + '\n' + `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),url=new URL(args.find(a=>a.startsWith('https://')));fs.copyFileSync(path.join(process.env.RSQ_TEST_ASSETS,path.basename(url.pathname)),args[args.indexOf('-o')+1]);\n`
  await writeFile(join(tools, 'curl'), stub); await chmod(join(tools, 'curl'), 0o755)
  const env = { ...process.env, RSQ_VERSION: '', RSQ_TEST_ASSETS: assets, RSQ_INSTALL_DIR: root, RSQ_BIN_DIR: bin, PATH: tools + ':' + process.env.PATH, XDG_CONFIG_HOME: join(temporary, 'config') }
  const run = (command, args) => { const out = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); if (out.status !== 0) throw Error(out.stderr); return out.stdout }
  run('sh', ['scripts/install.sh']); const cli = join(bin, 'rsq')
  if (run(cli, ['--version']).trim() !== version) throw Error('Installed version differs')
  JSON.parse(run(cli, ['schema', 'upgrade'])); JSON.parse(run(cli, ['schema', 'task get']))
  const before = await readFile(join(root, 'current'), 'utf8')
  run('sh', ['scripts/install.sh'])
  if (await readFile(join(root, 'current'), 'utf8') === before) throw Error('Reinstall did not prepare another version')
  const rollback = JSON.parse(run(cli, ['upgrade', '--rollback', '--yes']))
  if (rollback.status !== 'rolled_back' || await readFile(join(root, 'current'), 'utf8') !== before) throw Error('Rollback did not restore previous version')
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, version, installation: 'passed', schema: 'passed', rollback: 'passed' }))
} finally { await rm(temporary, { recursive: true, force: true }) }
