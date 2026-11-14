# 02 [P0] 目录物理身份比较的未知态保守语义与工单交接（Handoff）工作区物理分离校验

* **优先级**：P0（高优 — 直接关系工单恢复安全边界、交接前后新旧工作区物理隔离与 Windows `PATH` 垫片剥离）
* **涉及文件**：
  * `src/infra/environment.ts`（`sameDirectory` L51-54、`withoutDirectory` L55-57）
  * `src/core/part.ts`（`EngineOptions` 端口签名 L15）
  * `src/core/tickets.ts`（`Tickets.handoff` L212-263）
  * `src/app/runtime.ts`（`Engine` 端口接线 L142-148）
  * `src/executor/dsh.ts`（`prepare` L280-288、`checkWorkspace` L289-368、`reclaim` L952）
  * `src/executor/workspace.ts`（`reclaimWorkspace` L60-72）
  * `src/executor/provenance.ts`（`pathIdentity` L36-39）
  * `tests/environment.spec.ts`、`tests/tickets.spec.ts`、`tests/workspace.spec.ts`、`tests/runtime.spec.ts`

---

## 一、 问题描述与根因分析

对**已存在目录**通过文件系统物理身份（`stat` 的 `dev + ino` 配合 `realpathSync.native`）判定是否为同一目录没有争议——该方式能由操作系统内核统一处理 Windows 盘符大小写、正反斜杠、8.3 短文件名、符号链接（Symlink）、NTFS 目录联接点（Junction）以及按目录开启的大小写敏感属性（`fsutil.exe file setCaseSensitiveInfo`）。

真正的架构漏洞集中在以下两个核心问题：**（1）当路径不存在或文件系统身份不可验证时，不同业务场景的保守失败（Fail-closed）方向截然相反，不能混用更不能盲目转小写；** **（2）工单交接（Handoff）的工作区分离校验目前停留在核心层纯字符串比较，且执行器首次准备阶段漏检了顶层符号链接 / Junction，无法保证新旧工作区物理分离。**

### 1. 文件系统身份不可验证时，两类调用方的保守方向完全相反（`src/infra/environment.ts:51-54`）

当前 `sameDirectory` 实现：
```ts
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
```
该函数同时服务于两类安全目标完全相反的调用方：

1. **等价性证明场景（工单恢复校验：`src/executor/dsh.ts:297, 303, 351, 353`）——必须证明“确系同一物理目录”，假阳性（误判相同）是致命风险**：
   * 当路径不存在（`ENOENT`）、无权限（`EACCES`）或底层文件系统无法返回有效身份时，当前回退到 `resolve(path)`；若为了兼容 Windows 盘符大小写而将不存在的路径统一 `.toLowerCase()`，则会引入更严重的安全漏洞：在开启了目录级大小写敏感的 NTFS 目录（如 WSL 互操作目录或显式开启 `setCaseSensitiveInfo` 的工作树根目录）或挂载的区分大小写卷中，`Work/A` 与 `Work/a` 是两个完全不同的目录。一旦原目录 `Work/A` 缺失或不可读，小写折叠会让 `Work/A` 与 `Work/a` 误判相等，导致恢复校验被绕过。
   * 因此，在“证明同一目录”场景下，**只要任一路径不存在或物理身份不可验证，唯一安全的保守结论只能是 `false`（拒绝认定相同）**。
   * *注：唯一尚未落盘的前置步骤是 `checkWorkspace` L303 在 `allowPrepare === true && claim?.state === 'new'` 执行 `prepareDirectory` 之前——此时校验的是数据库里的 `claim.directory` 与 `ticket.execution.directory` 记录是否被篡改，应使用严格字节相等 `claim.directory === directory`（零大小写折叠），并在 `prepareDirectory` 创建目录后立即落盘和核验真实物理身份。*
2. **潜在别名剔除场景（`withoutDirectory` 剥离 Worker 禁用垫片目录：`src/app/setup.ts:64`、`src/deployment.ts:101, 119`）——必须剔除“可能指向同一位置”的路径，假阴性（漏删）是风险**：
   * `Setup` 构造阶段 `worker-bin` 目录可能尚未创建落盘，而系统 `PATH` 中可能已存在盘符或目录名大小写不一致的同位置条目（如 `f:\state\worker-bin\` vs `F:\state\worker-bin`）。此处若因目录尚不存在而返回“不相同”，会导致禁用垫片目录逃逸留在被测 `PATH` 中。
   * 因此，在“剔除潜在别名”场景下，当末级目录尚不存在时，应基于最近已存在祖先目录的真实物理身份判断：同一物理父目录下在 Windows 上大小写碰撞的未创建子路径（或祖先身份本身不可验证的可疑条目），应保守视为潜在别名予以剔除。

### 2. 交接（Handoff）工作区分离校验不触碰文件系统，且首次准备漏检顶层软链 / Junction

1. **核心层纯字符串比较无法识别软链、Junction 与目录嵌套（`src/core/tickets.ts:212-263`）**：
   * 当前 `Tickets.handoff` L213 仅检查：
     ```ts
     if (!prepared?.execution?.directory || old.execution?.directory === prepared.execution.directory) {
       throw new Error('Handoff requires a separately prepared ticket workspace')
     }
     ```
   * 一旦通过 L213，同一同步事务后续代码（L242-262）会**不可逆地将旧工单 `old` 标记为 `ended`、迁移所有 Thread 订阅并触发 `executor.stop(old)`**。
   * 纯字符串规范化（无论是否处理大小写或斜杠）位于不触碰文件系统的纯内存层，根本无法识别**符号链接（Symlink）、NTFS 目录联接点（Junction）、父目录软链/Junction 折射，以及新旧工作区父子目录嵌套（如新目录位于旧工作区子目录内或反之）**。
2. **异步执行阶段首次创建工作区漏检顶层软链 / Junction，且未复验前驱互斥（`src/executor/dsh.ts:307-323, 362-366`）**：
   * 在 `DshExecutor.checkWorkspace` 中，新工单首次准备（`claim?.state === 'new'`）调用的 `stat(directory)`（L307、L313）与 `pathIdentity(directory)`（L363，内部同样调用 `stat`）**均会跟随符号链接与 NTFS Junction**！
   * 而拒绝符号链接/Junction 的 `!(await lstat(directory)).isDirectory()` 检查（L319）**仅在 `claim?.state === 'ready'` 分支内执行**！
   * 这意味着若自定义 `prepare` 命令（或外部预置路径）将新工作区创建为指向旧工单工作区的符号链接或 NTFS Junction，首次启动会完全绕过检查并直接在旧工单目录中启动新 Worker Session；同时 `checkWorkspace` 也从未将新工作区的 `(device, inode)`、`realpath` 或 `gitIdentity.git` 与 `handoffFrom` 前驱链做物理互斥核验。

---

## 二、 具体修复方案

### 1. 引入三值物理目录比较原语，按保守方向拆分消费端（`src/infra/environment.ts`）

废弃单一模糊语义的 `sameDirectory` 回退逻辑，改为显式区分 `unknown` 状态的三值底层原语，并提供两个保守方向明确的导出函数：

#### （1）底层三值原语：`compareExistingDirectories(a, b)`

```ts
export type DirectoryComparison = 'same' | 'different' | 'unknown'
```

判定规则：
1. 对 `a` 与 `b` 分别执行 `statSync(path, { bigint: true })` 与 `realpathSync.native(path)`。
2. 只要任一侧抛出异常（`ENOENT`、`EACCES`、`EPERM`、`ELOOP` 等）或 `!stat.isDirectory()`，一律返回 `'unknown'`（不做任何路径字符串猜测）。
3. 当两侧均为已存在且可访问的目录时：
   * 若两侧均具备有效非零文件系统身份（`dev !== 0n && ino !== 0n`）：
     * `statA.dev === statB.dev && statA.ino === statB.ino` → 返回 `'same'`；
     * 否则 → 返回 `'different'`。
   * 若底层文件系统未提供非零 `(dev, ino)`（如部分特殊网络/虚拟文件系统返回 `0n`）：
     * 仅当内核返回的 `realpathSync.native(a) === realpathSync.native(b)` 精确全等时返回 `'same'`；
     * 若 `realpathSync.native` 字符串不等但在 `win32` 下仅大小写不同，由于缺乏非零 `(dev, ino)` 无法区分“大小写敏感卷上的不同目录 `A`/`a`”与“异常驱动未规范化大小写”，**保守返回 `'unknown'`**（绝不通过 `.toLowerCase()` 盲判 `'same'`）。

#### （2）等价性证明函数：`sameExistingDirectory(a, b): boolean`（Fail-closed 为 `false`）

* **实现**：`return compareExistingDirectories(a, b) === 'same'`。
* **适用范围**：
  * `src/executor/dsh.ts`：`checkWorkspace` 中校验已有 Session 的 `cwd`（L297）、已就绪工作区的 `claim.directory`（L303，当 `claim.state !== 'new'` 时）、`claim.commonDir`（L351）及 `claim.gitIdentity.{commonDir,gitDir}`（L353）。
  * 对于 `dsh.ts:303` 中 `allowPrepare === true && claim.state === 'new'` 尚未执行 `prepareDirectory` 的前置分支：此时目标目录按设计必须尚不存在（若已存在会在 L315 报错），直接要求记录精确相等 `claim.directory === directory`；待 `prepareDirectory` 落盘后再校验真实物理身份。
  * 对于 `dsh.ts:952`（`reclaim` 的 `stillEnded` 并发守卫）：该处比较的是同一工单对象在内存快照与最新数据库快照中的 `execution.directory` 字段是否被并发修改，保留精确字符串 `===` 即可。
  * 对于 `src/executor/workspace.ts:70`（`reclaimWorkspace` 判断主检出 vs 链接工作树）：改用异步版 `compareExistingDirectories(gitDir, common)`——`'same'` 记为主检出，`'different'` 进入链接工作树分支检查，**`'unknown'` 保守记为 `report.worktree = unknown('Git metadata directory identity could not be verified')`**，不猜测归属。

#### （3）潜在别名判定函数：`mayAliasDirectory(a, b, platform = process.platform): boolean`（供 `withoutDirectory` 使用，Fail-closed 为 `true`）

* **实现**：
  1. 先调用 `compareExistingDirectories(a, b)`：若为 `'same'` 返回 `true`，若为 `'different'` 返回 `false`。
  2. 若为 `'unknown'`（典型如 `worker-bin` 尚未创建，或 `PATH` 条目尚不存在）：
     * 分别向上回溯 `a` 与 `b` 最近已存在的祖先目录 `ancA`、`ancB`（记录各自未创建的剩余相对路径段 `relA`、`relB`），并调用 `compareExistingDirectories(ancA, ancB)`：
     * 若祖先明确为 `'different'` → 返回 `false`；
     * 若祖先为 `'same'` → 在 `platform === 'win32'` 下若 `relA.toLowerCase() === relB.toLowerCase()` 返回 `true`（POSIX 下比较 `relA === relB`），否则返回 `false`；
     * 若连已存在祖先的身份都为 `'unknown'`（例如权限受限或虚拟卷无有效 `dev/ino`）→ 若归一化字符串在目标平台可能别名命中，保守返回 `true`（宁可从 Worker 的 `PATH` 中多剔除可疑垫片项，绝不漏放禁用垫片目录）。

---

### 2. 调整 `core ↔ executor` 端口接口，建立“两阶段”工单交接工作区物理分离机制

`src/core/` 不直接引入 `node:fs` 是为了领域层可测试性，通过端口接口（Port）将工作区分离校验委托给基础设施/执行器层完全符合六边形架构边界。由于交接发生时新工作区目录**尚未运行 `prepare` 命令落盘**，而异步 `prepare` 命令又可能在落盘时创建符号链接或 Junction，必须采用 **“阶段一：交接同步事务内预检（保护旧工单不被误关） + 阶段二：`prepareDirectory` 后物理复验（阻断首个 Worker 回合启动）”** 的双阶段设计。

#### 阶段一：交接同步事务内预检端口（在结束旧工单与迁移订阅之前 Fail-closed）

1. **端口接口调整（`src/core/part.ts`、`src/core/tickets.ts`、`src/app/runtime.ts`）**：
   * 在 `EngineOptions`（`src/core/part.ts:15`）中新增同步端口方法（或扩展 `prepareTicket` 上下文参数，推荐独立显式端口以保持职责清晰）：
     ```ts
     verifyHandoffWorkspace?: (predecessors: readonly Ticket[], candidateDirectory: string) => void
     ```
   * 在 `Tickets.handoff`（`src/core/tickets.ts:212-216`）中：
     * 沿 `old.handoffFrom` 向上收集完整前驱工单链 `predecessors`（设深度上限如 64 层；若链中存在环路或找不到历史前驱工单记录，立即抛错拒绝交接）。
     * 先保留非空与快速字符串拦截，随后**在执行 L242 `old.handoffTo = id`、`old.ended = ...` 及迁移 Thread 订阅之前**，调用 `this.options.verifyHandoffWorkspace(predecessors, prepared.execution.directory)`（在生产运行时 `src/app/runtime.ts` 中必须注入该端口；未注入时若触发交接亦应默认拒绝或由测试显式提供）。
     * 因为 `Engine.handoff`（`src/core/engine.ts:231`）整体包裹在 `this.repo.atomic(...)` SQLite 事务中，只要预检抛错，`prepare` 写入的 `KV` 声明回滚，**旧工单 `old` 保持存活、原 Assignment 不被停止、飞书 Thread 订阅不会丢失**。

2. **阶段一文件系统保守预检算法（`DshExecutor.verifyHandoffWorkspace` 实现）**：
   * **规则 A — 候选新目录必须尚不存在（拦截复用已有目录、预置软链或 NTFS Junction）**：
     * 对 `candidateDir` 执行 `lstatSync(candidateDir)`（注意用 `lstatSync` 而非 `statSync`，以捕获悬空软链与 Junction）：
       * 若调用成功（路径已存在，无论是目录、普通文件、Symlink 还是 Junction）→ **立即抛错拒绝交接**；
       * 若抛错但 `code !== 'ENOENT'`（如 `EACCES`、`EPERM`、`ELOOP`）→ **状态不可验证，保守抛错拒绝交接**。
   * **规则 B — 解析并验证候选新目录最近已存在祖先的真实物理身份**：
     * 向上回溯找到 `candidateDir` 最近已存在祖先目录 `candAnc`，执行 `realpathSync.native(candAnc)` 与 `statSync(candAnc, { bigint: true })`：
       * 若失败、`!isDirectory()` 或 `dev === 0n || ino === 0n` → **祖先物理身份不可验证，保守拒绝交接**；
       * 计算基于真实祖先展开的目标规范路径 `candTarget = join(realCandAnc, ...candRelSegments)`。
   * **规则 C — 对 `predecessors` 链中每一个前驱工单做物理分离与非嵌套校验**：
     * 若任一前驱工单缺失 `pred.execution?.directory` → **前驱工作区记录缺失，保守拒绝交接**。
     * **分支 C1：前驱目录在磁盘上仍存在（`lstatSync(predDir)` 未报 `ENOENT`）**：
       * 获取前驱目录的 `realpathSync.native(predDir)` 与 `statSync(predDir, { bigint: true })`。若前驱为断链、无权限（`EACCES`）、循环链接（`ELOOP`）或 `dev === 0n || ino === 0n` → **前驱真实目标不可验证（无法排除候选目录指向同一物理位置），保守拒绝交接**。
       * 校验 `candAnc` 的 `(dev, ino)` 不等于前驱目录的 `(dev, ino)`，且 `candTarget` 与 `realPredDir` **既不相等，也不互为父子目录前缀**（严禁将新工作区建在旧工作区子目录内，或将旧工作区包在新工作区子目录内）。
       * 若 `candAnc` 与 `realPredDir` 的父目录为同一物理目录（`dev + ino` 相同），在 `win32` 下额外要求 `candRelSegments[0].toLowerCase() !== basename(realPredDir).toLowerCase()`，防止在大小写不敏感目录中发生名称碰撞，也防止在同一父目录下产生大小写混淆路径。
     * **分支 C2：前驱目录已不在磁盘上（`lstatSync(predDir)` 报 `ENOENT`）**：
       * 向上定位 `predDir` 最近已存在祖先 `predAnc`，获取其 `realpathSync.native` 与非零 `(dev, ino)`（若不可验证 → **保守拒绝交接**）。
       * 若 `candAnc` 与 `predAnc` 属于同一物理祖先目录（或一方位于另一方真实路径前缀下），校验双方剩余相对路径段既不相等、不互为父子前缀，且在 `win32` 下共享物理父目录处的首个子段不发生大小写不敏感相等（避免新工单覆盖尚待恢复的历史前驱路径槽位）。

#### 阶段二：`prepareDirectory` 落盘后的物理身份复验（`src/executor/dsh.ts:checkWorkspace`）

预检通过后，异步启动阶段会运行管理员配置的 `prepare` 命令（或内置 `git worktree add`）创建新工作区。为彻底封堵 **`prepare` 命令本身创建符号链接 / NTFS Junction 或复用已有 Git worktree** 的风险，修改 `DshExecutor.checkWorkspace`（`src/executor/dsh.ts:307-366`）：

1. **无条件使用 `lstat` 拒绝顶层符号链接与 NTFS Junction（修复 `claim?.state === 'new'` 漏检漏洞）**：
   * 在 `prepareDirectory` 完成后（无论 `claim?.state` 是 `'new'` 还是 `'ready'`），立即执行：
     ```ts
     const linkInfo = await lstat(directory)
     if (!linkInfo.isDirectory()) {
       throw new PrepareFailed(`The workspace ${directory} is a symbolic link, junction, or non-directory; ask an operator to inspect it.`)
     }
     ```
   * 在 Node.js / libuv（含 Windows 原生实现）中，`lstat` 对 POSIX symlink、Windows directory symlink 和 NTFS Junction（`IO_REPARSE_TAG_MOUNT_POINT`）均不设 `S_IFDIR`（`isSymbolicLink()` 为 `true`、`isDirectory()` 为 `false`），可在创建任何 Worker Session 之前直接阻断顶层软链与 Junction。
2. **强制获取真实路径与有效非零 `(device, inode)`**：
   * 对新准备完成的工作区调用 `canonicalDir = await realpath(directory)` 与 `directoryIdentity = await pathIdentity(canonicalDir)`。
   * 若 `directoryIdentity` 为 `undefined`（即 `dev === 0n || ino === 0n`），对于交接工单（以及需要持久化身份校验的受管工作区）直接抛出 `PrepareFailed`，拒绝在物理身份不可验证的文件系统上盲目放行。
3. **对携带 `ticket.handoffFrom` 的工单，回溯前驱链做真实物理互斥复验**：
   * 遍历 `handoffFrom` 全链的每个前驱 `pred`（读取 `predClaim = store.get(KV.workspace.claim(pred.id))`）：
     * **物理 Inode 互斥**：若 `predClaim?.directoryIdentity` 存在，要求 `directoryIdentity.device !== predClaim.directoryIdentity.device || directoryIdentity.inode !== predClaim.directoryIdentity.inode`。
     * **实时存活前驱的 `realpath` 与非包含复验**：对 `pred.execution?.directory` 执行 `lstat`：
       * 若非 `ENOENT`，解析 `predCanonical = await realpath(predDir)` 与 `predLiveId = await pathIdentity(predCanonical)`（解析失败或无有效身份则保守抛 `PrepareFailed`）；
       * 要求 `directoryIdentity` 与 `predLiveId` 不同，且 `canonicalDir` 与 `predCanonical` **互不为父子目录前缀**（彻底拦截“中间父目录被 `prepare` 脚本挂了 Junction 折射进旧工作区子目录”的场景）。
       * 若前驱目录已 `ENOENT` 且既无 `predClaim?.directoryIdentity` 又无 `predClaim?.gitIdentity`（历史老记录身份完全缺失），对于交接复验同样需确保 `canonicalDir` 未落入前驱最近已存在真实祖先的同一目标子路径，无法确认时抛 `PrepareFailed` 交运维核查。
     * **Git Worktree 管理目录与分支互斥**：当新工作区包含 `.git` 时，强制要求 `gitIdentity` 解析成功（移除当前 L346 在 `claim?.state === 'new'` 时静默吞掉 `gitIdentity` 错误的宽松分支），并校验新工作区的 `gitIdentity.git`（`.git/worktrees/<name>` 的 `device + inode`）及 `branch` 与任一前驱的 `predClaim.gitIdentity.git` 及 `predClaim.branch` 均不相同（注：同一仓库下不同 worktree 的 `commonDir` 相同是预期行为）。

---

## 三、 关键边界情形与保守行为对照表

| 边界场景 | `sameExistingDirectory`（恢复校验 `checkWorkspace`） | `Tickets.handoff` 阶段一同步预检 | `checkWorkspace` 阶段二交接复验 | `mayAliasDirectory` / `withoutDirectory`（剥离 `PATH` 垫片） |
| --- | --- | --- | --- | --- |
| 已存在同一物理目录（`f:\work\t1` vs `F:/work/t1/`、8.3 短名） | `(dev, ino)` 相同 → **`true`（通过）** | 目标已存在（`lstat` 非 `ENOENT`） → **拒绝交接（保活旧工单）** | `(dev, ino)` 与前驱冲突 → **`PrepareFailed`（阻断启动）** | `(dev, ino)` 相同 → **剔除** |
| 大小写敏感目录中 `Work/A` 与 `Work/a`（两者均存在） | `(dev, ino)` 不同 → **`false`（拒绝）** | 若目标未占用且物理父目录允许独立文件项，进入阶段二真实 Inode 核验（Windows 默认仍建议拒绝同父目录仅大小写差异的候选名以防工具链混淆） | `(dev, ino)` 不同且非软链/非包含 → 按真实物理身份判定 | `(dev, ino)` 不同 → **保留** |
| 大小写敏感目录中 `Work/A` 缺失，`Work/a` 存在（或两侧均缺失） | 存在 `ENOENT` → `'unknown'` → **`false`（绝不转小写误放行！）** | 若候选路径与前驱路径在同一父目录下仅大小写不同 → **保守拒绝交接** | 缺失抛 `PrepareFailed` | 同物理父目录下未创建子段在 `win32` 大小写相同 → **保守剔除** |
| 符号链接（Symlink）或 NTFS Junction 指向旧工作区（顶层或父目录） | 若 `claim.state === 'ready'`，`lstat` 拦截顶层链接 + `(dev, ino)` 校验原始目录 | 顶层已存在软链/Junction 被 `lstat` 拦截；父目录软链/Junction 被祖先 `realpathSync.native` 解析后检出与旧工作区同源/嵌套 → **拒绝交接** | `prepare` 脚本新建的顶层软链/Junction 被新增 `lstat` 拦截；中层软链折射被 `realpath` + `(device, inode)` 互斥拦截 → **`PrepareFailed`** | `realpath` / `(dev, ino)` 命中 → **剔除** |
| 权限不足（`EACCES`）、循环软链（`ELOOP`）或 `dev=0n, ino=0n` 无法验证身份 | `'unknown'` → **`false`（拒绝恢复）** | 候选祖先或前驱身份不可验证 → **保守拒绝交接（保活旧工单）** | 无法取得有效 `directoryIdentity` / 前驱实时身份不可读 → **`PrepareFailed`** | 祖先身份不可验证且可能命中 → **保守剔除** |

---

## 四、 验证与测试计划

1. **`tests/environment.spec.ts` — 三值原语与双方向保守语义单测**：
   * 已存在目录的不同盘符大小写（`f:\...` vs `F:\...`）、正反斜杠混写、`realpath` 解析后在 `sameExistingDirectory` 下返回 `true`。
   * **缺失路径与大小写敏感模拟**：当 `Work/A` 不存在而 `Work/a` 存在（或两者均不存在）时，`sameExistingDirectory('.../Work/A', '.../Work/a')` 严格返回 `false`（验证未做 `.toLowerCase()` 回退）。
   * **身份不可验证模拟**：当 `dev === 0n && ino === 0n` 且 `realpathSync.native` 仅大小写不同，或 `statSync` 抛 `EACCES` 时，`compareExistingDirectories` 返回 `'unknown'`，`sameExistingDirectory` 返回 `false`。
   * **`withoutDirectory` 预创建剔除**：在 `worker-bin` 创建前与创建后，均能从 `PATH` 中剥离大小写变体与尾斜杠变体，且不误删同父目录下无关兄弟目录。
2. **`tests/tickets.spec.ts` & `tests/runtime.spec.ts` — 交接双阶段物理隔离测试**：
   * **阶段一拦截且旧工单完好**：
     * 候选新路径已存在为普通目录、符号链接或 Windows NTFS Junction（Windows 下可用无需管理员权限的 `symlinkSync(oldDir, newDir, 'junction')` 构造真实用例）时，`engine.handoff(...)` 抛出异常，且断言 **`old.ended === undefined`、`old.handoffTo === undefined`、原 Thread 订阅仍绑定在 `old.id` 上**。
     * 候选新路径位于指向 `old` 工作区的父级 Junction/Symlink 之下，或位于 `old` 工作区子目录内（以及 `old` 位于新路径子目录内）时，`engine.handoff(...)` 拒绝交接并保活 `old`。
     * 模拟前驱目录权限不可读或身份返回 `0n`（不可验证）时，`engine.handoff(...)` 保守拒绝交接。
   * **阶段二拦截 `prepare` 脚本违规行为**：
     * 自定义 `prepare` 脚本将新工单 `directory` 创建为指向 `old` 工作区的 NTFS Junction 或 Symlink：断言 `DshExecutor` 在 `claim.state === 'new'` 阶段即被 `lstat` 拦截并报 `PrepareFailed`，**不会创建新 Worker Session，也不会在旧目录中执行任何模型回合**。
     * 自定义 `prepare` 脚本在中层子目录挂载 Junction 使 `realpath(newDir)` 落入 `old` 工作区内部，或复用了 `old` 的 `.git/worktrees/<name>` 管理目录：断言阶段二复验抛出 `PrepareFailed`。
3. **`tests/workspace.spec.ts` — 恢复与盘点回归测试**：
   * 验证历史工单目录缺失但存在仅大小写不同的同级目录时，`checkWorkspace` 保守拒绝恢复且不执行 `prepare` 命令。
   * 验证 `reclaimWorkspace` 在 Git 目录身份不可验证时将 `report.worktree` 记为 `unknown`，不误报为主检出或已验证工作树。
