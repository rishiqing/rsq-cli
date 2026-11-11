import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import { cliDiagnostic, renderCliDiagnostic } from '../dist/cli-errors.js'
import { RsqError } from '../dist/core.js'

const directory = mkdtempSync(join(tmpdir(), 'rsq-cli-output-'))
process.on('exit', () => rmSync(directory, { recursive: true, force: true }))
const run = (args, terminal = false, input = '') => spawnSync(process.execPath,
  [...(terminal ? ['--import', './test/fixtures/cli-terminal.mjs'] : []), 'dist/cli.js', ...args],
  { input, encoding: 'utf8', timeout: 15000, env: { ...process.env, XDG_CONFIG_HOME: directory } })

test('unknown login flag gives scripts a precise error and an executable recovery command', () => {
  const result = run(['--profile', 'work', '--login'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  const { error } = JSON.parse(result.stderr)
  assert.equal(error.code, 'USAGE_ERROR')
  assert.equal(error.reason, 'unknown_option')
  assert.match(error.message, /--login/u)
  assert.match(error.hint, /rsq login/u)
  assert.ok(error.actions.includes('rsq login --profile work --method password'))
})

test('terminal diagnostics are readable and --json restores the machine error contract', () => {
  const human = run(['--login'], true)
  assert.equal(human.status, 2)
  assert.equal(human.stdout, '')
  assert.match(human.stderr, /错误 \[USAGE_ERROR\]/u)
  assert.match(human.stderr, /下一步：[\s\S]*rsq login/u)
  assert.ok(!human.stderr.includes('"error":'))
  const machine = run(['--json', '--login'], true)
  assert.equal(machine.status, 2)
  assert.equal(JSON.parse(machine.stderr).error.reason, 'unknown_option')
})

test('unavailable WeCom login names the failed service and offers password login without saving a session', () => {
  for (const json of [false, true]) {
    const result = run([...(json ? ['--json'] : []), 'login', '--method', 'wecom', '--no-browser', '--profile', 'work'], true)
    assert.equal(result.status, 5)
    assert.equal(result.stdout, '')
    if (json) {
      const { error } = JSON.parse(result.stderr)
      assert.equal(error.code, 'WECOM_LOGIN_UNAVAILABLE')
      assert.ok(error.actions.includes('rsq login --profile work --method password'))
    } else {
      assert.match(result.stderr, /企业微信 CLI 登录服务当前不可用，本次登录未完成/u)
      assert.match(result.stderr, /rsq login --profile work --method password/u)
      assert.ok(!result.stderr.includes('该环境'))
    }
    assert.equal(existsSync(join(directory, 'rsq-cli/sessions/production/work.json')), false)
  }
})

test('login menu offers password, WeCom and DingTalk in order and EOF cancels with a failing exit code', () => {
  const result = run(['login'], true)
  assert.equal(result.status, 130)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /1\. 日事清账号密码[\s\S]*2\. 企业微信扫码[\s\S]*3\. 钉钉扫码/u)
  assert.match(result.stderr, /CANCELLED/u)
})

test('business results stay JSON in terminals and machine mode', () => {
  for (const json of [false, true]) {
    const result = run([...(json ? ['--json'] : []), 'project', 'template', 'create', '--name', 'offline-fixture', '--attribute', 'person', '--dry-run'], true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).dryRun, true)
    assert.equal(result.stderr, '')
  }
})

test('global formatting works for all command families and is discoverable in Schema', () => {
  const pretty = run(['--format', 'pretty', 'schema', 'task get'])
  assert.equal(pretty.status, 0, pretty.stderr)
  const schema = JSON.parse(pretty.stdout)
  assert.match(pretty.stdout, /\n  "version"/u)
  assert.deepEqual(schema.globalParameters.format.enum, ['json', 'pretty', 'table', 'ndjson'])
  assert.equal(schema.output.defaultFormat, 'json')
  const table = run(['auth', 'status', '--format', 'table'])
  assert.equal(table.status, 0, table.stderr)
  assert.match(table.stdout, /profile[\s\S]*default/u)
  assert.match(table.stdout, /state[\s\S]*missing/u)
  const machine = run(['--format', 'json', '--login'], true)
  assert.equal(JSON.parse(machine.stderr).error.reason, 'unknown_option')
  for (const args of [['task', 'get'], ['project', 'template', 'create'], ['login']]) {
    const help = run([...args, '--help'])
    assert.equal(help.status, 0, help.stderr)
    for (const flag of ['--profile <profile>', '--format <format>', '--json']) assert.ok(help.stdout.includes(flag), args.join(' ') + ' ' + flag)
  }
  const invalid = run(['task', 'get', '--format', 'unsupported-format'])
  assert.equal(invalid.status, 2)
  assert.match(JSON.parse(invalid.stderr).error.message, /--format/u)
})

test('nested command parse errors name the missing option and point to that command help', () => {
  const result = run(['task', 'get', '--id'])
  assert.equal(result.status, 2)
  const { error } = JSON.parse(result.stderr)
  assert.match(error.message, /--id.*缺少取值/u)
  assert.ok(error.actions.includes('rsq task get --help'))
  assert.ok(error.actions.includes('rsq schema "task get"'))
  const unknown = run(['task', 'get', '--unsupported-option'])
  assert.equal(unknown.status, 2)
  assert.ok(JSON.parse(unknown.stderr).error.actions.includes('rsq task get --help'))
})

test('usage diagnostics never echo secret argument values or unexpected exception text', () => {
  const secret = 'do-not-echo-credential'
  for (const code of ['commander.unknownOption', 'commander.invalidArgument']) {
    const diagnostic = cliDiagnostic(new CommanderError(2, code, "error: unknown option '--password=" + secret + "'"))
    assert.ok(!renderCliDiagnostic(diagnostic, false).includes(secret))
    assert.ok(!renderCliDiagnostic(diagnostic, true).includes(secret))
  }
  const unexpected = cliDiagnostic(new Error(secret))
  assert.equal(unexpected.error.code, 'UNEXPECTED_ERROR')
  assert.ok(!renderCliDiagnostic(unexpected, true).includes(secret))
})

test('human errors retain partial-write recovery information', () => {
  const details = { failedStep: 'readback', completedSteps: ['created'], resources: { taskId: 'own-created-task' }, writeOutcome: 'unknown' }
  const diagnostic = cliDiagnostic(new RsqError('NETWORK_ERROR', '无法连接日事清服务。', 5, details))
  const human = renderCliDiagnostic(diagnostic, true)
  assert.match(human, /own-created-task/u)
  assert.match(human, /unknown/u)
  assert.deepEqual(JSON.parse(renderCliDiagnostic(diagnostic, false)).error.details, details)
})
