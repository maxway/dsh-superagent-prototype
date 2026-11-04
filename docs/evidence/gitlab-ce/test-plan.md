# GitLab 自部署社区版（CE）验收测试方案

目标：在不碰生产项目的前提下，验证 dsh-superagent 的 GitLab Source 能在自部署 GitLab CE 上完成账号、项目、Issue/MR、评论、CI、回复和游标恢复。适用于 HTTPS、HTTP、带端口和私有 CA 的实例；URL 子路径和 access token 是已知未验证项。

## 1. 准备

- 一个**测试项目**，例如 `group/dsh-superagent-test`；不要用生产项目。
- 一个**测试 Issue** 和一个**测试 MR**，都可以丢弃。
- 一个 GitLab 用户账号，至少 Developer；`glab` 用该账号登录，不使用个人账号配置。
- 服务所在机器安装：`glab`（1.36+，需要 `glab auth git-credential`）、`git` 2.32+。
- 记录：GitLab CE 版本（`/help`）、完整 URL（scheme/host/port/是否子路径）、`glab --version`、`git --version`。

先设置变量，后续命令复用：

```sh
HOST=gitlab.example.com          # 不带 scheme；HTTP 实例也写 host[:port]
PROJECT=group/dsh-superagent-test
ENC=$(printf '%s' "$PROJECT" | sed 's|/|%2F|g')
GLAB=/path/to/glab-agent          # 面板里配置的同一个包装脚本
ISSUE=1
MR=1
```

如果实例是 HTTP，把下面的 `https://` 换成 `http://`；如果是私有 CA，先确认 `glab` 和 worker 的 git 都信任它（worker 可在服务环境设置 `GIT_SSL_CAINFO`）。

## 2. 账号与 CLI

```sh
"$GLAB" --version
"$GLAB" auth git-credential --help   # 低于 1.36 会没有这个命令
"$GLAB" api user                     # 必须是智能体账号，不是个人账号
"$GLAB" api "projects/$ENC"          # 项目可读，且返回 permissions
```

通过标准：

- `api user` 的 `username` 是智能体账号。
- `projects/$ENC` 返回 `id`、`path_with_namespace`、`default_branch`。
- `permissions.project_access.access_level` 或 `group_access.access_level` 至少 30。
- 若 `permissions` 为空，记录使用的 token 类型；当前 setup 会拒绝这种账号，改用 Developer 用户账号。

## 3. 一键冒烟脚本

```sh
GLAB="$GLAB" scripts/gitlab-smoke.sh "$HOST" "$PROJECT" "$ISSUE" "$MR"
```

它检查：账号、项目读取、Issue note POST、`updated_at` 前后变化、note 读回、`glab auth git-credential`、MR 读取。任一步失败都会退出非零，把完整输出保留。

重点看 `updated_at`：

- 发 note 前后 `updated_at` 必须变化；不变时脚本报 `WARNING` 并退出 1。
- 当前 Source 用 Issue/MR 的 `updated_at` 发现新增评论；不变会漏评论。这是 mock 测试无法证明的前提。

## 4. Credential helper 与 git 推送

只验证 helper 输出，不打印密码：

```sh
printf 'protocol=https\nhost=%s\n\n' "$HOST" | "$GLAB" auth git-credential get >/tmp/glab-cred
test -s /tmp/glab-cred && echo "credential ok"
```

再用隔离配置做一次真实 git 操作，避免读到操作者全局配置：

```sh
TMP=$(mktemp -d)
cat >"$TMP/gitconfig" <<EOF
[credential "https://$HOST"]
	helper = !$GLAB auth git-credential
EOF
GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  git ls-remote "https://$HOST/$PROJECT.git"
```

通过标准：`ls-remote` 能列出分支。若 HTTP，协议和配置 key 都改成 `http`；若 SSH，确认 worker 的 SSH key 和 `insteadOf` 行为不属于本测试范围。

## 5. Source setup

1. 在 profile 的 `cordis.patch.yml` 启用 `dsh-superagent-gitlab`、禁用 `dsh-superagent-github`；重启服务。
2. 在 **Sources** 填 GitLab URL、项目、`$GLAB` 路径；保存。保存会检查账号和项目；失败时记录 setup 错误。
3. 打开 GitLab Source 的开关，确认 setup 成功；Panel **Sources** 显示 GitLab，GitHub 不活动。
4. 在 **Policy** 里加入测试账号；在准备命令里把测试仓库 checkout 到 `$DSH_SUPERAGENT_DIR`（如 `git clone https://$HOST/$PROJECT.git "$DSH_SUPERAGENT_DIR"`）。

通过标准：服务启动后 GitLab Source health 为 ready（首次轮询后），没有 setup 错误。

## 6. 触发与回复

按顺序做，记录时间、Trigger/Ticket 和结果：

1. **Issue mention**：测试账号新建 Issue，正文写 `@agent-account 请看一下这个测试问题`。应产生候选/工单，worker 收到上下文，回复一条 Issue note。
2. **Issue comment**：在该 Issue 下发一条不带 @ 的评论。若打开“接收评论”，应产生候选；若未打开，工单的 source thread 订阅仍应把评论送给 worker（如果工单已存在）。
3. **MR**：从测试分支开 MR；worker 报告后应能绑定 MR，卡片显示 `!1`。
4. **MR comment**：在 MR 下发评论并 @ 智能体；应产生 Trigger。
5. **Pipeline**：在测试分支触发一条 pipeline；打开“接收 CI”后应看到 MR head pipeline 或默认分支 pipeline 的状态变化，失败时 worker 能读 `gitlab/mrs/<iid>/checks`。
6. **回复**：确认回复是 Issue/MR note，带 `<!-- dsh-superagent:<id> -->` 标记；重试不重复发。
7. **关闭/合并**：关闭 MR，确认工单结束并显示 closed；合并另一个 MR，确认显示 merged。

通过标准：每个 Trigger 的 actor、Thread、URL 正确；回复只发一次；MR 绑定/结束正确；没有跨项目或跨 Issue/MR 的串线。

## 7. 游标与重启

1. 停掉服务；在测试 Issue 和 MR 各加一条评论。
2. 启动服务；等待一轮轮询。
3. 确认两条评论都被收到，且没有重复回复。
4. 在服务运行中重启一次；确认已读评论不重发，未读评论会补上。

通过标准：不丢评论、不重复回复；失败轮次后游标不会跳过未读评论。

## 8. CE 专项检查

- **版本**：记录 `/help` 的版本；当前代码不依赖 Premium/Ultimate 字段，`detailed_merge_status` 等为可选。
- **HTTP**：Source URL 用 `http://`，`glab` 也配置为 HTTP；worker credential/URL 重写应走 HTTP。
- **端口**：URL 带端口时，commit email 不应包含端口；`glab`/git 的 host 配置要匹配。
- **子路径**：若实例是 `https://host/gitlab`，当前未验证；请记录 `glab api user` 和项目 URL 的实际行为，可能需要在 Source URL/glab 配置上适配。
- **私有 CA**：确认 `glab` 和 worker git 都信任；否则 setup 可能在 `api user` 或 clone 阶段失败。
- **access token**：若用 project/group access token 且 `permissions` 为空，setup 会拒绝；记录 token 类型并改用用户账号，或作为后续需求。
- **权限**：Developer 能推分支/开 MR；不能推保护分支时，测试分支不要用保护分支。

## 9. UI 证据

在同一浏览器、同一视口、同一主题下截：

1. Sources 页面：启用 GitLab 前（GitHub 或 setup pending）和启用后（GitLab 卡片、项目、账号）。
2. Prompts 页面：GitLab skill 标签和内容。
3. 至少一张 Issue/MR 回复或工单卡片的证据（可脱敏）。

截图不要包含私有 Feishu 内容、token、cookie 或内部项目链接；用测试项目。

## 10. 证据清单

提交给维护者：

- CE 版本、完整 URL 类型、`glab --version`、`git --version`。
- `scripts/gitlab-smoke.sh` 的完整输出（脱敏）。
- `glab api user`/`projects/$ENC` 的关键字段（脱敏 id、路径可保留）。
- 每个触发场景的时间、Trigger/Ticket 编号、预期/实际结果、回复链接。
- 游标重启测试的评论 id 和结果。
- UI 前后截图。
- 未通过项的完整报错和复现命令。

## 11. 通过标准

- 账号/项目/API/credential 全部通过。
- Issue、评论、MR、CI 四类触发都能到达；回复幂等；MR 绑定/结束正确。
- 重启不丢不重；`updated_at` 前提成立。
- HTTP 实例可用；HTTPS 不回归。
- 没有 setup 错误、没有跨项目访问、没有泄露 token。

## 12. 已知未验证/限制

- URL 子路径（如 `/gitlab`）未验证。
- project/group access token 的 `permissions` 为空时 setup 拒绝。
- 内联 discussion 的自动回复仍是顶层 note；需要按 skill 手工 `glab api`。
- 幂等检查只读最近 100 条 note。
- `gitlab/.../checks` 只到 pipeline，不到单个 job。
- 404 note POST 会重试；目标被删除时可能持续重试。
- 真实 CE 已验证 Issue 评论→回复、CLI smoke、默认分支 CI 变化、人类作者 MR Trigger、MR-head pending pipeline detail/ID 变化、停服及运行中重启后的评论补读，以及 Sources 启用前后截图。由于项目无 Runner，job 成功/失败结果与失败 checks 仍未验证；其他 CE 形态未验证，PR 保持 draft。

## 13. 本次实测记录

本次复用既有 GitLab 项目 `ngd/dsh-superagent-prototype`（ID `4569`）和隔离 profile `superagent-gitlab-test`；结果不代表第 1–12 节的全量验收。

- **隔离环境**：复用项目 `ngd/dsh-superagent-prototype`（ID `4569`）和 profile `superagent-gitlab-test`（端口 `52853`）。初始代码为 `e2d4e9d`；为实测 MR detail 修复，将 profile 实际链接的 package checkout 更新到 `5fc859b` 并重建 bundle。原 `3082` 服务及工作区未改动，最终仍 healthy。`glab` 版本为 `1.36.0`，测试账号 `project_4569_bot` 具有项目 Maintainer 权限。
- **接入检查**：账号与项目 API 检查通过；GitLab Source health 为 `ready`。credential helper 和隔离配置下的 `git ls-remote` 经手动验证成功。
- **Issue 流程**：Issue `#1` 请求评论触发 `accept` 决策，Ticket `cfb32838e0dfd5d1dc935a22d4b72696` 进入 `ready` 并结束。Superagent 发布确认 note `122026` 和摘要 note `122027`；摘要读回内容符合预期。
- **MR**：临时 bot 作者 MR `!1`（`project_4569_bot`）被 Source 正确抑制自触发。随后 `jun.mei` 从 `test/superagent-human-mr-20261105` 创建人类作者 MR `!2`；Source 收到 MR Trigger `b7ba6053ef0a6da584c2e1cb9558b3df`，验证人类作者 MR 触发路径。
- **CI**：项目未注册 Runner。默认分支 pipelines `148272`、`148273`、`148279` 在测试时为 `pending`；Source 对 `148273`、`148279` 收到 CI Trigger，策略记为 `admission_ignored`。MR `!2` 列表 API 的 `head_pipeline` 为 `null`，单 MR 详情返回 pipeline `148310`（`pending`）。提交 `111b412` 的 detail fallback 在实际 profile bundle 中生效，Source 写入 `gitlab-ci:mr:2` baseline（ID `148310`）；创建第二条 pipeline `148319`（仍为 `pending`）并更新 MR 后，Source 收到 CI Trigger `fa249d83a80a549898d9f41cac783c36`（`revision=1`、`status=pending`），状态 cursor 更新至 ID `148319`。这验证了 MR-head pipeline 读取与 pipeline ID 变化检测；无 Runner，job 成功/失败结果及 `gitlab/mrs/<iid>/checks` 失败读取仍未验证。
- **服务重启/游标恢复**：profile 停止期间由 `jun.mei` 向 Issue `#1` 和 MR `!1` 添加 note `122049`、`122050`；重启后 `received` 从 `3` 增至 `5`，两条各读一次且无重复回复。随后在服务运行、轮询间隔 `3600` 秒且执行器暂停时，`jun.mei` 添加 Issue note `122081` 并创建 MR `!2`；受控重启后 Source 收到 MR Trigger 与评论 Trigger，`received` 从 `5` 增至 `7`，worker running/queued 均为 `0`。MR pipeline ID 变化的第二次重启使 `received` 从 `7` 增至 `8`；已读事件没有重复派发。
- **Sources 截图**：在 DSH Superagent「设置 → 来源」页采集启用前后的裁切截图：[`sources-before.png`](sources-before.png)（GitLab Source 关闭）和 [`sources-after.png`](sources-after.png)（GitLab Source 启用，显示项目 `ngd/dsh-superagent-prototype` 与账号 `project_4569_bot`；其他观察开关关闭）。截图避开工作区侧栏，未包含凭据。
- **执行与代码验证**：模型服务返回 HTTP `200`，worker checkout 干净，位于提交 `c5d1ebe`。初次 `pnpm check` 通过：58 个测试文件、1194 个测试、类型检查和构建；修复后 `tests/gitlab.spec.ts` 的 20 个测试通过，`pnpm run build` 成功。
- **CLI smoke 历史**：在功能分支 `e2d4e9d` 上的初次运行因 `glab auth git-credential` 漏掉 `get` 参数而失败；后续提交 `051b9b6` 修复后复跑通过（账号、项目、`updated_at` 从 `14:51:16` 更新到 `15:43:27`、note 读回及 credential helper 均通过）。该次复跑是 HTTPS 自建 CE 的 Issue/credential 路径；本次 profile 的 credential helper 和隔离配置 `git ls-remote` 也单独通过。
- **清理**：pipeline `148266`、`148268`、`148271`、`148272`、`148273`、`148279`、`148309`、`148310`、`148319` 均已取消；临时 MR `!1`、`!2` 均关闭，对应分支均删除。GitLab Source 仍启用，Issue/MR/评论/CI 观察开关已复位为 `false`，`pollSeconds=60`，执行器已恢复，Issue `#1` 保留；最终 test profile 和原 `3082` service 均 healthy。其他 CE 部署形态仍未测试。
