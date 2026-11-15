param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$Release,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$runtime = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([char[]]'\/')
$releases = Join-Path $runtime 'releases'
$current = Join-Path $runtime 'current'
$releasePath = [System.IO.Path]::GetFullPath($Release).TrimEnd([char[]]'\/')
if ((Split-Path -Parent $releasePath) -ine $releases) { throw 'Release must be a direct child of the runtime releases directory.' }
$releaseItem = Get-Item -LiteralPath $releasePath -Force
if ($releaseItem.LinkType -or -not $releaseItem.PSIsContainer) { throw 'Release must be a real directory.' }
$controlPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char[]]'\/')
$separator = [System.IO.Path]::DirectorySeparatorChar
if ($controlPath -ieq $runtime -or $controlPath.StartsWith($runtime + $separator, [StringComparison]::OrdinalIgnoreCase) -or
    $runtime.StartsWith($controlPath + $separator, [StringComparison]::OrdinalIgnoreCase)) { throw 'Trusted control directory must be outside the release and runtime.' }
for ($ancestor = $controlPath; $ancestor; $ancestor = Split-Path -Parent $ancestor) {
  $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
  if ($item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted control directory must not use links.' }
}
$pathsHelper = Get-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-paths.ps1') -Force -ErrorAction Stop
if ($pathsHelper.PSIsContainer -or $pathsHelper.LinkType -or ($pathsHelper.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted runtime path helper must be a regular file.' }
. $pathsHelper.FullName
if ($IsWindows) {
  $controlIdentity = Get-RuntimeValidatedDirectoryPath $controlPath
  $runtimeIdentity = Get-RuntimeValidatedDirectoryPath $runtime
  if ((Test-RuntimeDirectoryAncestor $controlIdentity $runtimeIdentity) -or (Test-RuntimeDirectoryAncestor $runtimeIdentity $controlIdentity)) { throw 'Trusted control directory must be outside the release and runtime.' }
}
$verifier = Get-Item -LiteralPath (Join-Path $controlPath 'runtime-verify.ps1') -Force -ErrorAction Stop
if ($verifier.LinkType -or ($verifier.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $verifier.PSIsContainer) { throw 'Trusted release verifier must be a regular file.' }
. $verifier.FullName
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($settings.installedOnly -ne $true -or $settings.installedOnly -isnot [bool]) { throw 'Service configuration must set installedOnly to true.' }
if (-not $settings.home -or -not $settings.profile -or -not $settings.url -or -not $settings.checkout) { throw 'Service configuration must specify home, profile, url and checkout.' }
if (-not $settings.node -or -not [System.IO.Path]::IsPathFullyQualified([string]$settings.node) -or -not (Test-Path -LiteralPath ([string]$settings.node) -PathType Leaf)) { throw 'Service configuration must specify an existing absolute Node executable.' }
$serviceHome = [System.IO.Path]::GetFullPath([string]$settings.home).TrimEnd([char[]]'\/')
$profile = [string]$settings.profile
if ($profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'Invalid service profile.' }
if ([System.IO.Path]::GetFullPath([string]$settings.checkout).TrimEnd([char[]]'\/') -ine $current) { throw 'Service checkout must name the runtime current junction.' }
$url = [uri]$settings.url
if ($url.Scheme -notin @('http', 'https') -or $url.Host -notin @('localhost', '127.0.0.1', '::1', '[::1]')) { throw 'The service URL must be local HTTP(S).' }
$lockHelper = Get-Item -LiteralPath (Join-Path $PSScriptRoot 'superagent-lifecycle-lock.ps1') -Force -ErrorAction Stop
if ($lockHelper.PSIsContainer -or $lockHelper.LinkType -or ($lockHelper.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted lifecycle lock helper must be a regular file.' }
. $lockHelper.FullName
$runtimeIdentity = if ($IsWindows) { Get-RuntimeValidatedDirectoryPath $runtime } else { $runtime }
$mutex = Get-SuperagentLifecycleMutex $runtimeIdentity 'runtime'
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another runtime operation is in progress.' }
  if ($IsWindows) {
    $null = Get-RuntimeValidatedDirectoryPath $releases
    $null = Get-RuntimeValidatedDirectoryPath $releasePath
  }
  $control = Join-Path $runtime 'control'
  $binding = Join-Path $control 'binding.json'
  function Assert-Uninitialized {
    $controlItem = $null
    try { $controlItem = Get-Item -LiteralPath $control -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { }
    if ($IsWindows -and $null -ne $controlItem) { $null = Get-RuntimeValidatedDirectoryPath $control }
    foreach ($path in @($current, $binding, (Join-Path $control 'activation.json'), (Join-Path $control 'deploy-runtime.json'))) {
      $existing = $null
      try { $existing = Get-Item -LiteralPath $path -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { }
      if ($null -ne $existing) { throw 'Runtime is already initialized or requires manual inspection.' }
    }
  }
  Assert-Uninitialized
  $releaseRecord = Test-PreparedRelease $releasePath ([string]$settings.node)
  $preparedRecordPath = Join-Path $releasePath 'runtime-prepared.json'
  $preparedRecordHash = (Get-FileHash -LiteralPath $preparedRecordPath -Algorithm SHA256).Hash
  Test-PreparedRuntimeImport $releasePath ([string]$settings.node)
  $verified = Test-PreparedRelease $releasePath ([string]$settings.node)
  if ((Get-FileHash -LiteralPath $preparedRecordPath -Algorithm SHA256).Hash -cne $preparedRecordHash -or
      $verified.commit -cne $releaseRecord.commit -or $verified.archiveSha256 -cne $releaseRecord.archiveSha256) { throw 'Release preparation record changed during import.' }
  Assert-Uninitialized
  New-Item -ItemType Directory -Path $control -Force | Out-Null
  if ($IsWindows) { $null = Get-RuntimeValidatedDirectoryPath $control }
  $data = @{ home = $serviceHome; profile = $profile; url = $url.AbsoluteUri.TrimEnd('/'); current = $current } | ConvertTo-Json
  $stream = [System.IO.File]::Open($binding, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write($data) } finally { $writer.Dispose() }
  } finally { $stream.Dispose() }
  New-Item -ItemType Junction -Path $current -Target $releasePath -ErrorAction Stop | Out-Null
  Write-Output (ConvertTo-Json @{ current = $current; release = $releasePath; initialized = $true } -Compress)
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
