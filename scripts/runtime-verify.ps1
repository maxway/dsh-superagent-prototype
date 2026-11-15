function Resolve-DependencyNode([string]$Node) {
  if (-not $Node) { $Node = 'node' }
  if (-not [System.IO.Path]::IsPathFullyQualified($Node)) { $Node = (Get-Command $Node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'Configured Node executable does not exist.' }
  return [System.IO.Path]::GetFullPath($Node)
}

function Assert-NoExternalNodeModules([string]$ReleasePath) {
  $ancestor = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($ReleasePath).TrimEnd([char[]]'\/'))
  while ($ancestor) {
    $candidate = Join-Path $ancestor 'node_modules'
    try {
      $null = [System.IO.File]::GetAttributes($candidate)
      throw "External node_modules directory is not allowed: $candidate"
    } catch [System.IO.FileNotFoundException] {
    } catch [System.IO.DirectoryNotFoundException] {
    }
    $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
  }
}

function Assert-NoUnlistedReleaseFiles([string]$ReleasePath, $Files) {
  $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $Files) { [void]$allowed.Add([string]$entry.Name) }
  foreach ($name in @('runtime-build.json', 'runtime-prepared.json')) { [void]$allowed.Add($name) }
  $pending = [System.Collections.Generic.Stack[object]]::new()
  $pending.Push(@{ path = $ReleasePath; relative = '' })
  while ($pending.Count) {
    $directory = $pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory.path -Force -ErrorAction Stop)) {
      $relative = if ($directory.relative) { $directory.relative + '/' + $item.Name } else { $item.Name }
      if ($item.LinkType -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Unsafe release entry: $relative" }
      if ($item.PSIsContainer) {
        if ($relative -cne 'node_modules') { $pending.Push(@{ path = $item.FullName; relative = $relative }) }
      } elseif (-not $allowed.Contains($relative)) {
        throw "Unlisted release file: $relative"
      }
    }
  }
}

function Test-PreparedRelease([string]$ReleasePath, [string]$Node) {
  $checkedDirectories = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  if ($IsWindows) {
    $directory = Get-Item -LiteralPath $ReleasePath -Force -ErrorAction Stop
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Unsafe release directory: $ReleasePath" }
    [void]$checkedDirectories.Add($ReleasePath)
  }
  $recordPath = Join-Path $ReleasePath 'runtime-prepared.json'
  try { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json } catch { throw 'Release preparation record is missing or unreadable.' }
  if ($record.commit -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' -or $record.archiveSha256 -notmatch '^[0-9a-f]{64}$' -or $null -eq $record.files) { throw 'Invalid release preparation record.' }
  $files = @($record.files.PSObject.Properties)
  $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $files) {
    $name = [string]$entry.Name
    if (-not $name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or $entry.Value -notmatch '^[0-9a-f]{64}$') { throw 'Unsafe release preparation record.' }
    if (-not $names.Add($name)) { throw 'Duplicate release file.' }
    if ($IsWindows) {
      $directoryPath = $ReleasePath
      $parts = $name.Split('/')
      for ($index = 0; $index -lt $parts.Length - 1; $index++) {
        $directoryPath = Join-Path $directoryPath $parts[$index]
        if (-not $checkedDirectories.Contains($directoryPath)) {
          $directory = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
          if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Unsafe release directory: $directoryPath" }
          [void]$checkedDirectories.Add($directoryPath)
        }
      }
    }
    $path = Join-Path $ReleasePath $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Release file missing: $name" }
    if ((Get-Item -LiteralPath $path -Force).LinkType -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.Value) { throw "Release file changed: $name" }
  }
  foreach ($required in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'runtime-build.json', 'lib/index.js', 'scripts/dsh-superagent', 'scripts/dsh-superagent.ps1', 'scripts/service-start.ps1', 'scripts/superagent-lifecycle-lock.ps1', 'scripts/launch-hidden.vbs', 'scripts/prepare-runtime.ps1', 'scripts/initialize-runtime.ps1', 'scripts/activate-runtime.ps1', 'scripts/runtime-activation-core.ps1', 'scripts/runtime-paths.ps1', 'scripts/runtime-verify.ps1')) {
    if (-not $names.Contains($required)) { throw "Release record missing required file: $required" }
  }
  try { $manifest = Get-Content -LiteralPath (Join-Path $ReleasePath 'runtime-build.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Runtime build manifest is unreadable.' }
  if ($manifest -isnot [pscustomobject] -or $manifest.format -isnot [long] -or $manifest.format -ne 1) { throw 'Invalid runtime build manifest format.' }
  Assert-NoExternalNodeModules $ReleasePath
  Assert-NoUnlistedReleaseFiles $ReleasePath $files
  return $record
}

function Test-PreparedRuntimeImport([string]$ReleasePath, [string]$Node) {
  Assert-NoExternalNodeModules $ReleasePath
  $Node = Resolve-DependencyNode $Node
  $temporaryHome = Join-Path ([System.IO.Path]::GetTempPath()) ('superagent-import-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporaryHome -ErrorAction Stop | Out-Null
  $allowed = @('PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE')
  $start = [System.Diagnostics.ProcessStartInfo]::new($Node)
  $start.WorkingDirectory = $ReleasePath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.Environment.Clear()
  foreach ($name in $allowed) { $value = [Environment]::GetEnvironmentVariable($name); if ($null -ne $value) { $start.Environment[$name] = $value } }
  $start.Environment['HOME'] = $temporaryHome
  $start.Environment['USERPROFILE'] = $temporaryHome
  foreach ($argument in @('--input-type=module', '-e', "import { pathToFileURL } from 'node:url'; for (const file of ['index', 'github-watch', 'gitlab-watch', 'feishu-watch']) await import(pathToFileURL(process.cwd() + '/lib/' + file + '.js').href)")) { $start.ArgumentList.Add($argument) }
  try {
    $process = [System.Diagnostics.Process]::Start($start)
    try {
      if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Release dependency import timed out.' }
      if ($process.ExitCode -ne 0) { throw 'Release dependency import failed.' }
    } finally { $process.Dispose() }
  } finally { Remove-Item -LiteralPath $temporaryHome -Recurse -Force }
}
