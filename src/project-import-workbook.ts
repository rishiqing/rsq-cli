import { createHash } from 'node:crypto'
import { RsqError } from './core.js'
import { readXlsxFirstSheet, type XlsxCell } from './xlsx.js'

export const projectImportHeaders: Record<string, string> = {
  '任务标题*': 'name', '任务标题': 'name', '任务详情': 'note', '任务开始时间': 'start', '开始时间': 'start', '任务结束时间': 'end', '结束时间': 'end',
  '标签': 'labels', '优先级': 'priority', '是否完成': 'done', '完成时间': 'finished', '父任务标题': 'parent',
  '所属卡片*': 'card', '所属卡片': 'card', '所属任务模块*': 'module', '所属任务模块': 'module', '所属计划*': 'module', '负责人': 'principal', '执行人': 'members', '参与人': 'participants',
}
export type ImportDate = { date: string; time: string; providedTime: boolean }
export type ProjectImportRow = { row: number; name: string; module: string; card: string; parent: string; note: string; labels: string[]; priority: number; done: boolean;
  start: ImportDate | null; end: ImportDate | null; finished: ImportDate | null; principal: string[]; members: string[]; participants: string[]; columns: string[] }
export type ProjectImportWorkbook = { sha256: string; bytes: Uint8Array; rows: ProjectImportRow[]; headers: string[] }
function invalid(message: string, row?: number): never { throw new RsqError('INVALID_WORKBOOK', message, 2, row ? { row } : undefined) }
const split = (value: string, row: number) => {
  if (!value) return []
  if (value.includes(';') && value.includes('；')) invalid('同一单元格不要混用中英文分号，服务端会把它解析成不同名称。', row)
  const values = value.split(/[;；]/)
  if (values.some(text => !text || text !== text.trim())) invalid('成员和标签名称须完整且不能带分隔符旁的空白。', row)
  return [...new Set(values)]
}
function date(value: string, row: number): ImportDate | null {
  if (!value) return null
  const match = /^(\d{4})[.-](\d{2})[.-](\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value)
  if (!match) invalid('日期请使用文本 YYYY-MM-DD 或 YYYY-MM-DD HH:mm[:ss]；点号分隔也可。数字日期、公式和系统时区不会被猜测。', row)
  const [year, month, day, hour, minute, second] = match!.slice(1).map(value => Number(value ?? 0))
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (year < 1900 || year > 9999 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) invalid('导入日期不是有效日历日期或时间。', row)
  return { date: `${match![1]}-${match![2]}-${match![3]}`, time: `${match![4] ?? '00'}:${match![5] ?? '00'}:${match![6] ?? '00'}`, providedTime: match![4] !== undefined }
}
export function projectImportRows(cells: XlsxCell[]): { rows: ProjectImportRow[]; headers: string[] } {
  const headers = cells.filter(cell => cell.row === 1 && cell.value !== ''), columns = new Map<number, string>(), meanings = new Set<string>()
  for (const cell of headers) {
    if (cell.formula || cell.value !== cell.value.trim()) invalid('首行表头必须是当前模板中的完整文本。', 1)
    const field = projectImportHeaders[cell.value]
    if (field && meanings.has(field)) invalid('同一含义的多个表头会覆盖数据，请只保留一列：' + cell.value, 1)
    if (field) { columns.set(cell.column, field); meanings.add(field) }
  }
  if (!meanings.has('name')) invalid('Excel 首行缺少任务标题*。', 1)
  const data = new Map<number, Record<string, string>>()
  let expandedTextBytes = 0
  for (const cell of cells) {
    if (cell.row === 1 || cell.value === '') continue
    expandedTextBytes += Buffer.byteLength(cell.value)
    if (expandedTextBytes > 4194304) invalid('展开后的表格文本超过 4 MiB；请拆分为独立导入。')
    if (cell.formula) invalid('请把公式转换成实际值；不使用可能过期的缓存结果。', cell.row)
    const field = columns.get(cell.column)
    if (!field) invalid('数据列没有当前支持的表头，不能静默丢弃该列。', cell.row)
    const record = data.get(cell.row) ?? {}; record[field] = cell.value; data.set(cell.row, record)
  }
  const priority = ['最高', '较高', '普通', '较低']
  const rows: ProjectImportRow[] = [...data].sort(([a], [b]) => a - b).map(([row, value]) => {
    if (!value.name?.trim() || value.name.length > 200) invalid('任务标题必填且最多 200 字；有内容的空标题行不能被忽略。', row)
    if (value.name !== value.name.trim() || value.parent && value.parent !== value.parent.trim()) invalid('任务及父任务标题不能有首尾空白。', row)
    if (!value.parent && (!value.module || !value.card)) invalid('根任务必须明确指定所属任务模块和所属卡片。', row)
    for (const name of ['module', 'card']) if (value[name] && (value[name] !== value[name].trim() || value[name].length > 200)) invalid('模块和卡片名称须明确且最多 200 字。', row)
    if (value.priority && !priority.includes(value.priority)) invalid('优先级只支持最高、较高、普通、较低。', row)
    if (value.done && !['Y', 'N', '是', '否'].includes(value.done)) invalid('是否完成只支持 Y/N 或 是/否。', row)
    const start = date(value.start ?? '', row), end = date(value.end ?? '', row), finished = date(value.finished ?? '', row)
    if (start && end && start.date + start.time > end.date + end.time) invalid('开始时间不能晚于结束时间。', row)
    const principal = split(value.principal ?? '', row)
    if (principal.length > 1) invalid('一个任务只能指定一位负责人。', row)
    return { row, name: value.name, module: value.module ?? '', card: value.card ?? '', parent: value.parent ?? '', note: value.note ?? '', labels: split(value.labels ?? '', row),
      priority: value.priority ? priority.indexOf(value.priority) + 1 : 3, done: ['Y', '是'].includes(value.done), start, end, finished, principal,
      members: split(value.members ?? '', row), participants: split(value.participants ?? '', row), columns: Object.keys(value).sort() }
  })
  if (!rows.length || rows.length > 10000) invalid('Excel 必须包含 1 至 10000 条任务。')
  const byName = new Map<string, ProjectImportRow[]>()
  for (const row of rows) byName.set(row.name, [...byName.get(row.name) ?? [], row])
  for (const row of rows) {
    let cursor = row, depth = 0
    const visited = new Set([row])
    while (cursor.parent) {
      const parents = byName.get(cursor.parent) ?? []
      if (parents.length !== 1 || visited.has(parents[0]) || ++depth > 50) invalid('父任务须唯一存在于同一文件，且不能形成循环或超过 50 层。', row.row)
      const parent = parents[0]
      if (parent.parent && parent.row > cursor.row) invalid('多层子任务必须在其父子任务行之后，避免后台按行创建时丢失父级。', row.row)
      if (row.module && row.module !== parent.module || row.card && row.card !== parent.card) invalid('子任务的模块和卡片必须与父任务一致；请清空子行的归属列以继承。', row.row)
      visited.add(parent); cursor = parent
    }
    if (row.parent) { row.module = cursor.module; row.card = cursor.card }
  }
  const keys = rows.map(row => JSON.stringify([row.module, row.card, row.parent, row.name]))
  if (new Set(keys).size !== keys.length) invalid('同一父级下的同名任务无法独立识别导入结果；请先使用唯一标题。')
  return { rows, headers: headers.map(cell => cell.value) }
}
export async function readProjectImportWorkbook(file: string): Promise<ProjectImportWorkbook> {
  const workbook = await readXlsxFirstSheet(file)
  return { ...projectImportRows(workbook.cells), bytes: workbook.bytes, sha256: createHash('sha256').update(workbook.bytes).digest('hex') }
}
