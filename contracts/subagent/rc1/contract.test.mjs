import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { stopSubagents, untilQuiet } from '../../../src/executor/background.ts'

test('rc1 real runtime waits for an external mock provider', { timeout: 5000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.1')
  const ctx = new Context()
  const root = { id: 'root', status: 'idle', session: { id: 'root', header: { id: 'root', origin: 'user' } } }
  const agents = { get: id => id === root.id ? root : undefined, list: () => [root] }
  for (const [name, service] of Object.entries({
    agents,
    workingDirectory: { ensure: async () => process.cwd() },
    sessionProjections: { register: async () => ({}) },
  })) ctx.reflect.provide(name, service)
  const fiber = await ctx.plugin(SubagentRuntime, { maxDepth: 2, maxActiveSubagents: 8 })
  const runtime = ctx.get('subagents')
  const completion = Promise.withResolvers()
  runtime.registerProvider({
    name: 'mock', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() { return { id: 'external', result: completion.promise, async dispose() {} } },
  })
  try {
    const activation = await runtime.startActivation({ provider: 'mock', request: { parent: root, prompt: [] }, delivery: 'caller', signal: new AbortController().signal })
    let settled = false
    const quiet = untilQuiet(ctx, root, new AbortController().signal).then(value => { settled = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    completion.resolve({ output: [], stopReason: 'completed' })
    await activation.result
    assert.equal(await quiet, true)
  } finally {
    completion.resolve({ output: [], stopReason: 'aborted' })
    await fiber.dispose()
  }
})

test('rc1 stop aborts and fully disposes a catalogued external child without a local agent', { timeout: 5000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.1')
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
  const calls = []
  const root = {
    id: 'root', session, status: 'idle', followup() {},
    cancel: (...args) => calls.push(['cancel', ...args]), whenIdle: async () => {},
  }
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
  const completion = Promise.withResolvers()
  const disposeStarted = Promise.withResolvers()
  const allowDispose = Promise.withResolvers()
  let aborted = false
  let disposed = false
  runtime.registerProvider({
    name: 'mock', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start(request) {
      request.signal.addEventListener('abort', () => {
        aborted = true
        completion.resolve({ output: [], stopReason: 'aborted' })
      }, { once: true })
      return { id: 'external', result: completion.promise, async dispose() {
        disposeStarted.resolve()
        await allowDispose.promise
        disposed = true
      } }
    },
  })
  try {
    const activation = await runtime.startActivation({ provider: 'mock', label: 'external test', request: { parent: root, prompt: [] }, delivery: 'parent', signal: new AbortController().signal })
    assert.equal(agents.get(activation.childId), undefined)
    assert.ok((await runtime.listChildren(root.id)).some(child => child.id === activation.childId && child.mode === 'external'))
    let settled = false
    const stopping = stopSubagents(ctx, root, true).then(() => { settled = true })
    await disposeStarted.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(aborted, true)
    assert.equal(disposed, false)
    assert.equal(settled, false)
    assert.deepEqual(calls, [])
    allowDispose.resolve()
    await stopping
    assert.equal(disposed, true)
    assert.equal((await activation.result).stopReason, 'aborted')
    assert.deepEqual(calls, [['cancel', { kind: 'user' }, { keepInbox: true }]])
  } finally {
    completion.resolve({ output: [], stopReason: 'aborted' })
    allowDispose.resolve()
    await fiber.dispose()
  }
})

test('rc1 stop uses listChildren and drainChildren for live local children', async () => {
  const calls = []
  const root = { id: 'root', status: 'idle', cancel: (...args) => calls.push(['cancel', ...args]), whenIdle: async () => {} }
  const services = {
    agents: { get: id => id === 'root' ? root : id === 'live' ? {} : undefined },
    subagents: {
      async listChildren(id) { calls.push(['listChildren', id]); return [{ id: 'live' }, { id: 'ended' }] },
      async drainChildren(agent, ids) { calls.push(['drainChildren', agent, ids]) },
      async drainDescendants() { throw new Error('must not drain root') },
    },
  }
  await stopSubagents({ get: name => services[name], agents: services.agents }, root, true)
  assert.deepEqual(calls, [
    ['listChildren', 'root'],
    ['drainChildren', root, ['live']],
    ['cancel', { kind: 'user' }, { keepInbox: true }],
  ])
})
