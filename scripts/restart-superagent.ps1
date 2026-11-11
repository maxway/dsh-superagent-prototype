param(
  [string]$Config = (Join-Path $env:USERPROFILE '.dsh-superagent\service.json'),
  [string]$ServiceScript = (Join-Path $PSScriptRoot 'dsh-superagent.ps1'),
  [string]$UpdateScript = (Join-Path $PSScriptRoot 'update-superagent.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "Service configuration not found: $Config" }
if (-not (Test-Path -LiteralPath $ServiceScript -PathType Leaf)) { throw "Service script not found: $ServiceScript" }

$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$pathEntries = @($settings.path | Where-Object { $_ })
if ($settings.node) { $pathEntries = @((Split-Path -Parent ([string]$settings.node))) + $pathEntries }
if ($pathEntries.Count) { $env:PATH = ($pathEntries -join ';') + ';' + $env:PATH }
$url = [uri]$settings.url
if ($url.Scheme -notin @('http', 'https') -or $url.Host -notin @('localhost', '127.0.0.1', '::1')) {
  throw 'The service URL must be a local HTTP(S) URL.'
}

$serviceHome = if ($settings.home) { [string]$settings.home } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = if ($settings.profile) { [string]$settings.profile } elseif ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }
if ($profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'Invalid service profile.' }
. (Join-Path $PSScriptRoot 'superagent-lifecycle-lock.ps1')
$mutex = Get-SuperagentLifecycleMutex $serviceHome $profile
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another deployment or recovery is already in progress.' }
  $markers = @((Join-Path $serviceHome "service\control\lifecycle\$($url.Port).maintenance"),
    (Join-Path $serviceHome "service\control\profiles\$profile\deployment.maintenance"))
  foreach ($marker in $markers) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
    Set-Content -LiteralPath $marker -Value "Deployment started $(Get-Date -Format o); retry deployment after failure."
  }

function Listening([int]$Port) {
  $output = & netstat -ano -p tcp
  if ($LASTEXITCODE -ne 0) { throw 'Cannot list TCP listeners.' }
  foreach ($line in $output) {
    if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+\d+\s*$' -and [int]$Matches[1] -eq $Port) { return $true }
  }
  return $false
}

function ServiceStatus {
  $output = & pwsh -NoLogo -NoProfile -NonInteractive -File $ServiceScript status -Config $Config
  try { $status = $output | ConvertFrom-Json } catch { throw 'Cannot establish service process status.' }
  if ($null -eq $status -or $status.identity -ne 'listener' -or $status.home_matches -ne $true -or
      $null -eq $status.listener -or $null -eq $status.pids -or $null -eq $status.foreign -or $null -eq $status.unlistening -or
      @($status.foreign).Count -or @($status.unlistening).Count -or @($status.listener).Count -ne @($status.pids).Count -or
      @($status.pids).Count -gt 1) {
    throw 'Cannot identify the configured service safely; refusing to stop or update.'
  }
  if (@($status.pids).Count -and (-not $status.start.pid -or $status.start.pid -ne $status.pids[0])) {
    throw 'The listening process does not match the recorded service; refusing to stop or update.'
  }
  return $status
}

$status = ServiceStatus
if (Listening $url.Port) {
  if (@($status.pids).Count -ne 1) { throw 'The configured listener is not the expected service.' }
  $state = Invoke-RestMethod -Method Get -Uri "$($url.AbsoluteUri.TrimEnd('/'))/orchestrator/api/state" -Headers @{ 'x-orchestrator-request' = '1' } -TimeoutSec 10
  if (-not $state.health.runtime -or -not ($state.health.assessment -or $state.health.delivery -or $state.health.reply)) {
    throw 'The configured URL is not a Superagent server.'
  }
  Invoke-RestMethod -Method Post -Uri "$($url.AbsoluteUri.TrimEnd('/'))/orchestrator/api/service/stop" -Headers @{ 'x-orchestrator-request' = '1' } -TimeoutSec 10 | Out-Null
  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Milliseconds 500
    $listening = Listening $url.Port
  } while ($listening -and (Get-Date) -lt $deadline)
  if ($listening) { throw "Service is still listening on port $($url.Port)." }
}
$status = ServiceStatus
if (@($status.pids).Count -or @($status.listener).Count) { throw 'The service may still be running; refusing to update the checkout.' }

$checkout = [string]$settings.checkout
if (-not $checkout) { throw 'The service configuration must specify the checkout.' }
& pwsh -NoLogo -NoProfile -NonInteractive -File $UpdateScript -Checkout $checkout
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:DSH_SUPERAGENT_LIFECYCLE_LOCKED = '1'
& pwsh -NoLogo -NoProfile -NonInteractive -File $ServiceScript start -Config $Config -UseInstalled
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($marker in $markers) { Remove-Item -LiteralPath $marker -Force }
exit 0
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
