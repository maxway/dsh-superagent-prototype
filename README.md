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
- 可选配置 GitLab webhook：来源自动在项目里创建或更新 webhook，事件到达时立即触发同步；不配置时退化为轮询，适合有固定 IP 的部署。
- 支持自建 GitLab，包括通过 HTTP 提供的实例；提交、推送、合并请求、评审回复和 CI 修复通过 `glab` 完成。

#### Windows 原生部署

让服务直接跑在原生 Windows 主机上，不需要 WSL、tmux 或 Python。

- 官方原型面向 POSIX 主机；本 fork 把服务脚本改为跨平台 Node 实现，Windows 上同样支持启动、状态、停止和重启。
- 执行器的命令层、准备命令、路由工具、提示词与技能支持 PowerShell；飞书来源通过 npm `lark-cli` 的 `.cmd` shim 解析到 Node 入口运行。
- 项目 Windows runner 在合并请求和默认分支上运行 `pnpm check`；真实的 Windows 工单已完成从 Issue 到合并请求和来源回复的端到端流程。细节与验证记录见 [009 Windows 部署](docs/zh/009-windows-deployment.md)。

#### 谷价时段调度

把不紧急的工单按来源排入模型谷价时段，降低长任务的模型成本。

- 官方原型没有该调度；本 fork 可把工单标记为 `offPeak`，其执行器只在执行设置中的每日窗口内启动新的派工。飞书需求默认立即执行，除非明确可以延后；GitLab 和 GitHub 需求默认排入谷价时段，除非明确紧急。
- 窗口默认关闭，可配置开始时间、结束时间、IANA 时区，并支持跨午夜；默认起止时间 `22:00`–`08:00`（`Asia/Shanghai`）对应北京时间谷价时段。

#### 任务级 Watchdog 巡检

在进程巡检之外增加任务级监督，让卡住或偏离目标的工单能被发现。

- 独立 profile 中的定时会话通过只读路由 `GET /orchestrator/api/watchdog` 读取全部进行中工单的阶段、最近报告与静默时长，结合机械信号和模型判断，把异常报告给运营者。
- `watchdog` 设置块提供 `off`/`observe`/`report`/`enforce` 四档，默认 `observe`；只有 `enforce` 能通过专用 API 执行允许的 retry/stop，且要经过快照新鲜度、工单变化、等待人工、人类跟进、未送达输入、谷价排队、暂停/未配置、静默阈值、冷却与按工单/全局限流检查。所有决定持久化到 SQLite 审计，`GET watchdog` 返回最近记录。
- `scripts/dsh-superagent watchdog` 输出机器可读快照（含设置、最近审计与 `lastRun`），`watchdog run [--note <text>]` 把本次观测从实时快照记录下来（没有异常也记，保留 30 天），`watchdog runs [--limit <n>]` 列出最近的观测结果，`watchdog retry|stop <ticket> --reason` 向服务端请求一次决定；stop 默认不在允许动作里。`watchdog report --chat <chat id> [--note <text>]` 让服务端把观察汇总（服务状态、有信号的工单、最近决定）通过飞书机器人发到该会话，Watchdog 可以直接把要报告的事发到运营者平时看的地方。也可以把 `scripts/watchdog` 作为独立进程运行：它有自己的配置、状态、日志与 pid，不依赖 DSH profile，每轮记录一次观测、仅在机械发现变化时发飞书，并为后续主机/部署检查留出入口。从 Watchdog 修改提示词或其他设置仍留待后续阶段。

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

通用设计与开发文档与官方一致，入口见[官方 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md)。本 fork 额外提供：

- [009 Windows 部署](docs/zh/009-windows-deployment.md)：必要性、适配方案、分阶段实施与验证记录。
- [010 Session 保留机制](docs/zh/010-session-retention.md)：Session、工作目录和数据库的增长测量、已实现的工作目录与分支回收，以及后续清理提案。
- [011 多 Git 来源](docs/zh/011-multi-git-sources.md)：一个部署使用多个 Git 来源或项目的现状、可行性评估与分阶段建议。
- 全部编号文档的简体中文翻译，位于 `docs/zh/`。

## 许可证

[MIT](LICENSE)。官方项目同样使用 MIT 许可证。