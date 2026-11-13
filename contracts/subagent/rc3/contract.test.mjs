import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime, NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { stopSubagents, untilQuiet } from '../../../src/executor/background.ts'

async function fixture({ disposalError, beforePublication } = {}) {
  const ctx = new Context()
  const definitions = new Map()
  const states = new Map()
  const catalog = []
  const session = {
    id: 'root', header: { id: 'root', origin: 'user' },
    append(type, data) {
      const event = { type, data, seq: catalog.length }
      catalog.push(event)
      for (const [key, definition] of definitions) states.set(key, definition.apply(states.get(key), event))
    },
  }
  const root = { id: 'root', session, status: 'idle', cancel() {}, whenIdle: async () => {} }
  const agents = { get: id => id === root.id ? root : undefined, list: () => [root] }
  const services = {
    agents,
    sessions: { get: id => id === root.id ? session : undefined },
    workingDirectory: { ensure: async () => process.cwd() },
    sessionProjections: { register: async definition => {
      definitions.set(definition.key, definition)
      states.set(definition.key, definition.init(session.header, 0))
      return { stateOf: () => states.get(definition.key) }
    } },
    sessionQuery: { observeSession: async () => ({
      projections: { values: { subagentCatalog: definitions.get('subagentCatalog').wire.view(states.get('subagentCatalog')) } },
      [Symbol.dispose]() {},
    }) },
  }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const fiber = await ctx.plugin(SubagentRuntime, { maxDepth: 2, maxActiveSubagents: 8 })
  const runtime = ctx.get('subagents')
  let count = 0
  const aborted = []
  const completions = new Map()
  const disposed = []
  runtime.registerProvider({
    name: 'mock', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start(request) {
      const id = `child-${++count}`
      const completion = Promise.withResolvers()
      completions.set(id, completion)
      request.signal.addEventListener('abort', () => aborted.push(id), { once: true })
      await beforePublication?.()
      return { id, result: completion.promise, async dispose() {
        disposed.push(id)
        completion.resolve({ output: [], stopReason: 'aborted' })
        if (disposalError) throw disposalError
      } }
    },
  })
  const start = (delivery = 'parent') => runtime.startActivation({ provider: 'mock', parent: root, prompt: [], label: 'test', delivery, signal: new AbortController().signal })
  return { ctx, root, runtime, start, aborted, completions, disposed, fiber }
}

test('rc3 stop waits for uncatalogued caller-delivered work without interrupting it (unsafe observation, not a safety guarantee)', { timeout: 5000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.3')
  const { ctx, root, runtime, start, aborted, completions, disposed, fiber } = await fixture()
  let activation
  try {
    activation = await start('caller')
    assert.deepEqual(await runtime.listDescendants(root.id), [])
    let resultSettled = false
    let stopSettled = false
    const result = activation.result.then(value => { resultSettled = true; return value })
    const stopping = stopSubagents(ctx, root).then(() => { stopSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(resultSettled, false)
    assert.equal(stopSettled, false)
    assert.deepEqual(aborted, [])
    assert.deepEqual(disposed, [])
    completions.get(activation.childId).resolve({ output: [], stopReason: 'completed' })
    assert.equal((await result).stopReason, 'completed')
    await stopping
    assert.equal(stopSettled, true)
  } finally {
    if (activation) {
      completions.get(activation.childId).resolve({ output: [], stopReason: 'aborted' })
      await activation.dispose()
    }
    await fiber.dispose()
  }
})

test('rc3 tree wait observes an external start not yet published to the catalog', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers(), publish = Promise.withResolvers()
  const { ctx, root, runtime, start, completions, fiber } = await fixture({
    beforePublication: () => { entered.resolve(); return publish.promise },
  })
  let activation
  try {
    const starting = start()
    await entered.promise
    assert.deepEqual(await runtime.listDescendants(root.id), [])
    let stopped = false
    const stopping = stopSubagents(ctx, root).then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    publish.resolve()
    activation = await starting
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    completions.get(activation.childId).resolve({ output: [], stopReason: 'completed' })
    await activation.result
    await stopping
    assert.equal(stopped, true)
  } finally {
    publish.resolve()
    if (activation) {
      completions.get(activation.childId).resolve({ output: [], stopReason: 'aborted' })
      await activation.dispose()
    }
    await fiber.dispose()
  }
})

test('project rc3 stop hides external disposal failure (unsafe observation, not a safety guarantee)', { timeout: 5000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.3')
  const disposalError = new Error('provider disposal failed')
  const { ctx, root, runtime, start, aborted, disposed, fiber } = await fixture({ disposalError })
  try {
    const activation = await start()
    assert.ok((await runtime.listDescendants(root.id)).some(row => row.kind === 'child' && row.id === activation.childId))
    await stopSubagents(ctx, root)
    assert.deepEqual(aborted, [activation.childId])
    assert.deepEqual(disposed, [activation.childId])
    assert.equal((await activation.result).stopReason, 'aborted')
    await assert.rejects(activation.dispose(), error => error.cause === disposalError)
  } finally {
    await fiber.dispose()
  }
})

test('rc3 interrupt leaves a local child and its unclaimed inbox parked', { timeout: 10000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.3')
  const ctx = new Context()
  const entered = Promise.withResolvers()
  const fibers = []
  let root, activation
  ctx.reflect.provide('llm', {})
  ctx.reflect.provide('systemPrompt', { tools() {}, variable() {}, section() {}, context() {}, getSectionOrder: () => 0, getContextOrder: () => 0 })
  ctx.reflect.provide('workingDirectory', { ensure: async () => process.cwd(), set: async () => {} })
  ctx.reflect.provide('tools', { resolve: async ({ signal }) => {
    entered.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  } })
  try {
    for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, AgentLoop, SubagentRuntime]) {
      const config = plugin === AgentLoop ? { agents: [], maxParallelToolCalls: 1 }
        : plugin === SubagentRuntime ? { maxActiveSubagents: 8, maxDepth: 1 } : undefined
      const fiber = ctx.plugin(plugin, config)
      fibers.push(fiber)
      await fiber
    }
    root = await ctx.agents.create({ sessionId: 'local-contract-root', agentOptions: { provider: 'mock', model: 'mock' } })
    ctx.subagents.registerProvider({
      name: 'local-mock', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      async prepareContinuable() { return {} },
    })
    const signal = new AbortController().signal
    activation = await ctx.subagents.startActivation({
      provider: 'local-mock', parent: root.agent, prompt: [{ type: 'text', text: 'initial' }],
      label: 'local contract', delivery: 'caller', signal,
    })
    await entered.promise
    const child = ctx.agents.get(activation.childId)
    assert.ok(child)
    const messageId = await ctx.subagents.sendMessage(root.agent, child.id, [{ type: 'text', text: 'parked' }], { signal })
    assert.ok(child.inbox.nextStep.some(message => message.id === messageId))
    const controls = {
      listDescendants: async () => [{ kind: 'child', id: child.id }],
      interrupt: ctx.subagents.interrupt.bind(ctx.subagents),
      waitForTreeWork: ctx.subagents.waitForTreeWork.bind(ctx.subagents),
    }
    await stopSubagents({ get: name => name === 'subagents' ? controls : undefined, agents: ctx.agents }, root.agent, true)
    await child.whenIdle()
    assert.equal(child.status, 'idle')
    assert.equal(ctx.agents.get(child.id), child)
    assert.ok(child.inbox.nextStep.some(message => message.id === messageId))
    let settled = false
    void activation.result.then(() => { settled = true }, () => { settled = true })
    assert.equal(await ctx.subagents.waitForTreeWork(root.agent), false)
    assert.equal(settled, false)
    assert.ok(child.inbox.nextStep.some(message => message.id === messageId))
    assert.equal(ctx.agents.get(child.id), child)
  } finally {
    if (activation) await activation.dispose()
    if (root) await root.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})

test('rc3 waits for external child, interrupts it, and keeps root reusable', { timeout: 5000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.3')
  const { ctx, root, runtime, start, aborted, fiber } = await fixture()
  const interrupts = []
  const interrupt = runtime.interrupt.bind(runtime)
  runtime.interrupt = (id, authority) => { interrupts.push([id, authority]); return interrupt(id, authority) }
  runtime.drainDescendants = () => { throw new Error('must not drain root') }
  try {
    const first = await start()
    const rows = await runtime.listDescendants(root.id)
    assert.ok(rows.some(row => row.kind === 'child' && row.id === first.childId))
    let settled = false
    const quiet = untilQuiet(ctx, root, new AbortController().signal).then(value => { settled = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    await stopSubagents(ctx, root)
    assert.equal(await quiet, true)
    assert.deepEqual(aborted, [first.childId])
    assert.deepEqual(interrupts, [[first.childId, { kind: 'ancestor', agent: root }]])
    const second = await start()
    assert.notEqual(second.childId, first.childId)
    await stopSubagents(ctx, root)
    assert.deepEqual(aborted, [first.childId, second.childId])
  } finally {
    await fiber.dispose()
  }
})
