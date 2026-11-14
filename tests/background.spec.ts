/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { hasUnconfirmedSubagentCleanup, killJobs, stopBackground, stopSubagents, SubagentCleanupUnconfirmed, untilQuiet } from '../src/executor/background.ts'
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

it('recognizes only bounded nested unconfirmed cleanup errors', () => {
  const unconfirmed = new SubagentCleanupUnconfirmed('private detail')
  expect(hasUnconfirmedSubagentCleanup(new AggregateError([new AggregateError([unconfirmed])]))).toBe(true)
  expect(hasUnconfirmedSubagentCleanup(new Error('subagent_cleanup_unconfirmed'))).toBe(false)
  const cycle = new AggregateError([])
  cycle.errors.push(cycle)
  expect(hasUnconfirmedSubagentCleanup(cycle)).toBe(false)
  let deep: unknown = unconfirmed
  for (let depth = 0; depth < 10; depth++) deep = new AggregateError([deep])
  expect(hasUnconfirmedSubagentCleanup(deep)).toBe(false)
  expect(hasUnconfirmedSubagentCleanup(new AggregateError(Array.from({ length: 1000 }, () => new Error('other'))))).toBe(false)
})

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

it('reports jobs that remain running or cannot be collected after kill', async () => {
  const { ctx, jobs } = setup(async () => false)
  const first = jobs.run('worker-t1'), second = jobs.run('worker-t1')
  jobs.service.wait.mockImplementation(async id => {
    if (id === first) return { id, owner: 'worker-t1', status: 'running' }
    throw new Error('wait failed')
  })
  jobs.service.kill.mockImplementation(() => 'requested')
  await expect(killJobs(ctx, 'worker-t1', 'stop')).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: `Job ${first} is still running after kill` }),
      expect.objectContaining({ message: 'wait failed' })],
  })
  expect(jobs.service.kill.mock.calls.map(([id]) => id)).toEqual([first, second])
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

it('interrupts rc.2 descendants but reports their cleanup as unconfirmed', async () => {
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
  await expect(stopSubagents(ctx, agent, true)).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'Subagent cleanup for worker-t1 is unconfirmed; operator investigation is required' })],
  })
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
  expect(wait).toHaveBeenCalledWith(agent)
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('reports an unreadable descendant catalog as unconfirmed', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => [{ kind: 'diagnostic', id: 'unknown' }]))
  Reflect.set(subagents, 'interrupt', vi.fn())
  Reflect.set(subagents, 'waitForTreeWork', vi.fn(async () => false))
  await expect(stopSubagents(ctx, agent)).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'Subagent cleanup for worker-t1 is unconfirmed; operator investigation is required' })],
  })
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('reports unconfirmed work even when the catalog is empty', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => []))
  Reflect.set(subagents, 'interrupt', vi.fn())
  Reflect.set(subagents, 'waitForTreeWork', vi.fn(async () => true))
  await expect(stopSubagents(ctx, agent)).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'Subagent cleanup for worker-t1 is unconfirmed; operator investigation is required' })],
  })
  expect(agent.cancel).toHaveBeenCalled()
})

it('attempts to interrupt remaining rc.2 descendants after an interrupt fails', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const interrupt = vi.fn((id: string) => { if (id === 'child-1') throw new Error('interrupt failed') })
  const wait = vi.fn(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => [
    { kind: 'child', id: 'child-1' }, { kind: 'child', id: 'child-2' },
  ]))
  Reflect.set(subagents, 'interrupt', interrupt)
  Reflect.set(subagents, 'waitForTreeWork', wait)
  await expect(stopSubagents(ctx, agent)).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'interrupt failed' }), expect.any(SubagentCleanupUnconfirmed)],
  })
  expect(interrupt).toHaveBeenCalledTimes(2)
  expect(wait).toHaveBeenCalledWith(agent)
})

it('does not interrupt descendants after its stop lease is revoked during catalog lookup', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const catalog = Promise.withResolvers<{ kind: string; id: string }[]>()
  const interrupt = vi.fn()
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', () => catalog.promise)
  Reflect.set(subagents, 'interrupt', interrupt)
  Reflect.set(subagents, 'waitForTreeWork', vi.fn(async () => false))
  const lease = new AbortController()
  const stopping = stopSubagents(ctx, agent, false, lease.signal)
  lease.abort(new Error('stop lease revoked'))
  catalog.resolve([{ kind: 'child', id: 'child-1' }])
  await expect(stopping).rejects.toThrow('stop lease revoked')
  expect(interrupt).not.toHaveBeenCalled()
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('does not cancel the worker after its stop lease is revoked while waiting', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const tree = Promise.withResolvers<boolean>()
  const wait = vi.fn(() => tree.promise)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', async () => [{ kind: 'child', id: 'child-1' }])
  Reflect.set(subagents, 'interrupt', vi.fn())
  Reflect.set(subagents, 'waitForTreeWork', wait)
  const lease = new AbortController()
  const stopping = stopSubagents(ctx, agent, false, lease.signal)
  await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
  lease.abort(new Error('stop lease revoked'))
  tree.resolve(true)
  await expect(stopping).rejects.toThrow('stop lease revoked')
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('does not cancel a replacement worker after an asynchronous drain', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  const drain = Promise.withResolvers<void>()
  subagents.drainChildren.mockReturnValueOnce(drain.promise)
  const stopping = stopSubagents(ctx, agent)
  await Promise.resolve()
  Reflect.set(ctx.agents, 'get', () => undefined)
  drain.resolve()
  await expect(stopping).rejects.toThrow('Worker worker-t1 was replaced during subagent cleanup')
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('reports when waiting for an interrupted rc.2 tree times out', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => [{ kind: 'child', id: 'child-1' }]))
  Reflect.set(subagents, 'interrupt', vi.fn())
  Reflect.set(subagents, 'waitForTreeWork', vi.fn(() => new Promise(() => {})))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = stopSubagents(ctx, agent)
    const rejected = expect(stopping).rejects.toMatchObject({
      message: 'Stopping subagent tree of worker-t1 failed',
      errors: [expect.objectContaining({ message: 'Waiting for subagent tree of worker-t1 timed out' }), expect.any(SubagentCleanupUnconfirmed)],
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  } finally { vi.useRealTimers() }
})

it('reports when the rc.2 worker does not become idle after cancellation', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  Reflect.deleteProperty(subagents, 'listChildren')
  Reflect.deleteProperty(subagents, 'drainChildren')
  Reflect.set(subagents, 'listDescendants', vi.fn(async () => [{ kind: 'child', id: 'child-1' }]))
  Reflect.set(subagents, 'interrupt', vi.fn())
  Reflect.set(subagents, 'waitForTreeWork', vi.fn(async () => true))
  Reflect.set(agent, 'whenIdle', () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = stopSubagents(ctx, agent)
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Waiting for worker-t1 to become idle timed out' }), expect.any(SubagentCleanupUnconfirmed)],
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
  } finally { vi.useRealTimers() }
})

it('reports an rc.1 release timeout and cancels the turn the release may have woken', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = stopSubagents(ctx, agent)
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Releasing subagents of worker-t1 timed out' })],
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('collects jobs started before the worker becomes idle', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const idle = Promise.withResolvers<void>()
  Reflect.set(agent, 'whenIdle', () => idle.promise)
  const stopping = stopBackground(ctx, agent.id, 'stop')
  const job = jobs.run(agent.id)
  idle.resolve()
  await stopping
  expect(jobs.service.kill).toHaveBeenCalledWith(job, agent.id, expect.any(String))
})

it('does not stop a replacement worker after waiting for jobs', async () => {
  const { ctx, agent, jobs, subagents } = setup(async () => false)
  const job = jobs.run(agent.id)
  jobs.service.kill.mockImplementation(() => 'requested')
  const stopping = stopBackground(ctx, agent.id, 'stop')
  await vi.waitFor(() => expect(jobs.service.kill).toHaveBeenCalledWith(job, agent.id, expect.any(String)))
  const replacement = { ...agent, cancel: vi.fn() }
  Reflect.set(ctx.agents, 'get', () => replacement)
  jobs.end(job)
  await expect(stopping).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'Worker worker-t1 was replaced during background cleanup' })],
  })
  expect(replacement.cancel).not.toHaveBeenCalled()
  expect(subagents.drainChildren).not.toHaveBeenCalled()
})

it('reports a worker that remains active even when there are no subagents', async () => {
  const { ctx, agent } = setup(async () => false)
  Reflect.set(ctx, 'get', () => undefined)
  Reflect.set(agent, 'whenIdle', () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = stopBackground(ctx, agent.id, 'stop')
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Waiting for worker-t1 to become idle timed out' })],
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
  } finally { vi.useRealTimers() }
})

it('passes rc.1 external catalog entries without local agents to the release operation', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  Reflect.set(subagents, 'listChildren', async () => [{ id: 'external-child', mode: 'external' }])
  Reflect.set(ctx.agents, 'get', (id: string) => id === agent.id ? agent : undefined)
  await stopSubagents(ctx, agent)
  expect(subagents.drainChildren).toHaveBeenCalledWith(agent, ['external-child'])
})
