import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'rsq-cli-test-'))
process.on('exit', () => rmSync(root, { force: true, recursive: true }))
const run = (args, input) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', input, env: { ...process.env, XDG_CONFIG_HOME: root }, maxBuffer: 64 * 1024 * 1024 })

test('progressive discovery exposes exactly the runtime parameters and help', () => {
  const all = run(['schema', '--all'])
  assert.equal(all.error,undefined)
  assert.equal(all.status,0)
  const catalog = JSON.parse(all.stdout)
  const modules = JSON.parse(run(['schema']).stdout).modules
  assert.equal(modules.reduce((sum, module) => sum + module.count, 0), catalog.operations.length + catalog.workflows.length + catalog.builtins.length)
  for (const module of modules) assert.equal(module.executable, [...catalog.operations, ...catalog.workflows, ...catalog.builtins].filter(item => item.command.split(' ')[0] === module.name && item.executable).length, module.name)
  const modulesSeen = new Set()
  const representative = catalog.operations.filter(op => {
    if (!op.executable) return false
    const module = op.command.split(' ')[0]
    if (modulesSeen.has(module)) return false
    modulesSeen.add(module)
    return true
  })
  // Every parameter is checked by the catalog audit and transport fixtures;
  // exercise Commander/help once per business module without 800 subprocesses.
  for (const op of representative) {
    const leaf = JSON.parse(run(['schema', op.command]).stdout)
    assert.deepEqual(leaf.inputSchema, op.inputSchema)
    const help = run([...op.command.split(' '), '--help'])
    assert.equal(help.status, 0, op.command + ': ' + (help.error?.message ?? help.stderr))
    for (const flag of Object.keys(leaf.parameters)) assert.ok(help.stdout.includes('--' + flag + ' <value>'), op.command + ' ' + flag)
    assert.ok(help.stdout.includes('--input <file|->'))
  }
  assert.ok(catalog.operations.some(op => !op.executable))
  const help = run(['--help'])
  assert.ok(!help.stdout.includes('--environment'))
  assert.equal(run(['--environment', 'beta', 'auth', 'status']).status, 2)
})

test('CLI input, JSON stdout, stderr errors and destructive noninteractive confirmation', () => {
  const preview = run(['doc', 'draft', 'create', '--input', '-', '--dry-run'], '{"body":{"name":"private"}}')
  assert.equal(preview.status, 0)
  assert.equal(preview.stderr, '')
  assert.equal(JSON.parse(preview.stdout).dryRun, true)
  const duplicate = run(['doc', 'draft', 'create', '--input', '-', '--name', 'second', '--dry-run'], '{"body":{"name":"first"}}')
  assert.equal(duplicate.status, 2)
  assert.equal(duplicate.stdout, '')
  assert.equal(JSON.parse(duplicate.stderr).error.code, 'DUPLICATE_INPUT')
  const rawWithoutContext = run(['doc', 'delete', '--id', '123'])
  assert.equal(rawWithoutContext.status, 2)
  assert.equal(JSON.parse(rawWithoutContext.stderr).error.code, 'BUSINESS_CONTEXT_REQUIRED')
  const noConfirm = run(['doc', 'remove', '--space-id', '1', '--id', '123'])
  assert.equal(noConfirm.status, 2)
  assert.equal(JSON.parse(noConfirm.stderr).error.code, 'CONFIRMATION_REQUIRED')
  const auth = run(['auth', 'status'])
  assert.equal(JSON.parse(auth.stdout).state, 'missing')
})

test('bundled Skill is discoverable through the installed command without authentication', () => {
  const skill = run(['skill'])
  assert.equal(skill.status, 0)
  const value = JSON.parse(skill.stdout)
  assert.equal(value.name, 'rsq-cli')
  assert.ok(value.path.endsWith('/skills/rsq-cli/SKILL.md'))
  assert.ok(value.content.includes('rsq whoami'))
  assert.ok(value.content.includes('rsq schema'))
})
