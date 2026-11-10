import type { Command } from 'commander'
import type { JsonObject } from './core.js'
import { outputFormats } from './output.js'

export const globalParameters = {
  profile: { type: 'string', default: 'default', option: '--profile', description: '命名本地身份；不从另一个 profile 借用凭证。' },
  format: { type: 'string', enum: outputFormats, default: 'json', option: '--format', description: '结果格式：json、pretty、table 或 ndjson；显式 json 同时强制机器诊断。' },
  json: { type: 'boolean', default: false, option: '--json', description: '等同 --format json，终端错误也使用 JSON。' },
}

type Option = { flags: string; description: string; parameter: string; schema: JsonObject; presentValue?: boolean }
type Builtin = { command: string; description: string; effect: 'read' | 'write'; localOnly: boolean; requiresSession: boolean; options: Option[]; limitations: string[]; examples: string[] }
const definitions: Builtin[] = [
  { command: 'upgrade', description: '从 GitHub Releases 检查、安装更新或回滚', effect: 'write', localOnly: false, requiresSession: false, options: [
    { flags: '--check', description: '只检查更新', parameter: 'check', schema: { type: 'boolean', default: false }, presentValue: true },
    { flags: '--list', description: '列出已发布版本', parameter: 'list', schema: { type: 'boolean', default: false }, presentValue: true },
    { flags: '--version <version>', description: '选择指定 Release 版本', parameter: 'version', schema: { type: 'string' } },
    { flags: '--rollback', description: '回滚到上一次安装版本', parameter: 'rollback', schema: { type: 'boolean', default: false }, presentValue: true },
    { flags: '--force', description: '重新安装所选版本', parameter: 'force', schema: { type: 'boolean', default: false }, presentValue: true },
    { flags: '-y, --yes', description: '确认升级或回滚', parameter: 'yes', schema: { type: 'boolean', default: false }, presentValue: true },
  ], limitations: ['从 rishiqing/rsq-cli 的 GitHub Release 下载，不使用 npm；不发送日事清凭证。', '检查和列版本不改变本地安装；升级、指定版本及回滚需要确认，脚本带 --yes。', '先下载、校验 SHA256 并核对版本，再原子切换；保留上一次版本用于回滚。会话保存在独立目录。', '仅安装脚本管理的安装支持原地更新。随包 Skill 与 CLI 一起切换；通过 schema 返回的 agentSkill 查找当前 Skill。'], examples: ['rsq upgrade --check', 'rsq upgrade --list', 'rsq upgrade --yes', 'rsq upgrade --version 0.1.0-preview.1 --yes', 'rsq upgrade --rollback --yes'] },
  { command: 'login', description: '使用企业微信或日事清账号密码登录', effect: 'write', localOnly: false, requiresSession: false, options: [
    { flags: '--method <method>', description: 'wecom 或 password；非交互调用必须指定', parameter: 'method', schema: { enum: ['wecom', 'password'] } },
    { flags: '--no-browser', description: '显示企微登录链接，不尝试打开浏览器', parameter: 'browser', schema: { type: 'boolean', default: true }, presentValue: false },
    { flags: '--username <name>', description: '日事清账号；仅用于 password', parameter: 'username', schema: { type: 'string', minLength: 1 } },
    { flags: '--password-stdin', description: '从管道标准输入读取密码；须同时指定 --username', parameter: 'passwordStdin', schema: { type: 'boolean', default: false }, presentValue: true },
  ], limitations: ['交互终端省略 method 时选择企业微信或账号密码。', '脚本账号密码登录必须指定 method=password、username、password-stdin，stdin 仅传密码文本，不传 JSON。密码不作为普通选项或输入文件保存。', '企业微信通过浏览器扫码并确认登录。no-browser 仅停止自动打开浏览器，链接可复制到另一台机器。CLI 轮询并一次性领取会话。', 'no-browser 只用于企业微信。登录链接走 stderr；令牌和 Cookie 不出现在链接、页面或输出中。', '会话按 profile 隔离，以用户专属权限原子保存；登录保留原有业务权限。'], examples: ['rsq login', 'rsq login --method wecom --no-browser --profile work', 'rsq login --method password --username <账号> --password-stdin --profile work'] },
  { command: 'auth status', description: '查看本地会话，不访问网络', effect: 'read', localOnly: true, requiresSession: false, options: [], limitations: ['只报告 missing/expired/active 及本地身份，不证明服务端会话有效；随后 whoami 核对。'], examples: ['rsq auth status --profile work', 'rsq whoami --profile work'] },
  { command: 'whoami', description: '核对当前日事清账号和组织', effect: 'write', localOnly: false, requiresSession: true, options: [], limitations: ['通过当前身份对应服务的 authAjax 核对用户与组织；此旧接口可能初始化会话数据，保守按写副作用声明。', '输出仅身份和 profile，不输出服务端令牌或 Cookie。'], examples: ['rsq whoami --profile work'] },
  { command: 'logout', description: '清除当前 profile 的本地会话', effect: 'write', localOnly: true, requiresSession: false, options: [], limitations: ['删除当前 profile 的本地凭证文件；不注销组织、不撤销其他终端或其他 profile。'], examples: ['rsq logout --profile work'] },
]
export const builtinCommands = definitions.map(definition => ({
  id: 'builtin.' + definition.command.replaceAll(' ', '.'), kind: 'builtin', command: definition.command, description: definition.description,
  executable: true, review: 'reviewed', effect: definition.effect, methods: ['password', 'wecom'], localOnly: definition.localOnly, requiresSession: definition.requiresSession,
  supportsDryRun: false, inputMode: definition.command === 'login' ? 'flags-and-hidden-terminal-or-password-stdin' : 'flags', inputFileSupported: false,
  parameters: Object.fromEntries(definition.options.map(option => [option.parameter, { ...option.schema, option: option.flags.includes(', ') ? option.flags.split(', ')[1].split(' ')[0] : option.flags.split(' ')[0], description: option.description, ...(option.presentValue !== undefined && { presentValue: option.presentValue }) }])),
  globalParameters,
  inputSchema: { type: 'object', properties: Object.fromEntries(definition.options.map(option => [option.parameter, option.schema])), additionalProperties: false },
  ...(definition.command === 'login' && { nonInteractive: { required: ['method'], byMethod: { wecom: { forbiddenOptions: ['username', 'passwordStdin'] }, password: { required: ['username', 'passwordStdin'], requiredValues: { passwordStdin: true, browser: true }, stdin: 'password-text-from-pipe; max4096bytes; one-trailing-newline-removed', passwordSaved: false } } } }),
  resultSchema: definition.command === 'upgrade' ? { type: 'object', properties: { status: { type: 'string' }, currentVersion: { type: 'string' }, targetVersion: { type: 'string' }, skillPath: { type: 'string' }, versions: { type: 'array' } }, required: ['status', 'currentVersion'] } : definition.command === 'whoami' ? { type: 'object', properties: { profile: { type: 'string' }, method: { enum: ['password', 'wecom'] }, identity: { type: 'object', properties: { userId: { type: 'string' }, teamId: { type: 'string' }, username: { type: 'string' } }, required: ['userId', 'username'] } }, required: ['profile', 'method', 'identity'] } : { type: 'object', properties: { profile: { type: 'string' }, state: { enum: definition.command === 'login' ? ['active'] : definition.command === 'logout' ? ['missing'] : ['missing', 'expired', 'active'] }, method: { enum: ['password', 'wecom'] }, expiresAt: { type: 'string' }, identity: { type: 'object' } }, required: ['profile', 'state'] },
  transport: definition.command === 'upgrade' ? ['GET https://raw.githubusercontent.com/rishiqing/rsq-cli/main/latest.json', 'GET https://api.github.com/repos/rishiqing/rsq-cli/releases', 'GET https://github.com/rishiqing/rsq-cli/releases/download/{tag}/{asset}'] : definition.command === 'login' ? { password: ['POST /task/j_spring_security_check', 'GET /task/login/authAjax'], wecom: ['POST /qywxbackauth/cli-auth/device', 'POST /qywxbackauth/cli-auth/exchange', 'GET /task/login/authAjax'] } : definition.command === 'whoami' ? ['GET /task/login/authAjax'] : [],
  limitations: definition.limitations, examples: definition.examples, relatedCommands: definitions.filter(row => row.command !== definition.command).map(row => row.command),
}))
export function configureBuiltin(command: Command, name: string) {
  const definition = definitions.find(row => row.command === name)
  if (!definition) throw Error('Unknown builtin: ' + name)
  command.description(definition.description)
  for (const option of definition.options) command.option(option.flags, option.description)
  command.addHelpText('after', '\nSchema: rsq schema "' + name + '"\n' + definition.limitations.join('\n'))
  return command
}
