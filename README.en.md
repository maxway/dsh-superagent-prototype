# dsh-superagent

**English** | [简体中文](README.md)

> **This repository is a fork of DeepSeek's official [dsh-superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype).** The official [README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md) explains what the project is, how it works and where the general documentation lives. This README only records the differences from the official project and what is necessary to deploy this fork; it does not repeat the official README.

## Differences from the official project

The changes from the official prototype are grouped by importance below.

### Key features

#### GitLab Source and host switching

Lets this fork work directly with GitLab, including self-managed instances, without depending on GitHub, and switch Git hosts safely from the panel.

- The official prototype only connects to GitHub; this fork adds a GitLab Source. Each deployment has exactly one active Git Source; with both Git plugins installed in the profile, the Sources page can switch the active host.
- A switch is one action: it verifies the target account and repository and restarts once; when the old host still has open Tickets, the switch lists them and asks you to stop them first or confirm explicitly. A Ticket records the host it was accepted under and cannot resume on another one; switch back to continue it.
- The GitLab Source polls project issues, merge requests, notes and pipelines, replies in the original note, binds merge requests to Tickets, and returns CI status to the Executor.
- An optional GitLab webhook: the Source creates or updates the project webhook automatically and starts a sync as soon as an event arrives; without it the Source falls back to polling, which suits deployments with a fixed IP.
- Self-managed GitLab is supported, including instances served over HTTP. Commits, pushes, merge requests, review replies and CI fixes go through `glab`.

#### Native Windows deployment

Runs the service directly on a native Windows host, without WSL, tmux or Python.

- The official prototype targets POSIX hosts; this fork makes the service script a cross-platform Node implementation, and Windows supports the same start, status, stop and restart commands.
- The Executor's command layer, prepare command, router tools, prompts and skills support PowerShell; the Feishu Source resolves the npm `lark-cli` `.cmd` shim to its Node entry and runs it there.
- A project Windows runner runs `pnpm check` for merge requests and the default branch, and a real Windows Ticket has completed the end-to-end flow from an issue to a merge request and a source reply. See [009 Windows deployment](docs/009-windows-deployment.md) for details and the verification record.

#### Off-peak scheduling

Schedules Tickets into the model's off-peak billing window by source, lowering the cost of long tasks.

- The official prototype has no such scheduling; this fork can mark Tickets as `offPeak`, and their Executor starts each new Assignment only inside the daily window in the Execution settings. Feishu requests default to immediate execution unless clearly deferrable; GitLab and GitHub requests default to the window unless clearly urgent.
- The window is off by default, configurable by start time, end time and IANA time zone, and may cross midnight; the default `22:00`–`08:00` (`Asia/Shanghai`) matches the off-peak billing period in Beijing time.

#### Task-level Watchdog check

Adds task-level supervision alongside the process check, so a Ticket that stalls or drifts is noticed. Decisions and reports belong to the independent Watchdog outside the service; the service keeps only the read-only observation surface.

- The independent Watchdog reads every open Ticket's stage, latest report and silence through the read-only `GET /orchestrator/api/watchdog` route, and reports anomalies found from mechanical signals and model judgement. The in-service Watchdog intervention settings, SQLite decision audit and retry/stop route are removed.
- `scripts/dsh-superagent watchdog` prints the machine-readable snapshot with `lastRun`; `watchdog run [--note <text>]` records this observation from the live snapshot (even when nothing is wrong, kept for thirty days); `watchdog runs [--limit <n>]` lists recent observation results; and `watchdog report --chat <chat id> [--note <text>]` sends the observation summary to that chat through the Feishu bot. `status` also reports the DSH home, profile directory, stateDir, bundle link, checkout revision and `lib` as deployment facts a release preflight can reuse.
- `scripts/watchdog` can also run as an independent process with its own configuration, state, log and pid: it needs no DSH profile, records an observation every cycle, and reports when the mechanical findings change. It holds one versioned read-only wait, so a Ticket, health or silence-threshold change wakes it at once; a timeout only reconnects the wait, and `intervalSeconds` is the maximum fallback gap. A configured `dailyReport` adds one quiet report each morning when nothing is wrong; a findings report is unaffected. `--gate` runs only the mechanical pre-check, exits 0 after recording a quiet cycle and exits 2 after recording a risk, so the full DSH agent's model judgement runs only on those risky cycles. The main Session can also send the operator's deploy request through `orchestrator_deploy` to the independent Watchdog; a deployment keeps to the necessary stop, switch, start and basic health check, targeting under a minute in the stable period.

#### Feishu read-only answers

Lets people or bots outside the allowed lists ask questions in a designated group chat without gaining permission to execute.

- A group chat can set the "unlisted · addresses the agent" cell in the admission table to read-only reply: anyone there, including bots and agents, gets an answer after read-only investigation; the work item changes no files, makes no commits, opens no change requests and delivers no pull request.
- Private chats do not offer read-only answers and remain open only to listed people; private messages from anyone else are ignored.

### Special note

- **Stricter Feishu permissions.** The official prototype includes interfaces that read messages and chat information; this fork's Feishu Source only consumes message events and replies, and no longer needs those read permissions. It therefore cannot backfill messages received while the service was offline, read a thread by id, or sync chat members; chat ids and allowed lists are entered by hand.

### Other changes

- **Chinese first.** The official repository documents are English only; this fork adds Simplified Chinese translations of the numbered documents and SETUP, and makes the default README Simplified Chinese, with the English version in [README.en.md](README.en.md). GitHub and GitLab titles, descriptions, comments and review replies follow the language of the request.
- **Service lifecycle and operations.** This fork adds `POST service/stop`: it drains Executors for up to ten seconds, then exits through the DSH launcher; the service script gives each profile its own tmux socket and clears inherited `TMUX` and `TMUX_PANE` before starting; and the panel's Deployment tab shows startup problems, the state directory and host limits, and can run the setup check again.
- **Ticket workspace reclamation.** When a Ticket ends, its linked worktree and local branch are reclaimed if the checkout is clean and every commit is on a remote; when all pull requests the Ticket opened have merged and the remote branch still points at local HEAD, the remote branch is deleted too. Directories with uncommitted or unpushed work are kept.
- **Executor context compaction.** A worker session compacts when the context reaches 40% of the window (`thresholdRatio: 0.4`), so a long Ticket's later requests do not stay near the window limit.

## Deployment

This fork follows the official setup flow and adds the GitLab and Windows steps.

- Ask your coding agent to read [SETUP.md](SETUP.md) (Chinese: [SETUP.zh-CN.md](SETUP.zh-CN.md)) and set up dsh-superagent with you.
- Accounts, manual steps, upgrades and troubleshooting are in [006 Deployment](docs/006-deployment.md); the differences for a Windows host are in [009 Windows deployment](docs/009-windows-deployment.md).
- Prerequisites: Node.js 24.9+, pnpm, Git 2.32+, GitHub CLI 2.48+ or GitLab CLI 1.36+, and DeepSeek Harness within the `engines.dsh` range of `package.json`; POSIX hosts also need tmux and Python 3.8+, and Windows hosts need PowerShell 7 and native `gh`/`glab`. See SETUP for the full list.

## Documentation

The general design and development documents match the official project; start from the [official README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md). This fork additionally provides:

- [009 Windows deployment](docs/009-windows-deployment.md): necessity, adaptation plan, staged implementation and verification record.
- [010 Session retention](docs/010-session-retention.md): measuring the growth of sessions, workspaces and the database, the implemented workspace and branch reclamation, and a cleanup proposal for the rest.
- [011 Multiple Git Sources](docs/011-multi-git-sources.md): the current state, feasibility assessment and staged recommendation for several Git sources or projects in one deployment.
- Simplified Chinese translations of every numbered document, under `docs/zh/`.

## License

[MIT](LICENSE). The official project uses the MIT license as well.