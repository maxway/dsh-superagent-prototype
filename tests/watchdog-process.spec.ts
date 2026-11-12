import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
    waitForChange: (config: Record<string, unknown>, since: string | undefined, timeoutSeconds: number, signal?: AbortSignal) =>
      Promise<{ version: string, changed: boolean, reason: string }>
  }
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-config-'))
  const path = join(directory, 'watchdog.json')
  writeFileSync(path, JSON.stringify({ url: 'not a url', stateDir: 'state' }))
  expect(() => module.loadConfig(path)).toThrow(/url must be/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', unknown: 1 }))
  expect(() => module.loadConfig(path)).toThrow(/Unknown watchdog configuration field/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', intervalSeconds: 5 }))
  expect(() => module.loadConfig(path)).toThrow(/intervalSeconds/)
  const config = module.loadConfig((writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9/', stateDir: 'state' })), path))
  expect(config).toMatchObject({ url: 'http://127.0.0.1:9', intervalSeconds: 900, staleMinutes: 30 })

  const findings = module.collectFindings(snapshot({ tickets: [
    { id: 't1', title: 'Stuck', signals: ['queued', 'no-progress'] },
    { id: 't2', title: 'Waiting', signals: ['waiting-person'] },
  ], state: { paused: false, load: { running: 3, maxWorkers: 3 }, health: { runtime: { state: 'ready' }, gitlab: { state: 'error', detail: 'offline' } },
    setup: { problem: { code: 'agentCliUnset', place: 'gitlab' } } } }))
  // Full worker load explains queued, but no-progress remains visible as a mechanical hint.
  expect(findings).toEqual([{ kind: 'ticket', id: 't1', title: 'Stuck', signals: ['no-progress'] },
    { kind: 'ticket', id: 't2', title: 'Waiting', signals: ['waiting-person'] },
    { kind: 'health', part: 'gitlab', state: 'error', detail: 'offline' },
    { kind: 'setup', code: 'agentCliUnset', place: 'gitlab' }])
  expect(module.fingerprint(findings)).toBe(module.fingerprint(module.collectFindings(snapshot({ tickets: [
    { id: 't1', title: 'Stuck', signals: ['no-progress'] },
    { id: 't2', title: 'Waiting', silentMinutes: 90, signals: ['waiting-person'] },
  ], state: { paused: false, load: { running: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' }, gitlab: { state: 'error', detail: 'offline' } },
    setup: { problem: { code: 'agentCliUnset', place: 'gitlab' } } } }))))
  // A paused service explains the Ticket signals it causes, but a delivery fault stays visible.
  expect(module.collectFindings(snapshot({ tickets: [{ id: 't1', title: 'Stuck', signals: ['queued', 'no-progress', 'waiting-person'] }],
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
    const second = await run(['--config', config, '--once'])
    expect(second.code).toBe(2)
    expect(second.stderr).toContain('Watchdog lock exists')
  } finally {
    child.kill()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
  }
}, 15_000)

it('keeps observations locally without writing runs or reports', async () => {
  const answers: unknown[] = []
  const { calls, url } = await fakeService(() => answers[0])
  const config = configure(url, { dailyReport: { hour: 0, timezone: 'UTC' } })
  answers[0] = snapshot()
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  answers[0] = snapshot({ tickets: [{ id: 't1', title: 'Stuck', signals: ['no-progress'] }] })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect(calls.map(call => call.method)).toEqual(['GET', 'GET'])
  const status = await run(['--config', config, '--status'])
  expect(status.code).toBe(0)
  expect(JSON.parse(status.stdout)).toMatchObject({ reachable: true, current: ['t1 no-progress'] })
  expect(readFileSync(join(directory!, 'state', 'watchdog.log'), 'utf8')).toContain('Observed 1 finding')
})

it('records malformed snapshot findings as unreachable and recovers on the next valid snapshot', async () => {
  let answer: unknown = snapshot()
  const { url } = await fakeService(() => answer)
  const config = configure(url, { alertFile: 'alerts.jsonl', alertAfterFailures: 1 })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  answer = snapshot({ tickets: [{ id: 'bad', signals: {} }] })
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  const state = join(directory!, 'state', 'state.json')
  expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: false, unreachable: 1, lastError: expect.any(String) })
  expect(JSON.parse(readFileSync(join(directory!, 'alerts.jsonl'), 'utf8')).kind).toBe('unreachable')
  for (const incomplete of [{ tickets: [] }, { tickets: [], state: {} }, { tickets: [], state: { health: null } }]) {
    answer = incomplete
    expect((await run(['--config', config, '--once'])).code).toBe(1)
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: false, lastError: expect.stringContaining('complete Watchdog snapshot') })
  }
  answer = snapshot()
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: true, unreachable: 0 })
})

it('continues periodic observation after a malformed snapshot', async () => {
  let healthy = false
  const { calls, url } = await fakeService(() => healthy ? snapshot() : snapshot({ tickets: [null] }))
  const config = configure(url)
  const clock = join(directory!, 'clock.cjs')
  writeFileSync(clock, 'const original = setTimeout; global.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 50 : ms, ...args)')
  const child = spawn(process.execPath, ['--require', clock, script, '--config', config], { stdio: 'ignore' })
  try {
    const state = join(directory!, 'state', 'state.json')
    const deadline = Date.now() + 10_000
    while (!existsSync(state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: false })
    healthy = true
    while (Date.now() < deadline && !JSON.parse(readFileSync(state, 'utf8')).reachable) await new Promise(resolve => setTimeout(resolve, 20))
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: true })
    expect(calls.length).toBeGreaterThanOrEqual(2)
  } finally {
    child.kill()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
  }
}, 15_000)

it('rejects an oversized snapshot without recording it as reachable', async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(Buffer.alloc(8 * 1024 * 1024 + 1, 32))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const config = configure(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  expect(JSON.parse(readFileSync(join(directory!, 'state', 'state.json'), 'utf8'))).toMatchObject({ reachable: false })
})

it('enforces a total deadline even while the response keeps streaming', async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{')
    const stream = setInterval(() => response.write(' '), 100)
    response.on('close', () => clearInterval(stream))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const config = configure(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const started = Date.now()
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_000)
  expect(Date.now() - started).toBeLessThan(15_000)
  expect(JSON.parse(readFileSync(join(directory!, 'state', 'state.json'), 'utf8'))).toMatchObject({ reachable: false })
}, 18_000)

it('logs an unreachable service and exposes the local status', async () => {
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

it('ignores recovery and deployment requests in a running observer', async () => {
  const config = configure('http://127.0.0.1:1', { crashRecovery: { serviceConfig: 'service.json', recoveryScript: 'recover.ps1', retrySeconds: 1 },
    powershell: 'pwsh', deployConfig: 'deploy.json', agentConfig: 'missing-agent.json' })
  const recovery = join(directory!, 'recovery-ran')
  writeFileSync(join(directory!, 'service.json'), '{}')
  writeFileSync(join(directory!, 'recover.ps1'), `param($Config, $ExpectedUrl)\nSet-Content -LiteralPath '${recovery.replaceAll("'", "''")}' -Value 'ran'\n`)
  const request = join(directory!, 'request.json')
  const result = join(directory!, 'result.json')
  writeFileSync(request, '{}')
  writeFileSync(join(directory!, 'deploy.json'), JSON.stringify({ requestPath: request, resultFile: result }))
  const child = spawn(process.execPath, [script, '--config', config], { stdio: 'ignore' })
  try {
    const state = join(directory!, 'state', 'state.json')
    const deadline = Date.now() + 10_000
    while (!existsSync(state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: false })
    expect(existsSync(join(directory!, 'state', 'heartbeat.json'))).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(existsSync(recovery)).toBe(false)
    expect(readFileSync(request, 'utf8')).toBe('{}')
    expect(existsSync(result)).toBe(false)
    expect(readdirSync(directory!).some(name => name.startsWith('result.json.watchdog-'))).toBe(false)
    expect(readFileSync(join(directory!, 'state', 'watchdog.log'), 'utf8')).not.toMatch(/Crash recovery|Deployment/)
  } finally {
    child.kill()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
  }
}, 15_000)
it('refuses an existing lock without replacing it', async () => {
  const config = configure('http://127.0.0.1:1')
  const stateDir = join(directory!, 'state')
  mkdirSync(stateDir)
  const lock = join(stateDir, 'watchdog.pid')
  writeFileSync(lock, '123456789\n')
  const result = await run(['--config', config, '--once'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('verify no observer is running before removing it manually')
  expect(readFileSync(lock, 'utf8')).toBe('123456789\n')
})

it('retries failed local alerts and recovery records without falsely acknowledging them', async () => {
  let healthy = false
  const { url } = await fakeService(() => healthy ? snapshot() : {})
  const config = configure(url, { alertFile: 'alerts.jsonl', alertAfterFailures: 1 })
  const alert = join(directory!, 'alerts.jsonl')
  const state = join(directory!, 'state', 'state.json')
  mkdirSync(alert)
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  expect(JSON.parse(readFileSync(state, 'utf8'))).not.toHaveProperty('alertedAt')
  expect(readFileSync(join(directory!, 'state', 'watchdog.log'), 'utf8')).not.toContain('Independent alert written')
  rmSync(alert, { recursive: true })
  expect((await run(['--config', config, '--once'])).code).toBe(1)
  expect(JSON.parse(readFileSync(state, 'utf8'))).toHaveProperty('alertedAt')
  expect(JSON.parse(readFileSync(alert, 'utf8')).kind).toBe('unreachable')
  rmSync(alert)
  mkdirSync(alert)
  healthy = true
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ reachable: true, unreachable: 2, alertedAt: expect.any(String) })
  rmSync(alert, { recursive: true })
  expect((await run(['--config', config, '--once'])).code).toBe(0)
  expect(JSON.parse(readFileSync(alert, 'utf8'))).toMatchObject({ kind: 'recovered', failures: 2 })
  expect(JSON.parse(readFileSync(state, 'utf8'))).not.toHaveProperty('alertedAt')
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