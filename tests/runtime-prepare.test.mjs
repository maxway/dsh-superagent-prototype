import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const shell = (args, env = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-shell-'))
  try {
    const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'].includes(name.toUpperCase())))
    return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', timeout: 120000, cwd: home, env: { ...base, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, ...env } })
  } finally { rmSync(home, { recursive: true, force: true }) }
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')

test('prepares an isolated release without changing current', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-prepare-'))
  try {
    const independentControl = join(root, 'control')
    mkdirSync(independentControl)
    for (const name of ['prepare-runtime.ps1', 'initialize-runtime.ps1', 'superagent-lifecycle-lock.ps1', 'runtime-paths.ps1', 'runtime-verify.ps1']) {
      copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(independentControl, name))
    }
    const prepare = join(independentControl, 'prepare-runtime.ps1')
    const initialize = join(independentControl, 'initialize-runtime.ps1')
    const source = join(root, 'source')
    mkdirSync(join(source, 'lib'), { recursive: true })
    mkdirSync(join(source, 'scripts'))
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-superagent', type: 'module', packageManager: 'pnpm@0.0.0' }))
    writeFileSync(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
    for (const file of ['index', 'github-watch', 'gitlab-watch', 'feishu-watch']) writeFileSync(join(source, 'lib', `${file}.js`), 'export const loaded = true\n')
    const controls = ['dsh-superagent', 'dsh-superagent.ps1', 'service-start.ps1', 'superagent-lifecycle-lock.ps1', 'launch-hidden.vbs', 'prepare-runtime.ps1', 'initialize-runtime.ps1', 'activate-runtime.ps1', 'runtime-activation-core.ps1', 'runtime-paths.ps1', 'runtime-verify.ps1']
    for (const file of controls) writeFileSync(join(source, 'scripts', file), '')
    const files = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', ...['index', 'github-watch', 'gitlab-watch', 'feishu-watch'].map(file => `lib/${file}.js`), ...controls.map(file => `scripts/${file}`)]
    writeFileSync(join(source, 'runtime-build.json'), JSON.stringify({ format: 1, commit: 'a'.repeat(40), files: Object.fromEntries(files.map(file => [file, digest(join(source, file))])) }))
    const archive = join(root, 'bundle.zip')
    const zipped = shell(['-Command', "Compress-Archive -Path (Join-Path $env:ZIP_SOURCE '*') -DestinationPath $env:ZIP_DEST"], { ZIP_SOURCE: source, ZIP_DEST: archive })
    assert.equal(zipped.status, 0, zipped.stderr)
    const pnpm = join(root, 'pnpm.cmd')
    writeFileSync(pnpm, '@echo off\r\nif "%1"=="--version" (echo 0.0.0 & exit /b 0)\r\nexit /b 0\r\n')
    const runtime = join(root, 'runtime')
    const args = ['-File', prepare, '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm]
    const mismatch = shell(['-File', prepare, '-Archive', archive, '-Sha256', '0'.repeat(64), '-RuntimeRoot', runtime])
    assert.notEqual(mismatch.status, 0)
    assert.equal(existsSync(runtime), false)
    for (const target of ['releases', 'cache', 'cache/pnpm']) {
      const junctionRuntime = join(root, `junction-${target.replace('/', '-')}`)
      const outside = join(root, `outside-${target.replace('/', '-')}`)
      mkdirSync(join(junctionRuntime, target, '..'), { recursive: true })
      mkdirSync(outside)
      symlinkSync(outside, join(junctionRuntime, target), 'junction')
      const rejected = shell(['-File', prepare, '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', junctionRuntime, '-Node', process.execPath, '-Pnpm', pnpm])
      assert.notEqual(rejected.status, 0, `accepted ${target} junction`)
      assert.match(rejected.stderr, /Reparse points are not supported/)
      assert.deepEqual(readdirSync(outside), [], `wrote outside via ${target}`)
      if (target !== 'releases') assert.equal(existsSync(join(junctionRuntime, 'releases')), false)
    }
    const ancestorOutside = join(root, 'ancestor-outside')
    mkdirSync(ancestorOutside)
    const ancestorLink = join(root, 'ancestor-link')
    symlinkSync(ancestorOutside, ancestorLink, 'junction')
    const ancestorRejected = shell(['-File', prepare, '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', join(ancestorLink, 'new-runtime'), '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(ancestorRejected.status, 0)
    assert.deepEqual(readdirSync(ancestorOutside), [])
    const fileRuntime = join(root, 'file-runtime')
    mkdirSync(fileRuntime)
    writeFileSync(join(fileRuntime, 'cache'), 'not a directory')
    const fileRejected = shell(['-File', prepare, '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', fileRuntime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(fileRejected.status, 0)
    assert.equal(existsSync(join(fileRuntime, 'releases')), false)
    const relativeRejected = shell(['-File', prepare, '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', 'relative-runtime', '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(relativeRejected.status, 0)
    const untrustedControls = join(root, 'untrusted-controls')
    mkdirSync(untrustedControls)
    copyFileSync(prepare, join(untrustedControls, 'prepare-runtime.ps1'))
    copyFileSync(fileURLToPath(new URL('../scripts/runtime-paths.ps1', import.meta.url)), join(untrustedControls, 'runtime-paths.ps1'))
    symlinkSync(root, join(untrustedControls, 'runtime-verify.ps1'), 'junction')
    const untrustedRuntime = join(root, 'untrusted-runtime')
    const untrusted = shell(['-File', join(untrustedControls, 'prepare-runtime.ps1'), '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', untrustedRuntime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(untrusted.status, 0)
    assert.equal(existsSync(untrustedRuntime), false)
    const trustedControls = join(root, 'trusted-controls')
    mkdirSync(trustedControls)
    for (const name of ['prepare-runtime.ps1', 'runtime-paths.ps1', 'runtime-verify.ps1']) {
      copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(trustedControls, name))
    }
    const nestedRuntime = join(trustedControls, 'nested-runtime')
    const nested = shell(['-File', join(trustedControls, 'prepare-runtime.ps1'), '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', nestedRuntime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(nested.status, 0)
    assert.match(nested.stderr, /control directory.*outside the runtime|control directory and runtime must be independent/i)
    assert.equal(existsSync(nestedRuntime), false)
    const result = shell(args)
    assert.equal(result.status, 0, result.stderr)
    const record = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(record.prepared, true)
    assert.equal(record.archiveSha256, digest(archive))
    assert.equal(existsSync(join(record.release, 'runtime-prepared.json')), true)
    assert.equal(existsSync(join(runtime, 'current')), false)
    const defaultNode = shell(['-File', prepare, '-Archive', archive, '-Sha256', digest(archive), '-RuntimeRoot', join(root, 'default-node-runtime')], { PATH: `${root};${dirname(process.execPath)};${process.env.PATH}` })
    assert.equal(defaultNode.status, 0, defaultNode.stderr)
    const prepared = JSON.parse(readFileSync(join(record.release, 'runtime-prepared.json'), 'utf8'))
    assert.equal(prepared.files['runtime-build.json'], digest(join(record.release, 'runtime-build.json')))
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-superagent', type: 'module', packageManager: 'pnpm@0.0.0', dependencies: { fixture: '1.0.0' } }))
    writeFileSync(join(source, 'lib', 'index.js'), "import 'fixture'\n")
    const updateManifest = () => writeFileSync(join(source, 'runtime-build.json'), JSON.stringify({ format: 1, commit: 'a'.repeat(40), files: Object.fromEntries(files.map(file => [file, digest(join(source, file))])) }))
    updateManifest()
    const missingArchive = join(root, 'missing-dependency.zip')
    assert.equal(shell(['-Command', "Compress-Archive -Path (Join-Path $env:ZIP_SOURCE '*') -DestinationPath $env:ZIP_DEST"], { ZIP_SOURCE: source, ZIP_DEST: missingArchive }).status, 0)
    const missing = shell(['-File', prepare, '-Archive', missingArchive, '-Sha256', digest(missingArchive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /Release dependency import failed/)
    const importMarker = join(root, 'unlisted-import-called')
    writeFileSync(pnpm, '@echo off\r\nif "%1"=="--version" (echo 0.0.0 & exit /b 0)\r\nmkdir node_modules\r\necho original>node_modules\\fixture.js\r\nmkdir lib\\node_modules\\fixture\r\necho unexpected>lib\\node_modules\\fixture\\index.js\r\nexit /b 0\r\n')
    writeFileSync(join(source, 'lib', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(importMarker)}, 'called')\n`)
    updateManifest()
    const unlistedArchive = join(root, 'unlisted-dependency.zip')
    assert.equal(shell(['-Command', "Compress-Archive -Path (Join-Path $env:ZIP_SOURCE '*') -DestinationPath $env:ZIP_DEST"], { ZIP_SOURCE: source, ZIP_DEST: unlistedArchive }).status, 0)
    const unlisted = shell(['-File', prepare, '-Archive', unlistedArchive, '-Sha256', digest(unlistedArchive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(unlisted.status, 0)
    assert.match(unlisted.stderr, /Unlisted release file/)
    assert.equal(existsSync(importMarker), false)
    writeFileSync(pnpm, '@echo off\r\nif "%1"=="--version" (echo 0.0.0 & exit /b 0)\r\nmkdir node_modules\r\necho original>node_modules\\fixture.js\r\necho tampered>lib\\index.js\r\nexit /b 0\r\n')
    const changed = shell(['-File', prepare, '-Archive', unlistedArchive, '-Sha256', digest(unlistedArchive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(changed.status, 0)
    assert.match(changed.stderr, /Runtime file changed during preparation/)
    assert.equal(existsSync(importMarker), false)
    for (const [name, expected] of [
      ['runtime-prepared.json', /Unexpected preparation record/],
      ['runtime-build.json', /Runtime build manifest changed/],
    ]) {
      writeFileSync(pnpm, `@echo off\r\nif "%1"=="--version" (echo 0.0.0 & exit /b 0)\r\nmkdir node_modules\r\necho original>node_modules\\fixture.js\r\necho tampered>${name}\r\nexit /b 0\r\n`)
      const metadata = shell(['-File', prepare, '-Archive', unlistedArchive, '-Sha256', digest(unlistedArchive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm])
      assert.notEqual(metadata.status, 0, name)
      assert.match(metadata.stderr, expected, name)
      assert.equal(existsSync(importMarker), false, name)
    }
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-superagent', type: 'module', packageManager: 'pnpm@0.0.0' }))
    writeFileSync(join(source, 'lib', 'index.js'), 'export const loaded = true\n')
    writeFileSync(pnpm, '@echo off\r\nif "%1"=="--version" (echo 0.0.0 & exit /b 0)\r\nexit /b 0\r\n')
    writeFileSync(join(source, 'lib', 'index.js'), 'await new Promise(() => setInterval(() => {}, 1000))\n')
    updateManifest()
    const hangingArchive = join(root, 'hanging-import.zip')
    assert.equal(shell(['-Command', "Compress-Archive -Path (Join-Path $env:ZIP_SOURCE '*') -DestinationPath $env:ZIP_DEST"], { ZIP_SOURCE: source, ZIP_DEST: hangingArchive }).status, 0)
    const hanging = shell(['-File', prepare, '-Archive', hangingArchive, '-Sha256', digest(hangingArchive), '-RuntimeRoot', join(root, 'hanging-runtime'), '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(hanging.status, 0)
    assert.match(hanging.stderr, /Release dependency import timed out/)
    writeFileSync(join(source, 'lib', 'index.js'), 'export const loaded = true\n')
    updateManifest()
    const unsafeNames = [
      'folder/file ', 'folder/file.', 'folder /file', 'folder./file', 'folder./',
      ...['CON', 'NUL', 'AUX', 'PRN', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)].map(name => `extra/${name}.txt`),
      'extra/con', 'extra/nUl.data', 'extra/COM¹.log', 'extra/LPT²/', 'extra/CON .txt',
      'extra/a\u0001b', 'extra/a\u007fb', 'extra/a\u0085b', 'extra/a?b', 'extra/a*b', 'extra/a<b', 'extra/a>b', 'extra/a|b', 'extra/a"b', 'extra//file', 'node_modules/evil/index.js', 'lib/NoDe_MoDuLeS/evil/index.js', 'runtime-prepared.json'
    ]
    const validDirectories = ['ordinary/valid-name/', 'ordinary/COM10/', 'ordinary/CONSOLE/']
    const names = [...unsafeNames, ...validDirectories]
    const createArchives = shell(['-Command', `
      Add-Type -AssemblyName System.IO.Compression
      $names = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZIP_NAMES)) | ConvertFrom-Json
      for ($index = 0; $index -lt $names.Count; $index++) {
        $target = Join-Path $env:ZIP_ROOT ("entry-{0}.zip" -f $index)
        Copy-Item -LiteralPath $env:ZIP_ORIGINAL -Destination $target
        $zip = [IO.Compression.ZipFile]::Open($target, [IO.Compression.ZipArchiveMode]::Update)
        try { [void]$zip.CreateEntry([string]$names[$index]) } finally { $zip.Dispose() }
      }
    `], { ZIP_NAMES: Buffer.from(JSON.stringify(names)).toString('base64'), ZIP_ROOT: root, ZIP_ORIGINAL: archive })
    assert.equal(createArchives.status, 0, createArchives.stderr)
    for (const [index, name] of unsafeNames.entries()) {
      const unsafeArchive = join(root, `entry-${index}.zip`)
      const unsafeRuntime = join(root, `unsafe-runtime-${index}`)
      const rejected = shell(['-File', prepare, '-Archive', unsafeArchive, '-Sha256', digest(unsafeArchive), '-RuntimeRoot', unsafeRuntime, '-Node', process.execPath, '-Pnpm', pnpm])
      assert.notEqual(rejected.status, 0, `accepted ${JSON.stringify(name)}`)
      assert.match(rejected.stderr, /Unsafe archive entry/, JSON.stringify(name))
      assert.equal(existsSync(unsafeRuntime), false, `created runtime for ${JSON.stringify(name)}`)
    }
    for (const [index, name] of validDirectories.entries()) {
      const directoryArchive = join(root, `entry-${unsafeNames.length + index}.zip`)
      const directoryResult = shell(['-File', prepare, '-Archive', directoryArchive, '-Sha256', digest(directoryArchive), '-RuntimeRoot', join(root, `directory-runtime-${index}`), '-Node', process.execPath, '-Pnpm', pnpm])
      assert.equal(directoryResult.status, 0, `${name}: ${directoryResult.stderr}`)
    }
    rmSync(join(source, 'scripts', 'activate-runtime.ps1'))
    const incompleteArchive = join(root, 'incomplete.zip')
    assert.equal(shell(['-Command', "Compress-Archive -Path (Join-Path $env:ZIP_SOURCE '*') -DestinationPath $env:ZIP_DEST"], { ZIP_SOURCE: source, ZIP_DEST: incompleteArchive }).status, 0)
    const incomplete = shell(['-File', prepare, '-Archive', incompleteArchive, '-Sha256', digest(incompleteArchive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(incomplete.status, 0)
    assert.match(incomplete.stderr, /Archive missing required file: scripts\/activate-runtime\.ps1/)
    writeFileSync(join(source, 'scripts', 'activate-runtime.ps1'), '')
    writeFileSync(join(source, 'lib', 'index.js'), 'tampered')
    const tamperedArchive = join(root, 'tampered.zip')
    assert.equal(shell(['-Command', "Compress-Archive -Path (Join-Path $env:ZIP_SOURCE '*') -DestinationPath $env:ZIP_DEST"], { ZIP_SOURCE: source, ZIP_DEST: tamperedArchive }).status, 0)
    const tampered = shell(['-File', prepare, '-Archive', tamperedArchive, '-Sha256', digest(tamperedArchive), '-RuntimeRoot', runtime, '-Node', process.execPath, '-Pnpm', pnpm])
    assert.notEqual(tampered.status, 0)
    assert.match(tampered.stderr, /Runtime file hash mismatch/)
    assert.equal(existsSync(join(runtime, 'current')), false)
    writeFileSync(pnpm, '@echo off\r\nif "%1"=="--version" (echo 0.0.0 & exit /b 0)\r\nexit /b 7\r\n')
    const failed = shell(args)
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /Dependency installation failed/)
    assert.equal(existsSync(join(runtime, 'current')), false)
    const serviceConfig = join(root, 'service.json')
    writeFileSync(serviceConfig, JSON.stringify({ checkout: join(runtime, 'current'), home: join(runtime, 'dsh-home'), profile: 'candidate', url: 'http://127.0.0.1:39199', node: process.execPath, installedOnly: true }))
    const initialized = shell(['-File', initialize, '-Config', serviceConfig, '-Release', record.release, '-RuntimeRoot', runtime])
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(existsSync(join(runtime, 'current')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
