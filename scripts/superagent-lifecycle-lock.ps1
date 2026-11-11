param([string]$Payload = '')

function Get-SuperagentLifecycleMutex([string]$ServiceHome, [string]$Profile) {
  $identity = [System.IO.Path]::GetFullPath($ServiceHome).TrimEnd([char[]]'\/').ToUpperInvariant() + "`n" + $Profile.ToUpperInvariant()
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
  finally { $hash.Dispose() }
  return [System.Threading.Mutex]::new($false, "Global\dsh-superagent-lifecycle-$digest")
}

if ($Payload) {
  $ErrorActionPreference = 'Stop'
  $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  $mutex = Get-SuperagentLifecycleMutex $request.home $request.profile
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another deployment or recovery is already in progress.' }
    $marker = Join-Path $request.home "service\control\profiles\$($request.profile)\deployment.maintenance"
    if (@($request.arguments) -contains '--respect-stop' -and $request.update) {
      $legacy = Join-Path (Split-Path -Parent (Split-Path -Parent $request.script)) ".artifacts\control\profiles\$($request.profile)\manually-stopped"
      $stopped = Join-Path $request.home "service\control\profiles\$($request.profile)\manually-stopped"
      if ((Test-Path -LiteralPath $stopped) -or (Test-Path -LiteralPath $legacy)) {
        Write-Output 'Intentional stop is active; automatic recovery skipped.'
        exit 0
      }
    }
    if ($request.update) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
      Set-Content -LiteralPath $marker -Value "Deployment started $(Get-Date -Format o); retry deployment after failure."
    }
    $env:DSH_SUPERAGENT_LIFECYCLE_LOCKED = '1'
    & $request.node $request.script @($request.arguments)
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($request.update) { Remove-Item -LiteralPath $marker -Force }
    exit 0
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
