import { CommanderError } from 'commander'
import { RsqError } from './core.js'

export type CliDiagnostic = {
  exit: number
  error: { code: string; message: string; reason?: string; hint?: string; actions?: string[]; details?: Record<string, unknown> }
}

export function cliDiagnostic(value: unknown, profile = 'default', command = ''): CliDiagnostic {
  const profileOption = profile !== 'default' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile) ? ' --profile ' + profile : ''
  const login = 'rsq login' + profileOption
  const help = command ? 'rsq ' + command + ' --help' : 'rsq --help'
  const schema = command ? 'rsq schema "' + command + '"' : 'rsq schema'
  const access = 'rsq organization access inspect' + profileOption
  if (value instanceof CommanderError) {
    // Commander may include an argument value in its message. Only retain a
    // validated option name, never the original message or raw argv.
    const option = value.message.match(/option '(-{1,2}[A-Za-z][A-Za-z0-9-]{0,63})/u)?.[1]
    if (value.code === 'commander.unknownOption') return { exit: 2, error: {
      code: 'USAGE_ERROR', reason: 'unknown_option', message: option ? '无法识别参数 ' + option + '。' : '无法识别该参数。',
      hint: option === '--login' ? '登录使用子命令 rsq login；--login 不是登录参数。' : option === '--password' ? '密码不能作为命令行参数传入，请使用隐藏输入或 --password-stdin。' : '运行 rsq --help 或对应命令的 --help 查看可用参数。',
      actions: option === '--login' ? [login, login + ' --method password'] : option === '--password' ? [login + ' --method password', login + ' --help'] : [help, schema],
    } }
    return { exit: 2, error: {
      code: 'USAGE_ERROR', reason: value.code.replace(/^commander\./u, ''),
      message: value.code === 'commander.unknownCommand' ? '无法识别该子命令。'
        : value.code === 'commander.optionMissingArgument' ? (option ? '参数 ' + option + ' 缺少取值。' : '命令参数缺少取值。')
          : value.code === 'commander.invalidArgument' && option ? '参数 ' + option + ' 的取值不正确。'
          : value.code === 'commander.missingArgument' ? '缺少必需参数。' : '命令或参数不正确。',
      hint: '运行 rsq --help 或对应命令的 --help 查看用法；业务参数可通过 rsq schema 发现。',
      actions: [help, schema],
    } }
  }
  const error = value instanceof RsqError ? value : new RsqError('UNEXPECTED_ERROR', '命令未能完成。')
  const networkHint = error.details?.reason === 'proxy_configuration' ? '代理地址须为 http:// 或 https:// URL；检查 HTTP_PROXY、HTTPS_PROXY 或对应小写变量。'
    : error.details?.reason === 'proxy_auth' ? '检查代理账号和密码，或联系代理管理员；不要把代理凭证发送到反馈中。'
      : error.details?.reason === 'proxy_http' ? '检查代理的访问规则和服务状态，或联系代理管理员。'
        : error.details?.reason === 'tls' ? '检查系统时间及代理证书；企业自签证书可通过 NODE_EXTRA_CA_CERTS 配置可信 CA。'
          : error.details?.reason === 'dns' ? '检查域名解析和代理地址；代理变量支持 HTTP_PROXY、HTTPS_PROXY 及小写形式。'
            : error.details?.reason === 'http' ? '检查 GitHub 访问权限或服务状态，稍后运行 rsq upgrade 重试。'
              : '检查网络及代理服务；支持 HTTP_PROXY、HTTPS_PROXY 和小写形式，NO_PROXY/no_proxy 可指定直连主机。'
  const recovery: Record<string, { message?: string; hint: string; actions: string[] }> = {
    WECOM_LOGIN_UNAVAILABLE: { message: '企业微信 CLI 登录服务当前不可用，本次登录未完成。', hint: '请稍后重新发起企业微信登录，使用新生成的链接；也可改用日事清账号密码登录。', actions: [login + ' --method wecom', login + ' --method password', login + ' --help'] },
    DINGTALK_LOGIN_UNAVAILABLE: { message: '钉钉 CLI 登录服务当前不可用，本次登录未完成。', hint: '请稍后重新发起钉钉登录，使用新生成的链接；也可改用日事清账号密码登录。', actions: [login + ' --method dingtalk', login + ' --method password', login + ' --help'] },
    FEISHU_LOGIN_UNAVAILABLE: { message: '飞书 CLI 登录服务当前不可用，本次登录未完成。', hint: '请稍后重新发起飞书登录，使用新生成的链接；也可改用日事清账号密码登录。', actions: [login + ' --method feishu', login + ' --method password', login + ' --help'] },
    WPS_LOGIN_UNAVAILABLE: { message: 'WPS CLI 登录服务当前不可用，本次登录未完成。', hint: '请稍后重新发起WPS登录，使用新生成的链接；也可改用日事清账号密码登录。', actions: [login + ' --method wps', login + ' --method password', login + ' --help'] },
    INVALID_LOGIN_METHOD: { hint: '交互登录运行 rsq login；脚本调用需显式指定 --method password、wecom、dingtalk、feishu 或 wps。', actions: [login, login + ' --help'] },
    LOGIN_FAILED: { hint: '请核对日事清账号密码；终端中密码为隐藏输入，脚本通过 --password-stdin 提供。', actions: [login + ' --method password'] },
    AUTH_REQUIRED: { hint: '请先登录当前 profile，再重新核对身份；写操作失败后先查结果，不直接重复提交。', actions: [login, 'rsq whoami' + profileOption] },
    LOGIN_EXPIRED: { hint: '本次浏览器登录已过期，请重新发起登录。', actions: [login] },
    FORBIDDEN: { hint: '请核对当前身份、组织及资源权限；不要绕过权限限制。', actions: ['rsq whoami' + profileOption, access] },
    FEATURE_FORBIDDEN: { hint: '当前公司角色没有此功能权限，请联系管理员确认。', actions: [access] },
    FEATURE_DISABLED: { hint: '当前公司未开通所需功能，请联系管理员确认套餐。', actions: [access] },
    FEATURE_UPGRADE_REQUIRED: { hint: '当前套餐不支持所需功能，请联系管理员确认。', actions: [access] },
    COMPANY_EXPIRED: { hint: '请联系管理员处理公司到期状态；确认前不要继续业务写入。', actions: [access] },
    COMPANY_OVER_CAPACITY: { hint: '请联系管理员处理超员状态；确认前不要继续业务写入。', actions: [access] },
    UPDATE_UNAVAILABLE: { hint: networkHint, actions: ['rsq upgrade'] },
    INVALID_PROXY_CONFIG: { message: '代理地址配置无效。', hint: networkHint, actions: [help] },
    CONFIRMATION_REQUIRED: { hint: '先用 --dry-run 核对影响，已获授权的非交互写入需加 --yes。', actions: [schema, help] },
    NETWORK_ERROR: { hint: networkHint + ' 写操作可能已发出，先按资源 ID 读回结果，不直接重复提交。', actions: [schema] },
    TIMEOUT: { hint: '请求可能已生效，先按资源 ID 读回结果，再决定下一步。', actions: [schema] },
    CANCELLED: { hint: '操作已停止；若已有写入步骤，请先核对返回的资源和结果。', actions: [schema] },
  }
  return { exit: error.exit, error: { code: error.code, message: error.message,
    ...(recovery[error.code] ?? { hint: '按当前命令的 Schema 和帮助核对参数；失败包含执行信息时，先核对已完成步骤和资源。', actions: [schema, help] }),
    ...(error.details && { details: error.details }) } }
}

export function renderCliDiagnostic(diagnostic: CliDiagnostic, human: boolean): string {
  if (!human) return JSON.stringify({ error: diagnostic.error }) + '\n'
  const { code, message, hint, actions, details } = diagnostic.error
  return ['错误 [' + code + ']：' + message, ...(hint ? ['提示：' + hint] : []),
    ...(actions?.length ? ['下一步：', ...actions.map(action => '  ' + action)] : []),
    ...(details ? ['执行信息：', JSON.stringify(details, null, 2)] : []), ''].join('\n')
}
