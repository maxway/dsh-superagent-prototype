# Watchdog intervention removal: Execution settings

Before and after captures of **Superagent → 设置 → 执行** on the same
1440 × 1100 viewport, light theme and Simplified Chinese UI.

- **Before:** the running production panel at `http://127.0.0.1:3083`, baseline
  commit `7ff7178` (`main` before this change). The page is scrolled to the
  Watchdog area so the removed card is visible.
- **After:** an isolated candidate DSH profile (separate DSH home, state
  directory, port `3092`, no Feishu, no production credentials) loading the
  built `lib` from this branch. The Execution settings page now ends after the
  Executor environment and configuration history; the Watchdog intervention
  mode, allowed actions, silence threshold, cooldown and hourly limits are gone.

The candidate profile used its own default model and an empty prepare command,
so those values differ from production; the page, viewport, theme and language
are the same, and the removed card is the only layout difference in the
affected area.

The read-only Watchdog observation endpoints (`GET watchdog`, `POST/GET
watchdog/runs`, `POST watchdog/report`) and the independent `scripts/watchdog`
process are unchanged by this UI removal.