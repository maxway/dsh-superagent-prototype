import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'
import { gitlabKind, pollRound, type GitlabConfig } from '../src/sources/gitlab.ts'
import { branchPipelineTrigger, gitlabChannel, gitlabThread, issueTrigger, mergeRequestTrigger, noteTrigger, type GitlabIssue, type GitlabMergeRequest,
  type GitlabNote } from '../src/sources/gitlab-trigger.ts'
import { claimMergeRequest, mergeRequestEndNotices, observeMergeRequest } from '../src/sources/gitlab-pull.ts'
import { changeOf } from '../src/sources/git-change.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabThreadContext, readGitlab, readGitlabRepositoryPath } from '../src/sources/gitlab-read.ts'
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
      keys: family => [...state.keys()].filter(name => name.startsWith(typeof family === 'string' ? family : family.prefix)) },
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
    const noteValue = noteTrigger(note({ discussion_id: 'disc-1', position: { new_path: 'src/app.css', new_line: 12 } }), { kind: 'issue', iid: 5, url: 'https://gitlab.com/acme/widgets/-/issues/5' }, 'agent-bot')
    expect(noteValue).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'gitlab:issue:5' }], addressed: 'mention',
      channel: { source: 'gitlab', thread: 'gitlab:issue:5' }, meta: { kind: 'issue', iid: 5, noteId: 11, discussionId: 'disc-1', path: 'src/app.css', line: 12 } })
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
    expect(gitlabKind.find!('#5')).toEqual({ threads: ['gitlab:issue:5'], terms: [] })
    expect(gitlabKind.find!('please check #5, thanks')).toEqual({ threads: ['gitlab:issue:5'], terms: [] })
    expect(gitlabKind.find!('see !7')).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
    expect(gitlabKind.find!('https://gitlab.example.com/group/sub/repo/-/merge_requests/7')).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
  })
it('points a branch pipeline trigger at its URL, not an unreadable resource', () => {
    const trigger = branchPipelineTrigger('https://gitlab.com', 'acme/widgets', 'main', 'abc', 0, 'failed', 'https://gitlab.com/acme/widgets/-/pipelines/3')
    expect(trigger.text).toContain('https://gitlab.com/acme/widgets/-/pipelines/3')
    expect(trigger.text).not.toContain('gitlab/commits/')
  })
  it('prefers the ticket\'s own change request, and the newest among equals', () => {
    expect(changeOf({ follows: [{ thread: 'gitlab:mr:7', own: false }, { thread: 'gitlab:mr:8', own: true }, { thread: 'gitlab:mr:9', own: true }] }))
      .toEqual({ provider: 'gitlab', number: 9 })
    expect(changeOf({ follows: [{ thread: 'github:2', own: false }, { thread: 'github:1', own: true }] })).toEqual({ provider: 'github', number: 1 })
    expect(changeOf({ follows: [] })).toBeUndefined()
  })
it('restricts GitLab API paths to the configured project', async () => {
    const h = context()
    vi.spyOn(h.commands, 'run').mockResolvedValue('{}')
    await expect(h.commands.glabApi(z.unknown(), 'projects/99/issues')).rejects.toThrow('restricted to the configured project')
    await expect(h.commands.glabApi(z.unknown(), 'projects/42/issues/%2e%2e/99')).rejects.toThrow('restricted to the configured project')
    await expect(h.commands.glabApi(z.unknown(), 'projects/42/..%2f99/issues')).rejects.toThrow('restricted to the configured project')
    await expect(h.commands.glabApi(z.unknown(), 'projects/42/%2e./99/issues')).rejects.toThrow('restricted to the configured project')
    await expect(h.commands.glabApi(z.unknown(), 'projects/42/%2e%2f99/issues')).rejects.toThrow('restricted to the configured project')
    await expect(h.commands.glabApi(z.unknown(), 'projects/42/issues')).resolves.toEqual({})
  })
it('reads a merge request description, its notes, a discussion and its head pipeline', async () => {
    const h = context()
    glab(h.commands, {
      'projects/42/issues/5': issue(),
      'projects/42/issues/5/notes': [note()],
      'projects/42/merge_requests/7': mr({ head_pipeline: { id: 9, status: 'failed', web_url: 'https://gitlab.com/p/9' } }),
      'projects/42/pipelines/9': { id: 9, status: 'failed', web_url: 'https://gitlab.com/p/9', sha: 'abc' },
      'projects/42/merge_requests/7/discussions/disc-1': { id: 'disc-1', notes: [note({ discussion_id: 'disc-1' })] },
    })
    expect(await readGitlab(h.commands, 'gitlab/issues/5')).toMatchObject({ number: 5, title: 'Fix the margin', state: 'opened', id: 'issue-5', text: 'Please fix the margin. @agent-bot' })
    expect(await readGitlab(h.commands, 'gitlab/issues/5/comments/1')).toMatchObject({ messages: [{ id: '11', from: 'alice' }] })
    await expect(readGitlab(h.commands, 'gitlab/issues/5/comments/0')).rejects.toThrow('positive page number')
    await expect(readGitlab(h.commands, 'gitlab/issues/5/comments/abc')).rejects.toThrow('positive page number')
    expect(await readGitlab(h.commands, 'gitlab/mrs/7/discussions/disc-1')).toMatchObject({ messages: [{ id: '11' }] })
    expect(await readGitlab(h.commands, 'gitlab/mrs/7/checks')).toMatchObject({ pipeline: { id: 9, status: 'failed' } })
  })
  it('reads a subscribed Thread with its description first and its notes after it', async () => {
    const h = context()
    glab(h.commands, { 'projects/42/issues/5': issue(), 'projects/42/issues/5/notes': [note()] })
    const page = await gitlabThreadContext.read(h.commands, issueTrigger(issue(), 'agent-bot'), 'thread', undefined, undefined)
    expect(page.messages[0]).toMatchObject({ id: 'issue-5', text: 'Fix the margin\n\nPlease fix the margin. @agent-bot' })
    expect(page.messages[1]).toMatchObject({ id: '11', from: 'alice' })
  })
  it('reads repository files and directories under the default branch, and rejects hidden paths', async () => {
    const h = context()
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      if (args[1]!.includes('/repository/files/')) return 'export const x = 1'
      return JSON.stringify([{ name: 'b', type: 'blob' }, { name: 'a', type: 'tree' }, { name: '.env', type: 'blob' }])
    })
    expect(await readGitlabRepositoryPath(h.commands, 'src/app.ts', 'file')).toBe('export const x = 1')
    expect(await readGitlabRepositoryPath(h.commands, '', 'directory')).toBe('a\nb')
    await expect(readGitlabRepositoryPath(h.commands, '', 'file')).rejects.toThrow('Name a file')
    await expect(readGitlabRepositoryPath(h.commands, '.secret', 'file')).rejects.toThrow('hidden')
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
  it('still reads human notes on an Issue or merge request the agent opened', async () => {
    const h = context()
    h.state.set(KV.gitlab.since, new Date(Date.now() - 3_600_000).toISOString())
    const review = note({ id: 21, body: 'Please adjust this.', author: { id: 2, username: 'alice' }, noteable_type: 'MergeRequest', noteable_iid: 7 })
    glab(h.commands, {
      'projects/42/issues': [issue({ author: { id: 9, username: 'agent-bot' }, description: 'Agent issue' })],
      'projects/42/issues/5/notes': [note({ body: 'A human follow-up' })],
      'projects/42/merge_requests': [mr({ author: { id: 9, username: 'agent-bot' }, source_branch: 'agent/gitlab-source' })],
      'projects/42/merge_requests/7/notes': [review],
      'projects/42/pipelines': [],
    })
    await pollRound(h.ctx)
    const received = (h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.map(([trigger]) => trigger as Trigger)
    expect(received.map(trigger => trigger.meta.noteId).sort()).toEqual([11, 21])
    expect(received.map(trigger => trigger.id)).not.toEqual(expect.arrayContaining([key('gitlab-issue', '5'), key('gitlab-mr', '7')]))
  })
  it('persists the first poll start when that round fails, so the same interval is retried', async () => {
    const h = context()
    glab(h.commands, { 'projects/42/issues': () => { throw new Error('network down') } })
    await expect(pollRound(h.ctx)).rejects.toThrow(/GitLab reads failed/)
    expect(h.state.get(KV.gitlab.since)).toBeTruthy()
  })
  it('does not advance a note cursor when the round stops mid-thread', async () => {
    const controller = new AbortController()
    const h = context({ receive: vi.fn(async () => { controller.abort(); return 'stored' as const }) })
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const old = new Date(Date.now() - 3_600_000).toISOString()
    h.state.set(KV.gitlab.since, old)
    h.state.set(KV.gitlab.cursor('issue', 5), old)
    glab(h.commands, {
      'projects/42/issues': [issue({ created_at: old, updated_at: now() })],
      'projects/42/issues/5/notes': [note({ id: 11 }), note({ id: 12, body: 'Second note' })],
      'projects/42/merge_requests': [], 'projects/42/pipelines': [],
    })
    await pollRound(h.ctx, controller.signal)
    expect(h.state.get(KV.gitlab.cursor('issue', 5))).toBe(old)
    expect((h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
  it('clears observed pipelines while CI observation is off, so turning it on baselines afresh', async () => {
    const h = context()
    h.state.set(KV.gitlab.ci('branch', 0), { status: 'failed', revision: 2, id: 9 })
    glab(h.commands, { 'projects/42/issues': [], 'projects/42/merge_requests': [], 'projects/42/pipelines': [] })
    await pollRound(h.ctx)
    expect(h.state.get(KV.gitlab.ci('branch', 0))).toBeUndefined()
  })
  it('reports a retried head pipeline even when its status repeats', async () => {
    const h = context({ config: (() => config({ observeCi: true })) as SourceContext['config'] })
    h.state.set(KV.gitlab.since, new Date(Date.now() - 3_600_000).toISOString())
    let current = mr({ author: { id: 9, username: 'agent-bot' }, head_pipeline: { id: 1, status: 'failed', web_url: 'https://gitlab.com/p/1' } })
    glab(h.commands, {
      'projects/42/issues': [],
      'projects/42/merge_requests': () => [current],
      'projects/42/merge_requests/7/notes': [],
      'projects/42/pipelines': [],
    })
    await pollRound(h.ctx)
    expect((h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.some(([trigger]) => (trigger as Trigger).meta.ci === true)).toBe(false)
    current = mr({ author: { id: 9, username: 'agent-bot' }, updated_at: now(), head_pipeline: { id: 2, status: 'failed', web_url: 'https://gitlab.com/p/2' } })
    await pollRound(h.ctx)
    const triggers = (h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.map(([trigger]) => trigger as Trigger)
    expect(triggers.some(trigger => trigger.meta.ci === true && trigger.meta.revision === 1)).toBe(true)
  })
  it('fetches a merge request detail when the list omits its head pipeline', async () => {
    const h = context({ config: (() => config({ observeCi: true })) as SourceContext['config'] })
    h.state.set(KV.gitlab.since, new Date(Date.now() - 3_600_000).toISOString())
    let detail = mr({ head_pipeline: { id: 1, status: 'pending', web_url: 'https://gitlab.com/p/1' } })
    glab(h.commands, {
      'projects/42/issues': [],
      'projects/42/merge_requests': [mr({ head_pipeline: null, updated_at: now() })],
      'projects/42/merge_requests/7': () => detail,
      'projects/42/merge_requests/7/notes': [],
      'projects/42/pipelines': [],
    })
    await pollRound(h.ctx)
    expect((h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.some(([trigger]) => (trigger as Trigger).meta.ci === true)).toBe(false)
    detail = mr({ head_pipeline: { id: 2, status: 'pending', web_url: 'https://gitlab.com/p/2' } })
    await pollRound(h.ctx)
    const triggers = (h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.map(([trigger]) => trigger as Trigger)
    expect(triggers.some(trigger => trigger.meta.ci === true && trigger.meta.revision === 1)).toBe(true)
  })
  it('reads a subscribed merge request\'s new notes even when the project scan has no update', async () => {
    const h = context()
    const followed = { key: 'gitlab:mr:7', ref: { source: 'gitlab', id: 'mr:7' }, subscriptions: ['t1'], createdAt: now(), lastAt: now(),
      meta: { url: 'https://gitlab.com/acme/widgets/-/merge_requests/7', author: 'alice' }, pending: [], decisions: [] } as unknown as Thread
    h.ctx.threads.subscribed = () => [followed]
    h.state.set(KV.gitlab.since, new Date(Date.now() - 3_600_000).toISOString())
    h.state.set(KV.gitlab.cursor('mr', 7), new Date(Date.now() - 3_600_000).toISOString())
    const reply = note({ id: 31, body: 'One more look?', author: { id: 2, username: 'alice' }, noteable_type: 'MergeRequest', noteable_iid: 7 })
    glab(h.commands, {
      'projects/42/issues': [], 'projects/42/merge_requests': [], 'projects/42/pipelines': [],
      'projects/42/merge_requests/7': mr(), 'projects/42/merge_requests/7/notes': [reply],
    })
    await pollRound(h.ctx)
    expect((h.ctx.receive as ReturnType<typeof vi.fn>).mock.calls.map(([trigger]) => (trigger as Trigger).meta.noteId)).toContain(31)
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
  it('retries a note target that reports 404 instead of dropping the message', async () => {
    const h = context()
    vi.spyOn(h.commands, 'run').mockRejectedValue(new CliError('404 Not Found', 404))
    await expect(sendGitlab(h.ctx, { id: 'reply-1', kind: 'reply' as const, channel: gitlabChannel('issue', 5), text: 'Done' })).rejects.toThrow('404')
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