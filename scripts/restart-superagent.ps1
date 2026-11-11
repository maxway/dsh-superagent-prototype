param(
  [string]$Config = (Join-Path $env:USERPROFILE '.dsh-superagent\service.json'),
  [string]$ServiceScript = (Join-Path $PSScriptRoot 'dsh-superagent.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "Service configuration not found: $Config" }
if (-not (Test-Path -LiteralPath $ServiceScript -PathType Leaf)) { throw "Service script not found: $ServiceScript" }

$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$url = [uri]$settings.url
if ($url.Scheme -notin @('http', 'https') -or $url.Host -notin @('localhost', '127.0.0.1', '::1')) {
  throw 'The service URL must be a local HTTP(S) URL.'
}

$listener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $url.Port })
if ($listener.Count -gt 0) {
  Invoke-RestMethod -Method Post -Uri "$($url.AbsoluteUri.TrimEnd('/'))/orchestrator/api/service/stop" -Headers @{ 'x-orchestrator-request' = '1' } -TimeoutSec 10 | Out-Null
  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Milliseconds 500
    $listener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $url.Port })
  } while ($listener.Count -gt 0 -and (Get-Date) -lt $deadline)
  if ($listener.Count -gt 0) { throw "Service is still listening on port $($url.Port)." }
}

& pwsh -NoLogo -NoProfile -NonInteractive -File $ServiceScript start -Config $Config
exit $LASTEXITCODE
