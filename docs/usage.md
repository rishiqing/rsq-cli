# 使用示例

先登录，再确认实际用户和公司：

```sh
rsq login --profile work
rsq whoami --profile work
rsq organization list --profile work
```

所有业务从 Schema 发现：

```sh
rsq schema
rsq schema project
rsq schema 'project template'
rsq schema 'project workflow'
rsq schema workflow
rsq schema replay
rsq schema datasheet
```

完整命令名、参数和复杂 JSON 结构以叶子 Schema 为准。不要猜选项、资源 ID、字段类型或模板上下文。`--input -` 从标准输入读取 JSON，`--input request.json` 读取文件。先用 `--dry-run` 离线检查写操作计划，再执行并读取结果。

```sh
rsq schema 'task get'
rsq task get --id '<任务ID>' --profile work
```

普通项目和项目模板分别选择命令。流程配置和流程执行也分别发现。先通过列表、上下文命令获取目标，再创建、编辑或推进状态；模板应用后核对实际创建的资源。写入失败时检查 `completedSteps`、`resources`、`failedStep`、`writeOutcome`，用读取命令核实结果。

## 读取 JSON 结果

业务编排命令成功时，stdout 的 JSON 顶层包含 `command`、`completedSteps`、`resources` 和 `result`。叶子 Schema 的 `resultSchema` 对应 `.result` 内的业务数据。直接接口命令按自己的响应 Schema 读取。脚本先检查 CLI 的退出码，失败时从 stderr 查看错误。`--dry-run` 的计划由顶层的 `dryRun: true` 标记。

## 项目流程和独立流程

只有流程名称时，先用 `workflow find`。`.result.items` 中的匹配项分别标出应用和已发起实例，并给出实际归属和 `target`。应用结果包含 `exportTarget`。名称重合时，按项目、应用、实例或创建时间辨认具体对象。查找支持 `--application-id` 和 `--process-id`。

```sh
rsq --format json workflow find --name '供应商审核' | jq -e '.result.items'

# 先在一个终端启动接收进程
rsq export watch --output ./exports

# 看到 listening 后，在另一个终端用同一 profile 发起
rsq workflow export --name '供应商审核'
rsq workflow export --application-id '<应用ID>' --form-name '基本信息'
```

网页导出按应用和筛选条件发起。`--instance-name` 按流程标题做包含匹配，`--status` 和 `--created-between` 进一步筛选实例。`--form-name` 或 `--form-id` 可指定表单列。省略表单选择时使用当前账号在网页保存的导出字段。

`.result.status` 为 `accepted` 说明流程服务已受理，`.result.exportId` 是受理标识。接收进程通过 HTTP 长轮询收取当前账号的在线通知并保存原文件，包括从网页发起的导出。文件保存后输出一行 NDJSON，`type` 为 `file`，`output` 为本地路径，`bytes` 为文件大小。原文件名相同时追加编号。每个账号启动一个接收进程，文件事件按账号接收，无法对应某一次发起。按 Ctrl+C 停止接收。断线或未运行期间的通知无法补收。

项目里的流程模块用 `project workflow`。先从项目取得 `projectId`，再从模块目录取得 `applicationId`。CLI 校验项目流程功能及实际模块归属。

```sh
rsq project workflow modules list --project-id '<项目ID>'
rsq project workflow configuration inspect --project-id '<项目ID>' --application-id '<应用ID>'
rsq project workflow form records list --project-id '<项目ID>' --application-id '<应用ID>' --form-id '<表单ID>'
rsq project workflow instance inspect --project-id '<项目ID>' --process-id '<实例ID>'
```

`form describe` 查看字段定义，`form records list` 查看实例中已填写的值。项目记录按可见实例分页，即使某页没有匹配表单，也按 `pagination.nextPage` 继续。`instance inspect` 返回该实例可见的步骤、表单和可用动作。

从独立「流程」系统打开的应用用 `workflow`，例如 `rsq workflow configuration inspect --application-id '<应用ID>'`。它使用独立流程功能，表单记录可按配有查看权限的表格分页。

从 `todo list`、`todo pending list` 或 `cooperation workflow list` 打开流程待办时，直接使用列表项的 `target`。CLI 自动核对归属和权限，返回实际步骤、表单和可用动作。指定待办步骤后，使用 `.result.step.actions` 核对当前账号可执行的动作。

```sh
rsq --format json todo workflow inspect --process-id '<待办的实例ID>' --step-id '<待办的步骤ID>' |
  jq -e '.result | objects | {scope, target, actions: .step.actions}'
```

## 复盘

填写日、周、月复盘，先查 `replay report context`，使用返回的 `replayCollectTemplateComponentId` 填写问题。若复盘 `id` 为空，先运行 `replay report create`。

```sh
rsq replay report question set --collection-id '<复盘集ID>' --date 2026-11-01 --component-id '<模板组件ID>' --text '完成本期计划'
```

带格式正文用 `--input replay-answer.json`，文件示例（`text` 与 `content` 二选一）：

```json
{
  "collectionId": "7001",
  "date": "2026-11-01",
  "componentId": "8101",
  "content": {
    "ops": [
      { "insert": "本期成果", "attributes": { "bold": true } },
      { "insert": "\n第二段。\n" }
    ]
  }
}
```

替换示例 ID 后先用 `--dry-run` 检查，再执行。CLI 会转换编辑器格式并读回核对；`--text ''` 清空该问题的答案。

Agent 使用随包的 [Skill](../skills/rsq-cli/SKILL.md)。默认 JSON 写入 stdout，提示写入 stderr。`rsq --help` 显示输出格式、字段筛选等全局选项。
