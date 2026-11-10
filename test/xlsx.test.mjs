import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { readXlsxFirstSheet, entryImportWorkbook } from '../dist/xlsx.js'
import { xlsxFixture } from '../scripts/xlsx-fixture.mjs'
async function file(bytes, run, suffix = '.xlsx') {
  const directory = await mkdtemp(join(tmpdir(), 'rsq-xlsx-test-'))
  try { const path = join(directory, 'file' + suffix); await writeFile(path, bytes, { mode: 0o600 }); return await run(path) } finally { await rm(directory, { recursive: true, force: true }) }
}
test('xlsx reader preserves rich/shared text, exact numeric strings and formula markers without evaluation', async () => {
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>9007199254740993</v></c><c r="C1"><f>SUM(B1,1)</f><v>99</v></c></row></sheetData></worksheet>'
  const bytes = xlsxFixture([], { 'xl/worksheets/sheet1.xml': sheet, 'xl/sharedStrings.xml': '<sst><si><r><t> 名&amp;</t></r><r><t>称 </t></r></si></sst>' })
  await file(bytes, async path => {
    const result = await readXlsxFirstSheet(path)
    assert.deepEqual(result.cells.map(cell => [cell.value, cell.type, cell.formula]), [[' 名&称 ', 's', false], ['9007199254740993', 'n', false], ['99', 'n', true]])
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(bytes))
  })
})
test('xlsx validates ZIP paths, compressed expansion, file extension and corruption before using workbook content', async () => {
  for (const bytes of [Buffer.from('not-a-zip'), zipSync({ '../outside': strToU8('x') }), zipSync({ 'oversized.bin': new Uint8Array(41943041) })]) await file(bytes, path => assert.rejects(readXlsxFirstSheet(path), { code: 'INVALID_FILE' }))
  await file(xlsxFixture([['valid']]), path => assert.rejects(readXlsxFirstSheet(path), { code: 'INVALID_FILE' }), '.xls')
})
test('xlsx rejects missing/external/escaping sheet relationships and external entities', async () => {
  const relationship = target => `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ${target}/></Relationships>`
  for (const extra of [
    { 'xl/_rels/workbook.xml.rels': relationship('Target="https://example.test/sheet.xml" TargetMode="External"') },
    { 'xl/_rels/workbook.xml.rels': relationship('Target="../../outside.xml"') },
    { 'xl/workbook.xml': '<!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook>&x;</workbook>' },
  ]) await file(xlsxFixture([], extra), path => assert.rejects(readXlsxFirstSheet(path), { code: 'INVALID_FILE' }))
})
test('xlsx rejects duplicate coordinates, inconsistent row coordinates, bad shared indices and bounds', async () => {
  for (const contents of [
    '<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>',
    '<row r="1"><c r="A2"><v>1</v></c></row>',
    '<row r="1"><c r="A1" t="s"><v>0</v></c></row>',
    '<row r="10003"><c r="A10003"><v>1</v></c></row>',
    '<row r="1"><c r="XFE1"><v>1</v></c></row>',
  ]) await file(xlsxFixture([], { 'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' + contents + '</sheetData></worksheet>' }), path => assert.rejects(readXlsxFirstSheet(path), { code: 'INVALID_FILE' }))
})
test('entry workbook adaptation preserves exact inspected values in ordinary shared strings accepted by POI', async () => {
  const bytes = entryImportWorkbook([{ indicatorId: '9007199254740993', value: ' <&"\n12.30' }, { indicatorId: '702', value: '0' }, { indicatorId: '703', value: 'literal_x0041_\r\u0000' }, { indicatorId: '704', value: '0' }])
  await file(bytes, async path => {
    const result = await readXlsxFirstSheet(path), cells = result.cells.filter(cell => cell.row >= 3)
    assert.deepEqual(cells.map(cell => [cell.row, cell.column, cell.value, cell.type]), [[3, 1, '9007199254740993', 's'], [3, 10, ' <&"\n12.30', 's'], [4, 1, '702', 's'], [4, 10, '0', 's'], [5, 1, '703', 's'], [5, 10, 'literal_x0041_\r\u0000', 's'], [6, 1, '704', 's'], [6, 10, '0', 's']])
    assert.ok(cells.every(cell => !cell.formula))
  })
})
