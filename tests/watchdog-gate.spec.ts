/** The artifact gate escalates the slow risks the observer's signal threshold does not raise by itself. */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const gate = join(import.meta.dirname, '..', 'scripts', 'watchdog-agent', 'gate.mjs')
const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []

afterEach(() => {
  for (const item of servers.splice(0)) item.close()
  for (const item of directories.splice(0)) rmSync(item, { recursive: true, force: true })
})

/** A snapshot shaped like the live management API: a reviewable result is `person` + `review`, not a `ready` stage. */
function snapshot(ticket: Record<string, unknown> = {}) {
  return {
    at: '2026-11-09T00:00:00.000Z', staleMinutes: 30, open: 1, tickets: [{
      id: 'r1', title: 'Review the build', stage: 'working', silentMinutes: 5, signals: [], attempts: ['running'], ...ticket,
    }],
    state: { paused: false, load: { running: 0, queued: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } },
      setup: { problem: null, feishuProblem: null } },
    lastRun: null,
  }
}

/** Start a fake management API and return the runs it recorded and its address. */
async function fakeService(answer: () => unknown) {
  const runs: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.method === 'POST' && request.url?.startsWith('/orchestrator/api/watchdog/runs')) {
        runs.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'run' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer()))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { runs, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/** Write a gate configuration and run one cycle from the repository scripts directory. */
function runGate(url: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-watchdog-gate-'))
  directories.push(directory)
  const config = join(directory, 'watchdog.json')
  writeFileSync(config, JSON.stringify({ url, staleMinutes: 30 }))
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolve => {
    execFile(process.execPath, [gate, '--config', config], { cwd: directory, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error?.code as number ?? 0, stdout, stderr }))
  })
}

it('escalates a result that waits for review for more than a day', async () => {
  const service = await fakeService(() => snapshot({ stage: 'person', action: 'review', silentMinutes: 2000 }))
  const result = await runGate(service.url)
  expect(result.code).toBe(2)
  expect(result.stdout).toContain('ready-unreviewed')
  expect(service.runs).toHaveLength(1)
  expect(service.runs[0]!.note).toContain('ready-unreviewed')
})

it('escalates repeated failed attempts and records a quiet cycle without an LLM', async () => {
  const service = await fakeService(() => snapshot({ attempts: ['failed', 'blocked', 'running'] }))
  const risky = await runGate(service.url)
  expect(risky.code).toBe(2)
  expect(risky.stdout).toContain('repeated-failures')
  expect(service.runs).toHaveLength(1)

  const quiet = await fakeService(() => snapshot())
  const result = await runGate(quiet.url)
  expect(result.code).toBe(0)
  expect(quiet.runs).toHaveLength(1)
  expect(quiet.runs[0]!.note).toContain('机械预检无风险')
})