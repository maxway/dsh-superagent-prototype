# Fork 演进审查与问题修复索引（`6337fc8` → `1bfad96`）

* **对比基线**：上游初始提交 `6337fc8` / `8c32a9d`（2026-10-31 DeepSeek Harness Team 原型提交，与 Fork 合并基点 `758a90e` 文件树完全一致） → `1bfad96`（2026-11-14）
* **变更规模**：316 个提交，316 个文件变更（`+25,013 / -3,499` 行）
* **审查日期**：2026-11-14

---

## 一、 演进脉络概览

相对最初仅支持 POSIX 环境、单 GitHub 仓库与 DSH `0.2.1-alpha.2` 的研究原型，当前仓库已完成 7 个主要维度的工程演进：

1. **GitLab 数据源与单活多源切换**：新增完整 GitLab Source（轮询 + Token 校验 Webhook 防抖唤醒）、PR/MR 统一抽象（`git-change.ts`）、面板一键切源与 `ticket.git.provider` 跨源恢复阻断。
2. **飞书权限收敛与只读答疑（`reply`）准入级**：移除受限读取权限依赖（`feishu-read.ts`、`feishu-image.ts`、群成员自动同步），新增群聊非白名单 `@` 的只读调查答疑授权强度，私聊严格限制白名单。
3. **原生 Windows 移植与自举部署体系**：重写跨平台 Node 控制脚本 `scripts/dsh-superagent`、Windows CLI 配置目录隔离与 `.cmd` 禁用垫片、WMI 脱离外部 Job Object 隐藏启动、`POST /orchestrator/api/service/stop` 优雅退出路由。
4. **分级模型、工单交接（Handoff）与谷价错峰调度**：引入 `low` / `high` / `expert` 三档路由与 `orchestrator_ticket_handoff`（`expert` 强校验人类独立行指令）、`offPeak` 谷价时间窗、`0.4` 上下文压缩阈值及 GPT 执行器提示词适配。
5. **DSH `0.2.2-rc.3` 适配与子代理隔离栅栏**：升级至 `0.2.2-rc.3`，移除 Worker 预设子代理工具并追加运行时 Guard（含 128 层持久化祖先追溯），建立独立锁文件的 `contracts/subagent/{rc1,rc2,rc3}` 契约测试与 `stopPending` / `stopFailure` 持久化冻结栅栏。
6. **工作区与 Session 安全生命周期**：停用破坏性自动删除 worktree/分支，改为只读盘点（`reclaimWorkspace` + `workspace-inventory.mjs`）、创建溯源（`provenance.ts`）与 `device + inode` / Session 创建时间戳恢复校验。
7. **独立只读 Watchdog 观察器与自举治理规范**：Watchdog 收敛为纯只读本地观察器 `scripts/watchdog`，配套中文文档体系、`AGENTS.md` 生产保护红线与 `.gitlab-ci.yml` Windows CI。

---

## 二、 问题索引与优先级排序

以下 9 项问题按优先级（`P0 高优` → `P1 中优` → `P2 低优`）排序，每项问题均配有独立的根因分析与修复方案说明文档：

| 序号 | 优先级 | 问题标题 | 核心涉及模块 | 修复方案文档 |
| :---: | :---: | --- | --- | --- |
| 01 | **P0** | 停机排空失败使服务滞留“监听存活但内部瘫痪”僵尸态，且无法再次优雅停机或被健康检查识别 | `src/app/runtime.ts`, `scripts/dsh-superagent` | [01-p0-shutdown-drain-zombie-state.md](./01-p0-shutdown-drain-zombie-state.md) |
| 02 | **P0** | 目录物理身份比较在未知态下缺少反向保守语义，且工单交接（Handoff）工作区分离校验无法识别软链 / Junction 与目录嵌套 | `src/infra/environment.ts`, `src/core/part.ts`, `src/core/tickets.ts`, `src/executor/dsh.ts`, `src/executor/workspace.ts` | [02-p0-windows-path-case-canonicalization.md](./02-p0-windows-path-case-canonicalization.md) |
| 03 | **P0** | Fail-closed 后台停止隔离栅栏（`stopFailure`）与升级前排队工单缺乏受控运维解锁与迁移工具 | `src/executor/dsh.ts`, `src/executor/background.ts`, `scripts/dsh-superagent` | [03-p0-ticket-quarantine-and-legacy-pending-recovery.md](./03-p0-ticket-quarantine-and-legacy-pending-recovery.md) |
| 04 | **P1** | `Sessions` 初始化类型签名遗漏 `tier`，且重启恢复已有 Session 时未挂载提示词变量同步钩子 | `src/app/sessions.ts`, `src/app/role-models.ts` | [04-p1-session-tier-signature-and-prompt-hook-resume.md](./04-p1-session-tier-signature-and-prompt-hook-resume.md) |
| 05 | **P1** | IPv6 回环地址 `[::1]` 在运维脚本与服务端 `registerHttp` / `sameOrigin` 之间契约不一致 | `src/app/http.ts`, `scripts/dsh-superagent` | [05-p1-loopback-ipv6-same-origin-alignment.md](./05-p1-loopback-ipv6-same-origin-alignment.md) |
| 07 | **P1** | Watchdog 收敛为只读观察器后遗留未接线的写接口、无上限轮询接口与半禁用脚本 | `src/app/http.ts`, `src/app/watchdog-recovery.ts`, `scripts/watchdog-*` | [07-p1-watchdog-legacy-surface-cleanup.md](./07-p1-watchdog-legacy-surface-cleanup.md) |
| 08 | **P2** | 工作区创建溯源 `isolatedGit` 将任何 Git `stderr` 判为异常并静默吞掉原因导致难以排障 | `src/executor/provenance.ts`, `src/executor/dsh.ts` | [08-p2-provenance-git-stderr-and-diagnostics.md](./08-p2-provenance-git-stderr-and-diagnostics.md) |
| 09 | **P2** | GitLab Webhook 对账未分页查询，且监听器对非法请求调用 `req.resume()` 存在慢速大包占用风险 | `src/sources/gitlab-webhook.ts` | [09-p2-gitlab-webhook-pagination-and-socket-drain.md](./09-p2-gitlab-webhook-pagination-and-socket-drain.md) |
| 10 | **P2** | 未接线原语 `WorkspaceRefJournal` 绕过 `Store` 版本化 Schema 迁移体系直接执行建表 DDL | `src/app/workspace-journal.ts`, `src/app/store.ts`, `src/app/migration.ts` | [10-p2-workspace-journal-schema-migration-integration.md](./10-p2-workspace-journal-schema-migration-integration.md) |

---

## 三、 建议修复批次与实施注意事项

1. **第一批（生产发布阻塞项 / P0）**：优先处理 **01、02、03**。这三项直接影响 Windows 原生部署下的停机可观测性、跨盘符/大小写路径恢复校验，以及升级到 `rc.3` 候选版后历史子代理工单与排队工单的恢复运维闭环。
2. **第二批（运行时一致性与部署幂等 / P1）**：依次评估 **04、05、07**。**07** 涉及删除/收敛 `src/` 与 `tests/` 文件，需同步更新 `docs/007-architecture.md`（及 `docs/zh/007-architecture.md`）以通过 `tests/docs.spec.ts` 一致性测试。
3. **第三批（防御纵深与演进整洁度 / P2）**：处理 **08、09、10**，可在常规迭代或启用自动引用清理前按需推进。
4. **自举开发红线提醒**：所有实际代码修复均须遵循仓库根目录 `AGENTS.md` 规范，在独立任务 worktree 与非生产 Profile / DSH Home（禁用飞书）中开发并跑通 `pnpm check`，严禁在稳定检出目录直接执行构建或停止生产进程。
