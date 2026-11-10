# rsq-cli

日事清命令行工具，为用户和 AI Agent 提供任务、项目、流程、OKR、复盘、绩效、文档等业务操作。

[![Release](https://img.shields.io/github/v/release/rishiqing/rsq-cli?include_prereleases&label=release)](https://github.com/rishiqing/rsq-cli/releases)
[![CI](https://github.com/rishiqing/rsq-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/rishiqing/rsq-cli/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[安装](#安装) · [登录](#登录) · [快速开始](#快速开始) · [Agent 使用](#agent-使用) · [更新](#更新) · [版本发布](https://github.com/rishiqing/rsq-cli/releases)

## 安装

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/rishiqing/rsq-cli/main/scripts/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/rishiqing/rsq-cli/main/scripts/install.ps1 | iex
```

安装包自带运行时，无需预装 Node.js。支持 macOS、Linux、Windows 的 x64 和 ARM64；Linux 需要 glibc。

也可以在 [Releases](https://github.com/rishiqing/rsq-cli/releases) 下载对应平台的安装包，查看版本更新和 SHA256 校验文件。

## 登录

```sh
rsq login
```

按提示选择登录方式，也可以直接指定：

```sh
# 企业微信登录：打开浏览器扫码
rsq login --method wecom

# 日事清账号密码登录：在终端按提示输入
rsq login --method password

# 查看当前账号和公司
rsq whoami

# 退出登录
rsq logout
```

登录支持：

- [x] 日事清账号密码
- [x] 企业微信
- [ ] 飞书
- [ ] 钉钉
- [ ] WPS

使用多个账号时，通过 `--profile` 保存和选择会话。CLI 遵循当前账号的组织和资源权限。

## 快速开始

```sh
# 查看帮助
rsq --help

# 发现业务模块、操作和参数
rsq schema
rsq schema task
rsq schema "task get"

# 查询任务
rsq task get --id '<任务ID>'
```

| 业务 | 发现命令 |
| --- | --- |
| 任务与日程 | `rsq schema task` |
| 项目、项目集与项目模板 | `rsq schema project` |
| 流程配置与审批 | `rsq schema workflow` |
| OKR、行动与执行台 | `rsq schema okr`、`rsq schema action`、`rsq schema execution` |
| 复盘与绩效 | `rsq schema replay`、`rsq schema appraisal` |
| 文档与数据表 | `rsq schema doc`、`rsq schema datasheet` |
| 文件与交付物 | `rsq schema file`、`rsq schema deliverable` |
| 统计与组织管理 | `rsq schema statistics`、`rsq schema organization`、`rsq schema contact` |

复杂参数通过 `--input request.json` 或 `--input -` 传入。写操作可先使用 `--dry-run` 查看计划；删除等需要确认的操作，非交互执行时使用 `--yes`。

更多示例见[使用指南](docs/usage.md)。

## Agent 使用

提供结构化 JSON 输出、逐级 Schema 和随包 [Skill](skills/rsq-cli/SKILL.md)。Agent 可先查询当前身份，再通过 Schema 发现所需资源、参数与操作影响：

```sh
rsq whoami
rsq schema
rsq schema project
rsq schema "project template create"
```

Schema 返回当前安装的 Skill 路径。操作前获取资源上下文，执行后使用查询命令核对结果。

## 更新

```sh
rsq upgrade --check
rsq upgrade --yes
```

查看版本或回滚到上次安装：

```sh
rsq upgrade --list
rsq upgrade --rollback --yes
```

升级与回滚保留已有登录会话。版本更新和安装包见 [Releases](https://github.com/rishiqing/rsq-cli/releases)。

## 开发

需要 Node.js 22：

```sh
npm ci
npm test
```

## 许可证

[Apache-2.0](LICENSE)
