# 06 [P1] 部署执行器 `deploy.mjs` 缺少外层互斥锁导致并发覆写 `resultFile`

* **优先级**：P1（中优 — 并发触发部署任务时会破坏请求去重与 `started_needs_attention` 保护状态）
* **涉及文件**：
  * `scripts/deploy.mjs`（L98-151）
  * `scripts/restart-superagent.ps1`（L24-29）
  * `docs/006-deployment.md` / `docs/zh/006-deployment.md`、`AGENTS.md`
  * `tests/deploy-executor.spec.ts`

---

## 一、 问题描述与并发竞态复现

`orchestrator_deploy` 工具写出部署请求文件并唤醒计划任务 `dsh-superagent-deploy`（执行 `scripts/deploy.ps1` → `scripts/deploy.mjs`）。当计划任务周期触发与唤醒命令并发重叠，或管理员手动多跑了一次 `deploy.mjs` 时：

1. **进程 A** 读取 `requestPath`（消化摘要 `D1`），检查 `resultFile` 未执行过，随后调用 `restart-superagent.ps1`，成功获取 Windows 命名 Mutex，开始停服、拉代码、`pnpm install`、`pnpm build`（耗时数十秒至数分钟）。
2. 在进程 A 尚未写完 `resultFile` 期间，**进程 B** 启动：
   * 读取同一个 `requestPath`（摘要仍为 `D1`）；
   * 读取旧的 `resultFile`（尚无 `D1` 记录），通过去重检查；
   * 调用 `restart-superagent.ps1`，在 `scripts/restart-superagent.ps1:29` 因抢不到命名 Mutex 立即抛错退出（退出码 `1`，stderr 包含 `Another deployment or recovery is already in progress.`）。
3. **竞态破坏点（`scripts/deploy.mjs:140-144`）**：
   ```js
   const ok = execution.status === 0
   const phase = ok ? 'completed' : [2, 3].includes(execution.status) ? 'started_needs_attention' : 'restart_failed'
   ...
   writeFileSync(config.resultFile, JSON.stringify(result, null, 2) + '\n')
   ```
   * **情况 1（进程 B 在进程 A 完成之后才落盘 `resultFile`，例如进程 A 恰好在进程 B 启动 `pwsh` 的几百毫秒内写完退出）**：进程 B 将 `resultFile` 覆写为 `{ ok: false, phase: 'restart_failed', requestDigest: D1 }`！原本已成功的 `completed`（或需要人工介入的 `started_needs_attention`）被冲掉；且由于 `deploy.mjs:117` 在无 `DSH_WATCHDOG_REQUEST_SHA256` 时仅对 `previous.ok || previous.phase === 'started_needs_attention'` 生效去重，**下一次计划任务轮询看到 `restart_failed` 后，会把刚刚已经部署成功的请求再重跑一遍（再次停服重启生产服务）！**
   * **情况 2（非原子写入）**：直接 `writeFileSync(config.resultFile, ...)` 未使用临时文件 + `renameSync`，并发读取者可能读到半截 JSON。

---

## 二、 具体修复方案

### 1. 在 `deploy.mjs` 外层增加原子排他锁文件（`<resultFile>.lock`）

在 `deploy.mjs` 进入执行阶段（`--validate` 和 `--plan` 之后、二次读取 `requestFor` 与去重检查**之前**），使用 `openSync(lockPath, 'wx')`（或项目中已有的 `proper-lockfile`）获取执行器级排他锁：

1. 锁文件内容写入 `{ pid: process.pid, startedAt: new Date().toISOString() }`（若使用 `proper-lockfile`，利用其心跳自动续租与 `stale` 检测，避免进程被强杀后永久死锁）。
2. **当锁已被其他存活执行器持有时**：
   * 直接向 stdout/log 输出 `'Another deploy executor is already running; skipping without modifying resultFile.\n'`；
   * **绝不触碰或覆写 `config.resultFile`**；
   * 以退出码 `0`（或专有跳过码）安全退出。

### 2. 防御性保护：识别底层生命周期 Mutex 冲突，禁止冲掉已有高优结果

即便外层文件锁因不同配置路径未拦截（例如手工直接运行了另一个 `resultFile` 或锁刚释放），若 `restart-superagent.ps1` 因命名生命周期 Mutex 被占用退出（可通过约定专用退出码如 `exit 75` `EX_TEMPFAIL` 或匹配明确输出标识）：
* `deploy.mjs` 不应将该次“未实际触碰服务的锁退避”覆写到已有同 `requestDigest` 且处于 `completed` 或 `started_needs_attention` 的 `resultFile` 上。

### 3. `resultFile` 改为原子落盘

将 `writeFileSync(config.resultFile, ...)` 改为写同目录临时文件 `${config.resultFile}.${process.pid}.tmp` 后调用 `renameSync`，确保任何时刻面板或运维读取到的 `resultFile` 都是完整 JSON。

### 4. 同步更新文档

更新 `AGENTS.md` 与 `docs/006-deployment.md`（及 `docs/zh/006-deployment.md`）中关于“无持久化部署锁，并发执行器可能竞争结果记录”的描述，如实反映新增的执行器互斥与原子落盘行为。

---

## 三、 验证与测试计划

1. **`tests/deploy-executor.spec.ts` 新增并发测试**：
   * 启动第一个 `deploy.mjs`（Mock `restartScript` 延迟 500ms 后返回退出码 `0` 或 `2` `started_needs_attention`）。
   * 在其运行期间启动第二个 `deploy.mjs` 指向同一配置。
   * 断言：第二个实例立即安全跳过，不启动 `restartScript`；两个实例都结束后，`resultFile` 完整保留第一个实例写入的 `completed` / `started_needs_attention` 记录，未被覆写为 `restart_failed`。
   * 测试陈旧锁（进程已不存在且超过 stale 阈值）的恢复行为或报错提示。
