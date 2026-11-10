// Extracted by scripts/automation-schema.mjs from pinned current UI pure logic.
export enum TriggerType {
  // ========= 计划模块（任务） =========

  /** 任务被创建时触发 */
  TaskCreated = 'taskCreated',

  /** 任务被完成时触发 */
  TaskCompleted = 'taskCompleted',

  /** 任务延期时触发 */
  TaskDelayed = 'taskDelayed',

  /** 任务定时触发 */
  TaskScheduled = 'taskScheduled',

  /** 所有子任务完成时触发 */
  AllSubTasksCompleted = 'allSubTasksCompleted',

  /** 子任务完成或者取消完成时触发 */
  SubTaskCompletedOrCancelled = 'subTaskCompletedOrCancelled',

  /** 一键催办任务触发 */
  UrgeDelayedTask = 'urgeDelayedTask',

  /** 任务变更时触发 */
  TaskChanged = 'taskChanged',

  // ========= 数据模块 =========

  /** 数据记录被创建时触发 */
  RecordCreated = 'recordCreated',

  /** 数据字段变更为特定值时触发 */
  DataFieldChanged = 'dataFieldChanged',

  /** 数据定时触发 */
  DataScheduled = 'dataScheduled',

  /** 数据按记录时间触发 */
  RecordDate = 'recordDate',

  // ========= 流程模块 =========

  /** 流程发起时触发 */
  ProcessStarted = 'processStarted',

  /** 流程完成时触发 */
  ProcessCompleted = 'processCompleted',

  /** 待办临近时间时触发 */
  ProcessTodoDueSoon = 'processTodoDueSoon',

  /** 关键节点预警 */
  ProcessKeyNodeWarning = 'processKeyNodeWarning',

  /** 流程待办延期后触发 */
  ProcessTodoDelayed = 'processTodoDelayed',

  /** 一键催办流程待办 */
  UrgeProcessTodo = 'urgeProcessTodo',

  /** 周期性自动发起流程 */
  ProcessScheduled = 'processScheduled',

  // ========= 周期性定时模块 =========

  /** 定时发送任务汇总通知 */
  DailyTaskSummary = 'dailyTaskSummary',

  /** 定时发送流程待办汇总通知 */
  DailyProcessSummary = 'dailyProcessSummary',

  /** 定时生成项目进展内容 */
  AutoGenerateAdvance = 'autoGenerateAdvance',

  // ========= 项目模块 =========

  /** 项目进展更新时触发 */
  AdvanceUpdated = 'advanceUpdated',
}
export enum TimingType {
  /** 无时间设置 */
  None = 'none',
  /** 任务开始前 */
  BeforeStart = 'beforeStart',
  /** 任务结束前 */
  BeforeEnd = 'beforeEnd',
  /** 延迟执行 */
  Delay = 'delay',
  /** 周期性执行 */
  Scheduled = 'scheduled',
  /** 每日执行 */
  Daily = 'daily',
}
export enum TimingUnit {
  Day = 'day',
  Hour = 'hour',
  Minute = 'minute',
}
export enum RecordDateCalculationType {
  DueDateMinusCurrentDate = 'dueDateMinusCurrentDate',
}
export enum RecordDateReminderDirection {
  /** 到期前 */
  Before = 'before',
  /** 到期当天 */
  On = 'on',
  /** 到期后 */
  After = 'after',
}
export enum RecordDateReminderUnit {
  Day = 'day',
  Month = 'month',
}
export interface IRecordDateReminderPoint {
  direction: RecordDateReminderDirection
  value: number
  unit: RecordDateReminderUnit
}
export enum SubTaskCompletionType {
  /** 完成或取消完成时 */
  CompletedOrCancelled = 'completedOrCancelled',
  /** 完成时 */
  Completed = 'completed',
  /** 取消完成时 */
  Cancelled = 'cancelled',
}
export enum SummaryType {
  /** 今日工作任务 */
  TodayWorkTasks = 'todayWorkTasks',
  /** 今日到期任务 */
  TodayDueTasks = 'todayDueTasks',
  /** 今日延期任务 */
  TodayOverdueTasks = 'todayOverdueTasks',
  /** 本周工作任务 */
  ThisWeekWorkTasks = 'thisWeekWorkTasks',
  /** 本周到期任务 */
  ThisWeekDueTasks = 'thisWeekDueTasks',
  /** 本周完成任务 */
  ThisWeekCompletedTasks = 'thisWeekCompletedTasks',
  /** 下周工作任务 */
  NextWeekWorkTasks = 'nextWeekWorkTasks',
  /** 下周到期任务 */
  NextWeekDueTasks = 'nextWeekDueTasks'
}
export enum SummaryTodoType {
  /** 今日工作待办 */
  TodayWorkTodos = 'todayWorkTodos',
  /** 今日到期待办 */
  TodayDueTodos = 'todayDueTodos',
  /** 今日延期待办 */
  TodayOverdueTodos = 'todayOverdueTodos',
  /** 本周工作待办 */
  ThisWeekWorkTodos = 'thisWeekWorkTodos',
  /** 本周到期待办 */
  ThisWeekDueTodos = 'thisWeekDueTodos',
  /** 本周完成待办 */
  ThisWeekCompletedTodos = 'thisWeekCompletedTodos',
  /** 下周到期待办 */
  NextWeekDueTodos = 'nextWeekDueTodos',
}
export enum FilterConjunction {
  And = 'and',
  Or = 'or',
}
export enum Operator {
  Is = 'is',
  IsNot = 'isNot',
  Contains = 'contains',
  DoesNotContain = 'doesNotContain',
  IsEmpty = 'isEmpty',
  IsNotEmpty = 'isNotEmpty',
  IsGreater = 'isGreater',
  IsGreaterEqual = 'isGreaterEqual',
  IsLess = 'isLess',
  IsLessEqual = 'isLessEqual',
  DoesNotContainSub = 'doesNotContainSub',
  OnlySub = 'onlySub',
  Todo = 'todo',
  IsDone = 'isDone',
  IsClose = 'isClose',
  IsDelay = 'isDelay',
  IsNotDelay = 'isNotDelay',
  Unconfirmed = 'unconfirmed',
  Confirming = 'confirming',
  Confirmed = 'confirmed',
  Unaudited = 'unaudited',
  Auditing = 'auditing',
  Change = 'change',
  Add = 'add',
  Remove = 'remove',
  IsRepeat = 'isRepeat',
}
export enum UpdateDateDuration {
  ExactDate = 'exactDate',
  AfterAutomationExecutionTime = 'afterAutomationExecutionTime',
  AfterProjectStartTime = 'afterProjectStartTime',
  AfterProjectEndTime = 'afterProjectEndTime',
}
export enum DatasheetUpdateDateDuration {
  AfterDatasheetFieldDateTime = 'afterDatasheetFieldDateTime',
}
export enum ActionType {
  /**
   * 任务相关发送通知
   */
  TaskNotify = 'taskNotify',
  /**
   * 数据相关发送通知
   */
  DatasheetNotify = 'datasheetNotify',
  /**
   * 流程相关发送通知
   */
  ProcessNotify = 'processNotify',
  /**
   * 流程待办相关发送通知
   */
  ProcessTodoNotify = 'processTodoNotify',

  /**
   * 任务汇总相关发送通知
   */
  TaskSummaryNotify = 'taskSummaryNotify',

  /**
   * 流程待办汇总相关发送通知
   */
  ProcessTodoSummaryNotify = 'processTodoSummaryNotify',

  /**
   * 项目进展相关发送通知
   */
  AdvanceNotify = 'advanceNotify',

  /**
   * 更新任务字段值
   */
  UpdateTaskField = 'updateTaskField',

  /**
   * 自动创建一个任务
   */
  CreateTask = 'createTask',

  /**
   * 自动完成任务
   */
  AutoCompleteParentTask = 'autoCompleteParentTask',

  /**
   * 根据子任务完成情况自动调整父任务进度
   */
  AutoUpdateParentTaskProgress = 'autoUpdateParentTaskProgress',

  /**
   * 自动发起一个流程
   */
  StartProcess = 'startProcess',

  /**
   * 自动创建一个项目
   */
  CreateProject = 'createProject',

  /**
   * 催办任务执行人
   */
  UrgeTask = 'urgeTask',

  /**
   * 催办流程待办执行人
   */
  UrgeTodo = 'urgeTodo',

  /**
   * 自动生成项目进展内容
   */
  GenerateAdvance = 'generateAdvance',
  /**
   * 任务移动
   */
  TaskMove = 'taskMove',
  /**
   * 更新数据字段值
   */
  UpdateDatasheetField = 'updateDatasheetField',
}
export enum NotifySenderType {
  Project = 'project',
  Editor = 'editor',
  Webhook = 'webhook',
  OtherEditor = 'otherEditor',
}
export enum JumpTarget {
  Project = 'project',
  Task = 'task',
  Datasheet = 'datasheet',
  Process = 'process',
  ProcessTodo = 'processTodo',
}
export enum WorkflowType {
  /** 新建任务通知 */
  CreateTaskNotification,

  /** 任务完成通知 */
  TaskCompletedNotification,

  /** 任务完成提醒 */
  TaskCompletedReminder,

  /** 任务延期提醒 */
  TaskDelayReminder,

  /** 任务字段变更后发送通知 */
  TaskChangeNotification,

  /** 定时提醒通知 */
  ScheduledReminderNotification,

  /** 一键催办任务 */
  UrgeDelayedTask,

  /** 自动完成父任务 */
  AutoCompleteParentTask,

  /** 子任务完成后自动调整父任务进度 */
  AutoAdjustTaskProgress,

  /** 任务字段变更后自动更新其他字段并通知 */
  AutoUpdateTask,

  /** 周期性定时更新任务字段并发送通知 */
  ScheduledTaskUpdate,

  /** 数据记录被创建时发送通知 */
  RecordCreatedNotification,

  /** 数据字段变更后发送通知 */
  DataChangeNotification,

  /** 定时提醒数据相关事项 */
  ScheduledDataReminderNotification,

  /** 数据字段变更后自动处理数据 */
  AutoProcessData,

  /** 周期性定时处理数据字段 */
  ScheduledDataProcessing,

  /** 数据创建时进行筛选器验证并反馈结果 */
  SubmitDataValidation,

  /** 数据字段变更后自动创建任务 */
  AutoCreateTask,

  /** 流程待办完成提醒 */
  ProcessTodoCompletedReminder,

  /** 流程待办延期提醒 */
  ProcessTodoDelayedReminder,

  /** 流程发起时发送通知 */
  ProcessStartNotification,

  /** 流程完成后发送通知 */
  ProcessEndNotification,

  /** 一键催办延期待办 */
  UrgeProcessTodo,

  /** 周期性自动发起流程 */
  AutoStartProcess,

  /** 流程完成后自动创建项目 */
  CreateProjectAfterProcess,

  /** 周期性发送任务延期汇总通知 */
  TaskSummaryNotification,

  /** 周期性发送流程待办汇总通知 */
  ProcessTodoSummaryNotification,

  /** 项目进展更新时发送通知 */
  AdvanceNotification,

  /** 周期性自动生成项目进展数据 */
  AutoGenerateAdvance,

  /** 关键节点预警 */
  ProcessKeyNodeWarning,

  /** 数据按记录时间提醒 */
  RecordDateReminder,
}
