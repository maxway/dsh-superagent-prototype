import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/runtime-paths.ps1', import.meta.url))
const shell = (command, env = {}) => spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env, RUNTIME_PATHS_SCRIPT: script } })

test('resolves local directory handles and compares physical ancestors', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-paths-'))
  try {
    const parent = join(root, 'parent')
    const child = join(parent, 'child')
    const sibling = join(root, 'parent-other')
    const alias = join(root, 'alias')
    mkdirSync(child, { recursive: true })
    mkdirSync(sibling)
    symlinkSync(parent, alias, 'junction')
    writeFileSync(join(root, 'file'), 'not a directory')
    const result = shell(`
      $ErrorActionPreference = 'Stop'
      . $env:RUNTIME_PATHS_SCRIPT
      $parent = Get-RuntimePhysicalDirectoryPath $env:PARENT
      $child = Get-RuntimePhysicalDirectoryPath $env:CHILD
      $alias = Get-RuntimePhysicalDirectoryPath $env:ALIAS
      $aliasChild = Get-RuntimePhysicalDirectoryPath (Join-Path $env:ALIAS 'child')
      $sibling = Get-RuntimePhysicalDirectoryPath $env:SIBLING
      $volumeRoot = $parent.Substring(0, $parent.IndexOf('}') + 2)
      $rejected = foreach ($path in @($env:MISSING, $env:FILE, 'relative', '\\\\server\\share', '\\\\?\\C:\\')) {
        try { Get-RuntimePhysicalDirectoryPath $path | Out-Null; $false } catch { $true }
      }
      $invalidComparison = try { Test-RuntimeDirectoryAncestor $parent ($parent + '\\..\\other') | Out-Null; $false } catch { $true }
      $otherVolume = '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\'
      $otherVolumeRejected = try { Test-RuntimeDirectoryAncestor $otherVolume $child | Out-Null; $false } catch { $true }
      @{ parent=$parent; child=$child; alias=$alias; aliasChild=$aliasChild; sibling=$sibling; volumeRoot=$volumeRoot; same=(Test-RuntimeDirectoryAncestor $parent $alias); descendant=(Test-RuntimeDirectoryAncestor $parent $child); siblingRejected=(-not (Test-RuntimeDirectoryAncestor $parent $sibling)); reverseRejected=(-not (Test-RuntimeDirectoryAncestor $child $parent)); rootContains=(Test-RuntimeDirectoryAncestor $volumeRoot $child); rootSame=(Test-RuntimeDirectoryAncestor $volumeRoot $volumeRoot); otherVolumeRejected=$otherVolumeRejected; caseOverlap=(Test-RuntimeDirectoryAncestor ($volumeRoot + 'Parent') ($volumeRoot + 'parent\\child')); invalidComparison=$invalidComparison; rejected=@($rejected) } | ConvertTo-Json -Compress
    `, { PARENT: parent, CHILD: child, ALIAS: alias, SIBLING: sibling, MISSING: join(root, 'missing'), FILE: join(root, 'file') })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout.trim())
    assert.match(output.parent, /^\\\\\?\\Volume\{[0-9a-f-]+\}\\/i)
    assert.equal(output.alias.toLowerCase(), output.parent.toLowerCase())
    assert.equal(output.aliasChild.toLowerCase(), output.child.toLowerCase())
    for (const key of ['same', 'descendant', 'siblingRejected', 'reverseRejected', 'rootContains', 'rootSame', 'otherVolumeRejected', 'caseOverlap', 'invalidComparison']) assert.equal(output[key], true, key)
    assert.deepEqual(output.rejected, [true, true, true, true, true])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validates every existing directory without following reparse points', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-paths-chain-'))
  try {
    const parent = join(root, 'parent')
    const child = join(parent, 'child')
    const sibling = join(root, 'parent-other')
    const alias = join(root, 'alias')
    mkdirSync(child, { recursive: true })
    mkdirSync(sibling)
    symlinkSync(parent, alias, 'junction')
    writeFileSync(join(root, 'file'), 'not a directory')
    const result = shell(`
      $ErrorActionPreference = 'Stop'
      . $env:RUNTIME_PATHS_SCRIPT
      $parent = Get-RuntimeValidatedDirectoryPath $env:PARENT
      $child = Get-RuntimeValidatedDirectoryPath $env:CHILD
      $sibling = Get-RuntimeValidatedDirectoryPath $env:SIBLING
      $driveRoot = [System.IO.Path]::GetPathRoot($env:PARENT)
      $physicalRoot = Get-RuntimeValidatedDirectoryPath $driveRoot
      $rejected = foreach ($path in @($env:ALIAS, (Join-Path $env:ALIAS 'child'), $env:FILE, $env:MISSING, 'relative', '\\\\server\\share', '\\\\?\\C:\\', (Join-Path $env:ALIAS '..\\parent'))) {
        try { Get-RuntimeValidatedDirectoryPath $path | Out-Null; $false } catch { $true }
      }
      $reparseErrors = foreach ($path in @($env:ALIAS, (Join-Path $env:ALIAS 'child'))) {
        try { Get-RuntimeValidatedDirectoryPath $path | Out-Null; '' } catch { $_.Exception.Message }
      }
      $otherVolume = '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\'
      $crossVolumeRejected = try { Test-RuntimeDirectoryAncestor $otherVolume $child | Out-Null; $false } catch { $true }
      @{ same=(Test-RuntimeDirectoryAncestor $parent (Get-RuntimeValidatedDirectoryPath $env:PARENT)); descendant=(Test-RuntimeDirectoryAncestor $parent $child); caseOverlap=(Test-RuntimeDirectoryAncestor $parent.ToUpperInvariant() $child.ToLowerInvariant()); siblingRejected=(-not (Test-RuntimeDirectoryAncestor $parent $sibling)); rootContains=(Test-RuntimeDirectoryAncestor $physicalRoot $child); rootSame=(Test-RuntimeDirectoryAncestor $physicalRoot $physicalRoot); crossVolumeRejected=$crossVolumeRejected; rejected=@($rejected); reparseErrors=@($reparseErrors) } | ConvertTo-Json -Compress
    `, { PARENT: parent, CHILD: child, SIBLING: sibling, ALIAS: alias, FILE: join(root, 'file'), MISSING: join(root, 'missing') })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout.trim())
    for (const key of ['same', 'descendant', 'caseOverlap', 'siblingRejected', 'rootContains', 'rootSame', 'crossVolumeRejected']) assert.equal(output[key], true, key)
    assert.deepEqual(output.rejected, [true, true, true, true, true, true, true, true])
    for (const error of output.reparseErrors) assert.match(error, /Reparse points are not supported/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails closed when directory attributes are inaccessible', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-paths-acl-'))
  const denied = join(root, 'denied')
  mkdirSync(denied)
  const identity = shell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
  assert.equal(identity.status, 0, identity.stderr)
  const sid = identity.stdout.trim()
  assert.match(sid, /^S-1-/)
  try {
    const deny = spawnSync('icacls.exe', [denied, '/deny', `*${sid}:(F)`], { encoding: 'utf8' })
    assert.equal(deny.status, 0, deny.stderr || deny.stdout)
    const result = shell(". $env:RUNTIME_PATHS_SCRIPT; Get-RuntimePhysicalDirectoryPath $env:DENIED", { DENIED: denied })
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stderr, /Cannot open directory/i)
    const validated = shell(". $env:RUNTIME_PATHS_SCRIPT; Get-RuntimeValidatedDirectoryPath $env:DENIED", { DENIED: denied })
    assert.notEqual(validated.status, 0, validated.stdout)
    assert.match(validated.stderr, /Cannot open directory/i)
  } finally {
    const restore = spawnSync('icacls.exe', [denied, '/remove:d', `*${sid}`], { encoding: 'utf8' })
    assert.equal(restore.status, 0, restore.stderr || restore.stdout)
    rmSync(root, { recursive: true, force: true })
  }
})
