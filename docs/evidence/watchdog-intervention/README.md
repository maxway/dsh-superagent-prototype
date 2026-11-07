# Watchdog intervention settings: before and after

These captures show the same page in an isolated candidate: **Superagent → 设置 → 执行** (Execution settings), at a
1440 × 1000 viewport with the light theme, with the same empty state and setup banner. The only intended difference is the
**Watchdog 介入** block added by this change.

- `before.png` — baseline `main` @ `e095162` (MR !30 merged; no `watchdog` settings block in the panel).
- `after.png` — this change (`watchdog` settings block, intervention API, audit and stop), built from the ticket worktree.

The candidate was a separate DSH profile with its own `DSH_HOME`, state directory and port; Feishu, GitHub and GitLab
Sources were disabled, and it had no tickets, credentials or production data. The setup banner is expected because the
candidate has no Source configured; it is identical in both captures. The panel is scrolled to the Execution settings
block where the new Watchdog section lives. The after capture shows the default `observe` mode, `retry` allowed, `stop`
off, and the default thresholds (30 / 15 / 2 / 6). No private Feishu content or credentials are present.
