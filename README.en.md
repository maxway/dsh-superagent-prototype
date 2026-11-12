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
- An optional GitLab webhook: the Source creates or updates the project webhook automatically and starts a sync as soon as an event arrives; it requires a stable address reachable by GitLab; without it the Source continues polling.
- Self-managed GitLab is supported, including instances served over HTTP. Commits, pushes, merge requests, review replies and CI fixes go through `glab`.

#### Ticket categories, model tiers and handoff

- Tickets use `query`, `research` or `development` to define authorization, independently of the `low` / `high` capability tier used for model selection. Queries default to `low`, other work to `high`. An unset tier model falls back to the category model, the Executor default, then the host default; settings changes do not change an existing Session's model.
- When the same authorized task needs greater capability, an eligible Feishu-origin `low` Ticket can hand off to a new `high` Ticket without expanding its authorization. The successor uses a summary and a new workspace; complete context and duplicate-free switching are not guaranteed. See [003 Execution](docs/003-execution.md#ticket-categories-and-models) for conditions and configuration.

#### Native Windows deployment

Runs the service directly on a native Windows host, without WSL, tmux or Python.

- The official prototype targets POSIX hosts; this fork makes the service script a cross-platform Node implementation, and Windows supports the same start, status, stop and restart commands.
- The Executor's command layer, prepare command, router tools, prompts and skills support PowerShell; the Feishu Source resolves the npm `lark-cli` `.cmd` shim to its Node entry and runs it there.
- A project Windows runner runs `pnpm check` for merge requests and the default branch, and a real Windows Ticket has completed the end-to-end flow from an issue to a merge request and a source reply. See [009 Windows deployment](docs/009-windows-deployment.md) for details and the verification record.

#### Off-peak scheduling

Schedules Tickets into the model's off-peak billing window by source, lowering the cost of long tasks.

- The official prototype has no such scheduling; this fork can mark Tickets as `offPeak`, and their Executor starts each new Assignment only inside the daily window in the Execution settings. For models known to have peak/off-peak pricing (currently `deepseek-v4.1-flash`), Feishu requests default to immediate execution and GitLab and GitHub requests to the window. Other or unknown models default to immediate execution; an explicit choice can defer or expedite any model.
- The window is off by default, configurable by start time, end time and IANA time zone, and may cross midnight; the default `22:00`–`08:00` (`Asia/Shanghai`) matches the off-peak billing period in Beijing time.

#### Task-level Watchdog check

The intended independent Watchdog observer reads service and Ticket snapshots from `GET /orchestrator/api/watchdog` at fixed intervals, without long polling, and records local state, logs and heartbeat. It does not run a model, send Feishu messages, write to the service, automatically recover services or Tickets, poll deployment requests, or update itself; the launcher runs only the installed version.

This is not proactive notification: an operator must inspect the evidence or arrange separate alerts. Service-side enforce recovery APIs may still be callable; a read-only observer does not disable them. Existing production requires a separate Watchdog deployment before the new behavior applies, and older installations and independent tasks may retain their behavior. See [006 deployment](docs/006-deployment.md#independent-watchdog-process) for deployment and limitations.

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

For general background, see the [official README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md); use this repository's documentation for the fork's current behavior:

- [003 Execution](docs/003-execution.md): Ticket categories, model selection, handoff and recovery.
- [012 Worker handoff design](docs/012-worker-handoff.md): a broader proposal, not implemented; distinct from the existing capability handoff.
- [009 Windows deployment](docs/009-windows-deployment.md): necessity, adaptation plan, staged implementation and verification record.
- [010 Session retention](docs/010-session-retention.md): measuring the growth of sessions, workspaces and the database, the implemented workspace and branch reclamation, and a cleanup proposal for the rest.
- [011 Multiple Git Sources](docs/011-multi-git-sources.md): the current state, feasibility assessment and staged recommendation for several Git sources or projects in one deployment.
- Simplified Chinese translations of every numbered document, under `docs/zh/`.

## License

[MIT](LICENSE). The official project uses the MIT license as well.