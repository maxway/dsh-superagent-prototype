/** GitLab merge request binding, lifecycle observation, and terminal IM notification helpers. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { ticketBranch } from './github-pull.ts'
import { pipelineFact } from './gitlab-read.ts'
import { gitlabPage, gitlabThread, MergeRequestSchema, SOURCE, type GitlabMergeRequest } from './gitlab-trigger.ts'

export type MergeRequest = GitlabMergeRequest
export async function readMergeRequest(ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<MergeRequest> {
  const project = ctx.deployment.gitlab
  if (!project) throw new Error('The GitLab Source has no working project')
  return ctx.commands.withSignal(signal).glabApi(MergeRequestSchema, `projects/${project.projectId}/merge_requests/${iid}`)
}
const mrNumber = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:mr:`) ? Number(thread.slice(`${SOURCE}:mr:`.length)) : undefined
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** True when the MR was opened by the agent account from a branch in the configured project (not a fork). */
export const agentMergeRequest = (mr: Pick<MergeRequest, 'author' | 'source_project_id'>, deployment: Pick<Deployment, 'git' | 'gitlab'>): boolean =>
  sameName(mr.author.username, deployment.git.login) && (!deployment.gitlab || !mr.source_project_id || mr.source_project_id === deployment.gitlab.projectId)
const CI_FACT = (status: string | undefined): ThreadFact | undefined => status ? pipelineFact(status) : undefined

/**
 * Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR on the
 * ticket's branch, enforcing that one MR binds to at most one open ticket.
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.kind === 'mr' && source.meta.iid === mr.iid
  const opened = agentMergeRequest(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    return `Merge request does not belong to this ticket: use the source MR or an MR by ${ctx.deployment.git.login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'Merge request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === gitlabThread('mr', mr.iid))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles an MR's state and pipeline fact with any bound or branch-matching ticket.
 * An open agent MR auto-binds to the single open ticket on its branch unless that ticket already follows another open MR.
 * @returns whether the MR has ended.
 */
export async function observeMergeRequest(ctx: SourceContext, mr: MergeRequest): Promise<boolean> {
  const ended = mr.state === 'closed' || mr.state === 'merged' || !!mr.merged_at
  if (ended) closeMergeRequest(ctx, mr)
  else {
    const candidates = agentMergeRequest(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0] : undefined
    const reopened = ticket?.follows?.some(item => item.thread === gitlabThread('mr', mr.iid) && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(number => number === mr.iid))) claimMergeRequest(ctx, ticket.id, mr)
  }
  ctx.threads.describe(gitlabThread('mr', mr.iid), { facts: { ci: CI_FACT(mr.head_pipeline?.status ?? undefined) ?? null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `mr:${mr.iid}` }, own)
    ctx.threads.patch(gitlabThread('mr', mr.iid), { iid: mr.iid, kind: 'mr', url: mr.web_url, author: mr.author.username })
  })
}
/** Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides. */
function closeMergeRequest(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `mr:${mr.iid}` }, mr.state === 'merged' || mr.merged_at ? 'merged' : 'closed', at)
}
/** Builds idempotent notices for IM conversations when a ticket ends with its MR. */
export function mergeRequestEndNotices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow || !deployment.gitlab) return []
  const iid = mrNumber(follow.thread)!
  const url = gitlabPage(deployment.gitlab.host, deployment.repository, 'mr', iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  // GitLab timelines already show the merge, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}