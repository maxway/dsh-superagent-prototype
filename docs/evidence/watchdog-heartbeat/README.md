# Watchdog versions, heartbeat and install facts on the Execution page

Before and after captures of **Superagent → 执行 → 状态** on the same
1440 × 1100 viewport, light theme and Simplified Chinese UI.

- **Before:** an isolated candidate DSH profile (profile `p2-panel`, state
  `D:\dsh-p2-panel\state`, port `3093`, no Feishu, no production accounts)
  loading the built `lib` of commit `37a2c6e`, the merge of `main` before the
  panel change. The page shows the unsolved deployment-check problem and no
  Watchdog line.
- **After:** the same profile, state and port, loading the built `lib` of this
  branch with the panel change. The page shows `Superagent 版本 0.1.0`,
  `Watchdog 版本 p2-panel`, `最近心跳 0 分钟前`, and the installed
  `当前版本 v2`, `上一版 v1`, `候选版本 v2` and `最近更新 2026/11/9 13:25`.
- The after candidate recorded one Watchdog observation through
  `POST /orchestrator/api/watchdog/runs` with `version: "p2-panel"`, and set
  `DSH_SUPERAGENT_WATCHDOG_HOME=D:\dsh-p2-panel\watchdog` with `current.txt`,
  `previous.txt` and `watchdog-update-result.json`, so the values are read by
  the running panel, not a mockup. The before candidate had no recorded run
  and no install home; neither line existed in that build.
- Both pages have the same candidate state, including the unsolved deployment
  check and the empty Ticket list. The only relevant layout difference is the
  two new lines; the page content behind them is unchanged.
- The production instance was not restarted, reconfigured or used for this
  capture; the candidate had no Feishu bot and no production credentials. The
  candidate process was stopped after the capture.

The heartbeat warns instead of treating silence as normal: a missing run shows
`没有心跳记录`, and a run older than twice the stale threshold (60 minutes for
the 30-minute default) shows `心跳已过期`. The install line shows
`最近一次更新失败` when the recorded result says the last update failed.