import { asObject, RsqError, type JsonObject } from './core.js'
import { appraisalAssessmentSteps, appraisalEntryPlan, appraisalEntrySnapshot } from './appraisal-assessments.js'
import { readXlsxFirstSheet, entryImportWorkbook } from './xlsx.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export type AppraisalEntryImportAction = 'entry-import-preview' | 'entry-import-save'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const id = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : invalid('导入指标和考核 ID 必须为精确正整数。')
export function appraisalEntryImportSteps(action: AppraisalEntryImportAction): [string, string, string][] {
  const all: [string, string, string][] = [['parsed', 'POST', '/task/performance/appraisal/export/entryUpload'], ...appraisalAssessmentSteps('assessment-inspect'), ...(action === 'entry-import-save' ? appraisalAssessmentSteps('assessment-entry-save') : [])]
  return all.filter((step, index) => all.findIndex(other => other[0] === step[0]) === index)
}
export async function runAppraisalEntryImport(action: AppraisalEntryImportAction, input: JsonObject, context: {
  call: (step: string, args?: JsonObject) => Promise<unknown>; userId: string; resources: Record<string, unknown>;
  inspect: (appraisalId: string) => Promise<unknown>; save: (appraisalId: string, values: JsonObject[], expectedEntrySnapshot: unknown) => Promise<unknown>;
}) {
  const { resources } = context
  if (!Array.isArray(input.appraisalIds) || !input.appraisalIds.length || input.appraisalIds.length > 50 || new Set(input.appraisalIds).size !== input.appraisalIds.length) invalid('请显式提供最多 50 个不重复考核 ID，以限定文件写入范围。')
  const appraisalIds = (input.appraisalIds as unknown[]).map(id), workbook = await readXlsxFirstSheet(String(input.file))
  const byRow = new Map<number, typeof workbook.cells>()
  for (const cell of workbook.cells.filter(cell => cell.row >= 3)) { const row = byRow.get(cell.row) ?? []; row.push(cell); byRow.set(cell.row, row) }
  const expected = new Map<string, string>(); let ended = false
  const last = Math.max(2, ...byRow.keys())
  for (let index = 3; index <= last; index++) {
    const cells = byRow.get(index) ?? [], key = cells.find(cell => cell.column === 1), value = cells.find(cell => cell.column === 10)
    if (!key?.value) { ended = true; continue }
    if (ended) invalid('文件在空指标行之后还有数据，服务会提前结束；请移除中间空行后重试。')
    if (key.formula || value?.formula || ['b', 'e', 'd'].includes(key.type) || value && ['b', 'e', 'd'].includes(value.type)) invalid('结果录入的指标 ID 和结果不能使用公式、布尔、日期或错误单元格。')
    if (key.type === 'n' && !Number.isSafeInteger(Number(key.value))) invalid('长指标 ID 必须存为 Excel 文本，避免数值精度丢失。')
    const indicatorId = id(key.value)
    if (value?.value) {
      if (value.value.length > 2000) invalid('导入结果值不能超过 2000 字符。')
      if (expected.has(indicatorId)) invalid('文件包含重复指标，不猜测覆盖顺序。')
      expected.set(indicatorId, value.value)
    }
  }
  if (!expected.size || expected.size > 1000) invalid('文件须包含 1–1000 个非空结果；空结果不会清空原值。')
  // Freeze the inspected projection. This also adapts legal inline-string XLSX
  // files to the shared-string format accepted by the deployed POI parser.
  const directory = await mkdtemp(join(tmpdir(), 'rsq-entry-import-'))
  let raw: unknown
  try { const file = join(directory, 'entry.xlsx'); await writeFile(file, entryImportWorkbook([...expected].map(([indicatorId, value]) => ({ indicatorId, value }))), { mode: 0o600 }); raw = await context.call('parsed', { files: { fileData: file } }) }
  finally { await rm(directory, { recursive: true, force: true }) }
  if (!Array.isArray(raw) || !raw.length || raw.length > 1000) invalid('文件没有可录入结果，或单次超过 1000 条指标。当前格式读取首表第 3 行起的第 1 列 ID 和第 10 列非空结果。')
  const entries = (raw as unknown[]).map(value => { const row = asObject(value); if (typeof row.resultValue !== 'string' || !row.resultValue.length || row.resultValue.length > 2000) invalid('导入结果值须为 1–2000 字符的字符串。'); return { indicatorId: id(row.indicatorId), value: String(row.resultValue) } })
  if (new Set(entries.map(row => row.indicatorId)).size !== entries.length) invalid('文件包含重复指标，不合并或猜测最后一条。')
  if (entries.length !== expected.size || entries.some(row => expected.get(row.indicatorId) !== row.value)) throw new RsqError('BUSINESS_ASSERTION_FAILED', '服务解析的指标集合或文本值与本地文件不符；未保存业务值。', 5)
  const plans: { appraisalId: string; values: JsonObject[]; snapshot: unknown }[] = [], matched = new Set<string>()
  // Inspect and validate the entire batch before the first business mutation.
  for (const appraisalId of appraisalIds) {
    const result = asObject(await context.inspect(appraisalId)), graph = { assessment: asObject(result.assessment), content: asObject(result.content), flow: asObject(result.flow) }
    if (!Array.isArray(graph.content.dimensions)) invalid('考核正文没有实际维度，不能定位导入指标。')
    const indicatorIds = (graph.content.dimensions as unknown[]).flatMap(value => { const dimension = asObject(value); if (!Array.isArray(dimension.indicators)) invalid('考核维度缺少实际指标。'); return (dimension.indicators as unknown[]).map(value => id(asObject(value).id)) })
    const selected = entries.filter(row => indicatorIds.includes(row.indicatorId))
    if (!selected.length) continue
    appraisalEntryPlan(graph, context.userId, selected, true)
    for (const value of selected) { if (matched.has(value.indicatorId)) invalid('同一指标出现在多个考核中，停止而不猜归属。'); matched.add(value.indicatorId) }
    plans.push({ appraisalId, values: selected, snapshot: appraisalEntrySnapshot(graph) })
  }
  if (matched.size !== entries.length) throw new RsqError('RESOURCE_FORBIDDEN', '文件包含不属于指定考核范围的指标；未保存任何业务值。', 4)
  const common = { context: 'appraisal-result-entry-import', format: 'first-xlsx-sheet; row-3-onward; column-A-indicatorId; column-J-resultValue', rowCount: entries.length,
    plans: plans.map(({ snapshot, ...plan }) => plan), untouchedAppraisalIds: appraisalIds.filter(id => !plans.some(plan => plan.appraisalId === id)), temporary: true,
    limitations: ['upload-only-parses-no-business-values-persisted', 'first-empty-indicator-id-or-missing-row-ends-server-parser', 'empty-result-cells-are-skipped-not-cleared', 'per-assessment-writes-have-no-shared-transaction-or-server-cas'], relatedCommands: ['appraisal assessments queue result-entry', 'appraisal assessments inspect', 'appraisal assessments entry save', 'appraisal assessments entry submit'] }
  if (action === 'entry-import-preview') return { ...common, saved: false }
  const completed: string[] = []; resources.importedAssessmentIds = completed
  for (const plan of plans) {
    await context.save(plan.appraisalId, plan.values, plan.snapshot)
    completed.push(plan.appraisalId)
  }
  return { ...common, saved: true, completedAppraisalIds: completed, independentlyVerified: true }
}
