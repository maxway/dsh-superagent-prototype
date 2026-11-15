import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const deploy = fileURLToPath(new URL('../scripts/deploy-direct.ps1', import.meta.url))
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-direct-test-'))
  const source = join(root, 'source repo')
  const runtime = join(root, 'runtime root')
  const old = join(runtime, 'releases', 'old')
  const current = join(runtime, 'current')
  const bin = join(root, 'bin')
  const config = join(root, 'service config.json')
  const log = join(root, 'calls.jsonl')
  for (const directory of [source, join(old, 'scripts'), bin]) mkdirSync(directory, { recursive: true })
  writeFileSync(config, JSON.stringify({ checkout: current }))
  symlinkSync(old, current, 'junction')

  const record = `$entry = @{ tool = $tool; args = @($commandArgs); cwd = (Get-Location).Path }; Add-Content -LiteralPath $env:TEST_LOG -Value (ConvertTo-Json -InputObject $entry -Compress -Depth 5)`
  const service = label => `param($Action, $Config, [switch]$UseInstalled)
$tool = '${label}'; $commandArgs = @($Action, $Config, [bool]$UseInstalled)
${record}
if ($Action -eq 'stop' -and $env:FAIL_STOP) { exit 23 }
exit 0
`
  writeFileSync(join(old, 'scripts', 'dsh-superagent.ps1'), service('old-service'))
  const newService = join(root, 'new-service.ps1')
  writeFileSync(newService, service('new-service'))
  const git = join(bin, 'fake-git.ps1')
  writeFileSync(git, `$tool = 'git'; $commandArgs = @($args)
${record}
if ($args -contains 'rev-parse') { Write-Output ('a' * 40) }
$output = @($args | Where-Object { $_ -like '--output=*' })
if ($output.Count -eq 1) { Set-Content -LiteralPath $output[0].Substring(9) -Value 'fake archive' }
exit 0
`)
  const pnpm = join(bin, 'fake-pnpm.ps1')
  writeFileSync(pnpm, `$tool = 'pnpm'; $commandArgs = @($args)
${record}
if ($args[0] -eq 'build' -and $env:FAIL_BUILD) { exit 17 }
exit 0
`)
  const tar = join(bin, 'fake-tar.ps1')
  writeFileSync(tar, `$tool = 'tar'; $commandArgs = @($args)
${record}
$index = [array]::IndexOf($args, '-C')
if ($index -lt 0) { exit 19 }
$scripts = Join-Path $args[$index + 1] 'scripts'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
Copy-Item -LiteralPath $env:TEST_NEW_SERVICE -Destination (Join-Path $scripts 'dsh-superagent.ps1')
exit 0
`)
  writeFileSync(join(bin, 'tar.cmd'), `@echo off\r\npwsh -NoLogo -NoProfile -NonInteractive -File "%~dp0fake-tar.ps1" %*\r\nexit /b %errorlevel%\r\n`)
  const env = { ...baseEnv, PATH: `${bin};${baseEnv.PATH || baseEnv.Path || ''}`, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TEST_LOG: log, TEST_NEW_SERVICE: newService }
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', deploy, '-SourceRepo', source, '-Remote', 'test-remote', '-Ref', 'refs/heads/test-branch', '-RuntimeRoot', runtime, '-Config', config, '-Node', process.execPath, '-Git', git, '-Pnpm', pnpm]
  const invoke = extra => spawnSync('pwsh', args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)) : []
  return { root, source, runtime, old, current, config, invoke, calls }
}

const windows = { skip: process.platform !== 'win32' }
const samePath = (actual, expected) => assert.equal(realpathSync(actual).toLowerCase(), realpathSync(expected).toLowerCase())

test('fetches and builds a release before stopping, switching and starting', windows, () => {
  const instance = fixture()
  try {
    const result = instance.invoke()
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const calls = instance.calls()
    assert.deepEqual(calls.map(call => call.tool), ['git', 'git', 'git', 'tar', 'pnpm', 'pnpm', 'old-service', 'new-service'])
    const [fetch, resolve, archive, tar, install, build, stop, start] = calls
    assert.deepEqual(resolve.args.slice(-2), ['rev-parse', 'FETCH_HEAD^{commit}'])
    assert.ok(fetch.args.includes('fetch'))
    assert.ok(fetch.args.includes('test-remote'))
    assert.ok(fetch.args.includes('refs/heads/test-branch'))
    assert.ok(fetch.args.includes(instance.source) || fetch.cwd.toLowerCase() === instance.source.toLowerCase())
    const archiveIndex = archive.args.indexOf('archive')
    const output = archive.args.find(arg => arg.startsWith('--output='))
    assert.ok(archiveIndex >= 0 && output)
    assert.equal(archive.args.at(-1), 'a'.repeat(40))
    assert.deepEqual(tar.args.slice(0, 2), ['-xf', output.slice('--output='.length)])
    assert.equal(tar.args[2], '-C')
    const release = tar.args[3]
    assert.ok(release && !relative(join(instance.runtime, 'releases'), release).startsWith('..'))
    samePath(install.cwd, release)
    samePath(build.cwd, release)
    assert.deepEqual(install.args, ['install', '--frozen-lockfile'])
    assert.deepEqual(build.args, ['build'])
    assert.deepEqual(stop.args, ['stop', instance.config, false])
    assert.deepEqual(start.args, ['start', instance.config, true])
    samePath(instance.current, release)
    assert.notEqual(realpathSync(instance.current).toLowerCase(), realpathSync(instance.old).toLowerCase())
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('build failure leaves the old service and junction untouched', windows, () => {
  const instance = fixture()
  try {
    const result = instance.invoke({ FAIL_BUILD: '1' })
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(instance.calls().map(call => call.tool), ['git', 'git', 'git', 'tar', 'pnpm', 'pnpm'])
    samePath(instance.current, instance.old)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('stop failure does not switch the junction or start the new service', windows, () => {
  const instance = fixture()
  try {
    const result = instance.invoke({ FAIL_STOP: '1' })
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(instance.calls().map(call => call.tool), ['git', 'git', 'git', 'tar', 'pnpm', 'pnpm', 'old-service'])
    samePath(instance.current, instance.old)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})
