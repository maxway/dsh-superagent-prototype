import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type Ticket, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'
import { gitlabKind, pollRound, type GitlabConfig } from '../src/sources/gitlab.ts'
import { gitlabChannel, gitlabThread, issueTrigger, mergeRequestTrigger, noteTrigger, type GitlabIssue, type GitlabMergeRequest,
  type GitlabNote } from '../src/sources/gitlab-trigger.ts'
import { claimMergeRequest, mergeRequestEndNotices, observeMergeRequest } from '../src/sources/gitlab-pull.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import type { SourceContext } from '../src/sources/host.ts'

const deployment = testGitlabDeployment()
const now = (): string => new Date().toISOString()
const issue = (overrides: Partial<GitlabIssue> = {}): GitlabIssue => ({
  iid: 5, title: 'Fix the margin', description: 'Please fix the margin. @agent-bot', state: 'opened', created_at: now(), updated_at: now(),
  web_url: 'https://gitlab.com/acme/widgets/-/issues/5', author: { id: 2, username: 'alice' }, ...overrides })
const mr = (overrides: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest => ({
  iid: 7, title: 'Fix the margin', description: 'The margin is fixed.', state: 'opened', created_at: now(), updated_at: now(),
  web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/7', author: { id: 2, username: 'alice' }, source_branch: 'fix-margin',
  target_branch: 'main', sha: 'abc', source_project_id: 42, ...overrides })
const note = (overrides: Partial<GitlabNote> = {}): GitlabNote => ({
  id: 11, body: 'Can you also check the padding? @agent-bot', author: { id: 2, username: 'alice' }, created_at: now(), updated_at: now(),
  system: false, noteable_type: 'Issue', noteable_iid: 5, ...overrides })
const config = (overrides: Partial<GitlabConfig> = {}): GitlabConfig => ({
  host: 'https://gitlab.com', repository: 'acme/widgets', cli: '/bin/glab', pollSeconds: 60, failuresBeforeError: 3,
  observeIssues: true, observeMrs: true, observeComments: true, observeCi: false, ...overrides })

function context(overrides: Partial<SourceContext> = {}) {
  const state = new Map<string, unknown>()
  const threads = new Map<string, unknown>()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const value: SourceContext = {
    deployment, commands, ready: Promise.resolve(), configured: () => true, config: (() => config()) as SourceContext['config'],
    receive: vi.fn(() => 'stored' as const), atomic: work => work(),
    state: { get: name => state.get(name) as never, set: (name, next) => { if (next === undefined) state.delete(name); else state.set(name, next) },
      keys: () => [] },
    threads: { get: name => threads.get(name) as never, subscribed: () => [], describe: vi.fn(), patch: vi.fn() },
    tickets: { get: () => undefined, open: () => [], bindThread: vi.fn(), threadClosed: vi.fn() },
    triggers: { get: () => undefined, latest: () => undefined }, notify: vi.fn(), report: vi.fn(), ...overrides,
  }
  return { ctx: value, state, threads, commands }
}
/** Stubs `glab api` calls by their path, ignoring query strings; a route may be a function for a changing response. */
function glab(commands: Commands, routes: Record<string, unknown>) {
  const reads: string[] = []
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const path = args[1]!
    reads.push(path)
    const base = path.split('?')[0]!
    const route = routes[base] ?? (base.includes('/notes') ? [] : base.endsWith('/issues') || base.endsWith('/merge_requests') ? [] : [])
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    return JSON.stringify(value)
  })
  return reads
}

afterEach(() => { vi.restoreAllMocks() })

describe('gitlab triggers', () => {
  it('translates an issue, a merge request and a note into threaded triggers, marking mentions and bots', () => {
    const issueValue = issueTrigger(issue(), 'agent-bot')
    expect(issueValue).toMatchObject({ id: key('gitlab-issue', '5'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'gitlab:issue:5' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, addressed: 'mention', url: 'https://gitlab.com/acme/widgets/-/issues/5',
      channel: { source: 'gitlab', thread: 'gitlab:issue:5', address: { kind: 'issue', iid: '5' } },
      meta: { kind: 'issue', iid: 5, author: 'alice' } })
    const mrValue = mergeRequestTrigger(mr(), 'agent-bot')
    expect(mrValue).toMatchObject({ id: key('gitlab-mr', '7'), meta: { kind: 'mr', iid: 7, sourceBranch: 'fix-margin' },
      channel: { source: 'gitlab', thread: 'gitlab:mr:7' } })
    const noteValue = noteTrigger(note({ position: { new_path: 'src/app.css', new_line: 12 } }), { kind: 'issue', iid: 5, url: 'https://gitlab.com/acme/widgets/-/issues/5' }, 'agent-bot')
    expect(noteValue).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'gitlab:issue:5' }], addressed: 'mention',
      channel: { source: 'gitlab', thread: 'gitlab:issue:5' }, meta: { kind: 'issue', iid: 5, noteId: 11, path: 'src/app.css', line: 12 } })
    expect(noteValue.text).toContain('src/app.css:12')
    // A bot's note is not human, and the agent's own note is not a trigger at all.
    expect(noteTrigger(note({ author: { id: 3, username: 'ci-bot', bot: true } }), { kind: 'issue', iid: 5 }, 'agent-bot').human).toBe(false)
  })
  it('scopes issues, merge requests, comments and CI by configuration, and offers the matching admission rows', () => {
    const policyConfig = config({ observeIssues: true, observeMrs: false, observeComments: true, observeCi: false })
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, policyConfig)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'mr' } }, policyConfig)).toEqual({ listened: true, observed: false, row: 'mrs' })
    expect(gitlabKind.scope!({ meta: { kind: 'mr', noteId: 1 } }, policyConfig)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(gitlabKind.scope!({ meta: { ci: true } }, policyConfig)).toEqual({ listened: true, observed: false, row: 'ci' })
    expect(gitlabKind.policy!.rows!(policyConfig as unknown as Record<string, unknown>)).toMatchObject([{ id: 'issues', cells: { listedUnaddressed: true } },
      { id: 'mrs', cells: { listedUnaddressed: false } }, { id: 'comments', cells: { listedUnaddressed: true } }, { id: 'ci', cells: { unlistedUnaddressed: false } }])
  })
})

describe('gitlab polling', () => {
  it('reads issues, merge requests and their notes, receives each trigger, and advances its cursors', async () => {
    const h = context()
    h.state.set(KV.gitlab.since, new Date(Date.now() - 3_600_000).toISOString())
    h.state.set(KV.gitlab.cursor('issue', 5), new Date(Date.now() - 3_600_000).toISOString())
    const noteValue = note()
    glab(h.commands, {
      'projects/42/issues': [issue()],
      'projects/42/issues/5/notes': [noteValue],
      'projects/42/merge_requests': [mr()],
      'projects/42/merge_requests/7/notes': [],
      'projects/42/pipelines': [],
    })
    await pollRound(h.ctx)
    const received = (h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.map(([trigger]) => trigger as Trigger)
    expect(received.map(trigger => trigger.id)).toEqual(expect.arrayContaining([key('gitlab-issue', '5'), key('gitlab-mr', '7'),
      key('gitlab-note', 'issue', '5', '11', noteValue.updated_at!)]))
    expect(h.state.get(KV.gitlab.since)).toBeTruthy()
    expect(h.ctx.report).toHaveBeenCalledWith('gitlab', expect.objectContaining({ state: 'ready' }))
  })
  it('does not receive the agent\'s own notes, system notes or unaddressed comments when comments are not observed', async () => {
    const h = context({ config: (() => config({ observeIssues: false, observeMrs: false, observeComments: false })) as SourceContext['config'] })
    glab(h.commands, {
      'projects/42/issues': [issue({ description: 'No mention' })],
      'projects/42/issues/5/notes': [note({ body: 'A note', author: { id: 9, username: 'agent-bot' } }), note({ id: 12, body: 'A system note', system: true }),
        note({ id: 13, body: 'An unaddressed note' })],
      'projects/42/merge_requests': [], 'projects/42/pipelines': [],
    })
    await pollRound(h.ctx)
    expect(h.ctx.receive).not.toHaveBeenCalled()
  })
})

describe('gitlab channel and merge requests', () => {
  it('posts a note with an idempotency marker, and skips a note that already holds it', async () => {
    const h = context()
    const message = { id: 'reply-1', kind: 'reply' as const, channel: gitlabChannel('issue', 5), text: 'Done' }
    let posted = 0
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      if (args.includes('POST')) { posted += 1; return '{}' }
      return JSON.stringify([{ id: 1, body: `<!-- dsh-superagent:reply-1 -->\nDone`, author: { username: 'agent-bot' } }])
    })
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(posted).toBe(0)
    vi.restoreAllMocks()
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      if (args.includes('POST')) { posted += 1; return '{}' }
      return '[]'
    })
    expect(await sendGitlab(h.ctx, message)).toBe('sent')
    expect(posted).toBe(1)
  })
  it('claims an agent merge request on the ticket branch and ends a ticket when the merge request closes', async () => {
    const ticket = { id: 't1', title: 'Fix', follows: [], channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      execution: { name: 'fix-margin', directory: '/w/fix-margin', assignment: '' },
      origin: { triggerId: key('gitlab-mr', '7'), triggerIds: [] }, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
        actor: { source: 'gitlab', id: 'alice' }, scope: '' }, decisionId: 'd', open: true } as unknown as Ticket
    const h = context({
      tickets: { get: id => id === 't1' ? ticket : undefined, open: () => [ticket], bindThread: vi.fn(), threadClosed: vi.fn() },
      triggers: { get: () => ({ source: 'gitlab', meta: { kind: 'mr', iid: 7 } }) as unknown as Trigger, latest: () => undefined },
    })
    const pull = mr({ author: { id: 9, username: 'agent-bot' }, source_branch: 'agent/fix-margin' })
    expect(claimMergeRequest(h.ctx, 't1', pull)).toBeUndefined()
    expect(h.ctx.tickets.bindThread).toHaveBeenCalledWith('t1', { source: 'gitlab', id: 'mr:7' }, true)
    ticket.follows = [{ thread: 'gitlab:mr:7', own: true }]
    const merged = mr({ author: { id: 9, username: 'agent-bot' }, state: 'merged', merged_at: now(), source_branch: 'agent/fix-margin' })
    await observeMergeRequest(h.ctx, merged)
    expect(h.ctx.tickets.threadClosed).toHaveBeenCalledWith({ source: 'gitlab', id: 'mr:7' }, 'merged', expect.any(String))
    ticket.follows = [{ thread: 'gitlab:mr:7', own: true, closed: { at: now(), outcome: 'merged' } }]
    ticket.channels = [{ source: 'feishu', thread: 'feishu:oc:om', address: { chatId: 'oc', messageId: 'om' } }]
    ticket.ended = { at: now(), by: 'executor', outcome: 'merged' }
    expect(mergeRequestEndNotices(ticket, '修一下', deployment)).toMatchObject([{ channel: { source: 'feishu' }, text: expect.stringContaining('已合并') }])
  })
})