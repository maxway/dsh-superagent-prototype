/** The persistent observer hands new mechanical risk to the full agent instead of reporting it itself. */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'watchdog')
const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []

afterEach(() => {
  for (const item of servers.splice(0)) item.close()
  for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true })
})

/** A snapshot with one reviewable result waiting longer than a day, or a quiet working ticket. */
function snapshot(risk = true) {
  return {
    at: '2026-11-09T00:00:00.000Z', staleMinutes: 30, open: 1,
    tickets: [risk
      ? { id: 'r1', title: 'Review', stage: 'person', action: 'review', silentMinutes: 2000, signals: [], attempts: ['running'] }
      : { id: 'w1', title: 'Working', stage: 'working', silentMinutes: 5, signals: [], attempts: ['running'] }],
    state: { paused: false, load: { running: 0, queued: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } },
      setup: { problem: null, feishuProblem: null } },
    lastRun: null,
  }
}

/** A fake management API that records observation runs and Feishu reports. */
async function fakeService(answer: () => unknown) {
  const runs: Record<string, unknown>[] = []
  const reports: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const url = request.url ?? ''
      if (request.method === 'POST' && url.startsWith('/orchestrator/api/watchdog/runs')) {
        runs.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'run' }))
        return
      }
      if (request.method === 'POST' && url.startsWith('/orchestrator/api/watchdog/report')) {
        reports.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sent: true }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer()))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { runs, reports, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/** A stub agent runner that records each launch and exits with `code`. */
function agentStub(root: string, code: number) {
  const marker = join(root, 'agent-runs.txt')
  const runner = join(root, 'run.ps1')
  writeFileSync(runner, [
    'param([string]$Config)',
    `Add-Content -LiteralPath ${JSON.stringify(marker).replace(/'/g, "''")} -Value 'run'`,
    `exit ${code}`,
    '',
  ].join('\n'))
  const config = join(root, 'agent.json')
  writeFileSync(config, '{}')
  return { marker, runner, config }
}

/** Write one observer configuration and run a single cycle. */
function configure(root: string, url: string, agent: { runner: string, config: string }, fields: Record<string, unknown> = {}) {
  const path = join(root, 'watchdog.json')
  writeFileSync(path, JSON.stringify({ url, chatId: 'oc_test', report: true, intervalSeconds: 60, staleMinutes: 30,
    stateDir: 'state', agentRunner: agent.runner, agentConfig: agent.config, agentTimeoutSeconds: 60, ...fields }))
  return path
}

function run(config: string) {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolve => {
    execFile(process.execPath, [script, '--once', '--config', config], { timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error?.code as number ?? 0, stdout, stderr }))
  })
}

it.skipIf(process.platform !== 'win32')('runs the full agent once per new risk and leaves the judgement report to it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-watchdog-agent-trigger-'))
  directories.push(root)
  const agent = agentStub(root, 0)
  const answers = [snapshot(true)]
  const service = await fakeService(() => answers[0])
  const config = configure(root, service.url, agent)

  const first = await run(config)
  expect(first.code).toBe(0)
  expect(readFileSync(agent.marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1)
  // The observer records its observation, but the full agent owns the Feishu judgement report.
  expect(service.runs).toHaveLength(1)
  expect(service.reports).toHaveLength(0)
  expect(JSON.parse(readFileSync(join(root, 'state', 'state.json'), 'utf8')))
    .toMatchObject({ agentExit: 0, agentFingerprint: expect.any(String) })

  // The same finding does not spend another model call; the observer still records each cycle.
  expect((await run(config)).code).toBe(0)
  expect(readFileSync(agent.marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1)
  expect(service.runs).toHaveLength(2)

  // A cleared risk drops the marker; a later recurrence runs the agent again.
  answers[0] = snapshot(false)
  expect((await run(config)).code).toBe(0)
  expect(JSON.parse(readFileSync(join(root, 'state', 'state.json'), 'utf8'))).not.toHaveProperty('agentFingerprint')
  answers[0] = snapshot(true)
  expect((await run(config)).code).toBe(0)
  expect(readFileSync(agent.marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(2)
}, 30_000)

it.skipIf(process.platform !== 'win32')('reports one agent failure instead of retrying the same finding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-watchdog-agent-failure-'))
  directories.push(root)
  const agent = agentStub(root, 1)
  const service = await fakeService(() => snapshot(true))
  const config = configure(root, service.url, agent)

  expect((await run(config)).code).toBe(0)
  expect(readFileSync(agent.marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1)
  expect(service.reports).toHaveLength(1)
  expect(String(service.reports[0]!.note)).toContain('执行失败')
  // The failed finding is marked as handled, so the next cycle does not relaunch the agent.
  expect((await run(config)).code).toBe(0)
  expect(readFileSync(agent.marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1)
  expect(service.reports).toHaveLength(1)
}, 30_000)

it('requires an existing agent configuration and runner when the agent trigger is configured', async () => {
  const module = await import(pathToFileURL(script).href) as { loadConfig: (path: string) => Record<string, unknown> }
  const root = mkdtempSync(join(tmpdir(), 'dsh-watchdog-agent-config-'))
  directories.push(root)
  const path = join(root, 'watchdog.json')
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', stateDir: 'state', agentTimeoutSeconds: 60 }))
  expect(() => module.loadConfig(path)).toThrow(/require agentConfig/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', stateDir: 'state', agentConfig: 'missing.json' }))
  expect(() => module.loadConfig(path)).toThrow(/does not exist/)
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', stateDir: 'state', agentConfig: 'agent.json' }))
  writeFileSync(join(root, 'agent.json'), '{}')
  writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:9', stateDir: 'state', agentConfig: 'agent.json', agentRunner: 'missing-runner.ps1' }))
  expect(() => module.loadConfig(path)).toThrow(/does not exist/)
  expect(existsSync(join(root, 'agent.json'))).toBe(true)
})