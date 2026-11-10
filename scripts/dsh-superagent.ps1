# Versioned operator entry for one local dsh-superagent service.
#
# Normal use is one action word: pwsh scripts\dsh-superagent.ps1 start|stop|restart|status.
# The machine-specific facts stay in a JSON file outside the checkout (default:
# %USERPROFILE%\.dsh-superagent\service.json); the file pins the checkout, DSH home, profile and URL so a typo cannot
# start or stop another instance. No target or timing parameter is exposed on the command line. The Node control script
# under <checkout>\scripts\dsh-superagent does the actual work; this wrapper validates the configuration and supplies
# the environment that home needs.
#
# It never force-kills, never targets a remote URL, and never edits the profile. See docs/006-deployment.md.
param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'verify')]
  [string]$Action = 'status',
  [string]$Config = '',
  [switch]$RespectStop
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) { throw $message }

$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { (Get-Location).Path }
$defaultConfig = [System.IO.Path]::Combine($userHome, '.dsh-superagent', 'service.json')
$configExplicit = $PSBoundParameters.ContainsKey('Config') -and -not [string]::IsNullOrWhiteSpace($Config)
if (-not $Config) { $Config = $env:DSH_SUPERAGENT_SERVICE_CONFIG }
if (-not $Config) { $Config = $defaultConfig }

$value = $null
if (Test-Path -LiteralPath $Config) {
  try { $value = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json } catch {
    Fail "Cannot read the service configuration $Config`: $($_.Exception.Message)"
  }
  $allowed = @('checkout', 'home', 'agentsHome', 'profile', 'url', 'node', 'timeout', 'stopTimeout', 'survivalSeconds',
    'path', 'deployRequest', 'deployCommand')
  foreach ($property in $value.PSObject.Properties) {
    if ($property.Name -notin $allowed) { Fail "Unknown key '$($property.Name)' in $Config" }
  }
} elseif ($configExplicit) {
  Fail "The service configuration does not exist: $Config"
}

function Value([string]$name, $fallback) {
  if ($null -ne $value) {
    $property = $value.PSObject.Properties[$name]
    if ($null -ne $property -and $null -ne $property.Value -and "$($property.Value)" -ne '') { return $property.Value }
  }
  return $fallback
}

# The wrapper exposes one action; target facts and tuning live in the machine configuration, not in the command line.
$Checkout = [string](Value 'checkout' (Split-Path -Parent $PSScriptRoot))
$DshHome = [string](Value 'home' $env:DSH_HOME)
if (-not $DshHome) { $DshHome = [System.IO.Path]::Combine($userHome, '.dsh') }
$DshProfile = [string](Value 'profile' $env:DSH_SUPERAGENT_PROFILE)
if (-not $DshProfile) { $DshProfile = 'superagent' }
$Url = [string](Value 'url' $env:DSH_SUPERAGENT_URL)
$urlConfigured = [bool]$Url
if (-not $Url) { $Url = 'http://127.0.0.1:3082' }
$Timeout = [int](Value 'timeout' 60)
$StopTimeout = [int](Value 'stopTimeout' 300)
$SurvivalSeconds = [int](Value 'survivalSeconds' 20)

$Checkout = [System.IO.Path]::GetFullPath($Checkout)
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
if (-not (Test-Path -LiteralPath $Checkout -PathType Container)) { Fail "The checkout does not exist: $Checkout" }
$control = Join-Path $Checkout 'scripts\dsh-superagent'
if (-not (Test-Path -LiteralPath $control -PathType Leaf)) { Fail "The control script does not exist: $control" }
$profileDirectory = Join-Path $DshHome (Join-Path 'profiles' $DshProfile)
# A stop may discover the running server from another home/profile, so only a start needs this profile locally.
if ($Action -in @('start', 'restart') -and -not (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
  Fail "The DSH profile '$DshProfile' does not exist in $DshHome."
}

$target = $null
if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$target) -or $target.Scheme -notin @('http', 'https')) {
  Fail "The URL must be an absolute http(s) URL: $Url"
}
if ($target.Host -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) {
  Fail "The URL must name the loopback interface; refusing a remote target: $Url"
}
if ($target.Port -le 0) { Fail "The URL must name an explicit loopback port: $Url" }

$node = [string](Value 'node' '')
if (-not $node) { $node = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Fail "The Node executable does not exist: $node" }

$env:DSH_HOME = $DshHome
$agentsHome = [string](Value 'agentsHome' '')
if ($agentsHome) { $env:DSH_AGENTS_HOME = [System.IO.Path]::GetFullPath($agentsHome) }
$prepend = @(@(Value 'path' @()) | Where-Object { $_ -and (Test-Path -LiteralPath ([string]$_) -PathType Container) })
if ($prepend.Count) { $env:PATH = (($prepend | ForEach-Object { [string]$_ }) -join ';') + ';' + $env:PATH }

if ($Action -in @('start', 'restart')) {
  if (-not $env:LUMOS_API_KEY) { $env:LUMOS_API_KEY = [Environment]::GetEnvironmentVariable('LUMOS_API_KEY', 'User') }
  if (-not $env:LUMOS_API_KEY) { Fail 'The user-level LUMOS_API_KEY is missing; a start cannot authenticate the model provider.' }
}
$deployRequest = [string](Value 'deployRequest' '')
$deployCommand = [string](Value 'deployCommand' '')
if ($deployRequest) { $env:DSH_SUPERAGENT_DEPLOY_REQUEST = $deployRequest }
if ($deployCommand) { $env:DSH_SUPERAGENT_DEPLOY_COMMAND = $deployCommand }

$arguments = @($control, $Action, '--profile', $DshProfile, '--home', $DshHome)
# A stop without a named URL discovers the running server; keep a configured/explicit URL exact.
if ($urlConfigured -or $Action -ne 'stop') { $arguments += @('--url', $Url) }
if ($Action -in @('start', 'restart')) { $arguments += @('--timeout', [string]$Timeout) }
if ($Action -in @('stop', 'restart')) { $arguments += @('--stop-timeout', [string]$StopTimeout) }
if ($Action -eq 'verify') { $arguments += @('--survival-seconds', [string]$SurvivalSeconds) }
if ($RespectStop) { $arguments = @('--respect-stop') + $arguments }

& $node @arguments
exit $LASTEXITCODE