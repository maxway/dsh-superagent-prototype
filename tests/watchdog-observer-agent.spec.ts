import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'watchdog')
const directories: string[] = []
const servers: ReturnType<typeof createServer>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('ignores obsolete action configuration without validating its dependencies', async () => {
  const observer = await import(pathToFileURL(script).href) as { loadConfig: (path: string) => Record<string, unknown> }
  const root = mkdtempSync(join(tmpdir(), 'dsh-watchdog-legacy-config-'))
  directories.push(root)
  const path = join(root, 'watchdog.json')
  writeFileSync(path, JSON.stringify({ url: 'https://example.test', stateDir: 'state', report: true,
    dailyReport: { hour: 9 }, agentConfig: 'missing.json', agentRunner: 'missing.ps1', agentTimeoutSeconds: 60,
    crashRecovery: { serviceConfig: 'missing.json', recoveryScript: 'missing.ps1' }, deployConfig: 'missing.json' }))
  const config = observer.loadConfig(path)
  expect(config.url).toBe('https://example.test')
  for (const field of ['report', 'dailyReport', 'agentConfig', 'crashRecovery', 'deployConfig']) {
    expect(config).not.toHaveProperty(field)
  }
})

it('never launches an agent or sends reports for findings in once and continuous modes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-watchdog-readonly-agent-'))
  directories.push(root)
  const calls: string[] = []
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ tickets: [{ id: 't1', title: 'Risk', signals: ['no-progress'] }], state: { health: {} } }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const marker = join(root, 'agent-ran')
  const runner = join(root, 'runner.ps1')
  writeFileSync(runner, `param($Config)\nSet-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'ran'\n`)
  writeFileSync(join(root, 'agent.json'), '{}')
  const config = join(root, 'watchdog.json')
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stateDir: 'state',
    intervalSeconds: 60, report: true, chatId: 'oc_test', dailyReport: { hour: 0, timezone: 'UTC' },
    agentConfig: 'agent.json', agentRunner: runner, powershell: 'pwsh' }))
  const once = await new Promise<number>(resolve => execFile(process.execPath, [script, '--config', config, '--once'],
    error => resolve(error?.code as number ?? 0)))
  expect(once).toBe(0)
  const clock = join(root, 'clock.cjs')
  writeFileSync(clock, 'const original = setTimeout; global.setTimeout = (fn, ms, ...args) => original(fn, ms === 60000 ? 50 : ms, ...args)')
  const child = spawn(process.execPath, ['--require', clock, script, '--config', config], { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 10_000
    while (calls.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.every(call => call === 'GET /orchestrator/api/watchdog?stale_minutes=30')).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'state', 'state.json'), 'utf8'))).toMatchObject({ reachable: true, current: ['t1 no-progress'] })
    expect(existsSync(join(root, 'state', 'heartbeat.json'))).toBe(true)
  } finally {
    child.kill()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
  }
}, 15_000)
