/** The read-only Watchdog observation: recording a run and rendering the summary an external Watchdog reports. */
import { key } from '../core/index.ts'
import type { Store, WatchdogRun } from './store.ts'
import type { ViewHost } from './views/records.ts'
import { watchdogSummary, watchdogView } from './views/watchdog.ts'

/** The default silence threshold used when a snapshot request names none; an external Watchdog may override it per request. */
export const WATCHDOG_STALE_MINUTES = 30
/** How long recorded observation runs are kept; older rows are pruned whenever a new run is recorded. */
export const WATCHDOG_RUN_RETENTION_DAYS = 30

export interface WatchdogHost {
  store: Store
  /** The ticket views need the Sources and channel links, as the management snapshot uses them. */
  view: ViewHost
}
/** Service facts the observation record carries besides the Ticket snapshot. */
export interface WatchdogRunState {
  paused: boolean
  load: { running: number; maxWorkers: number }
  health: Record<string, { state: string; detail?: string }>
}
/** One recorded observation: the live snapshot, the rendered observation and an optional one-sentence judgement. */
export interface WatchdogRunRequest {
  note?: string
  /** The installed artifact's version and commit; a service-only check may omit them. */
  version?: string
  commit?: string
  idempotencyKey: string
}
/**
 * Record one Watchdog observation run. The server renders the observation from the live snapshot, so a stored run means
 * the check ran and what it saw even when nothing was flagged; a repeated idempotency key returns the first record.
 */
export function watchdogRun(host: WatchdogHost, state: WatchdogRunState, request: WatchdogRunRequest): WatchdogRun {
  return host.store.atomic(() => {
    const existing = host.store.watchdogRuns.byIdempotency(request.idempotencyKey)
    if (existing) return existing
    const at = new Date().toISOString()
    const view = watchdogView(host.view, at, WATCHDOG_STALE_MINUTES)
    const note = request.note?.trim() || undefined
    const run: WatchdogRun = {
      id: key('watchdog-run', request.idempotencyKey),
      idempotency: request.idempotencyKey,
      at,
      paused: state.paused,
      open: view.open,
      flagged: view.tickets.filter(ticket => ticket.signals.length).length,
      ...(note ? { note } : {}),
...(request.version ? { version: request.version } : {}),
      ...(request.commit ? { commit: request.commit } : {}),
      text: watchdogSummary({ view, paused: state.paused, load: state.load, health: state.health, ...(note ? { note } : {}) }),
    }
    host.store.watchdogRuns.save(run)
    host.store.watchdogRuns.prune(new Date(Date.parse(at) - WATCHDOG_RUN_RETENTION_DAYS * 86_400_000).toISOString())
    return run
  })
}