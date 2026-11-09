# Watchdog version and heartbeat on the Execution page

Before and after captures of **Superagent → 执行 → 状态** on the same
1440 × 1100 viewport, light theme and Simplified Chinese UI.

- **Before:** an isolated candidate DSH profile (profile `p2-panel`, state
  `D:\dsh-p2-panel\state`, port `3093`, no Feishu, no production accounts)
  loading the built `lib` of commit `37a2c6e`, the merge of `main` before the
  panel change. The page shows the unsolved deployment-check problem and no
  Watchdog line.
- **After:** the same profile and state, loading the built `lib` of this
  branch with the panel change. The page shows `Superagent 版本 0.1.0`,
  `Watchdog 版本 p2-panel` and `最近心跳 0 分钟前` under the status line.
- The after candidate recorded one Watchdog observation through
  `POST /orchestrator/api/watchdog/runs` with `version: "p2-panel"` and
  `commit: "37a2c6e"`, so the version and heartbeat are real values read by
  the panel, not a mockup. The before candidate had no recorded run; the
  version/heartbeat line did not exist in that build.
- Both pages have the same candidate state, including the unsolved deployment
  check and the empty Ticket list. The only relevant layout difference is the
  new line; the page content behind it is unchanged.
- The production instance was not restarted, reconfigured or used for this
  capture; the candidate had no Feishu bot and no production credentials. The
  candidate process was stopped after the capture.

The line warns instead of treating silence as normal: a missing run shows
`没有心跳记录`, and a run older than twice the stale threshold (60 minutes for
the 30-minute default) shows `心跳已过期`.