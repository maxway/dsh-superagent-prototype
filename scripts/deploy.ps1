# Independent deployment task entry point.
#
# A scheduled task runs this file outside the production service and outside every DSH tool command. It is a thin
# Windows/PowerShell shim: `scripts/deploy.mjs` invokes the independent mechanical restart without a model call.
#
# The deployment-specific paths stay in a JSON configuration outside the repository; pass it with -Config or
# DSH_SUPERAGENT_DEPLOY_CONFIG. See docs/006-deployment.md for the fields and the scheduled task.
param(
  [string]$Config = '',
  [string]$Confirmation = '',
  [switch]$Validate,
  [switch]$Plan,
  [switch]$Agent
)

$ErrorActionPreference = 'Stop'

if (-not $Config) { $Config = $env:DSH_SUPERAGENT_DEPLOY_CONFIG }
if (-not $Config) { throw 'No deployment configuration: pass -Config or set DSH_SUPERAGENT_DEPLOY_CONFIG.' }
$configPath = (Resolve-Path -LiteralPath $Config).Path
$value = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

function Field([string]$name) {
  $property = $value.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

$checkout = Split-Path -Parent $PSScriptRoot
if (Field 'checkout') { $checkout = [string](Field 'checkout') }
$node = [string](Field 'node')
if (-not $node) { $node = 'node' }
$executor = Join-Path $checkout 'scripts\deploy.mjs'
if (-not (Test-Path -LiteralPath $executor)) { throw "The deployment executor does not exist: $executor" }

# The service keeps its own home and settings because a release uses the instance's service.ps1.
$dshHome = [string](Field 'home')
if (-not $dshHome) { $dshHome = $env:DSH_HOME }
if ($dshHome) { $env:DSH_HOME = $dshHome }
if (Field 'agentsHome') { $env:DSH_AGENTS_HOME = [string](Field 'agentsHome') }
if (Field 'deployRequest') { $env:DSH_SUPERAGENT_DEPLOY_REQUEST = [string](Field 'deployRequest') }
if (Field 'deployCommand') { $env:DSH_SUPERAGENT_DEPLOY_COMMAND = [string](Field 'deployCommand') }
$nodeDirectory = [System.IO.Path]::GetDirectoryName($node)
if ($nodeDirectory) { $env:PATH = $nodeDirectory + ';' + $env:PATH }

$arguments = @($executor, '--config', $configPath)
if ($Confirmation) { $arguments += @('--confirmation', $Confirmation) }
if ($Validate) { $arguments += '--validate' }
if ($Plan) { $arguments += '--plan' }
if ($Agent) { $arguments += '--agent' }

& $node @arguments
exit $LASTEXITCODE