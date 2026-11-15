# 006 部署

[English](../006-deployment.md) | **简体中文**

本指南用于安装、配置和运行 dsh-superagent。它涵盖账号、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 的基础上。

## 本检出的生产主机

2026-11-14 运行时切换之前，目标生产主机为原生 Windows，使用固定检出目录 `F:\code\dsh-superagent-prototype`，以及与 Desktop 分离的 DSH 根目录。仅使用不同的 profile 并不能隔离工作区和会话存储。2026-11-08，操作员批准切换到 `C:\Users\dd\.dsh-superagent`，并将 `DSH_AGENTS_HOME` 设置为其中的 `agents` 子目录。带版本的入口 `scripts\dsh-superagent.ps1` 读取 checkout 之外的 `%USERPROFILE%\.dsh-superagent\service.json`，固定 checkout、DSH home、profile、本机回环 URL、Node 路径、可选的 PATH 追加项以及部署请求/命令；没有该文件而直接使用通用脚本，可能重新使用 Desktop 的共享目录。本机 `C:\Users\dd\.dsh-superagent\service.ps1` 仍是既有工具的兼容入口；切换后应缩减为向带版本入口传 `-Config` 的 shim。原有专属状态目录仍位于新根目录之外的 `C:\Users\dd\.dsh\state\superagent`。启动报告显示运行时和飞书 ready、GitLab starting；根据操作员要求，切换后未独立验证工作区、会话恢复和端到端行为。这种分离不是操作系统安全边界。profile 直接链接 F: 检出；不要为了匹配包名而重命名目录。Windows profile 示例位于 `examples/profile.cordis.patch.yml`；POSIX / WSL 示例保留在 `examples/profile.posix.cordis.patch.yml`，供独立部署使用。历史 WSL 状态与工作树不是 Windows worker 目录，不得清理或在 Windows 上直接恢复。

Windows 进程不能安全依赖共享检出内 WSL 创建的依赖链接。应在生产服务停止、其他使用该依赖树的进程静止后，于最终路径准备并验证完整的 Windows 依赖安装。pnpm 的 `Already up to date` 不代表可用：用 Windows Node 构建并导入实际 bundle，再确认带 `x-orchestrator-request: 1` 的 `GET /orchestrator/api/state` 返回 200，并检查来源健康。仅监听 Web 端口不够。两种平台都需要运行时，应分离各自的依赖树。后台运行时还要确认服务与飞书消费者没有可见控制台，且含令牌的启动日志只允许目标用户和管理员访问。

### 版本化运行时候选（Windows）

候选流程与已知限制见 `docs/runtime-windows.md`；最新代码部署入口尚未安装或完成运维验证。当前生产事实须重新核实，不能从候选实现推断。

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

1. 创建一个带机器人能力的自建应用。授予它接收消息事件和以机器人身份发送消息的权限，然后发布应用版本。它不需要读取消息、聊天历史、群或群成员的权限：来源只使用事件携带的内容并回复。被移除的读取路径会调用需要 `im:message`、`im:message:readonly`、`im:message.history:readonly`（消息）以及 `im:chat`、`im:chat:readonly`、`im:chat.group_info:readonly`、`im:chat:read`、`im:chat.members:read`（群和成员）的接口；当前版本不再调用它们。因此它无法补收 dsh-superagent 离线期间的消息，无法按 ID 读取消息或话题，无法列出群或同步成员，也无法读取图片（原因见下文**图片与截图**）。群 chat_id 和允许名单需要手工填写。为群选择**全部消息**还需要飞书“接收群内全部消息”的权限；没有该权限时只会收到 @ 机器人的消息。
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

**图片与截图。** 机器人无法下载图片。下载图片需要 `im:resource`（`GET /open-apis/im/v1/images/:image_key`），下载消息资源需要 `im:message:readonly`（或 `im:message.history:readonly`）。这个自建应用两者都没有：上传图片的探测报告缺少 `im:resource`，消息资源下载返回 `99991672` 并列出 `im:message.history:readonly`/`im:message:readonly`/`im:message`；操作员已确认（2026-11-09）两个权限都无法开通。因此实时事件只带来渲染后的文本，图片显示为 `![Image]` 标记并带有 `img_…` key，agent 看到的是标记而不是截图。即使一条富文本消息同时包含 @ 机器人和图片，机器人也只能读取其中的文字。请让发送者用文字描述图片内容，或用文字提出请求。这是部署限制，不是来源设置；如果以后应用获得其中之一，可以再实现图片下载路径。

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

Windows 上，从独立操作环境使用已安装运行时的带版本入口及经核实的服务配置。以下为本机入口；操作前核实目标，启动或重启前清空继承的旧部署变量。它们不会部署新版本：

```powershell
$env:DSH_SUPERAGENT_DEPLOY_REQUEST = ''
$env:DSH_SUPERAGENT_DEPLOY_COMMAND = ''
pwsh F:\dsh-superagent-runtime\current\scripts\dsh-superagent.ps1 status -Config F:\dsh-superagent-runtime\config\service.json
pwsh F:\dsh-superagent-runtime\current\scripts\dsh-superagent.ps1 start -Config F:\dsh-superagent-runtime\config\service.json -UseInstalled
pwsh F:\dsh-superagent-runtime\current\scripts\dsh-superagent.ps1 stop -Config F:\dsh-superagent-runtime\config\service.json
pwsh F:\dsh-superagent-runtime\current\scripts\dsh-superagent.ps1 restart -Config F:\dsh-superagent-runtime\config\service.json -UseInstalled
```

除非用 `-Config` 或 `DSH_SUPERAGENT_SERVICE_CONFIG` 指定其他文件，它读取 `%USERPROFILE%\.dsh-superagent\service.json`；`examples/service.windows.json` 是模板。该文件固定 `checkout`、`home`、`agentsHome`、`profile`、回环 `url`、`node` 可执行文件、可选的 `path` 追加项以及可选的 `deployRequest`/`deployCommand`，并且不保存密钥。启动还需要用户级 `LUMOS_API_KEY`，包装脚本从用户环境复制。入口接受动作以及可选的 `-Config` 和 `-RespectStop`；`-UseInstalled` 供专用恢复和内部调用使用，目标和时序信息留在文件里。服务控制应使用已安装运行时配置。它会拒绝不存在的 checkout 和非回环 URL。

Node 脚本仍是实现，也是两个平台上已设置好环境时的可用入口：

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

Windows 上写作 `node scripts\dsh-superagent start` 等；该文件没有 `.cmd` shim，因此需要 Node。

`--url` 的监听者是明确目标。Windows 显式 `stop --url` 通过回环端口和 Superagent 管理状态确认目标，无需读取进程命令行或管理员权限；它不核验监听者是否使用所传 profile，因此应准确指定目标 URL。不传 `--url` 时机械发现回环监听者，无法区分时要求指定 URL。两种路径都不强杀。

`start` 在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`；其他 profile 则使用 `dsh-<profile>`。它最多等待一分钟，让运行时变为就绪或报告安装配置要求。首次运行时，它会打印缺失的安装配置信息。它会拒绝重复的实例，包括从这个脚本之外启动的实例。每个 profile 使用独立命名的 tmux socket。pane 使用调用者的 `DSH_HOME`、`HOME` 和 `PATH`（包括未设置的情况），并在启动 DSH 前清除 `TMUX` 与 `TMUX_PANE`，避免 worker 继承服务 socket。仅设置 `TMUX_TMPDIR` 不能覆盖继承的 `TMUX`；这些措施只是护栏，不是操作系统安全边界。

Windows 上，`start` 要求 `dsh` 在 `PATH` 上（npm 的 `.cmd` shim），以分离进程启动 `dsh --profile <profile> --no-open`，日志和控制文件与 POSIX 相同，并等待管理 API；它不使用 tmux。当调用者位于 Windows Job 中时，它通过 `scripts\service-start.ps1` 在 Job 之外创建服务，并把同一个 `--home` 传下去。`status` 通过 Windows PowerShell（`powershell.exe`，Windows 自带）列出进程。`stop` 通过 `POST /orchestrator/api/service/stop` 让 DSH 退出，而不是发送信号；它最多等待五分钟，绝不会强制杀死进程。上面的 tmux socket 与 `TMUX` 细节只适用于 POSIX。两种平台使用相同的退出码、日志名和 `manually-stopped` 标记。

`stop` 和 `restart` 请求优雅 drain，并最多等待进程五分钟退出。执行器 drain 的上限是十秒，DSH 启动器再加五秒宽限，因此停止通常约十五秒完成；drain 之后仍在回合中的 worker 可能被打断。POSIX 上它们绝不会强制杀死进程，也不会碰其他 tmux 会话。候选版本在 drain 未确认时保留进程、数据库和状态锁，运行时健康状态显示 `shutdown_failed` 错误（`status` 以 1 退出），并拒绝后续停机请求。Windows 停机与重启会直接报告该失败，不等待超时或启动替代进程。恢复前应排查原进程与残留工作；不要为继续部署而强制杀进程。现有安装需另行部署此候选版本。

`status` 打印进程 id、健康状况和安装配置问题。要使用其他 profile 或端口，请用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`；PowerShell 中设置 `$env:DSH_SUPERAGENT_PROFILE` 和 `$env:DSH_SUPERAGENT_URL`。

底层服务控制的 `status`、`start` 和 `restart` 使用以下退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 它没有运行、运行了两份、没有响应，或它的运行时报告错误；重启可能修复 |
| 2 | 它正在运行，但运行时以外的某个部分报告错误，例如某个来源或策略同步（`sync:<source id>`）；重启不能修复 |
| 3 | 它正在运行并等待安装配置；重启不能修复 |

仍在启动的来源算作正常运行。安装配置无法检查的飞书机器人也算。

`status` 在 `errors` 下返回失败的部分及其详情，在 `setup` 下返回安装配置要求。底层服务控制的 `start` 和 `restart` 会逐行打印这些问题；如果服务始终没有起来，它们以 1 退出。有意的 `stop` 写入停止标记，专用恢复入口会尊重该标记；不要据此假定恢复已自动调度。

每个 DSH home 在自己的 `service/` 下保存服务的日志和控制文件，因此脏的或共享的 checkout 不再是运行时状态：

- 启动日志：`<DSH home>\service\logs\dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于脚本。保留最新的 20 个。
- 控制文件：`<DSH home>\service\control\profiles\<profile>\`，包含停止标记、锁、进程 id 和最近一次启动事实。

本版本仍会读取旧的 `<checkout>\.artifacts\control\profiles\<profile>\` 停止标记、记录 PID 和启动事实，使有意的停止和当前启动在升级后继续有效。正常启动不再向那里写入；停止一个仍由旧位置记录的服务时，会把停止标记写回该目录，让恢复检查继续生效。新入口部署完成、且没有旧的调用方式后，可以归档该目录。

打开日志中打印的 URL，然后在侧边栏中选择 **Superagent**。

### 服务检查

在独立于 `superagent` 的环境检查状态；退出码 2 或 3 分别报告部件错误或安装配置要求，不要把重启当作修复。退出码 1 时检查输出和服务日志并诊断原因。主动停止标记表示服务应保持停止；服务控制应使用已安装版本和经过确认的实例配置。

### 任务级巡检（Watchdog）

预期的新独立 Watchdog observer 按固定间隔以 GET 读取 `GET /orchestrator/api/watchdog` 快照，不使用长轮询；快照包含服务状态、进行中工单及其机械信号。服务不可达时，observer 无法读取其实时状态，但可在本地记录读取失败。

### 独立 Watchdog 进程

预期的 observer 只写本地状态、日志和心跳：不运行模型、不发送飞书、不向服务写入观测或报告、不自动恢复服务或工单、不轮询部署请求，也不自更新。本地记录不是主动通知：操作员需要自行查看，或另行配置独立告警系统。服务侧 `lastRun` 不是 observer 的心跳，可能已过期。服务侧恢复等写入 API（包括 enforce 模式恢复 API）仍可能可调用；observer 只读并不等于这些 API 已禁用或受到保护。

launcher 只运行当前安装的 Watchdog 版本，启动及退出后均不自动拉取、构建或切换版本。这是预期新模式，并非对现有生产安装的断言：必须单独部署新的 Watchdog 制品和 launcher 才会生效，普通 Superagent 部署不会更新独立安装的 Watchdog。单独部署并验证前，旧 observer、launcher 或其他计划任务仍可能保留旧行为，应分别核实其安装和配置。

候选版本停用了危险的仅凭 PID 强杀；在单独部署新版 Watchdog 之前，现有生产安装仍可能执行这种强杀。没有管理员权限时，进程身份或操作权限可能无法读取：必须用 PID 加创建时间确认身份，或用同一个进程句柄完成识别与操作；无法确认身份或所需权限时拒绝操作。PID 可能复用，单独使用不能证明身份。这些检查不是操作系统隔离边界。

### 在 Windows Job 之外启动服务

DSH 运行的工具命令属于一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Windows Job；从其中启动的服务会在命令结束时被终止，而命令内部此前的健康检查可能已经通过。`scripts/dsh-superagent start` 会检测这一状态，让 WMI 提供程序在 Job 之外创建 `scripts/service-start.ps1`，并等待健康检查。WMI 创建进程时会请求隐藏窗口。该包装脚本从受限文件中恢复服务环境、启动分离的服务后退出；它从不启动 observer。不在 Job 中的普通终端启动仍走原路径；计划任务所在的 Job 也按同样方式离开，`status` 会报告实时的 `inJob` 值以及 `start` 中最近一次启动的方式。普通启动不再仅因无法读取启动后 Job 归属而失败；需要时可用独立的 `verify` 检查。

带版本的 `scripts\dsh-superagent.ps1` 是服务入口：它校验机器配置并调用控制脚本，因此服务在进程位于 Job 之外时仍使用自己的 profile home 和凭据。操作员的 `C:\Users\dd\.dsh-superagent\service.ps1` 仍是既有工具的兼容入口；切换后应缩减为指向该入口的 shim。`scripts/service-start.ps1` 也可以由独立计划任务直接运行；它会收到与父进程相同的 `-DshHome`。该任务应通过 `wscript.exe <checkout>\scripts\launch-hidden.vbs <pwsh> -NoLogo -NoProfile -NonInteractive -File <checkout>\scripts\service-start.ps1 ...` 启动，使包装脚本和它运行的 node 控制脚本都没有窗口。

计划任务没有可继承的控制台，Windows 会给它启动的第一个控制台程序（`node` 或 `pwsh`）一个可见窗口。因此所有非交互入口都经过 `scripts/launch-hidden.vbs`：`wscript.exe` 自身没有控制台，启动器以隐藏窗口运行命令、等待并返回它的退出码，该命令的所有控制台子进程共享这个隐藏控制台。这适用于部署和服务启动任务；另行安装的旧 Watchdog 任务需要独立核实。只有人在交互查看时才直接运行命令。控制脚本也会隐藏它自己的 PowerShell、`git` 和 Windows ACL 辅助进程，因此后台的 `status`、`start` 或 `stop` 也不会闪出它们。

`node scripts/dsh-superagent verify --profile superagent --url <url> --survival-seconds 30` 在执行器退出后证明发布有效：恰好一个进程服务该 profile，管理 API 返回 ready（或 paused），进程不在外部 Windows Job 内，且在存活窗口之后仍是同一进程。退出码 1 会指出未通过的条件。

### 部署请求

请求排队不代表部署成功。版本化运行时的候选流程和限制见 [runtime 指南](../runtime-windows.md)；最新代码部署入口尚未安装或完成运维验证。已有主机上的旧任务和脚本不会因仓库清理而消失，不得调用。

独立的 `scripts/recover-superagent.ps1` 可尊重主动停机标记并启动已安装版本；预期的新 observer 不调用它。另行调度的旧调用方须独立核实。

### 版本化 Watchdog 制品与安装

Watchdog 独立于 Superagent 安装，`<watchdogHome>\current.txt` 指向当前制品；预期的新 launcher 只运行该已安装版本，不自动更新。安装新 observer 和 launcher 是操作员单独控制的部署操作，不会因为修改本工作树或部署 Superagent 自动发生。候选版本的 `watchdog-control` 只提供只读 `status`；`start`、`stop`、`deploy` 及 Watchdog 更新入口为安全暂时停用。单独授权安装后应核实安装版本、本地状态、日志和心跳；排队的请求或服务侧观测不代表部署成功。

observer 使用原子独占 PID 锁。异常退出可能留下锁，系统不会自动删除；人工清理前须确认对应 observer 进程已不存在，并考虑 PID 复用及进程身份。事件循环停滞、进程退出、PID 复用或写入失败都可能导致本地日志和心跳过期或不可用；日志应作为敏感证据处理。预期模式没有内建主动通知。新制品不包含 agent、bootstrap 和 deployment 模块；另行安装的旧任务仍可能运行。

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

   把个人 CLI（例如登录你自己账号的 CLI）列为禁止调用的命令。旧版执行器清理可能删除已结束工单的链接 worktree 和 ref，并尝试删除远端分支；已部署版本可能仍会这样做，其检查不能证明被忽略的数据、外部使用者或远端更新安全。取回的 ref 不能证明远端有持久副本，远端比较和删除也不是原子操作。lifecycle 候选版本改为逐工单只读对账，并在工单详情中保留最新报告；工单结束不会自动删除 worktree、本地分支或远端分支。这不代表该版本已部署。历史残留需要人工确认。恢复或考虑清理前参见 `docs/015-workspace-lifecycle.md`；不要未经恢复审查就用当前 prepare 命令重建缺失的旧工作树。

   rc.3 兼容候选从 worker 预设移除原生子智能体工具，并对已识别的受管理 worker 及子智能体拒绝已知原生工具，包括使用旧预设的 worker。它不能撤销已准备的调用，也不能覆盖其他入口、外部或 GUI 工作及未识别子智能体，并非完整隔离。rc.2/rc.3 路径尽力 interrupt 已登记 child 并等待树工作，而非释放 activation；待处理 inbox 或本地 activation 可能保留并再次唤醒，目录也可能遗漏工作。目录只要含 child 或 diagnostic（包括历史记录），或观察到树工作，即使没有其他错误也报告清理未确认；目录为空或等待返回 false 不能证明没有遗留活动。既有持久化 Ticket 隔离会阻断后续自动工作，重启后仍显示 worker 健康错误，且不会自动解除。意图记录前崩溃、GUI 直接操作及未确认的外部工作仍不受保护。rc.1 路径不同。同进程关闭失败时，候选保留数据库及状态锁，防止另一个 Runtime 打开；如果某 worker 的停止意图无法写入，候选不会取消或清理该 worker，必须人工核查。恢复前须核查原进程与残余工作。HTTP 请求关闭失败时，候选记录错误且不调用进程退出钩子；进程保留在关闭状态供排查，不再提供正常服务。这不能证明外部工作已停止，也不代表已部署到生产。
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
| `POST service/stop` | 请求 dsh-superagent 先 drain 执行器（上限十秒），再通过 DSH 启动器退出：`stopping: true`。启动器没有退出钩子或上次停机失败时返回 500；服务脚本用它来避免依赖 POSIX 信号 |
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
| `cleanup` | lifecycle 候选版本把旧版排队的副作用作为已结束工单的只读观察处理，不删除资源；失败在健康面板可见。已部署的旧版本可能仍执行破坏性清理，应单独核实部署版本 |
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
- `executor`：`model`、`tierModels`、`models`、`maxWorkers`、`offPeak`、`directory`、`prepare` 和 `blockedCommands`。`tierModels` 把 `low`、`high`、`expert` 映射到模型或 `null`；有档位的工单依次使用档位模型、`model` 和宿主默认模型。`models` 把旧类别 `query`、`research`、`development` 映射到模型或 `null`，仅用于无档位的旧工单；这些工单依次回退到 `model` 和宿主默认模型。`offPeak` 默认是 `{"enabled": false, "start": "22:00", "end": "08:00", "timezone": "Asia/Shanghai"}`：带有 `offPeak` 标记的工单只在该每日窗口内启动新的派工（见 [003 执行](003-execution.md)）。阿里云百炼的 DeepSeek 按北京时间 22:00 至次日 08:00 的闲时价计费，忙时为 08:00 至 22:00（[计费说明](https://help.aliyun.com/zh/model-studio/billing-for-model-studio)），默认值与该时段一致。处理暂停是一个单独的设置 `paused`，由 `POST executor/pause` 设置。

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

**自举部署注意：**运行中的 superagent 不能在自己的 worker 中执行原地升级或重启。开发与验证使用隔离的非生产实例，生产与测试必须隔离 profile、DSH home、状态、控制文件、端口、凭据及外部来源；飞书只在生产启用。恢复旧工单前须核验其工作树和 Session 工作目录。具体保护规则见仓库根目录的 `AGENTS.md`。

候选版本化发布流程及限制见 [runtime 指南](../runtime-windows.md)；如需备份，应事先独立取得一致且验证过的备份，不能假定在线复制单个 SQLite 文件就是一致备份。

重启会结束正在运行的派工，并带恢复说明启动替代的派工。这不能验证原工作区或隔离恢复后的 worker：恢复前应核验工作树、分支、未提交工作和 Session 工作目录；原目录缺失或不匹配时应停止并由运维恢复。参见 `docs/015-workspace-lifecycle.md`。团队文本和被覆盖的提示词段落会保留；没有覆盖的段落跟随新的默认内容。升级后检查标记为 **默认内容已更新** 的段落。

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
| 已结束工单的 worktree 仍留在 `<stateDir>/work/…` | 这是候选版本的预期行为：工单结束不会自动删除 worktree 或分支。保留目录，并在任何手动操作前调查归属、被忽略及其他本地数据、活跃使用者和恢复需求。已部署的旧版本可能在宿主启动时再次尝试清理；历史残留需要人工确认。参见 `docs/015-workspace-lifecycle.md` |
| 找不到 `pwsh`，或准备命令报 PowerShell 错误 | 安装 PowerShell 7 并把 `pwsh` 放到 `PATH` 上；准备命令不使用 Windows PowerShell 5.1 |
| Windows 上启动时报 `dsh must be on PATH.` | 全局安装 DSH 并打开新的 shell；`start` 会解析 npm 的 `dsh.cmd` |
| PowerShell 或 `cmd.exe` 无法运行 `scripts\dsh-superagent` | 该脚本在 Windows 上没有 `.cmd` shim；请运行 `pwsh scripts\dsh-superagent.ps1 <action>`，环境已设置好时也可 `node scripts\dsh-superagent <command>` |
| `The service configuration does not exist` 或目标不匹配 | 按 `examples/service.windows.json` 创建 `%USERPROFILE%\.dsh-superagent\service.json`；入口拒绝不存在的 checkout 或非回环 URL |
| `The management URL … is owned by PID …` | 端口被其他进程占用；停止它或改用服务真实的 `url`。入口绝不会杀外部监听者 |
| `This home's dsh-superagent process … does not listen` | 记录过的进程仍在运行，但没有监听目标 URL；检查并修复其监听，或从独立任务处理 |
| `gh` 或 `glab` 的 `.cmd` 包装脚本丢失或破坏参数 | 使用原生 `gh.exe` 或 `glab.exe` 及其配置目录（见 Windows 凭据）；绝不要让 JSON 或消息文本经过 `cmd.exe` |
| Windows 主机上飞书来源被拒绝 | 把来源的 **机器人的 lark-cli** 字段指向 `lark-cli`（npm 的 `.cmd` shim）或包的 Node 入口；没有 Node 入口的自定义 `.cmd` 包装会被拒绝 |
| `git does not read the credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 工单失败并报 `The git configuration of the repository in … sets …` | 从克隆的 `.git/config` 中移除所指的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 把所指的文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或选择另一个 `stateDir` |
| `The bot lark-cli allows user identities` | 让飞书来源指向一个仅机器人配置，如上面的飞书机器人所述 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置的应用 id 和密钥 |
| `The Feishu bot is not a member of the chat.` | 在该群的设置中把机器人加入群；下一次尝试就会成功 |
| 发给机器人的截图或图片没有被理解 | 机器人无法下载图片：应用既没有 `im:resource` 也没有 `im:message:readonly`，且两者都无法开通（见上文**图片与截图**）。请让发送者改用文字描述 |
| `status` 以 2 退出 | 某个部分报告错误，重启不能修复：`errors` 会列出每个部分（如管理 API 下所列）及其详情；每个部分恢复工作后会清除自己的条目 |
| `status` 以 3 退出 | 安装配置在等待：`setup` 说明缺少什么，概览会链接到可修复它的设置 |
| `status` 以 1 退出 | 服务没有运行、运行了两份、没有响应，或它的运行时报告错误；输出和最新的日志会说明是哪种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | CLI 失败但没有打印原因；以运营者的用户身份手动运行所指的程序，查看它自己的消息 |
| 面板说 dsh-superagent 没有响应 | 它正在重启，或因其配置而没有启动；DeepSeek Harness 的日志会指出原因 |
| `dsh-superagent configuration has keys it does not use`（日志） | 移除所指的键；消息会说明每个值现在位于何处 |
| 日志说插件与正在运行的 dsh 不兼容 | 安装一个处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| DeepSeek Harness 升级后，面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| 提及之后没有任何反应 | 检查作者是否在来源的允许名单上、来源是否开启、处理是否未暂停。在 GitHub 上，通过编辑 Issue 正文添加的提及不会被接收；请在评论中提及智能体 |
