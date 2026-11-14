# 02 [P0] Windows 路径大小写不敏感导致的目录等价性误判

* **优先级**：P0（高优 — 影响 Windows 原生环境下的工单恢复校验、PATH 垫片剥离与盘点准确性）
* **涉及文件**：
  * `src/infra/environment.ts`（`sameDirectory` L51-54、`withoutDirectory` L55-57）
  * `src/executor/dsh.ts`（`checkWorkspace` L297/303/351/353、`reclaim` L952）
  * `src/executor/workspace.ts`（`reclaimWorkspace` L65、L70）
  * `src/core/tickets.ts`（`handoff` L213）
  * `tests/environment.spec.ts`、`tests/workspace.spec.ts`、`tests/runtime.spec.ts`

---

## 一、 问题描述与根因分析

最新提交 `1bfad96` 修复了前端面板 `ExecutionSettings` 对 Windows 绝对路径（如 `F:\code\worktrees`）的输入校验，但后端多处路径等价判断在 Windows（NTFS/ReFS 默认大小写保留但不敏感，且 Git for Windows 与 Node/用户输入在盘符大小写及斜杠形式上经常不一致）下存在隐患：

### 1. `sameDirectory` 在目录不存在或盘符大小写不一致时失真（`src/infra/environment.ts:51-54`）

当前实现：
```ts
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
```
存在两个问题：
1. **路径尚未创建时回退到 `path.resolve`**：`resolve('f:\\code\\work')` 返回 `'f:\\code\\work'`，而 `resolve('F:\\code\\work')` 返回 `'F:\\code\\work'`，在 `win32` 下严格 `===` 返回 `false`。
2. **`withoutDirectory(PATH, dir)` 过滤失效**：Windows 系统环境变量 `PATH` 中大量条目以小写盘符或尾部反斜杠书写（如 `c:\users\dd\...`），当目录尚不存在或符号链接/SUBST 盘表现不同时，`sameDirectory` 返回 `false` 会导致目标目录未能从 `PATH` 中剔除。
3. **`realpathSync` vs `realpathSync.native`**：在 Windows 上，优先使用 `realpathSync.native` 能更稳定地由操作系统内核返回规范化盘符与真实大小写。

### 2. 多处业务逻辑直接用 `===` 裸比较路径字符串

* `src/executor/workspace.ts:70`：
  ```ts
  report.commonDir = resolve(common)
  ...
  resolve(gitDir) === report.commonDir
  ```
  `common` 与 `gitDir` 来自 `git rev-parse --path-format=absolute`，虽然同一次 Git 调用通常大小写一致，但一旦涉及符号链接、目录联接点（Junction）或外部传入路径对比，仅靠 `resolve` 字符串 `===` 并不可靠。
* `src/executor/dsh.ts:952`：
  ```ts
  current.execution?.directory === ticket.execution?.directory
  ```
* `src/core/tickets.ts:213`：
  ```ts
  if (!prepared?.execution?.directory || old.execution?.directory === prepared.execution.directory)
  ```
  若工单 Handoff 前后管理员在面板将 `executor.directory` 从 `f:\work` 改为 `F:\work`，裸字符串 `===` 会误以为新旧工作目录不同（尽管工单名带新 ID 后缀通常会区分，但边界校验本身在 Windows 下不严谨）。

---

## 二、 具体修复方案

### 1. 强化 `sameDirectory` 的跨平台语义（`src/infra/environment.ts`）

增加可选 `platform: NodeJS.Platform = process.platform` 参数以便在任意平台上做确定性单元测试：

1. **当两个路径均存在且为目录时**：
   * 优先比较 `statSync(a, { bigint: true })` 与 `statSync(b, { bigint: true })`：若 `dev !== 0n && ino !== 0n`，直接通过 `a.dev === b.dev && a.ino === b.ino` 判定同一物理目录（天然兼容大小写、8.3 短文件名、Junction 联接点与符号链接）。
   * 若文件系统不提供非零 inode，则使用 `realpathSync.native(path)`，并在 `platform === 'win32'` 时统一做尾部路径分隔符规整与 `.toLowerCase()`（或 `toUpperCase()`）规范化对比。
2. **当任一路径不存在（`ENOENT`）时**：
   * 对存在的父级前缀做 `realpathSync.native` 解析后拼接剩余相对段（或回退到 `win32.resolve` / `posix.resolve`），在 `platform === 'win32'` 下移除非根尾部分隔符并统一转换大小写后再比较。

示例结构：
```ts
export function normalizeComparisonPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = platform === 'win32' ? win32.resolve(value) : posix.resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}
```

### 2. 替换裸字符串路径比较

* 在 `src/executor/workspace.ts` 中，对 `gitDir` 与 `commonDir` 的主检出/链接工作树判定改用 `sameDirectory(gitDir, common)`（或基于 `realpath` + `sameDirectory`）。
* 在 `src/executor/dsh.ts:952` 中改用 `sameDirectory`（处理好 `undefined` 情况）。
* `src/core/tickets.ts` 属于纯领域核心层（`src/core/` 不直接依赖 `node:fs` I/O），可通过注入或纯路径规范化辅助函数消除 Windows 盘符大小写差异，同时保持 `core` 层零文件系统副作用。

---

## 三、 风险与边界评估

* **WSL / 挂载大小写敏感目录（Per-directory case sensitivity）**：Windows NTFS 极少数目录可通过 `fsutil.exe file setCaseSensitiveInfo` 开启大小写敏感。**优先使用已存在目录的 `(dev, ino)` 或 `realpathSync.native` 精确比较**、仅在路径不存在回退时做 `win32` 大小写折叠，即可同时兼顾常规 NTFS 大小写不敏感与已存在大小写敏感子目录的精确区分！
* **UNC 网络共享路径（`\\server\share\...`）**：`win32.resolve` 原生保留 UNC 前缀 `\\server\share`，测试需覆盖 UNC 路径大小写变体。

---

## 四、 验证与测试计划

1. **`tests/environment.spec.ts` 新增用例**：
   * 已存在目录的不同盘符大小写（`f:\...` vs `F:\...`）、正反斜杠混写（`F:/code/work` vs `F:\code\work\`）在 `sameDirectory` 下返回 `true`。
   * **尚未创建目录**在 `win32` 模式下 `f:\temp\new-dir` 与 `F:\TEMP\new-dir\` 返回 `true`，在 `posix` 模式下返回 `false`。
   * `withoutDirectory` 能正确剔除 `PATH` 中大小写不一致或带尾斜杠的目标目录。
   * UNC 路径 `\\Server\Share\Work` 与 `\\server\share\work` 等价性验证。
2. **`tests/workspace.spec.ts` & `tests/runtime.spec.ts` 回归**：
   * 模拟 Git 返回大写盘符正斜杠路径 `F:/...`、配置存储小写盘符反斜杠路径 `f:\...` 时，`checkWorkspace` 与 `reclaimWorkspace` 不发生误报拒绝。
