import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'

const coordinator = fileURLToPath(new URL('../scripts/deploy-runtime.ps1', import.meta.url))
const activate = fileURLToPath(new URL('../scripts/activate-runtime.ps1', import.meta.url))
const lockHelper = fileURLToPath(new URL('../scripts/superagent-lifecycle-lock.ps1', import.meta.url))
const pathHelper = fileURLToPath(new URL('../scripts/runtime-paths.ps1', import.meta.url))
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())))
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, env: baseEnv, ...options })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-deploy-test-'))
  const gitTemplate = join(root, 'git-template')
  mkdirSync(gitTemplate)
  const gitEnv = { ...baseEnv, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_TEMPLATE_DIR: gitTemplate, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: gitTemplate }
  const git = (...args) => {
    const result = run('git', args, { cwd: root, env: gitEnv })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const control = join(root, 'control')
  const work = join(root, 'work')
  const remote = join(root, 'remote.git')
  const source = join(root, 'source.git')
  const runtime = join(root, 'runtime')
  const config = join(root, 'config.json')
  for (const directory of [control, join(work, 'scripts'), join(runtime, 'control')]) mkdirSync(directory, { recursive: true })
  copyFileSync(coordinator, join(control, 'deploy-runtime.ps1'))
  copyFileSync(activate, join(control, 'activate-runtime.ps1'))
  copyFileSync(lockHelper, join(control, 'superagent-lifecycle-lock.ps1'))
  copyFileSync(pathHelper, join(control, 'runtime-paths.ps1'))
  for (const name of ['runtime-verify.ps1']) copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(control, name))
  const service = { checkout: join(runtime, 'current'), home: join(root, 'home'), profile: 'isolated-profile', url: 'http://127.0.0.1:39195', installedOnly: true, node: process.execPath }
  mkdirSync(service.home)
  writeFileSync(config, JSON.stringify(service))
  writeFileSync(join(runtime, 'control', 'binding.json'), JSON.stringify({ current: service.checkout, home: service.home, profile: service.profile, url: service.url }))
  const release = join(runtime, 'releases', 'old')
  mkdirSync(join(release, 'scripts'), { recursive: true })
  symlinkSync(release, service.checkout, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(release, 'scripts', 'dsh-superagent.ps1'), `
param($Action, $Config)
if ($Action -ne 'status') { throw 'Unexpected service action' }
if ($env:STATUS_OUTPUT) { Write-Output $env:STATUS_OUTPUT } else { '{"identity":"listener","home_matches":true,"pids":[],"listener":[],"foreign":[],"unlistening":[]}' }
if ($env:STATUS_EXIT) { exit [int]$env:STATUS_EXIT }
exit 0
`)
  writeFileSync(join(work, 'scripts', 'runtime-artifact.mjs'), `
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
if (process.env.FAIL_BUILD) process.exit(12)
if (process.env.BUILD_MARK) writeFileSync(process.env.BUILD_MARK, 'called')
if (process.env.ENV_MARK) writeFileSync(process.env.ENV_MARK, JSON.stringify({ gitDir: Object.hasOwn(process.env, 'GIT_DIR'), gitWorkTree: Object.hasOwn(process.env, 'GIT_WORK_TREE'), marker: process.env.SAFE_MARKER }))
if (process.env.BUILD_READY) {
  writeFileSync(process.env.BUILD_READY, 'ready')
  while (!existsSync(process.env.BUILD_CONTINUE)) await new Promise(resolve => setTimeout(resolve, 30))
}
writeFileSync(join(process.argv[5], 'artifact.zip'), process.argv[3])
`)
  git('init', '-q', `--template=${gitTemplate}`, work)
  git('-C', work, 'config', 'user.name', 'Test')
  git('-C', work, 'config', 'user.email', 'test@example.invalid')
  git('-C', work, 'add', '.')
  git('-C', work, 'commit', '-qm', 'test')
  const commit = git('-C', work, 'rev-parse', 'HEAD')
  git('clone', '-q', '--bare', `--template=${gitTemplate}`, work, remote)
  git('init', '-q', '--bare', `--template=${gitTemplate}`, source)
  git('-C', source, 'remote', 'add', 'local', remote)
  const ref = git('-C', work, 'symbolic-ref', 'HEAD')
  writeFileSync(join(control, 'prepare-runtime.ps1'), `
param($Archive, $Sha256, $RuntimeRoot, $Node, $Pnpm)
if ($env:FAIL_PREPARE) { exit 17 }
$release = Join-Path $RuntimeRoot 'releases/test-release'
New-Item -ItemType Directory -Path $release -Force | Out-Null
$commit = if ($env:BAD_COMMIT) { 'bad-commit' } else { Get-Content -LiteralPath $Archive -Raw }
@{ commit = $commit; archiveSha256 = $Sha256 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'runtime-prepared.json')
@{ prepared = $true; release = $release; archiveSha256 = $Sha256 } | ConvertTo-Json -Compress
`)
  writeFileSync(join(control, 'runtime-activation-core.ps1'), `
function Invoke-RuntimeActivationCore {
param($Config, $Release, $RuntimeRoot)
Add-Content -LiteralPath (Join-Path $RuntimeRoot 'activation-calls') -Value $Release
if ($env:ACTIVATE_READY) {
  Set-Content -LiteralPath $env:ACTIVATE_READY -Value 'ready'
  while (-not (Test-Path -LiteralPath $env:ACTIVATE_CONTINUE)) { Start-Sleep -Milliseconds 30 }
}
if ($env:EXIT_ACTIVATE) { exit 23 }
if ($env:FAIL_ACTIVATE) { throw 'fake activation failed' }
if ($env:ACTIVATE_MODE -eq 'noop') { return }
$commit = (Get-Content -LiteralPath (Join-Path $Release 'runtime-prepared.json') -Raw | ConvertFrom-Json).commit
$journal = @{ phase = 'completed'; release = $Release; commit = $commit; at = [DateTime]::UtcNow.ToString('o') }
if ($env:ACTIVATE_MODE -eq 'bad-journal-commit') { $journal.commit = 'wrong' }
if ($env:ACTIVATE_MODE -eq 'bad-journal-release') { $journal.release = Join-Path $RuntimeRoot 'releases/old' }
if ($env:ACTIVATE_MODE -eq 'bad-journal-phase') { $journal.phase = 'starting' }
if ($env:ACTIVATE_MODE -notin @('missing-journal', 'stale-journal')) { $journal | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'control/activation.json') }
$output = @{ phase = 'completed'; release = $Release }
if ($env:ACTIVATE_MODE -eq 'bad-output-release') { $output.release = Join-Path $RuntimeRoot 'releases/old' }
if ($env:ACTIVATE_MODE -eq 'bad-output-phase') { $output.phase = 'starting' }
if ($env:ACTIVATE_MODE -eq 'bad-output-commit') { $output.commit = 'wrong' }
$output | ConvertTo-Json -Compress
}
`)
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(control, 'deploy-runtime.ps1'), '-SourceRepo', source, '-Remote', 'local', '-Ref', ref, '-RuntimeRoot', runtime, '-Config', config, '-Node', process.execPath]
  const env = { ...baseEnv, HOME: root, USERPROFILE: root, DSH_HOME: join(root, 'home'), LUMOS_API_KEY: 'test-only', GIT_CEILING_DIRECTORIES: root, GIT_OPTIONAL_LOCKS: '0' }
  const invoke = (extra = {}, customArgs = args) => run('pwsh', customArgs, { env: { ...env, ...extra } })
  const state = () => JSON.parse(readFileSync(join(runtime, 'control', 'deploy-runtime.json'), 'utf8'))
  return { root, control, runtime, args, env, invoke, state, commit, source, ref }
}

test('rejects control code inside the runtime before loading it', () => {
  const instance = fixture()
  try {
    const control = join(instance.runtime, 'control')
    const entry = join(control, 'deploy-runtime.ps1')
    const marker = join(instance.root, 'untrusted-helper-called')
    copyFileSync(coordinator, entry)
    writeFileSync(join(control, 'runtime-paths.ps1'), `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'called'\n`)
    const args = instance.args.map(value => value === join(instance.control, 'deploy-runtime.ps1') ? entry : value)
    const result = instance.invoke({}, args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Control directory, source repository and runtime root must be independent/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(join(control, 'deploy-runtime.json')), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('rejects a linked control helper before any deployment action', { skip: process.platform !== 'win32' }, () => {
  const instance = fixture()
  try {
    const helper = join(instance.control, 'runtime-paths.ps1')
    const outside = join(instance.root, 'outside-helper')
    mkdirSync(outside)
    rmSync(helper)
    symlinkSync(outside, helper, 'junction')
    const result = instance.invoke()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Trusted control file must be a regular file/)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('rejects runtime aliases before any deployment action', { skip: process.platform !== 'win32' }, () => {
  const instance = fixture()
  try {
    const alias = join(instance.root, 'runtime-alias')
    symlinkSync(instance.runtime, alias, 'junction')
    const args = instance.args.map(value => value === instance.runtime ? alias : value)
    const result = instance.invoke({}, args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Reparse points are not supported/)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('rejects missing or mismatched binding before building', () => {
  const instance = fixture()
  try {
    const binding = join(instance.runtime, 'control', 'binding.json')
    const original = JSON.parse(readFileSync(binding, 'utf8'))
    const marker = join(instance.root, 'build-called')
    rmSync(binding)
    const missing = instance.invoke({ BUILD_MARK: marker })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /binding is missing or unreadable/)
    writeFileSync(binding, JSON.stringify({ ...original, profile: 'wrong-profile' }))
    const mismatched = instance.invoke({ BUILD_MARK: marker })
    assert.notEqual(mismatched.status, 0)
    assert.match(mismatched.stderr, /bound to a different service/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('preflight rejects running, uncertain, missing and failed status before fetch or state', () => {
  const instance = fixture()
  try {
    const marker = join(instance.root, 'build-called')
    const state = join(instance.runtime, 'control', 'deploy-runtime.json')
    const script = join(instance.runtime, 'current', 'scripts', 'dsh-superagent.ps1')
    const empty = { identity: 'listener', home_matches: true, pids: [], listener: [], foreign: [], unlistening: [] }
    for (const extra of [
      { STATUS_OUTPUT: JSON.stringify({ ...empty, pids: [123], listener: [123] }) },
      { STATUS_OUTPUT: JSON.stringify({ ...empty, identity: 'scan' }) },
      { STATUS_OUTPUT: JSON.stringify({ ...empty, listener: null }) },
      { STATUS_OUTPUT: JSON.stringify({ ...empty, pids: '[]' }) },
      { STATUS_OUTPUT: JSON.stringify({ ...empty, unlistening: [123] }), STATUS_EXIT: '1' },
      { STATUS_OUTPUT: JSON.stringify({ ...empty, foreign: [123] }) },
      { STATUS_OUTPUT: '{bad' },
      { STATUS_OUTPUT: JSON.stringify(empty), STATUS_EXIT: '2' }
    ]) {
      const result = instance.invoke({ ...extra, BUILD_MARK: marker })
      assert.notEqual(result.status, 0, JSON.stringify(extra))
      assert.equal(existsSync(marker), false)
      assert.equal(existsSync(state), false)
      assert.equal(existsSync(join(instance.source, 'FETCH_HEAD')), false)
      assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
    }
    rmSync(script)
    const missing = instance.invoke({ BUILD_MARK: marker })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /service control is missing/)
    assert.equal(existsSync(state), false)
    assert.equal(existsSync(marker), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('preflight rejects a current link outside runtime releases', () => {
  const instance = fixture()
  try {
    const current = join(instance.runtime, 'current')
    const outside = join(instance.root, 'outside')
    mkdirSync(outside)
    rmSync(current)
    symlinkSync(outside, current, process.platform === 'win32' ? 'junction' : 'dir')
    const result = instance.invoke()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /points outside releases/)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    assert.equal(existsSync(join(instance.source, 'FETCH_HEAD')), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('stopped status with exit code 1 permits deployment', () => {
  const instance = fixture()
  try {
    const result = instance.invoke({ STATUS_EXIT: '1' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(instance.state().phase, 'completed')
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('real status rejects an occupied isolated endpoint before deployment', { skip: process.platform !== 'win32' }, async () => {
  const instance = fixture()
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    const config = join(instance.root, 'config.json')
    const settings = JSON.parse(readFileSync(config, 'utf8'))
    settings.profile = `runtime-test-${randomUUID()}`
    settings.url = `http://127.0.0.1:${port}`
    writeFileSync(config, JSON.stringify(settings))
    writeFileSync(join(instance.runtime, 'control', 'binding.json'), JSON.stringify({ current: settings.checkout, home: settings.home, profile: settings.profile, url: settings.url }))
    const scripts = join(instance.runtime, 'releases', 'old', 'scripts')
    for (const name of ['dsh-superagent.ps1', 'dsh-superagent']) {
      copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(scripts, name))
    }
    writeFileSync(join(instance.runtime, 'releases', 'old', 'package.json'), JSON.stringify({ type: 'module' }))
    const assertOccupied = result => {
      assert.equal(result.status, 1, result.stderr)
      const status = JSON.parse(result.stdout)
      assert.equal(status.profile, settings.profile)
      assert.equal(status.url, settings.url)
      assert.equal(status.identity, 'listener')
      assert.equal(status.home_matches, true)
      assert.deepEqual(status.pids, [])
      assert.deepEqual(status.unlistening, [])
      assert.ok(status.listener.includes(process.pid))
      assert.ok(status.foreign.some(entry => entry.pid === process.pid))
    }
    assertOccupied(run(process.execPath, [join(scripts, 'dsh-superagent'), 'status', '--profile', settings.profile, '--home', settings.home, '--url', settings.url], { env: instance.env }))
    assertOccupied(run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(scripts, 'dsh-superagent.ps1'), 'status', '-Config', config], { env: instance.env }))
    const marker = join(instance.root, 'build-called')
    const result = instance.invoke({ BUILD_MARK: marker })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Service is running or status is uncertain/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(instance.root, { recursive: true, force: true })
  }
})

test('rejects a Node mismatch before building or activation', () => {
  const instance = fixture()
  try {
    const config = join(instance.root, 'config.json')
    const settings = JSON.parse(readFileSync(config, 'utf8'))
    settings.node = join(instance.root, 'other-node.exe')
    writeFileSync(config, JSON.stringify(settings))
    const marker = join(instance.root, 'build-called')
    const result = instance.invoke({ BUILD_MARK: marker })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /pin the installed checkout and configured Node/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('incomplete or unreadable activation journals block work before build', () => {
  const instance = fixture()
  try {
    const journal = join(instance.runtime, 'control', 'activation.json')
    const marker = join(instance.root, 'build-called')
    for (const content of ['{"phase":"starting"}', '{"phase":"switching"}', '{"phase":"Completed"}', '{bad', 'null', '[]']) {
      writeFileSync(journal, content)
      const result = instance.invoke({ BUILD_MARK: marker })
      assert.notEqual(result.status, 0, content)
      assert.match(result.stderr, /Activation journal|Previous activation/, content)
      assert.equal(existsSync(marker), false, content)
      assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false, content)
      assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false, content)
    }
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('fetch, build and prepare failures never activate; successful release pins fetched commit', () => {
  const instance = fixture()
  try {
    const missingRef = instance.args.map(value => value === instance.ref ? 'refs/heads/missing' : value)
    assert.notEqual(instance.invoke({}, missingRef).status, 0)
    assert.equal(instance.state().phase, 'failed-before-activation')
    assert.notEqual(instance.invoke({ FAIL_BUILD: '1' }).status, 0)
    assert.equal(instance.state().phase, 'failed-before-activation')
    assert.notEqual(instance.invoke({ FAIL_PREPARE: '1' }).status, 0)
    assert.equal(instance.state().phase, 'failed-before-activation')
    assert.notEqual(instance.invoke({ BAD_COMMIT: '1' }).status, 0)
    assert.equal(instance.state().phase, 'failed-before-activation')
    assert.equal(existsSync(join(instance.runtime, 'activation-calls')), false)
    const envMarker = join(instance.root, 'builder-environment.json')
    const result = instance.invoke({ GIT_DIR: join(instance.root, 'wrong-git-dir'), GIT_WORK_TREE: join(instance.root, 'wrong-worktree'), GIT_INDEX_FILE: join(instance.root, 'wrong-index'), ENV_MARK: envMarker, SAFE_MARKER: 'preserved' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(envMarker, 'utf8')), { gitDir: false, gitWorkTree: false, marker: 'preserved' })
    assert.equal(instance.state().phase, 'completed')
    assert.equal(instance.state().commit, instance.commit)
    assert.equal(readFileSync(join(instance.runtime, 'activation-calls'), 'utf8').trim(), instance.state().release)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('failed or interrupted activation requires manual inspection', () => {
  const instance = fixture()
  try {
    const failed = instance.invoke({ FAIL_ACTIVATE: '1' })
    assert.notEqual(failed.status, 0)
    assert.equal(instance.state().phase, 'activation-started')
    assert.equal(instance.state().commit, instance.commit)
    assert.ok(instance.state().release)
    assert.match(instance.state().error, /fake activation failed/)
    const calls = readFileSync(join(instance.runtime, 'activation-calls'), 'utf8')
    const retry = instance.invoke()
    assert.notEqual(retry.status, 0)
    assert.match(retry.stderr, /manual inspection/)
    assert.equal(readFileSync(join(instance.runtime, 'activation-calls'), 'utf8'), calls)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('activation script exit preserves intent and releases runtime lock', () => {
  const instance = fixture()
  try {
    const result = instance.invoke({ EXIT_ACTIVATE: '1' })
    assert.notEqual(result.status, 0)
    assert.equal(instance.state().phase, 'activation-started')
    const direct = run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', activate, '-Config', join(instance.root, 'config.json'), '-Release', join(instance.runtime, 'releases', 'test-release'), '-RuntimeRoot', instance.runtime])
    assert.notEqual(direct.status, 0)
    assert.match(direct.stderr, /Deployment journal requires manual inspection/)
    const retry = instance.invoke()
    assert.notEqual(retry.status, 0)
    assert.match(retry.stderr, /manual inspection/)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('activation completion requires fresh matching output and journal', () => {
  const instance = fixture()
  const journal = join(instance.runtime, 'control', 'activation.json')
  const state = join(instance.runtime, 'control', 'deploy-runtime.json')
  try {
    for (const mode of ['noop', 'missing-journal', 'stale-journal', 'bad-output-release', 'bad-output-phase', 'bad-output-commit', 'bad-journal-release', 'bad-journal-phase', 'bad-journal-commit']) {
      writeFileSync(state, JSON.stringify({ phase: 'completed' }))
      rmSync(journal, { force: true })
      if (mode === 'stale-journal') {
        writeFileSync(journal, JSON.stringify({ phase: 'completed', release: join(instance.runtime, 'releases', 'test-release'), commit: instance.commit }))
      }
      const result = instance.invoke({ ACTIVATE_MODE: mode })
      assert.notEqual(result.status, 0, mode)
      assert.equal(instance.state().phase, 'activation-started', mode)
      assert.match(instance.state().error, /manual inspection/, mode)
      const calls = readFileSync(join(instance.runtime, 'activation-calls'), 'utf8')
      const retry = instance.invoke()
      assert.notEqual(retry.status, 0, mode)
      assert.equal(readFileSync(join(instance.runtime, 'activation-calls'), 'utf8'), calls, mode)
    }
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('crashed activation leaves direct activation fenced', async () => {
  const instance = fixture()
  const ready = join(instance.root, 'activate-ready')
  const proceed = join(instance.root, 'activate-proceed')
  const child = spawn('pwsh', instance.args, { env: { ...instance.env, ACTIVATE_READY: ready, ACTIVATE_CONTINUE: proceed }, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise(resolve => child.on('close', resolve))
  try {
    const deadline = Date.now() + 20000
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(existsSync(ready), true, errors)
    assert.equal(instance.state().phase, 'activation-started')
    child.kill()
    await exited
    const direct = run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', activate, '-Config', join(instance.root, 'config.json'), '-Release', join(instance.runtime, 'releases', 'test-release'), '-RuntimeRoot', instance.runtime])
    assert.notEqual(direct.status, 0)
    assert.match(direct.stderr, /Deployment journal requires manual inspection/)
    assert.equal(instance.state().phase, 'activation-started')
  } finally {
    if (child.exitCode === null && child.signalCode === null) { writeFileSync(proceed, 'go'); await exited }
    rmSync(instance.root, { recursive: true, force: true })
  }
})

test('direct activation excludes a concurrent coordinator', async () => {
  const instance = fixture()
  const ready = join(instance.root, 'direct-ready')
  const proceed = join(instance.root, 'direct-proceed')
  const release = join(instance.runtime, 'releases', 'test-release')
  mkdirSync(release, { recursive: true })
  writeFileSync(join(release, 'runtime-prepared.json'), JSON.stringify({ commit: instance.commit }))
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(instance.control, 'activate-runtime.ps1'), '-Config', join(instance.root, 'config.json'), '-Release', release, '-RuntimeRoot', instance.runtime], { env: { ...instance.env, ACTIVATE_READY: ready, ACTIVATE_CONTINUE: proceed }, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise(resolve => child.on('close', resolve))
  try {
    const deadline = Date.now() + 20000
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(existsSync(ready), true, errors)
    const concurrent = instance.invoke()
    assert.notEqual(concurrent.status, 0)
    assert.match(concurrent.stderr, /Another runtime operation/)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false)
    writeFileSync(proceed, 'go')
    assert.equal(await exited, 0, errors)
  } finally {
    if (child.exitCode === null) { writeFileSync(proceed, 'go'); await exited }
    rmSync(instance.root, { recursive: true, force: true })
  }
})

test('concurrent coordinators cannot deploy the same runtime', async () => {
  const instance = fixture()
  const ready = join(instance.root, 'ready')
  const proceed = join(instance.root, 'proceed')
  const child = spawn('pwsh', instance.args, { env: { ...instance.env, BUILD_READY: ready, BUILD_CONTINUE: proceed }, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise(resolve => child.on('close', resolve))
  try {
    const deadline = Date.now() + 20000
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(existsSync(ready), true, errors)
    const concurrent = instance.invoke()
    assert.notEqual(concurrent.status, 0)
    assert.match(concurrent.stderr, /Another runtime operation/)
    const direct = run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', activate, '-Config', join(instance.root, 'config.json'), '-Release', join(instance.runtime, 'releases', 'test-release'), '-RuntimeRoot', instance.runtime])
    assert.notEqual(direct.status, 0)
    assert.match(direct.stderr, /Another runtime operation/)
    writeFileSync(proceed, 'go')
    assert.equal(await exited, 0, errors)
    assert.equal(instance.state().phase, 'completed')
  } finally {
    if (child.exitCode === null) { writeFileSync(proceed, 'go'); await exited }
    rmSync(instance.root, { recursive: true, force: true })
  }
})
