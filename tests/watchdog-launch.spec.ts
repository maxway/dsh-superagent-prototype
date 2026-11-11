/** The windowless observer launcher starts the PowerShell launcher with the task arguments and keeps its exit code. */
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const observerLauncher = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch-observer.vbs')
const observerPs = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch-observer.ps1')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it.skipIf(process.platform !== 'win32')('starts the sibling launch-observer.ps1 and keeps the observer exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-observer-'))
  directory = dir
  copyFileSync(observerLauncher, join(dir, 'launch-observer.vbs'))
  writeFileSync(join(dir, 'launch-observer.ps1'), [
    'param([string]$Config)',
    '"config=$Config" | Set-Content -LiteralPath (Join-Path $PSScriptRoot "args.txt")',
    'exit 7',
  ].join('\n'))
  const config = join(dir, 'observer config.json')
  const code = await new Promise<number | null>(resolve => {
    execFile('wscript.exe', [join(dir, 'launch-observer.vbs'), '-Config', config], { timeout: 30_000 }, error =>
      resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(7)
  expect(readFileSync(join(dir, 'args.txt'), 'utf8').trim()).toBe(`config=${config}`)
}, 30_000)

it.skipIf(process.platform !== 'win32')('records observer stderr and its exit before a successful retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-failure-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  const bootstraps = join(dir, 'bootstraps.txt')
  writeFileSync(join(dir, 'watchdog-bootstrap.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(bootstraps)}, 'bootstrap\\n')`)
  writeFileSync(join(dir, 'current.txt'), 'v1')
  const config = join(dir, 'observer.json')
  writeFileSync(config, '{}')
  mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
  const marker = join(dir, 'retried.txt')
  writeFileSync(join(dir, 'versions', 'v1', 'watchdog'), `const fs = require('fs')
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'failed')
  process.stderr.write('simulated observer failure\\n')
  process.exit(9)
}
process.stderr.write('simulated clean stop\\n')
`)
  const result = await new Promise<{ code: number | null; error: string; stdout: string; stderr: string }>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'), '-Config', config],
      { timeout: 30_000 }, (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        error: error?.message ?? '', stdout, stderr,
      }))
  })
  let log = ''
  try { log = readFileSync(join(dir, 'launch-observer.log'), 'utf8') } catch {}
  expect(result.code, JSON.stringify({ ...result, log })).toBe(0)
  expect(log).toContain('observer output version=v1 simulated observer failure')
  expect(log).toContain('observer exit=9 version=v1')
  expect(readFileSync(bootstraps, 'utf8').trim().split(/\r?\n/)).toEqual(['bootstrap', 'bootstrap'])
  expect(log).toContain('observer output version=v1 simulated clean stop')
  expect(log).toContain('observer exit=0 version=v1')
}, 30_000)

it.skipIf(process.platform !== 'win32')('records launcher configuration failure and exits with code 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-invalid-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  const code = await new Promise<number | null>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'),
      '-Config', join(dir, 'missing.json')], { timeout: 30_000 }, error =>
      resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(2)
  expect(readFileSync(join(dir, 'launch-observer.log'), 'utf8')).toContain('configuration does not exist')
}, 30_000)

it.skipIf(process.platform !== 'win32')('reports a configuration failure even when the log cannot be written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-unwritable-log-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  mkdirSync(join(dir, 'launch-observer.log'))
  const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'),
      '-Config', join(dir, 'missing.json')], { timeout: 30_000 }, (error, _stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr }))
  })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('configuration does not exist')
}, 30_000)

it.skipIf(process.platform !== 'win32')('runs the observer even when the log cannot be written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-unwritable-output-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  mkdirSync(join(dir, 'launch-observer.log'))
  writeFileSync(join(dir, 'watchdog-bootstrap.mjs'), 'process.exit(0)')
  writeFileSync(join(dir, 'current.txt'), 'v1')
  const config = join(dir, 'observer.json')
  writeFileSync(config, '{}')
  mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
  const marker = join(dir, 'observer-ran.txt')
  writeFileSync(join(dir, 'versions', 'v1', 'watchdog'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  const code = await new Promise<number | null>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'), '-Config', config],
      { timeout: 30_000 }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(0)
  expect(readFileSync(marker, 'utf8')).toBe('ran')
}, 30_000)

it.skipIf(process.platform !== 'win32')('fails rather than launching the old observer when bootstrap fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-bootstrap-failure-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  writeFileSync(join(dir, 'watchdog-bootstrap.mjs'), 'process.stderr.write("remote unavailable\\n"); process.exit(1)')
  writeFileSync(join(dir, 'current.txt'), 'v1')
  const config = join(dir, 'observer.json')
  writeFileSync(config, '{}')
  mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
  const marker = join(dir, 'observer-ran.txt')
  writeFileSync(join(dir, 'versions', 'v1', 'watchdog'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  const code = await new Promise<number | null>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'), '-Config', config],
      { timeout: 10_000 }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(2)
  expect(readFileSync(join(dir, 'launch-observer.log'), 'utf8')).toMatch(/remote unavailable|bootstrap failed/i)
  expect(() => readFileSync(marker)).toThrow()
}, 15_000)

it.skipIf(process.platform !== 'win32')('starts the transaction version without waiting for the updater lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-transaction-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'watchdog-bootstrap.mjs'), join(dir, 'watchdog-bootstrap.mjs'))
  writeFileSync(join(dir, 'current.txt'), 'v1')
  const config = join(dir, 'observer.json')
  writeFileSync(config, '{}')
  mkdirSync(join(dir, 'update.lock'))
  writeFileSync(join(dir, 'update.lock', 'owner.json'), JSON.stringify({ pid: process.pid }))
  writeFileSync(join(dir, 'update.lock', 'launch-version.txt'), 'v1')
  mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
  const marker = join(dir, 'observer-ran.txt')
  writeFileSync(join(dir, 'versions', 'v1', 'watchdog'), `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(9) }\n`)
  const code = await new Promise<number | null>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'), '-Config', config],
      { timeout: 30_000 }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(0)
  expect(readFileSync(marker, 'utf8')).toBe('ran')
  const log = readFileSync(join(dir, 'launch-observer.log'), 'utf8')
  expect(log).toContain('observer exit=9 version=v1')
  expect(log).toContain('observer exit=0 version=v1')
}, 35_000)

it.skip('runs the current observer version through the PowerShell launcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-observer-ps-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
  writeFileSync(join(dir, 'watchdog-bootstrap.mjs'), 'process.exit(0)')
  writeFileSync(join(dir, 'current.txt'), 'v1')
  const config = join(dir, 'observer.json')
  writeFileSync(config, '{}')
  mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
  const marker = join(dir, 'observer-ran.txt')
  writeFileSync(join(dir, 'versions', 'v1', 'watchdog'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  const code = await new Promise<number | null>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-observer.ps1'), '-Config', config],
      { timeout: 30_000 }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(0)
  expect(readFileSync(marker, 'utf8')).toBe('ran')
}, 30_000)