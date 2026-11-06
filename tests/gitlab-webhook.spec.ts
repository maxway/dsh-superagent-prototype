import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError, Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { reconcileWebhook, removeWebhook, startWebhookListener, tokenMatches, webhookPath, WebhookWaker } from '../src/sources/gitlab-webhook.ts'
import { gitlabKind, watchGitlab, type GitlabConfig, type WebhookRuntime } from '../src/sources/gitlab.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

const deployment = testGitlabDeployment()
function commands() { return new Commands(() => deployment, {}, new AbortController().signal) }
function state() {
  const records = new Map<string, unknown>()
  const value = {
    get: <V>(key: string) => records.get(key) as V | undefined,
    set: <V>(key: string, next: V | undefined) => { if (next === undefined) records.delete(key); else records.set(key, next) },
  }
  return { records, value }
}
afterEach(() => { vi.restoreAllMocks() })

describe('gitlab webhook listener', () => {
  it('accepts only POST with the configured token on the configured path', async () => {
    const events: string[] = []
    const listener = await startWebhookListener({ host: '127.0.0.1', port: 0, path: '/gitlab/webhook', secret: 's3cret',
      onEvent: () => events.push('event') })
    const url = `http://127.0.0.1:${listener.port}/gitlab/webhook`
    const post = (init: RequestInit = {}) => fetch(url, { method: 'POST', ...init })
    try {
      expect((await post({ headers: { 'x-gitlab-token': 's3cret' } })).status).toBe(200)
      expect(events).toHaveLength(1)
      expect((await post()).status).toBe(401)
      expect((await post({ headers: { 'x-gitlab-token': 'wrong' } })).status).toBe(401)
      expect((await fetch(`http://127.0.0.1:${listener.port}/other`, { method: 'POST',
        headers: { 'x-gitlab-token': 's3cret' } })).status).toBe(404)
      expect((await fetch(url)).status).toBe(405)
      expect(events).toHaveLength(1)
    } finally { await listener.close() }
  })
  it('derives the request path from the public URL', () => {
    expect(webhookPath('http://192.168.1.20:3084/gitlab/webhook')).toBe('/gitlab/webhook')
    expect(webhookPath('http://192.168.1.20:3084')).toBe('/')
  })
  it('reports a bind failure instead of leaving a partial listener', async () => {
    const first = await startWebhookListener({ host: '127.0.0.1', port: 0, path: '/hook', secret: 's', onEvent: () => {} })
    await expect(startWebhookListener({ host: '127.0.0.1', port: first.port, path: '/hook', secret: 's', onEvent: () => {} }))
      .rejects.toThrow(/could not listen/)
    await first.close()
  })
  it('compares tokens in constant time and rejects empty values', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abd')).toBe(false)
    expect(tokenMatches('abc', 'abcd')).toBe(false)
    expect(tokenMatches('abc', undefined)).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
  })
})

describe('gitlab webhook waker', () => {
  it('wakes a waiting loop, coalesces pending deliveries, and times out otherwise', async () => {
    const waker = new WebhookWaker(), controller = new AbortController()
    const waiting = waker.wait(60_000, controller.signal)
    waker.wake()
    await expect(waiting).resolves.toBe(true)
    // A delivery that arrives while no loop waits is consumed by the next wait.
    waker.wake()
    await expect(waker.wait(60_000, controller.signal)).resolves.toBe(true)
    await expect(waker.wait(10, controller.signal)).resolves.toBe(false)
  })
  it('stops waiting when the source aborts', async () => {
    const waker = new WebhookWaker(), controller = new AbortController()
    const waiting = waker.wait(60_000, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBe(false)
  })
})

describe('gitlab project hook management', () => {
  it('creates one project hook and stores its token when none exists', async () => {
    const h = state(), calls: string[][] = []
    const tool = commands()
    vi.spyOn(tool, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      return args.includes('POST') ? JSON.stringify({ id: 5 }) : '[]'
    })
    const record = await reconcileWebhook(tool, 'projects/42', 'http://192.168.1.20:3084/gitlab/webhook', 'token-1', h.value)
    expect(record).toEqual({ secret: 'token-1', url: 'http://192.168.1.20:3084/gitlab/webhook', hookId: 5 })
    expect(h.records.get(KV.gitlab.webhook)).toEqual(record)
    const create = calls.find(args => args.includes('POST'))!
    expect(create).toEqual(expect.arrayContaining(['projects/42/hooks', '--field', 'url=http://192.168.1.20:3084/gitlab/webhook',
      '--field', 'token=token-1', '--field', 'issues_events=true', '--field', 'merge_requests_events=true',
      '--field', 'note_events=true', '--field', 'pipeline_events=true', '--field', 'push_events=false']))
  })
  it('updates its stored hook, adopts one with the same URL, and deletes it when the URL is cleared', async () => {
    const h = state()
    h.records.set(KV.gitlab.webhook, { secret: 'old', url: 'http://old/webhook', hookId: 7 })
    const tool = commands(), calls: string[][] = []
    vi.spyOn(tool, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      if (args.includes('DELETE')) return ''
      if (args[1]!.includes('/hooks?')) return JSON.stringify([{ id: 7, url: 'http://old/webhook' }])
      return JSON.stringify({ id: 7 })
    })
    const record = await reconcileWebhook(tool, 'projects/42', 'http://new:3084/gitlab/webhook', 'new-token', h.value)
    expect(record).toMatchObject({ secret: 'new-token', url: 'http://new:3084/gitlab/webhook', hookId: 7 })
    expect(calls.find(args => args.includes('PUT'))).toEqual(expect.arrayContaining(['projects/42/hooks/7', '--method', 'PUT',
      '--field', 'url=http://new:3084/gitlab/webhook', '--field', 'token=new-token']))
    await removeWebhook(tool, 'projects/42', h.value)
    expect(calls.find(args => args.includes('DELETE'))).toEqual(expect.arrayContaining(['projects/42/hooks/7', '--method', 'DELETE']))
    expect(h.records.get(KV.gitlab.webhook)).toBeUndefined()
  })
  it('adopts a matching hook after the stored id is gone, and forgets a hook GitLab already deleted', async () => {
    const h = state()
    h.records.set(KV.gitlab.webhook, { secret: 'old', url: 'http://old/webhook', hookId: 99 })
    const tool = commands(), calls: string[][] = []
    vi.spyOn(tool, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      if (args[1]!.includes('/hooks?')) return JSON.stringify([{ id: 7, url: 'http://new:3084/gitlab/webhook' }])
      return JSON.stringify({ id: 7 })
    })
    expect(await reconcileWebhook(tool, 'projects/42', 'http://new:3084/gitlab/webhook', 's', h.value)).toMatchObject({ hookId: 7 })
    expect(calls.some(args => args.includes('POST'))).toBe(false)
    h.records.set(KV.gitlab.webhook, { secret: 's', url: 'http://new:3084/gitlab/webhook', hookId: 7 })
    const missing = commands()
    vi.spyOn(missing, 'run').mockRejectedValue(new CliError('404 Not Found', 404))
    await removeWebhook(missing, 'projects/42', h.value)
    expect(h.records.get(KV.gitlab.webhook)).toBeUndefined()
  })
  it('explains that the agent account needs Maintainer to manage project hooks', async () => {
    const h = state()
    const tool = commands()
    vi.spyOn(tool, 'run').mockRejectedValue(new CliError('403 Forbidden', 403))
    await expect(reconcileWebhook(tool, 'projects/42', 'http://host/hook', 's', h.value))
      .rejects.toThrow(/needs the Maintainer role/)
    expect(h.records.get(KV.gitlab.webhook)).toBeUndefined()
  })
  it('does not parse an empty DELETE response as JSON', async () => {
    const h = state()
    h.records.set(KV.gitlab.webhook, { secret: 's', url: 'http://host/hook', hookId: 7 })
    const tool = commands()
    const run = vi.spyOn(tool, 'run').mockResolvedValue('')
    await removeWebhook(tool, 'projects/42', h.value)
    expect(run).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['--method', 'DELETE']))
    expect(h.records.get(KV.gitlab.webhook)).toBeUndefined()
  })
})

describe('gitlab webhook settings', () => {
  const base = { host: 'https://gitlab.com', repository: 'acme/widgets', cli: '/bin/glab', configDir: '/config/glab-agent' }
  it('defaults the optional webhook off and fills its listener defaults', () => {
    expect(gitlabKind.schema.parse(base)).toMatchObject({ webhookUrl: '', webhookPort: 3084, webhookBind: '0.0.0.0' })
  })
  it('accepts an http or https URL and refuses another scheme', () => {
    expect(gitlabKind.schema.parse({ ...base, webhookUrl: 'http://192.168.1.20:3084/gitlab/webhook' }))
      .toMatchObject({ webhookUrl: 'http://192.168.1.20:3084/gitlab/webhook' })
    expect(gitlabKind.schema.parse({ ...base, webhookUrl: 'https://agent.example.com/gitlab/webhook' }))
      .toMatchObject({ webhookUrl: 'https://agent.example.com/gitlab/webhook' })
    expect(() => gitlabKind.schema.parse({ ...base, webhookUrl: 'ftp://agent.example.com/hook' })).toThrow()
    expect(() => gitlabKind.schema.parse({ ...base, webhookUrl: 'not a url' })).toThrow()
  })
})

describe('gitlab webhook polling', () => {
  const config = (overrides: Partial<GitlabConfig> = {}): GitlabConfig => ({
    host: 'https://gitlab.com', repository: 'acme/widgets', cli: '/bin/glab', configDir: '/config/glab-agent',
    pollSeconds: 60, failuresBeforeError: 3, observeIssues: false, observeMrs: false, observeComments: false, observeCi: false,
    webhookUrl: 'http://192.168.1.20:3084/gitlab/webhook', webhookPort: 3084, webhookBind: '0.0.0.0', ...overrides })
  function context(configValue: GitlabConfig) {
    const reports: Health[] = []
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(Commands.prototype, 'run').mockResolvedValue('[]')
    const value: SourceContext = {
      deployment, commands, ready: Promise.resolve(), configured: () => true, config: (() => configValue) as SourceContext['config'],
      receive: vi.fn(() => 'stored' as const), atomic: work => work(),
      state: { get: () => undefined, set: () => {}, keys: () => [] },
      threads: { get: () => undefined, subscribed: () => [], describe: vi.fn(), patch: vi.fn() },
      tickets: { get: () => undefined, open: () => [], bindThread: vi.fn(), threadClosed: vi.fn() },
      triggers: { get: () => undefined, latest: () => undefined }, notify: vi.fn(),
      report: (_entry, healthValue) => reports.push(healthValue),
    }
    return { ctx: value, reports }
  }
  it('opens the webhook, runs a round on a delivery, and closes the listener on abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = context(config())
      const waker = new WebhookWaker(), close = vi.fn(async () => {})
      const runtime: WebhookRuntime = { url: h.ctx.config<GitlabConfig>('gitlab')!.webhookUrl, port: 3084, bind: '0.0.0.0',
        waker, events: () => 4, close }
      const controller = new AbortController()
      const running = watchGitlab(h.ctx, controller.signal, async () => runtime)
      await vi.waitFor(() => expect(h.reports.filter(report => report.detail?.includes('webhook on (4 events)')).length)
        .toBeGreaterThanOrEqual(1))
      const before = h.reports.length
      waker.wake()
      await vi.advanceTimersByTimeAsync(1500)
      await vi.waitFor(() => expect(h.reports.length).toBeGreaterThan(before))
      controller.abort()
      await running
      expect(close).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})