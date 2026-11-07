# 010 Session retention

dsh-superagent keeps almost every artifact it produces. A Ticket leaves a DSH Session, a repository checkout and rows in the orchestration database; the Executor now removes a finished Ticket's checkout when it can prove that no local work would be lost, while nothing deletes its Session or rows. [007 Architecture](007-architecture.md) records the database side — "Nothing deletes old records yet, so these grow without bound" — and DSH's session backend records the file side: session logs accumulate under their root until removed externally, and the persistence seam has no deletion API. This document measures that growth, compares the mechanisms operators use elsewhere, and proposes a deliberately small retention mechanism: one rule, one sweep and the smallest set of safety checks that make deletion trustworthy.

## Summary

- **What grows.** One `worker-<ticket>` Session per Ticket plus the deployment's orchestrator Session; one checkout per Ticket; the rows for every Trigger, disposition, Decision, Thread, Ticket, receipt and stored value; the DSH workspace registry; and the projection cache. At the time of writing this deployment held 21 session logs (13.2 MB), 8 checkout directories (188 MB) and a 312 KB database with a 4 MB write-ahead log. The checkouts dominate; the Sessions are small. The Executor now removes a finished Ticket's checkout when it is clean and every commit is remote, so only checkouts with local work remain.
- **The rule.** The checkout part is implemented: a finished Ticket's linked worktree and local `agent/<name>` branch are removed when `git status --porcelain` is empty and every commit is on a remote branch or the Ticket's fetched ref. The remote branch is deleted too when the Ticket's own pull requests all merged and its tip is still the local HEAD. The rest of this document proposes a later 45-day purge for the artifacts that remain: the Ticket row, its reports and its Thread subscription stay, so the Ticket still resumes.
- **The sweep.** The implemented cleanup is one durable effect per finished Ticket, checked again when the host starts; a proposed daily sweep would cover a broader purge. One indexed query a day, one safety check per candidate, one atomic rename into a trash directory, and a background removal after a 12-hour grace period. There is no new table and no full scan.
- **What this does not do.** No warm archive tier, no summary of the lost context, no per-file LRU, no Trigger or settings pruning, no orchestrator rotation. Each added a moving part without matching value at today's sizes; they are listed as deferred.
- **Reliability.** Dry-run first; pin an exception; every deletion re-checks that nothing runs and that no work is unpushed; the trash grace period keeps an undo window. The only upstream dependency is the Session deletion API.

## What accumulates today

Every artifact below survives a restart. Only the checkout has a retention path so far; the others have none.

| Artifact | Location | Growth | Removed today |
| --- | --- | --- | --- |
| Worker Session | `~/.dsh/sessions/<normalized-cwd>/worker-<ticket>/` | One per Ticket; grows with every turn and tool result | Nothing |
| Orchestrator Session | `~/.dsh/sessions/<normalized-cwd>/orchestrator-<deployment>/` | One forever | Nothing |
| Other Sessions | `~/.dsh/sessions/<normalized-cwd>/session-<uuid>/` | One per Session a person opens in the Web UI, or a subagent creates | Nothing |
| Checkout directory | `<stateDir>/work/<name>`, or `executor.directory` | One per Ticket; a repository plus dependencies and build output | When a Ticket ends: a linked worktree with no local-only work is removed and its local branch deleted; its remote branch too when the Ticket's own pull requests all merged and its tip is the local HEAD; otherwise nothing |
| Orchestration database | `<stateDir>/orchestrator.sqlite` | `trigger`, `disposition`, `thread`, `ticket`, `decision`, `effect`, `outbox` and `kv` rows | Nothing; only live working sets are indexed |
| Workspace registry | `~/.dsh/storages/workspace.json` | One record and session-id list per workspace; rewritten whole on each change | Nothing |
| Projection cache | `~/.dsh/storages/session_projcache/` | One derived file per Session | Replaced, not collected |

Each Session is a compressed append-only generation with a lock file; committed events are never rewritten. The registry decides which Sessions a workspace lists and which are archived. The database is one WAL-mode SQLite file whose generated columns keep passes on live rows. The checkout is where the bytes go.

Sessions a person opens in the Web UI are not Ticket bundles. This proposal neither archives nor deletes them; a DSH-level policy, or the operator, would own them.

| Measure (2026-11-05) | Value |
| --- | --- |
| DSH session logs | 21 files, 13.2 MB |
| Checkout directories | 8 directories, 188 MB (5.2–139 MB each) |
| Orchestration database | 312 KB plus a 4 MB write-ahead log |
| Workspace registry (host-wide) | 12 workspaces, 15 session ids, 0 archived |

The largest checkout held 133 MB of `node_modules`; the median checkout is about 6 MB. The orchestrator Session was 0.3 MB after eight hours, and 0.7 MB after three days in the older deployment. Sessions stay small until tool-heavy work arrives, which is when one Ticket can reach several megabytes — the largest here is 4.3 MB.

## How other systems bound it

Every mature system treats retention as a policy with two independent triggers and a deletion path that protects live work.

| System | Mechanism | What it suggests here |
| --- | --- | --- |
| [logrotate](https://man7.org/linux/man-pages/man8/logrotate.8.html) | Rotate by age or size, compress, keep N generations | Bound generations; compression is already used |
| [systemd-journald](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html) | `SystemMaxUse` and `SystemMaxFileSize` cap disk; `--vacuum-size` reclaims later | A disk budget, enforced out of band |
| [Prometheus](https://prometheus.io/docs/prometheus/latest/storage/) | `--storage.tsdb.retention.time` and `--storage.tsdb.retention.size`; deletes whole blocks | Age and size as equal triggers, never a scan of the live store |
| [Elasticsearch ILM](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html) | hot → warm → cold → delete phases | Tiering is deferred here: see below |
| [Kafka](https://kafka.apache.org/documentation/#configuration) | `log.retention.hours`, `log.retention.bytes`; deletes closed segments | Delete whole units; never rewrite a live log |
| [GitHub Actions](https://docs.github.com/en/actions/learn-github-actions/usage-limits-billing-and-administration) | Artifacts and logs kept 90 days by default; caches capped per repository and evicted after 7 unused days | A safe default plus a hard cap |
| [Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) | Lifecycle rules transition then expire objects | Explicit, reviewable rules instead of scripts |
| [SQLite](https://sqlite.org/lang_vacuum.html) | `auto_vacuum` and `incremental_vacuum`; WAL checkpoint | Return space in small steps, not a blocking `VACUUM` |

Five rules recur:

- Two triggers — age and total size — and whichever fires first wins.
- Delete whole units by an atomic rename, in the background, never by truncating live data.
- Select candidates from an index; a sweep costs O(batch), not O(corpus).
- Bound each run by batch size, elapsed time and IO priority.
- Keep a grace period, pinning, dry-run and an audit trail, so a deletion is reviewable.

## Proposed mechanism

One rule, one sweep and one deletion path. Everything else is deliberately absent until it proves necessary.

### The rule

A Ticket is purgeable when it ended at least `purgeDays` (45) days ago, is not pinned, has no pending or running Assignment, no undelivered Input, and no running agent. A checkout is additionally gated on `git status --porcelain` being empty and every commit being on a remote branch or its pull request merged; a checkout that fails this work check is kept and recorded, while its Session may still be purged. Each artifact is purged independently under its own check.

### The sweep

The sweep runs once a day, single-flight, outside model turns and panel requests. One indexed query selects ended Tickets older than the cutoff. The existing `ticket` table gains a generated `ended_at` column (`value ->> '$.ended.at'`) and an index, plus a generated `pinned` column; `outbox` gains `sent_at`, so settled receipts can be deleted by an index. No new table is introduced.

For each candidate the sweep re-reads the Ticket, applies the rule, moves the checkout into `<stateDir>/trash/<ticket>-<timestamp>/checkout`, and records the move. A second step in the same run removes trash entries older than 12 hours. The run stops at the batch or time cap and reports counts and bytes in the health entry and the log.

### The checkout

The checkout is the win: 188 MB against 13 MB of Sessions here. The implemented cleanup removes it as soon as its Ticket ends and the safe check passes, and a resumed Ticket rebuilds it with its prepare command. It also deletes the remote branch when the Ticket's own pull requests all merged and that branch still points at the local HEAD. The proposed extension is a trash step and a 45-day fallback for a checkout whose commits are not yet fully remote, which the sweep would keep and report; that extension is not implemented.

### The Session

The Session is small, and deleting it is the part DSH does not support. Phase 2 deletes it through the API described below; the same sweep calls it. Until then Sessions stay, so the session list keeps growing, but disk is not at risk from them. Archive is not used as a substitute: it hides a Session and blocks it from running until restored, while reclaiming nothing.

After a Session is purged, delivery creates a fresh one for the Ticket, the assignment text is re-sent, and the panel keeps the last report, so the work is recoverable but the conversation is not. That is the accepted trade at 45 days.

### Receipts and the size cap

Two smaller bounds, each one line in the same sweep. Settled outbox receipts are deleted 15 days after they settle; a receipt only prevents a duplicate delivery, and a Source's redelivery window is far shorter. If the state directory exceeds 10 GB, the sweep uses `emergencyDays` (22) — half the default age — for that run. The cap lowers the age; it does not choose victims, so there is no LRU. If the directory is still over at the halved age, health says so and the operator lowers `purgeDays`.

### What is deferred

- **A warm archive tier.** It hides Sessions but reclaims nothing, and an archived Session cannot run until restored, so resume needs an extra step for little benefit.
- **A summary of the purged Session.** It preserves context but adds a schema field, a write path and a resume path; at 45 days the last report is usually enough.
- **Pruning Triggers, dispositions, Decisions and `kv` versions.** The database is 312 KB; revisit when it is measured in gigabytes.
- **An orchestrator rotation.** Its log was 0.3 MB after eight hours and 0.7 MB after three days.
- **A per-file LRU.** The size cap already bounds the directory; an LRU only decides who loses first.

### What DSH must add

DSH has no Session deletion API, and archiving cannot stand in for it: an archived Session still occupies its disk, and its id must leave the archive set before a recreated Session with the same id can run. Removing the files behind DSH's back also races the persistence lock, the workspace membership and the projection cache.

The smallest correct addition is a removal operation on the session-persistence seam: take the write claim, refusing while another process holds it; remove the Session's generations and lock; remove the id from the workspace registry's membership and archive set; drop the projection cache entry; and return the bytes freed. dsh-superagent then calls it from the sweep. Phase 2 waits for it; phase 1 ships without it.

## Performance

- Selection is one indexed query; no new table, no scan of the session root, no per-candidate directory walk.
- Deletion is decoupled: the O(1) rename returns immediately, and the removal runs after the grace period, one directory at a time, at low IO priority.
- The sweep is daily and single-flight, with a batch and a time cap, and it skips startup and shutdown.
- The receipt delete is indexed and batched; no `VACUUM` runs against the live database.
- The session list does not shrink until phase 2, but listing cost is unchanged from today and checkouts do not affect it.
- A resume after purge is slower once: the prepare command rebuilds the checkout, or a fresh Session is created; neither path adds a new dependency.

## Safety

- No running or pending work is deleted; the check is repeated after every await, because a person can resume a Ticket mid-sweep.
- Trash is the undo window: nothing is unlinked inside `trashGraceHours`, and an operator can restore a rename by hand.
- Dry-run is the first mode: it logs what would be trashed and removed, with sizes, and writes nothing except the marks.
- An operator can pin a Ticket, which exempts it until unpinned.
- Unpushed work is never deleted; a checkout that fails the clean-and-pushed check is kept and reported.
- Every purge leaves an audit row with the time, reason and bytes; the health entry reports the last run.
- A failed deletion is logged and skipped; one failure does not block the rest of the batch.

## Defaults

| Setting | Proposal | Why |
| --- | --- | --- |
| `mode` | `off` | Deletion is destructive; enable it after a dry-run |
| `purgeDays` | 45 | Half the earlier quarter; still long enough for a follow-up |
| `trashGraceHours` | 12 | Half a day to undo a mistake |
| `receiptDays` | 15 | Half the earlier month; longer than any Source's redelivery window |
| `maxBytes` | 10 GB | Half the earlier budget for this 1 TB host |
| `emergencyDays` | 22 | Half the purge age, used when the cap is exceeded |
| `batchSize` | 50 | Fits a five-minute daily sweep |

## Phases

| Phase | Scope | Risk | Rough effort |
| --- | --- | --- | --- |
| 1 | Checkout deletion, receipt deletion, sweep, dry-run, health | Low | 2–3 days |
| 2 | Session deletion through the DSH API | Medium | 2–3 days |

## Alternatives

| Alternative | Why not |
| --- | --- |
| A cron job with `rm -rf` | Races live Sessions and work, cannot respect locks, and loses the undo window |
| Archive only | Hides the list but keeps every byte, and archived Sessions cannot run until restored |
| Delete when a Ticket ends | Implemented for a checkout that is clean and fully remote, which the prepare command rebuilds; one with local work is kept. A proposed 45-day sweep would handle the rest. |
| External object storage | More moving parts for one host; revisit if deployments multiply |
| A filesystem quota alone | Stops the agent at the limit instead of evicting gracefully |

## Open questions

1. Is losing a Session's context at 45 days, with no summary, acceptable? If not, the summary returns before phase 2.
2. Is deleting a clean, pushed checkout acceptable, given that the next resume rebuilds it? The Executor now does so when a Ticket ends; the open part is a trash window and the checkouts whose work is local.
3. Is a DSH-side Session deletion API acceptable to the DSH maintainers, or must the bundle use only shipped APIs — which would leave phase 2 unsupported?
4. Do the halved defaults fit this host: 45 days, 12 hours, 15 days, 10 GB?
5. Should pinning be per Ticket, per Thread, or both?