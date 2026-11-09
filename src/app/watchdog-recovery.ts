/** One bounded Watchdog recovery attempt, with a persisted audit and a per-Session retry ceiling. */
import { randomUUID } from 'node:crypto'
import type { EngineForPeople } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import type { Sessions } from './sessions.ts'
import type { Store, WatchdogRecovery } from './store.ts'

/** Recovery is off unless the operator explicitly enables the enforce mode in the service's environment. */
export type RecoveryMode = 'off' | 'enforce'
/** Reads the operator's recovery mode; only the exact `enforce` value enables retries. */
export const recoveryMode = (value = process.env.DSH_SUPERAGENT_WATCHDOG_RECOVERY): RecoveryMode =>
  value === 'enforce' ? 'enforce' : 'off'
/** At most one retry per Session; a failed retry is still the one attempt, so it cannot loop. */
export const MAX_RECOVERY_ATTEMPTS = 1
/** A snapshot older than this is not evidence for a recovery action. */
const MAX_SNAPSHOT_AGE_MS = 10 * 60_000

/** What a Watchdog recovery needs from the service: the live Session registry, the Ticket store and the retry action. */
export interface WatchdogRecoveryHost {
  store: Pick<Store, 'tickets' | 'watchdogRecoveries' | 'atomic'>
  engine: Pick<EngineForPeople, 'retryTicket'>
  sessions: Pick<Sessions, 'lifecycle'>
  paused: boolean
  mode: RecoveryMode
  now?: () => Date
}

/** The recovery request a Watchdog may post; it names one Ticket and one fresh snapshot. */
export interface WatchdogRecoveryRequest {
  ticketId: string
  action: 'retry'
  reason: string
  snapshotAt: string
  idempotencyKey: string
}

/** Refuse, execute, or replay an audited retry; a refused or failed attempt never restarts the service. */
export function recoverWatchdogSession(host: WatchdogRecoveryHost, request: WatchdogRecoveryRequest): WatchdogRecovery {
  const previous = host.store.watchdogRecoveries.byIdempotency(request.idempotencyKey)
  if (previous) return previous
  const now = host.now?.() ?? new Date()
  const at = now.toISOString()
  const sessionId = workerSessionId(request.ticketId)
  const refuse = (error: string): WatchdogRecovery => {
    const record: WatchdogRecovery = { id: randomUUID(), idempotency: request.idempotencyKey, at, ...request, sessionId,
      result: 'refused', error }
    host.store.watchdogRecoveries.save(record)
    return record
  }
  if (host.mode !== 'enforce') return refuse('Watchdog recovery is off; set DSH_SUPERAGENT_WATCHDOG_RECOVERY=enforce')
  if (host.paused) return refuse('The executor is paused; recovery does not run while paused')
  const open = host.store.tickets.open().some(item => item.id === request.ticketId)
  if (!open) return refuse('The Ticket is not open')
  const ticket = host.store.tickets.get(request.ticketId)
  if (!ticket) return refuse('The Ticket is not open')
  const latest = ticket.assignments.at(-1)
  if (!latest || latest.state !== 'running') return refuse('The latest Assignment is not running')
  if (host.sessions.lifecycle().some(item => item.ticketId === ticket.id)) {
    return refuse('The worker Session is present; session-missing no longer holds')
  }
  const snapshot = Date.parse(request.snapshotAt)
  if (!Number.isFinite(snapshot) || snapshot > now.getTime() + 60_000 || now.getTime() - snapshot > MAX_SNAPSHOT_AGE_MS) {
    return refuse('The Watchdog snapshot is stale; take a fresh snapshot before retrying')
  }

  let reserved: WatchdogRecovery | undefined
  host.store.atomic(() => {
    const again = host.store.watchdogRecoveries.byIdempotency(request.idempotencyKey)
    if (again) { reserved = again; return }
    const attempts = host.store.watchdogRecoveries.forTicket(ticket.id).filter(item => item.result !== 'refused').length
    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      reserved = { id: randomUUID(), idempotency: request.idempotencyKey, at, ...request, sessionId, result: 'refused',
        error: `The Session already used its ${MAX_RECOVERY_ATTEMPTS} recovery retry` }
      host.store.watchdogRecoveries.save(reserved)
      return
    }
    reserved = { id: randomUUID(), idempotency: request.idempotencyKey, at, ...request, sessionId, result: 'executing' }
    host.store.watchdogRecoveries.save(reserved)
  })
  if (!reserved) return refuse('The recovery could not be reserved')
  const executing = reserved
  if (executing.result !== 'executing') return executing
  try {
    host.engine.retryTicket(ticket.id)
    const executed: WatchdogRecovery = { ...executing, result: 'executed' }
    host.store.watchdogRecoveries.save(executed)
    return executed
  } catch (error) {
    const failed: WatchdogRecovery = { ...executing, result: 'failed',
      error: error instanceof Error ? error.message : String(error) }
    host.store.watchdogRecoveries.save(failed)
    return failed
  }
}