# dsh-superagent

**简体中文** | [English](README.en.md)

> **仅供研究参考的原型，不是 DeepSeek 的官方产品。** 这份代码源自我们团队的日常开发工作，其中大部分工程由编码智能体完成。请把它当作研究代码，而不是可投入生产的软件。它仍可能包含缺陷，编码风格与工程实践也可能不一致。在你自己的环境中使用前，请先审查并调整。
>
> 我们为公开发布做了调整，因此它不同于我们的内部版本，也不同于《Exploring Super-agent Design: Towards a More Autonomous Agent System》一文描述的实现。文章中讨论的一些设计属于未来发展方向，并未在这个原型中实现。

dsh-superagent 是一个面向单个 Git 仓库（GitHub 或 GitLab）的主动式编码智能体，打包为 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle。它监听当前生效的 Git 宿主，也可以选择监听飞书。当获允许的人向智能体请求工作时，它会开一个工单，在自己的智能体会话和目录中处理，并在原对话中交付 pull request 或 merge request。一个 Web 面板显示哪些事项需要人处理。

它也是一种与智能体协作的方式：**占用尽可能少的人工注意力，提供尽可能多的价值。** 一个能为整个团队行动的智能体，也可能浪费整个团队的注意力；因此它只在被请求时、或在团队写下的规则允许时行动，并且只在有人必须行动、或能使用结果时才说话。[000 理念](docs/zh/000-philosophy.md)说明了这条原则，以及它对运营者的要求。

本 README 重建自初始版本的旧 README：保留免责声明、理念、安装说明、文档索引与许可证，并集中介绍此后新增的能力。

## 新增与增强

### GitLab 来源

- 同一个部署只启用一个 Git 来源：GitHub 或 GitLab。GitHub 的 Issue、pull request、评论和默认分支 CI 能力保持不变。
- GitLab 来源轮询项目中的 Issue、合并请求、note 和流水线，在原 note 中回复，把合并请求绑定到工单，并报告已合并或已关闭等终态。
- 支持自建 GitLab，包括通过 HTTP 提供的实例；提交、推送、合并请求、评审回复和 CI 修复都通过 `glab` 完成。
- 工单会读取流水线状态；合并请求的 CI 失败会作为输入回到执行器。

### Windows 原生部署

- 服务脚本改为跨平台的 Node 实现，Windows 上同样支持启动、状态、停止和重启，不再需要 tmux、Python 或 WSL。
- 执行器的命令层、准备命令、路由工具、提示词与技能都支持 PowerShell；Windows 主机只运行一个 Git 来源。
- 飞书来源在 Windows 上可用：宿主把 npm `lark-cli` 的 `.cmd` shim 解析到 Node 入口执行，参数不经过 `cmd.exe`。
- 项目的 Windows runner 在合并请求和默认分支上运行 `pnpm check`；真实的 Windows 工单已完成从 Issue 到合并请求和来源回复的端到端流程。细节与验证记录见 [009 Windows 部署](docs/zh/009-windows-deployment.md)。

### 谷价时段调度

- Superagent 可以把复杂且不紧急的工单标记为 `offPeak`；它的执行器只在执行设置中的每日窗口内启动新的派工。
- 窗口默认关闭，可配置开始时间、结束时间、IANA 时区，并支持跨午夜；运行中的派工和唤醒空闲执行器的投递不会被推迟。默认起止时间为 `22:00`–`08:00`（`Asia/Shanghai`），对应北京时间谷价时段。

### 中文优先

- 默认 README 为简体中文，英文版见 [README.en.md](README.en.md)；编号文档和面板文案都提供中英双语。
- GitHub 与 GitLab 上的标题、描述、评论和评审回复跟随发起请求的语言；中文请求使用中文，仓库里的英文文本不会让智能体改回英文。

### 服务生命周期与运维

- 管理 API 提供 `POST service/stop`：先排空执行器（最多十秒），再通过 DSH 启动器退出；服务脚本用它实现 Windows 上不依赖 POSIX 信号的停止。
- 服务脚本为每个 profile 使用独立的 tmux socket，并在启动前清除继承的 `TMUX` 和 `TMUX_PANE`，避免任务误杀同一台机器上的其他服务。
- 面板的部署页显示启动问题、状态目录和本机上限，并可以重新运行安装检查。

### 执行器上下文压缩

- worker 会话在上下文达到窗口的 40%（`thresholdRatio: 0.4`）时触发压缩，早于默认上限；长工单的后续请求因此不会长时间贴着窗口上限运行。

### 更严格的飞书权限

- 飞书来源只消费消息事件并回复，不再调用需要读取消息、历史、群或成员的接口。因此它无法补收离线期间的消息、按 ID 读取话题或同步群成员，群 ID 和允许名单需要手工填写。

## 工作方式

1. **触发。** GitHub 来源轮询 Issue、pull request、评论和默认分支 CI；GitLab 来源轮询 Issue、合并请求、note 和流水线；配置后，飞书群、私信和其他群也会产生触发。每个触发是一个不可变事件，属于一个线程。
2. **准入与研判。** 允许名单和每个来源的准入表决定谁可以请求工作、哪些消息算明确请求。其余消息进入评估：接单模式 `observe`（默认）只记录主动接单，`auto` 才会真正接单，并且主动接单必须匹配团队写下的规则。
3. **工单。** 接受的工作变成工单，附带不可变的授权，记录当时的策略版本、范围、强度和匹配规则。线程订阅让工单直接收到后续讨论，无需再次点名智能体。
4. **执行。** 每个工单得到一个 `worker-<ticket>` 的 DSH Session 和一个独立工作目录；准备命令创建工作树，执行器在目录中实现、测试和提交。工单按执行器槽位调度，人的消息可以优先获得槽位。
5. **交付与跟进。** 执行器在原对话中回复，并打开或更新 pull request / merge request；评审意见、CI 结果和人的后续消息都能回到工单。工单关注它打开的 pull request，直到全部关闭或合并；已结束的工单保留订阅，人之后的评论可以在同一授权下恢复它。
6. **监督。** 在 DeepSeek Harness Web 的侧边栏打开 **Superagent**：面板先显示需要人处理的事项，再显示系统健康和历史。

## 快速开始

安装配置步骤较多，由编码智能体和运营者一起完成。请让你的编码智能体执行：

> 阅读本仓库的 SETUP.zh-CN.md，和我一起安装配置 dsh-superagent。

它会一次只问一个简短的问题，一次性展示完整计划，然后安装并配置好一切。前置条件是 Node.js 22.19+ 或 24+、pnpm、Git 2.32+、GitHub CLI 或 GitLab CLI，以及处于 `package.json` 的 `engines.dsh` 范围内的 DeepSeek Harness；Windows 主机的差异见 [009 Windows 部署](docs/zh/009-windows-deployment.md)。完整步骤、账号配置和故障排查见 [006 部署](docs/zh/006-deployment.md)。

## 文档

请按顺序阅读编号文档；每篇只建立在此前的文档之上。

- [000 理念](docs/zh/000-philosophy.md)
- [001 领域模型](docs/zh/001-domain.md)
- [002 授权机制](docs/zh/002-authorization.md)
- [003 执行](docs/zh/003-execution.md)
- [004 提示词](docs/zh/004-prompts.md)
- [005 面板](docs/zh/005-panel.md)
- [006 部署](docs/zh/006-deployment.md)：手动安装配置、配置、升级和故障排查
- [007 架构](docs/zh/007-architecture.md)
- [008 实操手册](docs/zh/008-cookbook.md)：添加来源
- [009 Windows 部署](docs/zh/009-windows-deployment.md)：必要性、适配方案、分阶段实施与验证记录
- [010 Session 保留机制](docs/zh/010-session-retention.md)：Session、工作目录和数据库的增长测量与清理提案

## 开发

`pnpm check` 会运行类型检查、测试和构建；`pnpm typecheck`、`pnpm test` 和 `pnpm build` 可以单独运行。

- `src/`：领域模型、来源、执行器、面板与 HTTP API。
- `prompts/`、`skills/`：主 Session 与执行器使用的提示词和技能。
- `docs/`、`docs/zh/`：英文与中文文档。
- `tests/`：Vitest 测试。
- `cordis.patch.yml`：DSH bundle 的定义。

## 许可证

[MIT](LICENSE)