import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { compareVersions, releaseVersion, releasePlatform, releaseAsset, safeArchiveEntry, verifyReleaseChecksum, upgradeRelease, latestManifest } from '../dist/release.js'
const first = '0.1.0-preview.1', second = '0.1.0-preview.2', platform = releasePlatform()
async function fixture(callback) {
  const temporary = await mkdtemp(join(tmpdir(), 'rsq-updater-')), root = join(temporary, 'managed')
  await mkdir(join(root, 'versions'), { recursive: true })
  const current = first + '-original'
  async function packageAt(directory, version) {
    await mkdir(join(directory, 'package/dist'), { recursive: true })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch }))
    await writeFile(join(directory, 'package/dist/cli.js'), '')
    await writeFile(join(directory, 'node'), '#!/bin/sh\nprintf ' + "'" + version + "\\n'" + '\n'); await chmod(join(directory, 'node'), 0o755)
  }
  await packageAt(join(root, 'versions', current), first)
  await writeFile(join(root, 'current'), current + '\n')
  const directory = join(temporary, 'release'); await packageAt(directory, second)
  const archive = join(temporary, 'release.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', directory, '.'])
  const bytes = await readFile(archive), asset = releaseAsset(second), sums = createHash('sha256').update(bytes).digest('hex') + '  ' + asset + '\n', calls = []
  const transport = async (url, init) => {
    calls.push(String(url)); assert.ok(!init.headers.authorization); assert.ok(!init.headers.cookie)
    if (url === latestManifest) return new Response(JSON.stringify({ version: second }))
    if (url.endsWith('/SHA256SUMS')) return new Response(sums)
    if (url.endsWith('/' + asset)) return new Response(bytes)
    throw Error('Unexpected download')
  }
  try { await callback({ temporary, root, current, bytes, asset, sums, calls, directory, archive, transport, packageAt }) } finally { await rm(temporary, { recursive: true, force: true }) }
}

test('release versions compare prereleases numerically and reject paths and unsupported platforms', () => {
  assert.equal(releaseVersion('v0.1.0-preview.1'), first)
  assert.equal(compareVersions('0.1.0-preview.10', second), 1)
  assert.equal(compareVersions('0.1.0', '0.1.0-preview.10'), 1)
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1)
  assert.throws(() => releaseVersion('../../payload'), { code: 'INVALID_RELEASE' })
  assert.throws(() => releasePlatform('linux', 'mips'), { code: 'UNSUPPORTED_PLATFORM' })
  for (const path of ['../secret', '/absolute', './a/../../b', 'C:/escape', 'a\\b']) assert.throws(() => safeArchiveEntry(path), { code: 'INVALID_RELEASE' })
  safeArchiveEntry('./package/dist/cli.js')
})
test('SHA256 verification requires exactly one matching checksum', () => {
  const bytes = Buffer.from('example'), name = 'rsq-fixture.tar.gz', line = createHash('sha256').update(bytes).digest('hex') + '  ' + name
  verifyReleaseChecksum(bytes, line, name)
  for (const sums of ['', line + '\n' + line, '0'.repeat(64) + '  ' + name]) assert.throws(() => verifyReleaseChecksum(bytes, sums, name), { code: 'CHECKSUM_MISMATCH' })
})
test('checking and listing releases need neither a managed installation nor a login', async () => {
  const checked = await upgradeRelease({ check: true }, { currentVersion: first, fetch: async () => new Response(JSON.stringify({ version: second })) })
  assert.equal(checked.status, 'update_available'); assert.equal(checked.updateAvailable, true)
  const listed = await upgradeRelease({ list: true }, { fetch: async () => new Response(JSON.stringify([{ tag_name: 'v' + first, prerelease: true, draft: false, html_url: 'https://github.com/rishiqing/rsq-cli/releases/tag/v' + first }])) })
  assert.equal(listed.versions[0].version, first)
  await assert.rejects(upgradeRelease({ list: true, rollback: true }), { code: 'INVALID_INPUT' })
})
test('upgrades require confirmation and never download or switch after refusal', { skip: process.platform === 'win32' }, async () => fixture(async f => {
  await assert.rejects(upgradeRelease({}, { root: f.root, currentVersion: first, fetch: f.transport }), { code: 'CONFIRMATION_REQUIRED' })
  assert.equal(f.calls.length, 1); assert.equal((await readFile(join(f.root, 'current'), 'utf8')).trim(), f.current)
}))
test('verified installation switches atomically and rollback restores the previous CLI and Skill without network', { skip: process.platform === 'win32' }, async () => fixture(async f => {
  const credentials = join(f.temporary, 'credentials'); await writeFile(credentials, 'credential-sentinel')
  const out = await upgradeRelease({ yes: true }, { root: f.root, currentVersion: first, fetch: f.transport })
  assert.equal(out.status, 'upgraded'); assert.equal(out.targetVersion, second)
  assert.equal((await readFile(join(f.root, 'previous'), 'utf8')).trim(), f.current)
  assert.match(out.skillPath, /package[/\\]skills[/\\]rsq-cli[/\\]SKILL.md$/)
  const selected = (await readFile(join(f.root, 'current'), 'utf8')).trim(); assert.notEqual(selected, f.current)
  assert.equal(f.calls.filter(url => url.endsWith('/' + f.asset)).length, 1)
  const rolled = await upgradeRelease({ rollback: true, yes: true }, { root: f.root, currentVersion: second, fetch: () => assert.fail('rollback must be offline') })
  assert.equal(rolled.status, 'rolled_back'); assert.equal(rolled.targetVersion, first)
  assert.equal((await readFile(join(f.root, 'current'), 'utf8')).trim(), f.current)
  assert.equal(await readFile(credentials, 'utf8'), 'credential-sentinel')
}))
test('checksum corruption, bad versions, unsafe tar links and network errors preserve the current installation', { skip: process.platform === 'win32' }, async () => fixture(async f => {
  await assert.rejects(upgradeRelease({ yes: true }, { root: f.root, currentVersion: first, fetch: async (url, init) => url.endsWith('/' + f.asset) ? new Response('corrupted') : f.transport(url, init) }), { code: 'CHECKSUM_MISMATCH' })
  await assert.rejects(upgradeRelease({ yes: true }, { root: f.root, currentVersion: first, fetch: async () => { throw Error('unavailable') } }), { code: 'UPDATE_UNAVAILABLE' })
  await symlink('../outside', join(f.directory, 'link'))
  execFileSync('tar', ['-czf', f.archive, '-C', f.directory, '.'])
  const bytes = await readFile(f.archive), sums = createHash('sha256').update(bytes).digest('hex') + '  ' + f.asset
  await assert.rejects(upgradeRelease({ yes: true }, { root: f.root, currentVersion: first, fetch: async url => new Response(url === latestManifest ? JSON.stringify({ version: second }) : url.endsWith('/SHA256SUMS') ? sums : bytes) }), { code: 'INVALID_RELEASE' })
  assert.equal((await readFile(join(f.root, 'current'), 'utf8')).trim(), f.current)
}))
test('the POSIX installer validates a release, supports quoted paths and preserves installation on checksum failure', { skip: process.platform === 'win32' }, async () => fixture(async f => {
  const assets = join(f.temporary, 'assets'), fakebin = join(f.temporary, 'tools'); await mkdir(assets); await mkdir(fakebin)
  await writeFile(join(assets, f.asset), f.bytes); await writeFile(join(assets, 'SHA256SUMS'), f.sums); await writeFile(join(assets, 'latest.json'), JSON.stringify({ version: second }, null, 2))
  const curl = '#!' + process.execPath + '\n' + `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),u=new URL(a.find(x=>x.startsWith('https://'))),out=a[a.indexOf('-o')+1];fs.copyFileSync(path.join(process.env.RSQ_FIXTURE_ASSETS,path.basename(u.pathname)),out);\n`
  await writeFile(join(fakebin, 'curl'), curl); await chmod(join(fakebin, 'curl'), 0o755)
  const root = join(f.temporary, "space's install"), bin = join(f.temporary, "space's bin"), env = { ...process.env, RSQ_VERSION: '', RSQ_FIXTURE_ASSETS: assets, RSQ_INSTALL_DIR: root, RSQ_BIN_DIR: bin, PATH: fakebin + ':' + process.env.PATH }
  const run = () => spawnSync('sh', ['scripts/install.sh'], { encoding: 'utf8', env })
  const installed = run(); assert.equal(installed.status, 0, installed.stderr)
  assert.equal(execFileSync(join(bin, 'rsq'), ['--version'], { encoding: 'utf8' }).trim(), second)
  const before = await readFile(join(root, 'current'), 'utf8')
  await writeFile(join(assets, 'SHA256SUMS'), '0'.repeat(64) + '  ' + f.asset)
  assert.notEqual(run().status, 0)
  assert.equal(await readFile(join(root, 'current'), 'utf8'), before)
}))

test('cancelling a download releases the update lock and leaves the selected version unchanged', { skip: process.platform === 'win32' }, async () => fixture(async f => {
  const stop = new AbortController()
  await assert.rejects(upgradeRelease({ yes: true }, { root: f.root, currentVersion: first, signal: stop.signal, fetch: async (url, init) => {
    if (url.endsWith('/' + f.asset)) { stop.abort(); throw Error('aborted') }
    return f.transport(url, init)
  } }), { code: 'CANCELLED' })
  assert.equal((await readFile(join(f.root, 'current'), 'utf8')).trim(), f.current)
  await mkdir(join(f.root, '.update-lock'))
}))
