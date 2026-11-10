// Extracted by scripts/automation-schema.mjs from pinned current UI pure logic.
import { IRecordDateReminderPoint, RecordDateReminderDirection, RecordDateReminderUnit } from './enums.js'
export const MAX_REMINDER_POINTS = 10
export const MAX_REMINDER_DAYS = 3650
export const MAX_REMINDER_MONTHS = 120
export function isValidReminderPoints(
  points: IRecordDateReminderPoint[] | undefined | null,
): points is IRecordDateReminderPoint[] {
  if (!Array.isArray(points) || points.length === 0 || points.length > MAX_REMINDER_POINTS) {
    return false
  }
  const seen = new Set<string>()
  for (const point of points) {
    if (!point || typeof point !== 'object') return false
    const { direction, value, unit } = point
    if (!Number.isSafeInteger(value)) return false
    if (direction === RecordDateReminderDirection.On) {
      if (value !== 0) return false
    } else if (
      direction === RecordDateReminderDirection.Before
      || direction === RecordDateReminderDirection.After
    ) {
      if (unit === RecordDateReminderUnit.Day) {
        if (value < 1 || value > MAX_REMINDER_DAYS) return false
      } else if (unit === RecordDateReminderUnit.Month) {
        if (value < 1 || value > MAX_REMINDER_MONTHS) return false
      } else {
        return false
      }
    } else {
      return false
    }
    const key = `${direction}:${value}:${direction === RecordDateReminderDirection.On ? RecordDateReminderUnit.Day : unit}`
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}
export function hasWebhookDeliveryConfig(config: {
  robotId?: string
  webhookUrl?: string
}): boolean {
  return Boolean(config.robotId?.trim() || config.webhookUrl?.trim())
}
