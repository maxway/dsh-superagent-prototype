# Independent service start wrapper.
#
# `scripts/dsh-superagent start` uses this file when it runs inside a Windows Job (a DSH tool command): the WMI provider
# creates this process outside every Job, with the user's default environment. The environment the service needs is
# restored from the restricted file the parent wrote, the detached service is started, and this wrapper exits.
#
# Run it directly (for example from an independent scheduled task or an operator terminal) to start the service without
# any Job at all. It never stops, replaces or reconfigures a service.
param(
  [Parameter(Mandatory = $true)][string]$Checkout,
  [string]$EnvFile = '',
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$TimeoutSeconds = 60,
  [string]$Log = ''
)

$ErrorActionPreference = 'Stop'

try {
  if ($EnvFile) {
    $environment = Get-Content -Raw -LiteralPath $EnvFile | ConvertFrom-Json
    Remove-Item -LiteralPath $EnvFile -Force -ErrorAction SilentlyContinue
    foreach ($property in $environment.PSObject.Properties) {
      if ($null -ne $property.Value) { Set-Item -Path ("env:" + $property.Name) -Value ([string]$property.Value) }
    }
  }
  # A WMI-created process starts with the user's default environment, which normally already has this; restore it when the
  # caller supplied it only for its own session.
  if (-not $env:LUMOS_API_KEY) { $env:LUMOS_API_KEY = [Environment]::GetEnvironmentVariable('LUMOS_API_KEY', 'User') }

  $node = (Get-Command node -ErrorAction Stop).Source
  $controlScript = Join-Path $Checkout 'scripts\dsh-superagent'
  if (-not (Test-Path -LiteralPath $controlScript)) { throw "The control script does not exist: $controlScript" }
  $arguments = @($controlScript, 'start', '--outside-job-child', '--profile', $Profile, '--url', $Url,
    '--timeout', [string]$TimeoutSeconds)

  Set-Location -LiteralPath $Checkout
  if ($Log) { & $node @arguments *>> $Log } else { & $node @arguments }
  $code = $LASTEXITCODE
} catch {
  # The launching command has no console, so put the actionable error where its health-check timeout looks.
  $message = "service-start failed: $($_.Exception.Message)"
  if ($Log) { try { $message | Out-File -Append -FilePath $Log -Encoding utf8 } catch { /* The parent reports the timeout. */ } }
  Write-Error $message
  exit 1
}
exit $code