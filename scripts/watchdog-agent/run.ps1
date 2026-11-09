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

# The agent runs in its own workspace, never in the checkout: DSH groups a Session under the workspace of its working
# directory, so running in the checkout would put Watchdog Sessions into the operator's Desktop DSH project. The default
# name carries the service profile, so several Watchdogs on one host do not share a workspace; `workspace` overrides it.
# A relative value (or the default) resolves against the configuration file, and the workspace must stay outside the
# checkout. It is created when missing.
$configDirectory = Split-Path -Parent $configPath
$separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$comparison = if ($env:OS -eq 'Windows_NT') { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
$checkoutPath = [System.IO.Path]::GetFullPath($checkout)
$workspaceDefault = Join-Path (Join-Path $configDirectory 'workspaces') ('watchdog_' + $profile)
$workspaceValue = Optional 'workspace' $workspaceDefault
if (-not [System.IO.Path]::IsPathRooted($workspaceValue)) { $workspaceValue = Join-Path $configDirectory $workspaceValue }
$workspace = [System.IO.Path]::GetFullPath($workspaceValue)
function Inside([string]$path, [string]$root) {
  $candidate = $path.TrimEnd($separators)
  $parent = $root.TrimEnd($separators)
  return $candidate.Equals($parent, $comparison) -or $candidate.StartsWith($parent + [System.IO.Path]::DirectorySeparatorChar, $comparison)
}
if (Inside $workspace $checkoutPath) {
  throw "watchdog agent configuration: workspace must be outside the checkout ($checkoutPath): $workspace"
}
New-Item -ItemType Directory -Force -Path $workspace | Out-Null

$logDirectory = Split-Path -Parent $logFile
if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
try {
  if ((Get-Item -LiteralPath $logFile -ErrorAction Stop).Length -gt 5MB) {
    Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
  }
} catch { }
function Log([string]$message) {
  "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $message" | Add-Content -LiteralPath $logFile -Encoding utf8
}

$env:DSH_HOME = $dshHome
if ($settings.PSObject.Properties['agentsHome'] -and $settings.agentsHome) { $env:DSH_AGENTS_HOME = [string]$settings.agentsHome }
if (-not $env:LUMOS_API_KEY) { $env:LUMOS_API_KEY = [Environment]::GetEnvironmentVariable('LUMOS_API_KEY', 'User') }

$gate = Join-Path $root 'gate.mjs'
Log "start version=$version checkout=$checkout workspace=$workspace"
Set-Location -LiteralPath $workspace
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
$prompt = $prompt.Replace('{{checkout}}', $checkout).Replace('{{workspace}}', $workspace).Replace('{{serviceUrl}}', $url).Replace('{{chatId}}', $chatId).Replace('{{staleMinutes}}', $staleMinutes).Replace('{{profile}}', $profile)
if ($version) { $prompt = $prompt.Replace('{{version}}', $version) }

Log 'high risk; running full agent'
$prompt | & $node $dsh --profile $agentProfile --patch $modelPatch --approval-policy never `
  --permission-mode danger-full-access - 2>&1 | Tee-Object -FilePath $logFile -Append
$code = $LASTEXITCODE
Log "end exit=$code"
exit $code