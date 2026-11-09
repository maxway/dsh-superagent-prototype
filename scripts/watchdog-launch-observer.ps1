# Stable launcher for the persistent Watchdog observer.
#
# A scheduled task runs this file once at logon (through the sibling VBS) and leaves it running. It reads `current.txt`,
# validates the version id and runs that version's `watchdog --config <observer.json>` in a restart loop, so switching
# versions never rewrites the task action and a crashed observer is restarted without touching superagent. A zero exit
# means the observer stopped on purpose (SIGTERM/SIGINT), so the launcher stops too.
param(
  [string]$Config = '',
  [string]$Home = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Home) { $Home = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Config) { $Config = Join-Path $Home 'observer.json' }
$logFile = Join-Path $Home 'launch-observer.log'

function Fail([string]$message) {
  try { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8 } catch { /* The task result carries the error. */ }
  Write-Error $message
  exit 2
}
function Log([string]$message) {
  try { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8 } catch { /* The task result carries the error. */ }
}

try {
  $currentPath = Join-Path $Home 'current.txt'
  if (-not (Test-Path -LiteralPath $currentPath)) { Fail "No current Watchdog version at $currentPath." }
  $version = (Get-Content -Raw -LiteralPath $currentPath).Trim()
  if ($version -notmatch '^[A-Za-z0-9._-]+$') { Fail "Invalid Watchdog version in ${currentPath}: $version" }
  $observer = Join-Path $Home "versions\$version\watchdog"
  if (-not (Test-Path -LiteralPath $observer)) { Fail "The current Watchdog version has no observer: $observer" }
  if (-not (Test-Path -LiteralPath $Config)) { Fail "The Watchdog observer configuration does not exist: $Config" }
  $node = (Get-Command node -ErrorAction Stop).Source
  Log "observer launcher start version=$version config=$Config node=$node"
  while ($true) {
    & $node $observer --config $Config
    $code = $LASTEXITCODE
    Log "observer exit=$code version=$version"
    if ($code -eq 0) { exit 0 }
    Start-Sleep -Seconds 10
  }
} catch {
  Fail $_.Exception.Message
}