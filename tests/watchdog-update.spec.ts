/** The independent Watchdog update installs and switches an artifact without touching the superagent service. */
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const artifact = join(import.meta.dirname, '..', 'scripts', 'watchdog-artifact.mjs')
const updater = join(import.meta.dirname, '..', 'scripts', 'watchdog-update.mjs')
let directory: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

type Artifact = { version: string, commit: string, sha256: string }
type Run = { version?: string, at?: string, id?: string, idempotencyKey?: string }

function build(root: string, version: string): Artifact {
  const out = join(root, 'staging', version)
  execFileSync(process.execPath, [artifact, '--out', out, '--version', version, '--commit', `${version}000000000000000000000000000000000000`,
    '--built-at', '2026-11-09T00:00:00.000Z'], { stdio: 'pipe' })
  return JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Artifact
}

function apply(configPath: string) {
  const script = `import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
const module = await import(pathToFileURL(process.argv[1]).href)
const config = module.loadConfig(process.argv[2])
try {
  const request = JSON.parse(readFileSync(config.requestPath, 'utf8'))
  module.validateRequest(request, config)
  const result = await module.update(config, request)
  process.exitCode = result.ok ? 0 : 1
} catch { process.exitCode = 2 }`
  return new Promise<{ code: number }>(resolve => {
    execFile(process.execPath, ['--input-type=module', '-e', script, updater, configPath], { timeout: 120_000 }, error =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0 }))
  })
}

function applyCli(script: string, config: string) {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolve => {
    execFile(process.execPath, [script, '--config', config], { timeout: 120_000 }, (error, stdout, stderr) =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }))
  })
}

it('installs a new artifact and retains the candidate when heartbeat verification fails', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-update '))
  const root = directory
  const home = join(root, 'home')
  mkdirSync(join(home, 'versions'), { recursive: true })
  const one = build(root, 'v1')
  const two = build(root, 'v2')
  cpSync(join(root, 'staging', 'v1'), join(home, 'versions', 'v1'), { recursive: true })
  writeFileSync(join(home, 'current.txt'), 'v1\n')

  const runs: Run[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'POST' && request.url?.startsWith('/orchestrator/api/watchdog/runs')) {
        const run = { ...JSON.parse(body || '{}'), id: `run-${runs.length}`, at: new Date().toISOString() } as Run
        runs.push(run)
        response.end(JSON.stringify(run))
        return
      }
      if (request.url?.startsWith('/orchestrator/api/watchdog/runs')) {
        response.end(JSON.stringify({ runs }))
        return
      }
      response.end('{}')
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const serviceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const trigger = join(root, 'trigger.mjs')
  mkdirSync(join(home, 'observer-state'), { recursive: true })
  writeFileSync(trigger, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(home, 'observer-state', 'heartbeat.json'))}, JSON.stringify({ pid: ${process.pid}, at: new Date().toISOString() }))
const version = process.env.DSH_WATCHDOG_VERSION
const response = await fetch(process.env.DSH_WATCHDOG_SERVICE_URL + '/orchestrator/api/watchdog/runs', {
  method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
  body: JSON.stringify({ idempotencyKey: 'fake-' + version, note: 'fake agent', version }),
})
if (!response.ok) process.exit(1)
`)
  const noop = join(root, 'noop.mjs')
  writeFileSync(noop, 'process.exit(0)\n')
  const requestPath = join(root, 'request.json')
  const configPath = join(root, 'update.json')
  const resultPath = join(root, 'result.json')
  const config = (startCommand: string, heartbeatTimeoutSeconds = 10) => writeFileSync(configPath, JSON.stringify({
    watchdogHome: home, stagingRoot: join(root, 'staging'), requestPath, serviceUrl,
    observerStopCommand: `"${process.execPath}" "${noop}"`, observerStartCommand: startCommand,
    logFile: join(root, 'update.log'), resultFile: resultPath, heartbeatTimeoutSeconds, survivalSeconds: 1, pollSeconds: 1, lockStaleSeconds: 60 }))
  const request = (version: string, key: string, artifactPath: string) => writeFileSync(requestPath, JSON.stringify({
    at: new Date().toISOString(), requestedBy: 'operator', confirmation: '更新 watchdog', idempotencyKey: key,
    target: { version, artifactPath, sha256: version === 'v2' ? two.sha256 : one.sha256 } }))

  config(`"${process.execPath}" "${trigger}"`)
  request('v2', 'update-1', join(root, 'staging', 'v2'))
  expect(await apply(configPath)).toMatchObject({ code: 0 })
  const updated = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
  expect(updated).toMatchObject({ ok: true, phase: 'updated', version: 'v2', previousVersion: 'v1', heartbeat: 'local' })
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe('v2')
  expect(readFileSync(join(home, 'previous.txt'), 'utf8').trim()).toBe('v1')
  expect(runs.filter(run => run.version === 'v2')).toHaveLength(1)

  // The same request key returns the recorded result instead of triggering another agent run.
  request('v2', 'update-1', join(root, 'staging', 'v2'))
  writeFileSync(join(home, 'observer-state', 'watchdog.pid'), String(process.pid))
  expect(await apply(configPath)).toMatchObject({ code: 0 })
  rmSync(join(home, 'observer-state', 'watchdog.pid'))
  expect(runs.filter(run => run.version === 'v2')).toHaveLength(1)

  // A missing run leaves the candidate in place for investigation.
  writeFileSync(join(home, 'current.txt'), 'v1\n')
  config(`"${process.execPath}" "${noop}"`, 2)
  request('v2', 'update-2', join(root, 'staging', 'v2'))
  expect(await apply(configPath)).toMatchObject({ code: 1 })
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ ok: false, phase: 'heartbeat-unverified', version: 'v2', previousVersion: 'v1', manualIntervention: true })
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe('v2')

  writeFileSync(join(home, 'current.txt'), 'v1\n')
  const deadTrigger = join(root, 'dead-trigger.mjs')
  writeFileSync(deadTrigger, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(home, 'observer-state', 'heartbeat.json'))}, JSON.stringify({ pid: 99999999, at: new Date().toISOString() }))
await fetch(process.env.DSH_WATCHDOG_SERVICE_URL + '/orchestrator/api/watchdog/runs', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ version: 'v2' }),
})`)
  config(`"${process.execPath}" "${deadTrigger}"`, 2)
  request('v2', 'update-dead-observer', join(root, 'staging', 'v2'))
  expect(await apply(configPath)).toMatchObject({ code: 1 })
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ ok: false, phase: 'heartbeat-unverified', manualIntervention: true })
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe('v2')

  // An artifact outside the staging root is refused before the request is archived.
  config(`"${process.execPath}" "${trigger}"`)
  request('v2', 'update-3', home)
  expect(await apply(configPath)).toMatchObject({ code: 2 })
  expect(readFileSync(requestPath, 'utf8')).toContain('update-3')

  // A persistent observer is stopped before the pointer switches and started from the new version afterwards.
  writeFileSync(join(home, 'current.txt'), 'v1\n')
  const order = join(root, 'observer-order.log')
  const observer = join(root, 'observer.mjs')
  writeFileSync(observer, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const action = process.argv[2]
const home = process.argv[3]
const current = readFileSync(home + '/current.txt', 'utf8').trim()
appendFileSync(process.argv[4], action + ' ' + current + '\\n')
if (action === 'start') {
  writeFileSync(${JSON.stringify(join(home, 'observer-state', 'heartbeat.json'))}, JSON.stringify({ pid: ${process.pid}, at: new Date().toISOString() }))
  const response = await fetch(process.env.DSH_WATCHDOG_SERVICE_URL + '/orchestrator/api/watchdog/runs', {
    method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: 'observer-' + current, note: 'observer', version: current }),
  })
  if (!response.ok) process.exit(1)
}
`)
  const observerConfig = join(root, 'update-observer.json')
  writeFileSync(observerConfig, JSON.stringify({ watchdogHome: home, stagingRoot: join(root, 'staging'), requestPath,
    serviceUrl, observerStopCommand: `"${process.execPath}" "${observer}" stop "${home}" "${order}"`,
    observerStartCommand: `"${process.execPath}" "${observer}" start "${home}" "${order}"`,
    logFile: join(root, 'update.log'), resultFile: resultPath, heartbeatTimeoutSeconds: 10, survivalSeconds: 1, pollSeconds: 1,
    lockStaleSeconds: 60 }))
  request('v2', 'update-observer', join(root, 'staging', 'v2'))
  expect(await apply(observerConfig)).toMatchObject({ code: 0 })
  const observed = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
  expect(observed).toMatchObject({ ok: true, phase: 'updated', version: 'v2', previousVersion: 'v1', heartbeat: 'local' })
  expect(readFileSync(order, 'utf8').trim().split(/\r?\n/)).toEqual(['stop v1', 'start v2'])
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe('v2')
}, 60_000)

it('builds the remote latest for the CLI instead of trusting a requested artifact', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-latest-'))
  const root = directory
  const checkout = join(root, 'checkout')
  const remote = join(root, 'remote.git')
  const home = join(root, 'home')
  const staging = join(root, 'custom-staging')
  const requestPath = join(root, 'request.json')
  const resultPath = join(root, 'result.json')
  mkdirSync(join(checkout, 'scripts'), { recursive: true })
  for (const name of ['watchdog-update.mjs', 'watchdog-control.mjs', 'watchdog-artifact.mjs', 'watchdog-smoke.mjs',
    'watchdog', 'watchdog-deployment.mjs', 'watchdog-agent', 'watchdog-launch-observer.ps1', 'watchdog-launch-observer.vbs', 'watchdog-bootstrap.mjs']) {
    cpSync(join(import.meta.dirname, '..', 'scripts', name), join(checkout, 'scripts', name), { recursive: true })
  }
  cpSync(join(import.meta.dirname, '..', 'package.json'), join(checkout, 'package.json'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'remote')
  const commit = git('rev-parse', 'HEAD')
  execFileSync('git', ['clone', '--bare', checkout, remote], { cwd: root })
  git('remote', 'add', 'origin', remote)
  writeFileSync(join(checkout, 'local-only.txt'), 'not on remote')
  git('add', 'local-only.txt')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'local only')
  const version = commit.slice(0, 7)
  const installed = join(home, 'versions', version)
  const cleanRemote = join(root, 'clean-remote')
  execFileSync('git', ['clone', '--branch', 'main', remote, cleanRemote], { cwd: root })
  execFileSync(process.execPath, [join(checkout, 'scripts', 'watchdog-artifact.mjs'), '--root', cleanRemote,
    '--out', installed, '--version', version, '--commit', commit])
  writeFileSync(join(home, 'current.txt'), `${version}\n`)
  mkdirSync(staging)
  const oldArtifact = join(staging, 'old')
  execFileSync(process.execPath, [join(checkout, 'scripts', 'watchdog-artifact.mjs'), '--root', checkout,
    '--out', oldArtifact, '--version', 'old', '--commit', git('rev-parse', 'HEAD')])
  writeFileSync(requestPath, JSON.stringify({ confirmation: 'update', idempotencyKey: 'old-request',
    target: { version: 'old', artifactPath: oldArtifact } }))
  const configPath = join(root, 'config.json')
  const start = join(root, 'start.mjs')
  const starts = join(root, 'starts.txt')
  mkdirSync(join(home, 'observer-state'))
  writeFileSync(start, `import { appendFileSync, writeFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(starts)}, 'start\\n')
writeFileSync(${JSON.stringify(join(home, 'observer-state', 'watchdog.pid'))}, '${process.pid}')
writeFileSync(${JSON.stringify(join(home, 'observer-state', 'heartbeat.json'))}, JSON.stringify({ pid: ${process.pid}, at: new Date().toISOString() }))`)
  writeFileSync(configPath, JSON.stringify({ watchdogHome: home, stagingRoot: staging, requestPath,
    serviceUrl: 'http://127.0.0.1:1', observerStopCommand: 'unused', observerStartCommand: `"${process.execPath}" "${start}"`,
    logFile: join(root, 'update.log'), resultFile: resultPath }))
  const result = await applyCli(join(checkout, 'scripts', 'watchdog-update.mjs'), configPath)
  expect(result).toMatchObject({ code: 0 })
  for (const name of ['launch-observer.ps1', 'launch-observer.vbs', 'watchdog-bootstrap.mjs', 'watchdog-control.mjs',
    'watchdog-update.mjs', 'watchdog-artifact.mjs', 'watchdog-smoke.mjs']) {
    expect(readFileSync(join(home, name), 'utf8').length).toBeGreaterThan(0)
  }
  expect(readFileSync(join(home, 'source-checkout.txt'), 'utf8').trim()).toBe(checkout)
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ ok: true, phase: 'started', version,
    request: { target: { version }, idempotencyKey: `old-request:${commit}` } })
  expect(readFileSync(starts, 'utf8').trim()).toBe('start')
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe(version)
  writeFileSync(requestPath, JSON.stringify({ confirmation: 'update' }))
  expect(await applyCli(join(checkout, 'scripts', 'watchdog-update.mjs'), configPath)).toMatchObject({ code: 0 })
  const minimal = JSON.parse(readFileSync(resultPath, 'utf8'))
  expect(minimal).toMatchObject({ ok: true, phase: 'already-current', version, request: { target: { version } } })
  expect(minimal.request.idempotencyKey).toMatch(new RegExp(`^[0-9a-f-]+:${commit}$`))
  writeFileSync(requestPath, JSON.stringify({ confirmation: 'update', target: { artifactPath: join(root, 'outside') } }))
  expect(await applyCli(join(checkout, 'scripts', 'watchdog-update.mjs'), configPath)).toMatchObject({ code: 0 })
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ ok: true, version, request: { target: { version } } })
  expect(readFileSync(starts, 'utf8').trim()).toBe('start')
  writeFileSync(requestPath, JSON.stringify({ confirmation: '' }))
  expect(await applyCli(join(checkout, 'scripts', 'watchdog-update.mjs'), configPath)).toMatchObject({ code: 2 })
  writeFileSync(requestPath, JSON.stringify({ confirmation: 'update' }))
  git('remote', 'set-url', 'origin', join(root, 'missing-remote'))
  const unavailable = await applyCli(join(checkout, 'scripts', 'watchdog-update.mjs'), configPath)
  expect(unavailable.code).not.toBe(0)
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe(version)
}, 120_000)

it('starts the prepared version while the updater holds its lock', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-update-lock-'))
  const home = join(directory, 'home')
  const manifest = build(directory, 'v2')
  const module = await import(updater)
  const config = { watchdogHome: home, stagingRoot: join(directory, 'staging'), serviceUrl: 'http://127.0.0.1:1',
    observerStopCommand: '', observerStartCommand: 'unused', logFile: join(directory, 'update.log'),
    resultFile: join(directory, 'result.json'), lockStaleSeconds: 900, smokeTimeoutSeconds: 30 }
  const result = await module.update(config, { confirmation: 'test', idempotencyKey: 'lock-test',
    target: { version: 'v2', artifactPath: join(directory, 'staging', 'v2'), sha256: manifest.sha256 } }, {
    smoke: async () => { throw new Error('smoke must not run during startup') },
    trigger: () => {
      const child = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'watchdog-bootstrap.mjs'), home],
        { encoding: 'utf8', timeout: 5000 })
      expect(child.status, child.stderr).toBe(0)
      return {}
    },
    verifyObserverHeartbeat: async () => ({ pid: process.pid }),
  })
  expect(result).toMatchObject({ ok: true, phase: 'updated', version: 'v2' })
  let currentStarts = 0
  const currentRequest = { confirmation: 'test', idempotencyKey: 'current-stopped',
    target: { version: 'v2', artifactPath: join(directory, 'staging', 'v2'), sha256: manifest.sha256 } }
  const started = await module.update(config, currentRequest, {
    trigger: () => {
      currentStarts++
      const child = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'watchdog-bootstrap.mjs'), home],
        { encoding: 'utf8', timeout: 5000 })
      expect(child.status, child.stderr).toBe(0)
      return {}
    },
    verifyObserverHeartbeat: async () => ({ pid: process.pid }),
  })
  expect(started).toMatchObject({ ok: true, phase: 'started' })
  expect(currentStarts).toBe(1)
  mkdirSync(join(home, 'observer-state'), { recursive: true })
  writeFileSync(join(home, 'observer-state', 'watchdog.pid'), String(process.pid))
  const running = await module.update(config, { ...currentRequest, idempotencyKey: 'current-running' }, {
    trigger: () => { throw new Error('must not restart a running observer') },
  })
  expect(running).toMatchObject({ ok: true, phase: 'already-current' })
  const externalHome = join(directory, 'external-home')
  const externalConfig = { ...config, watchdogHome: externalHome, resultFile: join(directory, 'external-result.json') }
  const release = module.acquireLock(externalConfig)
  try {
    const external = await module.update(externalConfig, { confirmation: 'test', idempotencyKey: 'external-lock',
      target: { version: 'v2', artifactPath: join(directory, 'staging', 'v2'), sha256: manifest.sha256 } }, {
      lockHeld: true, smoke: async () => ({}),
      trigger: () => {
        const child = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'watchdog-bootstrap.mjs'), externalHome],
          { encoding: 'utf8', timeout: 5000 })
        expect(child.status, child.stderr).toBe(0)
        return {}
      },
      verifyObserverHeartbeat: async () => ({ pid: process.pid }),
    })
    expect(external).toMatchObject({ ok: true, phase: 'updated' })
  } finally {
    release()
  }
  const failedHome = join(directory, 'failed-home')
  mkdirSync(failedHome)
  writeFileSync(join(failedHome, 'current.txt'), 'v1\n')
  let starts = 0
  const failure = await module.update({ ...config, watchdogHome: failedHome, resultFile: join(directory, 'failed-result.json') },
    { confirmation: 'test', idempotencyKey: 'start-failure',
      target: { version: 'v2', artifactPath: join(directory, 'staging', 'v2'), sha256: manifest.sha256 } }, {
      trigger: () => { starts++; throw new Error('simulated start failure') },
    })
  expect(failure).toMatchObject({ ok: false, phase: 'start-failed', manualIntervention: true })
  expect(starts).toBe(1)
  expect(readFileSync(join(failedHome, 'current.txt'), 'utf8').trim()).toBe('v2')
})

it('accepts a fresh heartbeat without a fixed survival wait', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-heartbeat-'))
  const state = join(directory, 'observer-state')
  mkdirSync(state, { recursive: true })
  const module = await import(updater) as {
    verifyObserverHeartbeat: (config: Record<string, unknown>, since: number) => Promise<unknown>
  }
  const since = Date.now()
  writeFileSync(join(state, 'heartbeat.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const started = Date.now()
  await expect(module.verifyObserverHeartbeat({ watchdogHome: directory, heartbeatTimeoutSeconds: 2 }, since))
    .resolves.toMatchObject({ pid: process.pid })
  expect(Date.now() - started).toBeLessThan(1000)
})