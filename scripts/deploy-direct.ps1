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
function Invoke-Native([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

$runtime = [System.IO.Path]::GetFullPath($RuntimeRoot)
$current = Join-Path $runtime 'current'
$service = Join-Path $current 'scripts/dsh-superagent.ps1'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ([System.IO.Path]::GetFullPath([string]$settings.checkout).TrimEnd([char[]]'\/') -ine $current.TrimEnd([char[]]'\/')) {
  throw 'Service configuration checkout must point to runtime current.'
}
$link = Get-Item -LiteralPath $current -Force
if ($link.LinkType -ne 'Junction') { throw 'Runtime current must be a junction.' }
$env:PATH = (Split-Path -Parent $Node) + [System.IO.Path]::PathSeparator + $env:PATH
Invoke-Native $Git @('-C', $SourceRepo, 'fetch', '--no-tags', $Remote, $Ref)
$commit = (& $Git -C $SourceRepo rev-parse 'FETCH_HEAD^{commit}' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $commit) { throw 'Cannot resolve fetched commit.' }
$release = Join-Path (Join-Path $runtime 'releases') ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $release -Force | Out-Null
$archive = Join-Path $release 'source.tar'
Invoke-Native $Git @('-C', $SourceRepo, 'archive', '--format=tar', "--output=$archive", $commit)
Invoke-Native 'tar' @('-xf', $archive, '-C', $release)
Remove-Item -LiteralPath $archive
Push-Location -LiteralPath $release
try {
  Invoke-Native $Pnpm @('install', '--frozen-lockfile')
  Invoke-Native $Pnpm @('build')
} finally { Pop-Location }
$shell = (Get-Process -Id $PID).Path
Invoke-Native $shell @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $service, 'stop', '-Config', $Config)
Remove-Item -LiteralPath $current -Force
New-Item -ItemType Junction -Path $current -Target $release | Out-Null
Invoke-Native $shell @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $service, 'start', '-Config', $Config, '-UseInstalled')
Write-Output (ConvertTo-Json @{ commit = $commit; release = $release } -Compress)
