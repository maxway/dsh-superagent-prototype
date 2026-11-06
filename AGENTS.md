# Agent instructions

## Pull request language

Write pull request titles and descriptions in Simplified Chinese. Keep subsequent PR description updates and PR discussion replies in Simplified Chinese as well, unless the user explicitly requests another language. Preserve code identifiers, commands, paths, and quoted technical terms as appropriate; translate the surrounding explanations.

## Self-hosted development: protect the running service

This repository is developed by dsh-superagent itself. The goal is to deliver new features regularly without letting a failed development build, test, or candidate deployment stop or corrupt the superagent that is doing the work. Development, candidate validation, and production release are separate operations. A worktree is source isolation, not a process, credential, or data isolation boundary.

The intended stable checkout is `F:\code\dsh-superagent-prototype`, also visible in WSL Ubuntu as `/mnt/f/code/dsh-superagent-prototype`. It is the intended stable runtime checkout and the Git source for task worktrees, not a scratch checkout. One main clone plus one temporary worktree per concurrent task is the preferred steady state; do not create a permanent extra clone unless cross-platform Git, dependency isolation, or recovery needs justify it. Ticket worktrees are still required for the work they isolate.

Observed on 2026-11-06: the WSL clone `/home/max/src/dsh-superagent-prototype` is a separate Git repository. Its worktree `/home/max/.dsh/state/superagent/work/windows-deploy-stage2-a14b20f9bf4f` had uncommitted changes and was the working directory of a `dsh --profile panel` process. The actual loaded bundle and service health were not established. The intended F: deployment and migration away from that WSL clone were not verified or completed. Treat these as dated observations, not current facts: inspect the live process, profile, bundle link, state, worktrees, and changes before acting. Do not delete, reset, move, or migrate the old clone or worktree until their ownership, changes, active tasks, and process dependencies are resolved and the operator approves the cutover.

### Development and candidate tests

- Work in the assigned task worktree; verify its Git common directory and branch before editing. Never treat the stable checkout, production state directory, or another task's worktree as scratch space. Preserve existing uncommitted work.
- Do not run install, build, clean, checkout, reset, pull, or other mutations in the stable checkout as part of development or testing. A linked bundle can read files from that checkout; changing it while the service runs is not a safe deployment mechanism.
- Run candidate services and lifecycle tests only with a separate profile, DSH home, state and database, control files, logs, port, working directory, and test credentials and sources. Do not consume or mutate production tickets, accounts, notifications, or external repositories. Use mocks or a dedicated test repository and test bot. A different state directory alone does not prevent duplicate external side effects.
- Never stop, restart, kill, or reconfigure the production process, profile, WSL distribution, host, or shared dependencies to make a test pass. Do not use broad process-kill commands or `wsl --shutdown`. Confirm the target identity before any lifecycle operation; if isolation is uncertain, stop and ask the operator.
- Windows and WSL may view the same F: files, but Git worktree links and native dependencies are not assumed portable. Verify Git paths from each OS before use; keep platform-specific dependencies and build artifacts in separate directories. If safe isolation cannot be achieved with one clone, use a separate disposable clone for the candidate instead of risking the stable instance.

### Controlled release and rollback

- A completed task or merged change is not a production deployment. Produce a reviewable commit and validate the candidate independently first; release on a deliberate cadence with an operator-approved maintenance window. The running service must not autonomously replace or restart itself in its own worker session. Use an independent operator or deployment supervisor that survives the service restart.
- Before cutover, inventory the actual process and loaded bundle, exact versions and paths, profile, state, credentials, control files, and active work; verify the target and rollback procedure. Quiesce work and take a consistent backup of the database and other necessary state, configuration, and unpushed work. Do not assume copying a live SQLite file alone is consistent. Verify the backup and retain the last known-good version and compatible dependencies.
- Only after approval, deploy the validated version in the maintenance window and verify process identity, readiness, source connectivity, and a safe end-to-end check. If verification fails, stop only the candidate/failed target and restore the known-good version with a compatible pre-migration database and configuration. Reconcile external side effects and data created since backup before restoring; never overwrite newer production state blindly.
- Process isolation reduces deployment risk but does not protect against shared host, disk, WSL, or power failure. Use independent monitoring and backups as appropriate; do not promise zero downtime.

### Keep this current

When changing Windows deployment, service lifecycle, worktree preparation, runtime paths, isolation, or release procedures, update these instructions and the relevant deployment documentation in the same change. Clearly distinguish verified behavior, dated local observations, plans, and unresolved questions. Recheck the live deployment instead of trusting this snapshot.
