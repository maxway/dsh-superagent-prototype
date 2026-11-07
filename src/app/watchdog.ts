/** Watchdog interventions: guards, limits and audit around the existing retry and stop ticket operations. */
import { canRetry, key, latestReport, ticketStage, UserError, type EngineForPeople } from '../core/index.ts'
import type { WatchdogAction, WatchdogConfig } from '../policy.ts'
import type { Store, WatchdogAudit } from './store.ts'
import type { ViewHost } from './views/records.ts'
import { watchdogView } from './views/watchdog.ts'

/** The snapshot a Watchdog decision is based on may not be older than this when the API re-reads the Ticket. */
const SNAPSHOT_MAX_MS = 10 * 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface WatchdogHost {
  store: Store
  engine: Pick<EngineForPeople, 'retryTicket' | 'stopTicket'>
  /** The ticket views need the Sources and channel links, as the management snapshot uses them. */
  view: ViewHost
  configured(): boolean
  setupProblem?: unknown
}
export interface WatchdogRequest {
  ticketId: string
  action: WatchdogAction
  reason: string
  evidence?: Record<string, unknown>
  snapshotAt: string
  idempotencyKey: string
}
const rowFacts = (row: ReturnType<typeof watchdogView>['tickets'][number] | undefined) => row ? {
  stage: row.stage, ...(row.action ? { action: row.action } : {}), silentMinutes: row.silentMinutes, signals: row.signals,
  ...(row.lastReport ? { lastReport: { state: row.lastReport.state, summary: row.lastReport.summary, at: row.lastReport.at } } : {}),
  attempts: row.attempts,
} : undefined
/** Count the actions a cooldown and the settings' hourly limits consume; `executing` counts before it completes. */
function limits(entries: WatchdogAudit[], ticketId: string, config: WatchdogConfig, at: number) {
  const consumed = entries.filter(entry => (entry.result === 'executing' || entry.result === 'executed' || entry.result === 'failed')
    && Number.isFinite(Date.parse(entry.at)))
  const mine = consumed.filter(entry => entry.ticketId === ticketId)
  return { cooldown: mine.some(entry => at - Date.parse(entry.at) < config.cooldownMinutes * 60_000),
    perTicketPerHour: mine.filter(entry => at - Date.parse(entry.at) < HOUR).length,
    perHour: consumed.filter(entry => at - Date.parse(entry.at) < HOUR).length }
}
/**
 * Decide one Watchdog request: modes `off`, `observe` and `report` never change a Ticket; only `enforce` may retry or stop,
 * after re-reading the Ticket and rejecting a changed snapshot, a waiting person, a pending delivery, an off-peak wait, a
 * paused or incomplete service, a too-recent silence, an action the settings exclude, or a cooldown/limit. Every decision
 * is kept in `watchdog_audit`; an `executing` row reserves the action so a concurrent request cannot duplicate it.
 */
export function watchdogAction(host: WatchdogHost, request: WatchdogRequest): WatchdogAudit {
  const settings = host.store.settings()
  const config = settings.watchdog
  const at = Date.now()
  const now = new Date(at).toISOString()
  const id = key('watchdog', request.action, request.ticketId, request.idempotencyKey)
  const entry: WatchdogAudit = { id, idempotency: request.idempotencyKey, at: now, snapshotAt: request.snapshotAt,
    ticketId: request.ticketId, action: request.action, mode: config.mode, initiator: 'watchdog', reason: request.reason,
    ...(request.evidence ? { evidence: request.evidence } : {}), result: 'refused' }
  // The reservation transaction serializes concurrent requests for this deployment: one inserts `executing`; the next
  // sees it in the limits and refuses, or sees the same idempotency key and returns the first decision.
  const reserved = host.store.atomic(() => {
    const existing = host.store.watchdog.byIdempotency(request.idempotencyKey)
    if (existing) return { entry: existing, execute: false as const }
    const ticket = host.store.tickets.get(request.ticketId)
    if (!ticket) throw new UserError('unknownTicket')
    entry.ticketTitle = ticket.title
    const before = watchdogView(host.view, now, config.staleMinutes).tickets.find(row => row.id === request.ticketId)
    entry.before = rowFacts(before)
    const refuse = (refusal: string) => {
      entry.result = 'refused'; entry.refusal = refusal
      host.store.watchdog.save(entry)
      return { entry, execute: false as const }
    }
    if (config.mode === 'off') return refuse('modeOff')
    if (config.mode === 'observe') {
      entry.result = 'observed'
      host.store.watchdog.save(entry)
      return { entry, execute: false as const }
    }
    if (config.mode === 'report') {
      entry.result = 'reported'
      host.store.watchdog.save(entry)
      return { entry, execute: false as const }
    }
    if (!config.actions.includes(request.action)) return refuse('actionNotAllowed')
    const snapshot = Date.parse(request.snapshotAt)
    if (!Number.isFinite(snapshot) || at - snapshot > SNAPSHOT_MAX_MS || snapshot - at > 60_000) return refuse('snapshotExpired')
    if (!host.configured() || host.setupProblem) return refuse('setup')
    if (settings.paused) return refuse('paused')
    if (ticket.ended) return refuse('ticketEnded')
    if (Date.parse(ticket.updatedAt) > snapshot) return refuse('ticketChanged')
    if (ticket.attention) return refuse('attention')
    const reportAt = latestReport(ticket)?.at ?? ''
    if (ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > reportAt)) {
      return refuse('humanFollowUp')
    }
    if (ticket.undelivered.length) return refuse('deliveryPending')
    const stage = ticketStage(ticket)
    if (ticket.offPeak && stage.stage === 'working' && stage.action === 'queued') return refuse('offPeak')
    if (!before) return refuse('unknownTicket')
    if (before.silentMinutes < config.staleMinutes) return refuse('notStale')
    if (request.action === 'retry' && !canRetry(ticket)) return refuse('notRetryable')
    // A stop is only for a Ticket whose work has visibly stopped: not one waiting on a person or a review.
    if (request.action === 'stop' && (before.stage !== 'working'
      || !before.signals.some(signal => signal === 'no-progress' || signal === 'queued'))) return refuse('notStoppable')
    const usage = limits(host.store.watchdog.since(new Date(at - DAY).toISOString()), request.ticketId, config, at)
    entry.limits = { cooldownMinutes: config.cooldownMinutes, perTicketPerHour: config.perTicketPerHour, perHour: config.perHour,
      cooldown: Number(usage.cooldown), usedPerTicketPerHour: usage.perTicketPerHour, usedPerHour: usage.perHour }
    if (usage.cooldown) return refuse('cooldown')
    if (usage.perTicketPerHour >= config.perTicketPerHour) return refuse('perTicketPerHour')
    if (usage.perHour >= config.perHour) return refuse('perHour')
    entry.result = 'executing'
    host.store.watchdog.save(entry)
    return { entry, execute: true as const }
  })
  if (!reserved.execute) return reserved.entry
  try {
    if (request.action === 'retry') host.engine.retryTicket(request.ticketId)
    else host.engine.stopTicket(request.ticketId, request.reason)
    reserved.entry.result = 'executed'
  } catch (error) {
    reserved.entry.result = 'failed'
    reserved.entry.error = error instanceof Error ? error.message : String(error)
  }
  const afterAt = new Date().toISOString()
  try {
    const after = watchdogView(host.view, afterAt, config.staleMinutes).tickets.find(row => row.id === request.ticketId)
    reserved.entry.after = after ? rowFacts(after) : { ended: true }
  } catch (error) {
    reserved.entry.after = { error: error instanceof Error ? error.message : String(error) }
  }
  host.store.watchdog.save(reserved.entry)
  return reserved.entry
}