/** Provider-neutral change request (GitHub pull request or GitLab merge request) helpers for the application glue. */
import type { OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import { claimPull, pullEndNotices, readPull, type Pull } from './github-pull.ts'
import { claimMergeRequest, mergeRequestEndNotices, readMergeRequest, type MergeRequest } from './gitlab-pull.ts'

export interface ChangeRef { provider: 'github' | 'gitlab'; number: number }
/** The change request a ticket follows, preferring its own thread and then the newest; `undefined` when it follows none. */
export function changeOf(ticket: Pick<Ticket, 'follows'>): ChangeRef | undefined {
  // Newest first, then the ticket's own change requests before context-only ones.
  const follows = [...(ticket.follows ?? [])].reverse().sort((a, b) => Number(!!b.own) - Number(!!a.own))
  for (const follow of follows) {
    const github = /^github:(\d+)$/.exec(follow.thread)
    if (github) return { provider: 'github', number: Number(github[1]) }
    const gitlab = /^gitlab:mr:(\d+)$/.exec(follow.thread)
    if (gitlab) return { provider: 'gitlab', number: Number(gitlab[1]) }
  }
  return undefined
}
export const changeNumber = (ticket: Pick<Ticket, 'follows'>): number | undefined => changeOf(ticket)?.number
/** Reads the ticket's change request from the active provider. */
export function readChange(ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull | MergeRequest> {
  return ctx.deployment.git.provider === 'gitlab' ? readMergeRequest(ctx, number, signal) : readPull(ctx, number, signal)
}
/** Claims the ticket's change request on the active provider. */
export function claimChange(ctx: SourceContext, ticketId: string, change: Pull | MergeRequest): string | undefined {
  return ctx.deployment.git.provider === 'gitlab' ? claimMergeRequest(ctx, ticketId, change as MergeRequest) : claimPull(ctx, ticketId, change as Pull)
}
/** Builds the terminal IM notices for a ticket that ended with its change request. */
export function changeEndNotices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] {
  return deployment.git.provider === 'gitlab' ? mergeRequestEndNotices(ticket, request, deployment) : pullEndNotices(ticket, request, deployment.repository)
}