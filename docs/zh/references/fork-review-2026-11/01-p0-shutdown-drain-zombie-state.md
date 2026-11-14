# 01 [P0] 停机排空失败使服务滞留“监听存活但内部瘫痪”僵尸态

* **优先级**：P0（高优 — 影响服务停机、发布更新与健康监控准确性）
* **涉及文件**：
  * `src/app/runtime.ts`（`requestShutdown` L209-219、`stop` L254-255、`shutdown` L256-288）
  * `scripts/restart-superagent.ps1`（L55-70）
  * `scripts/dsh-superagent`（`stopServer` L1072-1105）
  * `docs/006-deployment.md` / `docs/zh/006-deployment.md`
  * `tests/runtime.spec.ts`、`tests/http.spec.ts`

---

## 一、 问题描述与复现路径

当运维或发布脚本在 Windows 上调用 `POST /orchestrator/api/service/stop` 请求优雅停机时：

1. `Runtime.requestShutdown()` 在 50ms 后异步调用 `this.stop()`（即 `this.shutdown()`）。
2. `Runtime.shutdown()` 第一行立即执行：
   ```ts
   this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
   ```
   此时全局 `lifetime`（`this.stopped.signal`）已被永久 abort，`Passes` 与 `MasterAssessor` 已停止。
3. 随后 `this.executor.shutdown()` 执行后台任务与子代理停止。在 `0.2.2-rc.2 / rc.3` 下，只要某个已加载 Worker 历史上存在子代理目录记录或观察到树工作，`stopSubagents()` 就会抛出 `SubagentCleanupUnconfirmed`（或因 10 秒排空超时抛错），进而导致 `this.executor.shutdown()` 与 `this.shutdown()` 整体 reject。
4. 在 `requestShutdown()` 中（L215-217）：
   ```ts
   void this.stop().then(() => { shutdownExit(0) }, (error: unknown) => {
     this.ctx.logger.warn('dsh-superagent stop drain failed; process retained for investigation: %s', String(error))
   })
   ```
   出于保留现场供人工排查的考虑，进程**不调用 `shutdownExit`**，且 `finally` 中因 `workersStopped === false` **保留了 SQLite 连接与状态目录锁**，同时也**未执行 `this.disposers`（HTTP 路由未卸载）**，更**未将 `this.runtimeHealth` 更新为 `'error'`**。

### 导致的严重后果

1. **假健康僵尸态**：进程继续监听 `127.0.0.1:<port>`，`GET /orchestrator/api/state` 仍返回 HTTP 200，且 `health.runtime` 依然显示 `'ready'`（仅 `worker` 可能为 `'error'`），外部状态检查与只读 Watchdog 无法直接从 `health.runtime` 识别出“服务已进入不可逆的停机失败瘫痪态”。
2. **业务完全停摆但占锁占端口**：由于 `closingFlag === true` 且 `lifetime` 已 abort，所有依赖 `this.lifetime` 的 CLI 调用、数据源轮询和工单调度全部失效，但端口和 `orchestrator.sqlite` 锁仍被死死占住。
3. **二次 `service/stop` 永久无效**：`stop()` 定义为 `return this.stopping ??= this.shutdown()`，缓存了首次 rejected 的 Promise。后续任何 `POST /orchestrator/api/service/stop` 都会立即命中同一个 rejected Promise，既不会重新尝试排空，也不会退出；`restart-superagent.ps1` 与 `scripts/dsh-superagent stop` 只能空等 5 分钟直至超时报错。

---

## 二、 设计权衡与修复目标

在 `rc.3` 候选阶段，“排空未确认时不静默释放数据库锁以免新实例并发踩踏残留子代理”是合理的安全策略（见 `AGENTS.md` 与 `docs/014-dsh-rc3-compatibility.md`）。但**保留现场不等于伪装正常服务**。修复需同时满足：

1. **立即可观测**：一旦 `shutdown()` 失败，`runtimeHealth` 必须立即变为 `'error'`，明确标注 `shutdown_failed` 及原因，使 `scripts/dsh-superagent status`（退出码 1）、Web 面板和只读 Watchdog 立即告警。
2. **显式暴露生命周期阶段**：在 `/orchestrator/api/state` 中（或通过 `runtime` health detail）清晰反映 `closing` / `shutdownFailed` 状态，避免外部工具误判服务仍在正常工作。
3. **明确重复调用 `POST service/stop` 的语义**：当进程已处于停机失败滞留态时，再次调用 `POST service/stop` 不应返回误导性的 `200 {"stopping": true}`，而应返回明确错误状态码（如 `409` 或 `500`）告知调用方“停机排空未确认，进程已滞留等待人工排查”，让 `restart-superagent.ps1` / `scripts/dsh-superagent stop` 立即失败并输出准确诊断，无需盲等 5 分钟端口关闭。

---

## 三、 具体修复方案

### 1. 在 `Runtime` 中记录停机失败状态并更新 `runtimeHealth`（`src/app/runtime.ts`）

* 新增私有字段 `private shutdownError?: string`。
* 在 `shutdown()` 的 `catch` / 失败路径（或 `finally` 中 `if (!workersStopped)`）更新 `runtimeHealth`：
  ```ts
  } catch (error) {
    const detail = `Shutdown drain failed; process and state lock retained for operator investigation: ${error instanceof Error ? error.message : String(error)}`
    this.shutdownError = detail
    this.runtimeHealth.set({ state: 'error', detail, at: now() })
    throw error
  }
  ```
* 在 `requestShutdown()` 入口检查 `this.shutdownError`：
  * 若 `this.shutdownError` 已存在，直接抛出包含该详情的错误（由 `http.ts` 返回 500，或自定义 409 状态错误），不再伪装返回 `{ stopping: true }`。

### 2. 在控制脚本与重启脚本中快速识别停机滞留态（`scripts/dsh-superagent`、`scripts/restart-superagent.ps1`）

* 在发送 `POST /orchestrator/api/service/stop` 后的轮询等待循环中：
  * 除检查进程存活 / 端口监听外，每隔数秒探测一次 `GET /orchestrator/api/state`。
  * 若发现 `state.health.runtime.state === 'error'` 且详情匹配停机排空失败标记，**立即终止 5 分钟空等**，直接报出“服务停机排空未确认，已保留现场与状态锁，请先排查原进程与残留子代理/后台任务”，禁止继续执行更新或强制杀进程。

### 3. 同步更新部署文档（`docs/006-deployment.md` 及 `docs/zh/006-deployment.md`）

* 在 `POST service/stop` 与 `status` 说明中补充：当停机排空失败时，`runtime` 健康项将转为 `error`（`status` 退出码为 `1`），二次调用 `POST service/stop` 将直接报错拒绝，需人工核查后再恢复。
* 注意保持中英文文档标题层级与表格行数完全一致，确保 `tests/docs.spec.ts` 通过。

---

## 四、 验证与测试计划

1. **单元测试（`tests/runtime.spec.ts` & `tests/http.spec.ts`）**：
   * 构造 Worker 停止时抛出 `SubagentCleanupUnconfirmed` 或超时的夹具，调用 `POST /orchestrator/api/service/stop`。
   * 断言数据库与状态锁未释放的同时，`GET /orchestrator/api/state` 中 `health.runtime.state === 'error'` 且包含明确诊断信息。
   * 断言再次请求 `POST /orchestrator/api/service/stop` 时不再返回 `200 { stopping: true }`，而是返回错误响应。
2. **脚本回归测试（`tests/service-script.spec.ts` & `tests/restart-superagent.spec.ts`）**：
   * 模拟停机后服务进入 `runtime: error` 滞留态，验证 `stop` 与 `restart-superagent.ps1` 能快速退出并给出清晰的排查提示，而非耗尽 5 分钟超时。
3. **全量门禁**：在独立任务 worktree 中执行 `pnpm check` 确认类型检查、构建、文档一致性与测试全绿。
