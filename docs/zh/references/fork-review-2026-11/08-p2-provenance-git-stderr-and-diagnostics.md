# 08 [P2] 工作区创建溯源 `isolatedGit` 对 `stderr` 过度敏感且静默吞掉失败原因

* **优先级**：P2（低优 — 影响未来受控自动清理所需的创建溯源验证通过率与可排障性）
* **涉及文件**：
  * `src/executor/provenance.ts`（`isolatedGit` L23-33、`preflightCreation` L59-72、`verifyCreation` L73-106）
  * `tests/provenance.spec.ts`

---

## 一、 问题描述与根因分析

当配置了 `executor.managedRepository` 时，`DshExecutor.prepareDirectory` 会在执行 `prepare` 命令前后调用 `preflightCreation` 和 `verifyCreation` 建立工作区受管溯源证据（`CreationProvenance`）。当前实现存在两处隐患：

### 1. `isolatedGit` 将退出码 0 下的任何非空 `stderr` 一律视为异常（`src/executor/provenance.ts:30-32`）

```ts
const result = await exec('git', argv, { cwd, env, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true })
if (result.stderr.trim()) throw new Error('Git emitted a diagnostic')
return result.stdout
```
在真实 Git 运行环境中（尤其是 Windows / 大型仓库 / 并发 worktree 下），即使命令完全成功（`exitCode === 0` 且 `stdout` 格式完全合法），Git 仍可能向 `stderr` 输出良性提示，例如：
* `warning: ...`（如长路径、文件系统缓存或松散对象过多提示）
* `hint: ...`
* 特定 Git 版本下的仓库维护提示

一旦出现任何单行 `warning:`，`isolatedGit` 立即抛错，导致整个工作区溯源降级为 `status: 'unknown'`。

### 2. `preflightCreation` 与 `verifyCreation` 捕获所有异常后静默返回原对象，无任何诊断记录

* 在 `preflightCreation`（L71）和 `verifyCreation`（L105）中，所有检查分支不通过或 `catch` 块都直接 `return value`（保持 `status: 'unknown'`），**既不记录具体哪一步失败，也不写入日志**。
* 结果是：运维事后查看 `KV.workspace.provenance(ticketId)` 时，只能看到 `{ status: 'unknown' }`，完全无法区分是因为“预检时同名分支已存在”、“`prepare` 创建的不是 linked worktree”、“缺少 `refs/dsh-superagent/<id>` 引用”、“文件系统无 inode”还是“Git 输出了一条无关紧要的 stderr warning”。

---

## 二、 具体修复方案

### 1. 以退出码与结构化 `stdout` 校验为准，不再对退出码 0 的良性 `stderr` 一刀切抛错

* `execFile` 在非 0 退出码、超时或信号终止时本身就会自动 reject。
* 对于 `exitCode === 0` 的只读查询命令（`rev-parse`、`for-each-ref`、`symbolic-ref`、`worktree list --porcelain -z`），`verifyCreation` 后续代码**已经对 `stdout` 做了极其严格的格式校验**（绝对路径校验、40/64 位十六进制 OID 正则 `/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/`、NUL 分隔字段精确匹配）。良性 `stderr` 不会污染 `stdout`，无需在 `exitCode === 0` 时因 `stderr` 非空而强行失败。
* 唯一依赖 `stderr` 判断的场景是 `preflightCreation`（L62-68）中 `git show-ref --exists <name>` 返回退出码 `2`（引用不存在）：
  * 注意当前 L67 硬编码了英文字符串 `failure.stderr.trim() !== 'error: reference does not exist'`（依赖 `LC_ALL: 'C'`）。若某次调用附带了一行 `warning:`，精确相等比较同样会失败！
  * **更稳健的做法**：改用 `git for-each-ref --format=%(refname) refs/heads/... refs/dsh-superagent/...`（或 `git rev-parse --verify --quiet <name>^{commit}` 配合退出码，并在仓库健康前提下先用 `git rev-parse --git-common-dir` 确认仓库本身可读），无需依赖特定版本的英文 `stderr` 文案即可确定性判断引用是否存在！

### 2. 在 `CreationProvenance` 中增加可选只读诊断字段 `reason?: string`

扩展 `CreationProvenance` 接口（向后兼容已有 JSON 记录）：
```ts
export interface CreationProvenance {
  ...
  status: 'unknown' | 'verified'
  /** 当 status 为 unknown 时，记录未通过预检或创建后核验的具体原因（不含凭据）。 */
  reason?: string
}
```
在 `preflightCreation` 与 `verifyCreation` 的各个提前返回点写入简明机械原因（例如 `'branch_already_exists'`、`'missing_ticket_ref'`、`'not_linked_worktree'`、`'inode_unavailable'` 或截断脱敏后的错误摘要），并在验证成功时清除 `reason`。

---

## 三、 验证与测试计划

1. **`tests/provenance.spec.ts` 新增测试**：
   * 模拟 `Runner` 在 `exitCode === 0` 时伴随良性 `stderr` 警告（而 `stdout` 合法），验证 `preflightCreation` 与 `verifyCreation` 仍能达成 `status: 'verified'`。
   * 分别构造“预检前分支已存在”、“缺少 `refs/dsh-superagent/<id>`”、“普通 clone 而非 linked worktree”等场景，验证 `status === 'unknown'` 且 `reason` 字段准确指出具体未通过项。
