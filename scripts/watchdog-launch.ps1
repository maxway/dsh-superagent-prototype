# Stable launcher for the versioned Watchdog agent.
#
# Install this file once at the Watchdog home and point the scheduled task at it. It reads `current.txt`, validates the
# version id, and runs that version's `agent\run.ps1`; the watchdog update task switches `current.txt` atomically, so the
# task never needs its action rewritten. It never touches the superagent service.
param(
  [string]$Config = '',
  [string]$WatchdogHome = ''
)

$ErrorActionPreference = 'Stop'
if (-not $WatchdogHome) { $WatchdogHome = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Config) { $Config = Join-Path $WatchdogHome 'agent.json' }
$logFile = Join-Path $WatchdogHome 'launch.log'

function Fail([string]$message) {
  try { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8 } catch { /* The task result carries the error. */ }
  Write-Error $message
  exit 2
}

try {
  $currentPath = Join-Path $WatchdogHome 'current.txt'
  if (-not (Test-Path -LiteralPath $currentPath)) { Fail "No current Watchdog version at $currentPath." }
  $version = (Get-Content -Raw -LiteralPath $currentPath).Trim()
  if ($version -notmatch '^[A-Za-z0-9._-]+$') { Fail "Invalid Watchdog version in ${currentPath}: $version" }
  $runner = Join-Path $WatchdogHome "versions\$version\agent\run.ps1"
  if (-not (Test-Path -LiteralPath $runner)) { Fail "The current Watchdog version has no runner: $runner" }
  if (-not (Test-Path -LiteralPath $Config)) { Fail "The Watchdog agent configuration does not exist: $Config" }
  $powershell = (Get-Process -Id $PID).Path
  & $powershell -NoLogo -NoProfile -NonInteractive -File $runner -Config $Config
  exit $LASTEXITCODE
} catch {
  Fail $_.Exception.Message
}