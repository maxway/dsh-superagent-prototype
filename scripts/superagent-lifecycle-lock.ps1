param([string]$Payload = '')

function Get-SuperagentLifecycleMutex([string]$ServiceHome, [string]$Profile) {
  $identity = [System.IO.Path]::GetFullPath($ServiceHome).TrimEnd([char[]]'\/').ToUpperInvariant() + "`n" + $Profile.ToUpperInvariant()
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
  finally { $hash.Dispose() }
  return [System.Threading.Mutex]::new($false, "Global\dsh-superagent-lifecycle-$digest")
}

function Enter-SuperagentServiceLock {
  param([Parameter(Mandatory = $true)][string]$ServiceHome, [Parameter(Mandatory = $true)][string]$Profile)
  $acquired = [System.Collections.Generic.List[System.Threading.Mutex]]::new()
  $mutex = $null
  $locked = $false
  try {
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
      $pathsHelper = Get-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-paths.ps1') -Force -ErrorAction Stop
      if ($pathsHelper.PSIsContainer -or $pathsHelper.LinkType -or ($pathsHelper.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted runtime path helper must be a regular file.' }
      . $pathsHelper.FullName
      $physicalPath = Get-RuntimePhysicalDirectoryPath ([System.IO.Path]::GetFullPath($ServiceHome))
      $identity = $physicalPath.TrimEnd([char[]]'\/').ToUpperInvariant() + "`n" + $Profile.ToUpperInvariant()
      $hash = [System.Security.Cryptography.SHA256]::Create()
      try { $digest = [BitConverter]::ToString($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
      finally { $hash.Dispose() }
      $mutex = [System.Threading.Mutex]::new($false, "Global\dsh-superagent-service-physical-$digest")
      try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
      if (-not $locked) { throw 'Another deployment or recovery is already in progress.' }
      $acquired.Add($mutex)
      $mutex = $null
      $locked = $false
    }
    $mutex = Get-SuperagentLifecycleMutex $ServiceHome $Profile
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another deployment or recovery is already in progress.' }
    $acquired.Add($mutex)
    $mutex = $null
    return ,$acquired
  } catch {
    try {
      if ($null -ne $mutex) {
        try { if ($locked) { $mutex.ReleaseMutex() } } finally { $mutex.Dispose() }
      }
    } finally { Exit-SuperagentServiceLock $acquired }
    throw
  }
}

function Exit-SuperagentServiceLock {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[System.Threading.Mutex]]$Lock)
  $failure = $null
  for ($index = $Lock.Count - 1; $index -ge 0; $index--) {
    $mutex = $Lock[$index]
    try { $mutex.ReleaseMutex() } catch { if ($null -eq $failure) { $failure = $_ } }
    finally { $mutex.Dispose() }
  }
  $Lock.Clear()
  if ($null -ne $failure) { throw $failure }
}

if ($Payload) {
  $ErrorActionPreference = 'Stop'
  $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  $serviceLock = $null
  try {
    $serviceLock = Enter-SuperagentServiceLock $request.home $request.profile
    $env:DSH_SUPERAGENT_LIFECYCLE_LOCKED = '1'
    & $request.node $request.script @($request.arguments)
    exit $LASTEXITCODE
  } finally {
    if ($null -ne $serviceLock) { Exit-SuperagentServiceLock $serviceLock }
  }
}
