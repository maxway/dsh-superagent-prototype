$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'deploy-runtime.local.json'
$coordinator = Join-Path $PSScriptRoot 'deploy-runtime.ps1'
foreach ($path in @($configPath, $coordinator)) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Expected a regular deployment control file: $path" }
}
try { $settings = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'Local deployment configuration is unreadable.' }
if ($settings -isnot [pscustomobject]) { throw 'Local deployment configuration must be an object.' }
$required = @('SourceRepo', 'Remote', 'Ref', 'RuntimeRoot', 'Config', 'Node', 'Git', 'Pnpm')
$names = @($settings.PSObject.Properties.Name)
if ($names.Count -ne $required.Count -or @($names | Where-Object { $_ -cnotin $required }).Count) { throw 'Local deployment configuration must contain exactly the required fields.' }
$arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $coordinator)
foreach ($name in $required) {
  $value = $settings.$name
  if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { throw "Local deployment configuration requires a nonempty $name." }
  if ($name -in @('SourceRepo', 'RuntimeRoot', 'Config', 'Node', 'Git', 'Pnpm') -and -not [System.IO.Path]::IsPathFullyQualified($value)) { throw "Local deployment configuration requires an absolute $name path." }
  $arguments += @("-$name", $value)
}
& (Get-Process -Id $PID).Path @arguments
exit $LASTEXITCODE
