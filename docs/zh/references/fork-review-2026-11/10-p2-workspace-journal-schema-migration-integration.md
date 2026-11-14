# 10 [P2] `WorkspaceRefJournal` 绕过 `Store` 版本化 Schema 迁移体系直接执行建表 DDL

* **优先级**：P2（低优 — 当前原语尚未接入运行时主链路，在正式启用本地引用清理前需收敛）
* **涉及文件**：
  * `src/app/workspace-journal.ts`（L8-15）
  * `src/app/store.ts`（L83-139）
  * `src/app/migration.ts`（`SCHEMA_VERSION`、`OLDEST_SCHEMA`）
  * `tests/migration.spec.ts`、`tests/workspace-journal.spec.ts`

---

## 一、 问题描述与根因分析

为未来受控工作区引用清理准备的持久化操作日志类 `WorkspaceRefJournal`（`src/app/workspace-journal.ts:8-15`）目前在构造函数中直接对传入的 `store.db` 执行建表语句：

```ts
export class WorkspaceRefJournal implements LocalRefCleanupJournal {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>, private readonly repositoryIdentity: string) {
    if (!repositoryIdentity.trim()) throw new Error('A verified repository identity is required')
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_ref_operation (
      id TEXT PRIMARY KEY, repository TEXT NOT NULL, ref TEXT NOT NULL, intent TEXT NOT NULL, result TEXT,
      UNIQUE(repository, ref));
      CREATE TABLE IF NOT EXISTS workspace_ref_event (
      seq INTEGER PRIMARY KEY, operation TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);`)
  }
```

虽然目前 `WorkspaceRefJournal` 仅在单元测试 `tests/workspace-journal.spec.ts` 中实例化（尚未接入 `Runtime` 或 `DshExecutor`），但这种绕过 `Store` 集中式 Schema 管理的写法在后续正式接入时会带来三个架构风险：

1. **破坏版本回滚安全栅栏（关键风险）**：
   * `Store` 在启动时依赖 `KV.store.schema`（当前 `SCHEMA_VERSION = 11`）拦截旧版二进制程序打开新版数据库（`if (version !== undefined && version > SCHEMA_VERSION) throw ...`，见 `src/app/store.ts:98` 与 `docs/006-deployment.md:461`）。
   * 如果某次版本升级接入了 `WorkspaceRefJournal` 并写入了未决的清理意图（`workspace_ref_operation.result IS NULL`），却没有递增 `SCHEMA_VERSION`，一旦管理员将代码回滚到同样 `SCHEMA_VERSION === 11` 的旧版本，**旧版本会毫无感知地打开该数据库，完全忽略 `workspace_ref_operation` 中处于 `unknown`/未决状态的引用操作栅栏**，违背 `docs/015-workspace-lifecycle.md` 第 27 行“阻止旧版二进制重放或误读新状态”的硬性要求。
2. **DDL 不在启动迁移事务内统一管理**：
   * `Store` 将所有核心表与索引创建包裹在启动期的单个原子迁移事务内（`src/app/store.ts:102-129`），而散落在业务组件构造函数中的隐式 `db.exec(CREATE TABLE ...)` 會在运行期隐式提交事务，若在 `store.atomic()` 内部首次构造还会干扰事务边界。
3. **缺少必要的查询索引**：
   * `workspace_ref_event` 按 `operation` 关联查询审计事件时，当前缺少 `CREATE INDEX IF NOT EXISTS workspace_ref_event_operation ON workspace_ref_event(operation, seq)`。

---

## 二、 具体修复方案

在正式将 `WorkspaceRefJournal` 接入生产执行链路时（或提前整理存储层时），执行以下规范化改造：

1. **将表与索引定义收归 `Store` 启动建表与迁移流程（`src/app/store.ts` & `src/app/migration.ts`）**：
   * 在正式启用受控清理状态前，将 `SCHEMA_VERSION` 递增（例如 `11 -> 12`），编写无损前向迁移函数 `migrateTo12`（保持 `OLDEST_SCHEMA = 10` 支持平滑升级），使得写入过新表的数据库一旦被旧版程序打开，立即触发 `Unsupported orchestrator database version 12` 安全拒绝。
   * 在 `Store` 的主 DDL 块中统一声明 `workspace_ref_operation`、`workspace_ref_event` 及索引 `workspace_ref_event_operation(operation, seq)`。
2. **在 `Store` 上提供类型安全的仓储访问器（如同 `store.watchdogRuns` / `store.tickets`）**：
   * `WorkspaceRefJournal` 通过 `Store` 暴露的预编译语句接口读写，不再直接暴露底层裸 `DatabaseSync`（`Pick<Store, 'db'>`）给上层调用者，也无需在构造函数中重复执行 `db.exec` DDL。

---

## 三、 验证与测试计划

1. **`tests/migration.spec.ts`**：
   * 验证从 schema 10 / 11 升级到新 schema 版本后，原有业务数据完整无损，且新表与索引均已就绪；
   * 验证低版本 Schema 校验器打开升级后的数据库时，准确抛出版本不兼容错误拒绝启动。
2. **`tests/workspace-journal.spec.ts`**：
   * 保持现有幂等写入、并发同仓库同引用互斥、状态未决拒绝覆盖及跨重启持久化测试全部通过。
