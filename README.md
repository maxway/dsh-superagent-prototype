# dsh-superagent

**简体中文** | [English](README.en.md)

> **本仓库是 [DeepSeek 官方 dsh-superagent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 fork。** 官方 [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) 说明了项目是什么、如何工作以及通用文档。本 README 只记录本 fork 与官方的差异，以及在本 fork 上部署所必需的内容；官方 README 的内容不在这里重复。

## 本 fork 的差异

本 fork 相对官方原型的改动按重要性分组如下。

### 重点功能

#### GitLab 来源

让本 fork 可以直接在 GitLab（包括自建实例）上工作，而不必依赖 GitHub。

- 官方原型只接入 GitHub；本 fork 增加了可切换的 GitLab 来源，每个部署在 GitHub 与 GitLab 之间二选一。
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

### 特别注意

- **更严格的飞书权限。** 官方原型包含读取消息与群信息的接口；本 fork 的飞书来源只消费消息事件并回复，不再需要这些读取权限。因此它无法补收离线期间的消息、按 ID 读取话题或同步群成员，群 ID 和允许名单需要手工填写。

### 其他改动

- **中文优先。** 官方仓库的文档只有英文；本 fork 增加了编号文档和 SETUP 的简体中文翻译，并把默认 README 改为简体中文（英文版见 [README.en.md](README.en.md)）。GitHub 与 GitLab 上的标题、描述、评论和评审回复跟随请求语言。
- **服务生命周期与运维。** 增加 `POST service/stop`：先排空执行器（最多十秒），再通过 DSH 启动器退出；服务脚本为每个 profile 使用独立 tmux socket，并在启动前清除继承的 `TMUX`/`TMUX_PANE`；面板部署页显示启动问题、状态目录和本机上限，并可重新运行安装检查。
- **执行器上下文压缩。** worker 会话在上下文达到窗口的 40%（`thresholdRatio: 0.4`）时压缩，避免长工单的后续请求长时间贴着窗口上限。

## 部署

本 fork 沿用官方的安装配置流程，并补充 GitLab 与 Windows 的步骤。

- 让编码智能体阅读 [SETUP.zh-CN.md](SETUP.zh-CN.md)（英文 [SETUP.md](SETUP.md)），与运营者一起完成安装配置。
- 账号、手工步骤、升级和故障排查见 [006 部署](docs/zh/006-deployment.md)；Windows 主机的差异见 [009 Windows 部署](docs/zh/009-windows-deployment.md)。
- 前置条件：Node.js 22.19+ 或 24+、pnpm、Git 2.32+、GitHub CLI 或 GitLab CLI，以及处于 `package.json` 的 `engines.dsh` 范围内的 DeepSeek Harness。

## 文档

通用设计与开发文档与官方一致，入口见[官方 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md)。本 fork 额外提供：

- [009 Windows 部署](docs/zh/009-windows-deployment.md)：必要性、适配方案、分阶段实施与验证记录。
- [010 Session 保留机制](docs/zh/010-session-retention.md)：Session、工作目录和数据库的增长测量与清理提案。
- 全部编号文档的简体中文翻译，位于 `docs/zh/`。

## 许可证

[MIT](LICENSE)。官方项目同样使用 MIT 许可证。