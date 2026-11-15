import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const lockScript = fileURLToPath(new URL('../scripts/superagent-lifecycle-lock.ps1', import.meta.url))
const pathsScript = fileURLToPath(new URL('../scripts/runtime-paths.ps1', import.meta.url))
const command = `
  $ErrorActionPreference = 'Stop'
  . $env:LOCK_SCRIPT
  $lock = $null
  $legacy = $null
  try {
    if ($env:KIND -eq 'legacy') {
      $legacy = Get-SuperagentLifecycleMutex $env:HOME_PATH $env:PROFILE_NAME
      try { $locked = $legacy.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
      if (-not $locked) { throw 'busy' }
    } else {
      $lock = Enter-SuperagentServiceLock $env:HOME_PATH $env:PROFILE_NAME
    }
    [Console]::WriteLine('ACQUIRED')
    if ($env:HOLD -eq '1') { [Console]::ReadLine() | Out-Null }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
  } finally {
    if ($null -ne $lock) { Exit-SuperagentServiceLock $lock }
    if ($null -ne $legacy) { if ($locked) { $legacy.ReleaseMutex() }; $legacy.Dispose() }
  }
`
const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())))
const envFor = (home, kind = 'service', hold = false, profile = 'test') => ({
  ...baseEnv, HOME: dirname(home), USERPROFILE: dirname(home), LOCK_SCRIPT: lockScript, HOME_PATH: home, KIND: kind, HOLD: hold ? '1' : '0', PROFILE_NAME: profile,
})
const probe = (shell, home, kind = 'service', profile = 'test') => spawnSync(shell, args, { encoding: 'utf8', timeout: 30000, env: envFor(home, kind, false, profile) })

async function hold(shell, home, kind = 'service') {
  const child = spawn(shell, args, { env: envFor(home, kind, true), stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  await new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.includes('ACQUIRED')) resolve()
    })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`holder exited ${code}: ${stderr}`)))
  })
  return async () => {
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`holder exited ${code}: ${stderr}`)))
    })
    child.stdin.end('\n')
    await exited
  }
}

test('rejects a linked path helper before acquiring service locks', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'service-lock-helper-'))
  try {
    const control = join(root, 'control'), home = join(root, 'home'), target = join(root, 'outside')
    for (const directory of [control, home, target]) mkdirSync(directory)
    const copied = join(control, 'superagent-lifecycle-lock.ps1')
    copyFileSync(lockScript, copied)
    symlinkSync(target, join(control, 'runtime-paths.ps1'), 'junction')
    const result = spawnSync('pwsh', args, { encoding: 'utf8', timeout: 30000, env: { ...envFor(home), LOCK_SCRIPT: copied } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Trusted runtime path helper must be a regular file/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const shells = ['pwsh']
if (process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', env: baseEnv }).status === 0) shells.push('powershell.exe')

for (const shell of shells) {
  test(`${shell}: service lock coordinates aliases and legacy processes`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'service-lock-'))
    const home = join(root, 'home')
    const alias = join(root, 'alias')
    mkdirSync(home)
    if (process.platform === 'win32') symlinkSync(home, alias, 'junction')
    try {
      let release = await hold(shell, home)
      try {
        assert.notEqual(probe(shell, home).status, 0)
        assert.notEqual(probe(shell, home, 'legacy').status, 0)
        assert.equal(probe(shell, home, 'service', 'other').status, 0)
        if (process.platform === 'win32') {
          assert.notEqual(probe(shell, alias).status, 0)
          for (const otherShell of shells) assert.notEqual(probe(otherShell, alias).status, 0, `cross-shell: ${shell} to ${otherShell}`)
        }
      } finally { await release() }
      assert.equal(probe(shell, home).status, 0)
      const exceptionResult = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        . $env:LOCK_SCRIPT
        try {
          $lock = Enter-SuperagentServiceLock $env:HOME_PATH $env:PROFILE_NAME
          try { throw 'simulated caller failure' } finally { Exit-SuperagentServiceLock $lock }
        } catch { if ($_.Exception.Message -ne 'simulated caller failure') { throw } }
        $lock = Enter-SuperagentServiceLock $env:HOME_PATH $env:PROFILE_NAME
        Exit-SuperagentServiceLock $lock
      `], { encoding: 'utf8', timeout: 30000, env: envFor(home) })
      assert.equal(exceptionResult.status, 0, exceptionResult.stderr)
      if (process.platform === 'win32') {
        release = await hold(shell, home, 'legacy')
        try {
          assert.notEqual(probe(shell, home).status, 0)
          assert.equal(probe(shell, alias).status, 0, 'failed legacy acquisition must release physical mutex; old aliases do not coordinate')
        } finally { await release() }
        assert.notEqual(probe(shell, join(root, 'missing')).status, 0)
        const file = join(root, 'file')
        writeFileSync(file, 'not a directory')
        assert.notEqual(probe(shell, file).status, 0)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test(`${shell}: runtime path helpers work repeatedly`, { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'service-paths-'))
    try {
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        Set-StrictMode -Version Latest
        . $env:PATHS_SCRIPT
        . $env:PATHS_SCRIPT
        $physical = Get-RuntimePhysicalDirectoryPath $env:HOME_PATH
        $validated = Get-RuntimeValidatedDirectoryPath $env:HOME_PATH
        if ($physical -ne $validated) { throw 'resolved paths differ' }
      `], { encoding: 'utf8', timeout: 30000, env: { ...baseEnv, HOME: root, USERPROFILE: root, PATHS_SCRIPT: pathsScript, HOME_PATH: root } })
      assert.equal(result.status, 0, result.stderr)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
