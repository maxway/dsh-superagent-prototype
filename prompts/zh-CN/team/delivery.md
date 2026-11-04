[English 原文](../../team/delivery.md) | 简体中文

> 说明：运行时提示词仍使用英文原文；此译文仅供参考。

对于每个更改 UI 的工单，PR 描述必须同时包含标注清楚的 Before 和 After 视觉证据，并注明基线版本和变更后的修订版本。
捕获相同场景、视口、主题和相关 UI 状态，确保比较有意义；截图或演示均可接受。
只有 After 证据并不完整。
使用真实应用截图，而不是冒充先前实现的模型图；不要暴露私密飞书内容或凭据。
若后续 UI 变更使比较过时，应更新比较材料。
如果无法获取真实基线截图，应如实说明缺失的证据和限制，保持交接未完成，不要声称 UI PR 已就绪。
执行器（worker）负责捕获并验证比较材料；主 Session（orchestrator）在交付已就绪结果前检查报告中的证据。

请求匹配规则、任务分配、这些提示词或仓库指令所要求的审查。
绝不要以 agent 账号启用自动合并，以免 agent 合并自己的工作；只能使用本节指定的合并 CLI 启用：`<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY`。
若本节没有指定合并 CLI，则每个 PR 都由人类合并。
若指定了合并 CLI，则当以下条件全部满足时，为你从工单分支打开的 PR 的 head commit 启用自动合并：PR 已就绪；其变更少于 200 行（新增加删除）；这些指令要求的每项批准都涵盖该提交；并且若其变更会影响用户所见内容，这些指令已指定谁负责批准此类变更，且该批准涵盖该提交。
无需等待批准即可报告已就绪；批准到达后启用自动合并。
否则由人类合并 PR；在报告中说明这一点。
一旦以下任一条件不再成立（例如审查要求修改），应立即使用 `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` 撤销自动合并，并且必须在推送 PR 前完成；新 head 满足条件后再启用。
绝不要代替审查者批准或合并。
对于你打开的 PR，每位审查者都应获得署名，每个 PR 一次，并体现在 PR 分支的每个提交上：首次评估人类审查者对该 PR 的反馈时，重写分支，使其中每个提交都包含目前已署名的每个人的一条 `Co-authored-by: <name or login> <id+login@users.noreply.github.com>` trailer；其中 id 从 `gh api users/<login> --jq .id` 获取。
先按上述要求撤销自动合并。
运行 `git fetch origin`，设置 `base=$(git merge-base HEAD origin/<base branch>)`，其中 base branch 来自 `gh pr view <number> --json baseRefName`，并设置 `old=$(git rev-parse origin/<head branch>)`；然后运行 `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD`，每位署名者各使用一个 `--trailer`；该操作只会更改提交消息；最后使用 `git push --force-with-lease=<head branch>:$old` 推送；若推送被拒绝，则停止并报告。
之后添加的提交也应带有相同 trailers。
对某个提交的批准也涵盖其重写副本，因为两者的 tree 相同。
如果 PR 已合并，不要重写；在 orchestrator_report 中记录尚未署名的审查者。
绝不要为了给审查者署名而推送空提交。
不要给机器人署名（登录名以 [bot] 结尾的账号，以及这些指令指定为审查机器人的账号）、PR 作者、agent 账号，或这些指令指定的提交作者（其已作为每个提交的作者获得署名）。
在 orchestrator_report 中记录已经署名的人，以免后续执行器重复署名。
若人类正在处理同一问题，且其分支或 PR 包含本工单代码（即来自工单分支的提交，或已包含本工单变更），则无需询问任何人，立即使用 gh 关闭本工单的 PR，并在 PR 上留下一句话，指出该人类的 PR。
仅仅相关，或未包含本工单代码的工作，不构成关闭理由。
关闭 PR 即结束工单；不要发送其他消息。
