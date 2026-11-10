# Watchdog 与 Superagent 的互辅助设计

> 基线：`main` @ `7ff7178`（2026-11-09）。本文基于 2026-11-08/09 的两起生产事故、当前本机的独立 Watchdog 与部署任务、以及 [006 部署](../006-deployment.md) 的现有流程，给出两者“互相开发、升级、部署和看护”的目标关系、边界与分阶段落地方案。状态标记沿用仓库惯例：**已实现**、**部分实现**、**方案**、**待决策**。

## 1. 目标与不变量

期望的关系不是“两个都能重启对方”，而是**两个独立生命周期、彼此可维护、可观察、可回滚的监督关系**：

1. Superagent 可以开发、构建、升级 Watchdog；Watchdog 可以更新和部署 Superagent。
2. 任意一方的部署或退出，不能连带杀死另一方；任何长期运行进程都不应位于 DSH 工具调用创建的 Windows Job 中。
3. Watchdog 除工单与服务健康外，还能识别 Superagent 中“死掉的 Session”，并在明确授权下做有界恢复。
4. 两个方向的动作都有授权、幂等键、部署锁、版本/制品校验、持久化审计和回滚路径；生产发布的最终批准仍由操作员给出。
5. 双方都能看到对方的版本、心跳和最近动作；一方失联不能被当成“安静正常”。

不变量：Superagent 永不重启或替换自身；Watchdog 不在 Superagent 的进程树内运行；任何一方都不接受来自工单、面板消息或聊天内容的任意命令、路径或脚本。

## 2. 当前状态与两起事故

### 2.1 现有组件

| 组件 | 位置 | 当前职责 |
| --- | --- | --- |
| 服务控制脚本 | `scripts/dsh-superagent` | `start`/`stop`/`restart`/`status`，profile 级锁、健康检查、`watchdog` 只读快照与动作请求 |
| 独立 Watchdog 进程 | `scripts/watchdog` | 常驻 observer：自有配置/状态/日志/pid，用版本化长等待跟随变化（`GET /orchestrator/api/watchdog/wait`），记录运行、飞书日报与独立告警；配置 `agentConfig` 时新风险交给同版本完整 agent，observer 不再重复发机械报告 |
| Watchdog observer 与风险 agent（本机） | `C:\Users\dd\.dsh\watchdog-independent` 的 `current.txt` 指向的版本化制品（`watchdog`、`agent\run.ps1`、`gate.mjs`、`prompt.md`） | 计划任务 `dsh-superagent-watchdog-observer` 在登录时经 `launch-observer.vbs`/`launch-observer.ps1` 常驻运行 observer；observer 在长连接发现新风险时调用同版本 `agent\run.ps1`，由完整 DSH agent 判定和报告；每 30 分钟的 `dsh-superagent-watchdog-agent` 定时 gate 已删除。2026-11-10 安装 `obs-525e65f`（提交 `525e65f`），常驻 observer 已运行并记录带版本的心跳 |
| Superagent 侧部署入口 | `src/app/deployment.ts`、`orchestrator_deploy` | 主 Session 把操作者的部署原话写入请求文件，并执行 `DSH_SUPERAGENT_DEPLOY_COMMAND`；请求文件路径必须与部署任务的 `requestPath` 一致 |
| 独立部署任务（本机） | 仓库 `scripts/deploy.ps1` → `scripts/deploy.mjs` + `C:\Users\dd\.dsh\watchdog-deploy\deploy-config.json`，计划任务 `dsh-superagent-deploy` | 配置了 `mechanical` 时由 `deploy.mjs` 机械停服、备份停机状态、按清单切换、启动并做存活校验，不调用模型；否则回退 headless DSH agent 按 `local-superagent-release` 技能执行。两条路径都归档请求并写结果文件；生产配置尚未启用 `mechanical` |

### 2.2 事故一：Feishu watch 关闭竞态（已修复，本 MR）

2026-11-08 23:11:29 的一次部署重启中，旧进程以 `Error: database is not open` 退出。调用链是：`feishu-watch` 的 5 秒 `enabled` 轮询 → `ctx.config` → `SourceRegistry.settings` → `Store.get`，而关闭流程已经执行到 `store.close()`。

根因是两段生命周期的重叠：

- 关闭时先 `runtime.stopped.abort()`，但 Feishu 事件消费者由 Source 插件的独立 controller 管理；`feishu-loops.ts` 的 5 秒 interval 只在 `consume()` 结束后才 `clearInterval`，Windows 上停止消费者最多等 5 秒，期间 interval 仍可能读取已关闭的数据库。
- interval 回调没有捕获异常，而定时器回调里的未捕获异常会结束进程。

修复（`src/sources/feishu-loops.ts`）：读取设置统一经过 `sourceOn()`，数据库已关闭时返回 `undefined` 并停止循环；收到 abort 时立即清除 interval；未就绪/关闭期间收到的事件直接丢弃。回归测试 `tests/sources.spec.ts` 的 “stops quietly when the state database closes before the consumer stops” 在修复前复现了同一条 `database is not open` 栈。

### 2.3 事故二：部署 agent 退出杀死了服务（未修复，属于本设计范围）

2026-11-09 10:33–10:43 的部署中，`deploy.ps1` 启动 headless DSH agent；agent 在 10:41 用 `service.ps1 start` 拉起生产服务，10:42 健康检查和飞书报告成功，10:43 agent 正常 `exit=0`。agent 一退出，服务进程和同一 agent 在 10:42 拉起的独立 Watchdog 进程同时消失，服务在 10:43–11:00 不可用。

机制已经核实：DSH 的 Windows 子进程 provider 为每条工具命令创建 Windows Job，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；普通后代默认继承 Job，`detached: true` 不能 breakaway（Job 未设置 breakaway 许可）。因此从 DSH agent 的工具中启动的“detached”服务仍在该 agent 的 Job 里，agent 退出时被 Job 一并终止，没有 JS 异常日志。部署的“成功”验证发生在 agent 退出前几秒，形成盲区。

此外，2026-11-09 11:27 现场检查显示当前服务仍在桌面 DSH 的 Job 中（`IsProcessInJob=true`），关闭或重启桌面 DSH 仍可能再次静默杀死服务。这属于当前运维风险，需要操作员在独立的计划任务/普通终端中重启一次生产实例；本文不执行该重启。

这两起事故说明：当前“互相部署”在**代码层**是连通的，但在**进程生命周期、制品版本和健康反馈**三方面没有解耦。

## 3. 设计原则

1. **同一源码，两个制品。** Superagent 与 Watchdog 从同一提交构建，但分别安装、分别版本化、分别回滚；Watchdog 不在运行时依赖稳定 checkout 的源码。
2. **职责分离。** Superagent 负责开发、评审、请求和展示；Watchdog 负责独立执行受控发布与恢复。任何一方都不执行“替换自己”的动作。
3. **OS 监督者拥有长期进程。** 服务、Watchdog observer、风险 agent、部署执行器都由计划任务/系统服务启动；它们彼此不是父子关系，也不在 DSH 工具 Job 内。
4. **控制面是文件/API，不是命令。** 请求携带目标、不可变版本、幂等键、操作者确认、维护窗口；执行器只接受预配置的目标和动作，审计每个阶段。
5. **失联可见。** 双方都有心跳与版本；一方心跳过期时另一方报告，而不是把没有消息当成正常。
6. **死 Session 不等于死服务，也不等于工单该停。** 区分进程死亡、Session 缺失/停摆、模型重试、谷价排队、等待人工/评审/投递；恢复动作按证据升级。

## 4. 目标拓扑

```
Windows Task Scheduler / systemd
├── dsh-superagent-service-start   ← 独立启动服务（不在任何 DSH Job 内）
├── dsh-superagent-watchdog-observer ← 常驻 observer（HTTP 长连接；新风险时运行完整 agent）
├── dsh-superagent-watchdog        ← 常驻 observer（scripts/watchdog 或安装后的制品）
├── dsh-superagent-deploy          ← 受控发布 Superagent
└── dsh-superagent-watchdog-update ← 独立更新/回滚 Watchdog
        │
        ├── Superagent 服务（管理 API、面板、Session、SQLite）
        └── Watchdog 状态（配置、state.json、pid、日志、部署审计）
```

两条数据流：

- **请求流**：Superagent 写请求文件 → 触发独立任务 → 任务校验操作者原话、目标、版本、锁 → 执行 → 写结果并在服务可用时经服务飞书机器人报告；服务不可用时走独立的本地告警通道。
- **观察流**：Watchdog 读 `GET /orchestrator/api/watchdog`、宿主进程/计划任务状态和（后续）Session 心跳 → 记录运行与审计 → 有变化时报告 → 在授权范围内调用受控 API 或独立任务。

关键不变量在启动时自检并记录：实际进程 PID、启动方式/父进程、是否位于 Job、监听地址、版本、启动时间。服务启动脚本应在发现自身位于 DSH Job 时明确告警，而不是静默继续。

## 5. 两个方向的流程

### 5.1 Superagent → Watchdog：开发、升级、部署 Watchdog

**开发与构建。** Watchdog 的代码（`scripts/watchdog`）和本机 agent 脚本（`run.ps1`、`gate.mjs`、`prompt.md`、模型 patch 模板）都应进入仓库、走 MR 和 CI；路径、账号、chat id 等环境配置留在仓库外的配置目录。`gate.mjs`、`run.ps1` 与 observer 已随版本化制品发布，不再从 checkout 导入；剩余的环境配置与计划任务安装仍是本机操作员步骤。

**制品。** 构建输出包含 `scripts/watchdog`、agent 模板、配置 schema 与 manifest：`{name, commit, sha256, builtAt, apiVersion, minServiceVersion}`。安装到版本目录（例如 `watchdog/versions/<commit>/`），用 `current` 指针切换，保留上一版用于回滚。Superagent 的源码检出不再作为 Watchdog 的运行时依赖。

**部署。** 主 Session 只写 `watchdog-update-request.json`（操作者确认、目标版本、幂等键）并触发 `dsh-superagent-watchdog-update` 任务；该任务独立于服务与 observer，执行：校验请求 → 校验制品 → 在隔离环境冒烟（不启用生产飞书/凭据）→ 停旧 observer → 切换 `current` → 启动新 observer → 等待新版本心跳和一次成功观测 → 失败则切回上一版并报告。服务面板展示当前/候选/上一版和最近一次更新时间。

**验收。** 更新 Watchdog 不重启 Superagent；observer 更新期间服务继续响应；新 observer 的版本和心跳可在面板/审计中看到；失败自动回滚；并发更新只有一个生效。

### 5.2 Watchdog → Superagent：更新、部署与有界恢复

**请求与授权。** 沿用现有 `orchestrator_deploy` 请求文件，但补充不可变目标（提交或制品摘要）、操作者原话、幂等键、维护窗口和期望停机上限；执行器独立验证授权，不接受任意命令/路径。

**发布。** 预构建并预验证候选 → 一致性备份 → 停流/静默工作 → 停服务 → 切换构建产物 → **通过独立启动任务启动服务**（不在执行器 Job 内）→ 校验进程身份、版本、管理 API、来源连接、安全端到端检查 → 执行器退出后再次健康检查，证明服务存活 → 报告。执行器自身的退出不得影响服务；这是对 2026-11-09 事故的直接修复。

**恢复与锁。** 部署状态机持久化：`requested → verified → prepared → stopped → switched → started → verified`，失败进入 `failed`/`rolled-back`；同一目标同一时间只允许一个部署（部署锁 + 过期检测）；执行器崩溃留下明确状态，不自动盲目重试。回滚前核对数据库兼容性和备份后的新数据。

**自动重启边界。** 服务进程缺失且没有 `manually-stopped` 标记、没有进行中的部署时，Watchdog 可在 enforce 模式下通过独立启动任务做有界恢复：有次数/冷却/限流，写审计并报告；连续失败则停止动作、保留现场并升级给人。等待人工、评审、投递中的工单和部署中的服务不在自动恢复范围内。

### 5.3 Watchdog 辅助监控“死掉的 Session”

当前快照只有工单阶段、最近报告和静默时长；它能发现“没有进展”，但不能区分“整个服务死了”“某个 Session 死了”“模型在重试/排队”或“合法地等待人工”。方案是在 `GET watchdog` 的工单条目中增加 Session 观测：

| 字段 | 含义 |
| --- | --- |
| `sessionId` / `ticketId` / `assignmentId` | 关联的 Session 与派工 |
| `sessionState` | `missing`、`alive`、`idle`、`stalled`、`ended`（由服务的 Session 注册表与最近活动推导） |
| `lastActivityAt` / `lastTurnAt` / `lastReportAt` | 最近一次持久化消息、回合和报告的时间 |
| `modelRetry` / `queued` / `waitingFor` | 已有的重试、谷价和等待原因，避免把合法等待当作死亡 |
| `processAlive` | 仅当 Session 有独立进程/窗格时；DSH 内 Session 为进程内 agent，此项可空 |

建议信号与恢复阶梯：

1. `session-missing`：工单仍在执行，但 Session 不在注册表或已结束。先报告；enforce 下可对同一工单在同一目录重试一次，保留原 Session 记录，超限后升级。
2. `session-stalled`：Session 存在但超过阈值没有回合/持久化活动，且不处于模型重试、谷价、暂停、满载或等待人工/评审/投递。报告；enforce 下允许 retry，不允许 stop。
3. `ticket-stalled`：现有 `no-progress`/`queued` 信号，保留现有安全前置条件与冷却。
4. 服务级进程缺失：交给进程/启动任务看护，不用 Session 动作处理。

数据来源优先放在服务内：Session 注册表、持久化层和 Executor 已有生命周期信息，服务把它们压缩进只读快照即可，不新增外部读取数据库的通道。若 DSH 不提供可靠的“最后一回合”指标，则先由服务持久化每个 Session 的回合心跳，再暴露给 Watchdog。

### 5.4 互相看护与心跳

- **Watchdog 心跳**：已有 `watchdog_run`（每次运行都记录）与 `lastRun`；增加版本字段后，服务面板可以显示“Watchdog 已安装/版本/最近运行”。超过两个周期没有运行记录时，服务经飞书提醒操作员。
- **服务心跳**：Watchdog 已有服务健康快照和版本可加；报告服务版本、PID、启动时间、是否在 Job 中、最近一次部署结果。
- **故障时的报告通道**：当前 `watchdog report` 依赖服务的管理 API；服务完全不可用时 Watchdog 发不出飞书。需要一条最小的独立告警通道（预配置 chat id 的 `lark-cli` 调用或本地告警文件 + 计划任务），并限制目标 chat 和内容，不能变成任意消息通道。
- **谁看护 Watchdog**：不要形成两个进程互相自动重启的环。Watchdog 由 OS 监督者重启（计划任务失败重启/独立看护任务），服务只报告其心跳过期；必要时由一个更简单的、只检查进程存在性的外部看护兜底。

## 6. 授权与安全边界

1. 发布/更新请求必须包含操作者的原始确认文本；执行器独立核验，面板请求或同账号可读令牌不构成批准。
2. 目标和版本来自白名单或不可变摘要；请求文件 ACL 限制为服务账号与执行器账号可写，其他账号只读。
3. Watchdog 与部署执行器使用独立 OS 身份（至少独立凭据目录与目录权限），不能由工单注入命令。
4. 所有动作写持久化审计：请求、快照、前后状态、结果、失败原因、回滚点；面板可查询。
5. 任何一方都不在运行中替换自己的二进制/源码；自更新必须由独立任务完成，并保留上一版。
6. 飞书内容只发摘要，不把生产数据库、令牌或私有消息复制到仓库或公开评论。

## 7. 分阶段落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0（本 MR） | 修复 Feishu watch 关闭竞态并加回归测试；记录当前进程归属风险；完成本设计 | 回归测试通过；文档说明两起事故与限制 |
| P1（立即） | 修复部署启动归属：服务由独立启动任务或部署脚本在 DSH agent 退出后启动；执行器退出后做存活检查；observer 不再由部署 agent 拉起；操作员在 DSH 之外重启一次当前生产实例 | 部署任务退出后服务仍 `ready`；`IsProcessInJob=false`；关闭桌面 DSH 不影响服务 |
| P2（短期） | Watchdog agent 脚本入仓；版本化 Watchdog 制品和 `watchdog/current`；独立 `watchdog-update` 任务；面板显示双方版本/心跳 | 更新 Watchdog 不重启服务；失败回滚；并发更新只生效一个 |
| P3（中期） | 快照增加 Session 观测与信号；enforce 下有界 retry/重启；服务/宿主机检查项（路线图 L）；服务不可用时的独立告警 | 杀死测试 Session 后 Watchdog 能识别并恢复/报告；服务停止期间 Watchdog 仍工作并留下记录 |
| P4（可选） | 面板部署/更新入口与状态查询；审批与维护窗口配置；自动化边界评估 | 断线可恢复查看；未授权/未配置时不可执行 |

**P1 状态（2026-11-09）。** `scripts/dsh-superagent start` 已改为在调用方位于 Windows Job 中时，通过 WMI 让 `scripts/service-start.ps1` 在 Job 之外启动服务，并由 `status` 报告实时归属与最近启动方式。生产实例已由独立部署任务切换到 `0cf6a69`，`DSH_SUPERAGENT_WATCHDOG_RECOVERY=enforce`，执行器退出后服务继续存活。验收时发现：Node v24（libuv 1.52）会在进程第一次 spawn 非 detached 子进程时，把进程自己加入一个由它创建并持有的 kill-on-close Job（服务的 Feishu 事件消费者即触发），因此 `IsProcessInJob=false` 对运行中的服务永远不成立；全量句柄枚举实测服务只在该自建 Job 内，不在任何外部/DSH Job 中。`status`/`verify` 因此区分 `inJob`（任意归属）与 `foreignJob`（是否位于非自身创建的 Job），验收以 `foreignJob=false` 且执行器退出后同一进程继续存活为准；`scripts/deploy.ps1` 在部署 agent 退出后运行该检查并记录结果。2026-11-10 00:39 的生产 `verify --survival-seconds 3` 已以 `foreignJob=false` 通过，修正后的控制脚本已在生产生效。2026-11-10 新增 `scripts/deploy.mjs`：配置 `mechanical` 时例行部署只做机械预检、停服、停机状态备份、清单切换、启动和存活校验，不调用模型，失败时恢复运行文件并重启上一版；没有 `mechanical` 时保留 headless agent 回退。生产配置尚未启用 `mechanical`，启用步骤见 `docs/zh/006-deployment.md`。

**P2 状态（2026-11-09）。** Watchdog agent 脚本已入仓并模板化；`scripts/watchdog-artifact.mjs` 构建带 manifest/摘要的不可变制品，`watchdog-smoke.mjs` 用本地 mock 验证自包含性；`watchdog-launch.ps1` 作为稳定启动器读取 `current.txt`；`watchdog-update.mjs` 实现请求校验、staging 根校验、smoke、安装、指针切换、锁、幂等、心跳和回滚，更新运行记录携带 `version`/`commit`。agent 包装支持独立 `workspace`，默认按 service profile 生成 `workspaces\watchdog_<profile>`（如 `watchdog_superagent`、`watchdog_sheepdoku`），启动 gate 与完整 agent 前切换进去，并拒绝等于 checkout 或位于其内的路径；提示词改用 checkout 绝对路径，因此 Watchdog 的 Session 不再进入 Desktop 的 checkout 工作区。面板已在执行页显示双方版本、最近心跳，以及 current/候选/上一版与最近更新（缺失/过期/失败显示警告）；更新任务支持持久 observer 的停止、切换、启动与失败回滚。2026-11-10 01:31 生产安装 `obs-525e65f`（提交 `525e65f`），常驻 observer 由登录任务启动、`lastRun` 携带新版本；agent 包装运行于独立 workspace（`watchdog-independent\workspace`）。每 30 分钟的定时 gate 任务已删除。P4 保持方案状态，其待决策项见下一节。

**P3 状态（2026-11-09）。** 快照新增 `session-missing`；Watchdog 配置 `alertFile`/`alertAfterFailures` 写独立不可达/恢复记录；服务在 `DSH_SUPERAGENT_WATCHDOG_RECOVERY=enforce` 下支持有界恢复（只处理 session-missing、每 Session 最多一次 retry、失败只报告、审计行、不重启服务）。生产已启用 enforce；常驻 observer 取代了每 30 分钟的门控 agent，并由长连接在出现新风险时触发完整 agent。尚未实现：服务/宿主机检查项、独立告警的飞书投递与操作员确认。

## 8. 待决策与风险

**待决策。**

1. 一个独立监督器承担部署、Watchdog 更新和主机看护，还是拆成多个最小权限任务。
2. Watchdog 制品与 Superagent 制品分开发布，还是同仓同提交、分目录安装；版本兼容策略与最低服务 API 版本。
3. Session 生命周期的权威数据源（DSH 注册表、持久化心跳还是进程/窗格），以及“停摆”阈值。
4. 自动重启服务的授权范围和上限；是否需要操作员在每次生产发布前确认维护窗口。
5. 服务不可用时独立告警通道的实现（`lark-cli` 直发、系统事件日志还是外部监控）。
6. Windows 计划任务依赖用户登录的问题；是否迁移到专用账号/服务。

**风险。**

- 两个监督器同时重启同一目标会造成竞态；必须用部署锁、目标身份核对和单一职责表去重。
- 从 DSH 内启动的“独立”进程仍可能继承 Job；必须用外部计划任务/WMI 启动并在启动报告中验证。
- Watchdog 从稳定 checkout 导入源码会让“更新 Watchdog”等同于“更新 Superagent”；必须使用安装后的版本化制品。
- 版本偏斜（新 Watchdog 对旧服务 API）会让观测静默失败；manifest 与 API 版本必须在启动时校验。
- 服务不可用时的飞书报告依赖服务本身；没有独立通道时，最需要告警的时刻恰好发不出去。
- 自动恢复可能掩盖根因；连续失败必须停止动作、保留现场并升级给人。

## 9. 验收标准（整体）

1. 在隔离的非生产实例上：部署 Watchdog 不重启服务；部署 Superagent 时执行器退出后服务仍存活；失败可回滚；并发请求只生效一个。
2. 停止/杀死测试 Session、暂停服务、关闭来源等场景下，Watchdog 能区分并报告正确信号，enforce 只执行允许的动作。
3. 服务完全停止时，Watchdog 仍能记录、报告（通过独立通道）并在恢复后补齐状态。
4. 面板/审计能回答：当前双方版本、最近一次部署/更新、最近心跳、谁在何时执行了什么、回滚点在哪里。
5. 真实生产发布仍由操作员在维护窗口批准；默认 observe/report，enforce 需要显式开启。

## 10. 相关入口

- 服务控制与 Watchdog 快照/动作：`scripts/dsh-superagent`
- 独立 Watchdog 进程：`scripts/watchdog`
- 部署请求：`src/app/deployment.ts`、`orchestrator_deploy`
- Watchdog 介入与观测：`src/app/watchdog.ts`、`src/app/views/watchdog.ts`
- 现有部署流程：[006 部署](../006-deployment.md#升级)
- 路线图与差距：[路线图](super-agent-design-roadmap.md) 的 K、L；[差距分析](super-agent-design-gap-analysis.md)
