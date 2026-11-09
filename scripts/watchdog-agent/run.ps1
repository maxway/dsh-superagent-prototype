# One Watchdog cycle from a versioned artifact.
#
# The stable launcher starts this file from the current artifact version; `gate.mjs` and the observer come from the same
# version, so this cycle never imports source from the running superagent checkout. Environment paths, the operator chat
# and the model patch come from the JSON configuration outside the artifact. A quiet gate records the observation and
# returns without a model call; only a risky cycle starts the full DSH agent.
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [switch]$SkipLlm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

function Required([string]$name) {
  $property = $settings.PSObject.Properties[$name]
  $value = if ($null -eq $property) { $null } else { $property.Value }
  if ([string]::IsNullOrWhiteSpace([string]$value)) { throw "watchdog agent configuration: $name is required in $configPath" }
  return [string]$value
}
function Optional([string]$name, [string]$fallback) {
  $property = $settings.PSObject.Properties[$name]
  $value = if ($null -eq $property) { $null } else { $property.Value }
  if ([string]::IsNullOrWhiteSpace([string]$value)) { return $fallback }
  return [string]$value
}

$url = (Required 'url').TrimEnd('/')
$checkout = Required 'checkout'
$dshHome = Required 'dshHome'
$node = Required 'node'
$dsh = Required 'dsh'
$modelPatch = Required 'modelPatch'
$logFile = Required 'logFile'
$chatId = Optional 'chatId' ''
$profile = Optional 'serviceProfile' 'superagent'
$agentProfile = Optional 'agentProfile' 'headless'
$staleMinutes = Optional 'staleMinutes' '30'
$version = Optional 'version' ''
$skipLlm = $SkipLlm.IsPresent

$logDirectory = Split-Path -Parent $logFile
if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
try {
  if ((Get-Item -LiteralPath $logFile -ErrorAction Stop).Length -gt 5MB) {
    Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
  }
} catch { /* There is no log yet. */ }
function Log([string]$message) {
  "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8
}

$env:DSH_HOME = $dshHome
if ($settings.PSObject.Properties['agentsHome'] -and $settings.agentsHome) { $env:DSH_AGENTS_HOME = [string]$settings.agentsHome }
if (-not $env:LUMOS_API_KEY) { $env:LUMOS_API_KEY = [Environment]::GetEnvironmentVariable('LUMOS_API_KEY', 'User') }

$gate = Join-Path $root 'gate.mjs'
Log "start version=$version checkout=$checkout"
& $node $gate --config $configPath 2>&1 | Tee-Object -FilePath $logFile -Append
$gateCode = $LASTEXITCODE

if ($gateCode -eq 0) {
  Log 'gate quiet; no LLM (exit 0)'
  exit 0
}
if ($gateCode -ne 2) {
  Log "gate exit=$gateCode; no LLM"
  exit $gateCode
}
if ($skipLlm) {
  Log 'SkipLlm set; would run the full agent'
  exit 0
}
if (-not $chatId) { throw "watchdog agent configuration: chatId is required to run the full agent (use -SkipLlm to skip it)" }

$promptPath = Join-Path $root 'prompt.md'
$prompt = Get-Content -Raw -LiteralPath $promptPath
$prompt = $prompt.Replace('{{checkout}}', $checkout).Replace('{{serviceUrl}}', $url).Replace('{{chatId}}', $chatId).Replace('{{staleMinutes}}', $staleMinutes).Replace('{{profile}}', $profile)
if ($version) { $prompt = $prompt.Replace('{{version}}', $version) }

Log 'high risk; running full agent'
Set-Location -LiteralPath $checkout
$prompt | & $node $dsh --profile $agentProfile --patch $modelPatch --approval-policy never `
  --permission-mode danger-full-access - 2>&1 | Tee-Object -FilePath $logFile -Append
$code = $LASTEXITCODE
Log "end exit=$code"
exit $code