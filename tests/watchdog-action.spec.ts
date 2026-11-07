/** The Watchdog intervention service: modes, guards, cooldown and limits around retry and stop. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { watchdogAction, type WatchdogHost, type WatchdogRequest } from '../src/app/watchdog.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Assignment, ReportState, Ticket } from '../src/core/index.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import type { WatchdogConfig } from '../src/policy.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-action-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const report = (state: ReportState, summary: string, reportedAt: string) => ({ state, summary, at: reportedAt })
const assignment = (fields: Partial<Assignment> = {}): Assignment => ({ id: 'a1', state: 'running', createdAt: at(120), ...fields })
function ticket(id: string, fields: Partial<Ticket> = {}): Ticket {
  return { id, title: id, decisionId: 'd', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at(120),
    updatedAt: at(120),
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
    origin: { triggerId: 'e0', triggerIds: ['e0'] }, ...fields }
}
function host(engine: WatchdogHost['engine'], configured = true): WatchdogHost {
  const sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind); sources.register(feishuKind)
  return { store, engine, configured: () => configured, view: { store, sources, links: () => ({ url: '', label: { zh: '', en: '' } }) } }
}
function configure(watchdog: Partial<WatchdogConfig> = {}) {
  store.saveSettings(SettingsSchema.parse({ watchdog }))
}
function request(action: 'retry' | 'stop', overrides: Partial<WatchdogRequest> = {}): WatchdogRequest {
  return { ticketId: 't1', action, reason: 'No progress for two hours', snapshotAt: at(1), idempotencyKey: `${action}-key`, ...overrides }
}
const retryEngine = () => ({ retryTicket: vi.fn(), stopTicket: vi.fn() })
function saveBlocked() {
  store.tickets.save(ticket('t1', { updatedAt: at(120), assignments: [assignment({ report: report('failed', 'The build failed', at(120)) })] }))
}

it('never changes a Ticket in off, observe or report mode, and audits the decision', () => {
  saveBlocked()
  const engine = retryEngine()
  for (const mode of ['off', 'observe', 'report'] as const) {
    configure({ mode })
    const result = watchdogAction(host(engine), request('retry', { idempotencyKey: `${mode}-key` }))
    expect(result.mode).toBe(mode)
    const expected = { off: 'refused', observe: 'observed', report: 'reported' } as const
    expect(result.result).toBe(expected[mode])
    expect(result.refusal).toBe(mode === 'off' ? 'modeOff' : undefined)
    expect(store.tickets.get('t1')?.ended).toBeUndefined()
  }
  expect(engine.retryTicket).not.toHaveBeenCalled()
  expect(store.watchdog.recent()).toHaveLength(3)
})

it('enforces a retry only after re-reading the Ticket and records before and after', () => {
  saveBlocked()
  configure({ mode: 'enforce', actions: ['retry'] })
  const engine = retryEngine()
  engine.retryTicket.mockImplementation(() => {
    const current = store.tickets.get('t1')!
    current.assignments = [assignment({ state: 'pending', report: undefined })]
    current.updatedAt = new Date().toISOString()
    store.tickets.save(current)
  })
  const result = watchdogAction(host(engine), request('retry'))
  expect(result.result).toBe('executed')
  expect(result.mode).toBe('enforce')
  expect(engine.retryTicket).toHaveBeenCalledWith('t1')
  expect(result.before).toMatchObject({ stage: 'person', action: 'failed', silentMinutes: 120 })
  expect(result.after).toMatchObject({ stage: 'working', action: 'queued' })
  expect(store.watchdog.byIdempotency('retry-key')).toMatchObject({ result: 'executed', ticketId: 't1' })
})

it('stops only a working Ticket that has visibly stopped making progress', () => {
  store.tickets.save(ticket('t1', { updatedAt: at(120), assignments: [assignment({ startedAt: at(120), report: report('progress', 'Still going', at(120)) })] }))
  configure({ mode: 'enforce', actions: ['stop'] })
  const engine = retryEngine()
  engine.stopTicket.mockImplementation(() => {
    const current = store.tickets.get('t1')!
    current.ended = { at: new Date().toISOString(), by: 'human', outcome: 'stopped' }
    store.tickets.save(current)
  })
  const result = watchdogAction(host(engine), request('stop', { reason: 'No progress for two hours' }))
  expect(result.result).toBe('executed')
  expect(engine.stopTicket).toHaveBeenCalledWith('t1', 'No progress for two hours')
  expect(result.after).toEqual({ ended: true })
  // A blocked Ticket waits on a person; stop must not discard that decision.
  saveBlocked()
  const blocked = watchdogAction(host(engine), request('stop', { idempotencyKey: 'blocked-stop' }))
  expect(blocked).toMatchObject({ result: 'refused', refusal: 'notStoppable' })
})

it('refuses an action when a person is waited for, a delivery is pending, or the service is paused or unconfigured', () => {
  saveBlocked()
  configure({ mode: 'enforce', actions: ['retry', 'stop'] })
  const engine = retryEngine()
  const current = () => store.tickets.get('t1')!
  let value = current(); value.attention = { id: 'q1', question: 'Which branch?' }; store.tickets.save(value)
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'attention' }))).toMatchObject({ result: 'refused', refusal: 'attention' })
  value = current(); delete value.attention; value.undelivered = ['i1']; store.tickets.save(value)
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'pending' }))).toMatchObject({ result: 'refused', refusal: 'deliveryPending' })
  value = current(); value.undelivered = []; store.tickets.save(value)
  expect(watchdogAction(host(engine, false), request('retry', { idempotencyKey: 'setup' }))).toMatchObject({ result: 'refused', refusal: 'setup' })
  store.saveSettings(SettingsSchema.parse({ paused: true, watchdog: { mode: 'enforce', actions: ['retry'] } }))
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'paused' }))).toMatchObject({ result: 'refused', refusal: 'paused' })
  expect(engine.retryTicket).not.toHaveBeenCalled()
})

it('refuses a stale snapshot, a changed Ticket, a too-recent stall and an action the settings exclude', () => {
  saveBlocked()
  configure({ mode: 'enforce', actions: ['retry'] })
  const engine = retryEngine()
  expect(watchdogAction(host(engine), request('retry', { snapshotAt: at(30), idempotencyKey: 'expired' })))
    .toMatchObject({ result: 'refused', refusal: 'snapshotExpired' })
  const current = store.tickets.get('t1')!; current.updatedAt = new Date().toISOString(); store.tickets.save(current)
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'changed' })))
    .toMatchObject({ result: 'refused', refusal: 'ticketChanged' })
  const fresh = ticket('t2', { updatedAt: at(1), assignments: [assignment({ report: report('failed', 'Just failed', at(1)) })] })
  store.tickets.save(fresh)
  expect(watchdogAction(host(engine), request('retry', { ticketId: 't2', idempotencyKey: 'fresh' })))
    .toMatchObject({ result: 'refused', refusal: 'notStale' })
  expect(watchdogAction(host(engine), request('stop', { idempotencyKey: 'excluded' })))
    .toMatchObject({ result: 'refused', refusal: 'actionNotAllowed' })
})

it('refuses a repeated action by cooldown, idempotency and the hourly limits, so only one request executes', () => {
  saveBlocked()
  configure({ mode: 'enforce', actions: ['retry'] })
  const engine = retryEngine()
  engine.retryTicket.mockImplementation(() => {})
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'first' })).result).toBe('executed')
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'first' })).result).toBe('executed')
  expect(engine.retryTicket).toHaveBeenCalledTimes(1)
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'second' })))
    .toMatchObject({ result: 'refused', refusal: 'cooldown' })
  expect(engine.retryTicket).toHaveBeenCalledTimes(1)
})
it('records a failed action without rolling the Ticket back, and still applies the cooldown', () => {
  saveBlocked()
  configure({ mode: 'enforce', actions: ['retry'] })
  const engine = retryEngine()
  engine.retryTicket.mockImplementation(() => { throw new Error('the worker would not start') })
  const failed = watchdogAction(host(engine), request('retry', { idempotencyKey: 'failure' }))
  expect(failed).toMatchObject({ result: 'failed', error: 'the worker would not start' })
  expect(store.tickets.get('t1')?.ended).toBeUndefined()
  expect(watchdogAction(host(engine), request('retry', { idempotencyKey: 'after-failure' })))
    .toMatchObject({ result: 'refused', refusal: 'cooldown' })
  expect(engine.retryTicket).toHaveBeenCalledTimes(1)
})
