import Big from 'big.js'
import { asObject, RsqError, type JsonObject } from './core.js'
import { readXlsxFirstSheet } from './xlsx.js'
import { salaryInvalid as invalid, salaryId as id, salaryValue, type SalaryField, type salaryGrid } from './appraisal-salary-data.js'
export async function salaryImportPlan(file: string, input: JsonObject, fields: SalaryField[], grid: ReturnType<typeof salaryGrid>) {
  const workbook = await readXlsxFirstSheet(file), header = workbook.cells.filter(cell => cell.row === 1), byColumn = new Map<number, SalaryField>()
  const first = header.find(cell => cell.column === 1)
  if (!first || first.formula || !first.value) invalid('薪酬首表第一行须为表头，第一列为姓名；不把行号当用户。')
  for (const cell of header.filter(cell => cell.column > 1 && cell.value)) {
    const matches = fields.filter(field => field.type === 'num' && field.isShow && field.name === cell.value)
    if (cell.formula || matches.length !== 1 || [...byColumn.values()].some(field => field.id === matches[0].id)) invalid('导入列须唯一匹配本报表可见数字字段名称，不能导入系统/公式/隐藏字段。')
    byColumn.set(cell.column, matches[0])
  }
  if (!byColumn.size) invalid('文件没有本报表可导入的数字字段列。')
  const rowUsers = new Map<number, string>()
  for (const value of Array.isArray(input.rowUsers) ? input.rowUsers : []) {
    const row = asObject(value)
    if (!Number.isSafeInteger(row.row) || Number(row.row) < 2 || Number(row.row) > 10002 || rowUsers.has(Number(row.row))) invalid('显式行映射须使用不重复的 Excel 行号，从 2 开始。')
    const userId = id(row.userId)
    if (!grid.rows.some(row => row.userId === userId)) invalid('显式行映射不属于当前报表实际成员。')
    rowUsers.set(Number(row.row), userId)
  }
  const dataRows = new Map<number, typeof workbook.cells>()
  for (const cell of workbook.cells.filter(cell => cell.row > 1)) { const row = dataRows.get(cell.row) ?? []; row.push(cell); dataRows.set(cell.row, row) }
  const values: JsonObject[] = [], used = new Set<string>(), mapped = new Set<number>()
  let serverCompatible = rowUsers.size === 0
  for (const [rowNumber, cells] of [...dataRows].sort(([a], [b]) => a - b)) {
    if (!cells.some(cell => cell.value)) continue
    const label = cells.find(cell => cell.column === 1)
    if (label?.formula) invalid('姓名单元格不能使用工作簿公式。')
    const matches = grid.rows.filter(row => row.name === label?.value), explicit = rowUsers.get(rowNumber)
    if (!explicit && matches.length !== 1) throw new RsqError('AMBIGUOUS_RESOURCE', 'Excel 姓名不能唯一匹配当前报表成员；请用 rowUsers 显式绑定行号和公共用户 ID。', 2, { row: rowNumber, candidates: matches.map(row => row.userId) })
    const userId = explicit ?? matches[0].userId
    if (explicit) mapped.add(rowNumber)
    if (matches.length !== 1 || matches[0]?.userId !== userId) serverCompatible = false
    for (const cell of cells.filter(cell => cell.column > 1 && cell.value !== '')) {
      const field = byColumn.get(cell.column)
      if (!field || cell.formula || ['b', 'e', 'd'].includes(cell.type)) invalid('文件有未声明列、工作簿公式或非数值单元格；不会默默跳过。')
      let number: Big
      try { number = new Big(cell.value.trim().replace(/^\+/, '')) } catch { return invalid('薪酬导入单元格不是有效数字。') }
      if (number.abs().gt('9999999999.9999999999')) invalid('导入数值超过当前 UI 的十位整数边界。')
      const value = salaryValue(number.toFixed(2)), key = userId + ':' + field!.id
      if (used.has(key)) invalid('文件重复指定同一用户与字段单元格，不猜最后一条。')
      used.add(key); values.push({ userId, id: field!.id, value })
    }
  }
  if (rowUsers.size !== mapped.size) invalid('存在未对应实际非空 Excel 数据行的 rowUsers 映射。')
  if (!values.length || values.length > 100000) invalid('导入须包含 1–100000 个有效数值；空单元格跳过，不表示清空。')
  return { bytes: workbook.bytes, values, serverCompatible, columns: [...byColumn].map(([column, field]) => ({ column, fieldId: field.id, name: field.name })), rows: dataRows.size }
}
