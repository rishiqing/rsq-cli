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
const xmlText = (value: string) => value.replace(/_x[a-fA-F0-9]{4}_/g, code => '_x005F_' + code.slice(1))
  .replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g, character => '_x' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '_')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
function columnName(index: number) {
  let letters = ''
  for (let column = index + 1; column > 0; column = Math.floor((column - 1) / 26)) {
    letters = String.fromCharCode(65 + (column - 1) % 26) + letters
  }
  return letters
}

export function textWorkbook(sheets: { name: string; rows: (string | undefined)[][] }[]): Uint8Array {
  const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const spreadsheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.'
  const strings = new Map<string, number>(), files: Record<string, string> = {}
  let stringCount = 0
  const relationships: string[] = [], overrides: string[] = [], sheetList: string[] = []
  sheets.forEach(({ name, rows }, index) => {
    if (rows.length > 1048576) invalid('工作表超过 Excel 行数上限。')
    const id = index + 1, path = 'worksheets/sheet' + id + '.xml'
    relationships.push('<Relationship Id="rId' + id + '" Type="' + officeRel + '/worksheet" Target="' + path + '"/>')
    overrides.push('<Override PartName="/xl/' + path + '" ContentType="' + spreadsheetType + 'worksheet+xml"/>')
    sheetList.push('<sheet name="' + xmlText(name) + '" sheetId="' + id + '" r:id="rId' + id + '"/>')
    const sheetRows = rows.map((row, rowIndex) => {
      if (row.length > 16384) invalid('工作表超过 Excel 列数上限。')
      const cells = row.map((value, column) => {
        if (value === undefined) return ''
        if (value.length > 32767) invalid('单元格文本超过 Excel 长度上限。')
        if (!strings.has(value)) strings.set(value, strings.size)
        stringCount++
        return '<c r="' + columnName(column) + (rowIndex + 1) + '" t="s"><v>' + strings.get(value) + '</v></c>'
      })
      return '<row r="' + (rowIndex + 1) + '">' + cells.join('') + '</row>'
    })
    files['xl/' + path] = '<worksheet xmlns="' + sheetNs + '"><sheetData>' + sheetRows.join('') + '</sheetData></worksheet>'
  })
  overrides.push('<Override PartName="/xl/sharedStrings.xml" ContentType="' + spreadsheetType + 'sharedStrings+xml"/>')
  relationships.push('<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + officeRel + '/sharedStrings" Target="sharedStrings.xml"/>')
  files['[Content_Types].xml'] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="' + spreadsheetType + 'sheet.main+xml"/>' + overrides.join('') + '</Types>'
  files['_rels/.rels'] = '<Relationships xmlns="' + packageRel + '"><Relationship Id="rId1" Type="' + officeRel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  files['xl/workbook.xml'] = '<workbook xmlns="' + sheetNs + '" xmlns:r="' + officeRel + '"><sheets>' + sheetList.join('') + '</sheets></workbook>'
  files['xl/_rels/workbook.xml.rels'] = '<Relationships xmlns="' + packageRel + '">' + relationships.join('') + '</Relationships>'
  files['xl/sharedStrings.xml'] = '<sst xmlns="' + sheetNs + '" count="' + stringCount + '" uniqueCount="' + strings.size + '">' +
    [...strings.keys()].map(value => '<si><t xml:space="preserve">' + xmlText(value) + '</t></si>').join('') + '</sst>'
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])))
}

// The deployed POI parser needs the values in columns A and J as shared strings.
export function entryImportWorkbook(entries: { indicatorId: string; value: string }[]): Uint8Array {
  const cells = (indicator: string, value: string) => [indicator, ...Array<string | undefined>(8).fill(undefined), value]
  return textWorkbook([{ name: 'Entry', rows: [[], cells('指标 ID', '结果值'), ...entries.map(row => cells(row.indicatorId, row.value))] }])
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
