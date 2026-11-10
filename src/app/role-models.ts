/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { ticketCategory, type Ticket } from '../core/index.ts'
import type { RoleModel, Settings } from '../policy.ts'

/** A tier model takes precedence; older tickets and unset tiers retain category-model fallback. */
export function workerModel(settings: Settings, ticket: Pick<Ticket, 'category' | 'mandate' | 'tier'>): RoleModel | null {
  return (ticket.tier ? settings.executor.tierModels[ticket.tier] : null) ?? settings.executor.models[ticketCategory(ticket)] ?? settings.executor.model
}

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/**
 * Seed a role's configured model onto a brand-new session before its first step, leaving later manual or durable selections intact.
 * DSH 0.2.2 fixes a step's model before prompt assembly and ignores route changes made by `agent/request`, so the supported
 * selection point is `agent.model.select()`; it records the durable selection the loop reads without changing the global DSH
 * default. The assembly hook keeps the `{{provider}}` and `{{model}}` prompt variables in step with the live selection.
 */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model)
  agent.model.select(selected)
  agent.ctx.effect(() => agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const current = agent.model.current()
    const assembled = await next()
    return current === undefined ? assembled : { ...assembled, variables: { ...assembled.variables, provider: current.provider, model: current.model } }
  }, { prepend: true }))
  await ctx.sessionPersistence.flush()
}
