# 006 部署

[English](../006-deployment.md) | **简体中文**

本指南用于安装、配置和运行 dsh-superagent。它涵盖账号、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 的基础上。

## 本检出的生产主机

目标生产主机是原生 Windows，使用固定检出目录 `F:\code\dsh-superagent-prototype`，以及与 Desktop 分离的 DSH 根目录。仅使用不同的 profile 并不能隔离工作区和会话存储。2026-11-08，操作员批准切换到 `C:\Users\dd\.dsh-superagent`，并将 `DSH_AGENTS_HOME` 设置为其中的 `agents` 子目录。本机 `C:\Users\dd\.dsh-superagent\service.ps1` 在 `start`、`stop`、`restart` 和 `status` 时设置这些变量；不带这些变量使用通用脚本可能重新使用 Desktop 的共享目录。原有专属状态目录仍位于新根目录之外的 `C:\Users\dd\.dsh\state\superagent`。启动报告显示运行时和飞书 ready、GitLab starting；根据操作员要求，切换后未独立验证工作区、会话恢复和端到端行为。这种分离不是操作系统安全边界。profile 直接链接 F: 检出；不要为了匹配包名而重命名目录。Windows profile 示例位于 `examples/profile.cordis.patch.yml`；POSIX / WSL 示例保留在 `examples/profile.posix.cordis.patch.yml`，供独立部署使用。历史 WSL 状态与工作树不是 Windows worker 目录，不得清理或在 Windows 上直接恢复。

Windows 进程不能安全依赖共享检出内 WSL 创建的依赖链接。应在生产服务停止、其他使用该依赖树的进程静止后，于最终路径准备并验证完整的 Windows 依赖安装。pnpm 的 `Already up to date` 不代表可用：用 Windows Node 构建并导入实际 bundle，再确认带 `x-orchestrator-request: 1` 的 `GET /orchestrator/api/state` 返回 200，并检查来源健康。仅监听 Web 端口不够。两种平台都需要运行时，应分离各自的依赖树。后台运行时还要确认服务与飞书消费者没有可见控制台，且含令牌的启动日志只允许目标用户和管理员访问。

## 运行哪些东西

- **一个专用的 DeepSeek Harness profile**，本指南中称为 `superagent`。从 Web profile 模板创建它。它加载 bundle，并在 `127.0.0.1` 上提供其面板。让它与你日常使用的 profile 分开：插件会改变进程范围的 `PATH` 和 git 设置，而且它的进程需要独立重启和升级。
- **一个智能体 GitHub 账号。** 智能体以这个账号发表评论、推送分支和打开 pull request，并通过一个只以该账号登录的 GitHub CLI 完成这些操作。
- **可选：** 一个用于聊天请求的飞书机器人。

插件配置保存状态目录和本机上限。其他一切都用面板：仓库和账号在来源中设置，允许名单在策略中设置，执行器（worker）目录和命令在执行中设置。

Windows 主机以原型质量支持 Git 来源和飞书来源。服务控制、worker 命令层、准备命令和路由工具的 Windows 路径已经实现。测试套件在 CI 中由项目的 Windows runner 运行，并通过记录在案的 POSIX 专用跳过项；真实的 Windows 启动/状态/停止/重启冒烟已通过；针对临时 GitLab 项目的真实工单也完成了端到端流程：Issue、工单、准备、PowerShell worker、提交、推送、合并请求和来源回复。飞书通过 npm `lark-cli` 的 `.cmd` shim 支持：宿主把它解析到 Node 入口，不经过 shell 运行；Windows 测试覆盖了这条路径。临时主机没有启用真实机器人，因为它不能持有飞书凭据。在 Windows 上，worker 和路由 Session 使用 `pwsh` 工具而不是 `bash`，准备命令也通过 PowerShell 7 运行。下面某一步在 Windows 上不同时，会给出它的 Windows 写法。

### 权限与隔离

bundle 为执行器定义了 `dsh-superagent-worker`，为主 Session 定义了 `dsh-superagent-router`。它们出现在 DeepSeek Harness 的预设列表中，但只供 dsh-superagent 使用。不要为个人 Session 选择它们，也不要禁用它们的配置行。应用需要它们来创建和恢复自己的 Session。

在 Web UI 中打开一个空白的托管 Session 时，可能会选中该 profile 的默认预设。dsh-superagent 会在第一轮之前恢复其角色专用预设。

两个预设都以运营者的操作系统用户身份、以 `danger-full-access` 运行，并读取已订阅线程中的消息。账号包装器默认选择智能体的凭据；它们不隔离进程。执行器可以按路径执行程序，并读取运营者的主目录。若要隔离，请使用一个只包含智能体凭据的专用操作系统账号。Windows 上同样如此，而且没有操作系统沙箱：`.cmd` shim 只是拦截命令，因此请为服务使用一个只持有智能体凭据和仓库访问权限的专用 Windows 账号。Windows 路径已在临时项目上通过端到端运行，测试套件也在 CI 中运行；隔离方面的注意事项仍然适用。

## 前置条件

- Node.js 24.9+、pnpm 和 git 2.32+（Windows 主机用 Git for Windows）。POSIX 上还需要 tmux；Windows 上需要 PowerShell 7（`pwsh`），不需要 tmux 或 Python。
- 使用 GitHub 部署时，GitHub CLI（`gh`）2.48 或更高版本；使用 GitLab 部署时，GitLab CLI（`glab`）。来源的 CLI 字段必须指向智能体 CLI 的命令名或绝对路径（`gh`、`glab` 或 `lark-cli`；POSIX 上通常是包装脚本）；宿主依赖它们的子命令和输出格式。
- **Windows 主机：** 使用原生的 `gh.exe` 或 `glab.exe`，按下文 Windows 凭据一节以智能体账号登录。不要使用 `.cmd` 包装脚本。
- github.com 上的一个仓库，或 gitlab.com / 自建实例上的一个 GitLab 项目；不支持 GitHub Enterprise Server。要为每个工单创建检出，请保留一个本地克隆，让准备命令能从其中添加工作树。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- 为 DeepSeek Harness 配置的模型服务商。dsh-superagent 使用该 profile 的默认模型，除非评估或执行设置指定了另一个。请在实际部署的 profile 中配置；它不会继承你日常使用 profile 的账号凭据或服务商配置，没有配置服务商时会报缺少凭据，无法研判请求。
- 使用飞书时：`lark-cli`（已用 1.0.90 测试），以及一个带机器人的飞书或 Lark 应用。Windows 上请安装 npm 包 `@larksuite/cli`；宿主会把它的 `.cmd` shim 解析到包的 Node 入口。

## 账号

### 智能体 GitHub 账号

1. 为智能体创建一个 GitHub 用户账号，并授予它对仓库的写权限。GitHub App 不能充当智能体，因为 dsh-superagent 会读取该账号的通知。
2. 给它一个只使用自己凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以智能体账号登录；最后一条命令会打印其登录名。dsh-superagent 也以同样的方式读取登录名。Windows 上请改用原生 CLI 和它的配置目录，见下面的 Windows 凭据。

### 智能体 GitLab 账号（GitLab 部署）

1. 为智能体创建一个 GitLab 用户账号，并在项目上授予至少 Developer 角色；GitLab 免费版的 Developer 角色即可推送分支和创建合并请求。如果要使用可选的 GitLab webhook，还需要 Maintainer 角色。
2. 给它一个只使用自己凭据的 GitLab CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/glab-agent <<'EOF'
   #!/bin/sh
   GLAB_CONFIG_DIR="$HOME/.config/glab-agent" exec glab "$@"
   EOF
   chmod +x ~/.local/bin/glab-agent
   glab-agent auth login --hostname gitlab.example.com
   glab-agent api user
   ```

   这里要写自建实例的 host，不是 `gitlab.com`；来源里的 GitLab 地址必须使用同一 host 和协议：HTTPS 写 `https://gitlab.example.com`，HTTP 写 `http://gitlab.example.com`，worker 的 git credential helper 会按这个协议配置。`glab auth git-credential` 需要 glab 1.36 或更新版本；可用 `glab-agent auth git-credential --help` 检查，命令不存在就升级 glab。实例使用私有 CA 时，让 glab 和 worker 的 git 都信任它（git 可在服务环境里设置 `GIT_SSL_CAINFO`，或把 CA 装进操作系统信任库）。Windows 上请改用原生 CLI 和它的配置目录，见下面的 Windows 凭据。

3. 一个部署只有一个生效的 Git 来源。在 profile 的 `cordis.patch.yml` 中安装两个 Git 来源插件（`dsh-superagent-github` 和 `dsh-superagent-gitlab`），这样二者都能在面板里配置并设为生效；只安装一个也能继续工作。在 **来源** 中配置当前使用的 Git 来源。来源页会显示当前生效的宿主和仓库；要换到另一个宿主，配置它的卡片，然后点 **切换到此来源**。

切换是一个动作：dsh-superagent 先检查目标账号和仓库，然后只重启一次。旧宿主上还有未结束工单时，切换会列出它们，并要求明确确认或先停止。工单会记录接受时使用的 Git 宿主，因此不能换到另一个宿主上恢复：在另一个宿主上恢复会被报告为失败；切回原宿主后可以继续。状态目录会保留两个宿主的记录，切回时可以继续使用。

### Windows 凭据

Windows 主机用配置目录而不是包装脚本来选择智能体账号。不要为 `gh` 或 `glab` 写 `.cmd` 包装脚本：它会把每个参数都经由 `cmd.exe` 转发，破坏 JSON 和消息文本。用配置目录以智能体账号登录原生 CLI，然后把同一个目录填进来源的 **智能体账号的配置目录** 高级字段；留空则使用下文所示的默认目录。把来源的 `cli` 字段设为原生可执行文件 `gh` 或 `glab`，不要指向 `.cmd` 包装脚本。插件和它的 worker 会继承这个目录，因此二者使用同一个账号。

GitHub：

```powershell
$env:GH_CONFIG_DIR = "$env:USERPROFILE\.config\gh-agent"
gh auth login
gh api user --jq .login
```

GitLab：

```powershell
$env:GLAB_CONFIG_DIR = "$env:USERPROFILE\.config\glab-agent"
glab auth login --hostname gitlab.example.com
glab api user
```

### GitLab webhook（可选）

GitLab 来源默认按 `pollSeconds`（默认 60 秒）轮询，变更最长要一个轮询间隔才会被处理。如果部署主机有一个 GitLab 能访问、且长期不变的地址（通常是固定 IP 或固定域名），可以让 GitLab 的事件直接唤醒一次同步，把延迟降到几秒；不配置时来源仍按轮询工作。

1. 在 **来源** 的 **Webhook 地址** 填入 GitLab 能访问的完整地址，例如 `http://192.168.1.20:3084/gitlab/webhook`。其中的路径就是监听路径。高级字段 **Webhook 监听端口**（默认 3084）和 **Webhook 监听地址**（默认 `0.0.0.0`）决定本机监听；若 HTTPS 由反向代理终止，Webhook 地址写代理的地址，监听端口仍是这个本机端口。
2. 智能体账号需要项目上的 **Maintainer** 角色，因为只有它能管理项目的 webhook。设置保存后，来源会在下一次轮询时（通常一分钟内）在项目里自动创建或更新这个 webhook，并订阅 Issue、合并请求、评论和流水线事件；token 由 dsh-superagent 生成并保存在状态目录，无需手工在 GitLab 中填写。
3. 在防火墙中只允许 GitLab 访问这个端口。监听器只在配置的路径上接受 POST，token 不匹配返回 401；它不解析事件内容，收到事件后让下一次轮询立刻开始，因此轮询和各类读取仍是唯一的数据来源。如果地址是私有 IP，自建 GitLab 还要在管理区允许对本地网络的出站请求（并允许这个地址），否则 GitLab 会拒绝投递。
4. `pollSeconds` 继续作为兜底：webhook 未配置、被 GitLab 停用或配置失败时，来源按轮询工作；配置失败会显示在来源健康状态里，并按五分钟重试。清空 **Webhook 地址** 会停用并删除这个来源创建的项目 webhook。

### 飞书机器人（可选）

Windows 上 npm 安装的 `lark-cli` 是 `.cmd`。宿主会解析 shim 的 `%dp0%` Node 入口并用 Node 运行它，因此消息文本和 JSON 从不经过 `cmd.exe`。没有 Node 入口的 `.cmd` 会被拒绝；请使用 npm 包或原生可执行文件，不要用自定义包装脚本。

1. 创建一个带机器人能力的自建应用。授予它接收消息事件和以机器人身份发送消息的权限，然后发布应用版本。它不需要读取消息、聊天历史、群或群成员的权限：来源只使用事件携带的内容并回复。被移除的读取路径会调用需要 `im:message`、`im:message:readonly`、`im:message.history:readonly`（消息）以及 `im:chat`、`im:chat:readonly`、`im:chat.group_info:readonly`、`im:chat:read`、`im:chat.members:read`（群和成员）的接口；当前版本不再调用它们。因此它无法补收 dsh-superagent 离线期间的消息，无法按 ID 读取消息或话题，无法列出群或同步成员，也无法读取图片。群 chat_id 和允许名单需要手工填写。为群选择**全部消息**还需要飞书“接收群内全部消息”的权限；没有该权限时只会收到 @ 机器人的消息。
2. 给机器人一份自己的 `lark-cli` 配置，限制为机器人身份；在 POSIX 上再提供一个包装脚本：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   在 Windows 上安装包，并把来源的 **机器人的 lark-cli** 字段指向 `lark-cli`（npm 的 `.cmd` shim），高级配置目录指向 `%USERPROFILE%\.lark-cli-dsh-superagent`：

   ```powershell
   npm install -g @larksuite/cli
   $env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.lark-cli-dsh-superagent"
   lark-cli config init --app-id <cli_…> --app-secret-stdin
   lark-cli config strict-mode bot --global
   ```

   第一条命令从标准输入读取应用密钥（PowerShell 中用 `Get-Content secret.txt | lark-cli config init ...`）。请使用单独的配置目录：`lark-cli` 每个应用 id 只允许一个 profile，而你的个人配置可能已经包含该应用的用户登录。

   宿主会拒绝能充当用户的 CLI。它从机器人配置中读取应用 id、飞书/Lark 品牌和机器人的 `open_id`。

   两份配置共享应用密钥的钥匙串条目。要只删除机器人配置，请删除它的目录；不要运行 `lark-cli config remove`，那会影响共享的密钥。

## 安装

在一台还没有 `superagent` profile 的机器上运行一次这段内容：

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本是公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条安装这个 bundle。设置 `DSH_HOME` 可以改变默认的 `~/.dsh` 目录位置。

Windows 上用 PowerShell 运行同一段内容，把 `> /dev/null` 换成 `> $null`；`$PWD` 是检出的原生路径，因此安装的链接形如 `link:C:\...\dsh-superagent`。`dsh` 是 npm 的 `.cmd` shim，除非用 `DSH_HOME` 改变位置，profile 位于 `%USERPROFILE%\.dsh\profiles\superagent`。

只在全新安装时运行创建 profile 的命令。如果 profile 已存在，该命令会替换它并删除它的 `cordis.patch.yml`，包括本机配置。不要用它来升级。

## 本机配置

把 [examples/profile.cordis.patch.yml](../../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换每一个 `<placeholder>`。Windows 上该文件位于 `%USERPROFILE%\.dsh\profiles\superagent\cordis.patch.yml`。使用飞书时，还要在那里启用 `dsh-superagent-feishu` 条目。`webserver` 条目设置面板的端口。

| 键 | 是否必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 原生绝对路径：数据库、锁、`worker-bin` 中的命令 shim、智能体的 git 配置，以及默认情况下 `work` 中的工单目录。POSIX 上例如 `/home/me/.dsh/state/superagent`；Windows 上例如 `C:\Users\me\.dsh\state\superagent`。WSL 路径对 Windows 主机不是原生路径。升级前备份它 |
| `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大大小，以及一次研判读取多少线程页、在多久内读完 |

首次启动后，在 **设置 → 部署** 或 DeepSeek Harness 插件管理器中修改本机上限。改动无需重启即可生效。`stateDir` 不能在那里修改。无效的值或未知的配置键会阻止启动；日志会指出是哪个键。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

Windows 上通过 Node 运行同一个脚本，因为该文件没有 `.cmd` shim：

```powershell
node scripts\dsh-superagent start
node scripts\dsh-superagent status
node scripts\dsh-superagent stop
```

`start` 在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`；其他 profile 则使用 `dsh-<profile>`。它最多等待一分钟，让运行时变为就绪或报告安装配置要求。首次运行时，它会打印缺失的安装配置信息。它会拒绝重复的实例，包括从这个脚本之外启动的实例。每个 profile 使用独立命名的 tmux socket。pane 使用调用者的 `DSH_HOME`、`HOME` 和 `PATH`（包括未设置的情况），并在启动 DSH 前清除 `TMUX` 与 `TMUX_PANE`，避免 worker 继承服务 socket。仅设置 `TMUX_TMPDIR` 不能覆盖继承的 `TMUX`；这些措施只是护栏，不是操作系统安全边界。

Windows 上，`start` 要求 `dsh` 在 `PATH` 上（npm 的 `.cmd` shim），以分离进程启动 `dsh --profile <profile> --no-open`，日志和控制文件与 POSIX 相同，并等待管理 API；它不使用 tmux。`status` 通过 Windows PowerShell（`powershell.exe`，Windows 自带）列出进程。`stop` 通过 `POST /orchestrator/api/service/stop` 让 DSH 退出，而不是发送信号；它最多等待五分钟，绝不会强制杀死进程。上面的 tmux socket 与 `TMUX` 细节只适用于 POSIX。两种平台使用相同的退出码、日志名和 `manually-stopped` 标记。

`stop` 和 `restart` 请求优雅 drain，并最多等待进程五分钟退出。执行器 drain 的上限是十秒，DSH 启动器再加五秒宽限，因此停止通常约十五秒完成；drain 之后仍在回合中的 worker 可能被打断。POSIX 上它们绝不会强制杀死进程，也不会碰其他 tmux 会话。

`status` 打印进程 id、健康状况和安装配置问题。要使用其他 profile 或端口，请用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`；PowerShell 中设置 `$env:DSH_SUPERAGENT_PROFILE` 和 `$env:DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 会以四种退出码之一退出：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 它没有运行、运行了两份、没有响应，或它的运行时报告错误；重启可能修复 |
| 2 | 它正在运行，但运行时以外的某个部分报告错误，例如某个来源或策略同步（`sync:<source id>`）；重启不能修复 |
| 3 | 它正在运行并等待安装配置；重启不能修复 |

仍在启动的来源算作正常运行。安装配置无法检查的飞书机器人也算。

`status` 在 `errors` 下返回失败的部分及其详情，在 `setup` 下返回安装配置要求。`start` 和 `restart` 会逐行打印这些问题；如果服务始终没有起来，它们以 1 退出。只有有意的 `stop` 会暂停自动恢复。

每个 profile 在 `.artifacts/` 下保存日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于脚本。保留最新的 20 个。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁和进程 id。

打开日志中打印的 URL，然后在侧边栏中选择 **Superagent**。

### 每小时检查

在你日常使用的 DeepSeek Harness profile 中创建每小时检查，而不是在 `superagent` 中。智能体服务停止时，它必须继续运行。让该 profile 中的智能体用下面这段提示词创建每小时计划，并填入检出路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 保留有意的停止。只有 `stop` 写入标记；`start` 清除它。`restart` 不写标记，因此该检查可以恢复一次关闭超时的重启。Windows 上使用同一段提示词，把命令换成 `node scripts\dsh-superagent ...`。

### 任务级巡检（Watchdog）

每小时检查看的是进程。任务级巡检看的是工作：所有进行中工单的阶段、最近报告、静默时长和机械信号。这项工作由服务之外的独立 Watchdog 完成，因此主服务停止时它仍能工作。服务原先自带介入设置、SQLite 决定审计与 `retry`/`stop` 路由；因为决定与报告归外部 Watchdog，这些内置实现已经移除，服务只保留只读观测面。

`GET /orchestrator/api/watchdog` 返回只读快照：服务状态、每个进行中工单的阶段、最近派工与报告、静默时长和机械信号，以及最近一次记录的观测（`lastRun`）。`scripts/dsh-superagent --profile superagent --url <面板 URL> watchdog` 打印同样的 JSON。快照命令只发送 GET；`--stale-minutes` 只改变它的信号阈值。

Watchdog 有要报告的事时，`scripts/dsh-superagent --profile superagent --url <面板 URL> watchdog report --chat <chat id>` 会通过飞书来源的机器人把观察汇总发到该飞书会话，让人在平时和机器人对话的地方直接看到。服务端用自己的实时快照渲染汇总：服务状态、带机械信号的进行中工单及其静默时长和最近报告；`--note "<一句话>"` 追加 Watchdog 自己的判断。目标会话必须是机器人所在的会话，飞书来源也必须已启用并配置好；报告不修改工单，也不受对话回复 100 词上限的限制。该命令调用 `POST /orchestrator/api/watchdog/report`，传入 `chatId`、`idempotencyKey` 和可选的 `note`。

每次巡检用 `scripts/dsh-superagent --profile superagent --url <面板 URL> watchdog run [--note "<一句话>"]` 记录一次观测。服务端从实时快照渲染观测并保留 30 天，因此 `watchdog runs [--limit <n>]` 可以列出最近的观测，`GET /orchestrator/api/watchdog` 用 `lastRun` 返回最新一次。记录观测不修改工单、不发送消息；有新的 `lastRun` 才能区分“安静正常”和“巡检没跑”。每次运行都要记一次，包括没有异常时。

### 独立 Watchdog 进程

`scripts/watchdog` 读取同一份只读快照，把每次观测记录成一次运行，把发生变化的机械发现报告给飞书，并维护自己的配置、状态和日志；它不需要 DSH，也不依赖运营者的 profile，主机看护与部署监督也放在这个进程里。创建 `watchdog.json`；其中的相对路径按该文件所在目录解析：

```json
{
  "url": "http://127.0.0.1:3083",
  "chatId": "oc_...",
  "report": true,
  "intervalSeconds": 900,
  "staleMinutes": 30,
  "dailyReport": { "hour": 9, "timezone": "Asia/Shanghai" },
  "stateDir": "watchdog-state"
}
```

在前台或进程管理器下运行 `node scripts/watchdog --config watchdog.json`，或由计划任务每 15 到 30 分钟运行一次 `--once`。`--status` 打印最近记录的状态；进程在 `stateDir` 下写 `state.json` 与 `watchdog.log`，运行期间持有 `watchdog.pid`。它每轮都记录一次运行，因此 `GET watchdog` 的 `lastRun` 与 `watchdog runs` 能看出它还活着；机械发现集合变化时才发报告。配置 `dailyReport` 后，无异常时每天上午还会发一次安静的日报，让人知道安静的服务仍在被检查；每本地日只发一次，有异常时的报告不受影响。它没有模型判断：报告工单信号、异常的服务部件和安装配置问题，执行器满载或服务暂停会解释掉相应的工单信号。服务停止时它只记录失败并继续检查，无法通过飞书机器人发报告（机器人属于服务）。

要让模型成本只发生在真正需要的轮次，可以用 `--gate` 按同样的间隔把它当作门控运行。门控轮次读取快照、记录这次观测；没有风险就退出 0，有风险就退出 2：工单信号、部件报错、安装配置未完成、ready 结果等待超过一天，或连续两次失败尝试。只有退出 2 时才运行完整 DSH agent 做详细判定，由 agent 自己记录观测并报告，因此 LLM 只在风险轮次产生费用。门控只发送配置好的安静日报，不发送发现报告，也不修改其他东西；`--status`、状态文件和日志会给出它的退出原因。主机检查项、有界恢复与部署监督（路线图工作流 K、L）后续也放进这个进程。

### 部署最新 superagent

主会话可以把操作者明确的部署请求发给独立 Watchdog，而不是自己发布任何东西。`orchestrator_deploy` 工具把请求写到 `DSH_SUPERAGENT_DEPLOY_REQUEST` 指定的文件，并执行 `DSH_SUPERAGENT_DEPLOY_COMMAND` 中的命令（例如 `schtasks /run /tn dsh-superagent-deploy`）；两个值未设置时工具关闭。独立的部署任务读取请求、核验操作者的原话，并在自己的进程里发布最新提交，主实例只负责重启。只有操作者明确要求部署 superagent（“部署superagent”）时才使用该工具；普通请求不会触发部署，主会话也从不自己备份、发布或重启。

部署尽量只做最必要的内容。还没有预构建候选的首次部署走完整受控发布（候选构建与验证、一致性备份、启动检查与回滚路径），会更慢。稳定期由 Watchdog 预构建并预验证最新提交，部署只做停机、切换构建好的 `lib` 与 `prompts`（以及 `scripts/watchdog`、`locale/` 等实际运行的变更文件）、启动和基础健康检查，保留上一版用于回滚，目标控制在一分钟内。代码质量由仓库检查和外部维护通道保证，因此跳过重复的全量测试与大范围检查。结果由 Watchdog 报告。首次部署（也就是安装这个命令本身）由操作员或 Watchdog 直接带上确认发起；运行中的 superagent 具备该工具和两个环境变量后，后续请求由主会话发送。

#### 部署复盘与提速

2026-11-09 的部署历史在 `C:\Users\dd\.dsh\watchdog\watchdog-deploy.log` 里，能看出时间花在哪。两次部署端到端都约十分钟：08:46:58 那次到 08:56:53，10:33:47 那次到 10:43:09。第二次服务约 10:40:56 停止、约 10:41:50 就绪，实际切换约 54 秒；其余时间几乎都在前期准备，而不是发布本身。准备阶段重复了部署早就知道的事：运行中的服务用哪个 DSH home 和 profile 目录、stateDir 与 bundle 链接在哪、已有的候选构建是否已经匹配目标树、哪些 watchdog 写入者需要暂停。请求本身也有歧义（“部署 !43 并设置两个环境变量”），监督器要先还原意图才能开始。

下次按这几点缩短前期准备：

1. 先运行一次 `node scripts/dsh-superagent status --profile superagent --url <面板 URL> --home <DSH home>`。`status` 现在会报告 profile 目录、`service.ps1`、配置的 `stateDir`、bundle 链接与目标、checkout 版本与分支，以及构建出的 `lib`；直接读这些，不再重新发现。
2. 每个目标版本只保留一份候选，并记录 revision、产物哈希与测试证据。候选 worktree 的 `git rev-parse HEAD^{tree}` 与目标树相同、构建产物也一致时直接复用；不要在维护窗口里重新构建或重跑全量测试。
3. 用同一份 `status` 输出确认服务空闲，并记录进行中与排队工单数。做一致性备份前暂停独立 Watchdog 的写入，服务恢复后按原方式恢复并核验。
4. 在“文件已切换、服务已停止”的状态停下。不要在部署 DSH agent 的 shell 工具里启动服务：Windows 上这个子进程属于 agent 的 Job 对象，会随 agent 退出被杀。外层部署任务要在 DSH 子进程退出后再启动服务，在 agent 之外等待就绪，然后才报告成功。
5. 把实测的停机、启动和就绪时间写进部署日志。日志就是复盘材料：慢的那次可以和上一次比较，切换本身应保持在一分钟内。

身份核验、备份、回滚准备与维护窗口仍由发布监督器负责；这些事实只缩短发现过程，不替代那些步骤。

## 设置

安装配置必须成功，轮询或工作才会开始。概览会列出缺失的要求，并链接到对应的设置。更改设置会再次运行安装配置。如果你在应用之外修复了某些东西，例如 CLI 登录，请选择 **重新检查**。

1. **来源。** 只启用一个 Git 来源。GitHub 部署设置仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`；请求通常通过智能体账号的通知到达，提到该账号的新 Issue 或评论会在下一次轮询时到达，通过编辑已有 Issue 正文来添加提及则不会，请改为发表新评论。GitLab 部署在 profile 中加入 GitLab 插件，在 GitLab 来源卡片里配置地址、项目和智能体 CLI（例如 `/home/me/.local/bin/glab-agent`），然后在来源页切换到它；它从启用时开始扫描项目里的 Issue、合并请求、note 和流水线变化。可选地设置 **Webhook 地址** 让 GitLab 事件立即触发同步（见上面的 GitLab webhook 一节），留空则退化为 `pollSeconds` 轮询。使用飞书时，设置机器人 CLI、群、每个群的接收全部消息或仅提及模式，以及是否接收私信。Windows 上把 CLI 设为原生 `gh` 或 `glab`，并设置高级的配置目录字段而不是包装脚本路径；见上面的 Windows 凭据。
2. **策略。** 两条示例规则可以编辑或删除。在 **在各来源上** 下，添加可以请求执行的 GitHub 或 GitLab 账号以及飞书用户；在名单里有人或某个范围开放只读答疑之前，任何请求都不能成为工单。使用飞书时，可以选择一个群来同步名单，在启动时和 **立即同步** 时进行。准入表还可以把某个群聊范围的「名单外 · 点名智能体」单元格设为**只读答疑**，让那里的任何人（包括机器人和智能体）提问，由智能体只读调查后回答，而不执行。私聊对名单外的人只提供“忽略”，仍只开放给名单内的人。
3. **执行。** 目录根路径和一个准备命令。要让每个工单都有一份仓库检出，GitHub 部署使用：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   GitLab 部署使用 GitLab 变量：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "$DSH_SUPERAGENT_GITLAB_HOST/$DSH_SUPERAGENT_GITLAB_PROJECT.git" "${DSH_SUPERAGENT_GITLAB_MR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   Windows 上用 PowerShell 7（`pwsh`）而不是 `sh` 运行准备命令，变量写作 `$env:DSH_SUPERAGENT_DIR`、`$env:DSH_SUPERAGENT_NAME` 等。GitHub 部署、克隆位于 `C:\src\widgets` 时：

   ```powershell
   $head = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { "HEAD" }
   git -C C:\src\widgets fetch --no-tags "https://github.com/$($env:DSH_SUPERAGENT_GITHUB_REPOSITORY).git" "${head}:refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   git -C C:\src\widgets worktree add -b "agent/$($env:DSH_SUPERAGENT_NAME)" "$($env:DSH_SUPERAGENT_DIR)" "refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   ```

   GitLab 部署把仓库和 head 变量换成 GitLab 的对应变量：

   ```powershell
   $head = if ($env:DSH_SUPERAGENT_GITLAB_MR_HEAD) { $env:DSH_SUPERAGENT_GITLAB_MR_HEAD } else { "HEAD" }
   git -C C:\src\widgets fetch --no-tags "$($env:DSH_SUPERAGENT_GITLAB_HOST)/$($env:DSH_SUPERAGENT_GITLAB_PROJECT).git" "${head}:refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   git -C C:\src\widgets worktree add -b "agent/$($env:DSH_SUPERAGENT_NAME)" "$($env:DSH_SUPERAGENT_DIR)" "refs/dsh-superagent/$($env:DSH_SUPERAGENT_TICKET)"
   ```

   把个人 CLI（例如登录你自己账号的 CLI）列为禁止调用的命令。工单结束后，只要它的 worktree 干净且每个提交都在远端（或 prepare 命令取回的 ref 上），执行器就会回收该链接 worktree 并删除本地 `agent/<name>` 分支；有未提交或未推送工作的目录会保留，恢复工单时会再次运行 prepare 命令。当工单自己打开的 pull request 全部合并时，执行器也会删除远端分支，但只限远端分支的顶端仍是本地 HEAD 的情况；否则远端分支保留。
4. **提示词。** 设置团队段落：GitHub 声明行、评审机器人、提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，智能体也可以调用它。`SETUP.md` 用它保存设置，服务脚本读取 `GET state`。

把请求发送到 `http://127.0.0.1:<port>/orchestrator/api/`，并带上 `x-orchestrator-request: 1`。主机必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头，或 `Origin` 来自其他站点，会收到 403。

通过 API 保存拥有与面板相同的权限。与通过主 Session 工具进行的保存不同，它们可以更改执行环境和安装配置账号字段。

智能体可以依赖这些路由和字段。`src/app/api.ts` 中的其他路由服务于面板，并随面板变化。

| 请求 | 返回 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`，包含 `problem` 和 `feishuProblem`，各自为 `null` 或一个带有 `place`、`code`、`values` 和 `detail` 的安装配置问题，以及安装配置解决后的 `accounts`；`health`，下面每个部分一个条目，包含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，执行器 Session 的 `running`、工单的 `queued` 和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，各自带有 `value` 和 `revision`；`sources`：来源实例，每个带有 `id`、`kind`、`installed`、其块的 `value`（`{"enabled": …, "config": {…}}`）和 `revision`、其类型的表单，以及有安装配置问题时的 `problem`；`policyVersion`；以及 `environment`，执行环境的 `root` 和 `variables` |
| `GET sources` | 每个来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分的 `health`、安装配置 `problem`、过去一天的 `stats`、当天它 `filtered` 的触发，以及当天它 `dropped` 的消息（最新的在前），每条带有 `channel`、`preview`、作为某个工单的消息时的 `ticket`（`id` 和 `title`）、存储中有它时的 `thread`，以及 `dropped.at` 和 `dropped.reason`（`channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，带 `{"value": …, "revision": n}` | 保存一个块：`saved`、该块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是整个块，与 `GET settings` 中的形式相同；缺失的键取默认值 |
| `POST executor/pause`，带 `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 再次运行安装配置：`restarting: true`。安装配置没有可修复项时拒绝 |
| `POST service/stop` | 请求 dsh-superagent 先 drain 执行器（上限十秒），再通过 DSH 启动器退出：`stopping: true`。启动器没有退出钩子时返回 500；服务脚本用它来避免依赖 POSIX 信号 |
| `POST policy-sync/<source id>` | 立即同步该来源的允许名单：`policy`，即保存的来源部分 |
| `GET prompts`、`PUT prompts`，带 `{"config", "baseRevision"}` | 读取提示词配置：`current`，带有 `revision` 和 `config`；`defaults`；`sections`，即团队段落，按 Session 读取的顺序排列；`skillName`，团队技能名称的模式；`builtin`，团队技能不能使用的名称；以及 `skillPrefix`，Session 加载技能名称时使用的前缀。或保存它：新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 重试或停止一个工单，与面板的行为一致 |

健康条目按职责分组：

| 条目 | 报告的内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 等待模型预算重试的 Session |
| `evals` | 过去一小时内未完成、之后没有得到研判或不再提示的评估 |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | 在 [003 执行](003-execution.md) 中描述的已存储工作；送达统计等待中的工作，而回复涵盖渠道消息 |
| `cleanup` | 结束工单的目录清理；它只删除干净且提交全在远端的检出，因此失败不会出现在健康面板上 |
| `worker` | 执行器 Session 的事件处理；在首次失败后出现 |
| `github`、`gitlab`、`feishu` | 来源轮询、webhook 和事件 |
| `sync:<source id>` | 允许名单同步 |

拒绝会带一个状态码和 `error`（其英文文本）：

- 400：无效的值（`issues`，每项带有 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 和 `values`），或请求体不是 JSON 或过大。
- 404：某个不存在的东西。
- 409：过期的修订。
- 500：其他任何情况。

这些块：

- `source:github`、`source:gitlab`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的配置有 `repository`、`cli` 和高级的 `configDir`（即选择智能体账号的 `GH_CONFIG_DIR`），以及开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`，默认关闭，它们接收仓库中每个新 Issue、新 pull request 和评论，以及默认分支的 CI。GitLab 的配置有 `host`、写作 `group/project` 的 `repository`、`cli`、`configDir`（`GLAB_CONFIG_DIR`）、可选的 `webhookUrl`、高级的 `webhookPort`（默认 3084）和 `webhookBind`（默认 `0.0.0.0`）、`pollSeconds`、`failuresBeforeError` 和同样的 observe 开关。飞书的配置有 `cli`、`configDir`（`LARKSUITE_CLI_CONFIG_DIR`）、`chats`（形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，或 `"all"`）、`directMessages`，以及 `otherChats`（`"none"` 或 `"mentions"`）。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 行以群 id 为键；飞书还用 `other` 或 `direct`，GitHub 用 `issues`、`pulls`、`comments` 或 `ci`；`unlistedAddressed` 单元格可取 `explicit`、`reply`、`inferred` 或 `ignore`，未设置的单元格取默认值（见 [002 授权机制](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`offPeak`、`directory`、`prepare` 和 `blockedCommands`。`offPeak` 默认是 `{"enabled": false, "start": "22:00", "end": "08:00", "timezone": "Asia/Shanghai"}`：带有 `offPeak` 标记的工单只在该每日窗口内启动新的派工（见 [003 执行](003-execution.md)）。阿里云百炼的 DeepSeek 按北京时间 22:00 至次日 08:00 的闲时价计费，忙时为 08:00 至 22:00（[计费说明](https://help.aliyun.com/zh/model-studio/billing-for-model-studio)），默认值与该时段一致。处理暂停是一个单独的设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行相应的安装配置检查。检查失败会返回 400，详情在 `setup` 中。账号更改成功，或在安装配置待处理期间的任何保存，都会返回 `restarting: true`。应用重启期间，API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

Windows 上使用当前 Windows 版本自带的 `curl.exe`，把 `cli` 设为 `gh` 或 `glab`，并把账号目录写成 `configDir`，例如 `"configDir": "C:\\Users\\me\\.config\\gh-agent"`。

## 安装配置检查

安装配置使用 DeepSeek Harness 的子进程服务，和执行器的 shell 一样。它会移除名称包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

安装配置会验证当前 Git 宿主的仓库或项目和智能体的推送权限，写入执行器环境，并检查 git 对该宿主只使用智能体凭据。飞书安装配置失败只会停用飞书来源。

安装配置写入的进程环境：

- **命令 shim** 位于 `<stateDir>/worker-bin`，在 `PATH` 中排在最前。POSIX 上，`gh` 运行智能体的 CLI，`lark-cli` 运行机器人的 CLI，被禁止的命令会失败；shim 在运行目标之前会把自身目录从 `PATH` 中移除。Windows 上只有被禁止和未启用的命令会生成 `.cmd` shim（未启用的 Git 宿主对应 shim 会失败）；启用的 Git CLI 以 `GH_CONFIG_DIR` 或 `GLAB_CONFIG_DIR` 选择原生可执行文件运行，`lark-cli` 则通过其 npm `.cmd` shim 的 Node 入口运行，参数不会经过 `cmd.exe`。
- **git 配置**位于 `<stateDir>/worker-gitconfig`：替换运营者的全局和系统 git 配置。它选择智能体 CLI 作为当前宿主的凭据助手，把该宿主的 SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。个人 git 设置（例如 HTTP 代理）不生效。这里不设置提交身份，git 绝不会提示输入凭据，`GH_TOKEN`、`GITHUB_TOKEN`、`GLAB_TOKEN` 和 `GITLAB_TOKEN` 会被移除。

`worker-bin` 或 `worker-gitconfig` 中不是 dsh-superagent 写入的文件会阻止安装配置。如果工单目录位于一个自身配置添加了凭据的 git 仓库中，该工单会失败。

## 试一试

用允许名单中的 GitHub 账号，打开一个 Issue 或发表一条包含 `@<agent login> <request>` 的评论。在一个轮询间隔内（默认一分钟），概览应显示一个工单。智能体会确认请求，在自己的 Session 和目录中工作，并在原对话中交付。使用飞书时，在已配置的群中提及机器人。

## 升级

**自举部署注意：**如果正在运行的 superagent 负责开发本仓库，不能让它在自己的 worker 会话中执行下面的原地升级和重启。请先在隔离的任务工作树和测试实例中验证候选版本，再由独立于该服务的操作员或部署监督器，在经批准的维护窗口执行发布、健康检查和必要时的回滚。开发和候选版本验证共用一个非生产实例；生产与测试必须隔离 profile、DSH home、状态、控制文件、端口、凭据及外部来源，只分开工作树并不足够。飞书只在生产启用，测试实例不得持有生产机器人凭据或 CLI 配置。恢复旧工单前须核验其工作树和 Session 工作目录。本机的目标拓扑、当前待确认事项和具体保护规则见仓库根目录的 `AGENTS.md`。切换前须取得一致且经过验证的备份，并保留与之兼容的旧版本；回滚前要处理备份之后产生的数据和外部副作用。不要假定在线复制单个 SQLite 文件就是一致备份。

以下步骤只适用于已确认允许原地升级的部署，不是自举部署的自动发布流程：

1. 等到没有执行器处于一轮进行到一半的状态。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

Windows 上用 PowerShell 执行同样的步骤；PowerShell 7 支持 `&&`，服务命令是 `node scripts\dsh-superagent restart`。

重启会结束正在运行的派工，并带恢复说明启动替代的派工。团队文本和被覆盖的提示词段落会保留；没有覆盖的段落跟随新的默认内容。升级后检查标记为 **默认内容已更新** 的段落。

由更新版本迁移过的数据库无法被旧版本打开。因此回滚需要升级前的备份。升级 DeepSeek Harness 本身之后，重启正在运行的实例，以便面板加载匹配的构建产物。

### 智能体预设

执行器和路由预设会在 5 秒后把 shell 命令移到后台。Session 没有其预设就无法加载。在这些 Session 使用期间，请把 `dsh-superagent-worker` 和 `dsh-superagent-router` 行保留在 `cordis.patch.yml` 中；否则恢复会失败并报 `agent-preset/not-found`。

## 故障排查

安装配置问题会以面板的语言显示在概览上，并带有指向修复方法的链接；日志和 API 显示下面的英文文本。

| 现象 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置智能体的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录包装脚本 |
| `@… cannot read …` 或 `@… cannot push to …` | 给智能体账号授予仓库写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库，`owner/name` |
| 工单失败并报 `The prepare command failed: …` | 输出会指出原因，例如错误的克隆路径；修正命令，然后重试该工单 |
| 已结束工单的 worktree 仍留在 `<stateDir>/work/…` | 它有未提交或未跟踪改动、提交不在远端、检出了其他分支，或不是链接 worktree。提交并推送，或丢弃这些工作；下次宿主启动时会再次尝试清理 |
| 找不到 `pwsh`，或准备命令报 PowerShell 错误 | 安装 PowerShell 7 并把 `pwsh` 放到 `PATH` 上；准备命令不使用 Windows PowerShell 5.1 |
| Windows 上启动时报 `dsh must be on PATH.` | 全局安装 DSH 并打开新的 shell；`start` 会解析 npm 的 `dsh.cmd` |
| PowerShell 或 `cmd.exe` 无法运行 `scripts\dsh-superagent` | 该脚本在 Windows 上没有 `.cmd` shim；请运行 `node scripts\dsh-superagent <command>` |
| `gh` 或 `glab` 的 `.cmd` 包装脚本丢失或破坏参数 | 使用原生 `gh.exe` 或 `glab.exe` 及其配置目录（见 Windows 凭据）；绝不要让 JSON 或消息文本经过 `cmd.exe` |
| Windows 主机上飞书来源被拒绝 | 把来源的 **机器人的 lark-cli** 字段指向 `lark-cli`（npm 的 `.cmd` shim）或包的 Node 入口；没有 Node 入口的自定义 `.cmd` 包装会被拒绝 |
| `git does not read the credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 工单失败并报 `The git configuration of the repository in … sets …` | 从克隆的 `.git/config` 中移除所指的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 把所指的文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或选择另一个 `stateDir` |
| `The bot lark-cli allows user identities` | 让飞书来源指向一个仅机器人配置，如上面的飞书机器人所述 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置的应用 id 和密钥 |
| `The Feishu bot is not a member of the chat.` | 在该群的设置中把机器人加入群；下一次尝试就会成功 |
| `status` 以 2 退出 | 某个部分报告错误，重启不能修复：`errors` 会列出每个部分（如管理 API 下所列）及其详情；每个部分恢复工作后会清除自己的条目 |
| `status` 以 3 退出 | 安装配置在等待：`setup` 说明缺少什么，概览会链接到可修复它的设置 |
| `status` 以 1 退出 | 服务没有运行、运行了两份、没有响应，或它的运行时报告错误；输出和最新的日志会说明是哪种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | CLI 失败但没有打印原因；以运营者的用户身份手动运行所指的程序，查看它自己的消息 |
| 面板说 dsh-superagent 没有响应 | 它正在重启，或因其配置而没有启动；DeepSeek Harness 的日志会指出原因 |
| `dsh-superagent configuration has keys it does not use`（日志） | 移除所指的键；消息会说明每个值现在位于何处 |
| 日志说插件与正在运行的 dsh 不兼容 | 安装一个处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| DeepSeek Harness 升级后，面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| 提及之后没有任何反应 | 检查作者是否在来源的允许名单上、来源是否开启、处理是否未暂停。在 GitHub 上，通过编辑 Issue 正文添加的提及不会被接收；请在评论中提及智能体 |
