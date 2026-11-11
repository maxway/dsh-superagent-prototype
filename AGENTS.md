# Agent instructions

## Pull request language

Write pull request titles and descriptions in Simplified Chinese. Keep subsequent PR description updates and PR discussion replies in Simplified Chinese as well, unless the user explicitly requests another language. Preserve code identifiers, commands, paths, and quoted technical terms as appropriate; translate the surrounding explanations.

## Self-hosted development: protect the running service

This repository is developed by dsh-superagent itself. The goal is to deliver new features regularly without letting a failed development build, test, or candidate deployment stop or corrupt the superagent that is doing the work. Development, candidate validation, and production release are separate operations. A worktree is source isolation, not a process, credential, or data isolation boundary.

The intended stable checkout is `F:\code\dsh-superagent-prototype`, also visible in WSL Ubuntu as `/mnt/f/code/dsh-superagent-prototype`. It is the intended stable runtime checkout and the Git source for task worktrees, not a scratch checkout. One main clone plus one temporary worktree per concurrent task is the preferred steady state; do not create a permanent extra clone unless cross-platform Git, dependency isolation, or recovery needs justify it. Ticket worktrees are still required for the work they isolate.

Recheck live process, profile, bundle link, state, worktrees and changes; dated service-isolation and removed-ticket history is in [deployment](docs/006-deployment.md#production-host-for-this-checkout).

### Development and candidate tests

- Work in the assigned task worktree; verify its Git common directory and branch before editing. Never treat the stable checkout, production state directory, or another task's worktree as scratch space. Preserve existing uncommitted work.
- Do not run install, build, clean, checkout, reset, pull, or other mutations in the stable checkout as part of development or testing. A linked bundle can read files from that checkout; changing it while the service runs is not a safe deployment mechanism.
- Use one non-production server for development and candidate validation, separate from production in profile, DSH home, state and database, control files, logs, port, working directory, credentials and sources. Do not consume or mutate production tickets, accounts, notifications or external repositories; use mocks or a dedicated test repository.
- Only production may enable Feishu. The non-production server must have Feishu disabled and no production bot credentials or CLI configuration. Do not copy production profiles or databases into it; a disabled Source alone does not prevent setup from checking a saved bot configuration.
- Before resuming an existing ticket, verify its original worktree, branch, uncommitted work and session working directory. A missing directory is not evidence that it is safe to recreate from the current prepare command; stop and ask an operator to recover it. The previously deployed recovery did not enforce these checks; even where directory checks exist, they do not isolate a worker from the host, so do not claim restored workers are isolated automatically.
- The service script uses a profile-specific tmux socket, passes the caller's `DSH_HOME`, `HOME`, and `PATH` to its pane, and clears `TMUX`/`TMUX_PANE` before DSH starts. Preserve this isolation: `TMUX_TMPDIR` alone does not override an inherited `TMUX`. These guardrails are not an OS security boundary; workers must not target the service socket.
- Never stop, restart, kill, or reconfigure the production process, profile, WSL distribution, host, or shared dependencies to make a test pass. Do not use broad process-kill commands such as `pkill` or `killall`, unqualified `tmux kill-server`, or `wsl --shutdown`. Test cleanup may target only explicitly created test processes and isolated sockets. Confirm the target identity before any lifecycle operation; if isolation is uncertain, stop and ask the operator. Diagnose service failures from evidence; do not add automatic restart as a substitute for identifying and fixing their cause.
- The intended production host is native Windows with the F: checkout and a dedicated DSH home. For pinned configuration, compatibility wrapper, state, legacy controls, and 2026 cutover observations, see [deployment](docs/006-deployment.md#production-host-for-this-checkout). Keep Windows and WSL dependency trees separate and preserve historical WSL state and worktrees.
- Windows WMI process creation for the service wrapper requests a hidden window; preserve that behavior when changing the out-of-Job launch path, including its Windows tests.
- Watchdog updates use mechanical latest-code startup without a fixed 75-second survival wait or automatic old-version restart. Report heartbeat and startup failures honestly. The launcher records observer output and observed exit codes when its log is writable; log failure must not stop the observer or hide configuration errors, and the logs may be sensitive.
- The Windows Watchdog agent runs in its own workspace (the `workspace` field in its agent configuration, defaulting to `workspaces\watchdog_<service profile>` beside the configuration file, for example `watchdog_superagent` or `watchdog_sheepdoku`), never the stable checkout, so its DSH Sessions do not join the checkout's Desktop DSH workspace. The wrapper refuses a workspace inside the checkout and uses absolute checkout paths in its prompt. This is workspace separation, not an OS isolation boundary, and a shared DSH home still shares session and workspace storage.

### Controlled release and rollback

- When the user asks to deploy or restart normally, use the mechanical entry in [deployment](docs/006-deployment.md#deploying-the-latest-superagent): build the latest remote code, do not call a model for stop or release decisions, and do not require administrator elevation. An explicit deployment request authorizes its necessary stop; do not ask the user to repeat it.
- Only the dedicated Watchdog server-crash recovery may restart the installed version without pulling or building; do not confuse it with a normal latest-code deployment. Watchdog request consumption and crash recovery require explicit configuration and a deployed observer; a queued request does not prove deployment succeeded.
- Keep production lifecycle operations outside the server's own worker and preserve other people's work. The minimal in-place deployment does not make a backup or roll back; report failures and downtime honestly. A live SQLite file copy is not a consistent backup.

### Keep this current

When changing Windows deployment, service lifecycle, worktree preparation, runtime paths, isolation, or release procedures, update these instructions and the relevant deployment documentation in the same change. Clearly distinguish verified behavior, dated local observations, plans, and unresolved questions. Recheck the live deployment instead of trusting this snapshot.
