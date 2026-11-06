# Windows stage 5 evidence

This directory records the Windows test run that moves stage 5 from "not expected to pass on Windows" to "passes with
documented POSIX-only skips". It is evidence for [the Windows deployment plan](../../009-windows-deployment.md), not a
deployment itself.

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

## Documented POSIX-only skips

The suite skips these cases on Windows because their fixtures or behavior are POSIX-specific. Each skip names its
reason in the test source; the behavior they cover is exercised elsewhere.

- **`tests/service-script.spec.ts` POSIX lifecycle.** The cases drive tmux, `ps` and `SIGINT` with POSIX shell stand-ins.
  The platform-specific process, start and argument forms still run on Windows, and the real Windows
  start/status/stop/restart smoke above covers the lifecycle there.
- **`tests/environment.spec.ts` worker shims.** The POSIX shim wrappers select an account with a shell script. Windows
  selects accounts with `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR` and `LARKSUITE_CLI_CONFIG_DIR` and writes only `.cmd`
  guardrails; the "Windows command layer" cases cover that behavior.
- **`tests/sources.spec.ts` Feishu event consumer.** The Feishu Source is not supported on Windows yet (WP6): npm
  `lark-cli` is a `.cmd` launcher. The GitLab and GitHub Sources are unaffected.
- **`tests/deployment.spec.ts` POSIX setup fixtures.** Four setup cases run POSIX shell stand-ins for the CLIs. Windows
  resolution is covered by the PATHEXT case and the account-directory probe case; the real Windows CLIs are for the
  end-to-end run.
- **`tests/store.spec.ts` file modes.** Windows has no POSIX owner bits; the directory itself is still verified.
- **`tests/prompts.spec.ts` no skip.** The test now keeps its temporary prompt directory inside the package, which is
  required because a Windows temp directory can be on another drive.

## Remaining stage 5 work

- A Windows CI runner that runs `pnpm check` on every change.
- An end-to-end run on the dedicated scratch GitLab project `ngd/dsh-superagent-test`, not this repository: setup, a
  Ticket, prepare, a worker turn, commit, push, merge request, panel state and the source reply.
- Feishu on Windows (WP6), still optional and not supported today.

No user-interface change comes with this evidence, so it has no before-and-after screenshots.