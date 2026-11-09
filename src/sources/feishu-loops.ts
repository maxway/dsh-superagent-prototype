/**
 * Feishu live event loop: consumes `im.message.receive_v1` and hands each bot-visible message to the Source.
 * The bot has no permission to read messages, chats or members by API, so there is no history recovery, no thread
 * polling and no chat-name refresh: everything the Source knows comes from the live event payload.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { threadKey, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import type { FeishuBot } from '../deployment.ts'
import { feishuTrigger } from './feishu-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { launch } from '../infra/launch.ts'
import type { FeishuConfig } from './feishu.ts'

export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> => watch(ctx, signal)
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>('feishu')
/**
 * Whether the Feishu Source is on, or `undefined` once its state store is closed. Shutdown closes the database before the
 * Source controller is aborted, so a timer or event callback that reads settings after that point stops the loop instead of
 * throwing out of an unhandled timer (which ended the process with `database is not open`).
 */
function sourceOn(ctx: SourceContext): boolean | undefined {
  try { return enabled(ctx) !== undefined } catch { return undefined }
}
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: chatId }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    const on = sourceOn(ctx)
    if (on === undefined) return
    if (!on) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => {
      // A closed store means shutdown has begun; abort so the loop can exit without reading it again.
      if (sourceOn(ctx) !== true) running.abort()
    }, 5000)
    // Clear the check as soon as the run is stopping, not only after `consume` has finished: its stop can wait five seconds
    // on Windows, which is long enough for the database to close underneath a later check.
    const stopCheck = () => clearInterval(check)
    running.signal.addEventListener('abort', stopCheck, { once: true })
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); running.signal.removeEventListener('abort', stopCheck); signal.removeEventListener('abort', stop) }
    if (sourceOn(ctx) === undefined) return
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const resolved = launch([bot(ctx).cli, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'])
  const child = spawn(resolved.program, resolved.args,
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  // Closing stdin asks the consumer to finish; Windows has no SIGTERM, so give that exit five seconds before terminating.
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    child.stdin.end()
    if (process.platform !== 'win32') { child.kill('SIGTERM'); return }
    if (child.exitCode !== null) return
    // The npm shim runs a Node launcher whose child is the real consumer, so end the whole tree if stdin close was not enough.
    const terminate = setTimeout(() => {
      if (child.pid === undefined) return
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    }, 5000)
    child.once('exit', () => clearTimeout(terminate))
  }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'Feishu event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      ctx.report('feishu', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report('feishu', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
      const trigger = feishuTrigger(JSON.parse(line), bot(ctx).botId, bot(ctx).appId)
      // Events already read when the Source is disabled are dropped; the consumer stops shortly after. A closed store means
      // shutdown, so the event is dropped too rather than read through an unusable Source.
      if (!trigger || sourceOn(ctx) !== true) return
      await receive(ctx, trigger)
    }).catch(error => { ctx.report('feishu', { state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}