/** Deferring a Ticket's Assignments to the configured off-peak window (docs/003). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import type { OffPeakWindow } from '../src/offpeak.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })

/** Set the Executor's off-peak window, leaving the rest of the block as it is. */
function setWindow(window: Partial<OffPeakWindow>) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    offPeak: { enabled: true, start: '22:00', end: '08:00', timezone: 'Asia/Shanghai', ...window } } })
}
/** A GitHub Issue mention from an allowed sender, for the source-based default. */
function github(id: string, text: string): Trigger {
  return { id: `github:${id}`, source: 'github', threads: [{ source: 'github', id: `github:${id}` }],
    actor: { source: 'github', id: 'alice' }, human: true, addressed: 'mention', at: '2026-09-09T00:00:00Z', text, meta: {} }
}
/** Accept `trigger` with the routing fields given, outside the runtime's main-turn helpers. */
async function accept(trigger: Trigger, extra: Record<string, unknown> = {}): Promise<Ticket> {
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-one', acknowledgement: '收到。', ...extra })
  await h.runtime.idle()
  return h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
}
/** Move the fake clock without touching timers, and let the effect queue look again. */
async function setClock(iso: string) { vi.setSystemTime(Date.parse(iso)); await h.runtime.idle() }

it('holds an off-peak Ticket outside the window and launches it when the window opens', async () => {
  setWindow({ enabled: true, start: '22:00', end: '08:00' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-09T04:00:00Z') }) // 12:00 in Asia/Shanghai
  const ticket = await accept(feishu('1', '@bot 这个不急，排到夜里做'), { off_peak: true })
  expect(ticket.offPeak).toBe(true)
  expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'pending' })])
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(false)
  expect(h.runtime.effects.pending('launch')).toBe(true)
  // The launch is re-checked about once a minute, and stays held while the window is still closed.
  await setClock('2026-09-09T04:01:00Z')
  expect(ticketState(ticket)).toBe('pending')
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(false)
  // 22:00 in Asia/Shanghai: the same queued launch now starts.
  await setClock('2026-09-09T14:00:00Z')
  expect(ticketState(ticket)).toBe('running')
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(true)
  expect(h.runtime.effects.pending('launch')).toBe(false)
})

it('launches an off-peak Ticket at once inside the window or while the window is disabled', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-09T04:00:00Z') })
  setWindow({ enabled: false })
  const disabled = await accept(feishu('1', '@bot 这个不急'), { off_peak: true })
  expect(disabled.offPeak).toBe(true)
  expect(ticketState(disabled)).toBe('running')
  setWindow({ enabled: true, start: '09:00', end: '17:00' }) // 12:00 local is inside
  const open = await accept(feishu('2', '@bot 这个不急'), { off_peak: true })
  expect(ticketState(open)).toBe('running')
})

it('launches a Ticket not marked off-peak at once, outside the window', async () => {
  setWindow({ enabled: true, start: '22:00', end: '08:00' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-09T04:00:00Z') })
  const ticket = await accept(feishu('1', '@bot 修一下'))
  expect(ticket.offPeak).toBeUndefined()
  expect(ticketState(ticket)).toBe('running')
})

it('defers a GitHub request by default and honours an explicit override for urgent work', async () => {
  setWindow({ enabled: true, start: '22:00', end: '08:00' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-09T04:00:00Z') })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: { provider: 'test', model: 'deepseek-v4.1-flash' } } })
  const deferred = await accept(github('1', 'Upgrade the parser to the new grammar'))
  expect(deferred.offPeak).toBe(true)
  expect(ticketState(deferred)).toBe('pending')
  h.runtime.store.saveSettings(settings)
  const urgent = await accept(github('2', 'The production build is broken'), { off_peak: false })
  expect(urgent.offPeak).toBeUndefined()
  expect(ticketState(urgent)).toBe('running')
})

it('uses the selected tier model rather than the fallback for the default', async () => {
  setWindow({ enabled: true })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-09T04:00:00Z') })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    model: { provider: 'test', model: 'other' }, tierModels: { ...settings.executor.tierModels, high: { provider: 'test', model: 'deepseek-v4.1-flash' } } } })
  const ticket = await accept(github('1', 'Fix the parser'))
  expect(ticket.offPeak).toBe(true)
  expect(ticketState(ticket)).toBe('pending')
})

it('starts other models immediately by default but permits explicit deferral', async () => {
  setWindow({ enabled: true })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-09T04:00:00Z') })
  const immediate = await accept(github('1', 'Fix the parser'))
  expect(immediate.offPeak).toBeUndefined()
  expect(ticketState(immediate)).toBe('running')
  const deferred = await accept(github('2', 'Fix the parser later'), { off_peak: true })
  expect(deferred.offPeak).toBe(true)
  expect(ticketState(deferred)).toBe('pending')
})

/** The state of a Ticket's latest Assignment, read fresh from the store. */
function ticketState(ticket: Ticket): string {
  return h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.state
}