import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())))
const shell = (args, env = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-shell-'))
  try { return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', timeout: 120000, cwd: home, env: { ...baseEnv, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, ...env } }) }
  finally { rmSync(home, { recursive: true, force: true }) }
}

test('switches only a prepared release and records failed starts', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-activate-'))
  try {
    const control = join(root, 'control')
    mkdirSync(control)
    for (const name of ['activate-runtime.ps1', 'initialize-runtime.ps1', 'runtime-activation-core.ps1', 'runtime-paths.ps1', 'runtime-verify.ps1', 'superagent-lifecycle-lock.ps1']) {
      copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(control, name))
    }
    const activate = join(control, 'activate-runtime.ps1'), initialize = join(control, 'initialize-runtime.ps1')
    const runtime = join(root, 'runtime'), home = join(root, 'home')
    const releases = join(runtime, 'releases'), current = join(runtime, 'current')
    const old = join(releases, 'old'), next = join(releases, 'next'), broken = join(releases, 'broken')
    const profileModules = join(home, 'profiles', 'isolated-profile', 'node_modules')
    mkdirSync(profileModules, { recursive: true })
    const isolatedImport = `import { writeFileSync } from 'node:fs'; import { basename, join } from 'node:path'; writeFileSync(join(${JSON.stringify(root)}, 'import-' + basename(process.cwd())), 'yes'); if (process.env.RUNTIME_SECRET_VALUE) throw new Error('unexpected secret')\n`
    const calls = join(root, 'service-calls')
    const attacks = join(root, 'config-attacks')
    const fake = (fail, release) => `param($Action, $Config, [switch]$UseInstalled)\nAdd-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value $Action\nif ($env:ATTACK_CONFIG -eq '1') {\n  $replacement = "$Config.replacement"\n  [System.IO.File]::WriteAllText($replacement, '{"home":"wrong-target"}')\n  $rewrite = 'succeeded'; $replace = 'succeeded'\n  try { [System.IO.File]::WriteAllText($Config, '{"home":"wrong-target"}') } catch { $rewrite = 'blocked' }\n  try { [System.IO.File]::Move($replacement, $Config, $true) } catch { $replace = 'blocked' }\n  Remove-Item -LiteralPath $replacement -Force -ErrorAction SilentlyContinue\n  Add-Content -LiteralPath '${attacks.replaceAll("'", "''")}' -Value "$Action $rewrite $replace"\n}\n$marker = '${join(release, 'running').replaceAll("'", "''")}'\n$bundleTarget = if ($env:WRONG_BUNDLE_TARGET) { $env:WRONG_BUNDLE_TARGET } else { '${release.replaceAll("'", "''")}' }\nif ($Action -eq 'status') { if (Test-Path -LiteralPath $marker) { @{ identity='listener'; home_matches=$true; pids=@(12345); listener=@(12345); foreign=@(); unlistening=@(); start=@{pid=12345}; deployment=@{bundleTarget=$bundleTarget} } | ConvertTo-Json -Depth 5 } else { '{"identity":"listener","home_matches":true,"pids":[],"listener":[],"foreign":[],"unlistening":[]}' }; exit 0 }\nif ($Action -eq 'start') { if (${fail ? '$true' : '$false'}) { exit 7 }; New-Item -ItemType File -Path $marker | Out-Null }\nexit 0\n`
    for (const [release, fail] of [[old, false], [next, false], [broken, true]]) {
      mkdirSync(join(release, 'scripts'), { recursive: true })
      mkdirSync(join(release, 'lib'))
      const paths = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'runtime-build.json', 'lib/index.js', 'lib/github-watch.js', 'lib/gitlab-watch.js', 'lib/feishu-watch.js', 'scripts/dsh-superagent', 'scripts/dsh-superagent.ps1', 'scripts/service-start.ps1', 'scripts/superagent-lifecycle-lock.ps1', 'scripts/launch-hidden.vbs', 'scripts/prepare-runtime.ps1', 'scripts/initialize-runtime.ps1', 'scripts/activate-runtime.ps1', 'scripts/runtime-activation-core.ps1', 'scripts/runtime-paths.ps1', 'scripts/runtime-verify.ps1']
      for (const path of paths) writeFileSync(join(release, path), path.endsWith('dsh-superagent.ps1') ? fake(fail, release) : path === 'package.json' ? '{"type":"module"}' : path === 'runtime-build.json' ? JSON.stringify({ format: 1, commit: 'a'.repeat(40) }) : path === 'lib/index.js' ? isolatedImport : '')
      const files = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(release, path))).digest('hex')]))
      mkdirSync(join(release, 'node_modules'))
      writeFileSync(join(release, 'node_modules', 'fixture.js'), 'original')
      writeFileSync(join(release, 'runtime-prepared.json'), JSON.stringify({ commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), files }))
    }
    const config = join(root, 'service.json')
    const fakeBin = join(root, 'fake-bin'), fakeNodeMarker = join(root, 'fake-node-called')
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'node.cmd'), `@echo off\r\necho called > "${fakeNodeMarker}"\r\nexit /b 77\r\n`)
    const guardedPath = `${fakeBin};${process.env.PATH}`
    writeFileSync(config, JSON.stringify({ checkout: current, home, profile: 'isolated-profile', url: 'http://[::1]:39195', installedOnly: true, node: process.execPath }))
    const pathsHelper = join(control, 'runtime-paths.ps1'), outsideHelper = join(root, 'outside-helper')
    mkdirSync(outsideHelper)
    rmSync(pathsHelper)
    symlinkSync(outsideHelper, pathsHelper, 'junction')
    const linkedInitializer = shell(['-File', initialize, '-Config', config, '-Release', old, '-RuntimeRoot', runtime])
    assert.notEqual(linkedInitializer.status, 0)
    assert.match(linkedInitializer.stderr, /Trusted runtime path helper must be a regular file/)
    rmSync(pathsHelper)
    copyFileSync(fileURLToPath(new URL('../scripts/runtime-paths.ps1', import.meta.url)), pathsHelper)
    const candidateActivation = join(old, 'scripts', 'activate-runtime.ps1')
    const candidateLock = join(old, 'scripts', 'superagent-lifecycle-lock.ps1')
    const controlMarker = join(root, 'untrusted-control-called')
    writeFileSync(candidateActivation, readFileSync(activate))
    writeFileSync(candidateLock, `Set-Content -LiteralPath '${controlMarker.replaceAll("'", "''")}' -Value 'called'\n`)
    const untrustedActivation = shell(['-File', candidateActivation, '-Config', config, '-Release', old, '-RuntimeRoot', runtime])
    assert.notEqual(untrustedActivation.status, 0)
    assert.match(untrustedActivation.stderr, /Trusted control directory must be outside the release/)
    assert.equal(existsSync(controlMarker), false)
    writeFileSync(candidateActivation, '')
    writeFileSync(candidateLock, '')
    const candidateInitializer = join(old, 'scripts', 'initialize-runtime.ps1')
    writeFileSync(candidateInitializer, readFileSync(initialize))
    const untrusted = shell(['-File', candidateInitializer, '-Config', config, '-Release', old, '-RuntimeRoot', runtime])
    assert.notEqual(untrusted.status, 0)
    assert.match(untrusted.stderr, /Trusted control directory must be outside the release/)
    const otherReleaseControl = shell(['-File', candidateInitializer, '-Config', config, '-Release', next, '-RuntimeRoot', runtime])
    assert.notEqual(otherReleaseControl.status, 0)
    assert.match(otherReleaseControl.stderr, /Trusted control directory must be outside the release/)
    assert.equal(existsSync(current), false)
    assert.equal(existsSync(calls), false)
    writeFileSync(candidateInitializer, '')
    const oldBundle = join(old, 'lib', 'index.js')
    writeFileSync(oldBundle, 'tampered')
    const deniedInitialization = shell(['-File', initialize, '-Config', config, '-Release', old, '-RuntimeRoot', runtime])
    assert.notEqual(deniedInitialization.status, 0)
    assert.equal(existsSync(calls), false)
    assert.equal(existsSync(current), false)
    assert.equal(existsSync(join(root, 'import-old')), false)
    writeFileSync(oldBundle, isolatedImport)
    const runtimeControl = join(runtime, 'control')
    mkdirSync(runtimeControl)
    for (const name of ['activation.json', 'deploy-runtime.json']) {
      const journal = join(runtimeControl, name)
      writeFileSync(journal, '{"phase":"starting"}')
      const blocked = shell(['-File', initialize, '-Config', config, '-Release', old, '-RuntimeRoot', runtime], { PATH: guardedPath })
      assert.notEqual(blocked.status, 0)
      assert.match(blocked.stderr, /already initialized or requires manual inspection/)
      assert.equal(existsSync(join(root, 'import-old')), false)
      assert.equal(existsSync(current), false)
      rmSync(journal)
    }
    const initialized = shell(['-File', initialize, '-Config', config, '-Release', old, '-RuntimeRoot', runtime], { RUNTIME_SECRET_VALUE: 'test-secret', PATH: guardedPath })
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(existsSync(fakeNodeMarker), false)
    assert.equal(existsSync(join(root, 'import-old')), true)
    rmSync(join(root, 'import-old'))
    assert.notEqual(shell(['-File', initialize, '-Config', config, '-Release', old, '-RuntimeRoot', runtime]).status, 0)
    assert.equal(existsSync(join(root, 'import-old')), false)
    const links = shell(['-Command', "New-Item -ItemType Junction -Path $env:BUNDLE -Target $env:CURRENT | Out-Null"], { CURRENT: current, BUNDLE: join(profileModules, 'dsh-superagent') })
    assert.equal(links.status, 0, links.stderr)
    const foreignConfig = join(root, 'foreign-service.json')
    const foreignModules = join(root, 'other-home', 'profiles', 'other-profile', 'node_modules')
    mkdirSync(foreignModules, { recursive: true })
    const foreignLink = shell(['-Command', "New-Item -ItemType Junction -Path $env:BUNDLE -Target $env:CURRENT | Out-Null"], { CURRENT: current, BUNDLE: join(foreignModules, 'dsh-superagent') })
    assert.equal(foreignLink.status, 0, foreignLink.stderr)
    writeFileSync(foreignConfig, JSON.stringify({ checkout: current, home: join(root, 'other-home'), profile: 'other-profile', url: 'http://127.0.0.1:39196', installedOnly: true, node: process.execPath }))
    const rejected = shell(['-File', activate, '-Config', foreignConfig, '-Release', next, '-RuntimeRoot', runtime])
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /bound to a different service/)
    const run = (release, env = {}) => shell(['-File', activate, '-Config', config, '-Release', release, '-RuntimeRoot', runtime], { RUNTIME_SECRET_VALUE: 'test-secret', PATH: guardedPath, ...env })
    rmSync(pathsHelper)
    symlinkSync(outsideHelper, pathsHelper, 'junction')
    const linkedActivation = run(next)
    assert.notEqual(linkedActivation.status, 0)
    assert.match(linkedActivation.stderr, /Trusted control file must be a regular file/)
    rmSync(pathsHelper)
    copyFileSync(fileURLToPath(new URL('../scripts/runtime-paths.ps1', import.meta.url)), pathsHelper)
    assert.equal(existsSync(calls), false)
    writeFileSync(join(old, 'running'), 'running')
    const noHttp = "function Invoke-RestMethod { throw 'network forbidden' }; & $env:TEST_ACTIVATE -Config $env:TEST_CONFIG -Release $env:TEST_RELEASE -RuntimeRoot $env:TEST_RUNTIME"
    const wrongBundle = shell(['-Command', noHttp], { PATH: guardedPath, TEST_ACTIVATE: activate, TEST_CONFIG: config, TEST_RELEASE: next, TEST_RUNTIME: runtime, WRONG_BUNDLE_TARGET: broken })
    assert.notEqual(wrongBundle.status, 0)
    assert.match(wrongBundle.stderr, /Profile bundle link does not match the current release/)
    assert.equal(readFileSync(calls, 'utf8').trim(), 'status')
    assert.equal(existsSync(join(runtime, 'control', 'activation.json')), false)
    rmSync(calls)
    const unverifiedBundle = shell(['-Command', noHttp], { PATH: guardedPath, TEST_ACTIVATE: activate, TEST_CONFIG: config, TEST_RELEASE: next, TEST_RUNTIME: runtime })
    assert.notEqual(unverifiedBundle.status, 0)
    assert.match(unverifiedBundle.stderr, /running service loaded release cannot be established/)
    assert.equal(readFileSync(calls, 'utf8').trim(), 'status')
    assert.equal(existsSync(join(runtime, 'control', 'activation.json')), false)
    assert.equal(realpathSync(current).toLowerCase(), realpathSync(old).toLowerCase())
    rmSync(calls)
    rmSync(join(old, 'running'))
    rmSync(join(root, 'import-next'))
    const activationJournal = join(runtimeControl, 'activation.json')
    for (const journal of [
      { phase: 'completed', release: broken, commit: 'a'.repeat(40) },
      { phase: 'completed', release: old, commit: 'invalid' },
      { phase: 'completed', release: old },
    ]) {
      writeFileSync(activationJournal, JSON.stringify(journal))
      const mismatched = run(next)
      assert.notEqual(mismatched.status, 0)
      assert.match(mismatched.stderr, /earlier activation needs manual inspection/)
      assert.equal(existsSync(calls), false)
      assert.equal(existsSync(join(root, 'import-next')), false)
      assert.equal(realpathSync(current).toLowerCase(), realpathSync(old).toLowerCase())
    }
    rmSync(activationJournal)
    writeFileSync(join(next, 'lib', 'index.js'), 'tampered')
    const tampered = run(next)
    assert.notEqual(tampered.status, 0)
    assert.match(tampered.stderr, /Release file changed/)
    assert.equal(existsSync(join(runtime, 'control', 'activation.json')), false)
    writeFileSync(join(next, 'lib', 'index.js'), isolatedImport)
    const recordPath = join(next, 'runtime-prepared.json')
    const originalRecord = readFileSync(recordPath, 'utf8')
    const record = JSON.parse(originalRecord)
    writeFileSync(join(next, 'lib', 'index.js'), "import 'missing-superagent-test-dependency'\n")
    record.files['lib/index.js'] = createHash('sha256').update(readFileSync(join(next, 'lib', 'index.js'))).digest('hex')
    writeFileSync(recordPath, JSON.stringify(record))
    const missingDependency = run(next)
    assert.notEqual(missingDependency.status, 0)
    assert.equal(existsSync(join(runtime, 'control', 'activation.json')), false)
    writeFileSync(join(next, 'lib', 'index.js'), isolatedImport)
    record.files['lib/index.js'] = createHash('sha256').update(isolatedImport).digest('hex')
    writeFileSync(recordPath, JSON.stringify(record))
    const rewritingImport = `import { readFileSync, writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; const content = 'changed'; writeFileSync('cordis.patch.yml', content); const record = JSON.parse(readFileSync('runtime-prepared.json', 'utf8')); record.files['cordis.patch.yml'] = createHash('sha256').update(content).digest('hex'); writeFileSync('runtime-prepared.json', JSON.stringify(record))\n`
    writeFileSync(join(next, 'lib', 'index.js'), rewritingImport)
    record.files['lib/index.js'] = createHash('sha256').update(rewritingImport).digest('hex')
    writeFileSync(recordPath, JSON.stringify(record))
    const rewritten = run(next)
    assert.notEqual(rewritten.status, 0)
    assert.match(rewritten.stderr, /Release preparation record changed during import/)
    assert.equal(existsSync(calls), false)
    assert.equal(realpathSync(current).toLowerCase(), realpathSync(old).toLowerCase())
    writeFileSync(join(next, 'cordis.patch.yml'), '')
    writeFileSync(join(next, 'lib', 'index.js'), isolatedImport)
    writeFileSync(recordPath, originalRecord)
    const deployJournal = join(runtime, 'control', 'deploy-runtime.json')
    for (const content of [
      ...['fetching', 'building', 'preparing', 'activation-started', 'unknown', 'Completed'].map(phase => JSON.stringify({ phase })),
      '{broken', 'null', '[]', '{}', JSON.stringify({ phase: ['completed'] }),
    ]) {
      writeFileSync(deployJournal, content)
      const blocked = run(next)
      assert.notEqual(blocked.status, 0, content)
      assert.match(blocked.stderr, /Deployment journal/)
      assert.equal(existsSync(calls), false, content)
      assert.equal(existsSync(join(runtime, 'control', 'activation.json')), false, content)
      assert.equal(realpathSync(current).toLowerCase(), realpathSync(old).toLowerCase(), content)
    }
    for (const [phase, release] of [['failed-before-activation', next], ['completed', old]]) {
      writeFileSync(deployJournal, JSON.stringify({ phase }))
      const admitted = run(release)
      assert.equal(admitted.status, 0, `${phase}: ${admitted.stderr}`)
      assert.equal(JSON.parse(admitted.stdout.trim().split(/\r?\n/).at(-1)).phase, 'completed')
      assert.equal(realpathSync(current).toLowerCase(), realpathSync(release).toLowerCase())
      rmSync(join(release, 'running'))
    }
    rmSync(deployJournal)
    const originalConfig = readFileSync(config, 'utf8')
    chmodSync(config, 0o444)
    try {
      const readOnly = run(old)
      assert.equal(readOnly.status, 0, readOnly.stderr)
    } finally {
      chmodSync(config, 0o666)
    }
    rmSync(join(old, 'running'))
    const result = run(next, { ATTACK_CONFIG: '1' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(attacks, 'utf8').trim().split(/\r?\n/), [
      'status blocked blocked', 'status blocked blocked', 'start blocked blocked', 'status blocked blocked', 'verify blocked blocked',
    ])
    assert.equal(readFileSync(config, 'utf8'), originalConfig)
    writeFileSync(config, originalConfig)
    assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).phase, 'completed')
    assert.equal(JSON.parse(readFileSync(join(runtime, 'control', 'activation.json'))).release, next)
    rmSync(join(next, 'running'))
    rmSync(attacks)
    const failure = run(broken, { ATTACK_CONFIG: '1' })
    assert.notEqual(failure.status, 0)
    assert.match(failure.stderr, /Release start failed/)
    assert.deepEqual(readFileSync(attacks, 'utf8').trim().split(/\r?\n/), [
      'status blocked blocked', 'status blocked blocked', 'start blocked blocked',
    ])
    assert.equal(readFileSync(config, 'utf8'), originalConfig)
    writeFileSync(config, originalConfig)
    assert.equal(JSON.parse(readFileSync(join(runtime, 'control', 'activation.json'))).phase, 'starting')
    rmSync(join(root, 'import-next'))
    const repeated = run(next)
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stderr, /earlier activation needs manual inspection/)
    assert.equal(existsSync(join(root, 'import-next')), false)
    assert.equal(existsSync(fakeNodeMarker), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
