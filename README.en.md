# dsh-superagent

**English** | [简体中文](README.md)

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one Git repository, on GitHub or GitLab, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to the active Git host and, optionally, Feishu. When someone allowed asks the agent for work, it opens a Ticket, works on it in its own agent session and directory, and delivers in the original conversation, for example with a pull request or merge request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [000 Philosophy](docs/000-philosophy.md) explains the principle and what it asks of the operator.

This README rebuilds the initial README: it keeps the disclaimer, philosophy, setup instructions, documentation index and license, and focuses on the capabilities added since.

## What's new

### GitLab Source

- A deployment enables exactly one Git Source, GitHub or GitLab. GitHub keeps its existing support for issues, pull requests, comments and default-branch CI.
- The GitLab Source polls project issues, merge requests, notes and pipelines, replies in the original note, binds merge requests to Tickets, and reports terminal states such as merged or closed.
- Self-managed GitLab is supported, including instances served over HTTP. Commits, pushes, merge requests, review replies and CI fixes go through `glab`.
- A Ticket reads pipeline status, and a failing merge-request pipeline returns to the Executor as an Input.

### Native Windows deployment

- The service script is now a cross-platform Node implementation. Windows supports the same start, status, stop and restart commands without tmux, Python or WSL.
- The Executor's command layer, prepare command, router tools, prompts and skills support PowerShell. A Windows host runs one Git Source.
- The Feishu Source works on Windows: the host resolves the npm `lark-cli` `.cmd` shim to its Node entry and runs it without passing arguments through `cmd.exe`.
- A project Windows runner runs `pnpm check` for merge requests and the default branch, and a real Windows Ticket has completed the end-to-end flow from an issue to a merge request and a source reply. See [009 Windows deployment](docs/009-windows-deployment.md) for details and the verification record.

### Off-peak scheduling

- Superagent can mark a complex, non-urgent Ticket as `offPeak`; its Executor starts each new Assignment only inside the daily window in the Execution settings.
- The window is off by default, configurable by start time, end time and IANA time zone, and may cross midnight. A running turn and an Input that wakes an idle Executor are not postponed. The default `22:00`–`08:00` (`Asia/Shanghai`) matches the off-peak billing period in Beijing time.

### Chinese first

- The default README is Simplified Chinese, with the English version in [README.en.md](README.en.md). The numbered documentation and the panel are bilingual.
- GitHub and GitLab titles, descriptions, comments and review replies follow the language of the request. A Chinese request stays Chinese, and English text in the repository is no reason to switch back.

### Service lifecycle and operations

- The management API exposes `POST service/stop`: it drains Executors for up to ten seconds, then exits through the DSH launcher. The service script uses it to stop on Windows without a POSIX signal.
- The service script gives each profile its own tmux socket and clears inherited `TMUX` and `TMUX_PANE` before starting, so a task cannot kill another service on the same machine.
- The panel's Deployment tab shows startup problems, the state directory and host limits, and can run the setup check again.

### Executor context compaction

- A worker session compacts when the context reaches 40% of the window (`thresholdRatio: 0.4`) instead of the default cap, so a long Ticket does not spend most of its later requests near the window limit.

### Stricter Feishu permissions

- The Feishu Source only consumes message events and replies; it no longer calls interfaces that read messages, history, chats or members. It therefore cannot backfill messages received while the service was offline, read a thread by id, or sync chat members; chat ids and allowed lists are entered by hand.

## How it works

1. **Trigger.** The GitHub Source polls issues, pull requests, comments and default-branch CI; the GitLab Source polls issues, merge requests, notes and pipelines; when configured, Feishu chats, direct messages and other chats also produce Triggers. Every Trigger is an immutable event and belongs to a Thread.
2. **Admission and assessment.** The allowed lists and each Source's admission table decide who may request work and which messages count as explicit requests. Everything else goes through assessment: the `observe` acceptance mode (the default) only records proactive work, `auto` actually accepts it, and proactive acceptance must match a rule the team wrote.
3. **Ticket.** Accepted work becomes a Ticket with an immutable Mandate that records the policy version, scope, strength and matched rules at acceptance time. Thread subscriptions deliver later discussion to the Ticket without another mention of the agent.
4. **Execution.** Each Ticket gets a `worker-<ticket>` DSH Session and its own working directory. The prepare command creates the worktree, and the Executor implements, tests and commits there. Tickets are scheduled through executor slots, and a person's message can take an extra slot.
5. **Delivery and follow-up.** The Executor answers in the original conversation and opens or updates a pull request or merge request; review comments, CI results and later human messages all return to the Ticket. A Ticket follows the pull requests it opened until all are closed or merged; an ended Ticket keeps its subscriptions, so a person's later comment resumes it under the same Mandate.
6. **Supervision.** Open **Superagent** in the DeepSeek Harness Web sidebar. The panel shows what needs a person first, then system health and history.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. The prerequisites are Node.js 22.19+ or 24+, pnpm, Git 2.32+, the GitHub CLI or the GitLab CLI, and DeepSeek Harness within the `engines.dsh` range of `package.json`; see [009 Windows deployment](docs/009-windows-deployment.md) for the differences on a Windows host. [006 Deployment](docs/006-deployment.md) covers the full steps, accounts and troubleshooting.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Windows deployment](docs/009-windows-deployment.md): necessity, adaptation plan, staged implementation and verification record
- [010 Session retention](docs/010-session-retention.md): measuring the growth of sessions, checkouts and the database, and a cleanup proposal

## Development

`pnpm check` runs the typecheck, the tests and the build; `pnpm typecheck`, `pnpm test` and `pnpm build` run separately.

- `src/`: the domain model, Sources, Executor, panel and HTTP API.
- `prompts/`, `skills/`: the prompts and skills the router and the Executor use.
- `docs/`, `docs/zh/`: the English and Chinese documentation.
- `tests/`: Vitest tests.
- `cordis.patch.yml`: the DSH bundle definition.

## License

[MIT](LICENSE)