import { isDeepStrictEqual } from 'node:util'
import { RsqError, type JsonObject } from './core.js'
import { salaryCheck as check, salaryFields, salaryGrid, salaryValueEqual, type SalaryField } from './appraisal-salary-data.js'

export async function saveSalaryCells(values: JsonObject[], before: ReturnType<typeof salaryGrid>, fields: SalaryField[], context: {
  call: (step: string, args?: JsonObject) => Promise<unknown>; resources: Record<string, unknown>; query: JsonObject;
  period: ReturnType<typeof import('./appraisal-salary-data.js').salaryPeriod>; freshReport: () => Promise<void>;
}) {
  const { call, resources, query, period } = context, gridQuery = { ...query, period: period.code }
  const key = (userId: unknown, fieldId: unknown) => String(userId) + ':' + String(fieldId)
  const knownUsers = new Set(before.rows.map(row => row.userId)), numericFields = fields.filter(field => field.type === 'num' && field.isShow), knownFields = new Set(numericFields.map(field => field.id))
  const proposed = new Map<string, JsonObject>(), baseline = new Map<string, unknown>(before.rows.flatMap(row => numericFields.map(field => [key(row.userId, field.id), row.cells[field.id]] as const)))
  for (const value of values) {
    if (!knownUsers.has(String(value.userId)) || !knownFields.has(String(value.id)) || proposed.has(key(value.userId, value.id))) throw new RsqError('INVALID_INPUT', '只能修改当前报表实际成员与可见数字字段中的不重复单元格。', 2)
    proposed.set(key(value.userId, value.id), value)
  }
  const changed = values.filter(value => !salaryValueEqual(baseline.get(key(value.userId, value.id)), value.value)), completed: unknown[] = []
  resources.completedSalaryCellBatches = completed
  let current = before
  const fresh = async () => {
    await context.freshReport()
    check(isDeepStrictEqual(salaryFields(await call('freshFields', { query })), fields), '薪酬字段在读取后发生变化；未覆盖。')
    check(isDeepStrictEqual(salaryGrid(await call('freshSheet', { query: gridQuery }), fields), current), '薪酬数据在读取后变化；未覆盖。')
  }
  const verify = async (expected: Map<string, unknown>) => {
    const afterFields = salaryFields(await call('verifiedFields', { query })); check(isDeepStrictEqual(afterFields, fields), '薪酬写入期间字段定义发生变化。')
    const after = salaryGrid(await call('verifiedSheet', { query: gridQuery }), afterFields)
    check(isDeepStrictEqual(after.columns, before.columns) && isDeepStrictEqual(after.rows.map(row => row.userId), before.rows.map(row => row.userId)), '薪酬表格结构或成员发生变化。')
    for (const row of after.rows) for (const field of numericFields) if (!salaryValueEqual(row.cells[field.id], expected.get(key(row.userId, field.id)))) {
      throw new RsqError('PERSISTENCE_UNSUPPORTED', '薪酬数字值没有保存，或未指定单元格发生变化；先核对结果再恢复。', 5, { userId: row.userId, fieldId: field.id })
    }
    return after
  }
  await fresh()
  if (!changed.length) current = await verify(baseline)
  for (let offset = 0; offset < changed.length; offset += 1000) {
    if (offset) await fresh()
    const batch = changed.slice(offset, offset + 1000)
    resources.pendingSalaryCellBatch = batch.map(value => ({ userId: value.userId, fieldId: value.id }))
    await call('changed', { body: { id: query.id, period: period.code, periodType: period.apiType, data: batch } })
    for (const value of batch) baseline.set(key(value.userId, value.id), value.value)
    // Verification failure retains pending references: the server may have
    // saved some or all of them. Never retry the batch automatically.
    current = await verify(baseline)
    completed.push({ offset, cells: resources.pendingSalaryCellBatch })
    delete resources.pendingSalaryCellBatch
  }
  return { grid: current, changed: changed.length, batches: completed.length }
}
