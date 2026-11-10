// Extracted by scripts/automation-schema.mjs from pinned current UI pure logic.
import { z } from 'zod'
import { TriggerType, TimingType, TimingUnit, RecordDateCalculationType, RecordDateReminderDirection, RecordDateReminderUnit, SubTaskCompletionType, SummaryType, SummaryTodoType, FilterConjunction } from './enums.js'
import { isValidReminderPoints } from './helpers.js'
const TimingConfigSchema = z
  .object({
    type: z.enum(TimingType),
    isSkipHoliday: z.boolean().optional(),
    unit: z.enum(TimingUnit).optional(),
    value: z.number().optional(),
    time: z.string().optional(),
    rrule: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if ([TimingType.BeforeStart, TimingType.BeforeEnd, TimingType.Delay].includes(data.type)) {
      if (data.value === undefined || data.unit === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择天数',
        })
      }
      if (data.time === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择时间',
        })
      }
    }
    if (data.type === TimingType.Scheduled) {
      if (data.rrule === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择定时规则',
        })
      }
      if (data.time === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择时间',
        })
      }
    }
    if (data.type === TimingType.Daily && !data.time) {
      ctx.addIssue({
        code: 'custom',
        message: '请选择时间',
      })
    }
  })
const FilterConditionSchema = z.object({
  filterType: z.string({
    message: '请选择字段',
  }),
  operator: z.string(),
  fieldId: z.number().optional(),
  value: z.any(),
})
const FilterSchema = z.object({
  conditions: z.array(FilterConditionSchema).optional(),
  conjunction: z.enum(FilterConjunction).optional(),
})
const SubTaskCompletionTypeSchema = z.enum(SubTaskCompletionType)
const SummaryTypeSchema = z.enum(SummaryType)
const SummaryTodoTypeSchema = z.enum(SummaryTodoType)
export const TaskTriggerSchema = z
  .object({
    type: z.enum([
      TriggerType.TaskCreated,
      TriggerType.TaskCompleted,
      TriggerType.TaskDelayed,
      TriggerType.TaskChanged,
      TriggerType.TaskScheduled,
      TriggerType.UrgeDelayedTask,
      TriggerType.AllSubTasksCompleted,
      TriggerType.SubTaskCompletedOrCancelled,
    ] as const),
    planIdList: z.array(z.union([z.number(), z.literal('all')])).min(1, '请选择计划'),
    taskSelector: FilterSchema,
    timing: TimingConfigSchema,
    options: z
      .object({
        completionType: SubTaskCompletionTypeSchema.optional(),
        changeCondition: FilterConditionSchema.optional(),
      })
      .catchall(z.any())
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === TriggerType.SubTaskCompletedOrCancelled) {
      if (!data.options || data.options.completionType === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择子任务完成类型',
        })
      }
    }
    if (data.type === TriggerType.TaskChanged) {
      if (
        !data.options
        || !data.options.changeCondition
        || !data.options.changeCondition.filterType
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择更新条件',
        })
      }
    }
  })
const TaskSummaryTriggerSchema = z
  .object({
    type: z.literal(TriggerType.DailyTaskSummary),
    planIdList: z.array(z.union([z.number(), z.literal('all')])).min(1, '请选择计划'),
    timing: TimingConfigSchema,
    options: z
      .object({
        summaryType: SummaryTypeSchema.optional(),
      })
      .catchall(z.any())
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.options || !data.options.summaryType) {
      ctx.addIssue({
        code: 'custom',
        message: '请选择任务类型',
      })
    }
  })
const ProcessSummaryTriggerSchema = z
  .object({
    type: z.literal(TriggerType.DailyProcessSummary),
    applicationId: z.number().optional(),
    timing: TimingConfigSchema,
    options: z
      .object({
        summaryType: SummaryTodoTypeSchema.optional(),
      })
      .catchall(z.any())
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.applicationId) {
      ctx.addIssue({
        code: 'custom',
        message: '请选择流程',
      })
    }
    if (!data.options || !data.options.summaryType) {
      ctx.addIssue({
        code: 'custom',
        message: '请选择待办类型',
      })
    }
  })
const DatasheetTriggerSchema = z
  .object({
    type: z.enum([
      TriggerType.RecordCreated,
      TriggerType.DataScheduled,
      TriggerType.RecordDate,
      TriggerType.DataFieldChanged,
    ] as const),
    datasheetId: z
      .string({
        message: '请选择数据表',
      })
      .min(1, '请选择数据表'),
    datasheetSelector: z.any(), // 多维表格的筛选，虽然名义上用了IFilter但实际数据并不是IFilter
    timing: TimingConfigSchema,
    options: z
      .object({
        dateFieldId: z.string().optional(),
        calculationType: z.enum(RecordDateCalculationType).optional(),
        reminderPoints: z
          .array(
            z.object({
              direction: z.enum(RecordDateReminderDirection),
              value: z.number(),
              unit: z.enum(RecordDateReminderUnit),
            }),
          )
          .optional(),
        changeCondition: z.any(),
        validateSelector: z.any(),
      })
      .catchall(z.any())
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === TriggerType.RecordDate) {
      if (!data.options || !data.options.dateFieldId) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择日期字段',
        })
      }
      if (
        data.options?.calculationType
        !== RecordDateCalculationType.DueDateMinusCurrentDate
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择计算方式',
        })
      }
      if (!isValidReminderPoints(data.options?.reminderPoints)) {
        ctx.addIssue({
          code: 'custom',
          message: '请设置1至10个不重复的提醒时间（到期前/当天/后，单位为天或个月）',
        })
      }
    }
    if (data.type === TriggerType.DataFieldChanged) {
      if (
        !data.options
        || !data.options.changeCondition
        || !data.options.changeCondition.fieldId
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择更新条件',
        })
      }
    }
    if (data.type === TriggerType.RecordCreated) {
      if (data.options?.validateSelector?.conditions?.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择校验条件',
        })
      }
    }
  })
const ProcessTriggerSchema = z.object({
  type: z.enum([
    TriggerType.ProcessStarted,
    TriggerType.ProcessCompleted,
    TriggerType.ProcessTodoDueSoon,
    TriggerType.ProcessKeyNodeWarning,
    TriggerType.ProcessTodoDelayed,
    TriggerType.ProcessScheduled,
    TriggerType.UrgeProcessTodo,
  ] as const),
  applicationId: z.number().optional(),
  processSelector: z.any(),
  keyNodes: z.array(z.object({
    stepInfoId: z.number(),
    fieldId: z.number(),
  })).optional(),
  timing: TimingConfigSchema,
}).superRefine((data, ctx) => {
  if (!data.applicationId) {
    ctx.addIssue({
      code: 'custom',
      message: '请选择流程',
    })
  }
})
const AdvanceTriggerSchema = z.union([
  z.object({
    type: z.literal(TriggerType.AdvanceUpdated),
  }),
  z.object({
    type: z.literal(TriggerType.AutoGenerateAdvance),
    timing: TimingConfigSchema,
  }),
])
export const SummaryTriggerSchema = z.union([TaskSummaryTriggerSchema, ProcessSummaryTriggerSchema])
export const TriggerSchema = z.union([
  TaskTriggerSchema,
  SummaryTriggerSchema,
  DatasheetTriggerSchema,
  ProcessTriggerSchema,
  AdvanceTriggerSchema,
])
