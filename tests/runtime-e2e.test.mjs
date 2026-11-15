import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url))
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options })
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())))
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' })
function git(...args) {
  const result = run('git', args, { env: gitEnv, cwd: gitEnv.HOME })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const required = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'runtime-build.json', 'lib/index.js', 'lib/github-watch.js', 'lib/gitlab-watch.js', 'lib/feishu-watch.js', 'scripts/dsh-superagent', 'scripts/dsh-superagent.ps1', 'scripts/service-start.ps1', 'scripts/superagent-lifecycle-lock.ps1', 'scripts/launch-hidden.vbs', 'scripts/prepare-runtime.ps1', 'scripts/initialize-runtime.ps1', 'scripts/activate-runtime.ps1', 'scripts/runtime-activation-core.ps1', 'scripts/runtime-verify.ps1', 'scripts/runtime-paths.ps1']
function makeRelease(path, service, commit, sha, importMarker) {
  const files = {}
  for (const name of required) {
    const target = join(path, name)
    mkdirSync(join(target, '..'), { recursive: true })
    const content = name === 'scripts/dsh-superagent.ps1' ? service : name === 'package.json' ? '{"type":"module"}' : name === 'runtime-build.json' ? JSON.stringify({ format: 1, commit }) : name === 'lib/index.js' ? `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(importMarker)}, 'yes')` : ''
    writeFileSync(target, content)
    files[name] = createHash('sha256').update(content).digest('hex')
  }
  mkdirSync(join(path, 'node_modules'))
  writeFileSync(join(path, 'node_modules', 'fixture.js'), 'original')
  writeFileSync(join(path, 'runtime-prepared.json'), JSON.stringify({ commit, archiveSha256: sha, files }))
}
function fixture(root, pid) {
  Object.assign(gitEnv, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root })
  const control = join(root, 'control'), work = join(root, 'work'), remote = join(root, 'remote.git')
  const source = join(root, 'source.git'), runtime = join(root, 'runtime'), home = join(root, 'home')
  const current = join(runtime, 'current'), old = join(runtime, 'releases', 'old'), template = join(root, 'template')
  const config = join(root, 'config.json'), calls = join(root, 'calls'), marker = join(root, 'running')
  for (const path of [control, join(work, 'scripts'), join(home, 'profiles', 'isolated', 'node_modules'), join(runtime, 'control')]) mkdirSync(path, { recursive: true })
  for (const name of ['deploy-runtime.ps1', 'initialize-runtime.ps1', 'runtime-activation-core.ps1', 'runtime-verify.ps1', 'runtime-paths.ps1', 'superagent-lifecycle-lock.ps1']) copyFileSync(join(scripts, name), join(control, name))
  const service = `param($Action, $Config, [switch]$UseInstalled)
Add-Content -LiteralPath $env:E2E_CALLS -Value $Action
if ($Action -eq 'status') {
  if ($env:E2E_BAD_STATUS) { Write-Output '{bad'; exit 1 }
  if (Test-Path -LiteralPath $env:E2E_MARKER) {
    $target = [string]@((Get-Item -LiteralPath $env:E2E_CURRENT -Force).Target)[0]
    @{ identity='listener'; home_matches=$true; pids=@([int]$env:E2E_PID); listener=@([int]$env:E2E_PID); foreign=@(); unlistening=@(); start=@{pid=[int]$env:E2E_PID}; deployment=@{bundleTarget=$target} } | ConvertTo-Json -Depth 5 -Compress
  } else { '{"identity":"listener","home_matches":true,"pids":[],"listener":[],"foreign":[],"unlistening":[]}' }
  exit 0
}
if ($Action -eq 'start') { if ($env:E2E_FAIL_START) { exit 7 }; Set-Content -LiteralPath $env:E2E_MARKER -Value 'running' }
if ($Action -eq 'verify' -and $env:E2E_FAIL_VERIFY) { exit 8 }
if ($Action -eq 'stop') { throw 'Unexpected stop: the fake service is initially stopped.' }
exit 0
`
  makeRelease(old, service, 'a'.repeat(40), 'b'.repeat(64), join(root, 'import-old'))
  makeRelease(template, service, 'a'.repeat(40), 'b'.repeat(64), join(root, 'import-next'))
  writeFileSync(join(work, 'scripts', 'runtime-artifact.mjs'), `import { writeFileSync, existsSync } from 'node:fs'
if (process.env.E2E_BUILD_MARK) writeFileSync(process.env.E2E_BUILD_MARK, 'called')
if (process.env.E2E_BUILD_READY) {
  writeFileSync(process.env.E2E_BUILD_READY, 'ready')
  while (!existsSync(process.env.E2E_BUILD_CONTINUE)) await new Promise(resolve => setTimeout(resolve, 30))
}
writeFileSync(process.argv[5] + '/artifact.zip', process.argv[3])
`)
  git('init', '-q', work)
  git('-C', work, 'config', 'user.name', 'Test')
  git('-C', work, 'config', 'user.email', 'test@example.invalid')
  git('-C', work, 'add', '.')
  git('-C', work, 'commit', '-qm', 'fixture')
  const commit = git('-C', work, 'rev-parse', 'HEAD'), ref = git('-C', work, 'symbolic-ref', 'HEAD')
  git('clone', '-q', '--bare', work, remote)
  git('init', '-q', '--bare', source)
  git('-C', source, 'remote', 'add', 'local', remote)
  writeFileSync(join(control, 'prepare-runtime.ps1'), `param($Archive, $Sha256, $RuntimeRoot, $Node, $Pnpm)
if ($env:E2E_FAIL_PREPARE) { exit 17 }
$release = Join-Path $RuntimeRoot 'releases/next'
Copy-Item -LiteralPath $env:E2E_TEMPLATE -Destination $release -Recurse
if ($env:E2E_TAMPER -eq 'bundle') { Set-Content -LiteralPath (Join-Path $release 'lib/index.js') -Value 'tampered' }
if ($env:E2E_TAMPER -eq 'extra') { Set-Content -LiteralPath (Join-Path $release 'unexpected.js') -Value 'tampered' }
$recordPath = Join-Path $release 'runtime-prepared.json'
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$record.commit = (Get-Content -LiteralPath $Archive -Raw).Trim()
$record.archiveSha256 = $Sha256
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM
@{ prepared=$true; release=$release; archiveSha256=$Sha256 } | ConvertTo-Json -Compress
`)
  writeFileSync(config, JSON.stringify({ checkout: current, home, profile: 'isolated', url: 'http://127.0.0.1:39195', installedOnly: true, node: process.execPath }))
  const env = { ...gitEnv, HOME: home, USERPROFILE: home, DSH_HOME: home, TEMP: root, TMP: root, E2E_CALLS: calls, E2E_MARKER: marker, E2E_CURRENT: current, E2E_PID: String(pid), E2E_TEMPLATE: template }
  const shell = (args, extra = {}) => run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { cwd: root, env: { ...env, ...extra } })
  const initialized = shell(['-File', join(control, 'initialize-runtime.ps1'), '-Config', config, '-Release', old, '-RuntimeRoot', runtime])
  assert.equal(initialized.status, 0, initialized.stderr)
  const bundle = join(home, 'profiles', 'isolated', 'node_modules', 'dsh-superagent')
  const linked = shell(['-Command', 'New-Item -ItemType Junction -Path $env:E2E_BUNDLE -Target $env:E2E_CURRENT | Out-Null'], { E2E_BUNDLE: bundle })
  assert.equal(linked.status, 0, linked.stderr)
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(control, 'deploy-runtime.ps1'), '-SourceRepo', source, '-Remote', 'local', '-Ref', ref, '-RuntimeRoot', runtime, '-Config', config, '-Node', process.execPath]
  const invoke = (extra = {}) => run('pwsh', args, { cwd: root, env: { ...env, ...extra } })
  const state = name => JSON.parse(readFileSync(join(runtime, 'control', name + '.json'), 'utf8'))
  return { root, runtime, current, old, calls, commit, env, args, invoke, state }
}

async function withFixture(action) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-e2e-'))
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, stdio: 'ignore', env: { ...gitEnv, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root } })
  const exited = new Promise(resolve => fake.once('close', resolve))
  try {
    await action(fixture(root, fake.pid))
  } finally {
    fake.kill()
    await exited
    rmSync(root, { recursive: true, force: true })
  }
}

test('coordinator and real activation complete with a fully isolated fake service', { skip: process.platform !== 'win32' }, async () => {
  await withFixture(instance => {
    const result = instance.invoke()
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const deployment = instance.state('deploy-runtime'), journal = instance.state('activation')
    assert.equal(deployment.phase, 'completed')
    assert.equal(deployment.commit, instance.commit)
    assert.equal(journal.phase, 'completed')
    assert.equal(journal.commit, instance.commit)
    assert.equal(journal.release, deployment.release)
    assert.equal(readdirSync(join(instance.runtime, 'control')).some(name => /^activation-.*\.tmp$/.test(name)), false)
    assert.equal(realpathSync(instance.current).toLowerCase(), realpathSync(deployment.release).toLowerCase())
    const calls = readFileSync(instance.calls, 'utf8').trim().split(/\r?\n/)
    assert.deepEqual(calls, ['status', 'status', 'status', 'start', 'status', 'verify'])
  })
})

test('coordinator rejects running or invalid status before building or recording deployment', { skip: process.platform !== 'win32' }, async () => {
  for (const mode of ['running', 'invalid']) await withFixture(instance => {
    const marker = join(instance.root, 'build-called')
    if (mode === 'running') writeFileSync(join(instance.root, 'running'), 'running')
    const result = instance.invoke({ E2E_BUILD_MARK: marker, ...(mode === 'invalid' ? { E2E_BAD_STATUS: '1' } : {}) })
    assert.notEqual(result.status, 0, mode)
    assert.equal(existsSync(marker), false, mode)
    assert.equal(existsSync(join(instance.runtime, 'control', 'deploy-runtime.json')), false, mode)
    assert.equal(readFileSync(instance.calls, 'utf8').trim(), 'status', mode)
    assert.equal(realpathSync(instance.current).toLowerCase(), realpathSync(instance.old).toLowerCase(), mode)
  })
})

test('coordinator rejects post-prepare tampering before service calls', { skip: process.platform !== 'win32' }, async () => {
  for (const tamper of ['bundle', 'extra']) await withFixture(instance => {
    const result = instance.invoke({ E2E_TAMPER: tamper })
    assert.notEqual(result.status, 0, result.stderr)
    assert.equal(readFileSync(instance.calls, 'utf8').trim(), 'status')
    assert.equal(existsSync(join(instance.root, 'import-next')), false)
    assert.equal(realpathSync(instance.current).toLowerCase(), realpathSync(instance.old).toLowerCase())
  })
})

test('prepare and real activation failures do not report success', { skip: process.platform !== 'win32' }, async () => {
  await withFixture(instance => {
    const prepare = instance.invoke({ E2E_FAIL_PREPARE: '1' })
    assert.notEqual(prepare.status, null, prepare.error?.message)
    assert.notEqual(prepare.status, 0)
    assert.equal(instance.state('deploy-runtime').phase, 'failed-before-activation')
    assert.equal(readFileSync(instance.calls, 'utf8').trim(), 'status')
    assert.equal(realpathSync(instance.current).toLowerCase(), realpathSync(instance.old).toLowerCase())
    const failure = instance.invoke({ E2E_FAIL_VERIFY: '1' })
    assert.notEqual(failure.status, null, failure.error?.message)
    assert.notEqual(failure.status, 0)
    assert.equal(instance.state('deploy-runtime').phase, 'activation-started')
    assert.equal(instance.state('activation').phase, 'starting')
    assert.match(failure.stderr, /verification failed/i)
    const calls = readFileSync(instance.calls, 'utf8')
    const retry = instance.invoke()
    assert.notEqual(retry.status, null, retry.error?.message)
    assert.notEqual(retry.status, 0)
    assert.equal(readFileSync(instance.calls, 'utf8'), calls)
  })
})

test('activation rechecks when service starts after preflight', { skip: process.platform !== 'win32' }, async () => {
  await withFixture(async instance => {
    const ready = join(instance.root, 'ready'), proceed = join(instance.root, 'proceed')
    const child = spawn('pwsh', instance.args, { cwd: instance.root, env: { ...instance.env, E2E_BUILD_READY: ready, E2E_BUILD_CONTINUE: proceed }, stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    const exited = new Promise(resolve => child.once('close', resolve))
    try {
      const deadline = Date.now() + 20000
      while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(existsSync(ready), true, errors)
      writeFileSync(join(instance.root, 'running'), 'running')
      writeFileSync(proceed, 'go')
      assert.notEqual(await exited, 0)
      assert.match(errors, /running service loaded release cannot be established/)
      assert.equal(instance.state('deploy-runtime').phase, 'activation-started')
      assert.equal(readFileSync(instance.calls, 'utf8').trim().split(/\r?\n/).includes('stop'), false)
      assert.equal(realpathSync(instance.current).toLowerCase(), realpathSync(instance.old).toLowerCase())
    } finally {
      if (child.exitCode === null && child.signalCode === null) { writeFileSync(proceed, 'go'); await exited }
    }
  })
})

test('concurrent coordinator is fenced while the first is building', { skip: process.platform !== 'win32' }, async () => {
  await withFixture(async instance => {
    const ready = join(instance.root, 'ready'), proceed = join(instance.root, 'proceed')
    const child = spawn('pwsh', instance.args, { cwd: instance.root, env: { ...instance.env, E2E_BUILD_READY: ready, E2E_BUILD_CONTINUE: proceed }, stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    const exited = new Promise(resolve => child.once('close', resolve))
    try {
      const deadline = Date.now() + 20000
      while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(existsSync(ready), true, errors)
      const concurrent = instance.invoke()
      assert.notEqual(concurrent.status, null, concurrent.error?.message)
      assert.notEqual(concurrent.status, 0)
      assert.match(concurrent.stderr, /Another runtime operation/)
      assert.equal(instance.state('deploy-runtime').phase, 'building')
      assert.equal(readFileSync(instance.calls, 'utf8').trim(), 'status')
      writeFileSync(proceed, 'go')
      assert.equal(await exited, 0, errors)
      assert.equal(instance.state('deploy-runtime').phase, 'completed')
      assert.equal(instance.state('activation').commit, instance.commit)
    } finally {
      if (child.exitCode === null && child.signalCode === null) { writeFileSync(proceed, 'go'); await exited }
    }
  })
})
