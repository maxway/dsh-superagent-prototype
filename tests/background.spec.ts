/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('waits for tree work on a DSH runtime that no longer exposes waitForChildren', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const waitForTreeWork = vi.fn(async () => false)
  Reflect.deleteProperty(subagents, 'waitForChildren')
  Reflect.set(subagents, 'waitForTreeWork', waitForTreeWork)
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(true)
  expect(waitForTreeWork).toHaveBeenCalledWith(agent)
})

it('reports when the runtime has no supported subagent controls', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  await expect(stopSubagents(ctx, agent)).rejects.toThrow('does not provide supported background-work controls')
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('interrupts rc.2 descendants and waits without closing the root', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const interrupt = vi.fn(), wait = vi.fn(async () => false), drain = vi.fn()
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => [
    { kind: 'child', id: 'child-1' }, { kind: 'child', id: 'grandchild' }, { kind: 'diagnostic', id: 'unreadable' },
  ]))
  Reflect.set(subagents, 'interrupt', interrupt)
  Reflect.set(subagents, 'waitForTreeWork', wait)
  Reflect.set(subagents, 'drainDescendants', drain)
  await stopSubagents(ctx, agent, true)
  expect(interrupt.mock.calls).toEqual([
    ['child-1', { kind: 'ancestor', agent }], ['grandchild', { kind: 'ancestor', agent }],
  ])
  expect(wait).toHaveBeenCalledWith(agent)
  expect(drain).not.toHaveBeenCalled()
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
})

it('does not cancel the worker when rc.2 has no catalogued children', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const interrupt = vi.fn(), wait = vi.fn(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => []))
  Reflect.set(subagents, 'interrupt', interrupt)
  Reflect.set(subagents, 'waitForTreeWork', wait)
  await stopSubagents(ctx, agent)
  expect(interrupt).not.toHaveBeenCalled()
  expect(wait).not.toHaveBeenCalled()
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})
