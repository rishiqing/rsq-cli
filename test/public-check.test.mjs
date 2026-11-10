import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPublicTree } from '../scripts/public-check.mjs'

test('public repository guard accepts API home routes and rejects source provenance and private artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-public-'))
  try {
    const file = join(directory, 'schema.json')
    await writeFile(file, '{"route":"/task/okr/home/card/list"}')
    assert.deepEqual(await checkPublicTree(directory), [])
    for (const value of ['@' + 'packages' + '/private/src/file.ts:12', 'https:' + '//' + 'gitlab.' + 'example.invalid/team/repo', '/' + ['home', 'operator', 'private', 'file.ts'].join('/')]) {
      await writeFile(file, JSON.stringify({ example: value }))
      assert.equal((await checkPublicTree(directory)).length, 1)
    }
    await writeFile(file, JSON.stringify({ secretKey: 'sk_' + 'live_' + 'x'.repeat(48) }))
    assert.deepEqual(await checkPublicTree(directory), ['schema.json: credential-shaped value'])
    await rm(file)
    await writeFile(join(directory, 'backend.patch'), 'private implementation')
    assert.equal((await checkPublicTree(directory)).length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('public repository guard accepts anonymous public npm configuration and blocks private dependencies or publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-registry-'))
  try {
    const npmrc = join(directory, '.npmrc')
    await writeFile(npmrc, 'registry=https://registry.npmjs.org/\n@rishiqing:registry=https://registry.npmjs.org/\n')
    assert.deepEqual(await checkPublicTree(directory), [])
    for (const value of ['registry=https://packages.example.invalid/\n', '//registry.npmjs.org/:_authToken=fixture\n']) {
      await writeFile(npmrc, value)
      assert.ok((await checkPublicTree(directory)).length)
    }
    await rm(npmrc)
    const lock = join(directory, 'package-lock.json')
    await writeFile(lock, JSON.stringify({ packages: { 'node_modules/example': { resolved: 'https://packages.example.invalid/example.tgz' } } }))
    assert.ok((await checkPublicTree(directory)).length)
    await rm(lock)
    const pkg = join(directory, 'package.json')
    await writeFile(pkg, JSON.stringify({ publishConfig: { access: 'restricted' } }))
    assert.ok((await checkPublicTree(directory)).length)
    await writeFile(pkg, JSON.stringify({ publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } }))
    assert.deepEqual(await checkPublicTree(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
