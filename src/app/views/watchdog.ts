/** Read-only supervision facts for an external Watchdog: every open Ticket, its latest report and how long it has been silent. */
import { canRetry, latestAssignment, latestReport, ticketStage, type Assignment, type Ticket } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import { threadFacts, snapshot, type Snapshot, type ViewHost } from './records.ts'
import { markdown } from './text.ts'

/**
 * Mechanical hints for a Watchdog; the model judges whether a hint matters. `delivery-error` and `undelivered-inputs`
 * are faults, `queued` and `no-progress` mean a working Ticket has been silent for the stale threshold, and
 * `waiting-person` means a blocked, failed or unanswered Ticket has waited that long.
 */
export type WatchdogSignal = 'delivery-error' | 'undelivered-inputs' | 'queued' | 'no-progress' | 'waiting-person'
const SIGNAL_ORDER: readonly WatchdogSignal[] = ['delivery-error', 'undelivered-inputs', 'queued', 'no-progress', 'waiting-person']
/** A person stage these actions do not raise `waiting-person` for: delivery has its own fault signal, and a review may wait normally. */
const NO_WAITING_SIGNAL = new Set(['review', 'delivery'])

/** Whole minutes from `from` to `to`, never negative, or 0 for an unreadable time. */
function minutesBetween(from: string, to: number): number {
  const value = Date.parse(from)
  return Number.isFinite(value) ? Math.max(0, Math.floor((to - value) / 60_000)) : 0
}
/** The newest timestamp among a Ticket's change, inputs and Assignments; a Ticket's last visible sign of life. */
function lastActivity(ticket: Ticket): string {
  const times = [ticket.updatedAt, ...ticket.inputs.map(input => input.at),
    ...ticket.assignments.flatMap(assignment => [assignment.createdAt, assignment.startedAt, assignment.deliveredAt, assignment.idleAt,
      assignment.report?.at])].filter((value): value is string => !!value)
  return times.sort().at(-1) ?? ticket.createdAt
}
/** The Latest Assignment's supervision facts, without the report's full summary (the Ticket row carries that). */
function assignmentFacts(assignment: Assignment | undefined) {
  if (!assignment) return undefined
  return { id: assignment.id, state: assignment.state, createdAt: assignment.createdAt,
    ...assignment.startedAt ? { startedAt: assignment.startedAt } : {},
    ...assignment.deliveredAt ? { inputsDeliveredAt: assignment.deliveredAt } : {},
    ...assignment.idleAt ? { turnEndedAt: assignment.idleAt } : {} }
}
/** The Threads a Ticket subscribes to, as keys, titles and links; a context Thread grants no authority. */
function threadsOf(view: Snapshot, ticket: Ticket) {
  return view.threadsOf(ticket.id).map(thread => ({ ...threadFacts(view.store, thread),
    ...thread.context?.includes(ticket.id) ? { context: true as const } : {} }))
}
/**
 * Builds the Watchdog view: every open Ticket with its stage, latest Assignment and report, silence and signals.
 * `staleMinutes` is the silence threshold for the mechanical signals; it is a hint, not a verdict.
 */
export function watchdogView(host: ViewHost, at: string, staleMinutes: number) {
  const view = snapshot(host)
  const now = Date.parse(at)
  const tickets = host.store.tickets.open().slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(ticket => {
    const stage = ticketStage(ticket)
    // `idle` and `ended` have no action; a person stage names one and a queued working stage names `queued`.
    const action = 'action' in stage ? stage.action : undefined
    const assignment = latestAssignment(ticket)
    const report = latestReport(ticket)
    const activity = lastActivity(ticket)
    const silentMinutes = minutesBetween(activity, now)
    const signals: WatchdogSignal[] = []
    if (ticket.delivery) signals.push('delivery-error')
    if (ticket.undelivered.length) signals.push('undelivered-inputs')
    if (stage.stage === 'working' && action === 'queued') {
      // An off-peak Ticket waits on purpose; the window, not a fault, holds it.
      if (!ticket.offPeak && silentMinutes > staleMinutes) signals.push('queued')
    } else if (stage.stage === 'working' && silentMinutes > staleMinutes) signals.push('no-progress')
    else if (stage.stage === 'person' && action && !NO_WAITING_SIGNAL.has(action) && silentMinutes > staleMinutes) signals.push('waiting-person')
    const ordered = SIGNAL_ORDER.filter(signal => signals.includes(signal))
    return { id: ticket.id, title: ticket.title, stage: stage.stage, ...action ? { action } : {},
      createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, ageMinutes: minutesBetween(ticket.createdAt, now),
      lastActivityAt: activity, silentMinutes, ...assignment ? { assignment: assignmentFacts(assignment) } : {},
      ...report ? { lastReport: { state: report.state, summary: report.summary, at: report.at,
        ageMinutes: minutesBetween(report.at, now) } } : {},
      // Every Assignment's last known state, oldest first, so repeated failures are visible without the full reports.
      attempts: ticket.assignments.map(item => item.report?.state ?? item.state),
      ...ticket.attention ? { attention: { id: ticket.attention.id, question: markdown(ticket.attention.question),
        ...ticket.attention.triggerId ? { triggerId: ticket.attention.triggerId } : {} } } : {},
      ...ticket.delivery ? { deliveryError: ticket.delivery.error } : {}, undelivered: ticket.undelivered.length,
      ...ticket.offPeak ? { offPeak: true } : {}, actions: { retry: canRetry(ticket), stop: true },
      ...ticket.execution ? { directory: ticket.execution.directory } : {},
      ...ticket.assignments.some(item => item.startedAt) ? { sessionId: workerSessionId(ticket.id) } : {},
      threads: threadsOf(view, ticket), signals: ordered }
  })
  return { at, staleMinutes, open: tickets.length, tickets }
}
export type WatchdogView = ReturnType<typeof watchdogView>