function Assert-ProfileBundleTarget($Status, [string]$ExpectedTarget) {
  if (-not @($Status.pids).Count) { return }
  $actual = $Status.deployment.bundleTarget
  if ($actual -isnot [string] -or -not [System.IO.Path]::IsPathFullyQualified($actual) -or
      [System.IO.Path]::GetFullPath($actual).TrimEnd([char[]]'\/') -ine $ExpectedTarget) {
    throw 'Profile bundle link does not match the current release.'
  }
  throw 'The running service loaded release cannot be established; refusing to stop.'
}

function Invoke-RuntimeActivationCore {
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
$releaseRecord = $null
$configHandle = $null
try {
if ($IsWindows) {
  $Config = (Get-Item -LiteralPath $Config -Force).FullName
  $configHandle = [System.IO.File]::Open($Config, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $reader = [System.IO.StreamReader]::new($configHandle, [System.Text.Encoding]::UTF8, $true, 1024, $true)
  try { $settings = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
} else {
  $settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
}
if ($settings.installedOnly -ne $true -or $settings.installedOnly -isnot [bool]) { throw 'Service configuration must set installedOnly to true.' }
if (-not $settings.home -or -not $settings.profile -or -not $settings.url -or -not $settings.checkout) { throw 'Service configuration must specify home, profile, url and checkout.' }
if (-not $settings.node -or -not [System.IO.Path]::IsPathFullyQualified([string]$settings.node) -or -not (Test-Path -LiteralPath ([string]$settings.node) -PathType Leaf)) { throw 'Service configuration must specify an existing absolute Node executable.' }
$serviceHome = [System.IO.Path]::GetFullPath([string]$settings.home)
$profile = [string]$settings.profile
if ($profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'Invalid service profile.' }
if ([System.IO.Path]::GetFullPath([string]$settings.checkout).TrimEnd([char[]]'\/') -ine $current) { throw 'Service checkout must name the runtime current junction.' }
$url = [uri]$settings.url
if ($url.Scheme -notin @('http', 'https') -or $url.Host -notin @('localhost', '127.0.0.1', '::1', '[::1]')) { throw 'The service URL must be local HTTP(S).' }
$link = Get-Item -LiteralPath $current -Force
if ($link.LinkType -ne 'Junction') { throw 'Current must be an existing junction.' }
$oldTarget = [System.IO.Path]::GetFullPath([string]@($link.Target)[0]).TrimEnd([char[]]'\/')
if ((Split-Path -Parent $oldTarget) -ine $releases) { throw 'Current junction points outside releases.' }
$bundle = Get-Item -LiteralPath (Join-Path $serviceHome "profiles\$profile\node_modules\dsh-superagent") -Force
if (-not $bundle.LinkType -or [System.IO.Path]::GetFullPath([string]@($bundle.Target)[0]).TrimEnd([char[]]'\/') -ine $current) { throw 'Profile bundle must link directly to current.' }
$serviceScript = Join-Path $current 'scripts\dsh-superagent.ps1'
if (-not (Test-Path -LiteralPath $serviceScript -PathType Leaf)) { throw 'Current service control is missing.' }
$journal = Join-Path $runtime 'control\activation.json'
$lockHelper = Get-Item -LiteralPath (Join-Path $PSScriptRoot 'superagent-lifecycle-lock.ps1') -Force -ErrorAction Stop
if ($lockHelper.PSIsContainer -or $lockHelper.LinkType -or ($lockHelper.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted lifecycle lock helper must be a regular file.' }
. $lockHelper.FullName
$serviceLock = $null
try {
  $bindingPath = Join-Path $runtime 'control\binding.json'
  try { $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json } catch { throw 'Runtime binding is missing or unreadable.' }
  if ($binding.home -ine $serviceHome.TrimEnd([char[]]'\/') -or $binding.profile -ine $profile -or
      $binding.url -ine $url.AbsoluteUri.TrimEnd('/') -or $binding.current -ine $current) { throw 'Runtime is bound to a different service.' }
  $serviceLock = Enter-SuperagentServiceLock $serviceHome $profile
  function Assert-ActivationPrerequisites {
    $currentLink = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if ($currentLink.LinkType -ne 'Junction' -or [System.IO.Path]::GetFullPath([string]@($currentLink.Target)[0]).TrimEnd([char[]]'\/') -ine $oldTarget) { throw 'Current changed while waiting for the lifecycle lock.' }
    $journalItem = $null
    try { $journalItem = Get-Item -LiteralPath $journal -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { }
    if ($null -ne $journalItem) {
      if ($journalItem.PSIsContainer -or $journalItem.LinkType -or ($journalItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Activation journal is unreadable; inspect it before proceeding.' }
      try { $previous = Get-Content -LiteralPath $journal -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Activation journal is unreadable; inspect it before proceeding.' }
      if ($previous -isnot [pscustomobject] -or $previous.phase -isnot [string] -or $previous.phase -cne 'completed' -or
          $previous.release -isnot [string] -or -not [System.IO.Path]::IsPathFullyQualified($previous.release) -or
          [System.IO.Path]::GetFullPath($previous.release).TrimEnd([char[]]'\/') -ine $oldTarget -or
          $previous.commit -isnot [string] -or $previous.commit.Length -notin @(40, 64) -or $previous.commit -cmatch '[^0-9a-f]') {
        throw 'An earlier activation needs manual inspection.'
      }
    }
  }
  Assert-ActivationPrerequisites
  $releaseRecord = Test-PreparedRelease $releasePath ([string]$settings.node)
  $preparedRecordPath = Join-Path $releasePath 'runtime-prepared.json'
  $preparedRecordHash = (Get-FileHash -LiteralPath $preparedRecordPath -Algorithm SHA256).Hash
  Test-PreparedRuntimeImport $releasePath ([string]$settings.node)
  $verified = Test-PreparedRelease $releasePath ([string]$settings.node)
  if ((Get-FileHash -LiteralPath $preparedRecordPath -Algorithm SHA256).Hash -cne $preparedRecordHash -or
      $verified.commit -cne $releaseRecord.commit -or $verified.archiveSha256 -cne $releaseRecord.archiveSha256) { throw 'Release preparation record changed during import.' }
  Assert-ActivationPrerequisites
  function Status {
    $output = & pwsh -NoLogo -NoProfile -NonInteractive -File $serviceScript status -Config $Config
    try { $status = $output | ConvertFrom-Json } catch { throw 'Cannot establish service process status.' }
    if ($null -eq $status -or $status.identity -ne 'listener' -or $status.home_matches -ne $true -or
        $null -eq $status.listener -or $null -eq $status.pids -or $null -eq $status.foreign -or $null -eq $status.unlistening -or
        @($status.foreign).Count -or @($status.unlistening).Count -or @($status.listener).Count -ne @($status.pids).Count -or @($status.pids).Count -gt 1) {
      throw 'Cannot identify the configured service safely.'
    }
    if (@($status.pids).Count -and (-not $status.start.pid -or $status.start.pid -ne $status.pids[0])) { throw 'The listener does not match the recorded service.' }
    return $status
  }
  function Record([string]$phase) {
    $record = @{ phase = $phase; previous = $oldTarget; release = $releasePath; commit = $releaseRecord.commit; sourceDirty = ($releaseRecord.sourceDirty -eq $true); at = [DateTime]::UtcNow.ToString('o') }
    $temporary = Join-Path (Split-Path -Parent $journal) ('activation-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($temporary, $journal, $true)
  }
  $status = Status
  Assert-ProfileBundleTarget $status $oldTarget
  New-Item -ItemType Directory -Path (Split-Path -Parent $journal) -Force | Out-Null
  Record 'stopping'
  $env:DSH_SUPERAGENT_LIFECYCLE_LOCKED = '1'
  if (@($status.pids).Count) {
    $state = Invoke-RestMethod -Method Get -Uri "$($url.AbsoluteUri.TrimEnd('/'))/orchestrator/api/state" -Headers @{ 'x-orchestrator-request' = '1' } -TimeoutSec 10
    if (-not $state.health.runtime -or -not ($state.health.assessment -or $state.health.delivery -or $state.health.reply)) { throw 'The listener is not a verified Superagent service.' }
    & pwsh -NoLogo -NoProfile -NonInteractive -File $serviceScript stop -Config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Service stop failed.' }
  }
  $status = Status
  if (@($status.pids).Count -or @($status.listener).Count) { throw 'Service or listener remains; refusing to switch.' }
  Record 'switching'
  Remove-Item -LiteralPath $current -Force
  New-Item -ItemType Junction -Path $current -Target $releasePath -ErrorAction Stop | Out-Null
  Record 'starting'
  & pwsh -NoLogo -NoProfile -NonInteractive -File $serviceScript start -Config $Config -UseInstalled
  if ($LASTEXITCODE -ne 0) { throw "Release start failed or needs attention: $LASTEXITCODE" }
  $started = Status
  if (@($started.pids).Count -ne 1 -or -not $started.deployment.bundleTarget -or
      [System.IO.Path]::GetFullPath([string]$started.deployment.bundleTarget).TrimEnd([char[]]'\/') -ine $releasePath) {
    throw 'Started service does not report the intended release.'
  }
  & pwsh -NoLogo -NoProfile -NonInteractive -File $serviceScript verify -Config $Config
  if ($LASTEXITCODE -ne 0) { throw "Release verification failed: $LASTEXITCODE" }
  Record 'completed'
  Write-Output (ConvertTo-Json @{ previous = $oldTarget; release = $releasePath; phase = 'completed' } -Compress)
} finally {
  Remove-Item Env:DSH_SUPERAGENT_LIFECYCLE_LOCKED -ErrorAction SilentlyContinue
  if ($null -ne $serviceLock) { Exit-SuperagentServiceLock $serviceLock }
}
} finally {
  if ($null -ne $configHandle) { $configHandle.Dispose() }
}
}
