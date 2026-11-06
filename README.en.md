# dsh-superagent

**English** | [简体中文](README.md)

> **This repository is a fork of DeepSeek's official [dsh-superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype).** The official [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) explains what the project is, how it works and where the general documentation lives. This README only records the differences from the official project and what is necessary to deploy this fork; it does not repeat the official README.

## Differences from the official project

The changes from the official prototype are grouped by importance below.

### Key features

#### GitLab Source

Lets this fork work directly with GitLab, including self-managed instances, instead of depending on GitHub.

- The official prototype only connects to GitHub; this fork adds a switchable GitLab Source, and each deployment chooses GitHub or GitLab.
- The GitLab Source polls project issues, merge requests, notes and pipelines, replies in the original note, binds merge requests to Tickets, and returns CI status to the Executor.
- An optional GitLab webhook: the Source creates or updates the project webhook automatically and starts a sync as soon as an event arrives; without it the Source falls back to polling, which suits deployments with a fixed IP.
- Self-managed GitLab is supported, including instances served over HTTP. Commits, pushes, merge requests, review replies and CI fixes go through `glab`.

#### Native Windows deployment

Runs the service directly on a native Windows host, without WSL, tmux or Python.

- The official prototype targets POSIX hosts; this fork makes the service script a cross-platform Node implementation, and Windows supports the same start, status, stop and restart commands.
- The Executor's command layer, prepare command, router tools, prompts and skills support PowerShell; the Feishu Source resolves the npm `lark-cli` `.cmd` shim to its Node entry and runs it there.
- A project Windows runner runs `pnpm check` for merge requests and the default branch, and a real Windows Ticket has completed the end-to-end flow from an issue to a merge request and a source reply. See [009 Windows deployment](docs/009-windows-deployment.md) for details and the verification record.

#### Off-peak scheduling

Moves complex, non-urgent Tickets into the model's off-peak billing window to lower the cost of long tasks.

- The official prototype has no such scheduling; this fork can mark those Tickets as `offPeak`, and their Executor starts each new Assignment only inside the daily window in the Execution settings.
- The window is off by default, configurable by start time, end time and IANA time zone, and may cross midnight; the default `22:00`–`08:00` (`Asia/Shanghai`) matches the off-peak billing period in Beijing time.

### Special note

- **Stricter Feishu permissions.** The official prototype includes interfaces that read messages and chat information; this fork's Feishu Source only consumes message events and replies, and no longer needs those read permissions. It therefore cannot backfill messages received while the service was offline, read a thread by id, or sync chat members; chat ids and allowed lists are entered by hand.

### Other changes

- **Chinese first.** The official repository documents are English only; this fork adds Simplified Chinese translations of the numbered documents and SETUP, and makes the default README Simplified Chinese, with the English version in [README.en.md](README.en.md). GitHub and GitLab titles, descriptions, comments and review replies follow the language of the request.
- **Service lifecycle and operations.** This fork adds `POST service/stop`: it drains Executors for up to ten seconds, then exits through the DSH launcher; the service script gives each profile its own tmux socket and clears inherited `TMUX` and `TMUX_PANE` before starting; and the panel's Deployment tab shows startup problems, the state directory and host limits, and can run the setup check again.
- **Executor context compaction.** A worker session compacts when the context reaches 40% of the window (`thresholdRatio: 0.4`), so a long Ticket's later requests do not stay near the window limit.

## Deployment

This fork follows the official setup flow and adds the GitLab and Windows steps.

- Ask your coding agent to read [SETUP.md](SETUP.md) (Chinese: [SETUP.zh-CN.md](SETUP.zh-CN.md)) and set up dsh-superagent with you.
- Accounts, manual steps, upgrades and troubleshooting are in [006 Deployment](docs/006-deployment.md); the differences for a Windows host are in [009 Windows deployment](docs/009-windows-deployment.md).
- Prerequisites: Node.js 22.19+ or 24+, pnpm, Git 2.32+, the GitHub CLI or the GitLab CLI, and DeepSeek Harness within the `engines.dsh` range of `package.json`.

## Documentation

The general design and development documents match the official project; start from the [official README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md). This fork additionally provides:

- [009 Windows deployment](docs/009-windows-deployment.md): necessity, adaptation plan, staged implementation and verification record.
- [010 Session retention](docs/010-session-retention.md): measuring the growth of sessions, checkouts and the database, and a cleanup proposal.
- Simplified Chinese translations of every numbered document, under `docs/zh/`.

## License

[MIT](LICENSE). The official project uses the MIT license as well.