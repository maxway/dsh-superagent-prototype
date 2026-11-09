/** Bounded Watchdog recovery: only an absent worker Session, one audited retry, and no service restart. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { MAX_RECOVERY_ATTEMPTS, recoverWatchdogSession, recoveryMode } from '../src/app/watchdog-recovery.ts'
import type { Ticket } from '../src/core/index.ts'

let directory: string
let store: Store
const NOW = '2026-11-07T01:00:00.000Z'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-recovery-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function ticket(id: string, state: 'running' | 'failed' = 'running'): Ticket {
  return { id, title: id, decisionId: 'd', channels: [], inputs: [], undelivered: [], createdAt: NOW, updatedAt: NOW,
    assignments: [{ id: 'a1', state, createdAt: NOW, startedAt: NOW }], origin: { triggerId: 'e0', triggerIds: ['e0'] } } as unknown as Ticket
}
function host(mode: 'off' | 'enforce' = 'enforce', lifecycle: { ticketId: string; sessionId: string; status: 'running' }[] = []) {
  return { store, engine: { retryTicket: vi.fn((id: string) => ticket(id)) }, sessions: { lifecycle: () => lifecycle },
    paused: false, mode, now: () => new Date(NOW) }
}
const request = (ticketId: string, key: string, snapshotAt = NOW) => ({ ticketId, action: 'retry' as const, reason: 'Session missing',
  snapshotAt, idempotencyKey: key })

it('executes at most one audited retry for an absent Session and never retries a present one', () => {
  expect(recoveryMode('enforce')).toBe('enforce')
  expect(recoveryMode(undefined)).toBe('off')
  store.tickets.save(ticket('t1'))
  const off = recoverWatchdogSession(host('off'), request('t1', 'off-1'))
  expect(off).toMatchObject({ result: 'refused' })
  expect(host('off').engine.retryTicket).not.toHaveBeenCalled()

  const runtime = host()
  const executed = recoverWatchdogSession(runtime, request('t1', 'recover-1'))
  expect(executed).toMatchObject({ result: 'executed', ticketId: 't1', sessionId: 'worker-t1' })
  expect(runtime.engine.retryTicket).toHaveBeenCalledWith('t1')
  expect(recoverWatchdogSession(runtime, request('t1', 'recover-1'))).toMatchObject({ result: 'executed' })
  expect(runtime.engine.retryTicket).toHaveBeenCalledTimes(1)
  const second = recoverWatchdogSession(runtime, request('t1', 'recover-2'))
  expect(second).toMatchObject({ result: 'refused', error: expect.stringContaining(`its ${MAX_RECOVERY_ATTEMPTS} recovery retry`) })
  expect(runtime.engine.retryTicket).toHaveBeenCalledTimes(1)

  store.tickets.save(ticket('present'))
  const present = recoverWatchdogSession(host('enforce', [{ ticketId: 'present', sessionId: 'worker-present', status: 'running' }]),
    request('present', 'present-1'))
  expect(present).toMatchObject({ result: 'refused', error: expect.stringContaining('Session is present') })
})

it('refuses a stale snapshot and a latest Assignment that is not running', () => {
  store.tickets.save(ticket('stale'))
  expect(recoverWatchdogSession(host(), request('stale', 'stale-1', '2026-11-07T00:00:00.000Z')))
    .toMatchObject({ result: 'refused', error: expect.stringContaining('stale') })
  store.tickets.save(ticket('failed', 'failed'))
  expect(recoverWatchdogSession(host(), request('failed', 'failed-1')))
    .toMatchObject({ result: 'refused', error: expect.stringContaining('not running') })
})