import { RsqError } from './core.js'
import { renderCliDiagnostic, type CliDiagnostic } from './cli-errors.js'

export const outputFormats = ['json', 'pretty', 'table', 'ndjson'] as const
export type OutputFormat = typeof outputFormats[number]
export const outputContract = {
  defaultFormat: 'json', formats: outputFormats, option: '--format',
  stdout: '业务结果；JSON 默认单行，pretty 为缩进 JSON，table 为完整表格，ndjson 将顶层数组逐项输出。HTTP 事件流始终使用 NDJSON。',
  stderr: '错误、进度、确认预览及提示；交互终端默认可读，默认非交互调用或显式 --format json/ndjson 使用 JSON 事件行。',
  errors: { root: 'error', fields: ['code', 'message', 'reason', 'hint', 'actions', 'details'], exitCode: '原有退出码保留；details 保留部分成功步骤、资源 ID 和未知结果。' },
}

function json(value: unknown, pretty = false): string {
  const text = JSON.stringify(value, null, pretty ? 2 : undefined)
  if (text === undefined) throw new RsqError('OUTPUT_ERROR', '命令没有返回可输出的业务结果。', 6)
  return text
}
function safeText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
}
function cell(value: unknown): string {
  return safeText(typeof value === 'string' ? json(value).slice(1, -1) : value === undefined ? '' : json(value))
}
function width(text: string): number {
  return [...text].reduce((sum, char) => sum + (/\p{Mark}/u.test(char) ? 0
    : /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(char) ? 2 : 1), 0)
}
function table(value: unknown): string {
  let headers: string[], rows: string[][]
  if (Array.isArray(value)) {
    if (!value.length) return '（空列表）\n'
    if (value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) {
      const keys = [...new Set(value.flatMap(row => Object.keys(row)))]
      headers = keys.map(cell)
      rows = value.map(row => keys.map(key => cell(row[key])))
    } else { headers = ['值']; rows = value.map(item => [cell(item)]) }
  } else if (value !== null && typeof value === 'object') {
    headers = ['字段', '值']; rows = Object.entries(value).map(([key, item]) => [cell(key), cell(item)])
  } else { headers = ['值']; rows = [[cell(value)]] }
  if (!headers.length) return json(value, true) + '\n'
  const sizes = headers.map((header, index) => rows.reduce((size, row) => Math.max(size, width(row[index])), width(header)))
  const line = (row: string[]) => '| ' + row.map((value, index) => value + ' '.repeat(sizes[index] - width(value))).join(' | ') + ' |'
  const border = '+-' + sizes.map(size => '-'.repeat(size)).join('-+-') + '-+'
  return [border, line(headers), border, ...rows.map(line), border, ''].join('\n')
}

// All command families share this renderer. It never selects nested business
// fields, drops columns, truncates identifiers, or writes to a stream itself.
export class CliOutput {
  readonly human: boolean
  constructor(readonly format: OutputFormat, terminal: boolean, explicit: boolean) {
    this.human = format === 'pretty' || format === 'table' || (terminal && !explicit)
  }
  result(value: unknown): string {
    if (this.format === 'table') return table(value)
    if (this.format === 'ndjson' && Array.isArray(value)) return value.map(item => json(item) + '\n').join('')
    return json(value, this.format === 'pretty') + '\n'
  }
  event(value: unknown): string { return json(value) + '\n' }
  diagnostic(value: CliDiagnostic): string {
    const rendered = renderCliDiagnostic(value, this.human)
    return this.human ? safeText(rendered) : rendered
  }
  progress(message: string, details?: Record<string, unknown>): string {
    return this.human ? safeText(message) + '\n' : json({ type: 'progress', message, ...(details && { details }) }) + '\n'
  }
  preview(value: unknown): string {
    return this.human ? '执行预览：\n' + json(value, true) + '\n' : json({ type: 'preview', result: value }) + '\n'
  }
  prompt(message: string): string {
    return this.human ? safeText(message) : json({ type: 'prompt', message }) + '\n'
  }
}
