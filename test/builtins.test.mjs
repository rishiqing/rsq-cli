import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { builtinCommands } from '../dist/builtins.js'
const directory = mkdtempSync(join(tmpdir(), 'rsq-builtin-test-'))
process.on('exit', () => rmSync(directory, { recursive: true, force: true }))
const run = (args, input) => spawnSync(process.execPath, ['dist/cli.js', ...args], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, XDG_CONFIG_HOME: directory } })
test('all built-in identity commands are discoverable offline and their options match actual help', () => {
  for (const builtin of builtinCommands) {
    const output = run(['schema', builtin.command]); assert.equal(output.status, 0)
    const schema = JSON.parse(output.stdout), help = run([...builtin.command.split(' '), '--help']); assert.equal(help.status, 0)
    assert.equal(schema.kind, 'builtin'); assert.equal(schema.executable, true); assert.equal(schema.supportsDryRun, false); assert.equal(schema.inputFileSupported, false)
    for (const parameter of Object.values(schema.parameters)) assert.ok(help.stdout.includes(parameter.option), parameter.option)
    assert.ok(help.stdout.includes('Schema: rsq schema "' + builtin.command + '"'))
    assert.ok(!Object.hasOwn(schema.parameters, 'password')); assert.ok(!Object.hasOwn(schema.parameters, 'environment'))
  }
  const auth = JSON.parse(run(['schema', 'auth']).stdout); assert.ok(auth.builtins.some(builtin => builtin.command === 'auth status'))
  const byId = JSON.parse(run(['schema', 'builtin.login']).stdout); assert.equal(byId.command, 'login'); assert.deepEqual(byId.parameters.method.enum, ['password', 'wecom', 'dingtalk']); assert.equal(byId.parameters.browser.presentValue, false)
  assert.deepEqual(byId.transport.dingtalk, ['POST /backauth/cli-auth/device', 'POST /backauth/cli-auth/exchange', 'GET /task/login/authAjax'])
  assert.deepEqual(byId.transport.wecom, ['POST /qywxbackauth/cli-auth/device', 'POST /qywxbackauth/cli-auth/exchange', 'GET /task/login/authAjax'])
})
test('built-in identity discovery matches actual local session behavior and early noninteractive input failures', () => {
  const status = JSON.parse(run(['auth', 'status', '--profile', 'fresh']).stdout); assert.equal(status.state, 'missing'); assert.equal(status.profile, 'fresh')
  const logout = JSON.parse(run(['logout', '--profile', 'fresh']).stdout); assert.equal(logout.state, 'missing')
  for (const args of [[], ['--method', 'password'], ['--method', 'password', '--username', 'fixture'], ['--method', 'wecom', '--username', 'fixture'], ['--method', 'dingtalk', '--username', 'fixture'], ['--method', 'dingtalk', '--password-stdin'], ['--method', 'password', '--no-browser']]) {
    const output = run(['login', ...args], '')
    assert.equal(output.status, 2); assert.equal(output.stdout, ''); assert.ok(['INVALID_INPUT', 'INVALID_LOGIN_METHOD'].includes(JSON.parse(output.stderr).error.code))
  }
  const missing = run(['whoami', '--profile', 'fresh']); assert.equal(missing.status, 3); assert.equal(JSON.parse(missing.stderr).error.code, 'AUTH_REQUIRED')
})
