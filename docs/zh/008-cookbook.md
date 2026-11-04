# 008 实操手册

[English](../008-cookbook.md) | **简体中文**

本实操手册展示如何扩展 dsh-superagent。它使用 [001 领域模型](001-domain.md) 和 [002 授权机制](002-authorization.md) 中的术语，以及 [007 架构](007-architecture.md) 中的组件。

## 添加来源

本节实现一个名为 `webhook` 的来源（Source）类型。它通过一个虚构的 CLI `hookq` 读取一个虚构的消息队列，并把消息转换成触发（Trigger）。其他所有接口都属于 dsh-superagent。

这个实现有四项职责：转换事件、定义接收与授权规则、提供回复与上下文，以及维护轮询循环。编号步骤按顺序构建这些部分。

示例假定如下 CLI 约定：

- `hookq pull --after <n> --json` 打印位置 `n` 之后的消息，最旧的在前：`{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`。一个条目包含 `id`、`conversation`、`thread`（开启该线程的消息 id，在该消息本身上缺省）、带 `id` 和 `bot` 的 `sender`、`mentions_me`、`text`、`at` 和 `url`。
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` 在某条消息下回复，每个 key 只回复一次。对于已被删除的对话，它会在标准错误上以 `{"error": {"code": 410, "message": "…"}}` 失败。
- `hookq thread --conversation <id> --root <message id> --json` 打印线程的一页，最旧的在前，可用 `--after <cursor>` 取后续页：`{"items": […], "next": "<cursor>"}`，最后一页没有 `next`。

参照 `src/sources/github.ts`，把该类型及其插件入口放在 `src/sources/webhook.ts` 中。如果这个来源变大，就像飞书来源那样，把转换、渠道（Channel）与轮询代码拆到独立模块中。

### 1. 把事件映射到领域模型

在写代码之前先选定稳定的映射。触发 id、线程（Thread）id 和渠道地址都会被持久化，所以以后再改动它们会断开已有的记录。

| 概念 | 对 webhook 队列而言 |
| --- | --- |
| 触发 | 一条消息 |
| 线程 | 一条消息及同一对话中对它的回复：`<conversation>:<id of the first message>` |
| 发起者（Actor） | 发送者在队列上的 id，即允许名单命名它的方式 |
| 渠道地址 | 回复所在的对话与消息 |
| 接收范围 | 一个对话，在准入表中有自己的一行 |

### 2. 配置：schema、fields、facts 和 health

模块导入后续步骤用到的东西：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find, scope, channel, threadContext, policy and environment follow in the next steps.
}
```

- `kind` 是稳定的来源 id。它出现在触发的 `source`、线程键前缀、`source:webhook` 设置块和来源策略中。
- `schema` 校验存储的配置并提供默认值。在运营者保存实例之前，注册表会用这些默认值创建一个已启用的实例。让默认值什么都不接收；本示例默认不包含任何对话。
- `fields` 无需自定义面板代码就生成来源设置表单。`rows` 字段编辑以其第一列为键的条目；`advanced` 隐藏不常用的设置。如果来源能把 id 解析为显示名，就实现 `refreshLabels`。把这些名字保存在 `KV.sources.labels(kind)` 下。之后带 `choose` 和 `refresh` 的列就可以提供它们。
- 可选的 `facts(deployment)` 显示由安装配置（setup）推导出的值，例如某个 CLI 背后的账号。安装配置目前只检查 `SETUP_FIELDS` 中列出的 GitHub 和飞书字段，因此本示例不提供 facts。
- `health` 声明来源的健康条目，初始为 `starting`。注册会占用每个名字，并拒绝与 `runtime`、`reply`、`worker` 或 effect 类型等条目冲突。使用该类型的名字，并把 `sync:<id>` 留给策略同步。`error` 会让状态脚本以退出码 2 结束，并让每小时检查通知运营者，所以只在可能需要人工操作时才报告它。

### 3. 把消息转换成触发

在转换之前先校验 CLI 的响应：

```ts
/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** The Trigger of one queue message; the agent's own messages produce none. */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **稳定的 id。** 通过 `key` 从队列 id 推导触发 id。`Engine.receive` 对已存储的 id 返回 `duplicate`，而重复接单只会创建一个工单。因此重读消息是安全的。若要把编辑视为新事件，就在 id 中包含编辑版本，GitHub 对评论就是这样使用 `updated_at` 的。
- **线程。** 第一个线程是主线程，拥有评估。额外的线程增加关联（Correlation）上下文。id 由来源选择；它的完整键是 `webhook:<id>`。
- **发送者。** 在 `actor` 中使用来源原生的 id。对机器人和 CI 设置 `human: false`。名单上的机器人只能成为推断出的候选。空的 actor id（如 CI）使用未列出、未被点名发送者的准入单元。只有当消息确实面向智能体时，才把 `addressed` 设为 `mention` 或 `direct`；这会让允许名单上的人的消息具有显式强度。绝不为智能体自己的消息生成触发。
- **回复目的地与元数据。** `channel` 标明回复的去处；`url` 链接到来源消息。`channel.thread` 把消息分组以实现有序投递：工单中较晚的消息会排在较早的消息之后等待，直到较早的消息失败三次。其他工单不等待。把来源特有的字段放进 `meta`，例如接收对话和线程根。`meta` 和 `text` 都是不可信数据，不是授权。

智能体可以通过 `orchestrator_read trigger/<id>` 和 `thread/<key>` 读取新类型。它们会给出消息文本、去向和相邻的触发。新类型不会自动获得内置技能、原始服务记录的资源或 pull request 绑定。

文本搜索无需额外代码即可工作。当人们使用消息 id、URL 或 `#12` 这类来源特有的引用时，实现 `find(query)`。返回这些引用所指向的线程键和搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

这里，查询中的队列消息 id（例如 `m42`）会据此搜索触发。

### 4. 来源接收什么：范围

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

每次有触发进入时，Engine 都会通过 `SourceRegistry` 调用 `scope`。范围之外的消息会连同原因一起存为 filtered，且不创建线程。把消息传给 `receive`，而不是在轮询循环里静默丢弃它们，这样面板才能解释过滤。

`observed: true` 表示来源在该范围内接收未被点名的消息，从而允许对它们做出准入表决定。`row` 标识对应的准入行。

重新校验会用授权中存储的元数据调用 `scope`。让它只依赖 `meta` 和配置。恢复需要 `listened`，而不是 `observed`。没有 `scope` 时，类型会接收它产生的每个触发，但不观察任何触发。

### 5. 回复：渠道

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **幂等发送。** Outbox 调用 `SourceRegistry.send`，后者调用 `channel.send`。来源插件卸载期间，消息会等待。发送可能在远端服务已收到之后才失败，因此重试绝不能重复消息。用 `message.id` 作为幂等键：`hookq` 支持 `--key`；GitHub 会存储一个隐藏的评论标记；飞书接受幂等键。
- **永久失败与可重试失败。** 成功时返回 `sent`，只在投递永久不可能时（例如示例中的 410）返回 `gone`。gone 的消息会保留为无需处理，且不再入队；它出现在 `GET sources` 和来源页面上。其他失败就抛出，让 Outbox 在 5 秒后重试，并以倍数增长到 300 秒。`CliError.code` 是 CLI 输出报告的 code。
- **允许的目的地。** `allowed(address, config)` 只检查保存的地址和当前配置。把每个必需的事实都放进地址；例如，飞书会记录该会话是否为一对一。不再被监听的目的地会被置为无需处理，而停用的来源会让消息继续等待。没有 `allowed` 时，只要来源启用，所有地址都被允许。
- **链接。** `link(address, links)` 返回面板通过 `SourceRegistry.link` 显示的 URL 和标签。

### 6. 用于研判的线程上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动研判需要触发周围的对话。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 展开分页、根消息或父消息。实现可选的 `threadContext` 接口来提供这些读取：

- `read(commands, trigger, part, cursor, config)` 返回一个 `ContextPart`。它的 `messages` 使用 `ContextMessage`：`{id, from, at, text}` 加上适用的 `bot`、`deleted`、`reply_to`、`url`、`path` 和 `line` 字段。最后一页省略 `next`。`body` 是展示给研判 Session 的内容，这里是同一批消息。可选的 `status` 可以描述特殊结果，例如回退的读取模式。`part` 是 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 在其中找到触发自己的消息。
- `images(text)` 和 `image(…)` 用于消息带图片的类型；本示例省略了它们。

没有 `threadContext` 的类型不会给研判提供线程上下文；触发自己的文本仍然可读。

如果消息回复了更早的消息，就添加 `repliesTo(trigger)`。它返回对应的触发 id，让跟进通知和执行器（worker）的输入在已存储时显示被回复的消息。例如，如果 `hookq` 提供 `reply_to`，而转换把它存为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁可以提问：来源在策略中的部分

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` 校验来源策略，包括 `allowed` 发送者 id。id 比较不区分大小写。准入表单独校验，并在各类型间共享。这部分策略保存在 `policy.sources.webhook`，并计入策略版本。
- `fields` 在 **评估 → 每个来源** 下生成表单，从 `allowed` 开始。`explicit` 解释如何点名智能体。可选的 `unnamed: {person, bot}` 为飞书 `ou_…` 这类不透明 id 提供显示标签；本示例省略了它，因为队列 id 本身就是可读的名字。
- `rows(config)` 列出准入范围及其可用的单元。每个行 id 必须与 `scope` 返回的 `row` 匹配。未被点名消息的单元只在来源观察这些消息的地方可用。没有 `rows` 的类型使用默认单元。
- 可选的 `bots` 列出有资格成为推断候选的机器人，条目形状与 `allowed` 相同。没有它，任何机器人都不被准入。
- 可选的 `sync: {label, ready(part), run(host, part, signal)}` 在启动时以及 **Sync now** 时刷新成员关系。失败会出现在 `sync:<id>` 下，并在一分钟后重试，以倍数增长到一小时，直到成功。

### 8. 给执行器的变量

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

执行设置会在准备命令旁显示声明的 `variables`，即使来源已停用。启用时，`values` 用部署、配置和发起该工作的触发来提供工单特定的值。

准备命令读取环境变量；执行器（worker）在其指令中读取它们的值。使用 `DSH_SUPERAGENT_<KIND>_…` 前缀，对来自其他来源的工单返回空值，且绝不包含凭据。

### 9. 插件入口及其循环

```ts
export const name = 'dsh-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

插件注入 `orchestrator`。第一个 effect 注册该类型，并在释放时取消注册。第二个用 `SourceContext` 运行轮询循环。释放会中止循环并等待其完成，包括在应用停止或重启期间。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```


- **安装配置与开关。** 等待 `ctx.ready`，并在 `ctx.configured()` 为 false 时不读取任何东西。每轮都读取 `ctx.config(kind)`：来源关闭时它是 undefined。
- **游标。** 用 `KV`（`src/kv.ts`）中的类型化条目把读取位置存进 `ctx.state`，例如 `webhook: {cursor: record<number>('webhook-cursor')}`。`tests/store.spec.ts` 要求键字面量只出现在该注册表中。外部包可以用导出的 `record` 和 `family` 定义键。把值设为 `undefined` 会移除记录；`ctx.atomic` 把多次写入归入一个事务。

  只有每个覆盖到的触发都已存储之后，才推进游标。被中断的一轮会让游标保持不变；稳定的 id 让重放安全。对于时间戳游标，`src/sources/poll.ts` 中的 `cursorAt(started)` 会减去五秒，以容许远端迟到的写入。
- **线程元数据。** 接收触发之后，调用 `ctx.threads.describe(key, {label, url, facts})` 来填充它的显示信息。`ctx.threads.patch(key, meta)` 委托给 `threads.patchMeta`，设置来源拥有的键，或在值为 `undefined` 时移除它们。两者都会忽略不存在的线程，包括被过滤触发的线程。
- **逐项错误。** 统计格式错误的条目并继续，而不是让整批失败。`src/infra/commands.ts` 中的 `validItems(item, list, tally)` 支持这种模式。对于独立轮询的线程，使用 `src/sources/poll.ts` 中的 `pollThreads`；它把每次失败记为 `pollError`。它的 `polled` 谓词保留活跃订阅，以及最后一个触发与工单结束两者中较晚者之后的两周窗口。
- **健康。** 只通过 `ctx.report` 写已声明的条目。`health(state, code, values)` 提供固定消息，例如 `setupPending`、`sourceOff` 和 `pollFailures`。在报告 `error` 之前先累计连续失败次数。
- **中止。** 把 signal 传给 `ctx.commands.withSignal(signal)` 和 `delay`，并在条目之间检查它，这样停止或重启会立刻结束循环。

本示例不发送来源发起的通知。需要它们的来源调用 `ctx.notify`；Outbox 会像其他回复一样投递它们。

它也不把线程绑定到工单完成。只有当来源的线程生命周期决定工作是否完成时（例如 GitHub pull request 那样），才使用 `ctx.tickets.bindThread` 和 `threadClosed`。工单何时结束仍由 Engine 决定。

### 10. 注册插件

在 `tsdown.config.ts` 中把该模块构建为独立入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

然后在 `package.json` 的 `exports` 中加入 `"./webhook-watch": "./lib/webhook-watch.js"` 以导出构建产物，并把插件以停用状态加入 bundle 的 `cordis.patch.yml` 的 `insert` 列表，就像飞书那样：

```yaml
    - id: dsh-superagent-webhook
      name: dsh-superagent/webhook-watch
      disabled: true
```

在某个 profile 的 `cordis.patch.yml` 中用 `id: dsh-superagent-webhook` 和 `disabled: false` 启用插件。构建并重启。新的来源会出现在来源设置中，以及 **评估 → 每个来源** 下。

把它的模块和 spec 加入 [007 架构](007-architecture.md) 的模块表和测试表。`tests/docs.spec.ts` 检查这两个索引是否完整。

### 11. 测试

参照 `tests/sources.spec.ts` 的模式创建 `tests/webhook.spec.ts`：临时目录中的真实 Store、带 `HealthBoard` 的 `SourceRegistry`、带替身端口的 Engine，以及来自 `sourceContextOf` 的 `SourceContext`。

通过监视 `Commands.run` 来模拟 CLI 调用。也要监视 `withSignal`，因为它通常会返回一个新的 `Commands` 实例。

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // The registry claims the kind's health entries on the board, where the test reads them.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notices go to the outbox, which keeps their receipts and sends nothing here.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** The queue as `hookq` answers it. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // An allowed sender who mentions the agent makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构建一个队列条目。至少覆盖：

- 转换：稳定的 id、线程、发起者、`human` 与 `addressed`，以及智能体自己的消息不产生触发；
- 一轮：触发只存储一次、范围外的一条为 `filtered`、游标推进到它们之后、允许发送者的提及被研判为 `explicit`；
- 被中断的一轮，它保留自己的游标；
- `send`：`sent`、仅对 410 返回 `gone`，其他失败抛出，CLI 的错误由 `commandError` 构建；
- 线程上下文：一页的消息和下一页的游标，正如 `tests/registry.spec.ts` 通过 `SourceRegistry.threadContext` 读取某个类型的线程；
- 插件：`apply` 注册该类型，并在安装配置等待时报告 `setupPending`，它的 disposer 取消注册该类型，而逃出循环的失败会成为来源的健康信息，而不是未处理的 rejection；
- 来源在策略中的部分及其准入行，正如 `tests/registry.spec.ts` 和 `tests/policy.spec.ts` 检查飞书来源的那样。

### 检查清单

1. 映射触发、线程、发起者、渠道地址和接收范围。
2. 编写类型：`schema`、`fields`、`health`，以及安装配置推导出内容时的 `facts`。
3. 把事件转换成带稳定 id 的触发，并丢弃智能体自己的消息。
4. 在 `scope` 中仅根据 `meta` 决定来源接收什么。
5. 给它一个渠道，其 `send` 让每条消息只投递一次，并且只在对话永远无法接收时回答 `gone`。
6. 如果它能读取线程，就给研判提供它的线程上下文。
7. 给它一部分策略，包含 `allowed` 和准入行。
8. 注册它的执行环境变量。
9. 编写插件入口和一个循环：等待安装配置、跟随开关、在 `receive` 之后推进游标、按条目保留错误、报告健康并在中止时停止；在 `KV` 中命名游标。
10. 添加构建入口、导出和 `cordis.patch.yml` 插入项，并在 007 的表中列出该模块及其 spec。
11. 像 `tests/sources.spec.ts` 测试其他来源那样测试它。
