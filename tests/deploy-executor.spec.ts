import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const executor = join(import.meta.dirname, '..', 'scripts', 'deploy.mjs')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-test-'))
  directory = root
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, 'scripts'), { recursive: true })
  writeFileSync(join(checkout, 'scripts', 'dsh-superagent.ps1'), 'throw "must not execute directly"\n')
  const record = join(root, 'called.json')
  const restart = join(root, 'fake-restart.ps1')
  writeFileSync(restart, [
    'param([string]$Config, [string]$ServiceScript)',
    `$value = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json`,
    `@{ service = $value; serviceScript = $ServiceScript } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath '${record.replaceAll("'", "''")}'`,
    'if ($env:FAKE_RESTART_FAIL -eq "1") { exit 9 }',
    'exit 0',
  ].join('\n'))
  const request = join(root, 'deploy-request.json')
  writeFileSync(request, JSON.stringify({ confirmation: 'deploy', target: 'latest' }))
  const config = join(root, 'deploy.json')
  const settings = { checkout, requestPath: request, resultFile: join(root, 'result.json'), restartScript: restart,
    serviceHome: join(root, 'home'), serviceAgentsHome: join(root, 'agents'), serviceProfile: 'test-profile',
    url: 'http://127.0.0.1:39222', node: process.execPath,
    mechanical: { targetRevision: 'a'.repeat(40), fetch: false, observerStopCommand: 'exit 42', observerStartCommand: 'exit 42' } }
  writeFileSync(config, JSON.stringify(settings))
  return { root, checkout, record, restart, request, config, settings }
}

function run(config: string, args: string[] = [], env: Record<string, string> = {}) {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolvePromise => {
    execFile(process.execPath, [executor, '--config', config, ...args], { env: { ...process.env, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => resolvePromise({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr }))
  })
}

it('runs the independent mechanical restart with mapped service settings and archives the request', async () => {
  const value = fixture()
  const result = await run(value.config)
  expect(result.code).toBe(0)
  const called = JSON.parse(readFileSync(value.record, 'utf8'))
  expect(called.service).toMatchObject({ checkout: value.checkout, home: value.settings.serviceHome,
    agentsHome: value.settings.serviceAgentsHome, profile: 'test-profile', url: value.settings.url, node: process.execPath })
  expect(called.serviceScript).toBe(join(value.checkout, 'scripts', 'dsh-superagent.ps1'))
  expect(JSON.parse(readFileSync(value.settings.resultFile, 'utf8'))).toMatchObject({ ok: true, phase: 'completed' })
  expect(existsSync(value.request)).toBe(true)
  expect(existsSync(join(value.root, 'deploy-request.last.json'))).toBe(true)
  expect((await run(value.config)).stdout).toContain('already completed')
})

it('preserves a newer request written while deployment is running', async () => {
  const value = fixture()
  const newer = JSON.stringify({ confirmation: 'new request', target: 'latest' })
  const requestPath = value.request.replaceAll("'", "''")
  const requestText = newer.replaceAll("'", "''")
  writeFileSync(value.restart, `param($Config, $ServiceScript)\nSet-Content -NoNewline -LiteralPath '${requestPath}' -Value '${requestText}'\nexit 0\n`)
  expect((await run(value.config)).code).toBe(0)
  expect(readFileSync(value.request, 'utf8')).toBe(newer)
  expect(JSON.parse(readFileSync(join(value.root, 'deploy-request.last.json'), 'utf8')).confirmation).toBe('deploy')
  expect((await run(value.config)).code).toBe(0)
  expect(JSON.parse(readFileSync(value.settings.resultFile, 'utf8')).request.confirmation).toBe('new request')
})

it('preserves service settings while explicit deployment fields override without leaking them', async () => {
  const value = fixture()
  mkdirSync(value.settings.serviceHome, { recursive: true })
  writeFileSync(join(value.settings.serviceHome, 'service.json'), JSON.stringify({
    path: ['C:/mock/bin'], agentsHome: 'old-agents', profile: 'old-profile',
    deployRequest: 'mock-request', deployCommand: 'private-command-value', timeout: 45,
  }))
  const plan = await run(value.config, ['--plan'])
  expect(plan.stdout).not.toContain('private-command-value')
  const deployed = await run(value.config)
  expect(deployed.code).toBe(0)
  const called = JSON.parse(readFileSync(value.record, 'utf8'))
  expect(called.service).toMatchObject({ path: ['C:/mock/bin'], deployRequest: 'mock-request',
    deployCommand: 'private-command-value', timeout: 45, profile: 'test-profile', agentsHome: value.settings.serviceAgentsHome })
  expect(readFileSync(value.settings.resultFile, 'utf8')).not.toContain('private-command-value')
})

it('preserves the request and reports failure if the restart fails', async () => {
  const value = fixture()
  expect((await run(value.config, [], { FAKE_RESTART_FAIL: '1' })).code).toBe(1)
  expect(JSON.parse(readFileSync(value.settings.resultFile, 'utf8'))).toMatchObject({ ok: false, phase: 'restart_failed', exitCode: 9 })
  expect(existsSync(value.request)).toBe(true)
})

it('does not repeat a failed scheduled deployment through the Watchdog', async () => {
  const value = fixture()
  expect((await run(value.config, [], { FAKE_RESTART_FAIL: '1' })).code).toBe(1)
  rmSync(value.record)
  const digest = createHash('sha256').update(readFileSync(value.request)).digest('hex')
  const result = await run(value.config, [], { DSH_WATCHDOG_REQUEST_SHA256: digest })
  expect(result.code).toBe(1)
  expect(result.stdout).toContain('already failed')
  expect(existsSync(value.record)).toBe(false)
  expect((await run(value.config)).code).toBe(0)
})

it('rejects explicit old revisions and agent mode before executing anything', async () => {
  const value = fixture()
  writeFileSync(value.request, JSON.stringify({ confirmation: 'deploy', target: 'a'.repeat(40) }))
  const result = await run(value.config)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('invalid_target')
  expect((await run(value.config, ['--agent'])).stderr).toContain('agent_disabled')
  expect(existsSync(value.record)).toBe(false)
})

it('prints a plan without running the restart or archiving the request', async () => {
  const value = fixture()
  const result = await run(value.config, ['--plan'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, planOnly: true, target: 'latest' })
  expect(existsSync(value.record)).toBe(false)
  expect(existsSync(value.request)).toBe(true)
})

it('does not execute a request that differs from the Watchdog claim', async () => {
  const value = fixture()
  const result = await run(value.config, [], { DSH_WATCHDOG_REQUEST_SHA256: '0'.repeat(64) })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('request changed')
  expect(existsSync(value.request)).toBe(true)
  expect(existsSync(value.record)).toBe(false)
})

it('does nothing without a request and rejects concurrent deployment', async () => {
  const value = fixture()
  rmSync(value.request)
  expect((await run(value.config)).code).toBe(0)
  expect(existsSync(value.record)).toBe(false)
  writeFileSync(value.request, JSON.stringify({ confirmation: 'deploy' }))
  writeFileSync(`${value.settings.resultFile}.lock`, '')
  expect((await run(value.config)).stderr).toContain('deploy_locked')
  expect(existsSync(value.record)).toBe(false)
})
