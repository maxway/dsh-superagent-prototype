/** What an external Watchdog reads: the open Tickets, their latest reports, silence and mechanical signals. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { watchdogSummary, watchdogView } from '../src/app/views/watchdog.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Assignment, ReportState, Ticket } from '../src/core/index.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const NOW = '2026-11-07T01:00:00.000Z'
const at = (minutesAgo: number): string => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString()
function views() {
  store.saveSettings(SettingsSchema.parse({}))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind); sources.register(feishuKind)
  return { store, sources, links: () => ({ url: '', label: { zh: '', en: '' } }) }
}
const report = (state: ReportState, summary: string, reportedAt: string) => ({ state, summary, at: reportedAt })
const assignment = (fields: Partial<Assignment> = {}): Assignment => ({ id: 'a1', state: 'running', createdAt: at(120), ...fields })
function ticket(id: string, fields: Partial<Ticket> = {}): Ticket {
  return { id, title: id, decisionId: 'd', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at(120),
    updatedAt: at(120),
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
    origin: { triggerId: 'e0', triggerIds: ['e0'] }, ...fields }
}
const row = (id: string) => watchdogView(views(), NOW, 30).tickets.find(ticket => ticket.id === id)!

it('reports every open Ticket with its stage, latest report, silence and the Threads it follows', () => {
  const host = views()
  store.tickets.save(ticket('working', { title: 'Update README', updatedAt: at(50),
    assignments: [assignment({ startedAt: at(120), report: report('progress', 'Editing the README', at(50)) })] }))
  store.tickets.save(ticket('ended', { ended: { at: at(10), by: 'executor', outcome: 'completed' } }))
  store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: at(120), subscriptions: ['working'], correlated: [],
    pending: [], context: ['working'], meta: { label: 'PR 7', url: 'https://example.test/pull/7' } })
  const view = watchdogView(host, NOW, 30)
  expect(view).toMatchObject({ at: NOW, staleMinutes: 30, open: 1 })
  expect(view.tickets[0]).toMatchObject({ id: 'working', title: 'Update README', stage: 'working', ageMinutes: 120, silentMinutes: 50,
    lastReport: { state: 'progress', summary: 'Editing the README', at: at(50), ageMinutes: 50 }, signals: ['no-progress'],
    threads: [{ key: 'github:7', title: 'PR 7', url: 'https://example.test/pull/7', context: true }] })
})

it('flags faults and stale stages, but not an off-peak wait or a ready result awaiting review', () => {
  const host = views()
  const tickets = [
    ticket('delivery', { updatedAt: at(40), delivery: { error: 'worker unreachable', at: at(40) },
      assignments: [assignment({ startedAt: at(60), deliveredAt: at(40) })] }),
    ticket('undelivered', { updatedAt: at(5), inputs: [{ id: 'i1', kind: 'text', text: 'Status', at: at(5) }], undelivered: ['i1'],
      assignments: [assignment({ startedAt: at(60), report: report('progress', 'Busy', at(5)) })] }),
    ticket('queued', { createdAt: at(90), updatedAt: at(90) }),
    ticket('offpeak', { offPeak: true, createdAt: at(90), updatedAt: at(90) }),
    ticket('blocked', { updatedAt: at(50), assignments: [assignment({ report: report('blocked', 'Needs the design file', at(50)) })] }),
    ticket('review', { updatedAt: at(50), assignments: [assignment({ report: report('ready', 'PR is open', at(50)) })] })
  ]
  for (const value of tickets) store.tickets.save(value)
  const view = watchdogView(host, NOW, 30)
  const rows = Object.fromEntries(view.tickets.map(ticket => [ticket.id, ticket]))
  expect(rows.delivery).toMatchObject({ stage: 'person', action: 'delivery', signals: ['delivery-error'], undelivered: 0 })
  expect(rows.undelivered?.signals).toEqual(['undelivered-inputs'])
  expect(rows.queued).toMatchObject({ stage: 'working', action: 'queued', signals: ['queued'] })
  expect(rows.offpeak?.signals).toEqual([])
  expect(rows.blocked).toMatchObject({ stage: 'person', action: 'blocked', signals: ['waiting-person'] })
  // Waiting for a person to review a ready result is normal; the Watchdog reads its silence but raises no signal.
  expect(rows.review).toMatchObject({ stage: 'person', action: 'review', silentMinutes: 50, signals: [] })
})

it('counts a recent input as activity, so a busy Ticket is not called stalled', () => {
  const host = views()
  store.tickets.save(ticket('busy', { updatedAt: at(5), inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e1', at: at(5), human: true }],
    assignments: [assignment({ startedAt: at(60), report: report('progress', 'Waiting on a long build', at(50)) })] }))
  const [busy] = watchdogView(host, NOW, 30).tickets
  expect(busy).toMatchObject({ id: 'busy', stage: 'working', silentMinutes: 5, signals: [],
    lastReport: { at: at(50), ageMinutes: 50 } })
})

it('exposes a Ticket\'s question, delivery error and worker Session', () => {
  const host = views()
  store.tickets.save(ticket('question', { updatedAt: at(100), attention: { id: 'q1', question: 'Which branch?', triggerId: 'e1' },
    assignments: [assignment({ startedAt: at(120), report: report('progress', 'Working', at(100)) })] }))
  const question = row('question')
  expect(question).toMatchObject({ attention: { id: 'q1', question: 'Which branch?', triggerId: 'e1' }, sessionId: 'worker-question' })
})

it('renders the observation as a Feishu summary with the flagged Tickets and the Watchdog judgement', () => {
  const host = views()
  store.tickets.save(ticket('stalled', { title: 'Fix the build', updatedAt: at(50),
    assignments: [assignment({ startedAt: at(120), report: report('blocked', 'Waiting for a design file', at(50)) })] }))
  store.tickets.save(ticket('quiet', { title: 'Update the README', updatedAt: at(5),
    assignments: [assignment({ startedAt: at(60), report: report('progress', 'Editing the README', at(5)) })] }))
  const text = watchdogSummary({ view: watchdogView(host, NOW, 30), paused: false, load: { running: 1, maxWorkers: 3 },
    health: { runtime: { state: 'ready' }, feishu: { state: 'ready' } }, note: 'It has not reported for a while.' })
  expect(text).toContain('**Watchdog 观察汇总**')
  expect(text).toContain('服务 ready · 执行器 1/3')
  expect(text).toContain('进行中 2 个工单，1 个需要关注：')
  expect(text).toContain('- `stalled` Fix the build — 受阻，静默 50 分钟，信号 waiting-person')
  expect(text).toContain('最近报告 blocked：Waiting for a design file')
  expect(text).toContain('其余 1 个工单没有机械信号。')
  expect(text).toContain('**Watchdog 判断**：It has not reported for a while.')
})

it('renders an empty observation, a paused service and non-ready parts, without a judgement', () => {
  const host = views()
  const text = watchdogSummary({ view: watchdogView(host, NOW, 30), paused: true, load: { running: 0, maxWorkers: 3 },
    health: { runtime: { state: 'ready' }, feishu: { state: 'error', detail: 'socket closed' } } })
  expect(text).toContain('服务 ready · 执行器 0/3 · 已暂停 · 其他异常 feishu error（socket closed）')
  expect(text).toContain('没有进行中的工单。')
  expect(text).not.toContain('Watchdog 判断')
})
