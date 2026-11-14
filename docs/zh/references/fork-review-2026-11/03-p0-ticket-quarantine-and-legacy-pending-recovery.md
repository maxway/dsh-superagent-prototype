# 03 [P0] Fail-closed 隔离栅栏与升级前排队工单缺乏受控运维恢复工具

* **优先级**：P0（高优 — 升级 `0.2.2-rc.3` 及新工作区生命周期后，运维排障闭环必需）
* **涉及文件**：
  * `src/executor/dsh.ts`（`stopIntent` / `recordStopFailure` / `checkStopFailure` / `checkHandoffStops` L534-593、`launch` L696-719）
  * `src/executor/background.ts`（`stopSubagents` L206-238）
  * `src/executor/provenance.ts`（`newProvenance`、`preflightCreation`、`verifyCreation`）
  * `src/app/runtime.ts`（`stateDir` 排他锁 `proper-lockfile` L91-95）
  * `src/kv.ts`（`KV.executor.stopPending`、`KV.executor.stopFailure`、`KV.workspace.claim`、`KV.workspace.provenance`、`KV.sessions.workerCreation`、`KV.sessions.workerHeader`）
  * `scripts/`（新增离线受控运维脚本如 `scripts/superagent-fence-admin.mjs` 或集成至 `scripts/dsh-superagent`）
  * `docs/006-deployment.md`、`docs/014-dsh-rc3-compatibility.md`、`docs/015-workspace-lifecycle.md`（及对应 `docs/zh/*`）

---

## 一、 问题描述与触发场景

当前候选版本为防止残留子代理并发踩踏工作区、以及防止缺失历史目录被误执行 `prepare` 覆盖，引入了两道严格的持久化 Fail-closed 栅栏，但**均未实现人工核实后的受控解锁或迁移出口**：

### 场景 A：后台停止未确认栅栏（`stopFailure` / `stopPending`）一旦触发即永久死锁

1. 在 `src/executor/background.ts:236` 中（`rc.2 / rc.3` 路径）：
   ```ts
   if (catalog.length > 0 || observedTreeWork)
     failures.push(new SubagentCleanupUnconfirmed(`Subagent cleanup for ${agent.id} is unconfirmed; operator investigation is required`))
   ```
   注意 `listDescendants` 返回的是**持久化历史子代理目录**，而非仅运行中子代理。这意味着：**哪怕一个工单在升级前的 `rc.1` 时期曾合法创建并早已正常结束过子代理，升级到 `rc.3` 后只要该工单发生一次交接、停止或重启恢复，`catalog.length > 0` 就会必现触发 `SubagentCleanupUnconfirmed`！**
2. `DshExecutor.recordStopFailure` 将记录写入 `KV.executor.stopFailure(ticketId)`（若进程在停止途中崩溃则遗留 `KV.executor.stopPending(ticketId, token)`）。
3. 此后：
   * 该工单及所有 `handoffFrom` 后继工单每次启动或投递都会在 `checkStopFailure` 抛出 `Later` 永久挂起。
   * 服务重启后 `DshExecutor` 构造函数检测到任何 `stopFailure` / `stopPending` 键（`src/executor/dsh.ts:263`），立即将全局 `worker` 健康项置为 `'error'`（即使引起该记录的旧工单后来已被人工关闭，全局 `worker` 报错也永远不会自动消除！）。
   * 没有任何 CLI 或 API 可在运维确认无残留进程后清除该栅栏，唯一办法是停服手写 SQL 删 `kv` 表。

### 场景 B：升级前已入队但尚未首次启动的工单（如 `offPeak` 谷价等待或满槽排队）升级后必败

1. 在 `src/executor/dsh.ts:696-700` 中：
   ```ts
   const state = this.host.store.get(KV.sessions.workerCreation(ticket.id))
   const claim = this.host.store.get(KV.workspace.claim(ticket.id))
   const initial = state === 'new' && (claim?.state === 'new' || claim?.state === 'ready')
     && ticket.assignments.every(item => !item.startedAt)
   ```
2. 在升级前已被接受（`accept`）但因 `offPeak` 时间窗未开或 Worker 槽位已满而尚未执行过 `launch()` 的工单：
   * 数据库中没有 `KV.sessions.workerCreation(ticket.id)` 和 `KV.workspace.claim(ticket.id)`（二者均为 `undefined`）。
   * 升级后当谷价窗口打开轮到它启动时，`initial` 计算为 `false` → 调用 `checkWorkspace(ticket, false)` → 因目录尚不存在直接抛出 `PrepareFailed('The historical workspace ... is missing')`，工单直接变 `failed`！
   * 即便手工建好空目录，`requireWorker`（L372）也会因为 Session 尚未创建而再次抛 `PrepareFailed`。

---

## 二、 安全约束（设计红线）

根据 `AGENTS.md`、`docs/014` 与 `docs/015` 的安全原则，本项目**支持经运维核验后的受控人工解锁与迁移出口**，但必须补齐完整安全前提，严禁以简化流程为由削弱防线：

1. **未知状态严格拒绝（Fail-closed on unknown）**：任何依赖状态（进程是否存活、Session 是否存在、目录是否存在、Git 引用/worktree 是否存在、`-wal` 是否静默、`handoffFrom` 链路是否干净）只要**不可读、格式不兼容、损坏、发生锁冲突或证据不足**，均归类为 `unknown` 并立即拒绝放行或采纳；不得提供 `--force` / `--skip-checks` 等旁路参数。
2. **人工确认不等于技术隔离**：运维人员输入的 `--operator`、`--reason` 或核验确认参数仅构成**人类授权与审计责任门禁**，不能替代 OS 级进程隔离、文件锁或运行期检查；工具不得因“人工已确认”而跳过技术校验，也不得顺带执行宽泛的进程强杀（`pkill`/`killall`）或目录删除。
3. **绝不能改成自动静默放行**：不能在服务启动时自动清空 `stopPending`/`stopFailure`，也不能对所有缺目录或缺标记的旧工单自动补写 `claim` 或重跑 `prepare`。
4. **必须离线、在明确边界与审计保护下执行**：所有解锁与采纳操作仅限本机运维通过离线 CLI 执行，**切勿暴露为模型可调用的 Orchestrator 工具或自动策略**；任何状态变更前都必须先落盘或同事务原子绑定不可变审计记录。

---

## 三、 具体修复方案

### 1. 提供离线受控运维 CLI 工具（推荐新建 `scripts/superagent-fence-admin.mjs` 或集成至 `scripts/dsh-superagent`）

工具面向已停服的 `stateDir/orchestrator.sqlite`，强制在 `proper-lockfile`（与 `src/app/runtime.ts:94` 同一 `stateDir` 锁契约）保护下运行，且写操作前**拒绝存在未收敛的 `-wal` 文件**（防止指向仍在运行或异常中断的数据库快照）。CLI 提供三个子命令，且**只读诊断、人工核验、审计留痕与状态更新**四层边界严格分离：

#### 1.1 `inspect`（只读诊断，零副作用）

* **隔离栅栏清点**：列出所有 `KV.executor.stopFailure` 与 `KV.executor.stopPending` 记录的工单 ID、写入时间、错误详情（含是否带 `reason=subagent_cleanup_unconfirmed`）、工单当前状态（open/ended）、`handoffFrom` 前驱/后继关联链、`workerSessionId(ticket.id)` 以及 `ticket.execution?.directory`。
* **升级前排队工单分类清点**（必须显式传入 `--dsh-home <path>` 才能做完整可迁移性评估；未提供或不可读时仅标记 `unknown`）：将缺失 `workspace.claim` / `workerCreation` 且 `assignments.every(a => !a.startedAt)` 的未结束工单严格区分为三类，**绝不把“缺记录 + 缺目录”直接等同于可安全采纳**：
  1. `ready-for-operator-review`：全部外部检查可读，且工作区目录 `ENOENT`、目标 `workerSessionId(ticket.id)` 明确为 `not-found`、相关历史 KV（`workerHeader` / `provenance`）均不存在、且（如可定位仓库）Git 分支/引用与 worktree 注册均明确不存在，待人工确认后方可进一步执行 `adopt-never-started`；
  2. `conflict-or-partial`：目录、Session、Git 引用/worktree 或 `workerHeader`/`provenance` 任一项已存在，禁止采纳，须按历史部分执行/异常中断恢复处理；
  3. `unknown`：缺少 `--dsh-home`、DSH Session 存储不可读/损坏/格式不兼容、目录 `lstat` 非 `ENOENT` 错误、Git 仓库不可达或检查失败——**未知状态严格拒绝**。

#### 1.2 `release-stop-fence`（受控解除停止栅栏）

命令签名示例：`release-stop-fence --ticket <id> --operator <name> --reason <text> --verify-process-stopped <evidence> [--dsh-home <path>]`

* **明确 `stateDir` 锁的边界**：
  * 获取 `proper-lockfile` 的 `stateDir` 排他锁（及无未清理 `-wal` 校验）**只能防止另一个使用同一 `stateDir` 锁的 `dsh-superagent` 进程或并发运维脚本同时写入 SQLite**。
  * **它不能证明旧服务进程、旧 Worker Session、残留子代理或外部进程已经停止**：一方面 `Runtime` 使用 `stale: 30_000` 租约，卡死但尚未退出的旧进程可能让出过期锁；另一方面，在 `rc.2/rc.3` 下，脱离的 local child、unclaimed inbox、外部交付执行、后台 shell 作业以及直接打开同目录的外部工具均不受 `stateDir` 锁约束（见 `docs/014`）。
* **人工核验标准（操作人核验后必须以结构化证据参数显式声明，证据不足严格拒绝解除）**：
  1. **原服务进程退出核验**：核实此前持有该 `stateDir` 的 `dsh-superagent` 服务进程已真正终止（基于 PID + 进程创建时间或进程句柄一致性核验，不可仅凭拿到 `stateDir` 锁或单一 PID 数字推断）。
  2. **残留 Worker / 子代理 / 外部进程核验**：结合 `stopFailure` / `stopPending` 记录的错误原因与时间戳、`workerSessionId(ticket.id)` 对应的 DSH Session / 子代理目录与日志、操作系统进程树、`tmux` 会话及 `ticket.execution?.directory` 目录句柄占用情况，确认无残留子代理、脱离的 shell 进程或外部工具仍在运行或写入工作区。
  3. **交接链独立核验**：若工单存在 `handoffFrom` 前驱链（`src/executor/dsh.ts:581-593`），每张被阻断的前驱工单都必须单独核验与解除，严禁解除单个工单时顺带放行未核验的前驱或后继。
  4. **证据不足或未知状态一律拒绝**：若原进程退出状态不明、无法排查工作区占用或子代理活动、目标键内容与预期快照不一致、或未提供具体核验依据（仅填泛泛理由视为不合格），**工具拒绝解除并保留原 `stopFailure` / `stopPending` 栅栏**。
* **状态更新**：在 `stateDir` 排他锁与单 SQLite 写事务内，先复核当前 `stopFailure(id)` 与 `stopPending(id, *)` 存在且与前置检查快照一致，再将**操作人、时间、核验依据、原因以及完整的原 `stopFailure`/`stopPending` 原始快照**写入追加式不可变审计键（如 `KV.executor.stopReleaseAudit(id, timestamp)`），然后删除该 `ticketId` 下的 `stopFailure` 与 `stopPending` 键。不修改工作区文件、不删除 DSH Session。

#### 1.3 `adopt-never-started`（受控补齐升级前未启动工单的初始标记）

命令签名示例：`adopt-never-started --ticket <id> --dsh-home <path> --operator <name> --reason <text>`

* **核心前提：缺记录、缺目录、缺 Git 引用都不等于目标 Session 不存在**：
  * 历史工单可能已在 DSH 持久化中创建了 `workerSessionId(ticket.id)`（例如创建 Session 后尚未写入 `startedAt` 即崩溃、老版本未写 `workerCreation`/`workspace.claim`、用户通过 DSH UI 手动打开过该 Session ID，或存储中存在未物化的 pending Session / 损坏或版本不兼容的 Session 产物），即便磁盘目录与 Git 引用均缺失，也不能当作“从未创建”直接重跑 `prepare`。
* **严格前置校验（任一不满足或呈 `unknown` 状态立即严格拒绝）**：
  1. **目标 Session 真实不存在校验（强制要求 `--dsh-home`）**：通过受支持的 DSH `sessionPersistence` / 控制器只读校验（覆盖已物化存储及未物化 pending 记录与 `workspaceRegistry` 对应目录绑定），确认 `workerSessionId(ticket.id)` **明确为 `not-found`**；若该 Session 已存在，或读取遇到 `SessionFormatUnsupportedError`、损坏日志、锁冲突、权限不足或 DSH Home 不可访问等任何非 `not-found` 结果，**按冲突或 `unknown` 严格拒绝**。
  2. **工单与历史 KV 校验**：工单存在且处于未结束态（`!ticket.ended`）；`ticket.assignments.every(a => !a.startedAt)`；且 `KV.workspace.claim(id)`、`KV.sessions.workerCreation(id)`、`KV.sessions.workerHeader(id)`、`KV.workspace.provenance(id)` **均不存在**（任一历史残余键存在即拒绝）。
  3. **目录真实不存在校验**：`ticket.execution?.directory` 非空且通过路径规范化校验；`lstat` 必须明确返回 `ENOENT`（`EACCES`、`EPERM`、符号链接或父目录异常等均属 `unknown`，严格拒绝）。
  4. **Git 引用与 worktree 注册校验**：若配置了 `managedRepository`（或工作区可关联到托管主仓），在主仓中校验 `refs/heads/agent/<name>` 与 `refs/dsh-superagent/<id>` **明确不存在**（`git show-ref --exists` 精准返回不存在语义，参见 `src/executor/provenance.ts:63-68`；其余退出码、锁冲突或仓库不可读均属 `unknown` 拒绝），并校验 `git worktree list --porcelain -z` 中不存在指向该目录或分支的已注册 worktree。
* **状态更新**：前置客观复检全部通过后，在单个 SQLite 事务内再次核对 Ticket 与 KV 键未发生变化，随后写入：
  * 追加式不可变审计记录（含操作人、时间、原因、`--dsh-home` 及 Session/目录/Git 前置检查结果摘要）；
  * `KV.workspace.claim(id) = { directory, state: 'new' }`；
  * `KV.sessions.workerCreation(id) = 'new'`；
  * 若当前设置启用了 `executor.managedRepository` 且 `ticket.execution?.name` 有效，同步按 `prepare()` 一致规则初始化 `KV.workspace.provenance(id)`（使后续 `prepareDirectory` 继续执行 `preflightCreation` 与 `verifyCreation`）。
  * **工具本身不创建目录、不执行 `prepare` 命令、不创建 Session**，实际创建仍交由服务启动后的 `DshExecutor.launch` 走标准路径与运行期护栏完成。

---

### 2. 检查、人工确认、审计与状态更新的边界与失败恢复

#### 2.1 四阶段职责边界（防止 TOCTOU 与责任混同）

| 阶段 | 职责与输入 | 严格禁止跨越的边界 |
| :--- | :--- | :--- |
| **1. 只读检查（Inspect）** | 校验只读快照/存储可读性，采集 `stopFailure`/`stopPending`、Session、目录与 Git 状态 | 零写入、零推断；任何检查失败或缺失一律标 `unknown`，禁止输出“可自动放行”建议 |
| **2. 人工确认（Confirmation）** | 由运维结合进程表、句柄、tmux 与 DSH 历史独立确认“旧执行已停”或“历史确为空” | **人工确认不等于技术隔离**：不可替代进程/文件锁，不可越过 `unknown` 拒绝，不授权强杀进程或删目录 |
| **3. 客观复检 + 审计（Re-verify & Audit）** | 写命令持 `stateDir` 排他锁且确认无 `-wal` 后，**重新执行一遍完整只读检查**（防 TOCTOU），生成不可变审计载荷 | 禁止信任先前人工看到的旧 `inspect` 输出直接写库；禁止覆盖或删除历史审计记录 |
| **4. 状态更新（Mutation）** | 在单 SQLite 事务内原子写入审计键并更新目标 KV（清除停止栅栏或写入 `new` 初始标记） | 禁止跨库/跨文件系统“伪事务”；实际工作区/Session 创建与运行期校验仍由重启后的 `DshExecutor` 执行 |

#### 2.2 失败与崩溃恢复规范

1. **锁获取失败 / 锁失陷（Compromised）/ 非空 `-wal`**：立即中止且零写入；**严禁**手工删除 `proper-lockfile` 锁或 `-wal` 文件强行跑脚本，须先核实原服务进程已退出并由正常 SQLite 恢复后再重试。
2. **只读复检遇到 `unknown` 或不匹配**：直接 fail-closed 退出，保留原有 `stopFailure`、`stopPending`、工单与文件系统原样，等待问题查明。
3. **SQLite 事务提交前崩溃**：依赖 SQLite 原子事务自动回滚；隔离栅栏或未采纳状态原封不动，服务即使重启也继续保持 fail-closed 阻断。
4. **事务已提交但输出反馈前崩溃（终端断开或工具异常退出）**：重启或再次操作前，运维**必须先执行 `inspect` 与审计查询确认实际库状态**，禁止盲目重跑写入：
   * 若 `release-stop-fence` 审计键已存在且目标 `stopFailure`/`stopPending` 已清空，说明该次解锁已完成，无需重复解锁；
   * 若 `adopt-never-started` 审计键与 `claim`/`workerCreation` 已落盘，说明采纳已完成（此时若外部已被创建出目录或 Session，则属于冲突，禁止再次 adopt）。
5. **采纳后服务首次 `launch` 途中崩溃**：若在运行时停留在 `claim.state = 'preparing'` 或 `workerCreation = 'creating'`，服务会按 `src/executor/dsh.ts:304,371` 与 `docs/015` 拒绝自动覆盖并要求人工核查。此时**严禁再次运行 `adopt-never-started` 重置为 `'new'`**，必须人工检查半成品目录/Session 后按正常故障恢复流程处置。
6. **解锁后重启仍触发异常或再度隔离**：正因为人工确认不等于技术隔离，若重启后 `checkWorkspace`、`requireWorker`、`checkHandoffStops` 或后台停止再次报错，说明仍存在未核净的残留活动、前驱未解或真实状态冲突，运行期护栏重新阻断属预期行为，不得绕过。

---

### 3. 优化面板与 API 的可观测性（`src/app/views/tickets.ts`、`src/executor/dsh.ts`）

* 在 Ticket 详情视图（`ticketDetail`）中只读展示该工单是否存在未解除的 `stopFailure` / `stopPending` 隔离标记（以及最近一次 `stopReleaseAudit` 审计摘要），方便人工在面板直接定位是哪个工单及哪条 `handoffFrom` 前驱链导致全局 `worker` 健康报错，而无需翻查底层 KV 表。

### 4. 更新升级与排障文档

* 在 `docs/006-deployment.md`（Troubleshooting 章节）、`docs/014-dsh-rc3-compatibility.md` 和 `docs/015-workspace-lifecycle.md`（及对应 `docs/zh/*`）中记录 `inspect`、`release-stop-fence` 与 `adopt-never-started` 的安全前提、人工核验清单、边界声明与失败恢复步骤。

---

## 四、 验证与测试计划

1. **单元测试**：
   * 测试 `inspect`：能严格区分 `ready-for-operator-review`、`conflict-or-partial` 与 `unknown`；缺 `--dsh-home`、DSH 存储不可读/损坏或 Git 仓库报错时一律归为 `unknown` 并拒绝后续写入。
   * 测试 `adopt-never-started`：对从未启动且已证实目录、`workerSessionId`、历史 KV、Git 引用与 worktree 均不存在的旧工单成功补齐标记并在后续 `DshExecutor` 启动中正常完成 `prepare`；对曾启动过（`startedAt` 存在）、磁盘目录已存在、**目标 Session 已存在或 DSH 存储状态 `unknown`**、Git 引用/worktree 已存在或仓库不可读的工单严格拒绝（且无 `--force` 旁路）。
   * 测试 `release-stop-fence`：在服务持锁运行时或存在非空 `-wal` 时拒绝执行；缺少核验依据或处于 `unknown` 状态时拒绝解除；前置复检快照不一致时拒绝覆盖；停服且核验通过后在单事务内生成不可变审计记录并清除 `stopFailure`/`stopPending`（不连带解除 `handoffFrom` 前驱），重启 `DshExecutor` 后 `worker` 健康恢复正常且工单可继续调度。
   * 测试边界与崩溃恢复：覆盖事务提交前中止（完整回滚保持 fail-closed）、事务后重入核对、`adopt` 后卡在 `preparing`/`creating` 拒绝二次 `adopt`、以及 TOCTOU 复检拦截（`inspect` 后外部悄悄创建了目录或 Session 时 `adopt` 拒绝写入）。
   * 测试 `007-architecture.md` 与 `docs.spec.ts` 文档同步校验通过。
