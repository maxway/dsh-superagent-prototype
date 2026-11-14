import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'restart-superagent.ps1')
const updateScript = join(import.meta.dirname, '..', 'scripts', 'update-superagent.ps1')
const recoverScript = join(import.meta.dirname, '..', 'scripts', 'recover-superagent.ps1')
let directory: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

async function fixture(status: number, superagent = true) {
  directory = mkdtempSync(join(tmpdir(), 'restart-superagent-'))
  const config = join(directory, 'service.json')
  const mock = join(directory, 'service.ps1')
  const calls = join(directory, 'calls.txt')
  const update = join(directory, 'update.ps1')
  const requests: string[] = []
  const stopped = join(directory, 'stopped')
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers['x-orchestrator-request']}`)
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        .end(JSON.stringify({ health: { runtime: { state: 'ready' }, ...(superagent ? { assessment: { state: 'ready' } } : {}) } }))
      return
    }
    response.writeHead(status, { connection: 'close' }).end()
    if (status === 200) { writeFileSync(stopped, 'stopped'); server?.close() }
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${port}`, checkout: directory, home: directory }))
  writeFileSync(mock, `param($Action, $Config, [switch]$UseInstalled)\nif ($Action -eq 'status') {\n  if (Test-Path -LiteralPath '${stopped.replaceAll("'", "''")}') { '{"identity":"listener","home_matches":true,"listener":[],"pids":[],"foreign":[],"unlistening":[]}' }\n  else { '{"identity":"listener","home_matches":true,"listener":[1234],"pids":[1234],"foreign":[],"unlistening":[],"start":{"pid":1234}}' }\n  exit 0\n}\nAdd-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value "$Action|$Config|$UseInstalled"\nexit 0\n`)
  writeFileSync(update, `param($Checkout)\nAdd-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value "update|$Checkout"\nexit 0\n`)
  return { config, mock, update, calls, requests }
}

function run(config: string, mock: string, update: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-File', script, '-Config', config, '-ServiceScript', mock, '-UpdateScript', update], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', resolve)
  })
}

it.skipIf(process.platform !== 'win32')('requests the server to stop before starting', async () => {
  const value = await fixture(200)
  expect(await run(value.config, value.mock, value.update)).toBe(0)
  expect(value.requests).toEqual(['GET /orchestrator/api/state 1', 'POST /orchestrator/api/service/stop 1'])
  expect(readFileSync(value.calls, 'utf8').trim().split(/\r?\n/)).toEqual([`update|${directory}`, `start|${value.config}|True`])
  const port = new URL(JSON.parse(readFileSync(value.config, 'utf8')).url).port
  expect(existsSync(join(directory!, 'service', 'control', 'lifecycle', `${port}.maintenance`))).toBe(false)
}, 30000)

it.skipIf(process.platform !== 'win32').each([2, 3, 1])('preserves startup exit %i without creating maintenance markers', async code => {
  const value = await fixture(200)
  writeFileSync(value.mock, readFileSync(value.mock, 'utf8').replace(/exit 0\n$/, `exit ${code}\n`))
  expect(await run(value.config, value.mock, value.update)).toBe(code)
  const port = new URL(JSON.parse(readFileSync(value.config, 'utf8')).url).port
  for (const marker of [join(directory!, 'service', 'control', 'lifecycle', `${port}.maintenance`),
    join(directory!, 'service', 'control', 'profiles', 'superagent', 'deployment.maintenance')]) {
    expect(existsSync(marker)).toBe(false)
  }
}, 30000)

it.skipIf(process.platform !== 'win32')('uses configured PATH for the update tools', async () => {
  const value = await fixture(200)
  const settings = JSON.parse(readFileSync(value.config, 'utf8'))
  settings.path = [directory]
  writeFileSync(value.config, JSON.stringify(settings))
  writeFileSync(value.update, `param($Checkout)\nSet-Content -LiteralPath '${value.calls.replaceAll("'", "''")}' -Value $env:PATH\nexit 0\n`)
  expect(await run(value.config, value.mock, value.update)).toBe(0)
  expect((readFileSync(value.calls, 'utf8').split(/\r?\n/)[0] ?? '').split(';')).toContain(directory)
}, 30000)

it.skipIf(process.platform !== 'win32')('does not start when updating fails', async () => {
  const value = await fixture(200)
  writeFileSync(value.update, 'param($Checkout)\nexit 7\n')
  expect(await run(value.config, value.mock, value.update)).toBe(7)
  expect(() => readFileSync(value.calls, 'utf8')).toThrow()
  const port = new URL(JSON.parse(readFileSync(value.config, 'utf8')).url).port
  expect(existsSync(join(directory!, 'service', 'control', 'lifecycle', `${port}.maintenance`))).toBe(false)
}, 30000)

it.skipIf(process.platform !== 'win32')('refuses a different profile listener or an unlistening service before stopping', async () => {
  const value = await fixture(200)
  for (const status of [
    { identity: 'listener', home_matches: true, listener: [1234], pids: [], foreign: [{ pid: 1234 }], unlistening: [] },
    { identity: 'listener', home_matches: true, listener: [1234], pids: [1234], foreign: [], unlistening: [5678] },
    { identity: 'listener', home_matches: false, listener: [1234], pids: [1234], foreign: [], unlistening: [] },
    { identity: 'listener', home_matches: true, listener: [1234], pids: [1234], foreign: [], unlistening: [] },
    { identity: 'listener', home_matches: true, listener: [1234], pids: [1234], foreign: [], unlistening: [], start: { pid: 5678 } },
  ]) {
    writeFileSync(value.mock, `param($Action, $Config)\n'${JSON.stringify(status)}'\n`)
    expect(await run(value.config, value.mock, value.update)).not.toBe(0)
    expect(value.requests).toEqual([])
    expect(existsSync(value.calls)).toBe(false)
  }
}, 30000)

it.skipIf(process.platform !== 'win32')('does not stop another service listening on the configured port', async () => {
  const value = await fixture(200, false)
  expect(await run(value.config, value.mock, value.update)).not.toBe(0)
  expect(value.requests).toEqual(['GET /orchestrator/api/state 1'])
  expect(() => readFileSync(value.calls, 'utf8')).toThrow()
}, 30000)

it.skipIf(process.platform !== 'win32')('does not start when the stop request fails', async () => {
  const value = await fixture(503)
  expect(await run(value.config, value.mock, value.update)).not.toBe(0)
  expect(value.requests).toEqual(['GET /orchestrator/api/state 1', 'POST /orchestrator/api/service/stop 1'])
  expect(() => readFileSync(value.calls, 'utf8')).toThrow()
}, 30000)

it.skipIf(process.platform !== 'win32')('excludes recovery during a deployment update', async () => {
  const value = await fixture(200)
  const started = join(directory!, 'update-started')
  const release = join(directory!, 'release-update')
  writeFileSync(value.update, `param($Checkout)\nSet-Content -LiteralPath '${started.replaceAll("'", "''")}' -Value 'started'\nwhile (-not (Test-Path -LiteralPath '${release.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 50 }\n`)
  const guardServer = createServer((_request, response) => response.writeHead(503).end())
  await new Promise<void>(resolve => guardServer.listen(0, '127.0.0.1', resolve))
  const guardUrl = `http://127.0.0.1:${(guardServer.address() as AddressInfo).port}`
  const deploying = run(value.config, value.mock, value.update)
  try {
    const deadline = Date.now() + 15000
    while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(started)).toBe(true)
    const result = spawnSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', value.config, '-ServiceScript', value.mock], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('in progress')
    for (const action of ['start', 'restart', 'stop']) {
      const direct = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), action,
        '--home', directory!, '--profile', 'superagent', '--url', guardUrl], { encoding: 'utf8' })
      expect(direct.status).not.toBe(0)
      expect(direct.stderr).toContain('in progress')
    }
    expect(existsSync(value.calls)).toBe(false)
  } finally {
    writeFileSync(release, 'release')
    guardServer.close()
    expect(await deploying).toBe(0)
  }
}, 30000)

it.skipIf(process.platform !== 'win32')('pulls latest and builds after installing locked dependencies', () => {
  directory = mkdtempSync(join(tmpdir(), 'update-superagent-'))
  const calls = join(directory, 'calls.txt')
  writeFileSync(join(directory, 'git.cmd'), '@echo off\r\necho git %*>>"%TEST_CALLS%"\r\nexit /b 0\r\n')
  writeFileSync(join(directory, 'pnpm.cmd'), '@echo off\r\necho pnpm %*>>"%TEST_CALLS%"\r\nexit /b 0\r\n')
  const env = { ...process.env, PATH: `${directory};${process.env.PATH}`, TEST_CALLS: calls }
  execFileSync('pwsh', ['-NoProfile', '-File', updateScript, '-Checkout', directory], { env })
  const lines = readFileSync(calls, 'utf8').trim().split(/\r?\n/)
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain('pull --ff-only origin main')
  expect(lines[1]).toContain('install --frozen-lockfile')
  expect(lines[2]).toContain('build')
})

it.skipIf(process.platform !== 'win32')('does not build when pulling latest fails', () => {
  directory = mkdtempSync(join(tmpdir(), 'update-superagent-'))
  const calls = join(directory, 'calls.txt')
  writeFileSync(join(directory, 'git.cmd'), '@echo off\r\nexit /b 7\r\n')
  writeFileSync(join(directory, 'pnpm.cmd'), '@echo off\r\necho pnpm>>"%TEST_CALLS%"\r\nexit /b 0\r\n')
  const env = { ...process.env, PATH: `${directory};${process.env.PATH}`, TEST_CALLS: calls }
  const result = spawnSync('pwsh', ['-NoProfile', '-File', updateScript, '-Checkout', directory], { env })
  expect(result.status).toBe(7)
  expect(() => readFileSync(calls, 'utf8')).toThrow()
})

it.skipIf(process.platform !== 'win32').each([0, 2, 3, 1])('normal start ignores old maintenance markers for result %i', code => {
  directory = mkdtempSync(join(tmpdir(), 'maintenance-markers-'))
  const scripts = join(directory, 'scripts')
  const config = join(directory, 'config.json')
  const portMarker = join(directory, 'service', 'control', 'lifecycle', '19382.maintenance')
  const profileMarker = join(directory, 'service', 'control', 'profiles', 'recovery-test', 'deployment.maintenance')
  mkdirSync(scripts)
  mkdirSync(join(directory, 'service', 'control', 'lifecycle'), { recursive: true })
  writeFileSync(portMarker, 'failed deployment')
  writeFileSync(join(scripts, 'dsh-superagent'), `if (process.argv[2] === 'status') console.log(JSON.stringify({ identity: 'listener', pids: [], foreign: [], unlistening: [] })); else process.exit(${code})`)
  writeFileSync(join(scripts, 'update-superagent.ps1'), 'param($Checkout)\nexit 0\n')
  writeFileSync(config, JSON.stringify({ checkout: directory, home: directory, profile: 'recovery-test', node: process.execPath, url: 'http://127.0.0.1:19382' }))
  const wrapper = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.ps1')
  const result = spawnSync('pwsh', ['-NoProfile', '-File', wrapper, 'start', '-Config', config], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(code)
  expect(existsSync(portMarker)).toBe(true)
  expect(existsSync(profileMarker)).toBe(false)
})

it.skipIf(process.platform !== 'win32')('passes the recovery flag to the control script rather than Node', () => {
  directory = mkdtempSync(join(tmpdir(), 'recovery-arguments-'))
  const scripts = join(directory, 'scripts')
  const calls = join(directory, 'arguments.json')
  const config = join(directory, 'config.json')
  mkdirSync(scripts)
  writeFileSync(join(scripts, 'dsh-superagent'), `require('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)))`)
  writeFileSync(config, JSON.stringify({ checkout: directory, home: directory, profile: 'recovery-test', node: process.execPath, url: 'http://127.0.0.1:19382' }))
  const marker = join(directory, 'service', 'control', 'profiles', 'recovery-test', 'deployment.maintenance')
  mkdirSync(join(directory, 'service', 'control', 'profiles', 'recovery-test'), { recursive: true })
  writeFileSync(marker, 'failed deployment')
  const wrapper = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.ps1')
  const result = spawnSync('pwsh', ['-NoProfile', '-File', wrapper, 'start', '-Config', config, '-UseInstalled', '-RespectStop'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(calls, 'utf8'))).toContain('--respect-stop')
  expect(existsSync(marker)).toBe(true)
})

it.skipIf(process.platform !== 'win32')('crash recovery starts the installed version without updating', () => {
  directory = mkdtempSync(join(tmpdir(), 'recover-superagent-'))
  const calls = join(directory, 'calls.txt')
  const mock = join(directory, 'service.ps1')
  const config = join(directory, 'config.json')
  writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:19382', home: directory }))
  writeFileSync(mock, `param($Action, $Config, [switch]$UseInstalled, [switch]$RespectStop)\nif ($Action -eq 'status') { '{"identity":"listener","manually_stopped":false,"home_matches":true,"listener":[],"pids":[],"foreign":[],"unlistening":[],"start":{"pid":99999999}}'; exit 1 }\nSet-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value "$Action|$UseInstalled|$RespectStop"\n`)
  execFileSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', config, '-ServiceScript', mock])
  expect(readFileSync(calls, 'utf8').trim()).toBe('start|True|True')
  rmSync(calls)
  const markerDir = join(directory, 'service', 'control', 'lifecycle')
  mkdirSync(markerDir, { recursive: true })
  writeFileSync(join(markerDir, '19382.maintenance'), 'unfinished deployment')
  const profileDir = join(directory, 'service', 'control', 'profiles', 'superagent')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'deployment.maintenance'), 'unfinished deployment')
  execFileSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', config, '-ServiceScript', mock])
  expect(readFileSync(calls, 'utf8').trim()).toBe('start|True|True')
})

it.skipIf(process.platform !== 'win32')('does not recover on API errors while a process is alive or the service was stopped', () => {
  directory = mkdtempSync(join(tmpdir(), 'recover-superagent-status-'))
  const calls = join(directory, 'calls.txt')
  const mock = join(directory, 'service.ps1')
  const config = join(directory, 'config.json')
  writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:19383', home: directory }))
  for (const status of [
    { identity: 'listener', manually_stopped: false, home_matches: true, listener: [process.pid], pids: [process.pid], foreign: [], unlistening: [], start: { pid: process.pid } },
    { identity: 'listener', manually_stopped: true, home_matches: true, listener: [], pids: [], foreign: [], unlistening: [], start: { pid: 99999999 } },
    { identity: 'scan', manually_stopped: false, home_matches: true, listener: null, pids: [], foreign: [], unlistening: [], start: { pid: 99999999 } },
  ]) {
    writeFileSync(mock, `param($Action, $Config)\nif ($Action -eq 'status') { '${JSON.stringify(status)}'; exit 1 }\nSet-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value 'started'\n`)
    execFileSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', config, '-ServiceScript', mock])
    expect(existsSync(calls)).toBe(false)
  }
})
