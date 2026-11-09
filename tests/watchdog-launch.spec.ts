/** The windowless scheduled-task launcher starts the PowerShell launcher and keeps the agent's exit code. */
import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const launcher = join(import.meta.dirname, '..', 'scripts', 'watchdog-launch.vbs')
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
