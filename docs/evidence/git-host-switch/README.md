# Git host switching: before and after

These captures show the same page in two isolated, non-production candidates: **Superagent → 设置 → 来源** (Sources
settings), at a 1280 × 1000 viewport with the light theme, Chinese UI, the same two configured Git Sources and the same
single open Ticket. The only intended difference is this change.

- `before-sources-settings.png` — baseline `main` @ `df5d910`: the active Git host is implicit; GitHub has an on switch,
  GitLab an off switch, and changing hosts means saving both switches through a transient no-source state.
- `after-sources-settings.png` — this change: the page names the active Git host and repository, marks the active card,
  replaces the Git on/off switches with one **切换到此来源** action, and keeps the target card configurable.
- `after-switch-confirm.png` — the same page after choosing **切换到此来源**: the switch lists the old host's one open
  Ticket and requires an explicit **仍然切换** confirmation, because that Ticket cannot resume on the new host.

The candidate ran from the ticket worktree in its own DSH profile, `DSH_HOME`, state directory and port; the baseline ran
the same way from a detached worktree at `df5d910`. Both had Feishu disabled, no production state or credentials, and
fake `gh`/`glab` executables that only answer setup's account and repository probes (the examples print no private
material). The one open Ticket is a synthetic record titled 验证切换：旧宿主上的未结束工单, seeded identically in both states
so the list and the confirmation are comparable. The setup and polling banners are not part of these captures.

The switch was also confirmed end to end in the after instance: the deployment became GitLab, the migrated Ticket kept
its `github` host binding, and no Feishu content or credential appears in the images.