# 006 部署

[English](../006-deployment.md) | **简体中文**

本指南用于安装、配置和运行 dsh-superagent。它涵盖账号、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 的基础上。

## 运行哪些东西

- **一个专用的 DeepSeek Harness profile**，本指南中称为 `superagent`。从 Web profile 模板创建它。它加载 bundle，并在 `127.0.0.1` 上提供其面板。让它与你日常使用的 profile 分开：插件会改变进程范围的 `PATH` 和 git 设置，而且它的进程需要独立重启和升级。
- **一个智能体 GitHub 账号。** 智能体以这个账号发表评论、推送分支和打开 pull request，并通过一个只以该账号登录的 GitHub CLI 完成这些操作。
- **可选：** 一个用于聊天请求的飞书机器人。

插件配置保存状态目录和本机上限。其他一切都用面板：仓库和账号在来源中设置，允许名单在策略中设置，执行器（worker）目录和命令在执行中设置。

### 权限与隔离

bundle 为执行器定义了 `dsh-superagent-worker`，为主 Session 定义了 `dsh-superagent-router`。它们出现在 DeepSeek Harness 的预设列表中，但只供 dsh-superagent 使用。不要为个人 Session 选择它们，也不要禁用它们的配置行。应用需要它们来创建和恢复自己的 Session。

在 Web UI 中打开一个空白的托管 Session 时，可能会选中该 profile 的默认预设。dsh-superagent 会在第一轮之前恢复其角色专用预设。

两个预设都以运营者的操作系统用户身份、以 `danger-full-access` 运行，并读取已订阅线程中的消息。账号包装器默认选择智能体的凭据；它们不隔离进程。执行器可以按路径执行程序，并读取运营者的主目录。若要隔离，请使用一个只包含智能体凭据的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux
- GitHub CLI（`gh`）2.48 或更高版本。来源的 CLI 字段必须指向 `gh` 或 `lark-cli` 的包装脚本；宿主依赖它们的子命令和输出格式。
- github.com 上的一个仓库；不支持 GitHub Enterprise Server。要为每个工单创建检出，请保留一个本地克隆，让准备命令能从其中添加工作树。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- 为 DeepSeek Harness 配置的模型服务商。dsh-superagent 使用该 profile 的默认模型，除非评估或执行设置指定了另一个。
- 使用飞书时：`lark-cli`（已用 1.0.90 测试），以及一个带机器人的飞书或 Lark 应用

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

   以智能体账号登录；最后一条命令会打印其登录名。dsh-superagent 也以同样的方式读取登录名。

### 飞书机器人（可选）

1. 创建一个带机器人能力的自建应用。授予它接收消息事件和以机器人身份发送消息的权限，然后发布应用版本。它不需要读取消息、聊天历史、群或群成员的权限：来源只使用事件携带的内容并回复。被移除的读取路径会调用需要 `im:message`、`im:message:readonly`、`im:message.history:readonly`（消息）以及 `im:chat`、`im:chat:readonly`、`im:chat.group_info:readonly`、`im:chat:read`、`im:chat.members:read`（群和成员）的接口；当前版本不再调用它们。因此它无法补收 dsh-superagent 离线期间的消息，无法按 ID 读取消息或话题，无法列出群或同步成员，也无法读取图片。群 chat_id 和允许名单需要手工填写。为群选择**全部消息**还需要飞书“接收群内全部消息”的权限；没有该权限时只会收到 @ 机器人的消息。
2. 给机器人一份自己的 `lark-cli` 配置，限制为机器人身份，并提供一个包装脚本：

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

   第一条命令从标准输入读取应用密钥。请使用单独的配置目录：`lark-cli` 每个应用 id 只允许一个 profile，而你的个人配置可能已经包含该应用的用户登录。

   宿主会拒绝能充当用户的 CLI。它从机器人配置中读取应用 id、飞书/Lark 品牌和机器人的 `open_id`。

   两份配置共享应用密钥的钥匙串条目。要只删除机器人配置，请删除它的目录；不要运行 `lark-cli config remove`，那会影响共享的密钥。

## 安装

在一台还没有 `superagent` profile 的机器上运行一次这段内容：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本是公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条安装这个 bundle。设置 `DSH_HOME` 可以改变默认的 `~/.dsh` 目录位置。

只在全新安装时运行创建 profile 的命令。如果 profile 已存在，该命令会替换它并删除它的 `cordis.patch.yml`，包括本机配置。不要用它来升级。

## 本机配置

把 [examples/profile.cordis.patch.yml](../../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换每一个 `<placeholder>`。使用飞书时，还要在那里启用 `dsh-superagent-feishu` 条目。`webserver` 条目设置面板的端口。

| 键 | 是否必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令 shim、智能体的 git 配置，以及默认情况下 `work` 中的工单目录。升级前备份它 |
| `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大大小，以及一次研判读取多少线程页、在多久内读完 |

首次启动后，在 **设置 → 部署** 或 DeepSeek Harness 插件管理器中修改本机上限。改动无需重启即可生效。`stateDir` 不能在那里修改。无效的值或未知的配置键会阻止启动；日志会指出是哪个键。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`；其他 profile 则使用 `dsh-<profile>`。它最多等待一分钟，让运行时变为就绪或报告安装配置要求。首次运行时，它会打印缺失的安装配置信息。它会拒绝重复的实例，包括从这个脚本之外启动的实例。

`stop` 和 `restart` 请求优雅关闭，并最多等待执行器五分钟。它们绝不会强制杀死进程，也不会碰其他 tmux 会话。

`status` 打印进程 id、健康状况和安装配置问题。要使用其他 profile 或端口，请用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

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

`--respect-stop` 保留有意的停止。只有 `stop` 写入标记；`start` 清除它。`restart` 不写标记，因此该检查可以恢复一次关闭超时的重启。

## 设置

安装配置必须成功，轮询或工作才会开始。概览会列出缺失的要求，并链接到对应的设置。更改设置会再次运行安装配置。如果你在应用之外修复了某些东西，例如 CLI 登录，请选择 **重新检查**。

1. **来源。** 设置 GitHub 仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过智能体账号的通知到达。提到该账号的新 Issue 或评论会在下一次轮询时到达；通过编辑已有 Issue 正文来添加提及则不会。请改为发表新评论。使用飞书时，设置机器人 CLI、群、每个群的接收全部消息或仅提及模式，以及是否接收私信。
2. **策略。** 两条示例规则可以编辑或删除。在 **在各来源上** 下，添加可以请求工作的 GitHub 账号和飞书用户；在名单里有人之前，任何请求都不能成为工单。使用飞书时，可以选择一个群来同步名单，在启动时和 **立即同步** 时进行。
3. **执行。** 目录根路径和一个准备命令。要让每个工单都有一份仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   把个人 CLI（例如登录你自己账号的 CLI）列为禁止调用的命令。
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
| `worker` | 执行器 Session 的事件处理；在首次失败后出现 |
| `github`、`feishu` | 来源轮询和事件 |
| `sync:<source id>` | 允许名单同步 |

拒绝会带一个状态码和 `error`（其英文文本）：

- 400：无效的值（`issues`，每项带有 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 和 `values`），或请求体不是 JSON 或过大。
- 404：某个不存在的东西。
- 409：过期的修订。
- 500：其他任何情况。

这些块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的配置有 `repository` 和 `cli`，以及开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`，默认关闭，它们接收仓库中每个新 Issue、新 pull request 和评论，以及默认分支的 CI；飞书的配置有 `cli`、`chats`（形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，或 `"all"`）、`directMessages`，以及 `otherChats`（`"none"` 或 `"mentions"`）。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 行以群 id 为键；飞书还用 `other` 或 `direct`，GitHub 用 `issues`、`pulls`、`comments` 或 `ci`；未设置的单元格取默认值（见 [002 授权机制](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是一个单独的设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行相应的安装配置检查。检查失败会返回 400，详情在 `setup` 中。账号更改成功，或在安装配置待处理期间的任何保存，都会返回 `restarting: true`。应用重启期间，API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 安装配置检查

安装配置使用 DeepSeek Harness 的子进程服务，和执行器的 shell 一样。它会移除名称包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

安装配置会验证 GitHub 仓库和智能体的推送权限，写入执行器环境，并检查 git 对 github.com 只使用智能体凭据。飞书安装配置失败只会停用飞书来源。

安装配置写入的进程环境：

- **命令 shim** 位于 `<stateDir>/worker-bin`，在 `PATH` 中排在最前：`gh` 运行智能体的 CLI；`lark-cli` 运行机器人的 CLI；被禁止的命令会失败。shim 在运行目标之前会把自身目录从 `PATH` 中移除。
- **git 配置**位于 `<stateDir>/worker-gitconfig`：替换运营者的全局和系统 git 配置。它选择智能体 CLI 作为 github.com 的凭据助手，把 GitHub SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。个人 git 设置（例如 HTTP 代理）不生效。这里不设置提交身份，git 绝不会提示输入凭据，`GH_TOKEN` 和 `GITHUB_TOKEN` 会被移除。

`worker-bin` 或 `worker-gitconfig` 中不是 dsh-superagent 写入的文件会阻止安装配置。如果工单目录位于一个自身配置添加了凭据的 git 仓库中，该工单会失败。

## 试一试

用允许名单中的 GitHub 账号，打开一个 Issue 或发表一条包含 `@<agent login> <request>` 的评论。在一个轮询间隔内（默认一分钟），概览应显示一个工单。智能体会确认请求，在自己的 Session 和目录中工作，并在原对话中交付。使用飞书时，在已配置的群中提及机器人。

## 升级

1. 等到没有执行器处于一轮进行到一半的状态。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

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
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
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
