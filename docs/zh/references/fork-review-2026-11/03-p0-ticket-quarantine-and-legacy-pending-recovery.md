# 03 [P0] Fail-closed 隔离栅栏与升级前排队工单缺乏受控运维恢复工具

* **优先级**：P0（高优 — 升级 `0.2.2-rc.3` 及新工作区生命周期后，运维排障闭环必需）
* **涉及文件**：
  * `src/executor/dsh.ts`（`stopIntent` / `recordStopFailure` / `checkStopFailure` L534-593、`launch` L696-719）
  * `src/executor/background.ts`（`stopSubagents` L206-238）
  * `src/kv.ts`（`KV.executor.stopPending`、`KV.executor.stopFailure`、`KV.workspace.claim`、`KV.sessions.workerCreation`）
  * `scripts/`（新增离线受控运维脚本或 `scripts/dsh-superagent` 子命令）
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

根据 `AGENTS.md`、`docs/014` 与 `docs/015` 的安全原则：
* **绝不能改成自动静默放行**：不能在重启时自动清空 `stopPending`/`stopFailure`，也不能对所有缺目录的旧工单无条件重跑 `prepare`。
* **必须由本机运维显式确认、离线或在严格锁保护下执行，并留下持久化审计记录**。
* **切勿暴露为普通模型可调用的 Orchestrator 工具**，防止 Agent 自行绕过安全栅栏。

---

## 三、 具体修复方案

### 1. 提供离线受控运维 CLI 工具（推荐新建 `scripts/superagent-fence-admin.mjs` 或集成至 `scripts/dsh-superagent`）

工具直接操作**已停服且无并发写锁**（校验 `proper-lockfile` 状态目录锁 + 拒绝非空 `-wal` 或在同一套锁机制下互斥打开 `Store`）的 `orchestrator.sqlite`，提供三个子命令：

1. **`inspect`（只读诊断）**：
   * 列出所有存在 `KV.executor.stopFailure` 或 `KV.executor.stopPending` 的工单 ID、记录时间、错误原因、当前工单状态（open/ended）及关联工作目录。
   * 列出所有“升级前已接收但从未启动过（`assignments.every(a => !a.startedAt)`）、且缺少 `workspace.claim` / `workerCreation`、且磁盘上目录与 Session 均不存在”的待迁移排队工单。

2. **`release-stop-fence --ticket <id> --operator <name> --reason <text>`（受控解除停止栅栏）**：
   * 前置校验：服务未运行（成功获取 `stateDir` 排他锁）。
   * 原子事务内：读取原 `stopFailure(id)` 与 `stopPending(id, *)` 快照，追加写入持久化审计键（如 `KV.executor.stopReleaseAudit(id, timestamp)`，包含操作人、原因、原错误内容），然后删除该 `ticketId` 下的 `stopFailure` 与 `stopPending` 键。

3. **`adopt-never-started --ticket <id> --operator <name> --reason <text>`（受控补齐升级前未启动工单的初始标记）**：
   * 严格前置校验（任一不满足立即拒绝）：
     * 工单处于未结束态（`!ticket.ended`）；
     * 所有 Assignment 均从未启动过（`ticket.assignments.every(a => !a.startedAt)`）；
     * `KV.workspace.claim(id)` 与 `KV.sessions.workerCreation(id)` 均不存在；
     * `ticket.execution?.directory` 在文件系统上**确实不存在**（`lstat` 报 `ENOENT`，防止覆盖任何已有目录）；
     * 若配置了 `managedRepository`，在主仓中校验 `refs/heads/agent/<name>` 与 `refs/dsh-superagent/<id>` 均不存在。
   * 校验通过后，在事务内写入 `KV.workspace.claim(id) = { directory, state: 'new' }`、`KV.sessions.workerCreation(id) = 'new'` 及审计记录。服务启动后执行器即可按标准新工单安全完成首次 `prepare` 与 Session 创建。

### 2. 优化面板与 API 的可观测性（`src/app/views/tickets.ts`、`src/executor/dsh.ts`）

* 在 Ticket 详情视图（`ticketDetail`）中只读展示该工单是否存在未解除的 `stopFailure` / `stopPending` 隔离标记，方便人工在面板直接定位是哪个工单导致全局 `worker` 健康报错，而无需翻查底层 KV 表。

### 3. 更新升级与排障文档

* 在 `docs/006-deployment.md`（Troubleshooting 章节）、`docs/014-dsh-rc3-compatibility.md` 和 `docs/015-workspace-lifecycle.md`（及对应 `docs/zh/*`）中记录 `inspect`、`release-stop-fence` 与 `adopt-never-started` 的标准排查与执行步骤。

---

## 四、 验证与测试计划

1. **单元测试**：
   * 测试 `inspect` 能准确区分“从未启动的旧版排队工单”与“已启动过但目录丢失的工单”。
   * 测试 `adopt-never-started`：对从未启动且目录不存在的旧工单成功补齐标记并在后续 `DshExecutor` 启动中正常完成 `prepare`；对曾启动过（`startedAt` 存在）或磁盘目录已存在的工单严格拒绝。
   * 测试 `release-stop-fence`：在服务持锁运行时拒绝执行；停服执行后生成不可变审计记录、清除 `stopFailure`/`stopPending`，重启 `DshExecutor` 后 `worker` 健康恢复正常且工单可继续调度。
   * 测试 `007-architecture.md` 与 `docs.spec.ts` 文档同步校验通过。
