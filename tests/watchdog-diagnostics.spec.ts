import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'watchdog-diagnostics.ps1')

it.skipIf(process.platform !== 'win32')('filters task events and preserves channel failures', async () => {
  const command = `
function Get-WinEvent {
  param($ListLog, $FilterHashtable, $MaxEvents, $ErrorAction)
  if ($ListLog -eq 'Security') { throw 'access denied' }
  if ($ListLog) { return [pscustomobject]@{ IsEnabled = $false } }
  foreach ($name in @('dsh-superagent-watchdog-observer', 'other-task')) {
    $event = [pscustomobject]@{ TimeCreated = [datetime]::UtcNow; Id = 100; RecordId = 1; Name = $name }
    $event | Add-Member ScriptMethod ToXml { return "<Event><EventData><Data Name='TaskName'>$($this.Name)</Data></EventData></Event>" }
    $event
  }
}
& '${script.replace(/'/g, "''")}' -Hours 1
`
  const output = await new Promise<string>((resolve, reject) => {
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout))
  })
  const result = JSON.parse(output)
  expect(result.sources[0].enabled).toBe(false)
  expect(result.sources[0].events).toHaveLength(1)
  expect(result.sources[0].events[0].fields.TaskName).toBe('dsh-superagent-watchdog-observer')
  expect(result.sources[1].error).toContain('access denied')
})
