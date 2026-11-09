/** The windowless scheduled-task launcher starts the PowerShell launcher and keeps the agent's exit code. */
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const launcher = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch.vbs')
const observerLauncher = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch-observer.vbs')
const agentPs = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch.ps1')
const observerPs = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch-observer.ps1')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it.skipIf(process.platform !== 'win32')('starts the sibling launch-agent.ps1 with the task arguments and its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-'))
  directory = dir
  copyFileSync(launcher, join(dir, 'launch-agent.vbs'))
  writeFileSync(join(dir, 'launch-agent.ps1'), [
    'param([string]$Config)',
    '"config=$Config" | Set-Content -LiteralPath (Join-Path $PSScriptRoot "args.txt")',
    'exit 7',
  ].join('\n'))
  const config = join(dir, 'agent config.json')
  const code = await new Promise<number | null>(resolve => {
    execFile('wscript.exe', [join(dir, 'launch-agent.vbs'), '-Config', config], { timeout: 30_000 }, error =>
      resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(7)
  expect(readFileSync(join(dir, 'args.txt'), 'utf8').trim()).toBe(`config=${config}`)
}, 30_000)

it.skipIf(process.platform !== 'win32')('runs the current observer version through the PowerShell launcher', async () => {
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

it.skipIf(process.platform !== 'win32')('runs the current agent version through the PowerShell launcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-launch-agent-ps-'))
  directory = dir
  copyFileSync(agentPs, join(dir, 'launch-agent.ps1'))
  writeFileSync(join(dir, 'current.txt'), 'v1')
  const config = join(dir, 'agent.json')
  writeFileSync(config, '{}')
  mkdirSync(join(dir, 'versions', 'v1', 'agent'), { recursive: true })
  const marker = join(dir, 'agent-ran.txt')
  writeFileSync(join(dir, 'versions', 'v1', 'agent', 'run.ps1'), [
    'param([string]$Config)',
    `Set-Content -LiteralPath ${JSON.stringify(marker)} -Value 'ran'`,
    'exit 0',
  ].join('\n'))
  const code = await new Promise<number | null>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dir, 'launch-agent.ps1'), '-Config', config],
      { timeout: 30_000 }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0))
  })
  expect(code).toBe(0)
  expect(readFileSync(marker, 'utf8').trim()).toBe('ran')
}, 30_000)

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
