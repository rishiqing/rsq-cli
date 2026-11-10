// Extracted by scripts/automation-schema.mjs from pinned current UI pure logic.
import { z } from 'zod'
import { ActionType, NotifySenderType, JumpTarget, Operator, DatasheetUpdateDateDuration, UpdateDateDuration } from './enums.js'
import { hasWebhookDeliveryConfig } from './helpers.js'
export const NumberIdSchema = z.number().int().positive('ID必须为正整数')
const MemberTargetSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  type: z.string(),
  role: z.string().optional(),
  hierarchyLevel: z.string().optional(),
  projectRoleId: z.number().optional(),
  fieldId: z.string().optional(),
  processRoleId: z.number().optional(),
})
const BaseActionSchema = z.object({
  id: z.string().optional(),
  validationResult: z.boolean().nullable().optional(),
})
const MessageSchema = z.object({
  titleDelta: z.any(),
  contentDelta: z.any(),
  jumpTarget: z.enum(JumpTarget).nullable(),
})
export const NotifyActionSchema = z
  .object({
    type: z.enum([
      ActionType.TaskNotify,
      ActionType.TaskSummaryNotify,
      ActionType.AdvanceNotify,
      ActionType.DatasheetNotify,
      ActionType.ProcessNotify,
      ActionType.ProcessTodoNotify,
      ActionType.ProcessTodoSummaryNotify,
    ] as const),
    senderType: z.enum(NotifySenderType),
    projectId: NumberIdSchema.optional(),
    editorId: NumberIdSchema.optional(),
    webhookUrl: z.string().optional(),
    secret: z.string().optional(),
    robotId: z.string().optional(),
    senderList: z.array(MemberTargetSchema).optional(),
    message: MessageSchema,
  })
  .extend(BaseActionSchema.shape)
  .superRefine((data, ctx) => {
    if (data.senderType === NotifySenderType.Webhook) {
      if (
        !hasWebhookDeliveryConfig(data)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '请填写Webhook URL',
        })
      }
    }
    if (data.senderType === NotifySenderType.Project) {
      if (data.projectId === undefined || data.projectId === null) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择项目',
        })
      }
      if (!data.senderList || data.senderList.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: '请填写收件人',
        })
      }
    }
    if (data.senderType === NotifySenderType.Editor) {
      if (data.editorId === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '请选择发送人',
        })
      }
      if (!data.senderList || data.senderList.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: '请填写收件人',
        })
      }
    }
  })
export const TaskMoveActionSchema = z.object({
  type: z.literal(ActionType.TaskMove),
  projectId: z.number({
    message: '请选择项目',
  }),
  planId: z.number({
    message: '请选择计划',
  }),
  cardId: z.number({
    message: '请选择卡片',
  }),
  projectName: z.string().optional(),
  planName: z.string().optional(),
  cardName: z.string().optional(),
}).extend(BaseActionSchema.shape)
const FilterConditionSchema = z.object(
  {
    filterType: z.union([z.string(), z.number()]).refine(val => {
      if (typeof val === 'string') {
        return val.trim().length > 0
      }
      return true
    }, '请选择字段'),
    fieldId: z.union([z.number(), z.string()]).optional(),
    operator: z.enum(Operator, {
      message: '请选择比较符',
    }),
    value: z.any(),
  },
  {
    message: '请选择字段',
  },
)
const DateConfigSchema = z.union([
  z.tuple([
    z.literal(DatasheetUpdateDateDuration.AfterDatasheetFieldDateTime),
    z.number().min(1, '天数必须大于0'),
    z.string().min(1, '字段不能为空'),
  ]),
  z.tuple([
    z.enum([
      UpdateDateDuration.AfterAutomationExecutionTime,
      UpdateDateDuration.AfterProjectStartTime,
      UpdateDateDuration.AfterProjectEndTime,
    ]),
    z.number().min(1, '天数必须大于0'),
  ]),
  z.tuple([
    z.literal(UpdateDateDuration.ExactDate),
    z.number().min(1, '时间戳必须大于0'),
  ]),
  z.tuple([
    z.enum([
      UpdateDateDuration.AfterAutomationExecutionTime,
      UpdateDateDuration.AfterProjectStartTime,
      UpdateDateDuration.AfterProjectEndTime,
    ]),
  ]),
])
const TaskDateConfigSchema = z.object({
  start: DateConfigSchema,
  end: DateConfigSchema,
})
export const CreateTaskActionSchema = z.object({
  type: z.literal(ActionType.CreateTask),
  taskNameDelta: z.any().refine(val => val !== null, '任务名称不能为空'),
  taskMembers: z.array(MemberTargetSchema),
  createMember: MemberTargetSchema.nullable().refine(val => val !== null, '创建人不能为空'),
  date: TaskDateConfigSchema,
}).extend(BaseActionSchema.shape)
export const UpdateDatasheetFieldActionSchema = z.object({
  type: z.literal(ActionType.UpdateDatasheetField),
  condition: FilterConditionSchema,
}).extend(BaseActionSchema.shape)
export const UpdateTaskFieldActionSchema = z.object({
  type: z.literal(ActionType.UpdateTaskField),
  condition: FilterConditionSchema,
}).extend(BaseActionSchema.shape)
export const CreateProjectActionSchema = z.object({
  type: z.literal(ActionType.CreateProject),
  projectNameDelta: z.any().refine(val => val !== null, '项目名称不能为空'),
  projectMembers: z.array(MemberTargetSchema).min(1, '请选择项目成员'),
  createMember: MemberTargetSchema.nullable().refine(val => val !== null, '请选择创建人'),
  templateKanbanId: z.string({
    message: '请选择模版',
  }),
  projectGroupId: z.string({
    message: '请选择分组',
  }),
}).extend(BaseActionSchema.shape)
export const StartProcessActionSchema = z.object({
  type: z.literal(ActionType.StartProcess),
  processNameDelta: z.any().refine(val => val !== null, '流程名称不能为空'),
  processMembers: z.array(MemberTargetSchema).min(1, '请选择人员'),
}).extend(BaseActionSchema.shape)
export const ImplicitActionSchema = z.object({
  type: z.enum([
    ActionType.UrgeTask,
    ActionType.AutoCompleteParentTask,
    ActionType.AutoUpdateParentTaskProgress,
    ActionType.UrgeTodo,
    ActionType.GenerateAdvance,
  ] as const),
}).extend(BaseActionSchema.shape)
export const ActionSchema = z.discriminatedUnion('type', [
  NotifyActionSchema,
  TaskMoveActionSchema,
  UpdateTaskFieldActionSchema,
  CreateTaskActionSchema,
  UpdateDatasheetFieldActionSchema,
  CreateProjectActionSchema,
  StartProcessActionSchema,
  ImplicitActionSchema,
])
export const ActionsSchema = z.array(ActionSchema).min(1, '至少需要一个动作').superRefine((actions, ctx) => {
  const validationActions = actions.filter(action =>
    typeof action.validationResult === 'boolean',
  )

  if (validationActions.length > 0) {
    const hasTrueResult = validationActions.some(action =>
      action.validationResult === true,
    )
    const hasFalseResult = validationActions.some(action =>
      action.validationResult === false,
    )

    if (!hasTrueResult || !hasFalseResult) {
      ctx.addIssue({
        code: 'custom',
        message: '必须同时包含验证通过和验证不通过的动作',
      })
    }
  }
})
