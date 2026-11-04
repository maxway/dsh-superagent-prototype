# SETUP

[English](SETUP.md) | **简体中文**

供智能体与其运营者一起安装配置 dsh-superagent 的说明。如果你是真人，请让你的编码智能体阅读本文件并照做。

下面的步骤以 GitHub 为例。GitLab 部署请把 GitHub 读作 GitLab、`gh` 读作 `glab`、pull request 读作合并请求；[docs/zh/006-deployment.md](docs/zh/006-deployment.md) 有 GitLab 账号的步骤，并且只启用 GitLab 来源。

## 如何执行安装配置

安装配置遵循 [000 理念](docs/zh/000-philosophy.md)：尽可能少占用运营者的注意力。

- **在提出第一个问题之前，** 只读本文件和 `docs/zh/000-philosophy.md`，并运行一次下面的探测。在收集齐所有答案之前，不要读其他内容。
- **每条消息只问一个问题，** 只问一件事。等到回答后再问下一个。探测已经能回答的问题就跳过。
- **每条消息控制在 300 词以内，** 除非运营者要求更多。每个问题都给出一个运营者用一个词就能接受的推荐答案，并用一句话说明它为什么重要。
- **提问期间不要执行。** 收齐所有答案后，用一条消息发出完整计划，只有运营者确认后才执行。
- **绝不要在聊天中索要密钥。** 需要运营者亲自操作的步骤，例如创建账号、登录 CLI 或输入应用密钥，要放进一条消息，并给出在运营者自己的终端中运行的确切命令。
- **通过提问来传授这套理念，** 一次一句话，不要变成说教。

## 1. 探测

在这个检出目录中运行一次，结果自己保留：

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **前置条件：** Node.js 22.19+ 或 24+、pnpm、git 2.32+、tmux、Python 3.8+、GitHub CLI 2.48+，以及处于 `package.json` 的 `engines.dsh` 范围内的 DSH。缺少的项会成为计划中的一项，而不是一个问题。DSH 还需要模型服务；如果运营者从未用模型运行过 DSH，配置模型是运营者要做的步骤。
- **运营者登录名：** `gh api user` 的结果是运营者自己的 GitHub 登录名，用作第 5 个问题的推荐答案。
- **已有的 profile：** 如果一个 profile 中已有 `dsh-superagent` 条目，说明之前安装配置过：询问是否继续使用它、保留其配置，并阅读 `docs/zh/006-deployment.md` 中的升级一节。

## 2. 问题

按下面的顺序提问，每条消息只问一个，遵循 [001 领域模型](docs/zh/001-domain.md) 中的工作流：先问触发来自哪里，再问在那里谁可以请求工作，最后问执行器如何处理工单。推荐答案在方括号中。

**来源：请求从哪来。**

1. **来源。** 智能体只接受来自 GitHub 的请求，还是也接受来自飞书群的请求？[只接 GitHub，除非团队在飞书里工作。]
2. **仓库。** 智能体应该在哪个 github.com 仓库上工作，写成 `owner/name`？
3. **智能体账号。** 智能体以哪个 GitHub 用户账号行动？[一个专用账号，绝不用运营者自己的账号：智能体写的一切都会以这个名字出现。] 它可能还不存在；创建它是运营者要做的步骤。
4. 使用飞书时：**哪些群，** 按 `oc_…` chat_id 给出？机器人无法列出群，请从群的设置或消息链接中取得每个 ID。

**策略：谁可以请求工作。**

5. **在 GitHub 上。** 哪些 GitHub 登录名可以向智能体请求工作？[只有 `<operator login>`：智能体只为名单上的人行动，短名单能在运营者了解智能体行为的过程中降低团队噪音。]
6. 使用飞书时：**谁可以在飞书中提问？** [第一个群里的所有人，手工填写：机器人无法读取群成员，名单不会自动同步。]

**执行：智能体如何处理工单。**

7. **检出目录。** 每个工单应该从哪个本地克隆检出？[`~/src/<name>` 下的新克隆。]
8. **提交身份。** 智能体的提交应该以谁为作者？[智能体账号，这样它的工作明显是它自己做的。] 其他身份，例如运营者的身份，要写进 Delivery requirements 提示词段落。
9. **自动合并。** 智能体自己的 pull request 就绪并通过批准后，智能体是否应启用自动合并？[否：在智能体的 pull request 连续一段时间都正确之前，由人来合并。] 智能体绝不会以智能体账号的身份启用自动合并，因此若选是，它需要另一个有合并权限账号的 GitHub CLI：请运营者在运营者步骤中登录一个，并在 Delivery requirements 中写明。若选否，从 Delivery requirements 中删除自动合并那一段。

不要询问已有良好默认值的事项；把它们列在计划里：

- profile `superagent`，DSH Web profile 的副本，与运营者自己使用的 profile 分开，这样重启时不会关闭他们的 Session；端口 `3082`；状态目录 `<home>/.dsh/state/superagent`（绝对路径）；
- 从运营者自己的 profile 出发的每小时检查，在 dsh-superagent 没有运行时修复它；
- 分支前缀 `agent/`；
- 接单模式 `observe`，只记录主动工作而不执行，以及默认的规则和提示词段落；
- 使用飞书时：机器人只读取提及，且开启私信。

## 3. 计划

用一条不到 300 词的消息说明：将安装什么、账号和 CLI、要保存的设置、运营者步骤以及默认值。请求一次确认。

## 4. 执行

1. **先做运营者步骤。** 阅读 `docs/zh/006-deployment.md` 的账号一节，自己写好 CLI 包装脚本，然后用一条消息说明只有运营者能做的事：创建智能体账号；如果启用自动合并，让负责启用自动合并的账号登录一个 CLI；以智能体账号接受仓库邀请；为每个包装脚本运行 `auth login`；使用飞书时，创建并发布机器人应用，并用其密钥运行 `config init` 命令。等运营者说完成后，用 `<wrapper> api user --jq .login` 检查每个登录。
2. **安装并启动。** 遵循 `docs/zh/006-deployment.md` 的安装、机器配置以及启动和停止几节。跳过本仓库的 `git clone`：你就在它的检出目录中。如果第 7 个问题要求新克隆，克隆第 2 个问题中的仓库。如果已有 profile，跳过 `dsh superagent --from-default-profile` 命令，它会替换 profile 并删除其 `cordis.patch.yml`；改为编辑那个文件，而不是替换它。
3. **设置。** 通过 `docs/zh/006-deployment.md` 的管理 API 保存，顺序如下：`github` 来源；如果使用飞书，`feishu` 来源；带允许名单的 `policy` 块（飞书的群 id 需要手工填写，机器人无法列出群）；以及带第 7 个问题答案中准备命令的 `executor` 块。然后保存提示词，在 Delivery requirements 中写入第 8 个问题的提交身份和第 9 个问题的自动合并答案。返回 `restarting: true` 的保存会重启 dsh-superagent：等到 `scripts/dsh-superagent status` 不再以退出码 1 结束，再进行下一个请求，并重新从 `GET settings` 读取修订版本。
4. **失败。** 被拒绝的保存会在响应体中指明安装配置问题。在 `docs/zh/006-deployment.md` 的故障排查表中找到它，修复后继续。只向运营者询问你无法自行修复的内容。

## 5. 验证并交接

`scripts/dsh-superagent status` 以退出码 0 结束，且没有安装配置问题。如果你在运营者自己的 DSH profile 中运行，用你的调度工具创建 `docs/zh/006-deployment.md` 的每小时检查一节所述的每小时检查；否则把它的提示词交给运营者，让其在那边安排。然后用一条不到 300 词的消息说明：

- 面板 URL，以及侧边栏中的 **Superagent** 条目是要查看的地方。
- 如何试用：用允许名单内的账号，在仓库的 issue 下评论 `@<agent login> <request>`。大约一分钟内，总览页会出现一个工单。
- 给运营者的三条规则，来自 [000 理念](docs/zh/000-philosophy.md)的责任一节：从窄开始，为更少噪音而调整，为智能体所说的话负责。
- 进一步阅读的位置：按顺序阅读 `docs/zh/` 中的编号文档。
