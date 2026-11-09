# Independent deployment executor.
#
# A scheduled task runs this file outside the production service and outside every DSH tool command. It reads the
# operator's request, runs the headless DSH deployment agent, and — after that agent has exited — proves that the service
# survived it (one process, management API usable, outside every Windows Job, same process after a survival window).
# The agent may build, back up, stop, switch and start the service; the start command itself leaves any Windows Job, and
# this outer check is the last word on the result. It never starts the observer and never retries blindly.
#
# The deployment-specific paths stay in a JSON configuration outside the repository; pass it with -Config or
# DSH_SUPERAGENT_DEPLOY_CONFIG. See docs/006-deployment.md for the fields and the scheduled task.
param(
  [string]$Config = '',
  [string]$Confirmation = '',
  [switch]$Validate
)

$ErrorActionPreference = 'Stop'

if (-not $Config) { $Config = $env:DSH_SUPERAGENT_DEPLOY_CONFIG }
if (-not $Config) { throw 'No deployment configuration: pass -Config or set DSH_SUPERAGENT_DEPLOY_CONFIG.' }
$configPath = (Resolve-Path -LiteralPath $Config).Path
$value = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

function Field([string]$name, [switch]$Required) {
  $property = $value.PSObject.Properties[$name]
  $field = if ($null -eq $property) { $null } else { $property.Value }
  if ($Required -and [string]::IsNullOrWhiteSpace([string]$field)) {
    throw "deployment configuration: $name is required in $configPath"
  }
  return $field
}

foreach ($name in @('requestPath', 'promptPath', 'workdir', 'node', 'dsh', 'home', 'logFile', 'resultFile', 'url')) {
  Field $name -Required | Out-Null
}
$profile = if (Field 'agentProfile') { [string](Field 'agentProfile') } else { 'headless' }
$serviceProfile = if (Field 'serviceProfile') { [string](Field 'serviceProfile') } else { 'superagent' }
$url = [string](Field 'url')
$survival = if ($null -ne (Field 'survivalSeconds')) { [int](Field 'survivalSeconds') } else { 30 }
$checkout = Split-Path -Parent $PSScriptRoot
if (Field 'checkout') { $checkout = [string](Field 'checkout') }
$node = [string](Field 'node')
$control = Join-Path $checkout 'scripts\dsh-superagent'
$promptPath = [string](Field 'promptPath')
$modelPatch = if (Field 'modelPatch') { [string](Field 'modelPatch') } else { Join-Path (Split-Path -Parent $promptPath) 'model.patch.yml' }
$requestPath = [string](Field 'requestPath')
$requestArchive = Join-Path (Split-Path -Parent $requestPath) 'deploy-request.last.json'
$logFile = [string](Field 'logFile')
$resultFile = [string](Field 'resultFile')

if ($Validate) {
  [ordered]@{ config = $configPath; checkout = $checkout; profile = $profile; serviceProfile = $serviceProfile; url = $url
    survivalSeconds = $survival; requestPath = $requestPath; requestArchive = $requestArchive; promptPath = $promptPath
    modelPatch = $modelPatch; logFile = $logFile; resultFile = $resultFile } | ConvertTo-Json -Depth 3
  exit 0
}
if (-not (Test-Path -LiteralPath $control)) { throw "The control script does not exist: $control" }

$logDirectory = Split-Path -Parent $logFile
if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
function Log([string]$message) {
  "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8
}

$request = $null
if (Test-Path -LiteralPath $requestPath) {
  try { $request = Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json } catch {
    Log "bad deploy request: $($_.Exception.Message)"
    exit 2
  }
  if ([string]::IsNullOrWhiteSpace([string]$request.confirmation)) {
    Log 'deploy request has no operator confirmation'
    exit 2
  }
  Move-Item -Force -LiteralPath $requestPath -Destination $requestArchive
} elseif ($Confirmation) {
  $request = [pscustomobject]@{ at = (Get-Date).ToString('o'); requestedBy = 'operator'; confirmation = $Confirmation; target = 'latest' }
} else {
  Log 'no deploy request; nothing to do'
  exit 0
}

# The agent talks to DSH through its own profile home; the service it releases keeps its own home and settings because
# the release uses the instance's service.ps1. LUMOS_API_KEY comes from the account environment, never from this file.
$env:DSH_HOME = [string](Field 'home')
if (Field 'agentsHome') { $env:DSH_AGENTS_HOME = [string](Field 'agentsHome') }
$env:LUMOS_API_KEY = [Environment]::GetEnvironmentVariable('LUMOS_API_KEY', 'User')
if (-not $env:LUMOS_API_KEY) { throw 'The user-level LUMOS_API_KEY is missing.' }
if (Field 'deployRequest') { $env:DSH_SUPERAGENT_DEPLOY_REQUEST = [string](Field 'deployRequest') }
if (Field 'deployCommand') { $env:DSH_SUPERAGENT_DEPLOY_COMMAND = [string](Field 'deployCommand') }
$env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH

$prompt = Get-Content -Raw -LiteralPath $promptPath
$agentInput = "操作者请求（$($request.at)，$($request.requestedBy)）：$($request.confirmation)`n目标：$($request.target)`n`n$prompt"

$agentCode = 1
Push-Location -LiteralPath ([string](Field 'workdir'))
try {
  Log "deploy start (requested $($request.at), agent $profile, checkout $checkout)"
  $agentInput | & $node ([string](Field 'dsh')) --profile $profile --patch $modelPatch --approval-policy never `
    --permission-mode danger-full-access - 2>&1 | Tee-Object -FilePath $logFile -Append
  $agentCode = $LASTEXITCODE
} finally { Pop-Location }
Log "deployment agent exited code=$agentCode"

# The check that the 2026-11-09 incident was missing: the agent has exited, so wait and prove the service still runs
# outside any Job. It runs even after an agent failure, to record whether a service was left running.
Log "checking service survival after the agent exit (survival $survival s)"
$verifyOutput = & $node $control verify --profile $serviceProfile --url $url --survival-seconds $survival 2>&1
$verifyOutput | Tee-Object -FilePath $logFile -Append | Out-Null
$verifyCode = $LASTEXITCODE
Log "survival check exit=$verifyCode"

$head = $null
try { $head = (& git -C $checkout rev-parse HEAD 2>$null | Select-Object -First 1) } catch {}
if ($head) { $head = $head.Trim() }
$ok = $agentCode -eq 0 -and $verifyCode -eq 0
$result = [ordered]@{
  at = (Get-Date).ToString('o')
  ok = $ok
  phase = if ($ok) { 'agent_exited_service_alive' } elseif ($agentCode -ne 0) { 'agent_failed' } else { 'service_did_not_survive' }
  agentExitCode = $agentCode
  verifyExitCode = $verifyCode
  request = $request
  checkout = $checkout
  head = $head
  serviceProfile = $serviceProfile
  url = $url
  survivalSeconds = $survival
  verify = ($verifyOutput -join "`n")
  log = $logFile
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resultFile) | Out-Null
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultFile -Encoding utf8

if ($ok -and (Field 'reportChat')) {
  $note = '独立部署任务已退出，服务存活检查通过。'
  & $node $control watchdog report --profile $serviceProfile --url $url --chat ([string](Field 'reportChat')) `
    --note $note 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
  if ($LASTEXITCODE -ne 0) { Log "the final Feishu report failed; the result remains in $resultFile" }
}

Log "deploy end ok=$ok agent=$agentCode verify=$verifyCode result=$resultFile"
exit $(if ($ok) { 0 } else { 1 })