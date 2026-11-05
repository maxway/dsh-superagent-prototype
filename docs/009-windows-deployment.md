# 009 Windows deployment

This document answers two questions: whether dsh-superagent should run on a native Windows host, and what that would take. For this project the answer is yes: the workers must run Unity batchmode, build the Windows exe and run smoke tests in their ticket workspaces, and the Windows-only DSH skills run there too. The plan below is the path, not yet a supported deployment; the analysis also records when the answer would be no, so the decision stays readable if the project changes.

The question is about the host, not about who can use the agent. Every user opens the panel in a browser and mentions the agent in the Source conversation, so a Windows desktop never needs a local copy of the service.

## Summary

- **Required for this project.** The workers must run Unity batchmode, build the Windows exe and run smoke tests inside their ticket workspaces, and their DSH skills call Windows-only tools. That host must be Windows; WSL2 cannot run the Windows Editor against a Linux worktree, and a CI-only loop cannot give the worker the local build and smoke-test cycle it needs.
- **Estimate:** the Unity build and the exe smoke test add WP8 and WP9. A usable internal build takes about 13-21 person-days, or 3-4 weeks for one developer, without Feishu and without a Windows CI runner; full parity, with Feishu and Windows CI, takes about 16-26 person-days, or 3-5 weeks; add 20-30% for the chosen scope, which puts full parity at 19-34 person-days, or 4-6.5 weeks.
- **A Windows CI runner still helps:** it can run the heavy full builds and test suites on each merge request, but it does not replace the local batchmode and exe smoke loop in the ticket directory.
- **Recommendation:** port; start with a 2-3 day proof of concept that includes one real batchmode build and one exe smoke test on the target Windows machine, then follow WP0-WP9 in order. Confirm the Unity version, the Windows build target, the license and the smoke-test definition before committing the full schedule.

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

The bundle already switches its two agent presets between bash and pwsh by platform (`cordis.patch.yml`), so a Windows worker receives the PowerShell tool. The runtime and deployment layers did not follow.

| Area | Current implementation | Native Windows status |
| --- | --- | --- |
| Service control | `scripts/dsh-superagent` uses Python 3, tmux, `ps`, `fcntl.flock`, `os.kill(SIGINT)` and `umask` | Does not run; no portable graceful stop |
| Worker command shims | Extensionless `#!/bin/sh` files in `worker-bin`, prepended to `PATH` | PowerShell and `CreateProcess` do not execute them; account selection and blocked commands are lost |
| CLI wrappers and probes | Shell-script wrappers; setup probes run `env PATH=... <cli>`; `execFile` and `spawn` call the CLI directly | No `env` on Windows; `execFile` cannot run `.cmd`; npm-installed `lark-cli` is a `.cmd` |
| Prepare command | Always `sh -c <command>` | No `sh` by default; the documented command uses POSIX variables |
| Router tools | The master Session's allow list and wait guard hard-code `bash` | The `pwsh` tool is removed from the router; its wait guard never applies |
| Prompts and skills | "Workers use bash" and bash examples | The worker has PowerShell, so the instructions and examples are wrong for it |
| Setup and docs | `~/.local/bin`, `cat > ... <<'EOF'`, tmux, Python, `$HOME` | Need Windows equivalents |
| Tests and CI | POSIX fixtures, shells, `:` as the PATH separator; no Windows job | `pnpm check` is not expected to pass on Windows |

[006 Deployment](006-deployment.md) documents only the POSIX path, so even a hand-started Windows service would fail setup before it could poll.

## Is it necessary?

### Scenarios

| Scenario | Value of native Windows | Recommendation |
| --- | --- | --- |
| The repository is OS-agnostic; a Linux host, WSL2 or a container is available | Low: the service works today | Keep the Linux host; do not port |
| Workers must build or test Windows-only code, such as a desktop or driver project | High: the worker needs the Windows toolchain and checkout | Port, or add a Windows worker later; start with the proof of concept |
| WSL2 and every Linux host are forbidden, and the agent must run on a given Windows machine | Required: there is no other host | Port, with the plan below |
| Windows developers only need to open the panel or mention the bot | None: the panel is a browser application and Feishu is remote | Keep the host on Linux |
| A prototype demo on a Windows laptop | Low: WSL2 or a small Linux VM is enough | Do not port for the demo |
| The repository is a Unity project whose agent must run batchmode, build the exe and smoke-test it locally | Required: this project's case; the host needs Windows, Unity, the build toolchain and a license | Port, with WP8 and WP9; this is the selected path |
| The repository is a Unity project and the Unity work can run only in CI while the agent stays on Linux | Lower cost, but it does not provide the local build and smoke loop this project needs | Keep as a complementary CI runner, not a replacement |

### Unity projects

A Unity project makes the host question concrete. Unity ships an Editor for Windows, macOS and Linux, but this project needs the Windows Editor and the Windows build target: the workers run Unity batchmode to compile, build the Windows player and execute a smoke test. The rest of this section records the boundary and the options that were considered.

- **Local batchmode is the workflow.** The worker needs the Editor, the project's Windows build support, a license and the build scripts in its ticket directory; the exe it produces is the smoke test's subject. A CI runner cannot replace that loop, although it can also build and test every merge request.
- **WSL2 is not a substitute.** The Windows Editor must open a Windows path, so a WSL2 checkout under `/mnt/c` would be slow, would hit file-lock and line-ending problems, and would still need Unity and the license on the Windows side. The host is Windows.
- **A Windows CI runner is still worth having.** It can run the heavy full builds and test suites on each merge request while the agent does the local iteration; both use the same Unity version, license and build scripts.
- **Unity is heavy.** Each fresh worktree imports its own `Library`; builds need the license, the Windows build support and often the Visual Studio/IL2CPP toolchain, disk space and `git-lfs`, and care with `.meta` files and YAML scenes and prefabs. A warm `Library` or Unity Accelerator reduces the import cost; the smoke test needs a defined pass criterion, a display or `-nographics` plan, and captured player logs.

Confirm the Unity version, the Windows build target (for example Win64 with IL2CPP or Mono), the installed modules and license, the smoke-test definition and the expected build time before committing the schedule.

### Cost of support

A port is not a one-time cost. After it, every change must be checked on two platforms; the worker shell differs (`bash` and `pwsh`), so prompts, skills and tests need platform-aware text; a Windows runner has to exist to keep it honest; and the isolation story is weaker, because the blocked-command shims are a guardrail while the real boundary stays a dedicated operating-system account. For a research prototype with one repository and a shared service, that cost buys little unless one of the scenarios above is real.

### Verdict

**Necessary for this deployment.** The workers must run Unity batchmode, build the Windows exe and smoke-test it in their own ticket directories, and their skills execute Windows-only commands; the agent host therefore has to be Windows. This is the trigger the earlier analysis named, and the plan below applies. Start with the proof of concept, which includes one real build and smoke test, because Unity's license, import and build time are the parts that can move the schedule.

## Adaptation plan

### Principles

- Keep one behavior on both platforms and keep the POSIX path working; a Windows deployment must not change what an existing Linux installation does.
- Use the platform's native mechanisms instead of emulating POSIX: `pwsh` for the worker shell and prepare commands, `cmd.exe` only where a `.cmd` file must be launched, and DSH's `ctx.appExit` for a controlled shutdown.
- Keep platform differences in small helpers with a platform argument, as DSH does, so the branches are unit-testable on Linux.
- Treat the port as a prototype-quality change: no new runtime dependency, no settings migration unless a field is unavoidable, and no change to the database format.

### Work packages

| WP | Scope | Person-days | Depends on |
| --- | --- | --- | --- |
| WP0 | Proof of concept on a real Windows machine, including a Unity build and exe smoke test | 2-3 | — |
| WP1 | Service lifecycle: start, status, stop, restart, logs, lock | 2-3 | WP0 |
| WP2 | CLI and worker environment: probes, shims, wrappers, blocked commands | 2-3 | WP0 |
| WP3 | Prepare command, router tools, prompts and skills | 1-1.5 | WP2 |
| WP4 | Setup and deployment documentation, both languages | 1.5-2 | WP1-3 |
| WP5 | Windows tests and CI | 2-3 | WP1-4 |
| WP6 | Feishu on Windows, optional | 1-2 | WP2 |
| WP7 | End-to-end verification and hardening | 1.5-2 | WP1-5 |
| WP8 | Unity build integration on Windows | 2-4 | WP2, WP7 |
| WP9 | Windows exe smoke-test harness | 1-2 | WP8 |

### Staged execution

The work packages are the technical breakdown; the stages are the execution and acceptance order. Each stage ends with a reviewable change and a check, and the next stage starts only when the previous acceptance holds. Stages 0, 4 and 6 need a Windows machine with Unity; stages 1, 2, 3 and 5 can be built and tested on Linux with a platform argument.

| Stage | Scope | Acceptance | Windows host |
| --- | --- | --- | --- |
| 0 | Proof of concept on the target machine | DSH, the panel and the pwsh tool load; setup's blockers are measured; one Unity batchmode build and one exe smoke test are timed; go or no-go is recorded | Required |
| 1 | Service lifecycle: Node service script, `service/stop`, logs, lock and tests | `pnpm check` passes; `start`, `status`, `stop` and `restart` behave as before on Linux; the stop route is unit-tested; no POSIX change | No; Windows smoke follows |
| 2 | Worker command layer: platform command runner and probes, Win32 shims, `PATHEXT`, blocked commands, account selection | Unit tests cover the generated files and argument handling; POSIX behavior is unchanged; the generated `.cmd` files are reviewed | No |
| 3 | Prepare, router tools, prompts and skills: `pwsh` prepare, the router allow list, the wait guard, shell-neutral wording | Tests pass; Linux keeps the `sh` path; the Windows commands are documented | No |
| 4 | Unity build and exe smoke scripts: batchmode build, output path, smoke harness, cache and cleanup | On the stage 0 machine, a real build produces the exe and the smoke script passes and fails correctly | Required |
| 5 | Setup and deployment documentation: Windows prerequisites, service, credentials, prepare and troubleshooting, both languages | `pnpm check` and the documentation tests pass; a person reviews the Windows path | No |
| 6 | Windows CI and end-to-end verification, Feishu optional | A Windows runner runs `pnpm check`; a real ticket completes setup, build, smoke test, commit, push and merge request; Linux still passes | Required |

### WP0: proof of concept

On a clean Windows 11 or Windows Server machine, install Node 22.19+ or 24, pnpm, git, PowerShell 7, the Unity Editor version with the Windows build support and the Visual Studio/IL2CPP toolchain if the target uses it, and the DSH version pinned in [006 Deployment](006-deployment.md). Create the `superagent` profile, add the bundle with `link:`, open the panel and confirm that the Web profile, the `pwsh` tool and the isolation settings load. Then measure the four uncertain areas: setup's `env` probe, an `execFile`/`spawn` call with a `.cmd` wrapper, the prepare command under `sh -c`, and a real Unity batchmode build plus an exe smoke test from a worktree. Exit when each has a measured answer and a rough duration; stop if DSH or Unity cannot run, because either would change the whole estimate.

### WP1: service lifecycle

Replace the Python service script with one cross-platform Node script (recommended) or add a PowerShell twin (fallback). The recommended version keeps the current command line, exit codes, log names, `manually-stopped` marker and status output, and adds:

- Start: spawn `dsh --profile <profile> --no-open` detached with its output redirected to the existing log path; record the PID; wait for `GET state` to answer and print setup problems exactly as today.
- Status: read the PID file and the management API; detect duplicates; keep the four exit codes.
- Stop and restart: call a new loopback management route, `POST service/stop`, which asks the plugin to exit through `ctx.appExit(0)` after the response is sent; the current DSH shutdown path then disposes the profile. This is the portable graceful stop: Windows cannot deliver `SIGINT` across processes, and `os.kill(pid, SIGINT)` would terminate the process instead. On POSIX the script may keep `SIGINT` as a fallback.
- Lock and logs: an exclusive control lock, for example `proper-lockfile`, already a dependency, and log pruning as today.

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

### WP8: Unity build integration

Required for this project. On the Windows host:

- Install the exact Unity Editor version and modules the project uses, including the Windows build support and, if the target uses it, the Visual Studio/IL2CPP toolchain and the Windows SDK; activate the license for batch mode. The license is an operator step and can be the longest lead time.
- Add the project's batch-mode commands to the repository's `AGENTS.md` so every worker runs the same build and tests: `Unity.exe -batchmode -nographics -quit -projectPath <worktree> -buildTarget Win64 -logFile <log> -executeMethod <BuildMethod>`, and the Unity Test Framework form with `-runTests`, `-testPlatform` and `-testResults`.
- Build the player to a known output path outside the repository so it is never committed, and keep the build log with the ticket; the exe is the smoke test's input.
- Treat a build as long-running: run it in the background, wait through `job_output`, and tell workers in the prompt that the foreground shell moves commands to a job after five seconds.
- Plan the cache: a fresh worktree imports its own `Library`. Use a warmed template, Unity Accelerator, or a dedicated build cache; do not share one live `Library` between concurrent tickets.
- Cover the Windows operational details: `git-lfs`, long paths, antivirus exclusions for the worktrees, Unity and the fresh exe, the 260-character path limit, file locks, and Unity YAML merges (`.meta`, scenes, prefabs).
- Verify with the project's real build target and one EditMode or PlayMode test run; record the exact commands in the repository so the agent does not rediscover them.

### WP9: Windows exe smoke test

The smoke test is a project-specific definition, not a generic check. Build it with the project team:

- Agree on the pass criterion: the exe starts and exits with a chosen code, reaches a known scene or log line, or passes a scripted input sequence; capture the player log and any screenshot or artifact.
- Give the exe a command-line mode or test harness it can run unattended; prefer one that also works with `-nographics` or a virtual display. If the game needs a GPU or a visible window, run it on a machine that has one and record that in the prerequisites.
- Wrap launch, timeout, log capture and cleanup in one script the worker can run from the ticket directory; return a nonzero exit code and the relevant log tail on failure.
- Keep the exe and logs out of the repository; clean up old builds and stop antivirus from quarantining the fresh exe.
- Verify the script with a deliberately failing build or smoke test, so a red result is distinguishable from a harness error.

### Alternatives

- Keep the Python service script and add a PowerShell twin: lower risk for the existing POSIX path, two implementations to keep in sync.
- Use `.cmd` wrappers plus `cmd.exe`: the smallest settings change, but argument quoting is unsafe for JSON and message text.
- Run the worker in Git Bash on Windows: removes some shell differences but still needs the service script, adds an MSYS2 dependency the bundle does not otherwise use, and leaves the worker on the wrong shell unless the Windows presets are changed.
- Do nothing: keep the Linux or WSL2 host; this is not viable for this project because the workers need local Unity batchmode and the exe smoke test.

## Estimate

### Assumptions

- One developer who knows this repository, with a Windows machine that can install Node, git and the CLIs, and a test repository.
- No upstream DSH change; the pinned DSH version already supports Windows.
- Feishu is optional; a GitLab or GitHub source is the minimum.
- The estimate covers the port and its tests, not a redesign of the policy, the panel or the store.
- This project needs the Windows Editor with the Windows build support, the Visual Studio/IL2CPP toolchain if the target uses IL2CPP, a batch-mode license, a warm `Library` or Unity Accelerator, and a GPU or display if the smoke test needs one.
- The smoke-test definition and the Windows build target are known; if they are not, the proof of concept must define them and WP9 grows.
- A Windows CI runner is useful for the heavy builds, but it is not required for this estimate and does not replace the local loop.

| Phase | Contents | Person-days | Calendar for one developer |
| --- | --- | --- | --- |
| Proof of concept | WP0; one batchmode build and exe smoke test | 2-3 | 2-3 days |
| Usable internal build without Unity | WP0-WP4 and WP7 | 9-13 | 2-2.5 weeks |
| Usable internal build with Unity and exe smoke test | WP0-WP4 and WP7-WP9; no Feishu, no Windows CI | 13-21 | 3-4 weeks |
| Full parity without Unity | WP0-WP7 | 12-18 | 3-4 weeks |
| Full parity with Unity and exe smoke test | WP0-WP9 | 16-26 | 3-5 weeks |

### Calendar

The proof of concept takes 2-3 days. The usable internal build with Unity and the exe smoke test is about 3-4 weeks of focused work; full parity is about 3-5 weeks. Add 20-30% for the chosen scope; full parity then reaches 19-34 person-days, or 4-6.5 weeks. Part-time work stretches the calendar roughly proportionally. If the proof of concept finds a DSH-level blocker, or Unity cannot be licensed and built in batch mode, stop and re-estimate.

## Verification

### Acceptance criteria

- On a clean Windows machine, `pnpm check` passes, with documented Windows skips, and the service starts, reports status, stops gracefully and restarts.
- A real ticket from the Git Source completes end to end: setup, Ticket, prepare, worker turn, commit, push, merge request, panel state and the source-conversation reply.
- The same flow still passes on Linux with the same commit; no behavior changes for existing installations.
- With local Unity builds, a real Unity batchmode build and the exe smoke test pass from the ticket directory: the build produces the exe, the smoke script exits nonzero on failure, and the worker starts both in the background and reads the result.
- Documentation states the supported surface, the prerequisites and the isolation caveat.

### Test matrix

| Area | Linux | Windows | Method |
| --- | --- | --- | --- |
| Unit and integration tests | Required | Required | `pnpm check`, with platform-argument tests for Windows generation |
| Service lifecycle | Required | Required | Fake DSH and HTTP in tests; real DSH in WP7 |
| CLI invocation and blocked commands | Required | Required | Unit tests for argv, PATHEXT and `.cmd`; real CLIs in WP7 |
| Prepare command | Required | Required | Real worktree creation in WP7 |
| Unity build and exe smoke test | Via CI | On the Windows host | Real build and smoke test in WP7; the CI route uses the project's pipeline |
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
| Unity licensing, Library import or GPU requirements | Builds blocked, slow or flaky | Confirm the license and runner first; warm Library or Accelerator; `-nographics`; install git-lfs; exclude worktrees from antivirus |
| The exe smoke test needs a GPU or display, or is flaky | Red verification, false failures | Define the pass criterion; prefer `-nographics` or a test mode; run on a GPU machine when needed; capture logs and screenshots; distinguish harness errors |

### Open decisions

- The smoke-test definition and pass criterion; WP9 depends on them.
- The Windows build target and scripting backend, for example Win64 with IL2CPP or Mono, and the modules and toolchain that implies.
- Node service script versus PowerShell twin.
- Whether Feishu is in the first release or a follow-up.
- Whether the account configuration moves to `configDir` settings or stays in wrapper scripts for POSIX and environment variables on Windows.
- Whether a Windows CI runner also builds the exe and runs the smoke test; without one, the local host must do both.

## Out of scope

- A Windows desktop application, per-developer agents, or a service for multiple repositories.
- Hardening beyond the current prototype's model: a real sandbox, secret management or multi-user isolation.
- Changes to the DeepSeek Harness upstream, the policy model, the panel or the database format.
- macOS and other platforms beyond the incidental bash path.

## Recommendation

Port for this project. The workers must run Unity batchmode, build the Windows exe and smoke-test it locally, so the agent host is Windows. Start with the 2-3 day proof of concept on the target machine; if the build and smoke test work and the license is in place, follow WP0-WP9. Keep a Windows CI runner for the heavy full builds and test suites if one is available, but treat it as complementary to the local loop, not a replacement. Feishu remains optional and can be a follow-up.