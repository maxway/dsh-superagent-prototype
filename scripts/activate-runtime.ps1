param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$Release,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$runtime = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([char[]]'\/')
$controlPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char[]]'\/')
$separator = [System.IO.Path]::DirectorySeparatorChar
if ($controlPath -ieq $runtime -or $controlPath.StartsWith($runtime + $separator, [StringComparison]::OrdinalIgnoreCase) -or
    $runtime.StartsWith($controlPath + $separator, [StringComparison]::OrdinalIgnoreCase)) { throw 'Trusted control directory must be outside the release and runtime.' }
for ($ancestor = $controlPath; $ancestor; $ancestor = Split-Path -Parent $ancestor) {
  $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted control directory must not use links.' }
}
foreach ($name in @('superagent-lifecycle-lock.ps1', 'runtime-paths.ps1', 'runtime-activation-core.ps1')) {
  $item = Get-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Trusted control file must be a regular file: $name" }
}
. (Join-Path $PSScriptRoot 'superagent-lifecycle-lock.ps1')
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')
. (Join-Path $PSScriptRoot 'runtime-activation-core.ps1')
$runtimeIdentity = if ($IsWindows) { Get-RuntimeValidatedDirectoryPath $runtime } else { $runtime }
if ($IsWindows) { $null = Get-RuntimeValidatedDirectoryPath (Join-Path $runtime 'control') }
$runtimeMutex = Get-SuperagentLifecycleMutex $runtimeIdentity 'runtime'
$runtimeLocked = $false
try {
  try { $runtimeLocked = $runtimeMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $runtimeLocked = $true }
  if (-not $runtimeLocked) { throw 'Another runtime operation is in progress.' }
  if ($IsWindows) {
    $null = Get-RuntimeValidatedDirectoryPath (Join-Path $runtime 'releases')
    $null = Get-RuntimeValidatedDirectoryPath ([System.IO.Path]::GetFullPath($Release))
  }
  $deployJournal = Join-Path $runtime 'control\deploy-runtime.json'
  try { $deployItem = Get-Item -LiteralPath $deployJournal -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { $deployItem = $null }
  if ($null -ne $deployItem) {
    try { $deployment = Get-Content -LiteralPath $deployJournal -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Deployment journal is unreadable; inspect it before proceeding.' }
    if ($deployment -isnot [pscustomobject] -or $deployment.phase -isnot [string] -or $deployment.phase -cnotin @('completed', 'failed-before-activation')) {
      throw 'Deployment journal requires manual inspection before activation.'
    }
  }
  Invoke-RuntimeActivationCore -Config $Config -Release $Release -RuntimeRoot $runtime
} finally {
  if ($runtimeLocked) { $runtimeMutex.ReleaseMutex() }
  $runtimeMutex.Dispose()
}
