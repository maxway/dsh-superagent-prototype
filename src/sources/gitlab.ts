/** GitLab source kind definition, project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { sameName } from '../infra/text.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import type { Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { health, sourceContext, type Health } from './host.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { gitlabThreadContext, pipelineFact } from './gitlab-read.ts'
import { observeMergeRequest } from './gitlab-pull.ts'
import { branchPipelineTrigger, gitlabThread, issueTrigger, mentions, mergeRequestPipelineTrigger, MergeRequestSchema,
  mergeRequestTrigger, noteTrigger, NoteSchema, SOURCE, type GitlabKind, type GitlabMergeRequest, IssueSchema } from './gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { z } from 'zod'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMrs: z.boolean().default(false),
  observeComments: z.boolean().default(false), observeCi: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mrs: 'observeMrs', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return 'ci'
  if (meta.noteId !== undefined) return 'comments'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mrs'
  return undefined
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目中发给它的 Issue、合并请求、评论与 CI 状态变化，并用 note 回复。', en: 'The agent\'s GitLab account; receives Issues, merge requests, comments and pipeline changes addressed to it in the project, and replies with notes.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', label: { zh: 'GitLab 地址', en: 'GitLab URL' },
      hint: { zh: '例如 https://gitlab.com，或自建实例的地址。保存时检查账号能否推送到项目，然后重启 dsh-superagent。', en: 'For example https://gitlab.com, or a self-managed instance URL. Saving checks that the account can push to the project, then restarts dsh-superagent.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project，可含多级 group。这个来源接收这个项目的 Issue、合并请求和评论。', en: 'Written group/project, with nested groups allowed. This Source receives the project\'s Issues, merge requests and comments.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用独立配置登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查该账号能否推送到项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through its own configuration. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks that this account can push to the project, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收 CI 变化', en: 'Receive CI changes' },
      hint: { zh: '打开后，合并请求和默认分支的流水线状态变化会收到，由策略的接收表决定是否成为候选。', en: 'Pipeline status changes on merge requests and the default branch are received, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const issue = /(?:https?:\/\/[^/\s]+(?:\/[^/\s]+)+\/-\/issues\/(\d+)|(?:^|\s)#(\d+)(?=$|\s|[.,;:!?)]))/m.exec(query)
    const mr = /(?:https?:\/\/[^/\s]+(?:\/[^/\s]+)+\/-\/merge_requests\/(\d+)|(?:^|\s)!(\d+)(?=$|\s|[.,;:!?)]))/m.exec(query)
    return { threads: [...issue ? [`${SOURCE}:issue:${issue[1] ?? issue[2]}`] : [], ...mr ? [`${SOURCE}:mr:${mr[1] ?? mr[2]}`] : []], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mrs', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'ci', label: { zh: 'CI', en: 'CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源的 GitLab 地址，clone 与链接都用它', en: 'The GitLab URL of this Source, used for clones and links' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/project', en: 'The project this Source watches, as group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录', en: 'The agent\'s GitLab account; glab is signed in to it' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或合并请求编号；工单不是从 GitLab 来的时为空', en: 'Number of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<编号>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<number>/head of the merge request that started the ticket; empty when it was not a merge request' } },
    ],
    values: ({ deployment, trigger }) => {
      const active = deployment.git.provider === 'gitlab' && !!deployment.gitlab
      const from = trigger?.threads[0]?.source === SOURCE
      const number = from ? Number(trigger.meta.iid) || 0 : 0
      const kind = from ? trigger.meta.kind : undefined
      return { DSH_SUPERAGENT_GITLAB_HOST: active ? deployment.gitlab!.host : '', DSH_SUPERAGENT_GITLAB_PROJECT: active ? deployment.repository : '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: active ? deployment.git.login : '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: active ? deployment.git.commitEmail : '',
        DSH_SUPERAGENT_GITLAB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: number && kind === 'mr' ? `refs/merge-requests/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment && deployment.git.provider === 'gitlab' && deployment.gitlab ? {
    cli: { zh: `当前账号 @${deployment.git.login}`, en: `Current account @${deployment.git.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  // A deployment has one active Git host; this kind stays dormant when GitHub is the active one.
  if (ctx.deployment.git.provider !== 'gitlab') { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined; failures: string[]; read: Set<string>
  issues: number; mrs: number; notes: number; tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, failures: [], read: new Set(),
  issues: 0, mrs: 0, notes: 0, tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/** The numeric project API prefix and the canonical default branch of the active GitLab project. */
function projectOf(ctx: SourceContext): { path: string; projectId: number; defaultBranch: string } {
  const project = ctx.deployment.gitlab
  if (!project) throw new Error('The GitLab Source has no working project')
  return { path: `projects/${project.projectId}`, projectId: project.projectId, defaultBranch: project.defaultBranch }
}
function notesPath(project: string, kind: GitlabKind, iid: number): string {
  return `${project}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
}
function nameThread(ctx: SourceContext, kind: GitlabKind, iid: number, title: string, url: string): void {
  const thread = gitlabThread(kind, iid)
  ctx.threads.patch(thread, { iid, kind, url, ...(title ? { title } : {}) })
  ctx.threads.describe(thread, { label: `${kind === 'mr' ? '!' : '#'}${iid} ${title}`, ...(url ? { url } : {}) })
}
/**
 * One polling round: issues and merge requests updated since the project cursor, then subscribed Threads not read in this
 * round. Each stream fails independently so all streams run before the round fails.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return 60
  const { path, defaultBranch } = projectOf(ctx)
  // Persist the start of the first poll before reading, so a failed first round retries the same interval instead of losing it.
  let since = ctx.state.get(KV.gitlab.since)
  if (since === undefined) { since = round.started; ctx.state.set(KV.gitlab.since, since) }
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const sinceAt = new Date(Math.max(Date.parse(since), horizon)).toISOString()
  try { await pollIssues(ctx, round, config, path, sinceAt) } catch (error) { if (!stopped(ctx, round)) round.failures.push(`issues: ${String(error)}`) }
  try { await pollMergeRequests(ctx, round, config, path, sinceAt) } catch (error) { if (!stopped(ctx, round)) round.failures.push(`merge requests: ${String(error)}`) }
  try { await pollDefaultBranchCi(ctx, round, config, path, defaultBranch) } catch (error) { if (!stopped(ctx, round)) round.failures.push(`CI: ${String(error)}`) }
  await pollThreads(ctx, round)
  if (stopped(ctx, round)) return 60
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.atomic(() => ctx.state.set(KV.gitlab.since, cursorAt(round.started)))
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('gitlab', { state: 'ready', detail: `${round.issues} issues, ${round.mrs} merge requests, ${round.notes} notes; next poll ≥ ${config.pollSeconds}s${skipped}`, at: round.started })
  return 60
}
async function pollIssues(ctx: SourceContext, round: Round, config: GitlabConfig, project: string, since: string): Promise<void> {
  const login = ctx.deployment.git.login
  const issues = await ctx.commands.withSignal(round.signal).glabPages(IssueSchema,
    `${project}/issues?updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&scope=all&state=all`, round.tally)
  for (const issue of issues) {
    if (stopped(ctx, round)) return
    // The Agent's own Issue body is not a request from someone else, but its notes still carry other people's follow-ups.
    const fresh = Date.parse(issue.created_at) >= Date.parse(since)
    if (!sameName(issue.author.username, login) && fresh && (config.observeIssues || mentions(issue.description ?? '', login))) {
      await ctx.receive(issueTrigger(issue, login))
      round.issues += 1
    }
    nameThread(ctx, 'issue', issue.iid, issue.title, issue.web_url)
    await intakeNotes(ctx, round, config, project, 'issue', issue.iid, issue.web_url, issue.author.username, false)
    ctx.state.set(KV.gitlab.cursor('issue', issue.iid), cursorAt(round.started))
  }
}
async function pollMergeRequests(ctx: SourceContext, round: Round, config: GitlabConfig, project: string, since: string): Promise<void> {
  const login = ctx.deployment.git.login
  const mrs = await ctx.commands.withSignal(round.signal).glabPages(MergeRequestSchema,
    `${project}/merge_requests?updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&scope=all&state=all`, round.tally)
  for (const mr of mrs) {
    if (stopped(ctx, round)) return
    const fresh = Date.parse(mr.created_at) >= Date.parse(since)
    if (!sameName(mr.author.username, login) && fresh && (config.observeMrs || mentions(mr.description ?? '', login))) {
      await ctx.receive(mergeRequestTrigger(mr, login))
      round.mrs += 1
    }
    nameThread(ctx, 'mr', mr.iid, mr.title, mr.web_url)
    const ended = await observeMergeRequest(ctx, mr)
    round.read.add(`mr:${mr.iid}:change`)
    if (!ended) await intakeNotes(ctx, round, config, project, 'mr', mr.iid, mr.web_url, mr.author.username, false)
    if (config.observeCi) await intakeMergeRequestCi(ctx, round, mr)
    ctx.state.set(KV.gitlab.cursor('mr', mr.iid), cursorAt(round.started))
  }
}
async function intakeNotes(ctx: SourceContext, round: Round, config: GitlabConfig, project: string, kind: GitlabKind, iid: number,
  url: string, author: string, force: boolean): Promise<void> {
  const readKey = `${kind}:${iid}:notes`
  if (round.read.has(readKey)) return
  round.read.add(readKey)
  const login = ctx.deployment.git.login
  const cursor = ctx.state.get(KV.gitlab.cursor(kind, iid)) ?? ctx.state.get(KV.gitlab.since) ?? round.started
  const notes = await ctx.commands.withSignal(round.signal).glabPages(NoteSchema, `${notesPath(project, kind, iid)}?sort=asc&order_by=created_at`, round.tally)
  for (const note of notes) {
    if (stopped(ctx, round)) return
    if (note.system || sameName(note.author.username, login)) continue
    if (Date.parse(note.updated_at ?? note.created_at) < Date.parse(cursor)) continue
    if (!force && !config.observeComments && !mentions(note.body ?? '', login)) continue
    const trigger = noteTrigger(note, { kind, iid, url, author }, login)
    if (!trigger.text) continue
    await ctx.receive(trigger)
    round.notes += 1
  }
}
async function intakeMergeRequestCi(ctx: SourceContext, round: Round, mr: GitlabMergeRequest): Promise<void> {
  const status = mr.head_pipeline?.status
  if (!status) return
  const id = mr.head_pipeline?.id ?? undefined
  const previous = ctx.state.get(KV.gitlab.ci('mr', mr.iid))
  const revision = previous ? previous.revision + 1 : 0
  // A retried pipeline can keep its status; the new pipeline id is still a change worth reporting.
  if (previous && (previous.status !== status || previous.id !== id)) {
    await ctx.receive(mergeRequestPipelineTrigger(mr, revision, status, mr.head_pipeline?.web_url ?? mr.web_url))
  }
  ctx.state.set(KV.gitlab.ci('mr', mr.iid), { status, revision, ...(id === undefined ? {} : { id }) })
  ctx.threads.describe(gitlabThread('mr', mr.iid), { facts: { ci: pipelineFact(status) } })
}
async function pollDefaultBranchCi(ctx: SourceContext, round: Round, config: GitlabConfig, project: string, branch: string): Promise<void> {
  if (!config.observeCi) {
    // Forget the observed pipeline so switching CI back on baselines afresh instead of reporting the gap.
    const seen = ctx.state.get(KV.gitlab.ci('branch', 0))
    if (seen) ctx.state.set(KV.gitlab.ci('branch', 0), { revision: seen.revision })
    return
  }
  const pipelines = await ctx.commands.withSignal(round.signal).glabApi(z.array(z.looseObject({ id: z.number(), status: z.string(),
    sha: z.string(), web_url: z.string().nullish() })), `${project}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`)
  const latest = pipelines[0]
  if (!latest) return
  const previous = ctx.state.get(KV.gitlab.ci('branch', 0))
  const revision = previous ? previous.revision + 1 : 0
  if (previous && (previous.status !== latest.status || previous.id !== latest.id)) {
    await ctx.receive(branchPipelineTrigger(ctx.deployment.gitlab?.host ?? `https://${ctx.deployment.git.host}`, ctx.deployment.repository,
      branch, latest.sha, revision, latest.status, latest.web_url ?? ''))
  }
  ctx.state.set(KV.gitlab.ci('branch', 0), { status: latest.status, revision, id: latest.id })
  ctx.threads.describe(`gitlab:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: pipelineFact(latest.status) } })
}
async function pollThreads(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  const project = projectOf(ctx).path
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    const ref = thread.ref
    if (ref.id.startsWith('ci:')) return
    const kind: GitlabKind = ref.id.startsWith('mr:') ? 'mr' : 'issue'
    const iid = Number(ref.id.slice(ref.id.indexOf(':') + 1))
    if (!iid) return
    if (kind === 'mr' && !round.read.has(`mr:${iid}:change`)) {
      round.read.add(`mr:${iid}:change`)
      const mr = await ctx.commands.withSignal(round.signal).glabApi(MergeRequestSchema, `${project}/merge_requests/${iid}`)
      await observeMergeRequest(ctx, mr)
    }
    await intakeNotes(ctx, round, config, project, kind, iid, String(thread.meta.url ?? ''), String(thread.meta.author ?? ''), true)
    ctx.state.set(KV.gitlab.cursor(kind, iid), cursorAt(round.started))
  }, thread => {
    if (thread.ref.id.startsWith('ci:')) return true
    const kind = thread.ref.id.startsWith('mr:') ? 'mr' : 'issue'
    const iid = Number(thread.ref.id.slice(thread.ref.id.indexOf(':') + 1))
    return round.read.has(`${kind}:${iid}:notes`)
  })
}