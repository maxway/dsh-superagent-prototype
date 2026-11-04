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
printf 'protocol=https\nhost=%s\n\n' "$HOST" | "$GLAB" auth git-credential >/tmp/glab-cred
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
- 没有真实 CE 冒烟前，PR 保持 draft。