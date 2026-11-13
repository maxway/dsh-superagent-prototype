# 013 DSH 0.2.2 rc.1 / rc.2 子代理生命周期对照

状态：**历史调查与最小兼容候选，不是部署授权**。未检查生产进程、配置或实际部署版本。下文保留早期实验的调查过程供参考，其中实现与隔离描述属于已归档候选，并非当前工作树。

## 最小候选

当前候选保留 rc.1 原释放路径；rc.2 通过目录枚举后代，以祖先权限逐个中断子级，并在原有超时内等待树工作，不对可复用 worker root 执行 drain。根据用户明确选择，这只是尽力中断，**不等价于释放**：本地 activation 和待处理 inbox 可能保留并再次被唤醒，目录遗漏、并发创建及超时也可能留下运行中的工作。rc.2 目录枚举依赖 `sessionQuery` 和子代理目录投影；枚举失败会使停止报错。固定版本隔离合同使用真实运行时和内存替身，验证 rc.2 外部子级中断后可再次委派，以及 rc.1 等待和单独模拟的释放路径。尚未验证真实外部提供方、完整 profile、GUI 和崩溃恢复。本地基线 `9d817fa` 已移除自动工作树清理，未独立认证核验远端。早期实验性桥、隔离和回执实现保存在 Git stash 中，没有接入或包含在当前候选。

## 结论与范围

本项目 [package.json](../../package.json) 的 DSH `engines` 和 peer 使用 `^0.2.2-rc.1`，开发依赖固定 `0.2.2-rc.1`；本地安装的 subagent 包也是 rc.1。允许版本范围不等于已验证兼容。rc.2 的子代理归属从层层父子 activation 转为由树根统一持有，**中间创建者可先结算，后代继续运行**。本项目现有 Assignment 结束时只释放指定直接子代理、保留 worker 可复用的做法，在 rc.2 缺少原 API；直接换成整树 drain 又会封闭该 root 的后续子代理准入，不能作为无条件等价替代。

## 可追溯上游来源

- [rc.1 发布 tag 和源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1)（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`），[rc.1 subagent 包说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent/README.zh.md)，[rc.1 服务接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent/src/index.ts)。
- [rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)，[rc.2 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.2)（`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`），[两个 tag 差异](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.1...dsh-v0.2.2-rc.2)。
- [rc.2 subagent 包说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/subagent/subagent/README.zh.md)、[服务接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/subagent/subagent/src/index.ts)、[生命周期实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/subagent/subagent/src/manager.ts)。发布说明和包文档的层次不同，下面分别表述，不把源码观察冒充维护者动机。

## 上游事实：行为和接口

| 方面 | rc.1 | rc.2 |
| --- | --- | --- |
| 完成与所有权 | 本地 activation 自身活动、待处理输入 **及拥有的后代**结束后结算；释放该 activation 等待后代及资源，子级优先。 | 每个实例归同一在线树根持有；成员自身活动与待处理输入结束即可结算，**不等待或停止其创建的后代**。结构化结果也不再要求后代释放；依赖后代结果必须显式等待。 |
| 宿主等待 | `waitForChildren(parent)` 汇合后代推进中的工作和清理。 | `waitForTreeWork(root)` 汇合树内工作与清理；普通成员返回 false。两者均不把仅有停放 inbox 的空闲实例当作需等待的推进工作。 |
| 释放 | `drainChildren(parent, childIds)` 可释放选定直接子级而不关闭该父级其他准入；`drainDescendants` 关闭指定父级作用域。 | 服务接口不再提供 `drainChildren` 或 `listChildren`；`drainDescendants([root])` 关闭选定确切树根的准入并停止所有成员、等待启动和清理。该截止持续到该 root 离开 registry；普通成员不是树根，不能用作局部树 drain。 |
| 发现和通信 | `listChildren` 读直接子目录；`listDescendants` 递归发现。模型消息限定直接父子，冷恢复直接子级。 | `listDescendants` 递归发现；有同级唯一名称、根 `lead` 和斜杠路径。树中在线根或成员可联系其他可继续成员；只恢复目标，不恢复其创建祖先。目录是历史关系，不等于运行中的 Agent 列表。 |
| 通知与中断 | 父级投递提供结算通知；中断是发出信号，不等于收敛。 | 仅在直接创建者仍在线时向其发送完成通知，不冷恢复离线创建者；中断仍不是释放整棵树。生命周期事件按树根作用域分派而非创建父级；事件是观察接口，不是完成决策协议。 |
| 持久与外部执行 | 本地子级可继续，外部提供方一次执行；进程内 activation 与 inbox 不跨进程协调。 | 保留上述边界；目录 v3 写入名称，读取旧目录版本；外部执行仍不接受后续输入。已接受但未写入日志的消息崩溃后不会自动回放。 |

两版都将调用方信号限定于发布前工作；已发布执行的释放以 activation 的 `dispose()` 等机制为准。rc.2 的 `dispose()` 只停止该实例，不能假设递归终止后代。`interrupt` 保留本地 activation 和未领取 inbox，不能用作 Assignment 完成的清理证明。rc.2 清理失败会使 `dispose()` 拒绝、结束事件标记失败，但执行结果和父级通知可保留已捕获结果；不可把结果成功等同资源清理成功。

## 官方设计表述与推断

**有来源的官方表述：**rc.2 发布说明称支持具名、多层 SubAgent 协作；AgentTeam 改用统一具名子代理，中断工具默认关闭，自定义插件和 SDK 需迁移，共享会话存储的进程应同步升级。rc.2 包说明明确描述统一管理启动、消息准入、容量、运行归属与释放；兑现意味着已接受且句柄可取消；父级退出后后代独立运行，宿主释放根句柄前须 drain 整棵树。它还明确跨进程共享需要持久邮箱和租约协议，当前没有该协调能力。

**本报告推断，非官方声明：**树根所有权与跨同树消息、离线中间创建者的冷恢复共同支持多层协作，避免中间成员结算导致工作随之消失；但它把显式等待后代、结果汇总与根终止的责任推向宿主。具名目录改善寻址和发现，但目录、运行状态和授权必须分开判断。上游未在上述来源中明确说明移除 `drainChildren` 的全部取舍，也不能仅从名称变化推定安全性更好或向后兼容。

## 初次审查时的本项目代码路径与风险

1. [background.ts](../../src/executor/background.ts) 的 `childrenEnd` 选择 `waitForChildren ?? waitForTreeWork`，具备名称级回退；但旧/新等待的范围不同，仍须以真实 root、父级 idle、通知和 Session 序号验证。`untilQuiet` 不检查 Session 序号，而 rc.2 文档建议 headless 宿主交替等待并检查序号不变。存在完成通知竞争与提前释放 slot/报告等待状态的风险，需测试而非断言已复现。
2. 同一文件的 `stopSubagents` 必须同时存在 `listChildren`、`drainChildren` 才继续；rc.2 服务缺少这两个方法，服务存在时会抛出不支持错误，甚至在没有活动子级时也会先抛错。即使移除存在性检查，按 `ctx.agents.get` 筛选目录也不能识别外部执行，rc.2 还可能出现创建者已离线但后代仍运行的情况。目录遍历或只看直接子级不是完整的活动树释放协议。
3. [dsh.ts](../../src/executor/dsh.ts) 的 `stop`、`handOff`、同进程 `resume` 和 `shutdown` 依赖该清理；新 Assignment 的 `launch` 等待 `stopped`，但 `track` 对停止 promise 的拒绝做了吞并，错误另由后台 health 记录，不能视为已成功停止。初次审查时 `reclaim` 等待该跟踪后可进入工作树回收；当后台仍运行或停止失败时，存在与目录使用、后续任务和权限边界交错的风险。超时包装 `until` 返回 false 而非取消底层 promise；初版 `stopSubagents` 未检查该返回值，因此等待结束不证明 drain 完成。外部副作用亦不会因为取消而回滚。
4. [sessions.ts](../../src/app/sessions.ts) 在 `agent/created` 装饰子代理，`limitSubagent` 沿 `parentSession` 和当前 registry 中加载的父 Agent 向上寻找 worker，最多八层。rc.2 允许创建祖先离线并仅冷恢复目标，故可能无法通过此链找到 worker 并施加 `workOnly`；这是一条需要复现并封闭的授权风险，不是已证实生产漏洞。还需核对复用、恢复、深层以及外部后端的权限传播；外部后端保有自己的权限系统，不能仅靠本地 Agent hook 推断其安全性。
5. rc.2 的树级通信、名称、通知作用域、目录版本、默认中断工具及权限检查均可能改变模型体验和自定义集成；本项目工作工具白名单和实际 profile 应一并审查。单纯通过 semver、TypeScript 本地可选接口或 rc.1 mock 不能证明运行兼容。

## 已归档实现与验证

2026-11-13，根据操作员选择，兼容分支已变基到本地可用的 `origin/main` 快照 `9d817fa`；GitLab 远端需要认证，未使用凭据核验，因此不声称这是远端最新状态。该快照取消了已结束工单 worktree 及本地、远端分支的自动清理；候选保留这一行为，旧 cleanup effect 被消费但不删除任何内容。这消除了候选自身的自动删除竞争，但未消除子代理残留、保留工作区被并发使用、人工删除或外部副作用的风险。现有部署仍可能运行旧清理逻辑；前一节记录的是变基前的初次审查。

尚未接入的委派账本现在将每个代际绑定到 Assignment ID；桥拒绝其他 Assignment，准入在适配器验证 root 之后再次检查持久绑定。隔离 SQLite 测试验证了持久化以及缺少该字段的旧记录（包括 closed）会保守拒绝，当前没有自动迁移。该检查只是针对调用方提供身份的一致性校验，不是身份认证，也不是 Executor 恢复屏障；一个 Assignment 仍可能需要多个代际。

同进程恢复时，候选代码在取消前持久记录停止标记；如果取消抛错，它记录错误、仍尝试清理并继续处理后续 Ticket，即使清理或之后的停止成功也保留该标记。隔离回归测试验证了重新打开测试数据库后标记仍存在；这不能证明外部副作用或 GUI 活动已经停止。

兼容分支现在在等待后台工作时复查 worker 空闲状态和 Session 序号，将未完成的停止操作记录到数据库，并在停止失败或无法确认时阻止 Executor 的后续启动和投递。当存在子代理服务但缺少 rc.1 的可复用释放方法时，上述 Executor 操作会被拒绝；**这是有意暂不支持 rc.2 自动 worker 执行，而不是声称已兼容**。rc.1 清理现在将目录中所有外部子级 ID 及有本地 Agent 的子级 ID 交给 `drainChildren`，包括已结束的外部历史条目：上游实现会释放仍驻留的匹配 activation，对不再驻留的 ID 则不操作。目录不包含所有 caller 投递的外部执行，也不能覆盖创建中窗口；`listDescendants` 的 `activity` 依赖本地 Session，运行中的外部执行也可能显示 `inactive`，不能据此证明结束。清理失败后 activation 可能已从内部驻留表移除，因此再次 drain 的空操作不能证明先前清理成功。损坏、重复或不可读的停止记录同样会被保守视为隔离，进行中的停止在发现损坏记录时不会清除它；停止失败的 Ticket 可能无限期隔离，当前没有自动或面向操作员的解除隔离机制。

worker 祖先检查现在通过 Session 持久化只读离线祖先的 header。祖先缺失或不可读不能证明 Agent 与本项目无关：未解析的 Agent 仍不会受到本项目限制，外部后端也保有自己的权限系统。缺少 origin 的历史关系会被保守地视为可能的 worker 祖先关系。等待后台安静时会重新检查 worker 序号和其 shell job，但子代理或 job 的新准入与最终判断并非原子操作；停放 inbox 也可能在序号不变时存在。隔离只约束本 Executor 的路径，GUI 直接操作和检查前已接受的工作不在其范围内。所选主线不再自动回收已结束工单的 worktree 或分支，旧版 cleanup effect 是空操作。人工或外部删除和 Git 操作不受该保护约束，已开始的工作也不会被撤销。Executor 的停止等待超时不会取消底层操作；候选代码现在撤销停止令牌，并在异步目录读取和 drain 后、发起后续副作用前检查令牌及 Agent 身份，避免旧清理继续调用 cancel。已经开始的 drain、通知或外部副作用无法通过该令牌撤销。完整 Runtime 现在启动 Executor 的 worker 隔离及停止后，再等待主 Session 和其他活动；主 Session 取消异常不会跳过 worker 清理。若某个隔离标记无法持久写入，候选会跳过该 worker 的取消并报告失败，仍处理其他 worker，因此必须由操作员核查该 worker；主 Session 和 effect 的等待仍没有总时限；候选的 HTTP 请求关闭路径在停止失败时以非零退出码调用退出钩子，但退出码不能证明 GUI 或外部副作用已收敛。停止失败或超时后，不应在没有独立运维核查和明确恢复方案时清除标记或回收工作区。

2026-11-13，隔离测试使用真实 rc.1 和 rc.2 子代理运行时、内存父级与 mock 外部提供方，分别运行了本项目的 `untilQuiet`；rc.2 在缺少旧 API 时拒绝 `stopSubagents`，初版 rc.1 代码在外部目录条目没有本地 Agent、该子级仍运行时保守拒绝；后来根据上游源码改为将目录 ID 交给 `drainChildren`。后续在隔离夹具中用真实 rc.1 运行时和 mock 外部提供方验证：运行中的外部执行被中止并等待 dispose，历史目录 ID 可再次安全调用，dispose 抛错会传播；未覆盖真实外部进程、持久化或创建竞争。rc.2 测试还验证了上游 `drainDescendants` 会封闭确切根，而另一根仍可使用。最初的隔离夹具是临时文件。现已在 `contracts/subagent/` 另增独立锁定依赖的 rc.1 和 rc.2 合同测试，按需单独安装并运行，不属于默认测试集；两版测试均实例化各自固定版本的公开运行时，并在内存 SessionStore 与 mock 外部提供方下验证了真实 AgentRegistry 句柄的 drain 和注销；其他合同仍使用内存替身。测试未运行真实外部进程、模型、完整生产 profile 或跨进程恢复，不能证明完整兼容或可部署。

## 根句柄、收件箱和入口屏障的具体限制

rc.2 的 [`AgentRegistry.create/resume`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/core/agent/src/index.ts) 返回只有持有者能释放的 `AgentHandle`，`get` 只返回 Agent；而 [`SessionController` 内部创建和恢复](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/api/session-controller/src/agent.ts) 取出 `.agent`，没有将句柄交给本项目。现有 [sessions.ts](../../src/app/sessions.ts) 通过该控制器取得裸 Agent，不能从它反推出合法可释放的句柄。若自行持有句柄，必须从首次创建或恢复开始协调所有者，并防止控制器或 GUI 抢先恢复；还需恢复 preset、模型及工具限制。

正常 ready 的 root 释放时，上游 [`initializeAgent` teardown](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/core/agent-loop/src/index.ts) 使用 `keepInbox: !ready`，因此会清空待处理 inbox 并持久记录删除；事先以 `keepInbox: true` 取消也不改变后续 dispose 的行为。同 ID 恢复是重载持久 Session 和历史并创建新 Agent，不保证保留这些待处理输入，也不能保证已领取消息和外部副作用恰好执行一次。安全迁移需要上游提供保留 inbox 的释放契约，或在封锁所有入口后设计可崩溃恢复、去重的持久化交接，不能直接声称现有 dispose 可无损使用。

GUI 的 [`prompt`、`updateQueue`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/api/session-controller/src/commands.ts) 和 [`follow`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/api/session-controller/src/index.ts) 等路径可投递或恢复 Agent；只限制 Executor 或工具不能封住这些入口及已在途投递。[`remoteAccess` 策略](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/api/remote-access/src/index.ts)对 owner 直接放行，也不能作为 owner GUI 的屏障。完整方案需要覆盖 owner、最终入队及所有恢复路径的共享生命周期屏障，并验证在途操作；当前未发现等价的公开扩展点。特别是 `agent/created` 虽可异步等待，上游已先将 Agent 放入 registry，等待 listener 期间其他请求仍可取得它；`agent/inbox/spliced` 是提交后的通知，`agent/pre-step` 只约束执行步骤，`agent/pre-step` 执行前消息已经领取，拒绝不会自动重新入队；`runMaintenance` 期间新输入仍可进入 inbox。它们都不能代替入队前的全入口屏障。`drainDescendants` 本身会关闭该确切 root 的子代理准入并处理已在途的子级启动，但不覆盖普通 root 的 Session 投递或直接 Agent 输入；清理期间子级完成通知仍可能被注入 root。

## 本地独立委派 Root 的设计草案

已选择继续探索本项目内的委派架构，而不是假定上游会恢复旧接口。拟保留原 worker Session 及其 GUI、inbox 和历史，由项目独占持有单独的委派 root 句柄；一个委派代际结束时对其真实 root 调用 `drainDescendants`，确认成功后释放，下一次委派使用新 root。**这不是当前支持的运行模式。**目前仅实现尚未接入生产路径的版本协议适配器，以及接收现有句柄、仅在内存中管理准入和释放的代际原语；适配器要求显式协议版本并检查能力组合，通过两版真实运行时加内存替身的合同测试；接入时仍需可信的版本来源，方法形状本身不能证明实现版本。另有独立的实验性逐 Ticket 代际账本，可持久记录状态并拒绝未确认代际自动重开；实验性封装现已将传入句柄与账本代际绑定；入场失败即封闭本地入口并尝试标记未确认，关闭前先提交 closing 状态。它在账本写入失败或入场结果未确认时仍尝试清理，但不会据此解除隔离；入场等待超时后会尽力发起整树 drain，并对迟到的 activation 尝试单独 dispose；这些后台尝试不阻塞超时返回，也不证明其后代已停止。它尚未接入 Executor 或启动恢复，也不提供跨进程租约。实验性工厂现可先持久预留再调用注册表创建句柄，并在创建未确认时保留隔离；两版独立合同验证了真实注册表创建和释放句柄，但尚未验证真实持久 Session 恢复或 GUI 准入。工厂依赖调用者提供可信 setup 和目录限制；工具桥和消息桥尚未实现。一次 Assignment 中可能多次人工 handoff 和继续执行，因此代际不能简单等同 Assignment。

该设计必须先解决以下边界，才能解除 rc.2 运行时拒绝：

1. **入口和身份**：worker preset 自带原生子代理工具，当前 `restrict` 不屏蔽 Agent 本地工具。隔离合同使用两版真实工具注册表与执行管线、真实 Agent 和同名模拟工具验证：`restrict` 不能隐藏本地注册的工具，而该 Agent 的 guard 可以拒绝其新调用，且不影响另一 Agent；但在安装 guard 前已通过 prepare 的调用仍能执行；现有 guard 已安装、在 prepare 后 Ticket 状态从允许变为结束时，该调用也不再重新检查 guard，仍可执行。因此 guard 不能撤销已准入调用，本项目 `workOnly` 的动态 Ticket 检查不是与工具副作用原子绑定的屏障。另一个固定版本隔离合同 `contracts/native-tools/` 加载两版真实 `tool-subagent` 与 `tool-subagent-control`、真实工具管线和 Agent，但用计数替身代替子代理后端：验证原生委派调用可抵达替身、四个原生委派/控制工具的新调用可被 guard 拒绝，同时已 prepare 的原生委派调用仍可抵达替身。后续同一夹具又组合真实工具和对应版本的 `SubagentRuntime`、真实 Agent、内存 Session 与可控外部提供方：guard 改变前已 prepare 的工具调用确实创建第二个 activation；整树 drain 中止两次执行、等待提供方 dispose，完成后再调用原生工具会被拒绝。提供方仍是内存替身，未启动真实外部进程或模型，也未验证 GUI、完整 profile 或所有执行器；仍须封住 worker 的所有原生入口，包括旧 Session 和 GUI 驱动，并协调在途调用；每次桥接调用须以可信闭包绑定并校验确切 worker、Ticket、代际和权限，不能只把执行参数中的 Agent 改为 root。独立 root 不是 worker Session，其后代也没有 worker 祖先，现有祖先分类不会自动施加 Ticket 限制；必须建立可信归属并验证限制传播。实验性桥接准入原语已固定可信调用方提供的 worker、Ticket、Assignment、提供方和目录，在实际调用时、代际登记待处理准入之后，以及协议适配器完成自身 root 校验之后、调用上游启动之前同步检查 Session 身份、运行中 Assignment、停止标记和宿主关闭状态，并拒绝递归准入及异步最终检查；最终复核拒绝会保守隔离该代际，即使提供方尚未启动；它尚未注册为工具，也不封闭原生工具入口。两版隔离合同组合了桥接、真实 AgentRegistry 和真实子代理运行时，使用内存 Ticket/账本替身及受控外部提供方，验证拒绝错误调用者与停止标记、等待后端释放，并在同一 worker 上连续创建和关闭两个不同 root；扩展合同在独立临时工作目录中使用真实 SQLite Store、代际账本和结果回执，关闭并重开数据库后核对两代回执，以及 `creating`、`active`、`closing`、`unconfirmed` 均阻止新代际；上述状态由测试直接构造。另有隔离子进程合同：两版真实运行时在内存提供方结果未结算时由测试父进程终止其亲自创建的子进程；重开独立数据库后，代际仍为 `active`、回执不存在且新代际被拒绝。另一合同让内存提供方先返回完成结果，在捕获回调中人为暂停、提交回执之前终止子进程；两版重开数据库后均没有该回执且继续拒绝新代际，说明这一人为放大的窗口可能丢失已完成结果。此测试不能证明自然时序下的窗口长度、结果重放或外部副作用停止；Session 和外部提供方仍为内存夹具，也不是生产恢复演练，未验证消息消费。桥接自身的 close 会同步封口、复用同一个关闭 Promise，并等待此前已登记的代际准入；隔离测试覆盖了 worker 查询及 root 校验中重入该 close。它尚未与 Executor 的停止标记共享门，其他形式的同步重入或其他进程仍可能使状态在检查后变化；绝对目录和身份格式校验也不是权限或文件系统隔离。实验账本和结果日志统一拒绝空、过长或 Unicode 不完整的 Ticket 身份，但身份格式校验不是授权。
2. **工具协议**：rc.1 的子代理身份使用 ID，rc.2 使用树内名称和不同的 `list_agents`、`send_message`、`interrupt_agent` 参数。桥接必须明确模型看到的协议，校验跨树和跨 Ticket 地址，不将中断接纳误当作完成，也不能将目录 `inactive` 当作外部执行已停止。
3. **结果和通知**：独立 root 成为直接创建者后，子代理结果和消息到达 root，而不是 worker。需要可恢复的持久消息桥、去重和次序契约，覆盖 root 已停止、worker 已交接、停止失败及崩溃窗口；生命周期事件只是观察，不替代可靠交付或清理确认。实验性结果账本现在能按 Ticket、代际和 child 身份持久保存不可变结果并拒绝冲突；受控封装要求结果捕获回调，并在正常释放 root 前等待该回调。可选的账本适配器使用受限 JSON 快照，在构造完整快照及编码前累计检查转义后的 UTF-8 字节预算，并拒绝无法无损表示的结果；拒绝的 Promise 只记录不含原始错误的状态。这不是对恶意同进程代码或代理对象的沙箱。当前这些组件仅在隔离测试中组合，尚未连接 Executor、投递或消费确认；只允许当前未关闭代际写入新记录，旧代迟到且未记录的结果会被拒绝。caller result 被项目持久捕获之前进程崩溃，当前没有已验证的上游结果重放接口；消息 flush 也只确认写盘接受，不能证明 worker 已消费。代际关闭现会核验其直接持有的 activation 释放结果，但这不证明未持有的后代或外部副作用已安全结束。
4. **资源与权限**：必须从 root 创建时持有公开 `AgentHandle`，对其应用不高于 Ticket 的权限与工作目录限制，并确保子级无法绕过；root 的来源、GUI 展示与人工操作如何映射也须设计。关闭 root 的全部启动、停止、超时、清理失败和恢复路径都须保留持久隔离。
5. **兼容验收**：真实 rc.1/rc.2 分别覆盖创建、消息、后代、外部提供方、同 Assignment 的多次 handoff、GUI 访问、进程恢复和 inbox；验证用户可见行为变化，并在独立非生产环境中测试。当前等待、停止和 mock 外部提供方合同测试不足以证明以上保证。

## 可行迁移方向（均需设计和验证）

- **暂缓升级 / 明确限制运行时**：在隔离候选环境验证前保持已知 rc.1 组合，评估收紧引擎/依赖或运行时能力检查；这只是风险控制，不意味着当前发布或生产状态已被核实。
- **请求上游可复用根的 scoped release 能力**：寻求明确的、可等待完成且覆盖正在启动、本地及外部后代的 Assignment 级清理/准入屏障；完成后重新开放或提供 generation 语义。不要通过调用私有 manager、手工枚举后逐个 interrupt，或假设 drain 超时即成功来模拟它。
- **重新定义 worker 句柄生命周期**：可探索 Assignment 结束先停止所有新输入、对根做 `drainDescendants` 并确认清理成功，然后释放原 root 的 Agent 句柄；后续 Assignment 从持久 Session 重新物化一个新的确切 root，并恢复工具限制与 inbox。此方案必须先证明本项目 Sessions 所有权、句柄释放/重建 API、事件与输入顺序、冷恢复和权限能安全支持；不能只给同一个 root 调用 drain 后继续使用它。人类 handoff、关机、失败和重试也需要分别设计。
- **继续研究替代隔离模型**：例如每 Assignment 独立根并明确跨 Assignment 上下文恢复，或通过受控适配层管理独立持有的 activation；这会改变 Session 连续性及调用方归属，不能默认为低成本方案。任何方案都应失败即阻止重新启动及工作树回收，区分超时、未确认、成功和部分失败，并提供操作员可见的恢复路径。

建议的验收覆盖：真实 rc.1/rc.2 依赖矩阵；直接子级、孙级、外部执行、中间创建者提前退出和冷恢复；父级运行/空闲、停放 inbox、通知及 Session 序号竞争；创建中 drain、并发新输入、取消、超时及释放失败；Assignment 结束后新 Assignment 能委派、权限仍受 Ticket 约束；后台停止未确认时不得回收 worktree；重启 inbox、重复消息和外部副作用；不同版本共享存储、回滚与失败恢复。测试应在独立非生产 profile、DSH home、状态库、端口、凭据及测试仓库运行，不启用生产飞书；工作树本身不是进程或凭据隔离。

## 未解决问题

1. 上游是否计划提供不永久封闭 root 的、覆盖完整树的公开 release API 或可重开的 generation？若无，重建根的正式宿主契约是什么？
2. 本项目能否释放并从同一 Session 安全重建 Agent，同时保持已领取/未领取输入、限制、事件顺序和历史？各失败点如何恢复而不重复外部操作？
3. 如何以持久、不可伪造的根归属建立 worker Ticket 授权，尤其对祖先离线、深层、跨后端和恢复路径？外部执行的权限与停止如何证实？
4. 等待、停放 inbox、停止失败和超时的服务级目标、告警、隔离和人工处置是什么？worktree 回收如何与这些状态建立可靠屏障？
5. 已有历史 Session/目录与 rc.2 新写入的兼容及回滚如何验证？共享存储的所有进程如何协调升级并避免并发所有权？官方要求同步升级并不提供跨进程租约。
