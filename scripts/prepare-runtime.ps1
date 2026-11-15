param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [string]$Node = 'node',
  [string]$Pnpm = 'pnpm'
)

$ErrorActionPreference = 'Stop'
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Archive must be a file.' }
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $Sha256) { throw 'Archive SHA256 mismatch.' }
if ($RuntimeRoot -notmatch '^[A-Za-z]:[\\/]' -or $RuntimeRoot.Contains([char]0)) { throw 'RuntimeRoot must be an absolute local DOS path.' }
if (@($RuntimeRoot.Substring(3).Split([char[]]'\/') | Where-Object { $_ -in @('.', '..') }).Count) { throw 'Dot segments are not supported.' }
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([char[]]'\/')
if ($runtimePath.Length -eq 2) { $runtimePath += '\' }
$controlPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char[]]'\/')
if ($controlPath -ieq $runtimePath -or $controlPath.StartsWith($runtimePath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $runtimePath.StartsWith($controlPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Trusted control directory must be outside the runtime.' }
for ($ancestor = $controlPath; $ancestor; $ancestor = Split-Path -Parent $ancestor) {
  $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted control directory must be a real directory without links.' }
}
foreach ($name in @('runtime-paths.ps1', 'runtime-verify.ps1')) {
  $item = Get-Item -LiteralPath (Join-Path $controlPath $name) -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Trusted control file must be a regular file: $name" }
}
. (Join-Path $controlPath 'runtime-paths.ps1')
$controlIdentity = Get-RuntimeValidatedDirectoryPath $controlPath
function Get-ExistingRuntimeAncestor([string]$Path) {
  $candidate = $Path
  while ($true) {
    $item = $null
    try { $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { }
    if ($null -ne $item) {
      return (Get-RuntimeValidatedDirectoryPath $candidate)
    }
    $parent = [System.IO.Path]::GetDirectoryName($candidate.TrimEnd('\'))
    if (-not $parent -or $parent -eq $candidate) { throw "Cannot inspect runtime directory ancestry: $Path" }
    $candidate = $parent
  }
}
$releases = Join-Path $runtimePath 'releases'
$cache = Join-Path $runtimePath 'cache'
$pnpmCache = Join-Path $cache 'pnpm'
$release = Join-Path $releases ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Sha256.Substring(0, 12).ToLowerInvariant() + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$temporaryHome = Join-Path ([System.IO.Path]::GetTempPath()) ('superagent-prepare-' + [guid]::NewGuid().ToString('N'))

Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $archiveFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = [long]0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    $parts = $name.Split('/')
    if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or $name.TrimEnd('/') -eq 'runtime-prepared.json' -or @($parts | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) { throw "Unsafe archive entry: $name" }
    $segments = if ($name.EndsWith('/')) { @($parts | Select-Object -SkipLast 1) } else { $parts }
    foreach ($segment in $segments) {
      if (-not $segment -or $segment -ieq 'node_modules' -or $segment -match '[\p{Cc}<>"|?*]' -or $segment -match '[ .]$' -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)') { throw "Unsafe archive entry: $name" }
    }
    if (-not $names.Add($name.TrimEnd('/'))) { throw "Duplicate archive entry: $name" }
    if (-not $name.EndsWith('/')) { [void]$archiveFiles.Add($name) }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Archive links are not permitted: $name" }
    $total += $entry.Length
    if ($total -gt 1073741824) { throw 'Archive exceeds the 1 GiB expanded size limit.' }
  }
  foreach ($required in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'lib/index.js', 'scripts/dsh-superagent', 'scripts/dsh-superagent.ps1', 'scripts/service-start.ps1', 'scripts/superagent-lifecycle-lock.ps1', 'scripts/launch-hidden.vbs', 'scripts/prepare-runtime.ps1', 'scripts/initialize-runtime.ps1', 'scripts/activate-runtime.ps1', 'scripts/runtime-activation-core.ps1', 'scripts/runtime-paths.ps1', 'scripts/runtime-verify.ps1', 'runtime-build.json')) {
    if (-not $names.Contains($required)) { throw "Archive missing required file: $required" }
  }
} finally { $zip.Dispose() }

$runtimeExists = Test-Path -LiteralPath $runtimePath -PathType Container
$runtimeIdentity = Get-ExistingRuntimeAncestor $runtimePath
if ((Test-RuntimeDirectoryAncestor $controlIdentity $runtimeIdentity) -or
    ($runtimeExists -and (Test-RuntimeDirectoryAncestor $runtimeIdentity $controlIdentity))) { throw 'Trusted control directory and runtime must be independent.' }
foreach ($path in @($releases, $cache, $pnpmCache)) { $null = Get-ExistingRuntimeAncestor $path }
New-Item -ItemType Directory -Path $releases -Force | Out-Null
$null = Get-RuntimeValidatedDirectoryPath $releases
New-Item -ItemType Directory -Path $pnpmCache -Force | Out-Null
$null = Get-RuntimeValidatedDirectoryPath $pnpmCache
New-Item -ItemType Directory -Path $release -ErrorAction Stop | Out-Null
$null = Get-RuntimeValidatedDirectoryPath $release
New-Item -ItemType Directory -Path $temporaryHome -ErrorAction Stop | Out-Null
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $release)
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $Sha256) { throw 'Archive changed during extraction.' }
  $buildManifestPath = Join-Path $release 'runtime-build.json'
  $buildManifestHash = (Get-FileHash -LiteralPath $buildManifestPath -Algorithm SHA256).Hash
  $manifest = Get-Content -LiteralPath $buildManifestPath -Raw | ConvertFrom-Json
  if ($manifest -isnot [pscustomobject] -or $manifest.format -isnot [long] -or $manifest.format -ne 1 -or $manifest.commit -cnotmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' -or $null -eq $manifest.files) { throw 'Invalid runtime build manifest.' }
  $listed = @($manifest.files.PSObject.Properties)
  if (-not $listed.Count) { throw 'Runtime build manifest contains no files.' }
  [void]$archiveFiles.Remove('runtime-build.json')
  if ($archiveFiles.Count -ne $listed.Count) { throw 'Runtime build manifest file count does not match archive.' }
  foreach ($entry in $listed) {
    $name = [string]$entry.Name
    if (-not $archiveFiles.Contains($name)) { throw 'Runtime build manifest does not match archive.' }
    if (-not $name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or $entry.Value -notmatch '^[0-9a-f]{64}$') { throw 'Unsafe runtime build manifest entry.' }
    $path = Join-Path $release $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.Value) { throw "Runtime file hash mismatch: $name" }
  }
  $package = Get-Content -LiteralPath (Join-Path $release 'package.json') -Raw | ConvertFrom-Json
  if ($package.name -ne 'dsh-superagent') { throw 'Archive is not a dsh-superagent package.' }
  $expectedPnpm = [string]$package.packageManager
  $allowedEnvironment = @('PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE')
  foreach ($entry in @(Get-ChildItem Env:)) {
    if ($entry.Name.ToUpperInvariant() -notin $allowedEnvironment) { Remove-Item -LiteralPath "Env:$($entry.Name)" }
  }
  $env:HOME = $temporaryHome
  $env:USERPROFILE = $temporaryHome
  $env:PNPM_HOME = Join-Path $temporaryHome 'pnpm-home'
  $env:NPM_CONFIG_USERCONFIG = Join-Path $temporaryHome 'npmrc'
  $env:NPM_CONFIG_GLOBALCONFIG = Join-Path $temporaryHome 'global-npmrc'
  Push-Location -LiteralPath $temporaryHome
  try {
    if (-not [System.IO.Path]::IsPathFullyQualified($Node)) { $Node = (Get-Command $Node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'Configured Node executable does not exist.' }
    $Node = [System.IO.Path]::GetFullPath($Node)
    if (-not [System.IO.Path]::IsPathFullyQualified($Pnpm)) { $Pnpm = (Get-Command $Pnpm -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    if (-not (Test-Path -LiteralPath $Pnpm -PathType Leaf)) { throw 'Configured pnpm executable does not exist.' }
    $Pnpm = [System.IO.Path]::GetFullPath($Pnpm)
    $actualPnpm = (& $Pnpm --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or "pnpm@$actualPnpm" -ne $expectedPnpm) { throw "Expected $expectedPnpm, found pnpm@$actualPnpm." }
  } finally { Pop-Location }
  Push-Location -LiteralPath $release
  try {
    $null = Get-RuntimeValidatedDirectoryPath $release
    $null = Get-RuntimeValidatedDirectoryPath $pnpmCache
    $installArguments = @('install', '--frozen-lockfile', '--ignore-scripts', '--package-import-method', 'copy', '--store-dir', $pnpmCache)
    & $Pnpm @installArguments
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $LASTEXITCODE" }
    . (Join-Path $controlPath 'runtime-verify.ps1')
    $preparedPath = Join-Path $release 'runtime-prepared.json'
    function Assert-ArchiveFilesUnchanged {
      Assert-NoUnlistedReleaseFiles $release $listed
      if (Test-Path -LiteralPath $preparedPath) { throw 'Unexpected preparation record before completion.' }
      if ((Get-FileHash -LiteralPath $buildManifestPath -Algorithm SHA256).Hash -cne $buildManifestHash) { throw 'Runtime build manifest changed during preparation.' }
      foreach ($entry in $listed) {
        $path = Join-Path $release ([string]$entry.Name)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.Value) { throw "Runtime file changed during preparation: $($entry.Name)" }
      }
    }
    Assert-ArchiveFilesUnchanged
    Test-PreparedRuntimeImport $release $Node
    Assert-ArchiveFilesUnchanged
  } finally { Pop-Location }
  $recordFiles = @{}
  foreach ($entry in $listed) { $recordFiles[[string]$entry.Name] = [string]$entry.Value }
  $recordFiles['runtime-build.json'] = $buildManifestHash.ToLowerInvariant()
  $record = @{ archiveSha256 = $Sha256.ToLowerInvariant(); commit = $manifest.commit; sourceDirty = ($manifest.sourceDirty -eq $true); files = $recordFiles; preparedAt = [DateTime]::UtcNow.ToString('o'); pnpm = $actualPnpm }
  if ($manifest.sourceOverlay) { $record.sourceOverlay = $manifest.sourceOverlay }
  $recordStream = [System.IO.File]::Open((Join-Path $release 'runtime-prepared.json'), [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $writer = [System.IO.StreamWriter]::new($recordStream, [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write(($record | ConvertTo-Json)) } finally { $writer.Dispose() }
  } finally { $recordStream.Dispose() }
  Write-Output (ConvertTo-Json @{ release = $release; archiveSha256 = $Sha256.ToLowerInvariant(); prepared = $true } -Compress)
} finally {
  if (Test-Path -LiteralPath $temporaryHome) { Remove-Item -LiteralPath $temporaryHome -Recurse -Force }
}
