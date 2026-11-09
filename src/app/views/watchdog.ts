/** Read-only supervision facts for an external Watchdog and the observation summary it can send to a person. */
import { latestAssignment, latestReport, ticketStage, type Assignment, type Ticket } from '../../core/index.ts'
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
      ...ticket.offPeak ? { offPeak: true } : {},
      ...ticket.execution ? { directory: ticket.execution.directory } : {},
      ...ticket.assignments.some(item => item.startedAt) ? { sessionId: workerSessionId(ticket.id) } : {},
      threads: threadsOf(view, ticket), signals: ordered }
  })
  return { at, staleMinutes, open: tickets.length, tickets }
}
export type WatchdogView = ReturnType<typeof watchdogView>
/** State facts a Feishu Watchdog report carries besides the Ticket rows; `health` is the service's part health. */
export interface WatchdogSummaryInput {
  view: WatchdogView
  paused: boolean
  load: { running: number; maxWorkers: number }
  health: Record<string, { state: string; detail?: string }>
  /** The Watchdog's own one-sentence judgement, appended when it reports a finding or a quiet daily summary. */
  note?: string
}
/** A person stage's action label; the Watchdog view stores the action separately from the coarse `person` stage. */
const ACTION_LABEL: Record<string, string> = {
  answer: '待回答', review: '待验收', blocked: '受阻', failed: '失败', delivery: '投递失败',
}
const STAGE_LABEL: Record<string, string> = { ...ACTION_LABEL, working: '执行中', idle: '等待新触发' }
/** A Ticket's human-readable stage: a working Ticket is executing or queued, and a person Ticket shows what a person must do. */
function stageLabel(ticket: WatchdogView['tickets'][number]): string {
  if (ticket.stage === 'working') return ticket.action === 'queued' ? '排队中' : '执行中'
  return ticket.stage === 'person' && ticket.action ? ACTION_LABEL[ticket.action] ?? '待处理' : STAGE_LABEL[ticket.stage] ?? ticket.stage
}
/** One line of at most `max` characters, with whitespace collapsed so a report summary cannot break the Markdown list. */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
/** The report header's local time, `YYYY-MM-DD HH:mm`, from the snapshot's ISO timestamp; an unreadable timestamp is kept verbatim. */
function localTime(at: string): string {
  const value = new Date(at)
  if (!Number.isFinite(value.getTime())) return at
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}
/** At most this many flagged Tickets are listed; the rest become one count so a busy deployment stays within one message. */
const REPORT_TICKETS = 10
/**
 * Renders the Watchdog's observation as Feishu Markdown for the Feishu report route: service state and the open Tickets
 * that carry mechanical signals with their silence and latest report. It reads the same facts as the snapshot, so the
 * person receiving it sees the current observation; `note` adds the Watchdog's judgement. The message is plain operator
 * text, not a worker reply, so the 100-word IM limit does not apply.
 */
export function watchdogSummary(input: WatchdogSummaryInput): string {
  const { view, paused, load, health, note } = input
  const runtime = health.runtime
  const service = runtime ? runtime.state === 'ready' ? '服务 ready'
    : `服务 ${runtime.state}${runtime.detail ? `（${oneLine(runtime.detail, 80)}）` : ''}` : '服务状态未知'
  const problems = Object.entries(health).filter(([name, item]) => name !== 'runtime' && item.state !== 'ready')
    .map(([name, item]) => `${name} ${item.state}${item.detail ? `（${oneLine(item.detail, 60)}）` : ''}`)
  const facts = [service, `执行器 ${load.running}/${load.maxWorkers}`, ...paused ? ['已暂停'] : []]
  if (problems.length) facts.push(`其他异常 ${problems.join('；')}`)
  const lines = [`**Watchdog 观察汇总** · ${localTime(view.at)}`, facts.join(' · ')]
  const flagged = view.tickets.filter(ticket => ticket.signals.length)
  if (!view.open) lines.push('没有进行中的工单。')
  else if (!flagged.length) lines.push(`进行中 ${view.open} 个工单，没有需要关注的机械信号。`)
  else {
    lines.push(`进行中 ${view.open} 个工单，${flagged.length} 个需要关注：`)
    for (const ticket of flagged.slice(0, REPORT_TICKETS)) {
      const last = ticket.lastReport ? `；最近报告 ${ticket.lastReport.state}：${oneLine(ticket.lastReport.summary, 120)}` : ''
      lines.push(`- \`${ticket.id.slice(0, 8)}\` ${oneLine(ticket.title, 80)} — ${stageLabel(ticket)}，静默 ${ticket.silentMinutes}`
        + ` 分钟，信号 ${ticket.signals.join('、')}${last}`)
    }
    if (flagged.length > REPORT_TICKETS) lines.push(`- 另有 ${flagged.length - REPORT_TICKETS} 个工单需要关注。`)
    const quiet = view.open - flagged.length
    if (quiet) lines.push(`其余 ${quiet} 个工单没有机械信号。`)
  }
  if (note?.trim()) lines.push('', `**Watchdog 判断**：${oneLine(note, 500)}`)
  return lines.join('\n')
}
