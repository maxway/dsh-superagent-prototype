import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'watchdog')
let server: ReturnType<typeof createServer> | undefined
let directory: string | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

/** One management API answer the fake server returns instead of the default snapshot. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    at: '2026-11-09T00:00:00.000Z', staleMinutes: 30, open: 1,
    tickets: [{ id: 't1', title: 'Fix the build', stage: 'working', silentMinutes: 40, signals: [], attempts: ['running'] }],
    state: { paused: false, load: { running: 0, queued: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } },
      setup: { problem: null, feishuProblem: null } },
    watchdog: { mode: 'observe', actions: ['retry'], staleMinutes: 30 },
    audit: [], lastRun: null, ...overrides,
  }
}

/** Start a fake management API that answers the snapshot, run and report routes and records each request. */
async function fakeService(answer: () => unknown) {
  const calls: { method?: string; url?: string; body?: string }[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url?.startsWith('/orchestrator/api/watchdog/runs')) {
        response.end(JSON.stringify({ id: 'watchdog-run-1', text: '**Watchdog 观察汇总**' }))
      } else if (request.url?.startsWith('/orchestrator/api/watchdog/wait')) {
        response.end(JSON.stringify({ at: '2026-11-09T00:00:00.000Z', version: 'version-2', changed: true, reason: 'change' }))
      } else if (request.url === '/orchestrator/api/watchdog/report') {
        response.end(JSON.stringify({ sent: true, chatId: 'oc_test', text: '**Watchdog 观察汇总**' }))
      } else {
        response.end(JSON.stringify(answer()))
      }
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return { calls, url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` }
}

/** Write a configuration beside a fresh state directory and run the process once. */
function configure(url: string, fields: Record<string, unknown> = {}) {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-process-'))
  const path = join(directory, 'watchdog.json')
  writeFileSync(path, JSON.stringify({ url, chatId: 'oc_test', report: true, intervalSeconds: 60, staleMinutes: 30, stateDir: 'state', ...fields }))
  return path
}

function run(args: string[], cwd?: string) {
  return new Promise<{ code: number, stdout: string, stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { cwd: cwd ?? directory, timeout: 20_000 },
      (error, stdout, stderr) => error && error.code !== 1 && error.code !== 2 ? reject(error) : resolve({ code: error?.code as number ?? 0, stdout, stderr }))
  })
}

it('validates configuration, finds mechanical problems and keeps finding identities stable', async () => {
  const module = await import(pathToFileURL(script).href) as {
    loadConfig: (path: string) => Record<string, unknown>
    collectFindings: (snapshot: unknown) => Record<string, unknown>[]
    gateFindings: (snapshot: unknown) => Record<string, unknown>[]
    fingerprint: (findings: Record<string, unknown>[]) => string
    localClock: (timeZone: string, now: Date) => { date: string, hour: number }
    dailyReportDue: (config: Record<string, unknown>, state: Record<string, unknown>, now?: Date) => boolean
    waitForChange: (config: Record<string, unknown>, since: string | undefined, timeoutSeconds: number, signal?: AbortSignal) =>
      Promise<{ version: string, changed: boolean, reason: string }>
  }
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-config-'))
  const path = join(directory, 'watchdog.json')
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', report: true, stateDir: 'state' }))
  expect(() => module.loadConfig(path)).toThrow(/chatId/)
  writeFileSync(path, JSON.stringify({ url: 'not a url', stateDir: 'state' }))
  expect(() => module.loadConfig(path)).toThrow(/url must be/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', unknown: 1 }))
  expect(() => module.loadConfig(path)).toThrow(/Unknown watchdog configuration field/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', intervalSeconds: 5 }))
  expect(() => module.loadConfig(path)).toThrow(/intervalSeconds/)
  // A daily report is only meaningful with Feishu reporting on, and its schedule must be a valid local hour and zone.
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', stateDir: 'state', dailyReport: { hour: 9 } }))
  expect(() => module.loadConfig(path)).toThrow(/dailyReport requires report true/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', report: true, chatId: 'oc_test', stateDir: 'state',
    dailyReport: { hour: 24 } }))
  expect(() => module.loadConfig(path)).toThrow(/dailyReport.hour/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', report: true, chatId: 'oc_test', stateDir: 'state',
    dailyReport: { hour: 9, timezone: 'Mars/Olympus' } }))
  expect(() => module.loadConfig(path)).toThrow(/IANA time zone/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', report: true, chatId: 'oc_test', stateDir: 'state',
    dailyReport: { hour: 9, timezone: 'Asia/Shanghai' } }))
  expect(module.loadConfig(path)).toMatchObject({ dailyReport: { hour: 9, timezone: 'Asia/Shanghai' } })
  const config = module.loadConfig((writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9/', stateDir: 'state' })), path))
  expect(config).toMatchObject({ url: 'http://127.0.0.1:9', intervalSeconds: 900, staleMinutes: 30, report: false })
  const morning = new Date('2026-11-09T01:30:00.000Z')
  expect(module.localClock('Asia/Shanghai', morning)).toEqual({ date: '2026-11-09', hour: 9 })
  expect(module.dailyReportDue({ report: true, dailyReport: { hour: 9, timezone: 'Asia/Shanghai' } }, {}, morning)).toBe(true)
  expect(module.dailyReportDue({ report: true, dailyReport: { hour: 10, timezone: 'Asia/Shanghai' } }, {}, morning)).toBe(false)
  expect(module.dailyReportDue({ report: true, dailyReport: { hour: 9, timezone: 'Asia/Shanghai' } },
    { quietReportDate: '2026-11-09' }, morning)).toBe(false)

  const findings = module.collectFindings(snapshot({ tickets: [
    { id: 't1', title: 'Stuck', signals: ['no-progress'] },
    { id: 't2', title: 'Waiting', signals: ['waiting-person'] },
  ], state: { paused: false, load: { running: 3, maxWorkers: 3 }, health: { runtime: { state: 'ready' }, gitlab: { state: 'error', detail: 'offline' } },
    setup: { problem: { code: 'agentCliUnset', place: 'gitlab' } } } }))
  // A full worker load explains no-progress, and setup plus an unhealthy part are findings on their own.
  expect(findings).toEqual([{ kind: 'ticket', id: 't2', title: 'Waiting', signals: ['waiting-person'] },
    { kind: 'health', part: 'gitlab', state: 'error', detail: 'offline' },
    { kind: 'setup', code: 'agentCliUnset', place: 'gitlab' }])
  expect(module.fingerprint(findings)).toBe(module.fingerprint(module.collectFindings(snapshot({ tickets: [
    { id: 't2', title: 'Waiting', silentMinutes: 90, signals: ['waiting-person'] },
  ], state: { paused: false, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' }, gitlab: { state: 'error', detail: 'offline' } },
    setup: { problem: { code: 'agentCliUnset', place: 'gitlab' } } } }))))
  // A paused service explains the Ticket signals it causes, but a delivery fault stays visible.
  expect(module.collectFindings(snapshot({ tickets: [{ id: 't1', title: 'Stuck', signals: ['no-progress'] }],
    state: { paused: true, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } }, setup: { problem: null } } }))).toEqual([])
  expect(module.collectFindings(snapshot({ tickets: [{ id: 't1', title: 'Stuck', signals: ['delivery-error'] }],
    state: { paused: true, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } }, setup: { problem: null } } })))
    .toEqual([{ kind: 'ticket', id: 't1', title: 'Stuck', signals: ['delivery-error'] }])
  // A part that is still starting is normal operation; only an error is a finding.
  expect(module.collectFindings(snapshot({ state: { paused: false, load: { running: 0, maxWorkers: 3 },
    health: { runtime: { state: 'ready' }, feishu: { state: 'starting', detail: '' } }, setup: { problem: null } } }))).toEqual([])
  // The gate adds the slow risks a signal threshold does not raise by itself.
  expect(module.gateFindings(snapshot({ tickets: [{ id: 'r1', title: 'Review', stage: 'ready', silentMinutes: 2000, signals: [] }],
    state: { paused: false, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } }, setup: { problem: null } } })))
    .toEqual([{ kind: 'ticket', id: 'r1', title: 'Review', signals: ['ready-unreviewed'] }])
  // A real snapshot represents a ready result as the person/review stage, not as a `ready` stage.
  expect(module.gateFindings(snapshot({ tickets: [{ id: 'r2', title: 'Review', stage: 'person', action: 'review', silentMinutes: 2000, signals: [] }],
    state: { paused: false, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } }, setup: { problem: null } } })))
    .toEqual([{ kind: 'ticket', id: 'r2', title: 'Review', signals: ['ready-unreviewed'] }])
  expect(module.gateFindings(snapshot({ tickets: [{ id: 'f1', title: 'Flaky', stage: 'working', silentMinutes: 5, signals: [],
    attempts: ['failed', 'failed', 'running'] }],
    state: { paused: false, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } }, setup: { problem: null } } })))
    .toEqual([{ kind: 'ticket', id: 'f1', title: 'Flaky', signals: ['repeated-failures'] }])
})

it('waits on one versioned request and returns the version to resume from', async () => {
  const service = await fakeService(() => snapshot())
  const config = configure(service.url)
  const module = await import(pathToFileURL(script).href) as {
    loadConfig: (path: string) => Record<string, unknown>
    waitForChange: (config: Record<string, unknown>, since: string | undefined, timeoutSeconds: number) =>
      Promise<{ version: string, changed: boolean, reason: string }>
  }
  const loaded = module.loadConfig(config)
  const initial = await module.waitForChange(loaded, undefined, 1)
  expect(initial).toMatchObject({ version: 'version-2' })
  expect(service.calls.at(-1)?.url).toBe('/orchestrator/api/watchdog/wait?timeout=1&stale_minutes=30')
  const changed = await module.waitForChange(loaded, 'version-1', 1)
  expect(changed).toMatchObject({ version: 'version-2', changed: true, reason: 'change' })
  expect(service.calls.at(-1)?.url).toBe('/orchestrator/api/watchdog/wait?timeout=1&stale_minutes=30&since=version-1')
})

it('writes a local heartbeat even when the service is unreachable', async () => {
  const config = configure('http://127.0.0.1:1', { report: false })
  const child = spawn(process.execPath, [script, '--config', config], { stdio: 'ignore' })
  const heartbeat = join(directory!, 'state', 'heartbeat.json')
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(heartbeat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    const value = JSON.parse(readFileSync(heartbeat, 'utf8'))
    expect(value.pid).toBe(child.pid)
    expect(Date.parse(value.at)).toBeGreaterThan(Date.now() - 10_000)
  } finally {
    child.kill()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
  }
}, 15_000)

it('records every observation and reports a finding only when it changes', async () => {
  const answers: unknown[] = []
  const { calls, url } = await fakeService(() => answers[0])
  answers[0] = snapshot()
  const config = configure(url)
  const first = await run(['--config', config, '--once'])
  expect(first.code).toBe(0)
  expect(calls.filter(call => call.method === 'POST').map(call => call.url)).toEqual(['/orchestrator/api/watchdog/runs'])
  const statePath = join(directory!, 'state', 'state.json')
  expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ reachable: true, current: [] })

  // The same quiet observation records another run but sends nothing.
  const second = await run(['--config', config, '--once'])
  expect(second.code).toBe(0)
  expect(calls.filter(call => call.url === '/orchestrator/api/watchdog/report')).toHaveLength(0)

  // A new signal reports once; the unchanged finding does not report again.
  answers[0] = snapshot({ tickets: [{ id: 't1', title: 'Stuck', stage: 'working', silentMinutes: 40, signals: ['no-progress'] }] })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  const reports = calls.filter(call => call.url === '/orchestrator/api/watchdog/report')
  expect(reports).toHaveLength(1)
  expect(JSON.parse(reports[0]!.body!)).toMatchObject({ chatId: 'oc_test' })
  expect(JSON.parse(reports[0]!.body!).note).toContain('t1 no-progress')

  // A changed signal is a different finding and reports again.
  answers[0] = snapshot({ tickets: [{ id: 't1', title: 'Stuck', stage: 'person', action: 'failed', silentMinutes: 40, signals: ['waiting-person'] }] })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect(calls.filter(call => call.url === '/orchestrator/api/watchdog/report')).toHaveLength(2)
  const status = await run(['--config', config, '--status'])
  expect(status.code).toBe(0)
  expect(JSON.parse(status.stdout)).toMatchObject({ reachable: true, reportedFingerprint: expect.any(String), current: ['t1 waiting-person'] })
})

it('sends a quiet daily report once per local day and not again on later quiet cycles', async () => {
  const { calls, url } = await fakeService(() => snapshot())
  const config = configure(url, { dailyReport: { hour: 0, timezone: 'UTC' } })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  const reports = calls.filter(call => call.url === '/orchestrator/api/watchdog/report')
  expect(reports).toHaveLength(1)
  expect(JSON.parse(reports[0]!.body!)).toMatchObject({ chatId: 'oc_test' })
  expect(JSON.parse(reports[0]!.body!).note).toContain('每日巡检')
  expect(JSON.parse(readFileSync(join(directory!, 'state', 'state.json'), 'utf8')))
    .toMatchObject({ reachable: true, quietReportDate: expect.any(String) })
  // The same local date suppresses the heartbeat; a findings cycle does not replace it and still reports on change.
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect(calls.filter(call => call.url === '/orchestrator/api/watchdog/report')).toHaveLength(1)
})

it('reports a missing run route once, logs an unreachable service, and exits 1 without a state from status', async () => {
  const { calls, url } = await fakeService(() => snapshot())
  const config = configure(url, { report: false })
  // The first cycle records a run; the fake service then stops answering the run route with 404.
  server!.removeAllListeners('request')
  server!.on('request', (request, response) => {
    calls.push({ method: request.method, url: request.url, body: '' })
    if (request.url?.startsWith('/orchestrator/api/watchdog/runs')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unknown operation' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot()))
  })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  const log = readFileSync(join(directory!, 'state', 'watchdog.log'), 'utf8')
  expect(log.match(/no watchdog run route yet/g)).toHaveLength(1)

  const unreachable = configure('http://127.0.0.1:1')
  const result = await run(['--config', unreachable, '--once'])
  expect(result.code).toBe(1)
  expect(JSON.parse(readFileSync(join(dirname(unreachable), 'state', 'state.json'), 'utf8'))).toMatchObject({ reachable: false })
  const status = await run(['--config', unreachable, '--status'])
  expect(status.code).toBe(0)
  expect(JSON.parse(status.stdout)).toMatchObject({ reachable: false })
  const missing = await run(['--config', join(directory!, 'missing.json'), '--once'])
  expect(missing.code).toBe(2)
  expect(missing.stderr).toContain('Cannot read the watchdog configuration')
})

it('writes one independent alert after consecutive unreachable reads and a recovery record when the service returns', async () => {
  const { url } = await fakeService(() => snapshot())
  const config = configure('http://127.0.0.1:1', { report: false, alertFile: 'alerts.jsonl', alertAfterFailures: 2 })
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  expect(existsSync(join(directory!, 'alerts.jsonl'))).toBe(false)
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  const alertPath = join(directory!, 'alerts.jsonl')
  const first = readFileSync(alertPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  expect(first).toEqual([expect.objectContaining({ kind: 'unreachable', failures: 2, url: 'http://127.0.0.1:1' })])
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  expect(readFileSync(alertPath, 'utf8').trim().split(/\r?\n/)).toHaveLength(1)

  const recoveredPath = join(directory!, 'recovered.json')
  writeFileSync(recoveredPath, JSON.stringify({ url, report: false, stateDir: 'state', alertFile: 'alerts.jsonl', alertAfterFailures: 2 }))
  expect((await run(['--config', recoveredPath, '--once'])).code).toBe(0)
  expect(readFileSync(alertPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line).kind))
    .toEqual(['unreachable', 'recovered'])
})