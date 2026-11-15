# 07 [P1] Watchdog 收敛为只读观察器后遗留未接线写接口、轮询接口与半禁用脚本

* **优先级**：P1（中优 — 减小服务端攻击/误操作面、消除无上限内存轮询及维护噪音）
* **涉及文件**：
  * 服务端路由与逻辑：
    * `src/app/http.ts`（`GET watchdog/wait` L170-243 & L318、`POST watchdog/report` L322、`POST watchdog/runs` L335、`POST watchdog/recoveries` L345）
    * `src/app/watchdog.ts`、`src/app/watchdog-recovery.ts`、`src/app/store.ts`（`watchdog_run` / `watchdog_recovery` 表）
  * 脚本目录：
    * `scripts/watchdog`（L40-41 兼容忽略的 9 个废弃配置项）
    * `scripts/watchdog-control.mjs`、`scripts/watchdog-artifact.mjs`、`scripts/watchdog-bootstrap.mjs`、`scripts/watchdog-smoke.mjs`、`scripts/watchdog-update.mjs`、`scripts/watchdog-launch-observer.ps1`、`scripts/watchdog-launch-observer.vbs`、`scripts/watchdog-agent/*`
  * 架构与部署文档：
    * `docs/006-deployment.md`、`docs/007-architecture.md`（及对应 `docs/zh/*`）

---

## 一、 问题描述与现状盘点

在项目快速演进过程中，Watchdog 先后经历了“模型驱动互助恢复 + 自动部署 + 飞书主动播报” → “独立版本化制品自更新” → “纯只读本地观察器”三次架构收敛。当前最终形态（见 `AGENTS.md` 与 `scripts/watchdog`）明确规定：
> 观察器只通过 `GET /orchestrator/api/watchdog` 读取服务快照并写本地状态、日志与心跳；不运行模型、不发飞书、不写服务端、不自动恢复服务或工单、不轮询部署请求、也不自更新。

但代码库中仍遗留了前两代方案的大量活跃路由与半禁用脚本，带来两方面问题：

### 1. 服务端仍暴露未使用的写接口与高频轮询接口（`src/app/http.ts`）

1. **`GET /orchestrator/api/watchdog/wait`（资源消耗隐患）**：
   * 当前 `scripts/watchdog` 已不再使用长轮询。
   * 但该路由仍在 `watchdogWait`（`src/app/http.ts:223-243`）中以 **每 500ms 一次的 `setTimeout` 循环**持续运行长达 240 秒，每次循环全量查询所有开放工单、构造视图并计算 SHA-1（`watchdogVersion`），且**没有任何并发等待连接数上限**。若本机有遗留旧脚本或误调用并发挂起数十个 `watchdog/wait` 请求，将凭空造成每秒上百次同步 SQLite 读取与 JSON 序列化开销。
2. **`POST /orchestrator/api/watchdog/report`（外部副作用接口）**：
   * 只要请求带本地同源头，即可触发飞书群消息发送。
3. **`POST /orchestrator/api/watchdog/recoveries` 与 `POST /orchestrator/api/watchdog/runs`（状态变更接口）**：
   * 若环境变量遗留了 `DSH_SUPERAGENT_WATCHDOG_RECOVERY=enforce` 且宿主机存在未清理的旧版计划任务，仍可能绕过只读原则自动触发工单重试。

### 2. 脚本与测试存在大量“半残废/已禁用”资产

* `scripts/watchdog-control.mjs:22-32` 中 `stopLauncherProcesses`、`buildFromRepo`、`installLaunchers`、`prepareArtifact`、`deployArtifact`、`startObserver`、`stopObserver` 7 个导出函数全部直接抛出 `'Watchdog lifecycle and deployment are temporarily disabled for safety'`。
* `scripts/watchdog-agent/*`（含模型补丁与提示词）、`scripts/watchdog-artifact.mjs`、`scripts/watchdog-update.mjs` 等多套脚本及其 10 余个 `tests/watchdog-*.spec.ts` 仍在维护与 CI 中运行，但与当前推荐架构脱节，容易误导后续参与自举开发的 Worker。

---

## 二、 分阶段收敛修复方案

考虑到生产宿主机可能尚未完成新版独立 Watchdog 切换（`AGENTS.md` 指出生产需单独核查已安装的计划任务），建议分两步稳妥收敛：

### 第一阶段（立即可做，零破坏）：加固活跃路由安全边界

1. **限制或下线 `GET watchdog/wait`**：
   * 若确认本机无外部调用方依赖长轮询，直接移除 `GET watchdog/wait`（或至少加上单实例并发守卫 `maxConcurrentWaits = 2`，超出返回 `429`，并将内部轮询间隔从 `500ms` 放宽至 `2000ms` 或改为事件驱动唤醒）。
2. **默认冻结服务端写接口**：
   * 将 `POST watchdog/recoveries`（现已默认 `off`）、`POST watchdog/report`、`POST watchdog/runs` 明确标记为 `@deprecated`，或统一受控于显式特性开关（默认拒绝并返回 `410 Gone` / `403 Disabled`，除非显式开启兼容开关），防止宿主机遗留旧脚本静默写入数据库或向生产飞书群发消息。

### 第二阶段（确认宿主机无旧版计划任务后）：清理废弃脚本与归档模块

1. **核查生产宿主机计划任务**：只读检查 Windows Task Scheduler 中 `dsh-superagent-watchdog*` 任务的实际命令行，确认无任务指向 `scripts/watchdog-agent/run.ps1`。
2. **清理废弃脚本与未用模块**：
   * 归档或移除 `scripts/watchdog-agent/`、`scripts/watchdog-artifact.mjs`、`scripts/watchdog-bootstrap.mjs`、`scripts/watchdog-update.mjs` 及已废止的 `src/app/watchdog-recovery.ts`。
   * **注意 SQLite 向后兼容**：即使下线 `src/app/watchdog-recovery.ts` 和 `POST watchdog/runs`，`Store` 中已存在的历史表 `watchdog_run` / `watchdog_recovery` 可保留只读或不强制 `DROP TABLE`，以免产生不必要的数据库迁移风险。
   * **同步更新架构清单（关键！）**：`tests/docs.spec.ts` 强制校验 `src/` 下每一个模块文件与 `tests/` 下每一个 `.spec.ts(x)` 文件都必须精确列在 `docs/007-architecture.md`（及 `docs/zh/007-architecture.md`）的 `## Modules` 与 `## Tests` 表格中。增删任何 `src/` 或 `tests/` 文件时必须在同一提交中同步更新中英文 `007-architecture.md`！

---

## 三、 验证与测试计划

1. 更新或精简对应的 `tests/http.spec.ts` 与 `tests/watchdog*.spec.ts`。
2. 运行 `pnpm test tests/docs.spec.ts` 验证中英文文档结构、模块表与测试表 100% 对齐。
3. 运行 `node scripts/watchdog --help` 及单元测试，确认纯只读观察器功能完全不受影响。
