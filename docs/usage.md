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

## 项目流程和独立流程

只有流程名称时，先用 `workflow find`。结果分别标出应用和已发起实例，并给出实际归属、`target` 和 `exportTarget`。名称重合时，按项目、应用、实例或创建时间辨认具体对象。已知 ID 时可直接传 `--application-id` 或 `--process-id`。

```sh
rsq workflow find --name '供应商审核'
rsq workflow export --name '供应商审核' --output ./供应商审核.xlsx
rsq workflow export --application-id '<应用ID>' --form-name '基本信息'
```

导出按实际应用的导出权限读取可见实例、步骤和表单，保存为 Excel。可以用 `--status`、`--created-between` 或表单名称缩小范围。省略 `--output` 时保存到当前目录并自动命名。传入已有目录时按相同规则命名，显式文件名必须是新的 `.xlsx` 路径。stdout 返回文件路径和记录数。

项目里的流程模块用 `project workflow`。先从项目取得 `projectId`，再从模块目录取得 `applicationId`。CLI 校验项目流程功能及实际模块归属。

```sh
rsq project workflow modules list --project-id '<项目ID>'
rsq project workflow configuration inspect --project-id '<项目ID>' --application-id '<应用ID>'
rsq project workflow form records list --project-id '<项目ID>' --application-id '<应用ID>' --form-id '<表单ID>'
rsq project workflow instance inspect --project-id '<项目ID>' --process-id '<实例ID>'
```

`form describe` 查看字段定义，`form records list` 查看实例中已填写的值。项目记录按可见实例分页，即使某页没有匹配表单，也按 `pagination.nextPage` 继续。`instance inspect` 返回该实例可见的步骤、表单和可用动作。

从独立「流程」系统打开的应用用 `workflow`，例如 `rsq workflow configuration inspect --application-id '<应用ID>'`。它使用独立流程功能，表单记录可按配有查看权限的表格分页。

从 `todo list`、`todo pending list` 或 `cooperation workflow list` 打开流程待办时，直接使用列表项的 `target`。CLI 自动核对归属和权限，返回实际步骤、表单和可用动作。

```sh
rsq todo workflow inspect --process-id '<待办的实例ID>' --step-id '<待办的步骤ID>'
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
