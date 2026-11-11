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

it.skip('runs the current observer version through the PowerShell launcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-observer-ps-'))
  directory = dir
  copyFileSync(observerPs, join(dir, 'launch-observer.ps1'))
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