param(
  [Parameter(Mandatory = $true)][string]$SourceRepo,
  [Parameter(Mandatory = $true)][string]$Remote,
  [Parameter(Mandatory = $true)][string]$Ref,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$Node,
  [string]$Git = 'git',
  [string]$Pnpm = 'pnpm'
)

$ErrorActionPreference = 'Stop'
function FullPath([string]$value) {
  if (-not [System.IO.Path]::IsPathFullyQualified($value)) { throw "An absolute path is required: $value" }
  return [System.IO.Path]::GetFullPath($value).TrimEnd([char[]]'\/')
}
function Overlaps([string]$first, [string]$second) {
  $separator = [System.IO.Path]::DirectorySeparatorChar
  return $first.Equals($second, [StringComparison]::OrdinalIgnoreCase) -or $first.StartsWith($second + $separator, [StringComparison]::OrdinalIgnoreCase) -or $second.StartsWith($first + $separator, [StringComparison]::OrdinalIgnoreCase)
}
function LockFile([string]$path) {
  try { return [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
  catch { throw "Cannot acquire exclusive deployment lock: $path" }
}
function RunNative([string]$program, [string[]]$arguments) {
  $output = @(& $program @arguments)
  if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
  return $output
}
$source = FullPath $SourceRepo
$runtime = FullPath $RuntimeRoot
$configPath = FullPath $Config
$nodePath = FullPath $Node
$control = FullPath $PSScriptRoot
if (-not (Test-Path -LiteralPath $source -PathType Container) -or -not (Test-Path -LiteralPath $runtime -PathType Container) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Source, runtime, config and node must already exist.' }
if ((Overlaps $control $source) -or (Overlaps $control $runtime) -or (Overlaps $source $runtime)) { throw 'Control directory, source repository and runtime root must be independent.' }
for ($ancestor = $control; $ancestor; $ancestor = Split-Path -Parent $ancestor) {
  $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Trusted control directory must not use links.' }
}
foreach ($name in @('runtime-paths.ps1', 'superagent-lifecycle-lock.ps1', 'runtime-activation-core.ps1', 'runtime-verify.ps1', 'prepare-runtime.ps1')) {
  $item = Get-Item -LiteralPath (Join-Path $control $name) -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Trusted control file must be a regular file: $name" }
}
. (Join-Path $control 'runtime-paths.ps1')
$runtimeIdentity = $runtime
if ($IsWindows) {
  $sourceIdentity = Get-RuntimeValidatedDirectoryPath $source
  $runtimeIdentity = Get-RuntimeValidatedDirectoryPath $runtime
  $controlIdentity = Get-RuntimeValidatedDirectoryPath $control
  foreach ($pair in @(@($controlIdentity, $sourceIdentity), @($controlIdentity, $runtimeIdentity), @($sourceIdentity, $runtimeIdentity))) {
    if ((Test-RuntimeDirectoryAncestor $pair[0] $pair[1]) -or (Test-RuntimeDirectoryAncestor $pair[1] $pair[0])) { throw 'Control directory, source repository and runtime root must be independent.' }
  }
} elseif ((Overlaps $control $source) -or (Overlaps $control $runtime) -or (Overlaps $source $runtime)) { throw 'Control directory, source repository and runtime root must be independent.' }
if ($Remote -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Ref -notmatch '^refs/(heads|tags)/[A-Za-z0-9][A-Za-z0-9._/-]*$') { throw 'Remote must be a name and ref must be a full branch or tag ref.' }
$prepare = Join-Path $control 'prepare-runtime.ps1'
$activationCore = Join-Path $control 'runtime-activation-core.ps1'
if (-not (Test-Path -LiteralPath $prepare -PathType Leaf) -or -not (Test-Path -LiteralPath $activationCore -PathType Leaf)) { throw 'Trusted control directory must contain prepare-runtime.ps1 and runtime-activation-core.ps1.' }
. (Join-Path $control 'superagent-lifecycle-lock.ps1')
. $activationCore
$runtimeControl = Join-Path $runtime 'control'
if (-not (Test-Path -LiteralPath $runtimeControl -PathType Container)) { throw 'Runtime control directory must already exist.' }
if ($IsWindows) {
  $null = Get-RuntimeValidatedDirectoryPath $runtimeControl
  foreach ($directory in @('releases', 'cache')) {
    $path = Join-Path $runtime $directory
    if (Test-Path -LiteralPath $path) { $null = Get-RuntimeValidatedDirectoryPath $path }
  }
}
$statePath = Join-Path $runtimeControl 'deploy-runtime.json'
$runtimeMutex = Get-SuperagentLifecycleMutex $runtimeIdentity 'runtime'
$runtimeLocked = $false
$runtimeLock = $null
$sourceLock = $null
$configHandle = $null
$phase = ''
$record = [ordered]@{ phase = ''; source = $source; remote = $Remote; ref = $Ref; runtimeRoot = $runtime; config = $configPath; commit = $null; release = $null; at = $null }
function Record([string]$next) {
  $record.phase = $next
  $record.at = [DateTime]::UtcNow.ToString('o')
  $temporary = Join-Path $runtimeControl ('deploy-runtime-' + [guid]::NewGuid().ToString('N') + '.tmp')
  [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::Move($temporary, $statePath, $true)
  $script:phase = $next
}
try {
  try { $runtimeLocked = $runtimeMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $runtimeLocked = $true }
  if (-not $runtimeLocked) { throw 'Another runtime operation is in progress.' }
  $runtimeLock = LockFile (Join-Path $runtimeControl 'deploy-runtime.lock')
  $sourceLock = LockFile (Join-Path $source 'deploy-runtime.lock')
  $stateItem = $null
  try { $stateItem = Get-Item -LiteralPath $statePath -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { }
  if ($null -ne $stateItem) {
    if ($stateItem.PSIsContainer -or $stateItem.LinkType -or ($stateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Deployment state is unreadable; manual inspection is required.' }
    try { $previous = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Deployment state is unreadable; manual inspection is required.' }
    if ($previous -isnot [pscustomobject] -or $previous.phase -isnot [string] -or $previous.phase -cnotin @('completed', 'failed-before-activation')) { throw 'Previous deployment was interrupted or activation needs manual inspection.' }
  }
  $activationJournal = Join-Path $runtimeControl 'activation.json'
  $activationItem = $null
  try { $activationItem = Get-Item -LiteralPath $activationJournal -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { }
  if ($null -ne $activationItem) {
    if ($activationItem.PSIsContainer -or $activationItem.LinkType -or ($activationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Activation journal is unreadable; manual inspection is required.' }
    try { $previousActivation = Get-Content -LiteralPath $activationJournal -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Activation journal is unreadable; manual inspection is required.' }
    if ($previousActivation -isnot [pscustomobject] -or $previousActivation.phase -isnot [string] -or $previousActivation.phase -cne 'completed') { throw 'Previous activation needs manual inspection.' }
  }
  if ($IsWindows) {
    $configHandle = [System.IO.File]::Open($configPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $reader = [System.IO.StreamReader]::new($configHandle, [System.Text.Encoding]::UTF8, $true, 1024, $true)
    try { $settings = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop } finally { $reader.Dispose() }
  } else {
    $settings = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  }
  if ($settings -isnot [pscustomobject] -or $settings.installedOnly -ne $true -or $settings.installedOnly -isnot [bool] -or -not $settings.checkout -or
      -not $settings.node -or -not [System.IO.Path]::IsPathFullyQualified([string]$settings.node) -or
      [System.IO.Path]::GetFullPath([string]$settings.node).TrimEnd([char[]]'\/') -ine $nodePath -or
      [System.IO.Path]::GetFullPath([string]$settings.checkout).TrimEnd([char[]]'\/') -ine (Join-Path $runtime 'current')) {
    throw 'Runtime configuration must pin the installed checkout and configured Node executable.'
  }
  if (-not $settings.home -or -not [System.IO.Path]::IsPathFullyQualified([string]$settings.home) -or
      -not (Test-Path -LiteralPath ([string]$settings.home) -PathType Container) -or
      -not $settings.profile -or [string]$settings.profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' -or -not $settings.url) {
    throw 'Runtime configuration must specify an absolute home, valid profile and local URL.'
  }
  $serviceUrl = $null
  if (-not [Uri]::TryCreate([string]$settings.url, [UriKind]::Absolute, [ref]$serviceUrl) -or
      $serviceUrl.Scheme -notin @('http', 'https') -or $serviceUrl.Host -notin @('localhost', '127.0.0.1', '::1', '[::1]')) {
    throw 'Runtime configuration must specify a local HTTP(S) URL.'
  }
  $bindingPath = Join-Path $runtimeControl 'binding.json'
  try {
    $bindingItem = Get-Item -LiteralPath $bindingPath -Force -ErrorAction Stop
    if ($bindingItem.PSIsContainer -or $bindingItem.LinkType -or ($bindingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Invalid binding file.' }
    $binding = Get-Content -LiteralPath $bindingPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch { throw 'Runtime binding is missing or unreadable.' }
  if ($binding -isnot [pscustomobject] -or $binding.home -ine [System.IO.Path]::GetFullPath([string]$settings.home).TrimEnd([char[]]'\/') -or
      $binding.profile -ine [string]$settings.profile -or $binding.url -ine $serviceUrl.AbsoluteUri.TrimEnd('/') -or
      $binding.current -ine (Join-Path $runtime 'current')) { throw 'Runtime is bound to a different service.' }
  $current = Join-Path $runtime 'current'
  $currentLink = Get-Item -LiteralPath $current -Force -ErrorAction Stop
  if (($IsWindows -and $currentLink.LinkType -ne 'Junction') -or (-not $IsWindows -and -not $currentLink.LinkType)) { throw 'Current must be an existing junction.' }
  $currentTarget = FullPath ([string]@($currentLink.Target)[0])
  if ((Split-Path -Parent $currentTarget) -ine (Join-Path $runtime 'releases')) { throw 'Current junction points outside releases.' }
  $serviceScript = Join-Path $current 'scripts/dsh-superagent.ps1'
  if (-not (Test-Path -LiteralPath $serviceScript -PathType Leaf)) { throw 'Current service control is missing.' }
  $shell = (Get-Process -Id $PID).Path
  try {
    $statusOutput = @(& $shell -NoLogo -NoProfile -NonInteractive -File $serviceScript status -Config $configPath)
    $statusExit = $LASTEXITCODE
    $status = ($statusOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
  } catch { throw 'Cannot establish service process status during deployment preflight.' }
  if ($statusExit -notin @(0, 1) -or $status -isnot [pscustomobject] -or
      $status.identity -cne 'listener' -or $status.home_matches -isnot [bool] -or $status.home_matches -ne $true) {
    throw 'Cannot establish service process status during deployment preflight.'
  }
  foreach ($field in @('pids', 'listener', 'foreign', 'unlistening')) {
    if ($status.$field -isnot [array] -or $status.$field.Count -ne 0) { throw 'Service is running or status is uncertain; refusing deployment preflight.' }
  }
  $env:PATH = (Split-Path -Parent $nodePath) + [System.IO.Path]::PathSeparator + $env:PATH
  foreach ($entry in @(Get-ChildItem Env:)) {
    if ($entry.Name -like 'GIT_*') { Remove-Item -LiteralPath "Env:$($entry.Name)" -Force -Confirm:$false }
  }
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_CONFIG_GLOBAL = if ($IsWindows) { 'NUL' } else { '/dev/null' }
  $bare = (RunNative $Git @('-C', $source, 'rev-parse', '--is-bare-repository') | Out-String).Trim()
  if ($bare -ne 'true') { throw 'Source repository must be bare.' }
  $null = RunNative $Git @('check-ref-format', $Ref)
  Record 'fetching'
  $null = RunNative $Git @('-C', $source, 'fetch', '--no-tags', '--no-recurse-submodules', $Remote, $Ref)
  $commit = (RunNative $Git @('-C', $source, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}') | Out-String).Trim()
  if ($commit -cnotmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') { throw 'Fetched ref did not resolve to a full commit.' }
  $record.commit = $commit
  Record 'building'
  $work = Join-Path $control ('deployment-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  $checkout = Join-Path $work 'source'
  $artifacts = Join-Path $work 'artifacts'
  New-Item -ItemType Directory -Path $artifacts | Out-Null
  $null = RunNative $Git @('clone', '--no-checkout', '--shared', '--', $source, $checkout)
  $null = RunNative $Git @('-C', $checkout, 'checkout', '--detach', $commit)
  $builder = Join-Path $checkout 'scripts/runtime-artifact.mjs'
  if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw 'Fetched commit has no runtime artifact builder.' }
  $null = RunNative $nodePath @($builder, '--commit', $commit, '--out', $artifacts)
  $archives = @(Get-ChildItem -LiteralPath $artifacts -Filter '*.zip' -File)
  if ($archives.Count -ne 1) { throw 'Build must produce exactly one runtime archive.' }
  $archive = $archives[0].FullName
  $sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  $record['archive'] = $archive
  $record['archiveSha256'] = $sha
  Record 'preparing'
  $shell = (Get-Process -Id $PID).Path
  $output = @(RunNative $shell @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $prepare, '-Archive', $archive, '-Sha256', $sha, '-RuntimeRoot', $runtime, '-Node', $nodePath, '-Pnpm', $Pnpm))
  try { $prepared = $output[-1] | ConvertFrom-Json } catch { throw 'Prepare did not return a release record.' }
  if ($prepared.prepared -ne $true -or $prepared.archiveSha256 -cne $sha -or -not $prepared.release) { throw 'Prepare returned an invalid release record.' }
  $release = FullPath ([string]$prepared.release)
  if ((Split-Path -Parent $release) -ine (Join-Path $runtime 'releases')) { throw 'Prepared release is outside the runtime releases directory.' }
  if ($IsWindows) {
    $null = Get-RuntimeValidatedDirectoryPath (Join-Path $runtime 'releases')
    $null = Get-RuntimeValidatedDirectoryPath $release
  }
  $proof = Get-Content -LiteralPath (Join-Path $release 'runtime-prepared.json') -Raw | ConvertFrom-Json
  if ($proof.commit -cne $commit -or $proof.archiveSha256 -cne $sha) { throw 'Prepared release does not match the fetched commit and archive.' }
  $record.release = $release
  Record 'activation-started'
  $journalPath = Join-Path $runtimeControl 'activation.json'
  $previousJournalHash = if (Test-Path -LiteralPath $journalPath) { (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash } else { $null }
  $activationOutput = @(Invoke-RuntimeActivationCore -Config $configPath -Release $release -RuntimeRoot $runtime)
  try { $activation = $activationOutput[-1] | ConvertFrom-Json } catch { throw 'Activation did not return a completion record; manual inspection is required.' }
  if ($activation.phase -cne 'completed' -or -not $activation.release -or (FullPath ([string]$activation.release)) -ine $release -or ($null -ne $activation.commit -and $activation.commit -cne $commit)) { throw 'Activation output does not confirm the requested release; manual inspection is required.' }
  try {
    $journalHash = (Get-FileHash -LiteralPath $journalPath -Algorithm SHA256).Hash
    $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  } catch { throw 'Activation journal is missing or unreadable; manual inspection is required.' }
  if (($previousJournalHash -and $journalHash -eq $previousJournalHash) -or $journal.phase -cne 'completed' -or -not $journal.release -or (FullPath ([string]$journal.release)) -ine $release -or $journal.commit -cne $commit) { throw 'Activation journal does not confirm this release and commit; manual inspection is required.' }
  Record 'completed'
  Write-Output ($record | ConvertTo-Json -Compress)
} catch {
  if ($phase -and $phase -ne 'completed') {
    $record['error'] = $_.Exception.Message
    $failurePhase = if ($phase -eq 'activation-started') { 'activation-started' } else { 'failed-before-activation' }
    try { Record $failurePhase } catch { Write-Warning 'Could not persist failure state; inspect deployment state manually.' }
  }
  throw
} finally {
  if ($null -ne $configHandle) { $configHandle.Dispose() }
  if ($sourceLock) { $sourceLock.Dispose() }
  if ($runtimeLock) { $runtimeLock.Dispose() }
  if ($runtimeLocked) { $runtimeMutex.ReleaseMutex() }
  $runtimeMutex.Dispose()
}
