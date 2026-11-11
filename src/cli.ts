#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Command, CommanderError, Option } from 'commander'
import { loginPassword, loginWecom, loginDingtalk, openBrowser, whoami } from './auth.js'
import { asObject, context, readJson, readStdin, RsqError, type JsonObject } from './core.js'
import { assignField, catalog, flagValue, operationOutput, type Operation } from './operations.js'
import { loadSession, removeSession, requireSession, saveSession, status } from './session.js'
import { businessCoverage, businessScope, operationBusinessContext } from './business.js'
import { mainFlowCoverage } from './main-flows.js'
import { workflows, workflowSchema } from './workflows.js'
import { executeOperation as runOperation, executeWorkflow as runWorkflow } from './dispatch.js'
import { accessDescription } from './access.js'
import { builtinCommands, configureBuiltin, globalParameters } from './builtins.js'
import { upgradeRelease, agentSkillPath, type UpgradeOptions } from './release.js'
import { cliDiagnostic } from './cli-errors.js'
import { CliOutput, outputContract, outputFormats, type OutputFormat } from './output.js'

const app = new Command()
  .name('rsq')
  .description('日事清业务命令行。运行 rsq schema 发现业务命令。')
  .version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  .option('--profile <profile>', '选择本地会话', 'default')
  .option('--json', '终端错误也使用 JSON；业务结果默认输出 JSON')
  .addOption(new Option('--format <format>', globalParameters.format.description).choices([...outputFormats]).default('json'))
  .exitOverride()
  .configureHelp({ showGlobalOptions: true })
  .configureOutput({ writeErr: () => {} })
  .showHelpAfterError(false)

let activeCommand = ''
app.hook('preAction', (_root, command) => {
  const parts: string[] = []
  for (let current: Command | null = command; current && current !== app; current = current.parent) parts.unshift(current.name())
  activeCommand = parts.join(' ')
})

function output() {
  const opts = app.opts<{ format: string; json?: boolean }>()
  const format = opts.json || !outputFormats.includes(opts.format as OutputFormat) ? 'json' : opts.format as OutputFormat
  return new CliOutput(format, Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY),
    Boolean(opts.json || app.getOptionValueSource('format') === 'cli'))
}
function parsedCommandPath() {
  const parts: string[] = []
  let command = app
  while (true) {
    const next = command.commands.find(child => child.name() === command.args[0] || child.aliases().includes(command.args[0]))
    if (!next) return parts.join(' ')
    parts.push(next.name())
    command = next
  }
}

function selectedContext() {
  const options = app.opts<{ profile: string }>()
  return context('production', options.profile)
}
async function emit(value: unknown, stream = false) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(stream ? output().event(value) : output().result(value), (err) => err ? reject(err) : resolve())
  })
}
function message(value: string, details?: Record<string, unknown>) { process.stderr.write(output().progress(value, details)) }
async function ask(prompt: string) {
  const renderer = output()
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: renderer.human })
  const cancelled = new Promise<never>((_resolve, reject) => {
    const cancel = () => reject(new RsqError('CANCELLED', '操作已取消。', 130))
    rl.once('close', cancel)
    rl.once('SIGINT', cancel)
  })
  if (!renderer.human) process.stderr.write(renderer.prompt(prompt))
  try { return (await Promise.race([rl.question(renderer.human ? renderer.prompt(prompt) : ''), cancelled])).trim() } finally { rl.close() }
}
async function passwordPrompt(): Promise<string> {
  const stdin = process.stdin
  return new Promise((resolve, reject) => {
    let value = ''
    const original = stdin.isRaw
    const done = (error?: RsqError) => {
      stdin.off('data', receive)
      stdin.off('end', ended)
      stdin.setRawMode(original)
      stdin.pause()
      if (output().human) process.stderr.write('\n')
      if (error) reject(error); else resolve(value)
    }
    const ended = () => done(new RsqError('CANCELLED', '登录已取消。', 130))
    const receive = (buffer: Buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return ended()
        if (char === '\r' || char === '\n') return done()
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('')
        else if (char >= ' ') value += char
      }
    }
    process.stderr.write(output().prompt('日事清密码：'))
    stdin.setRawMode(true)
    stdin.on('data', receive)
    stdin.once('end', ended)
    stdin.resume()
  })
}

configureBuiltin(app.command('upgrade'), 'upgrade').action(async (options: UpgradeOptions) => {
  const stop = new AbortController(), onInterrupt = () => stop.abort()
  process.once('SIGINT', onInterrupt)
  try { await emit(await upgradeRelease(options, { signal: stop.signal, confirm: async plan => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return false
    message((plan.rollback ? '回滚' : '升级') + ' rsq：' + plan.currentVersion + ' → ' + plan.targetVersion)
    return ['y', 'yes'].includes((await ask('确认执行？[y/N]：')).trim().toLowerCase())
  } })) } finally { process.off('SIGINT', onInterrupt) }
})

configureBuiltin(app.command('login'), 'login')
  .action(async (options: { method?: string; browser: boolean; username?: string; passwordStdin?: boolean }) => {
    const ctx = selectedContext()
    let method = options.method
    if (!method && process.stdin.isTTY) {
      message('登录日事清\n  1. 企业微信扫码\n  2. 日事清账号密码\n  3. 钉钉扫码')
      while (!method) {
        const choice = await ask('选择登录方式 [1/2/3]：')
        if (choice === '1' || choice === 'wecom') method = 'wecom'
        else if (choice === '2' || choice === 'password') method = 'password'
        else if (choice === '3' || choice === 'dingtalk') method = 'dingtalk'
        else message('请输入 1、2 或 3，按 Ctrl+C 取消。')
      }
    }
    if (method !== 'wecom' && method !== 'password' && method !== 'dingtalk') throw new RsqError('INVALID_LOGIN_METHOD', '请选择 --method wecom、password 或 dingtalk。', 2)
    if (method !== 'password' && (options.username || options.passwordStdin)) throw new RsqError('INVALID_INPUT', '扫码登录不接受账号密码参数。', 2)
    if (method === 'password' && !options.browser) throw new RsqError('INVALID_INPUT', '--no-browser 仅适用于扫码登录。', 2)
    if (method === 'password' && (!process.stdin.isTTY && (!options.username || !options.passwordStdin))) {
      throw new RsqError('INVALID_INPUT', '非交互登录需要 --username 和 --password-stdin。', 2)
    }
    if (method === 'password' && options.passwordStdin && (!options.username || process.stdin.isTTY)) {
      throw new RsqError('INVALID_INPUT', '--password-stdin 需要通过管道提供密码，并指定 --username。', 2)
    }
    const stop = new AbortController()
    const onInterrupt = () => stop.abort()
    process.once('SIGINT', onInterrupt)
    try {
      const session = method !== 'password'
        ? await (method === 'wecom' ? loginWecom : loginDingtalk)(ctx, {
          signal: stop.signal,
          notify: url => {
            message('请在浏览器用' + (method === 'wecom' ? '企业微信' : '钉钉') + '扫码并确认登录：\n' + url + '\n\n若浏览器未打开，可复制以上链接。', { verificationUri: url })
            if (options.browser) openBrowser(url)
          },
        })
        : await loginPassword(ctx, options.username ?? await ask('日事清账号：'),
          options.passwordStdin ? (await readStdin(4096)).replace(/\r?\n$/, '') : await passwordPrompt())
      await saveSession(ctx, session)
      await emit(status(ctx, session))
    } finally { process.off('SIGINT', onInterrupt) }
  })

configureBuiltin(app.command('auth').description('查看登录状态').command('status'), 'auth status')
  .action(async () => {
    const ctx = selectedContext()
    await emit(status(ctx, await loadSession(ctx)))
  })
configureBuiltin(app.command('whoami'), 'whoami').action(async () => {
  const ctx = selectedContext()
  const session = requireSession(await loadSession(ctx))
  await emit({ ...ctx, method: session.method, identity: await whoami(ctx, session) })
})
configureBuiltin(app.command('logout'), 'logout').action(async () => {
  const ctx = selectedContext()
  await removeSession(ctx)
  await emit({ ...ctx, state: 'missing' })
})
app.command('skill').description('输出随包 Agent Skill 的位置与正文').action(async () => {
  const location = new URL('../skills/rsq-cli/SKILL.md', import.meta.url)
  await emit({ name: 'rsq-cli', path: fileURLToPath(location), content: readFileSync(location, 'utf8') })
})
app.command('coverage [domain] [capability]')
  .description('查看业务流程；--core 为本阶段冻结的主流程，默认保留完整细分账本')
  .option('--core', '查看当前交付阶段的主要业务闭环、通过记录、剩余模块和阻塞')
  .action(async (domain: string | undefined, capability: string | undefined, options: { core?: boolean }) => emit(options.core
    ? mainFlowCoverage([...workflows.workflows, ...catalog.operations], domain, capability)
    : { ...businessCoverage(domain, capability), currentStage: { command: 'rsq coverage --core', details: '本阶段按主要业务闭环交付；完整细分账本继续保留。' } }))

function summary(op: Operation) {
  return { id: op.id, command: op.command, description: op.description, effect: op.effect, methods: op.methods, review: op.review, executable: op.review === 'reviewed' && !op.requiresBusinessContext?.length, ...(op.requiresBusinessContext && { contextCommands: op.requiresBusinessContext }), ...(op.coverageScope && { coverageScope: op.coverageScope }) }
}
const moduleDescriptions: Record<string, string> = {
  task: '任务', project: '项目', doc: '文档', contact: '通讯录', file: '文件',
  workflow: '流程：应用、分组、步骤、审批、表单和统计',
  appraisal: '绩效：考核、指标、评分、模板和统计',
  okr: 'OKR：目标、关键结果、周期、对齐和指标',
  action: '行动：视图、分组、任务和导出',
  execution: '执行台：视图、分组、待办和显示字段',
  replay: '复盘：复盘集、模板、正文、审核、统计和智能规则',
  organization: '公司：组织目录、创建、会话切换及公司资料',
}
function leaf(op: Operation) {
  return {
    ...summary(op),
    access: accessDescription(op),
    confirmation: op.effect === 'destructive' ? 'required' : 'not_required',
    idempotency: op.idempotency,
    transport: { service: op.service, method: op.method, route: op.route, auth: op.auth, encoding: op.encoding ?? 'json', queryArray: op.queryArray ?? 'brackets' },
    parameters: Object.fromEntries(op.fields.map(({ option, ...field }) => [option, field])),
    inputSchema: op.inputSchema, ...(op.defaults && { fixedInput: op.defaults }), response: op.response,
    responseSchema: op.responseSchema, examples: op.examples,
    ...(op.outputFields && { outputFields: op.outputFields, outputNote: '仅输出这些字段；临时凭证只供业务编排内部使用。' }),
    business: operationBusinessContext(op),
    ...(op.requiresBusinessContext && { directExecution: false, contextCommands: op.requiresBusinessContext }),
  }
}
app.command('schema [path...]')
  .description('离线查看模块、操作和参数；例如 rsq schema "task get"')
  .option('--all', '导出完整操作契约')
  .action(async (path: string[], options: { all?: boolean }) => {
    const emitSchema = (value: object) => emit({ ...value, agentSkill: agentSkillPath, globalParameters, output: outputContract })
    const prefix = (path ?? []).join(' ').trim().replace(/\s+/g, ' ')
    if (options.all && prefix) throw new RsqError('INVALID_INPUT', '--all 不接受命令路径。', 2)
    const operations = catalog.operations
    if (options.all) return emitSchema({ version: catalog.version, baseline: catalog.baseline, operations: operations.map(leaf), workflows: workflows.workflows.map(workflowSchema), builtins: builtinCommands })
    if (!prefix) {
      const modules = new Map<string, { count: number; executable: number }>()
      for (const op of operations) {
        const group = op.command.split(' ')[0]
        const entry = modules.get(group) ?? { count: 0, executable: 0 }
        entry.count++; if (op.review === 'reviewed' && !op.requiresBusinessContext?.length) entry.executable++
        modules.set(group, entry)
      }
      for (const flow of workflows.workflows) {
        const group = flow.command.split(' ')[0], entry = modules.get(group) ?? { count: 0, executable: 0 }
        entry.count++; if (workflowSchema(flow).executable) entry.executable++
        modules.set(group, entry)
      }
      for (const builtin of builtinCommands) {
        const group = builtin.command.split(' ')[0], entry = modules.get(group) ?? { count: 0, executable: 0 }
        entry.count++; entry.executable++; modules.set(group, entry)
      }
      return emitSchema({ version: catalog.version, baseline: catalog.baseline,
        coverage: { status: businessScope.status, countsAreExhaustive: false, scope: businessScope.scope, details: 'rsq coverage --core', detailed: 'rsq coverage', stage: 'core-http-v1' },
        modules: [...modules].map(([name, value]) => ({ name, description: moduleDescriptions[name] ?? name, ...value, blocked: value.count - value.executable })) })
    }
    const builtin = builtinCommands.find(command => command.command === prefix || command.id === prefix)
    if (builtin) return emitSchema({ version: catalog.version, ...builtin })
    const exactFlow = workflows.workflows.find(flow => flow.command === prefix || flow.id === prefix)
    if (exactFlow) return emitSchema({ version: workflows.version, ...workflowSchema(exactFlow) })
    const exact = operations.find(op => op.command === prefix || op.id === prefix)
    if (exact) return emitSchema({ version: catalog.version, ...leaf(exact) })
    const subset = operations.filter(op => op.command.startsWith(prefix + ' '))
    const flowSubset = workflows.workflows.filter(flow => flow.command.startsWith(prefix + ' '))
    const builtinSubset = builtinCommands.filter(command => command.command.startsWith(prefix + ' '))
    if (subset.length || flowSubset.length || builtinSubset.length) return emitSchema({ version: catalog.version, path: prefix, operations: subset.map(summary), workflows: flowSubset.map(workflowSchema), builtins: builtinSubset })
    throw new RsqError('UNKNOWN_OPERATION', '找不到该命令或模块。请运行 rsq schema。', 2)
  })

const groups = new Map<string, Command>([['', app]])
for (const op of catalog.operations) {
  const parts = op.command.split(' ')
  let prefix = ''
  let parent = app
  for (const part of parts.slice(0, -1)) {
    const key = prefix ? prefix + ' ' + part : part
    let group = groups.get(key)
    if (!group) {
      group = parent.command(part).description(moduleDescriptions[part] ?? part + ' 业务接口').showHelpAfterError(false)
      groups.set(key, group)
    }
    parent = group
    prefix = key
  }
  const command = parent.command(parts.at(-1)!)
    .description((op.review === 'inferred' ? '[待核对，仅 dry-run] ' : '') + op.description)
    .option('--input <file|->', '传入按 Schema 分组的 JSON')
    .option('--dry-run', '验证输入并预览请求，不访问网络')
  if (op.effect === 'destructive') command.option('--yes', '明确确认执行不可逆操作')
  if (op.response === 'binary') command.option('--output <file>', '下载保存位置')
  for (const field of op.fields) command.option('--' + field.option + ' <value>', field.schema.description ?? field.in + '.' + field.name)
  command.addHelpText('after', '\nSchema: rsq schema "' + op.command + '"\n' + op.examples.join('\n'))
  command.action(async (opts: Record<string, string | boolean | undefined>) => {
    const ctx = selectedContext()
    let input: JsonObject = {}
    if (typeof opts.input === 'string') {
      let value: unknown
      try { value = await readJson(opts.input) } catch (error) {
        if (error instanceof RsqError) throw error
        throw new RsqError('INVALID_INPUT', '无法读取或解析 JSON 输入。', 2)
      }
      if (asObject(value) !== value) throw new RsqError('INVALID_INPUT', '输入必须是 JSON 对象。', 2)
      input = value as JsonObject
    }
    for (const field of op.fields) {
      const opt = field.option.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())
      const value = opts[opt]
      if (typeof value === 'string') assignField(input, field, flagValue(field, value, op.inputSchema))
    }
    let approved = Boolean(opts.yes)
    if (op.effect === 'destructive' && !opts.dryRun && !approved && process.stdin.isTTY && process.stderr.isTTY) {
      // Validate and show the plan before asking about an irreversible operation.
      const preview = await runOperation(ctx, op, input, null, { dryRun: true })
      process.stderr.write(output().preview(preview))
      approved = await ask('确认执行？输入 yes：') === 'yes'
    }
    const session = opts.dryRun || op.auth === 'none' ? null : await loadSession(ctx)
    const result = await runOperation(ctx, op, input, session, { dryRun: Boolean(opts.dryRun), approved, out: typeof opts.output === 'string' ? opts.output : undefined, emit: value => emit(value, true) })
    if (result !== undefined) await emit(opts.dryRun ? result : operationOutput(op, result))
  })
}

for (const flow of workflows.workflows) {
  const parts = flow.command.split(' ')
  let parent = app, prefix = ''
  for (const part of parts.slice(0, -1)) {
    const key = prefix ? prefix + ' ' + part : part
    let group = groups.get(key)
    if (!group) { group = parent.command(part).description(moduleDescriptions[part] ?? part + ' 业务'); groups.set(key, group) }
    parent = group; prefix = key
  }
  const command = parent.command(parts.at(-1)!).description(flow.description)
    .option('--input <file|->', '按业务 Schema 提供 JSON 参数')
    .option('--dry-run', '离线预览步骤与待解析上下文，不访问网络')
  if (flow.effect === 'destructive') command.option('--yes', '明确确认执行不可逆操作')
  for (const field of flow.parameters) command.option('--' + field.option + ' <value>', field.schema.description ?? field.name)
  command.addHelpText('after', '\nSchema: rsq schema "' + flow.command + '"\n' + flow.examples.join('\n'))
  command.action(async (opts: Record<string, string | boolean | undefined>) => {
    let input: JsonObject = {}
    if (typeof opts.input === 'string') {
      try {
        const value = await readJson(opts.input)
        if (asObject(value) !== value) throw new RsqError('INVALID_INPUT', '业务输入必须是 JSON 对象。', 2)
        input = value as JsonObject
      } catch (error) { if (error instanceof RsqError) throw error; throw new RsqError('INVALID_INPUT', '无法读取或解析 JSON 输入。', 2) }
    }
    for (const field of flow.parameters) {
      const key = field.option.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())
      if (typeof opts[key] === 'string') {
        if (Object.hasOwn(input, field.name)) throw new RsqError('DUPLICATE_INPUT', '业务参数重复：' + field.option, 2)
        input[field.name] = flagValue({ ...field, in: 'body' }, opts[key] as string, flow.inputSchema)
      }
    }
    const ctx = selectedContext()
    let approved = Boolean(opts.yes)
    if (flow.effect === 'destructive' && !opts.dryRun && !approved && process.stdin.isTTY && process.stderr.isTTY) {
      process.stderr.write(output().preview(await runWorkflow(ctx, flow, input, null, { dryRun: true })))
      approved = await ask('确认执行？输入 yes：') === 'yes'
    }
    await emit(await runWorkflow(ctx, flow, input, opts.dryRun ? null : await loadSession(ctx), { dryRun: Boolean(opts.dryRun), approved }))
  })
}

try {
  if (process.argv.length <= 2) app.outputHelp()
  else await app.parseAsync()
} catch (e) {
  if (e instanceof CommanderError && e.exitCode === 0) process.exitCode = 0
  else {
    const diagnostic = cliDiagnostic(e, app.opts<{ profile: string }>().profile, activeCommand || parsedCommandPath())
    process.stderr.write(output().diagnostic(diagnostic))
    process.exitCode = diagnostic.exit
  }
}
