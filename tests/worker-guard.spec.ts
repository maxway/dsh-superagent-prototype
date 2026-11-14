import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolsService, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, vi } from 'vitest'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'

it('enforces the worker guard through the rc3 tool pipeline', async () => {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.reflect.provide('skills', { register: () => () => {} })
  new ToolsService(ctx)
  const ticket = { id: 'test' }
  const agents = new Map<string, Agent>()
  ctx.reflect.provide('agents', agents)
  const host = {
    context: ctx, masterId: 'main', lifetime: new AbortController().signal,
    store: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined } },
    prompts: { current: () => ({ revision: 1, config: { skills: {} } }), skills: () => [] },
    effects: { handle: () => {} }, health: { set: () => {} }, closing: () => false,
    tools: () => [],
  } as unknown as SessionsHost
  const sessions = new Sessions(host)
  sessions.install()
  const agent = { id: 'worker-test', status: 'idle', session: { snapshotEvents: () => [] } } as unknown as Agent
  const scope = createScope(ctx, agent, { parent: {} })
  Object.assign(agent, { ctx: scope.ctx })
  agents.set(agent.id, agent)
  const blocked = vi.fn(async () => 'spawned')
  const ordinary = vi.fn(async () => 'read')
  const definition = (name: string, execute: () => Promise<string>): ToolDefinition => ({
    name, description: name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute,
  })
  ctx.tools.register(definition('read', ordinary))
  agent.ctx.tools.register(definition('subagent', blocked))
  try {
    const pipeline = new ToolExecutionPipeline(ctx)
    const signal = new AbortController().signal
    const input = (name: string) => ({ name, arguments: {}, callId: 'call' as never, agent, signal })
    const preparedBeforeGuard = await pipeline.prepare(input('subagent'))
    expect(preparedBeforeGuard.kind).toBe('dispatch')
    await ctx.parallel('agent/created', { agent, source: 'startup' })
    expect(ctx.tools.get('subagent', agent)).toBeDefined()
    const denied = await pipeline.prepare(input('subagent'))
    expect(denied.kind).toBe('post-result')
    if (denied.kind !== 'post-result' || preparedBeforeGuard.kind !== 'dispatch') throw new Error('unexpected preparation')
    expect(await pipeline.complete(denied.exec, denied)).toMatchObject({ isError: true, error: { message: 'Subagent tools are disabled for managed workers' } })
    expect(blocked).not.toHaveBeenCalled()
    const allowed = await pipeline.prepare(input('read'))
    expect(allowed.kind).toBe('dispatch')
    if (allowed.kind !== 'dispatch') throw new Error('read was not dispatched')
    expect(await pipeline.complete(allowed.exec, await pipeline.dispatch(allowed.exec))).toMatchObject({ isError: false, value: 'read' })
    expect(ordinary).toHaveBeenCalledOnce()
    expect(await pipeline.complete(preparedBeforeGuard.exec, await pipeline.dispatch(preparedBeforeGuard.exec))).toMatchObject({ isError: false, value: 'spawned' })
    expect(blocked).toHaveBeenCalledOnce()
  } finally {
    sessions.dispose()
    await scope.dispose()
  }
})
