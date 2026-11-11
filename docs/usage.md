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
