/** GitLab project webhook: auto-registration, a token-verified event listener, and event coalescing for the polling loop. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { CliError, type Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

/** The project hook this Source manages; `hookId` is absent until the first successful registration. */
export interface WebhookRecord { secret: string; url: string; hookId?: number; host?: string; project?: string }
/** The subset of a GitLab project hook this module reads when reconciling its own hook. */
const HookSchema = z.looseObject({ id: z.number(), url: z.string() })
const CreatedSchema = z.looseObject({ id: z.number() })

/**
 * Compares the webhook token in constant time; an empty or missing header never matches.
 * GitLab sends the configured secret token in `X-Gitlab-Token`.
 */
export function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (!expected || !actual) return false
  const left = Buffer.from(expected), right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** The request path GitLab must use for a configured public URL; a URL without a path listens at `/`. */
export function webhookPath(url: string): string {
  return new URL(url).pathname || '/'
}

/**
 * Coalesces GitLab deliveries for the polling loop: `wake()` marks an event pending and releases a waiting loop,
 * and `wait()` returns early (or immediately when an event is already pending) so a burst of deliveries causes one
 * near-immediate poll instead of one poll per delivery.
 */
export class WebhookWaker {
  private pending = false
  private release: (() => void) | undefined
  /** Records that GitLab delivered an event and releases a waiting loop. */
  wake(): void {
    this.pending = true
    const release = this.release
    this.release = undefined
    release?.()
  }
  /** Waits `ms` for a delivery; returns true when woken, false on timeout or abort. A pending wake is consumed. */
  wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (this.pending) { this.pending = false; return Promise.resolve(true) }
    return new Promise(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (woken: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.release = undefined
        resolve(woken)
      }
      const onAbort = () => finish(false)
      this.release = () => { this.pending = false; finish(true) }
      timer = setTimeout(() => finish(false), ms)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }
}

export interface WebhookListener { port: number; close(): Promise<void> }

/**
 * Starts the inbound listener for GitLab project events. Only POST requests on the configured path with the correct
 * token are accepted; the payload is not parsed, because the polling round reads the authoritative API after a wake.
 * Binding happens before registration, so a port conflict fails without creating a hook that cannot be reached.
 */
export async function startWebhookListener(options: { host: string; port: number; path: string; secret: string;
  onEvent: () => void }): Promise<WebhookListener> {
  const server = createServer((req, res) => {
    // Drain the body even for a rejected request, so a slow or large payload cannot hold the connection open.
    req.resume()
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== options.path) { res.writeHead(404); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
    const header = req.headers['x-gitlab-token']
    if (!tokenMatches(options.secret, Array.isArray(header) ? header[0] : header)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ message: 'invalid webhook token' }))
      return
    }
    // The payload is not needed; acknowledge GitLab promptly after the listener saw the event.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{"ok":true}')
    options.onEvent()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', listening); reject(error) }
      const listening = () => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', listening)
      server.listen(options.port, options.host)
    })
  } catch (error) {
    server.close()
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`the GitLab webhook listener could not listen on ${options.host}:${options.port}: ${detail}`)
  }
  const address = server.address() as AddressInfo | null
  return {
    port: address?.port ?? options.port,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}

/** Keeps the managed hook's secret across restarts; a fresh token is used when none was stored. */
export function webhookSecret(state: Pick<SourceContext['state'], 'get'>): string {
  return state.get(KV.gitlab.webhook)?.secret ?? randomBytes(32).toString('hex')
}

/** Maps a GitLab API refusal to an actionable message, because only Maintainers may manage project hooks. */
function actionable(error: unknown): Error {
  if (error instanceof CliError && (error.code === 403 || error.code === 401))
    return new Error(`the agent account cannot manage project webhooks (${error.message}); it needs the Maintainer role`)
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Creates, adopts or updates the project hook that delivers events to `url`, using the token the listener verifies.
 * A stored hook is updated only for its recorded host and project; a hook with the same URL is adopted otherwise, or a new hook is created.
 * The selected events mirror what the polling round reads; push events are not needed because the source never follows plain pushes.
 */
export async function reconcileWebhook(commands: Commands, project: string, url: string, secret: string,
  state: Pick<SourceContext['state'], 'get' | 'set'>): Promise<WebhookRecord> {
  const stored = state.get(KV.gitlab.webhook)
  const host = commands.deployment.gitlab?.host
  if (!host) throw new Error('The GitLab Source has no working host')
  const fields = ['--field', `url=${url}`, '--field', `token=${secret}`, '--field', 'issues_events=true',
    '--field', 'merge_requests_events=true', '--field', 'note_events=true', '--field', 'pipeline_events=true',
    '--field', 'push_events=false']
  try {
    const hooks = await commands.glabApi(z.array(HookSchema), `${project}/hooks?per_page=100`)
    let hookId = stored?.host === host && stored.project === project && stored.hookId !== undefined
      && hooks.some(hook => hook.id === stored.hookId) ? stored.hookId
      : hooks.find(hook => hook.url === url)?.id
    if (hookId === undefined) {
      const created = await commands.glabApi(CreatedSchema, `${project}/hooks`, '--method', 'POST', ...fields)
      hookId = created.id
    } else {
      await commands.glabApi(z.unknown(), `${project}/hooks/${hookId}`, '--method', 'PUT', ...fields)
    }
    const record: WebhookRecord = { secret, url, hookId, host, project }
    state.set(KV.gitlab.webhook, record)
    return record
  } catch (error) { throw actionable(error) }
}

/** Deletes the managed hook only for its recorded host and project; legacy or mismatched records are forgotten without deleting. */
export async function removeWebhook(commands: Commands, project: string, state: Pick<SourceContext['state'], 'get' | 'set'>): Promise<void> {
  const stored = state.get(KV.gitlab.webhook)
  if (!stored) return
  if (stored.host !== commands.deployment.gitlab?.host || !stored.host || stored.project !== project || stored.hookId === undefined) {
    state.set(KV.gitlab.webhook, undefined)
    return
  }
  try {
    await commands.glabApi(`${project}/hooks/${stored.hookId}`, '--method', 'DELETE')
  } catch (error) {
    if (!(error instanceof CliError && error.code === 404)) throw actionable(error)
  }
  state.set(KV.gitlab.webhook, undefined)
}