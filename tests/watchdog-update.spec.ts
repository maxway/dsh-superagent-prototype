/** The independent Watchdog update installs, switches and rolls back an artifact without touching the superagent service. */
import { execFile, execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function apply(config: string) {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolve => {
    execFile(process.execPath, [updater, '--config', config], { timeout: 120_000 }, (error, stdout, stderr) =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }))
  })
}

it('installs a new artifact, proves its heartbeat, is idempotent and rolls back a failed update', async () => {
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
  writeFileSync(trigger, `const version = process.env.DSH_WATCHDOG_VERSION
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
  const config = (triggerCommand: string, heartbeatTimeoutSeconds = 10) => writeFileSync(configPath, JSON.stringify({
    watchdogHome: home, stagingRoot: join(root, 'staging'), requestPath, serviceUrl, triggerCommand,
    logFile: join(root, 'update.log'), resultFile: resultPath, heartbeatTimeoutSeconds, pollSeconds: 1, lockStaleSeconds: 60 }))
  const request = (version: string, key: string, artifactPath: string) => writeFileSync(requestPath, JSON.stringify({
    at: new Date().toISOString(), requestedBy: 'operator', confirmation: '更新 watchdog', idempotencyKey: key,
    target: { version, artifactPath, sha256: version === 'v2' ? two.sha256 : one.sha256 } }))

  config(`"${process.execPath}" "${trigger}"`)
  request('v2', 'update-1', join(root, 'staging', 'v2'))
  expect(await apply(configPath)).toMatchObject({ code: 0 })
  const updated = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
  expect(updated).toMatchObject({ ok: true, phase: 'updated', version: 'v2', previousVersion: 'v1', heartbeat: 'recorded' })
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe('v2')
  expect(readFileSync(join(home, 'previous.txt'), 'utf8').trim()).toBe('v1')
  expect(runs.filter(run => run.version === 'v2')).toHaveLength(1)

  // The same request key returns the recorded result instead of triggering another agent run.
  request('v2', 'update-1', join(root, 'staging', 'v2'))
  expect(await apply(configPath)).toMatchObject({ code: 0 })
  expect(runs.filter(run => run.version === 'v2')).toHaveLength(1)

  // A trigger that never records a run must roll the pointer back to the previous version.
  writeFileSync(join(home, 'current.txt'), 'v1\n')
  config(`"${process.execPath}" "${noop}"`, 2)
  request('v2', 'update-2', join(root, 'staging', 'v2'))
  expect(await apply(configPath)).toMatchObject({ code: 1 })
  expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ ok: false, phase: 'rolled-back', version: 'v2', previousVersion: 'v1' })
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe('v1')

  // An artifact outside the staging root is refused before the request is archived.
  config(`"${process.execPath}" "${trigger}"`)
  request('v2', 'update-3', home)
  expect(await apply(configPath)).toMatchObject({ code: 2 })
  expect(readFileSync(requestPath, 'utf8')).toContain('update-3')
}, 60_000)