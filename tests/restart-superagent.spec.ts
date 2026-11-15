import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const recoverScript = join(import.meta.dirname, '..', 'scripts', 'recover-superagent.ps1')
let directory: string | undefined
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const testEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase()))),
  HOME: directory, USERPROFILE: directory, DSH_HOME: directory, LUMOS_API_KEY: 'test-only',
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
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
  writeFileSync(config, JSON.stringify({ checkout: directory, home: directory, profile: 'recovery-test', node: process.execPath, url: 'http://127.0.0.1:19382' }))
  const wrapper = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.ps1')
  const result = spawnSync('pwsh', ['-NoProfile', '-File', wrapper, 'start', '-Config', config], { encoding: 'utf8', env: testEnvironment() })
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
  const result = spawnSync('pwsh', ['-NoProfile', '-File', wrapper, 'start', '-Config', config, '-UseInstalled', '-RespectStop'], { encoding: 'utf8', env: testEnvironment() })
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
  execFileSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', config, '-ServiceScript', mock], { env: testEnvironment() })
  expect(readFileSync(calls, 'utf8').trim()).toBe('start|True|True')
  rmSync(calls)
  const markerDir = join(directory, 'service', 'control', 'lifecycle')
  mkdirSync(markerDir, { recursive: true })
  writeFileSync(join(markerDir, '19382.maintenance'), 'unfinished deployment')
  const profileDir = join(directory, 'service', 'control', 'profiles', 'superagent')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'deployment.maintenance'), 'unfinished deployment')
  execFileSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', config, '-ServiceScript', mock], { env: testEnvironment() })
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
    execFileSync('pwsh', ['-NoProfile', '-File', recoverScript, '-Config', config, '-ServiceScript', mock], { env: testEnvironment() })
    expect(existsSync(calls)).toBe(false)
  }
})
