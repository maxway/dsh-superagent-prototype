# Windows stage 5 evidence

This directory records the Windows test runs that move stage 5 from "not expected to pass on Windows" to "passes with
documented POSIX-only skips" and complete the end-to-end flow on a scratch project. It is evidence for [the Windows
deployment plan](../../009-windows-deployment.md), not a deployment itself.

## What was verified

- **Host:** the operator's Windows machine, Windows 10 Pro 19045.
- **Toolchain:** Node.js 24.21.0, pnpm 11.7.0, TypeScript 6.0.3, Vitest 4.1.8, PowerShell 7 installed for the Windows
  shell path.
- **Revision:** branch `agent/plan-driver-continue-9efcb0b7d8a6`, a clean clone of this repository under
  `D:\code\dsh-superagent-stage5-win` with the branch applied. The merge request records the final commit.
- **Command:** `pnpm check` (typecheck, tests, build) in that clone. The WSL worker launched it through the full path
  `/mnt/c/Windows/System32/cmd.exe`; Windows interop is not on `PATH` and must not be assumed on another host.
- **Result:** 60 test files and 1232 tests: 1195 passed, 37 skipped (the POSIX-only cases below); typecheck and build
  pass.

The run exercised the Windows branches of service control, the worker command layer, the prepare command, the router
tool allow list, path validation and the test suite. It found the two stage 0 blockers now fixed in this branch:
native `C:\...` paths were rejected by `stateDir` and `executor.directory`, and the setup probe passed its environment
through a POSIX `env` executable.

The clone is the code under test, not a deployment Source. A Windows deployment must watch a scratch project such as
`ngd/dsh-superagent-test`, never this repository.

## Real Windows service smoke (2026-11-06)

A second, isolated profile (`stage5-e2e`, panel port 3092, state directory `D:\dsh-stage5-e2e\state`, bundle
`D:\code\dsh-superagent-e2e-win` built from `main` at `f38c5dd`) was driven through `scripts\dsh-superagent` on the
same host, not through the desktop UI:

- `start` spawned the service through the installed `dsh`, detected its process, printed the log path and exited 0 with
  the management API's `runtime` and `gitlab` parts ready.
- `status` reported the detected PID and the ready parts and exited 0.
- `stop` exited 0 through `POST /orchestrator/api/service/stop`; the process and port went away, the `manually-stopped`
  marker was written, and `status` then reported no PID with `manually_stopped: true`.
- `restart` stopped and started again, exiting 0 with a new PID.
- The configured prepare command created a worktree of `ngd/dsh-superagent-test` through the worker's git configuration
  and the dedicated agent account; the test worktree and ref were removed afterwards.

The smoke found two service-script defects, now fixed with unit tests:

1. With `--profile` on its own command line, the control script counted itself as a running service and refused to
   start. The scan now ignores this control process and other control invocations of the same profile.
2. The desktop-installed DSH runs as `DeepSeek Harness.exe`, which the Windows process scan rejected because it only
   accepted `node` and `dsh`. The scan now recognizes that host name; Windows `start`, `status` and `stop` all depend
   on it.

On this revision the full Windows suite (`pnpm vitest run`) passes: 60 files, 1195 passed, 39 skipped. The two
additional skips are the new control-script cases, which drive the POSIX `ps`/`tmux` fixtures like the rest of that
suite.

## End-to-end run (2026-11-06)

A third isolated profile, `stage5-e2e` (panel port 3092, state `D:\dsh-stage5-e2e\state`, bundle
`D:\code\dsh-superagent-e2e-win`), watched the dedicated scratch GitLab project `ngd/dsh-superagent-test` (project
4593) as `project_4593_bot`, with its own glab configuration directory and worker git configuration. The bundle was
`main` at `f38c5dd` plus the then-unmerged stage 5 service fix from merge request !15 (merged as `97a13ef`); its
runtime code matches `main` at `0335575`.

- A person with the allowed scratch-project account opened Issue #1, asking for one line at the end of `README.md`.
  The GitLab Source stored the mention as a Trigger.
- The first assessment ended `unavailable` on a timeout because the profile had no model provider: the master Session
  failed with `MISSING_CREDENTIAL`, not a policy decision. Adding the same `llm-pi-ai` gateway provider as the Linux
  deployment, with the key from the Windows user environment, and restarting with a fresh master Session fixed it. A
  deployment profile does not inherit the desktop profile's account credentials.
- The next pass accepted the request as a Ticket ("在 README.md 末尾添加一行..."), and the prepare command fetched the
  scratch repository and created the worktree `D:\dsh-stage5-e2e\work\readme-stage5-line-7e0e909a5bf5` with
  `git worktree add`.
- The worker ran under the `pwsh` tool. It appended `Windows stage 5 end-to-end check`, committed `a2412af`, pushed
  `agent/readme-stage5-line-7e0e909a5bf5`, opened [merge request !1](https://gitlab.diandian.info/ngd/dsh-superagent-test/-/merge_requests/1)
  and replied in Issue #1 with the link. The merge request is one added line, has no conflicts, and waits for a person
  to merge it.
- The panel reported the Ticket in the person stage with a `ready` report. The issue reply, the merge request and the
  ticket report are the acceptance evidence.

Two environment notes from this run belong in a repeatable setup: start the service with the Windows user environment,
including the model key and a `PATH` that contains the native CLI (`C:\Users\dd\bin` on this host). A service started
through WSL interop inherits a reduced `PATH`, so the worker had to resolve `glab.exe` by its full path; that is a setup
artifact, not a bundle defect. The candidate service was stopped after the run; its profile state remains under
`D:\dsh-stage5-e2e\state`.

## Documented POSIX-only skips

The suite skips these cases on Windows because their fixtures or behavior are POSIX-specific. Each skip names its
reason in the test source; the behavior they cover is exercised elsewhere.

- **`tests/service-script.spec.ts` POSIX lifecycle.** The cases drive tmux, `ps` and `SIGINT` with POSIX shell stand-ins.
  The platform-specific process, start and argument forms still run on Windows, and the real Windows
  start/status/stop/restart smoke above covers the lifecycle there.
- **`tests/environment.spec.ts` worker shims.** The POSIX shim wrappers select an account with a shell script. Windows
  selects accounts with `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR` and `LARKSUITE_CLI_CONFIG_DIR` and writes only `.cmd`
  guardrails; the "Windows command layer" cases cover that behavior.
- **`tests/sources.spec.ts` Feishu event consumer.** It now runs on Windows too: the fake CLI is a Node program reached
  through an npm-style `.cmd` shim, so the same launcher the real `lark-cli.cmd` uses is exercised.
- **`tests/deployment.spec.ts` POSIX setup fixtures.** Four setup cases run POSIX shell stand-ins for the CLIs. Windows
  resolution is covered by the PATHEXT case and the account-directory probe case; the real Windows CLIs are for the
  end-to-end run.
- **`tests/store.spec.ts` file modes.** Windows has no POSIX owner bits; the directory itself is still verified.
- **`tests/prompts.spec.ts` no skip.** The test now keeps its temporary prompt directory inside the package, which is
  required because a Windows temp directory can be on another drive.

## Windows CI (2026-11-07)

A project-specific runner `windows-workstation-dd` (runner id 152, tag `windows`, shell executor with `pwsh`) was
registered to `ngd/dsh-superagent-prototype` on the operator's Windows workstation. It runs as a user-level process
from `D:\dsh-ci` and is started at Windows logon by a Startup entry; it is not a Windows service and has no dedicated
CI account.

`.gitlab-ci.yml` adds a `windows-check` job for merge requests and the default branch. It runs `node --version`,
`pnpm --version`, `pnpm install --frozen-lockfile` and `pnpm check`. The first pipeline (149774, job 233402) reported
success incorrectly because the CMD shell stopped after `pnpm --version`; switching the runner to `pwsh` and retrying
(job 233403) exposed a real line-ending defect: a default Windows checkout uses `core.autocrlf=true`, and the
documentation structure tests failed on CRLF. `tests/docs.spec.ts` now normalizes CRLF before parsing, and the next
pipeline (149777, job 233414) passed in 87 seconds.

The runner is a workstation runner: it stops when the machine is off or nobody is logged in, and jobs run with the
operator's credentials. A dedicated CI host with a dedicated Windows account is the follow-up before the runner is
used as a release gate.

## Feishu on Windows (WP6, 2026-11-07)

The Feishu Source is implemented for Windows. The host resolves an npm `.cmd` shim to the Node entry named by its
`%dp0%` path and runs that entry with Node, so message text and JSON never pass through `cmd.exe`; a `.js` entry runs the
same way, and a `.cmd` without a Node entry is refused. The long-running event consumer closes stdin and allows five
seconds before terminating, because Windows has no `SIGTERM`. The Feishu consumer suite now runs on Windows against a
Node fake reached through an npm-style `.cmd` shim, covering the launcher, the event stream and the stop path.

A live bot was not enabled on the scratch host: only production may enable Feishu, and the scratch host must not receive
Feishu credentials. Connecting a live bot is an operator step on the host that takes over production; the launcher and
event-consumer paths are verified without credentials.

## Remaining stage 5 work

- Merge request !1 in the scratch project waits for a person to merge it; merging is not part of this acceptance.
- Moving the runner to a dedicated CI host, which the plan records as a remaining question.

The end-to-end run passed, a Windows runner now runs `pnpm check` in CI, and WP6 is implemented and covered by the
Windows suite.

No user-interface change comes with this evidence, so it has no before-and-after screenshots.