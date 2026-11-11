param(
  [string]$Config = (Join-Path $env:USERPROFILE '.dsh-superagent\service.json'),
  [string]$ServiceScript = (Join-Path $PSScriptRoot 'dsh-superagent.ps1'),
  [string]$ExpectedUrl = ''
)

$ErrorActionPreference = 'Stop'

$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$url = [uri]$settings.url
if ($url.Scheme -notin @('http', 'https') -or $url.Host -notin @('localhost', '127.0.0.1', '::1', '[::1]')) {
  throw 'The service URL must be a local HTTP(S) URL.'
}
if ($ExpectedUrl -and ([uri]$ExpectedUrl).AbsoluteUri.TrimEnd('/') -ne $url.AbsoluteUri.TrimEnd('/')) {
  throw 'The Watchdog URL does not match the service configuration.'
}
$serviceHome = if ($settings.home) { [string]$settings.home } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = if ($settings.profile) { [string]$settings.profile } elseif ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }
if ($profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'Invalid service profile.' }
. (Join-Path $PSScriptRoot 'superagent-lifecycle-lock.ps1')
$mutex = Get-SuperagentLifecycleMutex $serviceHome $profile
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { Write-Output 'Deployment or recovery is in progress; recovery skipped.'; exit 0 }
  $statusOutput = & pwsh -NoLogo -NoProfile -NonInteractive -File $ServiceScript status -Config $Config
  try { $status = $statusOutput | ConvertFrom-Json } catch { throw 'Cannot establish service process status.' }
  if ($null -eq $status -or $status.identity -ne 'listener' -or $status.manually_stopped -ne $false -or
      $status.home_matches -ne $true -or $null -eq $status.listener -or $null -eq $status.pids -or
      $null -eq $status.foreign -or $null -eq $status.unlistening -or
      @($status.listener).Count -or @($status.pids).Count -or @($status.foreign).Count -or @($status.unlistening).Count -or
      -not $status.start.pid -or (Get-Process -Id $status.start.pid -ErrorAction SilentlyContinue)) {
    Write-Output 'No confirmed crashed service process; recovery skipped.'
    exit 0
  }
  $env:DSH_SUPERAGENT_LIFECYCLE_LOCKED = '1'
  & pwsh -NoLogo -NoProfile -NonInteractive -File $ServiceScript start -Config $Config -UseInstalled -RespectStop
  exit $LASTEXITCODE
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
