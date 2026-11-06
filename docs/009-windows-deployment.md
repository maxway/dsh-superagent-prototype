# 009 Windows deployment

This document answers two questions: whether dsh-superagent should run on a native Windows host, and what that would take. For this project the host must be Windows because its workers run a Windows-only toolchain; this plan covers only the dsh-superagent Windows deployment. The project's own toolchain work — Unity batchmode builds, exe packaging, smoke tests, project-specific skills and CI job definitions — is outside this scope and stays with the project.

The question is about the host, not about who can use the agent. Every user opens the panel in a browser and mentions the agent in the Source conversation, so a Windows desktop never needs a local copy of the service.

## Summary

- **Required for this project's host.** The workers must run the project's Windows-only toolchain, so the agent host must be Windows. This plan ports the deployment only; the project's own build and smoke work is out of scope.
- **Estimate:** a usable internal build takes about 9-13 person-days: 2-2.5 weeks for one developer, including the proof of concept and end-to-end verification, without Feishu and without a Windows CI runner.
- **Full parity** — Feishu, Windows CI, bilingual setup documentation and the hardening that keeps both platforms tested — takes about 12-18 person-days, or 3-4 weeks for one developer.
- **Status (2026-11-06):** stages 1-4 are implemented and tested on Linux. A manual Windows run of `pnpm check` now passes with documented POSIX-only skips, the proof of concept's native-path blocker is fixed, and a real Windows `start`/`status`/`stop`/`restart` smoke through the service script passes. A Windows runner, the end-to-end run and Feishu are still missing, so Windows remains experimental and the Feishu Source is not supported there.
- **Recommendation:** port the deployment; start with the 1-2 day proof of concept, then follow the staged plan below. The project's toolchain work is separate.

## What deploying on Windows means

dsh-superagent is one service for one repository. It polls the Git host, opens Tickets, works in its own checkouts, and answers in the conversation or opens a merge request. People use it through the web panel and Feishu; they never run it themselves.

Two different questions hide behind "Windows deployment":

- **Host:** the machine that runs the service, its DSH profile, its CLIs and its state directory. This document is about the host.
- **Clients:** the machines that open the panel or write in Feishu. They already work, because the panel is a browser application.

A Linux host, a WSL2 distribution on a Windows machine, a Linux virtual machine, a container, or a remote server all answer the client question. Native Windows only changes the host. If the goal is "our Windows developers can use the agent", nothing is missing today.

## Current support

### DeepSeek Harness

DSH already runs on Windows and treats it as a first-class platform:

- The shipped base profile mounts the PowerShell twins of the bash shell rows on `win32` — `dsh-pwsh-sandbox` plus `tool-pwsh` instead of `dsh-bash-sandbox` plus `tool-bash` — including the ACL restricted-token sandbox.
- The ordinary subprocess runner and the ACL sandbox have native Win32 implementations, including Job Object process containment.
- The launcher, profiles, plugin management, web server and session storage are Node applications without a POSIX-only dependency. The pinned DSH version in [006 Deployment](006-deployment.md) is the same package on every platform.

No upstream DSH work is needed for this port.

### dsh-superagent

The bundle already switches its two agent presets between bash and pwsh by platform (`cordis.patch.yml`), so a Windows worker receives the PowerShell tool. When this plan was written, the runtime and deployment layers did not follow.

| Area | Current implementation | Native Windows status |
| --- | --- | --- |
| Service control | `scripts/dsh-superagent` is a Node script: tmux and `ps` on POSIX, a detached process and the management stop route on Windows | Runs on both; Windows has no `SIGINT`, so stop uses `POST /orchestrator/api/service/stop` |
| Worker command shims | Extensionless `#!/bin/sh` files in `worker-bin`, prepended to `PATH` | PowerShell and `CreateProcess` do not execute them; account selection and blocked commands are lost |
| CLI wrappers and probes | Shell-script wrappers; setup probes run `env PATH=... <cli>`; `execFile` and `spawn` call the CLI directly | No `env` on Windows; `execFile` cannot run `.cmd`; npm-installed `lark-cli` is a `.cmd` |
| Prepare command | Always `sh -c <command>` | No `sh` by default; the documented command uses POSIX variables |
| Router tools | The master Session's allow list and wait guard hard-code `bash` | The `pwsh` tool is removed from the router; its wait guard never applies |
| Prompts and skills | "Workers use bash" and bash examples | The worker has PowerShell, so the instructions and examples are wrong for it |
| Setup and docs | `~/.local/bin`, `cat > ... <<'EOF'`, tmux, Python, `$HOME` | Need Windows equivalents |
| Tests and CI | POSIX fixtures, shells, `:` as the PATH separator; no Windows job | `pnpm check` is not expected to pass on Windows |

[006 Deployment](006-deployment.md) documented only the POSIX path when this plan was written, so even a hand-started Windows service would fail setup before it could poll. Stage 4 adds the Windows guidance; the status below records what is still missing.

### Implementation status (2026-11-06)

The table above is the assessment this plan started from. Stages 1-4 have since addressed these gaps:

- **Stage 0 (partial).** The proof of concept on the operator's Windows machine found two blockers: `stateDir` and `executor.directory` rejected native `C:\...` paths, and the setup probe passed its environment through a POSIX `env` executable. Both fixes are in main. A real Windows start/status/stop/restart smoke and the prepare command now pass there too; the end-to-end run against a target repository still belongs to stage 5.
- **Stage 1.** `scripts/dsh-superagent` is a Node script. POSIX keeps tmux and `SIGINT`; Windows starts a detached process and stops through `POST /orchestrator/api/service/stop`. Both the POSIX path and an isolated Windows profile pass start/status/stop/restart; the Windows smoke also found and fixed two process-detection defects (see [the stage 5 evidence](evidence/windows-stage5/)).
- **Stage 2.** The worker command layer resolves `PATHEXT`, writes `.cmd` guardrails only for blocked and inactive commands, and selects the agent account with `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR` and `LARKSUITE_CLI_CONFIG_DIR`; probes and git credentials use native argv.
- **Stage 3.** The prepare command runs through `sh -c` on POSIX and `pwsh -NoProfile -NonInteractive -Command` on Windows; the router accepts `pwsh`; prompts and skills are shell-neutral.
- **Stage 4.** Added the Windows setup and deployment path in both languages.
- **Stage 5 (partial).** `pnpm check` passes on a Windows host (Windows 10 19045, Node.js 24.21.0, pnpm 11.7.0) with the POSIX-only suites skipped for the reasons recorded in [the stage 5 evidence](evidence/windows-stage5/), and a real Windows `start`/`status`/`stop`/`restart` smoke through the service script passes. A Windows CI runner and the end-to-end run against a scratch GitLab project are not done.
- **Not done.** Stage 5's Windows runner and end-to-end run, and the Feishu Source on Windows (WP6). Windows therefore remains experimental; do not call it supported until stage 5 passes.

## Is it necessary?

### Scenarios

| Scenario | Value of native Windows | Recommendation |
| --- | --- | --- |
| The repository is OS-agnostic; a Linux host, WSL2 or a container is available | Low: the service works today | Keep the Linux host; do not port |
| Workers must build or test Windows-only code, such as a desktop or driver project | High: the worker needs the Windows toolchain and checkout | Port, or add a Windows worker later; start with the proof of concept |
| WSL2 and every Linux host are forbidden, and the agent must run on a given Windows machine | Required: there is no other host | Port, with the plan below |
| Windows developers only need to open the panel or mention the bot | None: the panel is a browser application and Feishu is remote | Keep the host on Linux |
| A prototype demo on a Windows laptop | Low: WSL2 or a small Linux VM is enough | Do not port for the demo |

### Cost of support

A port is not a one-time cost. After it, every change must be checked on two platforms; the worker shell differs (`bash` and `pwsh`), so prompts, skills and tests need platform-aware text; a Windows runner has to exist to keep it honest; and the isolation story is weaker, because the blocked-command shims are a guardrail while the real boundary stays a dedicated operating-system account. For a research prototype with one repository and a shared service, that cost buys little unless one of the scenarios above is real.

### Verdict

**Necessary for this project's host, with a focused scope.** The workers must run the project's Windows-only toolchain, so the host cannot stay on Linux or WSL2. This plan covers the dsh-superagent deployment: service lifecycle, CLI environment, prepare, tool names, documentation and tests. It does not implement the project's Unity build, exe packaging, smoke tests or project-specific skills; those stay with the project and are only a prerequisite for using the agent. Run the 1-2 day proof of concept first; it measures the three uncertain areas (CLI invocation, graceful stop, prepare command) before the rest of the work is committed.

## Adaptation plan

### Principles

- Keep one behavior on both platforms and keep the POSIX path working; a Windows deployment must not change what an existing Linux installation does.
- Use the platform's native mechanisms instead of emulating POSIX: `pwsh` for the worker shell and prepare commands, `cmd.exe` only where a `.cmd` file must be launched, and DSH's `ctx.appExit` for a controlled shutdown.
- Keep platform differences in small helpers with a platform argument, as DSH does, so the branches are unit-testable on Linux.
- Treat the port as a prototype-quality change: no new runtime dependency, no settings migration unless a field is unavoidable, and no change to the database format.

### Work packages

| WP | Scope | Person-days | Depends on |
| --- | --- | --- | --- |
| WP0 | Proof of concept on a real Windows machine | 1-2 | — |
| WP1 | Service lifecycle: start, status, stop, restart, logs, lock | 2-3 | WP0 |
| WP2 | CLI and worker environment: probes, shims, wrappers, blocked commands | 2-3 | WP0 |
| WP3 | Prepare command, router tools, prompts and skills | 1-1.5 | WP2 |
| WP4 | Setup and deployment documentation, both languages | 1.5-2 | WP1-3 |
| WP5 | Windows tests and CI | 2-3 | WP1-4 |
| WP6 | Feishu on Windows, optional | 1-2 | WP2 |
| WP7 | End-to-end verification and hardening | 1.5-2 | WP1-5 |

### Staged execution

The work packages are the technical breakdown; the stages are the execution and acceptance order. Each stage ends with a reviewable change and a check, and the next stage starts only when the previous acceptance holds. Stage 0 and stage 5 need a Windows machine; stages 1-4 can be built and tested on Linux with a platform argument.

| Stage | Scope | Acceptance | Windows host |
| --- | --- | --- | --- |
| 0 | Proof of concept on the target machine | DSH, the panel and the pwsh tool load; setup's blockers are measured; go or no-go is recorded | Required |
| 1 | Service lifecycle: Node service script and `service/stop` | `pnpm check`; a real DSH stop test through the route; status JSON, exit codes, markers, logs and locks unchanged; Windows start/stop smoke deferred to stage 0/5 | No on Linux; Windows smoke needs a host |
| 2 | Worker command layer: platform runner and probes, Win32 shims, `PATHEXT`, blocked commands, account selection | Unit tests cover generated files and argument handling; POSIX behavior is unchanged | No |
| 3 | Prepare, router tools, prompts and skills | Tests pass; Linux keeps the `sh` path; Windows commands are documented | No |
| 4 | Setup and deployment documentation | `pnpm check` and the documentation tests pass; a person reviews the Windows path | No |
| 5 | Windows CI and end-to-end verification, Feishu optional | A Windows runner runs `pnpm check`; a real ticket completes setup, prepare, push and merge request; Linux still passes | Required |

### WP0: proof of concept

On a clean Windows 11 or Windows Server machine, install Node 22.19+ or 24, pnpm, git, PowerShell 7 and the DSH version pinned in [006 Deployment](006-deployment.md). Create the `superagent` profile, add the bundle with `link:`, open the panel and confirm that the Web profile, the `pwsh` tool and the isolation settings load. Then reproduce the three blockers on purpose: setup's `env` probe, an `execFile`/`spawn` call with a `.cmd` wrapper, and the prepare command under `sh -c`. Exit when the three have a measured answer; stop if DSH itself fails to run, because that would change the whole estimate. The target is the operator's local Windows machine; the agent process runs on Linux and cannot operate it directly, so the operator runs these commands or provides a remote channel.

### WP1: service lifecycle

Replace the Python service script with one cross-platform Node script (recommended) or add a PowerShell twin (fallback). The recommended version keeps the current command line, exit codes, log names, `manually-stopped` marker and status output, and adds:

- Start: spawn `dsh --profile <profile> --no-open` detached with its output redirected to the existing log path; record the PID; wait for `GET state` to answer and print setup problems exactly as today.
- Status: read the PID file and the management API; detect duplicates; keep the four exit codes.
- Stop and restart: call a new loopback management route, `POST service/stop`, which asks the plugin to exit through `ctx.appExit(0)` after the response is sent; the current DSH shutdown path then disposes the profile. This is the portable graceful stop: Windows cannot deliver `SIGINT` across processes, and `os.kill(pid, SIGINT)` would terminate the process instead. On POSIX the script may keep `SIGINT` as a fallback.
- Lock and logs: an exclusive control lock, for example `proper-lockfile`, already a dependency, and log pruning as today.

Self-review findings before implementation:

- **Stop timing.** DSH's launcher force-exits five seconds after `appExit` or `SIGINT` (`PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000` in the profile boot), while the Executor drain is bounded at ten seconds (`SHUTDOWN_STOP_MS = 10_000`). An immediate `ctx.appExit(0)` route would cut a mid-turn worker off and cannot support the "five minutes" claim in [006 Deployment](006-deployment.md). The route answers, drains through `Runtime.stop()`, then calls `ctx.appExit(0)`; the documented bound is the drain plus the launcher grace. **Decision: option A.** Keep the ten-second drain and accept the roughly fifteen-second stop; a longer drain that lets long turns finish is a separate feature, not this port.
- **Windows start.** `dsh` is an npm `.cmd` on Windows; a plain `spawn('dsh')` fails. Resolve it with `where dsh`, launch through `cmd.exe /d /s /c` detached, redirect the log, and record or discover the Node PID with `Get-CimInstance`; there is no `ps` or `tmux`. Add a Windows start/stop smoke or defer it to stage 0/5.
- **Route verification and fallback.** The current unit test only checks that the host method is called; an integration test must start a DSH profile on Linux, POST `service/stop`, see the response and observe the exit. If `appExit` is absent, the route should refuse with 500 instead of returning `stopping: true` and hanging.
- **Compatibility and test budget.** Replacing the 250-line Python script and its 300-line test suite with Node needs golden tests for the status JSON, exit codes, markers, logs and locks; budget three to four person-days for WP1, not two to three.

The fallback is a PowerShell twin plus the same `service/stop` route, for example through a Windows service wrapper; it is faster to write but leaves two service implementations to maintain. The `tests/service-script.spec.ts` suite is rewritten around injected process and HTTP fakes so it runs on both platforms.

### WP2: CLI and worker environment

The CLI and account layer needs the most design care. The current model has two layers: extensionless `#!/bin/sh` shims in `worker-bin` that redirect bare `gh`, `glab` and `lark-cli` to the agent wrappers, and the wrapper scripts themselves, which set the agent configuration directories. Neither layer works on Windows as written.

Recommended design:

- Select credentials with environment variables rather than wrapper scripts: `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR` and `LARKSUITE_CLI_CONFIG_DIR`, set for the plugin process and inherited by worker shells. Add optional `configDir` fields to the Git and Feishu Source settings, with the current documented paths as defaults, so the panel can manage them.
- Point the `cli` setting at the real executable, `gh.exe` or `glab.exe`, and run it with normal argv, never through a shell: arbitrary text such as a merge-request body must not pass through `cmd.exe` quoting. Keep POSIX wrapper support for existing installations.
- Fix the probes: `workerProbe` and the Feishu probe pass `PATH` through the child environment instead of launching `env`; `executable()` learns `PATHEXT` and no longer requires the POSIX execute bit.
- Keep blocked commands as guardrail shims, written as `.cmd` files on Windows so PowerShell resolves them first. `gh`, `glab` and `lark-cli` no longer need account shims because the environment selects the account.
- Feishu: `lark-cli` on Windows is normally an npm `.cmd`; run it through a small Node launcher or require a native build, and keep message text out of `cmd.exe` quoting. This is WP6.

Alternative considered: keep the wrapper model and launch `.cmd` wrappers through `cmd.exe`. It is less work in settings but unsafe for CLI arguments that carry JSON or arbitrary message text, so it is not recommended as the long-term shape. A short internal trial can use it, provided the service environment sets the three configuration directories and the `cli` fields point at the wrappers.

### WP3: prepare command, router tools, prompts and skills

- Prepare: run the configured command through the platform shell: `sh -c` on POSIX and `pwsh -NoProfile -NonInteractive -Command` on Windows. Document the Windows form with `$env:DSH_SUPERAGENT_DIR` and a `git worktree` example; PowerShell 7 supports `&&`.
- Router tools: add `pwsh` to the master Session's allow list and to the `noWait` guard, or derive the shell tool name from the registered tools.
- Prompts and skills: replace "Workers use bash" with shell-neutral wording; audit the bundled skills for POSIX-only examples (`head`, `printf`, `$(...)`, `$VAR`) and provide PowerShell equivalents or shell-neutral steps. The worker can usually translate, but instructions should not train it on the wrong dialect.

### WP4: setup and deployment documentation

- `SETUP.md` and `SETUP.zh-CN.md`: a Windows prerequisite and operator section (PowerShell 7; Node, pnpm, git, gh/glab; no tmux or Python), PowerShell wrapper or configuration examples, and the new service commands.
- `docs/006-deployment.md` and its translation: Windows service management, credential directories, the prepare example, paths such as `%USERPROFILE%` and `C:\...`, and troubleshooting entries for the Windows-only failures.
- `examples/profile.cordis.patch.yml`: a Windows `stateDir` example; no structural change.
- `locale/*.json`: the prepare-command hint currently says the command runs with `sh`; make it platform-neutral.
- Keep the documentation honest: mark Windows as supported only after WP5 and WP7 pass, and state the isolation caveat.

### WP5: Windows tests and CI

- Add a platform argument to the helpers that read `process.platform`, and unit-test the Windows command generation, shim text, PATHEXT resolution and probe construction on Linux.
- Rewrite the service-script test around Node fakes; keep the POSIX test for the POSIX path if the Python script is kept.
- Triage `pnpm check` on Windows: many tests use POSIX fixtures, `:` PATH separators, `python3` and `#!/bin/sh` helpers. Skip POSIX-only tests on Windows only when a Windows-specific test covers the same behavior, and record why in the test.
- Add a Windows runner, for example a GitLab runner tag or a scheduled job, that runs `pnpm check` and, if feasible, a smoke test against a scratch repository. Without it, Windows support will rot.

### WP6: Feishu on Windows, optional

`lark-cli` from npm is a `.cmd`; the Feishu Source uses `spawn` for the long-running event consumer and `Commands.run` for one-shot calls. Run it through a Node launcher (the package's JS entry) or a native executable, keep message text out of shell quoting, and re-check the consumer's stop behavior on Windows, where stdin close plus `kill` becomes a terminate. If Feishu is out of scope, the Windows deployment supports only the Git Sources and the documentation must say so.

### WP7: end-to-end verification and hardening

A clean Windows machine, a real repository and a test ticket: setup passes; a mention creates a Ticket; the prepare command creates a worktree; the worker uses `pwsh`; the agent edits files, commits and pushes; the merge request is opened; the panel shows the result; `start`, `status`, `stop` and `restart` behave as on Linux; `stop` is graceful; logs are written. Re-run the same ticket on Linux to confirm no regression. Check the Windows-specific traps: PATH length, spaces and parentheses in paths, line endings under the isolated git configuration, executable bits on new scripts, symlinks if the repository uses them, and the 260-character path limit.

### Alternatives

- Keep the Python service script and add a PowerShell twin: lower risk for the existing POSIX path, two implementations to keep in sync.
- Use `.cmd` wrappers plus `cmd.exe`: the smallest settings change, but argument quoting is unsafe for JSON and message text.
- Run the worker in Git Bash on Windows: removes some shell differences but still needs the service script, adds an MSYS2 dependency the bundle does not otherwise use, and leaves the worker on the wrong shell unless the Windows presets are changed.
- Do nothing: keep the Linux or WSL2 host; this is not viable for this project because the host must run the project's Windows-only toolchain.

## Estimate

### Assumptions

- One developer who knows this repository, with a Windows machine that can install Node, git and the CLIs, and a test repository.
- No upstream DSH change; the pinned DSH version already supports Windows.
- Feishu is optional; a GitLab or GitHub source is the minimum.
- The estimate covers the port and its tests, not a redesign of the policy, the panel or the store.

| Phase | Contents | Person-days | Calendar for one developer |
| --- | --- | --- | --- |
| Proof of concept | WP0; measure the three uncertain areas | 1-2 | 1-2 days |
| Usable internal build | WP0-WP4 and WP7; no Feishu, no Windows CI | 9-13 | 2-2.5 weeks |
| Full parity | WP0-WP7 | 12-18 | 3-4 weeks |
| With contingency | Add 20-30% to full parity | 15-23 | 3.5-5 weeks |

### Calendar

The usable internal build is about 2-2.5 weeks of focused work; the full parity version is about 3-4 weeks, and 3.5-5 weeks with the contingency. Part-time work stretches the calendar roughly proportionally. If the proof of concept finds a DSH-level blocker, stop and re-estimate; none is expected today.

## Verification

### Acceptance criteria

- On a clean Windows machine, `pnpm check` passes, with documented Windows skips, and the service starts, reports status, stops gracefully and restarts.
- A real ticket from the Git Source completes end to end: setup, Ticket, prepare, worker turn, commit, push, merge request, panel state and the source-conversation reply.
- The same flow still passes on Linux with the same commit; no behavior changes for existing installations.
- Documentation states the supported surface, the prerequisites and the isolation caveat.

### Test matrix

| Area | Linux | Windows | Method |
| --- | --- | --- | --- |
| Unit and integration tests | Required | Required | `pnpm check`, with platform-argument tests for Windows generation |
| Service lifecycle | Required | Required | Fake DSH and HTTP in tests; real DSH in WP7 |
| CLI invocation and blocked commands | Required | Required | Unit tests for argv, PATHEXT and `.cmd`; real CLIs in WP7 |
| Prepare command | Required | Required | Real worktree creation in WP7 |
| Feishu, if in scope | Required | Required | Bot event and message in WP7, optional |

## Risks and open decisions

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `cmd.exe` quoting corrupts JSON or message text | Wrong API calls, corrupted merge requests | Use native executables and argv, not shell strings; restrict `cmd.exe` to `.cmd` launch only |
| No portable graceful stop | Force-killed workers, lost turns | Add the `service/stop` route through `ctx.appExit`; keep the POSIX signal fallback |
| Windows paths, line endings, executable bits or symlinks change commits | Broken scripts or noisy diffs in merge requests | Verify in WP7; set the isolated git configuration explicitly; use `git add --chmod=+x` when needed |
| Dual-platform drift | Windows breaks silently | Windows CI and a smoke test; platform-argument unit tests |
| Weaker isolation | A worker can act as the operator | Keep the dedicated OS account recommendation; blocked commands remain a guardrail only |
| Feishu's npm `.cmd` launcher | Feishu unavailable on Windows | Node launcher or native CLI; keep Feishu optional |

### Open decisions

- Node service script versus PowerShell twin.
- Whether Feishu is in the first release or a follow-up.
- Whether the account configuration moves to `configDir` settings or stays in wrapper scripts for POSIX and environment variables on Windows.
- Whether a Windows CI runner is available; without one, mark Windows as experimental.
- Whether the operator can provide remote access to the local Windows machine for the POC, and whether its project-toolchain prerequisites are installed.

## Out of scope

- A Windows desktop application, per-developer agents, or a service for multiple repositories.
- The project's Unity batchmode build, exe packaging, smoke tests, project-specific skills and CI job definitions; this plan only makes the Windows host able to run them.
- Hardening beyond the current prototype's model: a real sandbox, secret management or multi-user isolation.
- Changes to the DeepSeek Harness upstream, the policy model, the panel or the database format.
- macOS and other platforms beyond the incidental bash path.

## Recommendation

Port the deployment for this project. The workers must run the project's Windows-only toolchain, so the host is Windows; this plan is limited to making dsh-superagent run correctly there. Start with the 1-2 day proof of concept on the target machine, then follow WP0-WP7 and the staged order above. Keep the project's own Unity build, exe packaging and smoke-test work with the project, and keep Feishu optional. A Windows CI runner is worth adding after the port, but it is not part of the port itself.