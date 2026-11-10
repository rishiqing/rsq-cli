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

Agent 使用随包的 [Skill](../skills/rsq-cli/SKILL.md)。默认 JSON 写入 stdout，提示写入 stderr。`rsq --help` 显示输出格式、字段筛选等全局选项。
