# dsh-superagent

**简体中文** | [English](README.en.md)

> **本仓库是 [DeepSeek 官方 dsh-superagent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 fork。** 官方 [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) 说明了项目是什么、如何工作以及通用文档。本 README 只记录本 fork 与官方的差异，以及在本 fork 上部署所必需的内容；官方 README 的内容不在这里重复。

## 本 fork 的差异

本 fork 相对官方原型的改动按重要性分组如下。

### 重点功能

#### GitLab 来源与宿主切换

让本 fork 可以直接在 GitLab（包括自建实例）上工作，不必依赖 GitHub，并能在面板里安全切换 Git 宿主。

- 官方原型只接入 GitHub；本 fork 增加了 GitLab 来源。每个部署只有一个生效的 Git 来源；在 profile 中安装两个 Git 插件后，可在来源页切换当前宿主。
- 切换是一个动作：先校验目标账号和仓库，再只重启一次；旧宿主还有未结束工单时，切换会列出它们，要求先停止或明确确认。工单记录接受时的宿主，不能在另一个宿主上恢复；切回原宿主后可以继续。
- GitLab 来源轮询项目中的 Issue、合并请求、note 和流水线，在原 note 中回复，把合并请求绑定到工单，并把 CI 状态送回执行器。
- 可选配置 GitLab webhook：来源自动在项目里创建或更新 webhook，事件到达时立即触发同步；需要 GitLab 可访问的稳定地址；不配置时仍按轮询工作。
- 支持自建 GitLab，包括通过 HTTP 提供的实例；提交、推送、合并请求、评审回复和 CI 修复通过 `glab` 完成。

#### 工单分类、模型档位与接力

- 工单按 `query`、`research` 或 `development` 划分授权范围，能力档位 `low` / `high` 独立选择模型；默认查询为 `low`，其他工作为 `high`。未配置档位模型时依次回退到类别模型、执行器默认模型和宿主默认模型；已有 Session 不会因设置变更而换模型。
- 同一授权任务需要更强能力时，符合条件的飞书来源 `low` 工单可接力给新的 `high` 工单；它继承原授权，不扩大范围。接力使用摘要和新工作目录，不保证完整上下文或切换期间绝无重复。条件与配置见 [003 执行](docs/zh/003-execution.md#工单类别与模型)。

#### Windows 原生部署

让服务直接跑在原生 Windows 主机上，不需要 WSL、tmux 或 Python。

- 官方原型面向 POSIX 主机；本 fork 把服务脚本改为跨平台 Node 实现，Windows 上同样支持启动、状态、停止和重启。
- 执行器的命令层、准备命令、路由工具、提示词与技能支持 PowerShell；飞书来源通过 npm `lark-cli` 的 `.cmd` shim 解析到 Node 入口运行。
- 项目 Windows runner 在合并请求和默认分支上运行 `pnpm check`；真实的 Windows 工单已完成从 Issue 到合并请求和来源回复的端到端流程。细节与验证记录见 [009 Windows 部署](docs/zh/009-windows-deployment.md)。

#### 谷价时段调度

把不紧急的工单按来源排入模型谷价时段，降低长任务的模型成本。

- 官方原型没有该调度；本 fork 可把工单标记为 `offPeak`，其执行器只在执行设置中的每日窗口内启动新的派工。已知有峰谷价的模型（目前为 `deepseek-v4.1-flash`）上，飞书需求默认立即执行，GitLab 和 GitHub 需求默认排入谷价时段；其他或未知模型默认立即执行。显式指定仍可对任何模型延后或立即执行。
- 窗口默认关闭，可配置开始时间、结束时间、IANA 时区，并支持跨午夜；默认起止时间 `22:00`–`08:00`（`Asia/Shanghai`）对应北京时间谷价时段。

#### 任务级 Watchdog 巡检

预期的新独立 Watchdog observer 按固定间隔通过 `GET /orchestrator/api/watchdog` 读取服务和工单快照，不使用长轮询，并在本地记录状态、日志和心跳。它不运行模型、不发飞书、不向服务写入、不自动恢复服务或工单、不轮询部署请求，也不自更新；launcher 只运行当前安装的版本。

这不是主动通知，须人工查看或另行配置独立告警。服务侧 enforce 恢复 API 仍可能可调用；只读 observer 不会禁用它。现有生产必须单独部署新 Watchdog 才能生效，旧安装和独立任务可能仍保留旧行为。部署与限制见 [006 部署](docs/zh/006-deployment.md#独立-watchdog-进程)。

#### 飞书只读答疑

让名单外的人或机器人在指定群聊里提问，而不会获得执行权限。

- 群聊可在准入表里把「名单外 · 点名智能体」设为只读答疑：那里的任何人（包括机器人和智能体）提问时，智能体只读调查后回答，不修改文件、不提交、不打开变更请求，也不交付 pull request。
- 私聊不开放只读答疑，仍只允许名单内的人；名单外的私聊一律忽略。

### 特别注意

- **更严格的飞书权限。** 官方原型包含读取消息与群信息的接口；本 fork 的飞书来源只消费消息事件并回复，不再需要这些读取权限。因此它无法补收离线期间的消息、按 ID 读取话题或同步群成员，群 ID 和允许名单需要手工填写。

### 其他改动

- **中文优先。** 官方仓库的文档只有英文；本 fork 增加了编号文档和 SETUP 的简体中文翻译，并把默认 README 改为简体中文（英文版见 [README.en.md](README.en.md)）。GitHub 与 GitLab 上的标题、描述、评论和评审回复跟随请求语言。
- **服务生命周期与运维。** 增加 `POST service/stop`：先排空执行器（最多十秒），再通过 DSH 启动器退出；服务脚本为每个 profile 使用独立 tmux socket，并在启动前清除继承的 `TMUX`/`TMUX_PANE`；面板部署页显示启动问题、状态目录和本机上限，并可重新运行安装检查。
- **工单工作目录回收。** 工单结束后，干净且提交都在远端的链接 worktree 和本地分支会被自动回收；工单自己打开的合并请求全部合并后，若远端分支顶端仍是本地 HEAD，也会删除远端分支。有未提交或未推送工作的目录会保留。
- **执行器上下文压缩。** worker 会话在上下文达到窗口的 40%（`thresholdRatio: 0.4`）时压缩，避免长工单的后续请求长时间贴着窗口上限。

## 部署

本 fork 沿用官方的安装配置流程，并补充 GitLab 与 Windows 的步骤。

- 让编码智能体阅读 [SETUP.zh-CN.md](SETUP.zh-CN.md)（英文 [SETUP.md](SETUP.md)），与运营者一起完成安装配置。
- 账号、手工步骤、升级和故障排查见 [006 部署](docs/zh/006-deployment.md)；Windows 主机的差异见 [009 Windows 部署](docs/zh/009-windows-deployment.md)。
- 前置条件：Node.js 24.9+、pnpm、Git 2.32+、GitHub CLI 2.48+ 或 GitLab CLI 1.36+，以及处于 `package.json` 的 `engines.dsh` 范围内的 DeepSeek Harness；POSIX 主机还需要 tmux 和 Python 3.8+，Windows 主机还需要 PowerShell 7 与原生 `gh`/`glab`。完整清单见 SETUP。

## 文档

通用背景可参考[官方 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md)；本 fork 的当前行为以本仓库文档为准：

- [003 执行](docs/zh/003-execution.md)：工单类别、模型选择、接力及运行恢复。
- [012 Worker 交接设计](docs/zh/012-worker-handoff.md)：更广泛的交接方案，尚未实现；不要与现有能力接力混淆。
- [009 Windows 部署](docs/zh/009-windows-deployment.md)：必要性、适配方案、分阶段实施与验证记录。
- [010 Session 保留机制](docs/zh/010-session-retention.md)：Session、工作目录和数据库的增长测量、已实现的工作目录与分支回收，以及后续清理提案。
- [011 多 Git 来源](docs/zh/011-multi-git-sources.md)：一个部署使用多个 Git 来源或项目的现状、可行性评估与分阶段建议。
- 全部编号文档的简体中文翻译，位于 `docs/zh/`。

## 许可证

[MIT](LICENSE)。官方项目同样使用 MIT 许可证。