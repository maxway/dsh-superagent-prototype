# Deployment preflight timing, 2026-11-09

Source: the operator's `C:\Users\dd\.dsh\watchdog\watchdog-deploy.log` (not
committed; it contains operational reasoning and should not be copied into the
repository).

| Run | Deploy start | Deploy end | Wall time |
| --- | --- | --- | --- |
| 1 | 2026-11-09 08:46:58 | 2026-11-09 08:56:53 | 9 min 55 s |
| 2 | 2026-11-09 10:33:47 | 2026-11-09 10:43:09 | 9 min 22 s |

In run 2 the service stopped at about 10:40:56 and reported ready at about
10:41:50, so the stop, file switch, start and initial health check took about
54 seconds. The first seven minutes were preflight discovery and verification,
not the release itself.

## What consumed the preflight

- Re-establishing the running service's identity: DSH home, profile directory,
  `service.ps1`, configured `stateDir`, bundle link and its target.
- Re-checking whether an existing candidate worktree already produced the
  target tree, and comparing built files, instead of reusing one recorded
  candidate record.
- Pausing two independent watchdog writers for a consistent backup, then
  restoring them.
- Reconstructing an ambiguous request ("deploy !43 and set two environment
  variables") before the supervisor could begin.

A later crash investigation found a second deployment-flow defect: a service
started from the deploying DSH agent's shell tool inherits its Windows Job
object and is killed when the agent exits. The outer deployment task must start
the service after the DSH child has exited and then perform the health check.

## Changes in this merge request

- `scripts/dsh-superagent status` now reports `deployment` facts: DSH home,
  profile directory, `service.ps1`, `stateDir` from the profile patch, bundle
  link and target, checkout HEAD/branch/dirty state, and the built `lib`.
- The deployment preflight can therefore start from one read-only `status`
  call and reuse a recorded candidate whose tree matches the target.
- The deployment runbook now says to stop at the switched, stopped state and
  let the outer task start and verify the service, avoiding the Job-object
  failure.
- No production deployment was performed by this change.

## Mechanical executor, 2026-11-10

**Historical design:** The following describes the retired 2026-11-10 executor, not the current deployment path; the agent fallback, candidate manifest and backup/switch flow have since been removed. See [deployment](../../006-deployment.md#deploying-the-latest-superagent) for the current entry.

The routine deployment no longer starts a DSH agent. `scripts/deploy.mjs` (run
through `scripts/deploy.ps1`) performs a read-only preflight, stops the service,
copies the stopped SQLite state, switches an explicit runtime manifest, starts
the service outside every foreign Windows Job, verifies one process and API
readiness after a 3-second survival window, and rolls the runtime files back and
restarts the previous build when verification fails. The pre-built candidate is
produced before the maintenance window. A `mechanical` deployment configuration
selects this path; without it, `deploy.ps1` keeps the headless-agent fallback.

The preflight keeps only what a switch needs: one process, a ready runtime, no
setup problem, an unstopped and idle service, a resolved bundle inside the
runtime root, a clean candidate at the requested revision, an explicit manifest
including `lib`, a SQLite database to back up, and a post-start survival check.
It deliberately drops the agent's discovery and judgement, unrelated health
parts such as `evals`, repeated repository tests and builds, whole-checkout
hashing and ACL/hardlink/index audits. Those checks did not make the switch
safer within the window; the first eight minutes of the measured runs above
were discovery, not release work.

The executor is covered by `tests/deploy-executor.spec.ts` against a fake
control script and a local state API: plan without changes, stopped-state
backup, manifest switch, start and verify, rollback on failed verification, and
refusals for a busy service, an escaping manifest and a wrong candidate
revision. Production has not yet run a mechanical release, so the
under-one-minute target remains a design target rather than a measurement.