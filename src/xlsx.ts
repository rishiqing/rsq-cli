import { readFile, stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { parseStringPromise } from 'xml2js'
import { asObject, RsqError } from './core.js'
const invalid = (message: string): never => { throw new RsqError('INVALID_FILE', message, 2) }
const values = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value]
const text = (value: unknown): string => value == null ? '' : typeof value === 'string' || typeof value === 'number' ? String(value) : text(asObject(value)._)
const unescapeXstring = (value: string) => value.replace(/_x([a-fA-F0-9]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
function richText(value: unknown) { const row = asObject(value); return row.t != null ? unescapeXstring(text(row.t)) : values(row.r).map(run => unescapeXstring(text(asObject(run).t))).join('') }
export type XlsxCell = { row: number; column: number; value: string; type: string; formula: boolean }
// The deployed POI entry parser silently loses inlineStr values when it changes
// their cell type. Project inspected A/J entries into an ordinary shared-string
// workbook; no macros, formulas, other sheets or original file paths are sent.
export function entryImportWorkbook(entries: { indicatorId: string; value: string }[]): Uint8Array {
  const escape = (value: string) => value.replace(/_x[a-fA-F0-9]{4}_/g, code => '_x005F_' + code.slice(1)).replace(/[\u0000-\u0008\u000b-\u001f]/g, character => '_x' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '_')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  const strings = [...new Set(['指标 ID', '结果值', ...entries.flatMap(row => [row.indicatorId, row.value])])], indices = new Map(strings.map((value, index) => [value, index]))
  const cell = (reference: string, index: number) => `<c r="${reference}" t="s"><v>${index}</v></c>`
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Entry" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` + strings.map(value => '<si><t xml:space="preserve">' + escape(value) + '</t></si>').join('') + '</sst>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"/><row r="2">' + cell('A2', 0) + cell('J2', 1) + '</row>' + entries.map((row, index) => `<row r="${index + 3}">` + cell('A' + (index + 3), indices.get(row.indicatorId)!) + cell('J' + (index + 3), indices.get(row.value)!) + '</row>').join('') + '</sheetData></worksheet>',
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])))
}
export async function readXlsxFirstSheet(file: string): Promise<{ bytes: Uint8Array; cells: XlsxCell[] }> {
  if (extname(file).toLowerCase() !== '.xlsx') invalid('此导入适配只接受 .xlsx。')
  const info = await stat(file).catch(() => invalid('无法读取本地 Excel 文件。'))
  if (!info.isFile() || info.size > 20971520) invalid('Excel 必须是最多 20 MiB 的普通文件。')
  const bytes = await readFile(file).catch(() => invalid('无法读取本地 Excel 文件。'))
  if (bytes.length > 20971520) invalid('读取期间 Excel 超过 20 MiB。')
  let expanded = 0, entries = 0
  const names = new Set<string>()
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: entry => {
      expanded += entry.originalSize; entries++
      if (!Number.isSafeInteger(expanded) || expanded > 41943040 || entries > 2000 || names.has(entry.name) || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..')) invalid('Excel ZIP 过大、重复或包含无效路径。')
      names.add(entry.name)
      return /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(entry.name)
    } })
  } catch (error) { if (error instanceof RsqError) throw error; return invalid('Excel ZIP 无效或压缩方式不支持。') }
  const xml = async (path: string) => {
    const data = files[path]; if (!data) invalid('Excel 缺少必要的工作簿结构：' + path)
    let source: string
    try { source = new TextDecoder(data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true }).decode(data) } catch { return invalid('Excel XML 编码无效。') }
    if (/<!DOCTYPE|<!ENTITY/i.test(source!)) invalid('Excel XML 不允许外部实体或文档类型声明。')
    try { return asObject(await parseStringPromise(source!, { explicitArray: false, explicitRoot: true, trim: false, tagNameProcessors: [name => name.split(':').pop()!] })) } catch { return invalid('Excel XML 结构无效。') }
  }
  const workbook = await xml('xl/workbook.xml'), first = asObject(values(asObject(asObject(workbook.workbook).sheets).sheet)[0]), relationId = asObject(first.$)['r:id']
  if (typeof relationId !== 'string' || !relationId) invalid('Excel 首表缺少关联 ID。')
  const relationships = values(asObject((await xml('xl/_rels/workbook.xml.rels')).Relationships).Relationship).map(asObject), relation = relationships.find(row => asObject(row.$).Id === relationId), attrs = asObject(relation?.$)
  if (relationships.filter(row => asObject(row.$).Id === relationId).length !== 1) invalid('Excel 首表关联缺失或重复。')
  if (attrs.TargetMode === 'External' || typeof attrs.Target !== 'string' || !String(attrs.Type).endsWith('/worksheet')) invalid('Excel 首表没有合法的内部工作表关联。')
  const path = posix.normalize(String(attrs.Target).startsWith('/') ? String(attrs.Target).slice(1) : posix.join('xl', String(attrs.Target)))
  if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) invalid('Excel 工作表路径越界。')
  const shared = files['xl/sharedStrings.xml'] ? values(asObject((await xml('xl/sharedStrings.xml')).sst).si).map(richText) : []
  const sheet = asObject((await xml(path)).worksheet), cells: XlsxCell[] = [], coordinates = new Set<string>()
  const seenRows = new Set<number>()
  for (const rawRow of values(asObject(sheet.sheetData).row)) {
    const rowNumber = Number(asObject(asObject(rawRow).$).r)
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > 10002 || seenRows.has(rowNumber)) invalid('Excel 行号缺失、重复或越界。')
    seenRows.add(rowNumber)
    for (const rawCell of values(asObject(rawRow).c)) {
    const cell = asObject(rawCell), attrs = asObject(cell.$), coordinate = typeof attrs.r === 'string' ? /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(attrs.r) : null
    if (!coordinate || coordinates.has(String(attrs.r)) || cells.length >= 100000) invalid('Excel 单元格坐标重复、缺失或超过 100000 格。')
    coordinates.add(String(attrs.r))
    const row = Number(coordinate![2]), column = [...coordinate![1]].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0)
    if (!Number.isSafeInteger(row) || row !== rowNumber || column > 16384) invalid('Excel 单元格与行号不符或列越界。')
    const type = String(attrs.t ?? 'n'), raw = text(cell.v)
    let value = type === 'inlineStr' ? richText(cell.is) : raw
    if (type === 's') { const index = /^[0-9]+$/.test(raw) ? Number(raw) : -1; if (!Number.isSafeInteger(index) || index < 0 || index >= shared.length) invalid('Excel 共享字符串索引无效。'); value = shared[index] }
    if (value.length > 20000) invalid('Excel 单元格内容过长。')
    cells.push({ row, column, value, type, formula: Object.hasOwn(cell, 'f') })
  }
  }
  return { bytes, cells }
}
