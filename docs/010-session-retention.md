# 010 Session retention

The candidate does not automatically delete an ended Ticket's worktree or local or remote branch. This document records the retention problem and historical proposals, not an implemented purge policy. `docs/013-workspace-lifecycle.md` describes this checkout's read-only reconciliation and its limitations. Do not assume the candidate is deployed or that any proposed deletion or recovery mechanism exists.

## What accumulates

A Ticket can leave a worker Session, checkout and orchestration records. Other Sessions, the workspace registry and the projection cache also grow. At a 2026-11-05 observation this deployment held 21 Session logs (13.2 MB), eight checkout directories (188 MB), a 312 KB database and a 4 MB write-ahead log. These are historical measurements, not current capacity or proof that data is disposable.

| Artifact | Typical location | Retention concern |
| --- | --- | --- |
| Worker and orchestrator Sessions | DSH home under `sessions/` | Conversation and tool results can be needed for recovery and audit. |
| Other Sessions | DSH home under `sessions/` | Personal and subagent Sessions are not necessarily Ticket resources. |
| Ticket checkout | `<stateDir>/work/<name>` or configured directory | Can include local commits, untracked and ignored data, submodules and external process outputs. |
| Orchestration database | `<stateDir>/orchestrator.sqlite` | Ticket, Assignment, Trigger, decision, effect and receipt history have different dependencies. |
| Workspace registry and projection cache | DSH home under `storages/` | Must remain consistent with Session lifecycle. |

## Existing cleanup is not a safety guarantee

The previous implementation enqueues cleanup for ended Tickets, including again at startup; a deployed version may still do so. Subject to its checks, it can forcibly remove a linked worktree and delete the local branch and Ticket fetch ref; for merged own pull requests it also attempts remote branch deletion. Its normal Git status check omits ignored files, local remote-tracking refs may be stale, and its remote read and ordinary delete are not an atomic CAS. It does not establish that external processes or people have stopped using the directory. Thus a clean Git status or reachable commit is not proof that no work can be lost. Deployment state may differ from this checkout; verify it separately before drawing operational conclusions.

The previous launch path could run prepare if a Ticket's directory was missing, or treat an existing directory as prepared. Neither behavior proves safe restoration. The candidate refuses to recreate missing historical workspaces; before an existing Ticket resumes, an operator must still verify its original directory, repository, branch, local work and Session working directory. Do not assume that current prepare settings restore the previous work.

## Retention proposals are deferred

Earlier versions of this document proposed a 45-day Ticket/Session purge, a daily sweep, a 12-hour trash window, pinning, a size cap and receipt pruning. None is an implemented guarantee or an approved policy. Age, a merged pull request, a clean status or a trash rename alone cannot authorize deletion. The safety, ownership, backup, process, concurrency and crash-recovery requirements in `docs/013-workspace-lifecycle.md` must be resolved before any destructive retention is considered. Historical workspaces or other remnants require explicit human confirmation, not automatic adoption or cleanup.

A future Session purge would need a supported DSH deletion API coordinating the persistence write claim, Session generations, workspace membership and archive state, and projection cache. Archiving hides a Session rather than reclaiming its storage; deleting files behind DSH risks races and inconsistent state. A proposed fresh Session would not restore lost conversation, and a report or summary is not equivalent to that history. Receipt pruning also requires evidence about source redelivery and deduplication windows; no fixed expiry is established here.

## Open decisions

- Which data and external outcomes must remain available for audit, resume and handoff, and for how long?
- What consistent backup, restore test, pinning, access controls and explicit approvals are required for each resource type?
- Can DSH provide supported Session deletion and registry coordination? How are references and handoff manifests protected?
- How are disk pressure and historical unknown ownership surfaced without automatically sacrificing data?
