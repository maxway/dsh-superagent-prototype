# 04 [P1] `Sessions` 类型签名遗漏 `tier` 且恢复 Session 时丢失提示词变量同步钩子

* **优先级**：P1（中优 — 关系模型档位选择类型安全与进程重启前后系统提示词变量一致性）
* **涉及文件**：
  * `src/app/sessions.ts`（`ensure` L145、`existing` L163、`initialize` L178）
  * `src/app/role-models.ts`（`workerModel` L9、`initializeRoleModel` L27-38）
  * `tests/role-models.spec.ts`

---

## 一、 问题描述与根因分析

### 问题 A：`Sessions.ensure` / `existing` / `initialize` 参数类型漏掉 `tier`

1. 引入三档执行模型后，`src/app/role-models.ts:9` 中的 `workerModel` 已更新为：
   ```ts
   export function workerModel(settings: Settings, ticket: Pick<Ticket, 'category' | 'mandate' | 'tier'>): RoleModel | null {
     return ticket.tier ? settings.executor.tierModels[ticket.tier] ?? settings.executor.model
       : settings.executor.models[ticketCategory(ticket)] ?? settings.executor.model
   }
   ```
2. 但 `src/app/sessions.ts` 中三个入口的参数类型仍停留在旧版签名：
   ```ts
   async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Pick<Ticket, 'category' | 'mandate'>, createOnly = false): Promise<Agent>
   async existing(id: string, title: string, role: 'orchestrator' | 'worker', expected: Agent, ticket?: Pick<Ticket, 'category' | 'mandate'>): Promise<Agent>
   private async initialize(agent: Agent, title: string, role: 'orchestrator' | 'worker', ticket?: Pick<Ticket, 'category' | 'mandate'>, check: () => void = () => {}): Promise<void>
   ```
3. **为什么 TypeScript 没报错？** 因为 `Ticket['tier']` 在领域模型中是可选属性（`tier?: Tier`，兼容历史无档位工单），所以 `Pick<Ticket, 'category' | 'mandate'>` 在结构化子类型系统下可合法赋值给 `Pick<Ticket, 'category' | 'mandate' | 'tier'>`。
4. **风险**：目前仅因 `DshExecutor` 在运行时恰好传入了完整的 `Ticket` 实例而未触发运行时错误。一旦后续重构、新调用点或测试按函数签名构造 `{ category, mandate }` 对象传入，`ticket.tier` 将变为 `undefined`，导致 `low` / `high` / `expert` 三档路由配置静默失效并回退到废弃的 `category` 模型。

### 问题 B：`initializeRoleModel` 在恢复已有 Session 时提前返回，未挂载 `system-prompt/assemble` 钩子

查看 `src/app/role-models.ts:27-38`：
```ts
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model)
  agent.model.select(selected)
  agent.ctx.effect(() => agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const current = agent.model.current()
    const assembled = await next()
    return current === undefined ? assembled : { ...assembled, variables: { ...assembled.variables, provider: current.provider, model: current.model } }
  }, { prepend: true }))
  await ctx.sessionPersistence.flush()
}
```
存在两个边界缺陷：
1. **重启恢复后行为不一致**：当进程重启后通过 `Sessions.existing()` 重新初始化一个已有历史 `model/selection` 事件或 `requestHeader()` 的 `Agent` 时，第 29 行直接 `return`（正确跳过了 `agent.model.select`，保留已有持久化模型选择），但**也一并跳过了第 32-36 行的 `system-prompt/assemble` 钩子注册**。新创建的 `Agent` 有该钩子同步 `{{provider}}` 与 `{{model}}` 模板变量，重启恢复后的 `Agent` 却没有。
2. **无配置默认模型时同样跳过钩子**：若管理员将 `settings.executor.model` / `tierModels` 留为 `null`（使用 DSH 全局默认模型），第 28 行 `if (!model) return` 也会跳过该钩子。
3. **重复初始化幂等性**：`Sessions.existing()` 会在每次投递（`deliverQueued`）或重试（`resumeAfter`）时对同一个存活 `agent` 调用 `initialize()`。若将钩子提取出来，必须用 `WeakSet<Agent>`（或归入 `Sessions.decorateOnce` 的 `binding.disposers`）保证每个 `Agent` 实例**只注册一次**，避免每次投递消息叠加一层中间件造成内存泄漏。

---

## 二、 具体修复方案

### 1. 补齐 `Sessions` 的 `Ticket` 类型约束（`src/app/sessions.ts`）

定义统一类型别名并应用于 `ensure`、`existing` 与 `initialize`：
```ts
export type SessionTicket = Pick<Ticket, 'category' | 'mandate' | 'tier'>
```
将三处 `ticket?: Pick<Ticket, 'category' | 'mandate'>` 全部更新为 `ticket?: SessionTicket`。

### 2. 解耦“首次模型写入”与“提示词变量同步钩子”（`src/app/role-models.ts` / `src/app/sessions.ts`）

有两种等价且干净的收敛方式（推荐方案 1）：

* **方案 1（推荐 — 移入 `Sessions.decorateOnce` 统一生命周期管理）**：
  * `Sessions.decorateOnce(agent)` 本身就通过 `this.bindings` 保证了每个 `Agent` 实例在整个存活期内严格只装饰一次，且在 `agent/disposed` 或 `Sessions.dispose()` 时统一通过 `binding.disposers` 逆序释放！
  * 将 `agent.ctx.on('system-prompt/assemble', ...)` 注册进 `decorateOnce` 的 `binding.disposers` 中，则无论是首次创建、进程重启后恢复、还是 `model === null` 的会话，都拥有完全一致且可释放的变量同步钩子。
  * `initializeRoleModel` 专注职责：仅在 `model !== null` 且会话尚无历史请求/模型选择时，执行 `resolveRoleModel` → `agent.model.select` → `flush`。
* **方案 2（在 `role-models.ts` 内用 `WeakSet<Agent>` 去重）**：
  * 在 `initializeRoleModel` 顶部用 `const hooked = new WeakSet<Agent>()` 确保对每个 `agent` 注册一次 `system-prompt/assemble`（位于 `if (!model) return` 和历史事件判断之前）。

---

## 三、 验证与测试计划

1. **类型与单元测试（`tests/role-models.spec.ts`）**：
   * 验证 `low` / `high` / `expert` 工单通过 `Sessions.ensure` 创建时正确选中对应 `tierModels`。
   * 模拟进程重启（创建携带历史 `model/selection` 事件的新 `Agent` 实例并调用 `Sessions.existing`），验证：
     1. 不会覆盖用户已在会话中手动切换的模型；
     2. `system-prompt/assemble` 钩子依然生效，`variables.provider` 与 `variables.model` 与 `agent.model.current()` 保持同步；
     3. 对同一 `Agent` 连续多次调用 `Sessions.existing` 不会重复叠加 `system-prompt/assemble` 监听器。
