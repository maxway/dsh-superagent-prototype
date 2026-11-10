import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel, workerModel } from '../src/app/role-models.ts'
import type { Ticket } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const selections = () => session.snapshotEvents().flatMap(event => event.type === 'model/selection' ? [event.data as ModelSelection] : [])
  const model = { current: () => selections().at(-1), select: (selection: ModelSelection) => { session.append('model/selection', selection) } }
  const agent = { ctx, session, model } as unknown as Agent
  return { ctx, agent, resolve, flush, selections }
}
it('seeds the role model as the durable selection and keeps the prompt variables in step', async () => {
  const { ctx, agent, flush, selections } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'high' })
  expect(selections()).toEqual([{ provider: 'worker-provider', model: 'worker-model', reasoningEffort: ReasoningEffortId('high') }])
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  expect(flush).toHaveBeenCalledOnce()
})
it('lets a later explicit selection win', async () => {
  const { ctx, agent } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'manual', model: 'two' })
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve, selections } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(selections()).toEqual(kind === 'selection' ? [existing] : [])
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, selections } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  expect((await ctx.systemPrompt.assemble()).variables).not.toHaveProperty('provider')
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(selections()).toEqual([])
})
it('uses tier models independently of category while retaining legacy fallback', () => {
  const settings = SettingsSchema.parse({ executor: { model: { provider: 'p', model: 'default' },
    models: { query: { provider: 'p', model: 'legacy' } }, tierModels: { low: { provider: 'p', model: 'luna' }, high: { provider: 'p', model: 'terra' } } } })
  const ticket = (category: Ticket['category'], tier?: Ticket['tier']) => ({ category, tier, mandate: { strength: 'explicit' as const } as Ticket['mandate'] })
  expect(workerModel(settings, ticket('development', 'low'))?.model).toBe('luna')
  expect(workerModel(settings, ticket('research', 'high'))?.model).toBe('terra')
  expect(workerModel(settings, ticket('query', 'high'))?.model).toBe('terra')
  expect(workerModel(settings, ticket('query'))?.model).toBe('legacy')
  settings.executor.tierModels.low = null
  expect(workerModel(settings, ticket('query', 'low'))?.model).toBe('legacy')
})
it('selects a worker model by Ticket category, falling back to the executor default', () => {
  const settings = SettingsSchema.parse({ executor: { model: { provider: 'p', model: 'default' },
    models: { query: { provider: 'p', model: 'luna' }, research: null, development: { provider: 'p', model: 'terra' } } } })
  const ticket = (category: Ticket['category'], strength: Ticket['mandate']['strength'] = 'explicit') =>
    ({ category, mandate: { strength } as Ticket['mandate'] })
  expect(workerModel(settings, ticket('query'))).toEqual({ provider: 'p', model: 'luna' })
  expect(workerModel(settings, ticket('research'))).toEqual({ provider: 'p', model: 'default' })
  expect(workerModel(settings, ticket('development'))).toEqual({ provider: 'p', model: 'terra' })
  // A Ticket accepted before categories keeps its old model behavior: reply questions read as query, the rest development.
  expect(workerModel(settings, ticket(undefined, 'reply'))).toEqual({ provider: 'p', model: 'luna' })
  expect(workerModel(settings, ticket(undefined))).toEqual({ provider: 'p', model: 'terra' })
})