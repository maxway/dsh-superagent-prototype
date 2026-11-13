import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { stopSubagents, untilQuiet } from '../../../src/executor/background.ts'

async function fixture() {
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
  runtime.registerProvider({
    name: 'mock', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start(request) {
      const id = `child-${++count}`
      const completion = Promise.withResolvers()
      request.signal.addEventListener('abort', () => aborted.push(id), { once: true })
      return { id, result: completion.promise, async dispose() { completion.resolve({ output: [], stopReason: 'aborted' }) } }
    },
  })
  const start = () => runtime.startActivation({ provider: 'mock', parent: root, prompt: [], label: 'test', delivery: 'parent', signal: new AbortController().signal })
  return { ctx, root, runtime, start, aborted, fiber }
}

test('rc2 waits for external child, interrupts it, and keeps root reusable', { timeout: 5000 }, async () => {
  assert.equal(createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version, '0.2.2-rc.2')
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
