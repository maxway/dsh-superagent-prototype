# 009 Windows 部署：必要性与适配方案

[English](../009-windows-deployment.md) | **简体中文**

本文回答两个问题：dsh-superagent 是否应该支持在原生 Windows 主机上运行，以及要支持它需要做什么。这是一份分析与有条件的方案，不是已支持的部署路径。当前受支持的部署仍然是 Linux，包括 WSL2，见 [006 部署](006-deployment.md)。

问题在于主机，而不在于谁能使用智能体。所有用户都在浏览器中打开面板，并在来源会话里提到智能体，因此 Windows 桌面从来不需要在本地运行一份服务。

## 概要

- **当前部署没有必要。** 每个仓库一个常驻服务，跑在任意 Linux 主机（包括 WSL2）上，已经能完全服务 Windows 用户。只有出现具体的、仅 Windows 才有的需求时，移植才值得做，见[有没有必要？](#有没有必要)。
- **如果批准**，一个可用的内部版本约需 9-13 人日：一名开发者 2-2.5 周，包含概念验证和端到端验证，不含飞书，也不含 Windows CI runner。
- **完整对齐**——飞书、Windows CI、双语的安装文档，以及让两个平台都持续被测试的加固——约需 12-18 人日，即一名开发者 3-4 周。
- **建议：** 现在不要移植。只有当触发条件出现时，才做 1-2 天的概念验证，然后用实测结果决定。

## “在 Windows 上部署”意味着什么

dsh-superagent 是一个仓库对应一个服务。它轮询 Git 主机、创建工单、在自己的检出目录中工作，并在会话里答复或打开合并请求。人们通过 Web 面板和飞书使用它，从不自己运行它。

“Windows 部署”背后其实是两个不同的问题：

- **主机：** 运行服务、它的 DSH profile、它的 CLI 和它的状态目录的机器。本文讨论的是主机。
- **客户端：** 打开面板或在飞书中发言的机器。它们现在已经可用，因为面板是浏览器应用。

Linux 主机、Windows 机器上的 WSL2 发行版、Linux 虚拟机、容器或远程服务器，都能回答客户端的问题。原生 Windows 只改变主机。如果目标是“让我们的 Windows 开发者能用上智能体”，今天什么都不缺。

## 当前支持情况

### DeepSeek Harness

DSH 已经能在 Windows 上运行，并把 Windows 当作一等平台：

- 随附的 base profile 在 `win32` 上挂载 bash 外壳相关行对应的 PowerShell 版本——用 `dsh-pwsh-sandbox` 加 `tool-pwsh` 取代 `dsh-bash-sandbox` 加 `tool-bash`——包括 ACL 受限令牌沙箱。
- 普通子进程 runner 和 ACL 沙箱有原生 Win32 实现，包括 Job Object 进程包含。
- 启动器、profile、插件管理、Web 服务器和会话存储都是 Node 应用，没有仅 POSIX 的依赖。[006 部署](006-deployment.md)中固定的 DSH 版本在每个平台上都是同一个包。

这次移植不需要改动 DSH 上游。

### dsh-superagent

bundle 已经按平台把两个 agent preset 在 bash 和 pwsh 之间切换（`cordis.patch.yml`），因此 Windows 上的 worker 会拿到 PowerShell 工具。运行时和部署层没有跟上。

| 领域 | 当前实现 | 原生 Windows 状态 |
| --- | --- | --- |
| 服务控制 | `scripts/dsh-superagent` 使用 Python 3、tmux、`ps`、`fcntl.flock`、`os.kill(SIGINT)` 和 `umask` | 无法运行；没有可移植的优雅停止 |
| worker 命令 shim | `worker-bin` 中无扩展名的 `#!/bin/sh` 文件，被加到 `PATH` 前面 | PowerShell 和 `CreateProcess` 不会执行它们；账号选择与 blocked commands 失效 |
| CLI 包装与探测 | Shell 脚本包装；setup 用 `env PATH=... <cli>` 探测；`execFile` 和 `spawn` 直接调用 CLI | Windows 没有 `env`；`execFile` 不能运行 `.cmd`；npm 安装的 `lark-cli` 是 `.cmd` |
| 准备命令 | 固定 `sh -c <command>` | 默认没有 `sh`；文档中的命令使用 POSIX 变量 |
| 路由工具 | 主 Session 的白名单和等待守卫硬编码了 `bash` | `pwsh` 工具会从路由 Session 中被移除；它的等待守卫永远不生效 |
| 提示词与技能 | “Workers use bash”以及 bash 示例 | worker 用的是 PowerShell，所以指令和示例对它是错的 |
| 安装与文档 | `~/.local/bin`、`cat > ... <<'EOF'`、tmux、Python、`$HOME` | 需要 Windows 等价写法 |
| 测试与 CI | POSIX fixture、shell、以 `:` 分隔的 PATH；没有 Windows job | 预计 `pnpm check` 在 Windows 上不能通过 |

[006 部署](006-deployment.md) 只记录了 POSIX 路径，因此即使手工在 Windows 上启动服务，setup 也会在轮询之前失败。

## 有没有必要？

### 场景

| 场景 | 原生 Windows 的价值 | 建议 |
| --- | --- | --- |
| 仓库与操作系统无关；有可用的 Linux 主机、WSL2 或容器 | 低：服务今天就能用 | 保留 Linux 主机；不要移植 |
| worker 必须构建或测试仅 Windows 的代码，例如桌面或驱动项目 | 高：worker 需要 Windows 工具链和检出目录 | 移植，或以后增加 Windows worker；从概念验证开始 |
| WSL2 和所有 Linux 主机都被禁止，而智能体必须跑在指定的 Windows 机器上 | 必须：没有其他主机 | 移植，按下面的方案执行 |
| Windows 开发者只需要打开面板或提到机器人 | 无：面板是浏览器应用，飞书是远程的 | 把主机留在 Linux 上 |
| 在 Windows 笔记本上做原型演示 | 低：WSL2 或一个小型 Linux 虚拟机足够 | 不要为了演示而移植 |

### 支持成本

移植不是一次性成本。移植之后，每次改动都要在两个平台上检查；worker 外壳不同（`bash` 和 `pwsh`），所以提示词、技能和测试都需要能识别平台的文本；必须有一个 Windows runner 来保证它不会悄悄退化；而且隔离能力更弱，因为 blocked-command shim 只是护栏，真正的边界仍然是专用的操作系统账号。对于一个仓库、一个共享服务的研究原型来说，除非上面某个场景确实成立，否则这份成本换来的价值很小。

### 结论

**现在没有必要。** 当前的 Linux/WSL2 部署已经覆盖 Windows 用户。只有出现具体触发条件时才重新考虑：worker 必须运行的仅 Windows 工具链、硬性的不能用 WSL 或没有 Linux 主机，或者产品上要求 Windows 安装包。出现这些条件时，先做 1-2 天的概念验证；它在承诺其余工作之前，先测量三个不确定的领域（CLI 调用、优雅停止、准备命令）。

## 适配方案

### 原则

- 两个平台保持一种行为，并保持 POSIX 路径可用；Windows 部署不能改变现有 Linux 安装的行为。
- 使用平台原生机制，而不是模仿 POSIX：worker 外壳和准备命令用 `pwsh`，只在必须启动 `.cmd` 文件时用 `cmd.exe`，受控关闭用 DSH 的 `ctx.appExit`。
- 像 DSH 那样，把平台差异收进带 platform 参数的小 helper 中，使分支可以在 Linux 上做单元测试。
- 把移植当作原型质量的变化：不新增运行时依赖，除非某个字段不可避免，否则不做设置迁移，也不改动数据库格式。

### 工作包

| 工作包 | 范围 | 人日 | 依赖 |
| --- | --- | --- | --- |
| WP0 | 在真实 Windows 机器上做概念验证 | 1-2 | — |
| WP1 | 服务生命周期：start、status、stop、restart、日志、锁 | 2-3 | WP0 |
| WP2 | CLI 与 worker 环境：探测、shim、包装、blocked commands | 2-3 | WP0 |
| WP3 | 准备命令、路由工具、提示词与技能 | 1-1.5 | WP2 |
| WP4 | 安装与部署文档，两种语言 | 1.5-2 | WP1-3 |
| WP5 | Windows 测试与 CI | 2-3 | WP1-4 |
| WP6 | Windows 上的飞书，可选 | 1-2 | WP2 |
| WP7 | 端到端验证与加固 | 1.5-2 | WP1-5 |

### WP0：概念验证

在一台干净的 Windows 11 或 Windows Server 机器上，安装 Node 22.19+ 或 24、pnpm、git、PowerShell 7，以及 [006 部署](006-deployment.md)中固定的 DSH 版本。创建 `superagent` profile，用 `link:` 添加 bundle，打开面板，确认 Web profile、`pwsh` 工具和隔离设置都能加载。然后故意复现三个阻塞点：setup 的 `env` 探测、用 `.cmd` 包装的 `execFile`/`spawn` 调用，以及 `sh -c` 下的准备命令。三个问题都有实测答案时结束；如果 DSH 本身都跑不起来就停止，因为那会改变整个估算。

### WP1：服务生命周期

把 Python 服务脚本替换成一个跨平台的 Node 脚本（推荐），或者增加一个 PowerShell 孪生脚本（备选）。推荐版本保留当前的命令行、退出码、日志命名、`manually-stopped` 标记和状态输出，并增加：

- 启动：以 detached 方式启动 `dsh --profile <profile> --no-open`，把输出重定向到现有日志路径；记录 PID；等待 `GET state` 响应，并像今天一样打印 setup 问题。
- 状态：读取 PID 文件和管理 API；检测重复实例；保留四个退出码。
- 停止与重启：调用一个新的本地回环管理路由 `POST service/stop`，它让插件在响应发出后通过 `ctx.appExit(0)` 退出；随后 DSH 现有的关闭路径会释放 profile。这是可移植的优雅停止：Windows 不能跨进程发送 `SIGINT`，而 `os.kill(pid, SIGINT)` 会直接终止进程。在 POSIX 上，脚本可以保留 `SIGINT` 作为后备。
- 锁与日志：使用独占的控制锁，例如已经是依赖的 `proper-lockfile`，以及像今天一样清理日志。

备选方案是 PowerShell 孪生脚本加同一个 `service/stop` 路由，例如通过一个 Windows 服务包装器；写起来更快，但会留下两套服务实现需要维护。`tests/service-script.spec.ts` 测试套件会围绕注入的进程与 HTTP 假实现重写，使它在两个平台上都能运行。

### WP2：CLI 与 worker 环境

CLI 和账号层最需要仔细设计。当前模型有两层：`worker-bin` 中无扩展名的 `#!/bin/sh` shim，把裸 `gh`、`glab` 和 `lark-cli` 重定向到智能体包装；以及包装脚本本身，它设置智能体的配置目录。两层按现在的写法都不能在 Windows 上工作。

推荐设计：

- 用环境变量而不是包装脚本来选择凭据：`GH_CONFIG_DIR`、`GLAB_CONFIG_DIR` 和 `LARKSUITE_CLI_CONFIG_DIR`，为插件进程设置，并由 worker 外壳继承。给 Git 和飞书来源设置增加可选的 `configDir` 字段，默认值为当前文档中的路径，让面板可以管理它们。
- 把 `cli` 设置指向真实可执行文件 `gh.exe` 或 `glab.exe`，用普通 argv 运行，绝不经过 shell：合并请求正文这样的任意文本不能经过 `cmd.exe` 的引号解析。为现有安装保留 POSIX 包装支持。
- 修正探测：`workerProbe` 和飞书探测通过子进程环境传入 `PATH`，不再启动 `env`；`executable()` 识别 `PATHEXT`，不再要求 POSIX 的可执行位。
- 把 blocked commands 保留为护栏 shim，在 Windows 上写成 `.cmd` 文件，使 PowerShell 优先解析它们。`gh`、`glab` 和 `lark-cli` 不再需要账号 shim，因为环境变量已经选择了账号。
- 飞书：Windows 上的 `lark-cli` 通常是 npm 的 `.cmd`；通过一个小型 Node 启动器或原生构建来运行它，并让消息文本不经过 `cmd.exe` 的引号解析。这属于 WP6。

考虑过的备选：保留包装模型，通过 `cmd.exe` 启动 `.cmd` 包装。它在设置上改动更少，但对携带 JSON 或任意消息文本的 CLI 参数不安全，因此不推荐作为长期形态。短期的内部试用可以使用它，前提是服务环境设置三个配置目录，并且 `cli` 字段指向包装。

### WP3：准备命令、路由工具、提示词与技能

- 准备命令：通过平台外壳运行配置的命令：POSIX 上用 `sh -c`，Windows 上用 `pwsh -NoProfile -NonInteractive -Command`。用 `$env:DSH_SUPERAGENT_DIR` 和 `git worktree` 示例记录 Windows 写法；PowerShell 7 支持 `&&`。
- 路由工具：把 `pwsh` 加入主 Session 的白名单和 `noWait` 守卫，或者从已注册的工具推导外壳工具名。
- 提示词与技能：把“Workers use bash”改成不限定外壳的措辞；检查随附技能中的 POSIX 专用示例（`head`、`printf`、`$(...)`、`$VAR`），提供 PowerShell 等价写法或不限定外壳的步骤。worker 通常能自行翻译，但指令不应该用错误的方言训练它。

### WP4：安装与部署文档

- `SETUP.md` 和 `SETUP.zh-CN.md`：增加 Windows 前置条件和操作者一节（PowerShell 7；Node、pnpm、git、gh/glab；不需要 tmux 或 Python）、PowerShell 包装或配置示例，以及新的服务命令。
- `docs/006-deployment.md` 及其译文：Windows 服务管理、凭据目录、准备命令示例、`%USERPROFILE%` 和 `C:\...` 这样的路径，以及仅 Windows 会出现的故障排查条目。
- `examples/profile.cordis.patch.yml`：增加一个 Windows 的 `stateDir` 示例；不做结构性改动。
- `locale/*.json`：准备命令提示目前说命令用 `sh` 运行；改成不限定平台。
- 保持文档诚实：只有在 WP5 和 WP7 通过后才把 Windows 标为受支持，并说明隔离方面的注意事项。

### WP5：Windows 测试与 CI

- 给读取 `process.platform` 的 helper 增加 platform 参数，并在 Linux 上对 Windows 命令生成、shim 文本、PATHEXT 解析和探测构造做单元测试。
- 围绕 Node 假实现重写服务脚本测试；如果保留 Python 脚本，就为 POSIX 路径保留 POSIX 测试。
- 在 Windows 上梳理 `pnpm check`：许多测试使用 POSIX fixture、`:` PATH 分隔符、`python3` 和 `#!/bin/sh` helper。只有在 Windows 专用测试覆盖同一行为时，才在 Windows 上跳过 POSIX 专用测试，并在测试中记录原因。
- 增加一个 Windows runner，例如一个 GitLab runner tag 或定时 job，运行 `pnpm check`，如果可行，再对一个临时仓库跑冒烟测试。没有它，Windows 支持会逐渐失效。

### WP6：Windows 上的飞书，可选

npm 的 `lark-cli` 是 `.cmd`；飞书来源用 `spawn` 运行长期事件消费者，用 `Commands.run` 做一次性调用。通过 Node 启动器（包的 JS 入口）或原生可执行文件运行它，让消息文本不经过 shell 引号解析，并重新检查消费者在 Windows 上的停止行为——在那里，关闭 stdin 加 `kill` 会变成强制终止。如果飞书不在范围内，Windows 部署只支持 Git 来源，文档必须说明这一点。

### WP7：端到端验证与加固

一台干净的 Windows 机器、一个真实仓库和一张测试工单：setup 通过；一次提及创建工单；准备命令创建工作树；worker 使用 `pwsh`；智能体编辑文件、提交并推送；合并请求被打开；面板显示结果；`start`、`status`、`stop` 和 `restart` 与 Linux 上一致；`stop` 是优雅的；日志被写入。在 Linux 上重跑同一张工单，确认没有回归。检查 Windows 特有的陷阱：PATH 长度、路径中的空格和括号、隔离 git 配置下的换行符、新脚本的可执行位、仓库使用符号链接时的行为，以及 260 字符的路径限制。

### 备选方案

- 保留 Python 服务脚本并增加 PowerShell 孪生脚本：对现有 POSIX 路径风险更低，但要同步维护两套实现。
- 使用 `.cmd` 包装加 `cmd.exe`：设置改动最小，但参数引号解析对 JSON 和消息文本不安全。
- 在 Windows 上用 Git Bash 运行 worker：消除部分外壳差异，但仍要解决服务脚本问题，并让部署依赖 bundle 本来不使用的 MSYS2 环境；除非修改 Windows preset，否则 worker 仍然跑在错误的外壳上。
- 什么都不做：保留 Linux 或 WSL2 主机，除非必要性测试通过，否则这就是建议。

## 工期估算

### 假设

- 一名了解本仓库的开发者，有一台可以安装 Node、git 和 CLI 的 Windows 机器，以及一个测试仓库。
- 不需要改动 DSH 上游；固定的 DSH 版本已经支持 Windows。
- 飞书是可选的；GitLab 或 GitHub 来源是底线。
- 估算覆盖移植及其测试，不包含对策略、面板或存储的重新设计。

| 阶段 | 内容 | 人日 | 一名开发者的日历时间 |
| --- | --- | --- | --- |
| 概念验证 | WP0；测量三个不确定领域 | 1-2 | 1-2 天 |
| 可用的内部版本 | WP0-WP4 和 WP7；不含飞书，不含 Windows CI | 9-13 | 2-2.5 周 |
| 完整对齐 | WP0-WP7 | 12-18 | 3-4 周 |
| 含缓冲 | 在完整对齐上增加 20-30% | 15-23 | 3.5-5 周 |

### 日历

可用的内部版本约需 2-2.5 周的专注工作；完整对齐版本约需 3-4 周，含缓冲为 3.5-5 周。兼职会大致按比例拉长日历。如果概念验证发现 DSH 层面的阻塞，停止并重新估算；目前预计没有。

## 验证

### 验收标准

- 在一台干净的 Windows 机器上，`pnpm check` 通过（带有记录在案的 Windows 跳过项），服务可以启动、报告状态、优雅停止并重启。
- 来自 Git 来源的一张真实工单端到端完成：setup、工单、准备、worker 回合、提交、推送、合并请求、面板状态和来源会话中的答复。
- 同一提交在 Linux 上仍然通过同一流程；现有安装的行为没有变化。
- 文档说明受支持的范围、前置条件和隔离方面的注意事项。

### 测试矩阵

| 领域 | Linux | Windows | 方法 |
| --- | --- | --- | --- |
| 单元与集成测试 | 必须 | 必须 | `pnpm check`，以及针对 Windows 生成的 platform 参数测试 |
| 服务生命周期 | 必须 | 必须 | 测试中使用假 DSH 和 HTTP；WP7 中使用真实 DSH |
| CLI 调用与 blocked commands | 必须 | 必须 | 针对 argv、PATHEXT 和 `.cmd` 的单元测试；WP7 中使用真实 CLI |
| 准备命令 | 必须 | 必须 | WP7 中真实创建工作树 |
| 飞书（如果在范围内） | 必须 | 必须 | WP7 中的机器人事件与消息，可选 |

## 风险与待定决策

### 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `cmd.exe` 的引号解析破坏 JSON 或消息文本 | API 调用错误、合并请求内容损坏 | 使用原生可执行文件和 argv，不用 shell 字符串；`cmd.exe` 只用于启动 `.cmd` |
| 没有可移植的优雅停止 | worker 被强杀、回合丢失 | 通过 `ctx.appExit` 增加 `service/stop` 路由；保留 POSIX 信号后备 |
| Windows 的路径、换行符、可执行位或符号链接改变提交 | 脚本损坏或合并请求出现噪声 diff | 在 WP7 中验证；显式设置隔离的 git 配置；必要时用 `git add --chmod=+x` |
| 双平台漂移 | Windows 悄悄失效 | Windows CI 和冒烟测试；platform 参数单元测试 |
| 隔离更弱 | worker 可能以运营者身份行动 | 保留专用操作系统账号的建议；blocked commands 仍然只是护栏 |
| 飞书的 npm `.cmd` 启动器 | Windows 上飞书不可用 | Node 启动器或原生 CLI；飞书保持可选 |

### 待定决策

- 是否要移植；上面的必要性测试是门槛。
- Node 服务脚本还是 PowerShell 孪生脚本。
- 飞书是否进入首个版本，还是作为后续工作。
- 账号配置是改为 `configDir` 设置，还是在 POSIX 上保留包装脚本、在 Windows 上用环境变量。
- 是否有可用的 Windows CI runner；没有的话，把 Windows 标为实验性。

## 不在范围内

- Windows 桌面应用、每个开发者一个智能体，或一个服务对应多个仓库。
- 超出当前原型模型的加固：真正的沙箱、密钥管理或多用户隔离。
- 改动 DeepSeek Harness 上游、策略模型、面板或数据库格式。
- macOS 以及其他超出附带 bash 路径的平台。

## 建议

现在不要移植。智能体是共享服务，Windows 用户已经可以通过面板和飞书使用它；当前的 Linux 或 WSL2 主机足够。把这份方案留到出现仅 Windows 工具链、硬性的不能用 WSL 或没有 Linux 主机，或者产品上要求 Windows 的时候；届时先做概念验证，用实测结果在内部版本和完整对齐之间做选择。