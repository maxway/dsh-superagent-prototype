# Stable launcher for the persistent Watchdog observer.
#
# A scheduled task runs this file once at logon (through the sibling VBS) and leaves it running. It reads `current.txt`,
# validates the version id and runs that version's `watchdog --config <observer.json>` in a restart loop, so switching
# versions never rewrites the task action and a crashed observer is restarted without touching superagent. A zero exit
# means the observer stopped on purpose (SIGTERM/SIGINT), so the launcher stops too.
param(
  [string]$Config = '',
  [string]$WatchdogHome = ''
)

$ErrorActionPreference = 'Stop'
if (-not $WatchdogHome) { $WatchdogHome = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Config) { $Config = Join-Path $WatchdogHome 'observer.json' }
$logFile = Join-Path $WatchdogHome 'launch-observer.log'

function Fail([string]$message) {
  try { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8 } catch { /* The task result carries the error. */ }
  Write-Error $message -ErrorAction Continue
  exit 2
}
function Log([string]$message) {
  try { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8 } catch { /* The task result carries the error. */ }
}

function CurrentObserver {
  $currentPath = Join-Path $WatchdogHome 'current.txt'
  if (-not (Test-Path -LiteralPath $currentPath)) { Fail "No current Watchdog version at $currentPath." }
  $version = (Get-Content -Raw -LiteralPath $currentPath).Trim()
  if ($version -notmatch '^[A-Za-z0-9._-]+$') { Fail "Invalid Watchdog version in ${currentPath}: $version" }
  $observer = Join-Path $WatchdogHome "versions\$version\watchdog"
  if (-not (Test-Path -LiteralPath $observer)) { Fail "The current Watchdog version has no observer: $observer" }
  return [pscustomobject]@{ Version = $version; Observer = $observer }
}

try {
  if (-not (Test-Path -LiteralPath $Config)) { Fail "The Watchdog observer configuration does not exist: $Config" }
  $node = (Get-Command node -ErrorAction Stop).Source
  $session = try { (Get-Process -Id $PID -ErrorAction Stop).SessionId } catch { 'unknown' }
  Log "observer launcher start pid=$PID session=$session config=$Config node=$node"
  while ($true) {
    # Re-read the pointer on every restart: a switch performed while the old observer was stopped must start the new version.
    $target = CurrentObserver
    Log "observer start version=$($target.Version)"
    & $node $target.Observer --config $Config 2>&1 | ForEach-Object { Log "observer output version=$($target.Version) $_" }
    $code = $LASTEXITCODE
    Log "observer exit=$code version=$($target.Version)"
    if ($code -eq 0) { exit 0 }
    Start-Sleep -Seconds 10
  }
} catch {
  $details = $_ | Out-String
  Fail "$details$($_.ScriptStackTrace)"
}