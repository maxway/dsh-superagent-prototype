# 009 Windows 部署：必要性与适配方案

[English](../009-windows-deployment.md) | **简体中文**

本文回答两个问题：dsh-superagent 是否应该支持在原生 Windows 主机上运行，以及要支持它需要做什么。对这个项目，答案是肯定的：worker 必须在自己的工单目录里运行 Unity batchmode、打 Windows exe 包并跑冒烟测试，Windows 专用的 DSH skill 也在那里运行。下面是实施路径，不是已支持的部署；分析部分也记录了在什么情况下答案会是否定的，项目变化时决策仍然可读。

问题在于主机，而不在于谁能使用智能体。所有用户都在浏览器中打开面板，并在来源会话里提到智能体，因此 Windows 桌面从来不需要在本地运行一份服务。

## 概要

- **本项目需要。** worker 必须在自己的工单目录里运行 Unity batchmode、打 Windows exe 包并跑冒烟测试，而且它们的 DSH skill 调用仅 Windows 的工具。主机必须是 Windows；WSL2 无法让 Windows Editor 打开 Linux 工作树，纯 CI 循环也给不了 worker 所需的本地构建和冒烟测试循环。
- **工期：** Unity 构建和 exe 冒烟测试增加了 WP8 和 WP9。可用的内部版本约 13-21 人日，即一名开发者 3-4 周，不含飞书和 Windows CI；完整对齐（含飞书和 Windows CI）约 16-26 人日，即 3-5 周；为所选范围增加 20-30%，完整对齐达到 19-34 人日，即 4-6.5 周。
- **Windows CI runner 仍然有用：** 它可以在每个合并请求上跑较重的完整构建和测试套件，但不能替代工单目录里的本地 batchmode 和 exe 冒烟循环。
- **建议：** 移植；先做 2-3 天的概念验证，在目标 Windows 机器上完成一次真实的 batchmode 构建和一次 exe 冒烟测试，然后按 WP0-WP9 的顺序执行。在承诺完整排期之前，确认 Unity 版本、Windows 构建目标、许可证和冒烟测试定义。

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
| 仓库是 Unity 项目，agent 必须在本地跑 batchmode、打 exe 包并跑冒烟测试 | 必须：本项目的场景；主机需要 Windows、Unity、构建工具链和许可证 | 移植，包含 WP8 和 WP9；这是选定的路径 |
| 仓库是 Unity 项目，Unity 工作只能放在 CI 里，agent 留在 Linux | 成本更低，但给不了本项目需要的本地构建和冒烟循环 | 作为补充的 CI runner，而不是替代 |

### Unity 项目

Unity 项目让主机问题变得具体。Unity 提供 Windows、macOS 和 Linux 的 Editor，但这个项目需要 Windows Editor 和 Windows 构建目标：worker 运行 Unity batchmode 来编译、打 Windows player 包并执行冒烟测试。本节其余部分记录边界和考虑过的选项。

- **本地 batchmode 就是工作流。** worker 需要 Editor、项目的 Windows 构建支持、许可证和构建脚本，都在自己的工单目录里；它产出的 exe 是冒烟测试的对象。CI runner 不能替代这个循环，尽管它也可以为每个合并请求构建和测试。
- **WSL2 不是替代品。** Windows Editor 必须打开 Windows 路径，因此 `/mnt/c` 下的 WSL2 检出会很慢，会遇到文件锁和换行符问题，而且仍然需要 Windows 侧的 Unity 和许可证。主机就是 Windows。
- **Windows CI runner 仍然值得有。** 它可以在每个合并请求上跑较重的完整构建和测试套件，agent 做本地迭代；两边使用相同的 Unity 版本、许可证和构建脚本。
- **Unity 很重。** 每个新工作树都会导入自己的 `Library`；构建需要许可证、Windows 构建支持，通常还需要 Visual Studio/IL2CPP 工具链、磁盘空间和 `git-lfs`，并且要小心 `.meta` 文件和 YAML 场景/预制体。热 `Library` 或 Unity Accelerator 能降低导入成本；冒烟测试需要明确的通过标准、显示或 `-nographics` 方案，以及捕获的 player 日志。

在承诺排期之前，确认 Unity 版本、Windows 构建目标（例如 Win64 加 IL2CPP 或 Mono）、已安装的模块和许可证、冒烟测试定义，以及预期的构建时间。

### 支持成本

移植不是一次性成本。移植之后，每次改动都要在两个平台上检查；worker 外壳不同（`bash` 和 `pwsh`），所以提示词、技能和测试都需要能识别平台的文本；必须有一个 Windows runner 来保证它不会悄悄退化；而且隔离能力更弱，因为 blocked-command shim 只是护栏，真正的边界仍然是专用的操作系统账号。对于一个仓库、一个共享服务的研究原型来说，除非上面某个场景确实成立，否则这份成本换来的价值很小。

### 结论

**这个部署需要。** worker 必须在自己的工单目录里运行 Unity batchmode、打 Windows exe 包并跑冒烟测试，而且它们的 skill 执行仅 Windows 的命令；因此 agent 主机必须是 Windows。这正是前面分析命中的触发条件，下面的方案适用。先做概念验证，包含一次真实构建和冒烟测试，因为 Unity 的许可证、导入和构建时间是最能改变排期的部分。

## 适配方案

### 原则

- 两个平台保持一种行为，并保持 POSIX 路径可用；Windows 部署不能改变现有 Linux 安装的行为。
- 使用平台原生机制，而不是模仿 POSIX：worker 外壳和准备命令用 `pwsh`，只在必须启动 `.cmd` 文件时用 `cmd.exe`，受控关闭用 DSH 的 `ctx.appExit`。
- 像 DSH 那样，把平台差异收进带 platform 参数的小 helper 中，使分支可以在 Linux 上做单元测试。
- 把移植当作原型质量的变化：不新增运行时依赖，除非某个字段不可避免，否则不做设置迁移，也不改动数据库格式。

### 工作包

| 工作包 | 范围 | 人日 | 依赖 |
| --- | --- | --- | --- |
| WP0 | 在真实 Windows 机器上做概念验证，包含一次 Unity 构建和 exe 冒烟测试 | 2-3 | — |
| WP1 | 服务生命周期：start、status、stop、restart、日志、锁 | 2-3 | WP0 |
| WP2 | CLI 与 worker 环境：探测、shim、包装、blocked commands | 2-3 | WP0 |
| WP3 | 准备命令、路由工具、提示词与技能 | 1-1.5 | WP2 |
| WP4 | 安装与部署文档，两种语言 | 1.5-2 | WP1-3 |
| WP5 | Windows 测试与 CI | 2-3 | WP1-4 |
| WP6 | Windows 上的飞书，可选 | 1-2 | WP2 |
| WP7 | 端到端验证与加固 | 1.5-2 | WP1-5 |
| WP8 | Windows 上的 Unity 构建集成 | 2-4 | WP2、WP7 |
| WP9 | Windows exe 冒烟测试脚本 | 1-2 | WP8 |

### 分阶段执行

工作包是技术拆解；下面的阶段是执行与验收顺序。每个阶段以可审查的改动和一次检查结束，只有上一阶段的验收通过后才开始下一阶段。阶段 0、4、6 需要装有 Unity 的 Windows 机器；阶段 1、2、3、5 可以在 Linux 上用 platform 参数开发和测试。

| 阶段 | 范围 | 验收 | Windows 主机 |
| --- | --- | --- | --- |
| 0 | 在目标机器上做概念验证 | DSH、面板和 pwsh 工具加载；测量 setup 的阻塞点；完成并计时一次 Unity batchmode 构建和一次 exe 冒烟测试；记录 go/no-go | 需要 |
| 1 | 服务生命周期：Node 服务脚本、`service/stop`、日志、锁和测试 | `pnpm check` 通过；Linux 上 `start`、`status`、`stop`、`restart` 行为不变；停止路由有单元测试；POSIX 行为无变化 | 不需要；随后做 Windows 冒烟 |
| 2 | worker 命令层：平台命令运行器与探测、Win32 shim、`PATHEXT`、blocked commands、账号选择 | 单元测试覆盖生成的文件和参数处理；POSIX 行为不变；人工审查生成的 `.cmd` | 不需要 |
| 3 | 准备命令、路由工具、提示词与技能：`pwsh` prepare、路由白名单、等待守卫、不限定外壳的措辞 | 测试通过；Linux 保留 `sh` 路径；Windows 命令有文档 | 不需要 |
| 4 | Unity 构建和 exe 冒烟脚本：batchmode 构建、输出路径、冒烟脚本、缓存与清理 | 在阶段 0 的机器上，真实构建产出 exe，冒烟脚本能正确通过和失败 | 需要 |
| 5 | 安装与部署文档：Windows 前置条件、服务、凭据、准备命令和故障排查，两种语言 | `pnpm check` 和文档测试通过；人工审查 Windows 路径 | 不需要 |
| 6 | Windows CI 与端到端验证，飞书可选 | Windows runner 运行 `pnpm check`；真实工单完成 setup、构建、冒烟、提交、推送和合并请求；Linux 仍然通过 | 需要 |

### WP0：概念验证

在一台干净的 Windows 11 或 Windows Server 机器上，安装 Node 22.19+ 或 24、pnpm、git、PowerShell 7、带 Windows 构建支持的 Unity Editor（如果目标使用 IL2CPP，还包括 Visual Studio/IL2CPP 工具链），以及 [006 部署](006-deployment.md)中固定的 DSH 版本。创建 `superagent` profile，用 `link:` 添加 bundle，打开面板，确认 Web profile、`pwsh` 工具和隔离设置都能加载。然后测量四个不确定领域：setup 的 `env` 探测、用 `.cmd` 包装的 `execFile`/`spawn` 调用、`sh -c` 下的准备命令，以及从工作树执行一次真实的 Unity batchmode 构建加一次 exe 冒烟测试。每个领域都有实测答案和大致耗时后结束；如果 DSH 或 Unity 跑不起来就停止，因为任一都会改变整个估算。

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

### WP8：Unity 构建集成

本项目需要。在 Windows 主机上：

- 安装项目使用的精确 Unity Editor 版本和模块，包括 Windows 构建支持；如果目标使用 IL2CPP，还包括 Visual Studio/IL2CPP 工具链和 Windows SDK；为 batch mode 激活许可证。许可证是运营者步骤，可能是最长的前置时间。
- 把项目的 batch mode 命令写进仓库的 `AGENTS.md`，让每个 worker 运行相同的构建和测试：`Unity.exe -batchmode -nographics -quit -projectPath <worktree> -buildTarget Win64 -logFile <log> -executeMethod <BuildMethod>`，以及 Unity Test Framework 的 `-runTests`、`-testPlatform`、`-testResults` 形式。
- 把 player 构建到仓库之外的已知输出路径，确保它不会被提交；把构建日志和工单放在一起；exe 是冒烟测试的输入。
- 把构建当作长时间运行：放到后台运行，通过 `job_output` 等待，并在提示词里告诉 worker，前台 shell 会在五秒后把命令转入后台。
- 规划缓存：新工作树会导入自己的 `Library`。使用热模板、Unity Accelerator 或专用构建缓存；不要在并发工单之间共享同一个正在使用的 `Library`。
- 覆盖 Windows 运维细节：`git-lfs`、长路径、为工作树、Unity 和新生成的 exe 配置杀毒软件排除项、260 字符路径限制、文件锁，以及 Unity YAML 合并（`.meta`、场景、预制体）。
- 用项目真实构建目标和一次 EditMode 或 PlayMode 测试运行来验证；把确切命令记录在仓库里，避免 agent 重新摸索。

### WP9：Windows exe 冒烟测试

冒烟测试是项目特定的定义，不是通用检查。和项目团队一起确定：

- 约定通过标准：exe 启动并以选定的退出码退出、到达已知场景或日志行，或通过脚本化的输入序列；捕获 player 日志以及任何截图或产物。
- 给 exe 一个可以无人值守运行的命令行模式或测试入口；优先选择也能在 `-nographics` 或虚拟显示下工作的方式。如果游戏需要 GPU 或可见窗口，就在有相应条件的机器上运行，并把它写进前置条件。
- 把启动、超时、日志捕获和清理封装成一个 worker 能从工单目录运行的脚本；失败时返回非零退出码和相关的日志尾部。
- 不要让 exe 和日志进入仓库；清理旧构建，并阻止杀毒软件隔离新生成的 exe。
- 用一次故意失败的构建或冒烟测试来验证脚本，使红色结果能和脚本自身的错误区分开。

### 备选方案

- 保留 Python 服务脚本并增加 PowerShell 孪生脚本：对现有 POSIX 路径风险更低，但要同步维护两套实现。
- 使用 `.cmd` 包装加 `cmd.exe`：设置改动最小，但参数引号解析对 JSON 和消息文本不安全。
- 在 Windows 上用 Git Bash 运行 worker：消除部分外壳差异，但仍要解决服务脚本问题，并让部署依赖 bundle 本来不使用的 MSYS2 环境；除非修改 Windows preset，否则 worker 仍然跑在错误的外壳上。
- 什么都不做：保留 Linux 或 WSL2 主机；对本项目不可行，因为需要本地 Unity batchmode 和 exe 冒烟测试。

## 工期估算

### 假设

- 一名了解本仓库的开发者，有一台可以安装 Node、git 和 CLI 的 Windows 机器，以及一个测试仓库。
- 不需要改动 DSH 上游；固定的 DSH 版本已经支持 Windows。
- 飞书是可选的；GitLab 或 GitHub 来源是底线。
- 估算覆盖移植及其测试，不包含对策略、面板或存储的重新设计。
- 这个项目需要带 Windows 构建支持的 Windows Editor；如果目标使用 IL2CPP，还需要 Visual Studio/IL2CPP 工具链；需要 batch mode 许可证、热 `Library` 或 Unity Accelerator；如果冒烟测试需要，还需要 GPU 或显示。
- 冒烟测试定义和 Windows 构建目标是已知的；如果未知，概念验证必须先定义它们，WP9 也会变大。
- Windows CI runner 对较重的构建有用，但不是本估算的前提，也不能替代本地循环。

| 阶段 | 内容 | 人日 | 一名开发者的日历时间 |
| --- | --- | --- | --- |
| 概念验证 | WP0；一次 batchmode 构建和 exe 冒烟测试 | 2-3 | 2-3 天 |
| 不含 Unity 的可用的内部版本 | WP0-WP4 和 WP7 | 9-13 | 2-2.5 周 |
| 含 Unity 和 exe 冒烟的可用的内部版本 | WP0-WP4 和 WP7-WP9；不含飞书，不含 Windows CI | 13-21 | 3-4 周 |
| 不含 Unity 的完整对齐 | WP0-WP7 | 12-18 | 3-4 周 |
| 含 Unity 和 exe 冒烟的完整对齐 | WP0-WP9 | 16-26 | 3-5 周 |

### 日历

概念验证需要 2-3 天。含 Unity 和 exe 冒烟的可用的内部版本约需 3-4 周的专注工作；完整对齐约需 3-5 周。为所选范围增加 20-30%；完整对齐于是达到 19-34 人日，即 4-6.5 周。兼职会大致按比例拉长日历。如果概念验证发现 DSH 层面的阻塞，或 Unity 无法授权并在 batch mode 下构建，停止并重新估算。

## 验证

### 验收标准

- 在一台干净的 Windows 机器上，`pnpm check` 通过（带有记录在案的 Windows 跳过项），服务可以启动、报告状态、优雅停止并重启。
- 来自 Git 来源的一张真实工单端到端完成：setup、工单、准备、worker 回合、提交、推送、合并请求、面板状态和来源会话中的答复。
- 同一提交在 Linux 上仍然通过同一流程；现有安装的行为没有变化。
- 带本地 Unity 构建时，从工单目录跑通一次真实的 Unity batchmode 构建和 exe 冒烟测试：构建产出 exe，冒烟脚本失败时返回非零，worker 能后台启动并读取结果。
- 文档说明受支持的范围、前置条件和隔离方面的注意事项。

### 测试矩阵

| 领域 | Linux | Windows | 方法 |
| --- | --- | --- | --- |
| 单元与集成测试 | 必须 | 必须 | `pnpm check`，以及针对 Windows 生成的 platform 参数测试 |
| 服务生命周期 | 必须 | 必须 | 测试中使用假 DSH 和 HTTP；WP7 中使用真实 DSH |
| CLI 调用与 blocked commands | 必须 | 必须 | 针对 argv、PATHEXT 和 `.cmd` 的单元测试；WP7 中使用真实 CLI |
| 准备命令 | 必须 | 必须 | WP7 中真实创建工作树 |
| Unity 构建与 exe 冒烟测试 | 通过 CI | 在 Windows 主机上 | WP7 中真实构建和冒烟测试；CI 路线使用项目 pipeline |
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
| Unity 许可证、Library 导入或 GPU 要求 | 构建被阻塞、缓慢或不稳定 | 先确认许可证和 runner；热 Library 或 Accelerator；`-nographics`；安装 git-lfs；为工作树配置杀毒排除项 |
| exe 冒烟测试需要 GPU 或显示，或不稳定 | 验证变红、误报失败 | 定义通过标准；优先 `-nographics` 或测试模式；必要时在有 GPU 的机器上运行；捕获日志和截图；区分脚本自身错误 |

### 待定决策

- 冒烟测试的定义和通过标准；WP9 依赖它们。
- Windows 构建目标和脚本后端，例如 Win64 加 IL2CPP 或 Mono，以及由此需要的模块和工具链。
- Node 服务脚本还是 PowerShell 孪生脚本。
- 飞书是否进入首个版本，还是作为后续工作。
- 账号配置是改为 `configDir` 设置，还是在 POSIX 上保留包装脚本、在 Windows 上用环境变量。
- Windows CI runner 是否也构建 exe 并跑冒烟测试；没有的话，本地主机必须两者都做。

## 不在范围内

- Windows 桌面应用、每个开发者一个智能体，或一个服务对应多个仓库。
- 超出当前原型模型的加固：真正的沙箱、密钥管理或多用户隔离。
- 改动 DeepSeek Harness 上游、策略模型、面板或数据库格式。
- macOS 以及其他超出附带 bash 路径的平台。

## 建议

本项目要移植。worker 必须在本地运行 Unity batchmode、打 Windows exe 包并跑冒烟测试，因此 agent 主机是 Windows。先在目标机器上做 2-3 天的概念验证；如果构建和冒烟测试通过、许可证到位，就按 WP0-WP9 执行。如果已有 Windows CI runner，保留它跑较重的完整构建和测试套件，但把它当作本地循环的补充，而不是替代。飞书仍然是可选项，可以作为后续工作。