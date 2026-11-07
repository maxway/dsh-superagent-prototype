# Super-agent 设计差距分析

> 对照 [super-agent-design.md](super-agent-design.md) 与当前实现，梳理设计中尚未落地、或只有近似实现的重要能力。基线：`main` @ `0be6513`（2026-11-08）；与上一版基线（`e095162`，2026-11-07）相比，Watchdog 阶段 2（MR !30、!32）、Git 宿主切换（011 方案 A，MR !34）和 Windows 原生部署（见 [006 部署](../006-deployment.md)、[009 Windows 部署](../009-windows-deployment.md)）已并入主线。设计文档本身是一篇架构探讨，不是产品功能清单；本文只陈述实现与设计之间的差距，不改变设计。每项状态都给出可核查的代码入口或合并请求，剩余工作的拆分与并行边界见 [落地计划](super-agent-design-roadmap.md)。

## 结论

设计用五个模块支撑四个基础特征：双层架构（第 2 节）、事件驱动（第 3 节）和面向人的交互（第 4 节）负责*连续*、*高效*、*主动*；计算、状态与环境的分离（第 5 节）和 Watchdog（第 6 节）负责*持久*。

当前实现已经落地前三个模块的主体，包括第 3 节中的过滤、订阅直通和上下文组织：

- **已实现**：双层架构、两级过滤、订阅与直通、Inline & Spill 与链式召回（GitHub 与 GitLab）、异步后台作业、IM 与 Git 信道的定制交互；部署也支持原生 Windows 上的本机进程（[009 Windows 部署](../009-windows-deployment.md)）。
- **未实现**：计算与状态分离（5.1）、计算与执行环境分离（5.2）。这是设计五个模块中缺失的两个。
- **部分实现**：Watchdog（第 6 节）的只读巡检与 retry/stop 介入已落地（MR !28、!30、!32），缺从 Watchdog 修改设置或提示词；投机执行（3.4）可以由主动规则近似，但没有决定前提前行动的独立机制。
- **设计自身的开放问题**：长程记忆、Router 水平切分、A2A、安全与隐私（第 8 节）在设计里也没有答案，当前实现同样未解决，不应算作本项目的实现缺口。
- **范围与限制**：飞书没有线程上下文读取，链式召回在飞书线程上受限；邮件、文档等信道未接入；没有第 7 节那样的架构级评测。

## 对照表

| 设计章节 | 能力 | 当前状态 | 核查入口 |
| --- | --- | --- | --- |
| 2 | 双层架构：Router 层 + Worker 层 | 已实现 | `cordis.patch.yml` 定义 `dsh-superagent-router` 与 `dsh-superagent-worker` 两个 preset；`src/app/sessions.ts`、`src/executor/dsh.ts` 为每个工单创建隔离的 worker Session |
| 3.1 | 两级过滤：程序层 + 语义层 | 已实现 | `src/policy.ts` 的 `gate` 做确定性准入；`src/app/assessment.ts` 的 `MasterAssessor` 做语义研判 |
| 3.2 | 订阅与直通 | 已实现 | `src/core/intake.ts` 把触发扇出给订阅工单；`src/core/tickets.ts` 维护订阅、交回与取消；`tests/core-engine.spec.ts` |
| 3.3 | Inline & Spill 与链式召回 | 已实现，飞书受限 | `src/app/resources.ts` 的分页资源与 `src/app/cards.ts` 的 `textPage`/`newestPage`；`src/sources/github-read.ts`、`src/sources/gitlab-read.ts` 的 `threadContext` 读取；`src/sources/feishu.ts` 顶部注释说明飞书没有上下文读取权限 |
| 3.4 | 投机执行（预期提前行动） | 近似实现 | 主动规则见 `src/policy.ts` 的准入表与 `admitsInferred`；仓库中没有 `speculative` 配置，也没有决定前启动的可取消预执行路径 |
| 4.1 | 全双工、异步 ReAct | 已具备（依赖 DSH） | `cordis.patch.yml` 把前台命令与作业等待限制在 5 秒后转后台；`src/executor/background.ts`；`prompts/work.md` |
| 4.2 | 多信道交互 | 已实现（飞书/GitHub/GitLab） | `src/sources/*-channel.ts`、`src/app/outbox.ts`；`src/infra/text.ts` 的 `IM_WORDS = 100`；`src/sources/` 下没有邮件或文档来源 |
| 5.1 | 计算与状态分离 | 未实现 | `src/core/ports.ts` 只提供逻辑端口；`src/app/runtime.ts` 在本机 `stateDir` 上加锁并打开 SQLite；Session 日志仍在 DSH home 下；[006 部署](../006-deployment.md) |
| 5.2 | 计算与执行环境分离 | 未实现 | `src/executor/dsh.ts` 创建本机 DSH Session；`src/app/execution-environment.ts` 只描述本机环境变量与工作目录根；没有端侧 daemon 或设备注册 |
| 6 | Watchdog | 部分实现 | `src/app/api.ts` 的 `GET watchdog` 与 `POST watchdog/tickets/:id/:action`；`src/app/watchdog.ts`；`src/app/store.ts` 的 `watchdog_audit` 表；`src/policy.ts` 的 `WatchdogConfigSchema`；`scripts/dsh-superagent`；`tests/watchdog*.spec.ts` |
| 7 | 架构实验 | 未实现 | `tests/` 有功能与并发测试，但没有批处理、直通或双层架构对比的负载脚本与指标 |
| 8.1–8.4 | 长程记忆、Session 之外的协作、A2A、安全与隐私 | 未解决 | 设计标为开放问题；当前实现没有完整方案：8.2 已有执行中追加消息、停止与重试，8.4 见下文的权限限制；`src/core/memory.ts` 只是测试用的内存仓储，不是长程记忆 |

**核查方式。** 上表的“已实现”以当前 `main` 的源码入口和测试为准，“未实现”以源码中没有对应入口、且 `tests/` 没有相应覆盖为准。合并请求可按编号在 GitLab 上查到，测试文件可在 `tests/` 直接检索。

## 已实现的部分

下面的部分容易被误判为缺失，先说明现状与证据。

**双层架构。** `cordis.patch.yml` 定义了两个 DSH 预设：`dsh-superagent-router`（主 Session，只含路由所需工具）和 `dsh-superagent-worker`（执行器，含完整执行工具）。`src/executor/dsh.ts` 为每个工单创建一个 worker Session 和一个工作目录；worker 的推理和工具调用不直接输出到外部信道，结论通过报告和受规则约束的 `reply` 交付，渠道写入统一经过 `Outbox`。

**两级过滤。** `src/policy.ts` 的 `gate` 做确定性准入（来源、群组、允许名单、准入表），准入后的事件进入评估；`src/app/assessment.ts` 的 `MasterAssessor` 把候选交给主 Session 研判。程序层先滤掉大部分噪音，语义层再判断是否需要行动。

**订阅与直通。** `src/core/intake.ts` 把每个触发存储一次并扇出给订阅了该线程的工单；`src/core/tickets.ts` 维护订阅。同一线程的后续事件直接到达已订阅的 worker，不需要主 Session 转发；worker 可以交回触发或取消无关线程的订阅。

**上下文组织。** `src/app/resources.ts` 为 `orchestrator_read` 提供分页资源：列表项带 id 和摘要，资源读取用 `textPage`（`src/app/cards.ts`）截断长文本并保留续读入口，对象之间通过 id 形成可逐跳展开的引用图。GitHub 与 GitLab 来源提供 `threadContext` 读取线程上下文；飞书来源按设计只消费实时消息，不读取历史（见下文）。

**异步交互。** worker 预设把前台命令在 5 秒后转入后台作业，`src/executor/background.ts` 负责等待、收集和终止后台作业与子智能体；`prompts/work.md` 要求长命令以后台作业运行，后台结果作为新消息回到 worker。主 Session 的等待也被限制在 5 秒，不会因为一条命令阻塞候选处理。

**多信道。** 飞书、GitHub 和 GitLab 各有渠道实现（`src/sources/*-channel.ts`），确认、答复、结果和待人工决定都经 `Outbox` 按渠道发送；`src/app/outbox.ts` 对飞书应用单条消息的字数限制，GitHub/GitLab 按仓库规范交付完整说明。飞书来源在 Windows 上也可用（MR !19），但下文所述的只读历史权限限制不变。

**设计之外的能力。** 项目还实现了 Git 宿主切换（[011 多 Git 来源](../011-multi-git-sources.md) 的方案 A，MR !34）和按来源设置的谷价调度（MR !8、!25）。它们不在 [super-agent-design.md](super-agent-design.md) 的章节内，因此不列入上表的差距，但会影响部署形态与“高效/持久”的现状描述。

## 未实现的重要能力

### 1. Watchdog（第 6 节）

**设计要什么。** 在主系统之外运行一个独立的 Watchdog Session，用定时消息驱动，构成外部 Control Loop。它既处理接口报错、状态恢复失败等基础设施故障，也由模型判断各个 worker 是否有实质进展、方向是否偏离目标；发现异常时介入修复，遇到外部偶发故障则持续复查。它本身也是一个具备完整工具能力的 Agent Session，可以用自然语言询问故障原因，也可以在线修正主系统行为，例如增删提示词、调整触发规则。

**现状。** 已有的组件级、进程级能力，以及已经落地的只读任务级巡检：

- `src/infra/health.ts` 的 `HealthBoard` 汇总每个部件的健康条目，面板和 `GET state` 可以读到；它只报告状态，不做判断。
- `src/app/effects.ts` 对失败的副作用做指数退避重试；`src/executor/dsh.ts` 的 `resume` 在进程重启后恢复被中断的派工；来源轮询有失败计数。这些覆盖了“外部偶发故障持续复查”的一部分。
- `orchestrator_ticket_request_status` 允许主 Session 向等待中的 worker 询问状态，但它是被动触发的，不是周期巡检。
- [006 部署](../006-deployment.md) 的“每小时检查”是文档化的外部巡检提示词：在另一个 DSH profile 中定时运行 `status`，进程退出码为 1 时执行 `restart`。它是进程级的，需要人工按文档配置，不判断 worker 是否在无效循环或偏离目标。
- **已落地的只读任务级巡检（MR !28）**：`GET /orchestrator/api/watchdog` 返回每个进行中工单的阶段、最近派工与报告、静默时长、机械信号（投递失败、未送达输入、排队过久、无进展、等待人工过久）和线程信息；`scripts/dsh-superagent watchdog` 输出 JSON 快照；部署文档给出独立 profile 的定时任务提示词。
- **已落地的介入（阶段 2，MR !30、!32）**：`watchdog` 设置块（默认 `observe`，只有 `enforce` 执行动作）、专用 `POST /orchestrator/api/watchdog/tickets/<id>/retry|stop`、SQLite 持久化审计、按工单冷却与每小时限流，以及等待人工、人类跟进、未送达输入、谷价等待、暂停或未配置时的拒绝规则；面板提供同样的设置项，快照由该 API 与 CLI 读取。`scripts/dsh-superagent watchdog retry|stop` 只向该 API 请求决定；重试与停止都由服务端重新读取工单后执行，失败不回滚、只记录并报告。实现入口见上表的核查列，行为由 `tests/watchdog.spec.ts` 与 `tests/watchdog-action.spec.ts` 覆盖。

**影响。** 巡检能在设置的边界内发现并重试或停止卡住的工单，每一次决定都有审计和限流；但修改提示词、策略或其他设置仍需人来完成，服务进程存活和重启恢复也仍依赖外部每小时检查。当前单机部署一旦主机休眠或离线，整个系统停止，这正是第 5 节要解决的问题。

**下一步。** 阶段 2 的 retry/stop 介入已经落地；阶段 3 才允许从 Watchdog 修改设置或提示词，并且需要 diff、人工确认和回滚。具体任务、验收与并行边界见 [落地计划](super-agent-design-roadmap.md) 的工作流 B。

### 2. 计算与状态分离（5.1）

**设计要什么。** 把推进 Agent Loop 的计算做成无状态的弹性容器，把 Session 等持久化状态存入数据库。计算容器可以水平扩展、重启或替换，会话与任务的连续性由持久化存储保障，从而摆脱单台设备的生命周期限制。

**现状。** 代码在逻辑上已经有分离的缝隙：`Repositories`、`Policy`、`SourceScope`、`Executor` 等端口在 `src/core/ports.ts`，`Store` 是 SQLite 适配器，`Runtime` 在启动时锁定状态目录（`src/app/runtime.ts`）。但部署上没有分离：插件运行在本机 DSH 进程里，SQLite 文件在 `stateDir`，DSH Session 日志在 DSH home 下，工单工作目录默认在 `stateDir/work`；POSIX 上服务跑在 tmux 里，Windows 上是本机后台进程（[006 部署](../006-deployment.md)）。没有远程数据库、无状态计算容器或跨主机的会话续接。

**影响。** 主机休眠、离线或磁盘故障时整个系统停止；不能通过增加实例扩展吞吐；重启会中断正在运行的派工（`resume` 只是恢复，不是无损续接）。这是“持久在线”和“跨设备”最根本的障碍。

**落地路径。** 把 Store 换成共享数据库（例如 PostgreSQL），把 DSH Session 持久化移到服务端，把插件放进无状态容器，并引入租约/锁来避免同一工单被多个实例同时推进；需要迁移路径和离线兼容。这是一次架构级改造，应该先做边界与成本评估，再决定是否推进。

### 3. 计算与执行环境分离（5.2）

**设计要什么。** Agent Loop 留在云端，重状态的执行环境留在原地；端侧只部署一个不保存会话状态的轻量 daemon，负责执行命令与返回结果。这样既支持 BYOM（把用户日常开发机接入云端 Agent），也支持云端托管机器，并能在不同执行设备之间切换。

**现状。** 执行器与主 Session 在同一进程、同一主机：`src/executor/dsh.ts` 创建本机 DSH Session，`prepare` 命令和工具调用都在本机执行；`src/app/execution-environment.ts` 描述的是本机环境变量和工单目录根，不是远程环境。worker 以运营者操作系统用户、`danger-full-access` 运行，可以读取主目录和本地凭据（[006 部署](../006-deployment.md) 的“权限与隔离”）；Windows 上没有 OS 沙箱，同一限制同样存在。没有端侧 daemon、设备注册、跨设备路由或离线设备重连。

**影响。** 无法使用用户自己机器上的未提交修改、私有依赖和本地工具链；无法在不同设备之间切换；执行环境的安全边界完全依赖操作系统账号。

**落地路径。** 依赖 5.1：先让 Agent Loop 无状态，再定义“执行环境”协议（命令执行、文件读写、长任务、取消）和端侧 daemon 的认证与授权；把执行器对 Session 和目录的假设收敛到一个可替换的传输层；最后支持设备选择与离线任务排队。这是设计中成本最高的部分，应作为独立项目评估。

### 4. 投机执行（3.4）

**设计要什么。** 在还不确定结果是否会被采用时，根据环境信号在后台提前尝试，用额外算力换更短的人类等待；结果有价值就交付，没有价值就丢弃。

**现状。** 主动规则（准入表与 `admitsInferred`）允许推断出的工作在没有人类明确请求时被接单，worker 随后静默执行，只在就绪时交付；如果找不到有价值的结论，可以报告 `dropped` 并保持安静。因此“先做后报、无用则静默”的最终体验已经可以近似达到。缺的是设计中的时间顺序与并行度：工作要等评估决定之后才开始，没有在决定前就启动、之后按决定丢弃的预执行路径，也没有为“可能被采用”的结果预留资源或取消语义。

**影响。** 评估本身很快时，近似方案已经够用；当研判需要读取较多上下文、或希望在讨论结束前就准备好修复时，人类仍要等待。另一方面，真正的投机执行与项目“只在被请求时、或书面规则允许时行动”的理念（[000 理念](../000-philosophy.md)）以及授权模型存在张力，需要先明确“谁为可能被丢弃的工作付费、结果如何丢弃、失败是否可见”。

**落地路径。** 两个方向：给主动规则增加“预执行”标记，让匹配的触发在评估决定前启动一个可取消的轻量 worker，决定 `ignore` 时丢弃、`accept` 时转正；或者把评估中的上下文读取做成后台预取/预分析，减少决定延迟。前者需要新的授权与生命周期规则，建议先写一份设计决策再实现。

### 5. 飞书线程的上下文召回（3.3 的局部）

**设计要什么。** Inline & Spill 与链式召回要覆盖系统中的各类对象，包括 IM 消息前后文与所回复的消息。

**现状。** GitHub 与 GitLab 来源提供 `threadContext`，评估可以读取线程的头几页和触发周围的消息；飞书来源明确不提供上下文读取：`src/sources/feishu.ts` 的注释说明机器人只接收实时消息事件并回复，没有按 ID 读取消息、群历史或群成员的权限，因此不暴露历史恢复、线程轮询、上下文读取或成员同步。飞书来源在 Windows 上已可用（MR !19），但该权限限制不变。README 也把“更严格的飞书权限”列为 fork 的特别注意项。

**影响。** 飞书线程上的评估只能看到触发本身和批次，无法像设计描述的那样内联前后消息；跨信道的链式召回在飞书一侧断开。这是权限约束，不是代码遗漏。

**落地路径。** 要么申请并配置只读消息/历史权限（会扩大机器人权限面，需要运营者权衡），要么在提示词里明确“飞书触发缺少线程上下文”，让评估更保守地接单。短期不建议为此扩大权限。

### 6. 其他差距

- **邮件与文档信道（4.2）。** 设计把 GitHub、邮件、文档并列为异步信道；当前 `src/sources/` 只有飞书、GitHub、GitLab 三种来源。项目定位是代码协作，邮件/文档属于场景扩展，不是当前部署的缺口。
- **架构级评测（第 7 节）。** 仓库有较完整的功能测试（`tests/`，包括 `tests/runtime-concurrency.spec.ts`），但没有双层架构、直通机制、Router 批处理的负载实验，也没有 token 或完成时间的对比数据。设计的定量结论无法在本仓库复现。
- **安全与隐私（8.4）。** 设计把凭据隔离、云端与端侧互信列为开放问题；当前部署的实际状况是 worker 以运营者用户、`danger-full-access` 运行，凭据通过 CLI 配置和 git 凭据助手可用，没有“Agent 完全不接触凭据”的机制。专用操作系统账号只能缩小暴露面，不是设计要求的隔离；Windows 上还没有 OS 沙箱可用。

## 设计的开放问题

以下问题在设计第 8 节中明确标为未解决，不能算作本项目的实现缺失：

- **长程记忆与 Router 水平切分（8.1）。** 当前 Router 是单个常驻 Session；历史任务靠存储和引用图召回，没有跨月的摘要或分层记忆，也没有分片机制。
- **Session 之外的协作（8.2）。** 工单已经支持人在执行中追加消息、停止和重试，但设计提出的“用户在后台执行过程中随时介入、接管或实时协同”的产品形态仍未定义。
- **A2A（8.3）。** 没有多实例之间的通信与协作；当前一个部署只服务一个 Git 仓库和一个团队。
- **安全与隐私（8.4）。** 见上一节。

## 建议顺序

| 顺序 | 能力 | 规模 | 理由 |
| --- | --- | --- | --- |
| 1 | 5.1 的决策与 spike | 中 | 决定 5.2 的形态；先评估 DSH Session 持久化、迁移与锁定方案，再决定是否投入 |
| 2 | 5.1 实现（远程数据库、无状态运行时、租约） | 大 | 持久在线与多实例的基础；与多 Git B 都要改存储与设置，先约定迁移顺序 |
| 3 | 5.2 计算与执行环境分离 | 大 | 依赖 5.1；是跨设备与 BYOM 的前提 |
| 4 | 3.4 投机执行 | 中 | 效果已可由主动规则近似；先明确授权、成本与丢弃语义，再在一个低风险来源试点 |
| 5 | 飞书上下文 / G 评测 / H 安全 / 邮件文档 / Watchdog 阶段 3 | 小到大 | 按权限、验证需求与场景优先级分别推进；Watchdog 阶段 3 可选 |

Watchdog 阶段 2 已经落地；若目标只是让当前单机部署更稳，先把 [006 部署](../006-deployment.md) 的外部巡检按文档运行起来并积累观察数据，再考虑阶段 3。若目标是让 Super-agent 脱离单台设备，5.1 和 5.2 是绕不开的架构工作。各工作流的依赖、可并行边界和验收标准见 [落地计划](super-agent-design-roadmap.md)。