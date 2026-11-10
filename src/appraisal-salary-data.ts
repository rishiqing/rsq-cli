import Big from 'big.js'
import { asObject, RsqError, type JsonObject } from './core.js'
export const salaryInvalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
export function salaryCheck(value: unknown, message: string): asserts value { if (!value) throw new RsqError('BUSINESS_ASSERTION_FAILED', message, 5) }
export const salaryId = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : salaryInvalid('薪酬资源 ID 必须为精确正整数。')
export const salaryRows = (value: unknown, maximum = 10000): JsonObject[] => { salaryCheck(Array.isArray(value) && value.length <= maximum, '薪酬服务没有返回有界列表。'); return value.map(asObject) }
export const salaryName = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : salaryInvalid('薪酬名称必须为 1–100 个无控制字符的非空字符。')
const kinds = { month: 'monthly', quarter: 'quarter', halfYear: 'semiAnnual', year: 'annual' } as const
export function salaryPeriod(input: JsonObject) {
  const kind = String(input.periodType ?? 'month') as keyof typeof kinds
  if (!Object.hasOwn(kinds, kind)) salaryInvalid('请选择月、季度、半年或年薪酬周期。')
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date()), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7))
  const value = String(input.period ?? { month: today, quarter: `${year}-Q${Math.ceil(month / 3)}`, halfYear: `${year}-H${Math.ceil(month / 6)}`, year: String(year) }[kind])
  const patterns = { month: /^([1-9][0-9]{3})-(0[1-9]|1[0-2])$/, quarter: /^([1-9][0-9]{3})-Q([1-4])$/, halfYear: /^([1-9][0-9]{3})-H([12])$/, year: /^([1-9][0-9]{3})$/ }, match = patterns[kind].exec(value)
  if (!match) salaryInvalid('周期格式应与类型匹配：YYYY-MM、YYYY-Q1..Q4、YYYY-H1..H2 或 YYYY。')
  const y = Number(match![1]), ordinal = Number(match![2] ?? 1), max = { month: 12, quarter: 4, halfYear: 2, year: 1 }[kind]
  const code = (y: number, n: number): string => kind === 'month' ? `${y}-${String(n).padStart(2, '0')}` : kind === 'quarter' ? `${y}年${n}季度` : kind === 'halfYear' ? `${y}年${n === 1 ? '上' : '下'}半年` : `${y}年全年`
  return { kind, value, code: code(y, ordinal), apiType: kinds[kind], previousCode: code(ordinal === 1 ? y - 1 : y, ordinal === 1 ? max : ordinal - 1) }
}
export type SalaryField = { id: string; name: string; type: string; isSystem: boolean; isShow: boolean; displayOrder: number; from: string | null; formula: { id: string; text: string; factors: string[] } | null }
export function salaryFields(value: unknown): SalaryField[] {
  const fields = salaryRows(value).map(row => {
    salaryCheck(typeof row.name === 'string' && typeof row.type === 'string' && typeof row.isSystem === 'boolean' && typeof row.isShow === 'boolean' && typeof row.displayOrder === 'number' && Number.isFinite(row.displayOrder), '薪酬字段缺少类型、显示、系统或顺序信息。')
    const raw = row.formula == null ? null : asObject(row.formula)
    if (raw) salaryCheck(typeof raw.text === 'string' && Array.isArray(raw.factors) && raw.factors.every(factor => typeof factor === 'string'), '薪酬公式缺少真实文本和引用列表。')
    return { id: salaryId(row.id), name: row.name, type: row.type, isSystem: row.isSystem, isShow: row.isShow, displayOrder: row.displayOrder, from: typeof row.from === 'string' ? row.from : null,
      formula: raw == null ? null : { id: salaryId(raw.id), text: String(raw.text), factors: (raw.factors as string[]).filter(Boolean) } }
  })
  salaryCheck(new Set(fields.map(field => field.id)).size === fields.length && fields.every(field => field.type !== 'name'), '薪酬设置字段重复或错误包含固定姓名字段。')
  return fields
}
export function salaryGrid(value: unknown, fields: SalaryField[]) {
  const raw = asObject(value), columns = salaryRows(raw.header).map(row => {
    salaryCheck(row.r === 0 && Number.isSafeInteger(row.c) && Number(row.c) >= 0 && typeof row.v === 'string' && typeof row.type === 'string', '薪酬表头缺少真实坐标、名称或类型。')
    return { id: salaryId(row.id), name: String(row.v), type: String(row.type), column: Number(row.c) }
  })
  salaryCheck(new Set(columns.map(column => column.id)).size === columns.length && columns.every((column, index) => column.column === index) && columns.filter(column => column.type === 'name').length === 1, '薪酬表头重复、坐标不连续或姓名列不唯一。')
  const nameColumn = columns.find(column => column.type === 'name')!
  for (const column of columns) if (column.type !== 'name') salaryCheck(fields.some(field => field.id === column.id && field.type === column.type && field.name === column.name && field.isShow), '薪酬表头与已核对字段不符。')
  salaryCheck(fields.filter(field => field.isShow).length + 1 === columns.length, '薪酬表头遗漏可见字段。')
  const byRow = new Map<number, Map<string, JsonObject>>()
  for (const cell of salaryRows(raw.body, 250000)) {
    salaryCheck(Number.isSafeInteger(cell.r) && Number(cell.r) > 0 && Number.isSafeInteger(cell.c) && Number(cell.c) >= 0 && Number(cell.c) < columns.length && (cell.v == null || typeof cell.v === 'string' || typeof cell.v === 'number' && Number.isFinite(cell.v)), '薪酬单元格坐标或值无效。')
    const index = Number(cell.r), cells = byRow.get(index) ?? new Map(), fieldId = columns[Number(cell.c)].id
    salaryCheck(!cells.has(fieldId), '薪酬响应包含重复单元格。'); cells.set(fieldId, cell); byRow.set(index, cells)
  }
  const rows = [...byRow].sort(([a], [b]) => a - b).map(([index, cells], position) => {
    salaryCheck(index === position + 1 && cells.size === columns.length, '薪酬响应存在不完整行。')
    const name = cells.get(nameColumn.id)!; salaryCheck(name.userId != null, '薪酬姓名单元格没有公共公司用户 ID，不能从名称或行号猜用户。')
    return { userId: salaryId(name.userId), name: name.v == null ? null : String(name.v), cells: Object.fromEntries(columns.map(column => [column.id, cells.get(column.id)!.v ?? null])) }
  })
  salaryCheck(new Set(rows.map(row => row.userId)).size === rows.length, '薪酬数据有重复成员。')
  return { columns, rows }
}
export function salaryValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 22 || value !== '' && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) salaryInvalid('薪酬值须为最多 22 字符的十进制字符串；空字符串清空。')
  if (value !== '' && new Big(value as string).abs().gt('9999999999.9999999999')) salaryInvalid('薪酬数值超过当前 UI 的十位整数边界。')
  return value as string
}
export function salaryValueEqual(a: unknown, b: unknown) {
  if (a === b) return true
  try { if (a == null || b == null || a === '' || b === '') return false; return new Big(String(a)).eq(String(b)) } catch { return false }
}
export function salaryFormula(expression: unknown, fields: SalaryField[], target: SalaryField | null) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 10000 || /\$_|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(expression)) salaryInvalid('公式使用非空表达式及 {{字段ID}} 引用，不直接提交内部变量。')
  const factors: string[] = []
  let onlyText = String(expression), text = String(expression).replace(/\{\{([1-9][0-9]*)\}\}/g, (token, id: string) => {
    const field = fields.find(field => field.id === id && field.id !== target?.id && (target == null || field.isShow))
    if (!field) salaryInvalid('公式引用不属于本报表可选字段，或为自身/编辑时隐藏字段。')
    const factor = `$_field_${id}_$`; factors.push(factor); onlyText = onlyText.replace(token, field!.name); return factor
  })
  if (/[{}]/.test(text)) salaryInvalid('公式字段引用格式无效，请使用 context 中的字段 ID。')
  // No JavaScript evaluation. The same expression language remains on the
  // server; only field references and dependency cycles are checked locally.
  if (target) {
    const edges = new Map(fields.map(field => [field.id, field.id === target.id ? factors : field.type === 'formula' ? field.formula?.factors ?? [] : []]))
    const walk = (current: string, path: Set<string>): void => {
      if (path.has(current)) salaryInvalid('公式引用形成循环，请先调整依赖。')
      const next = new Set(path); next.add(current)
      for (const factor of edges.get(current) ?? []) { const match = /^\$_field_([1-9][0-9]*)_\$$/.exec(factor); if (match) walk(match[1], next) }
    }
    walk(target.id, new Set())
  }
  return { text, factors, onlyText }
}
