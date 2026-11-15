import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verify = fileURLToPath(new URL('../scripts/runtime-verify.ps1', import.meta.url))
const paths = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'runtime-build.json', 'lib/index.js', 'scripts/dsh-superagent', 'scripts/dsh-superagent.ps1', 'scripts/service-start.ps1', 'scripts/superagent-lifecycle-lock.ps1', 'scripts/launch-hidden.vbs', 'scripts/prepare-runtime.ps1', 'scripts/initialize-runtime.ps1', 'scripts/activate-runtime.ps1', 'scripts/runtime-activation-core.ps1', 'scripts/runtime-paths.ps1', 'scripts/runtime-verify.ps1', 'lib/nested/extra.js']
const run = (release, temporaryHome) => {
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: temporaryHome, USERPROFILE: temporaryHome, TEMP: temporaryHome, TMP: temporaryHome, TMPDIR: temporaryHome, VERIFY_SCRIPT: verify, VERIFY_RELEASE: release })
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '. $env:VERIFY_SCRIPT; $ErrorActionPreference = "Stop"; Test-PreparedRelease $env:VERIFY_RELEASE | Out-Null'], { encoding: 'utf8', timeout: 30000, env, cwd: temporaryHome })
}

function createRelease(release) {
  const files = {}
  for (const path of paths) {
    const content = path === 'package.json' ? '{}' : path === 'runtime-build.json' ? JSON.stringify({ format: 1, commit: 'a'.repeat(40) }) : `content of ${path}\n`
    const target = join(release, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    files[path] = createHash('sha256').update(content).digest('hex')
  }
  writeFileSync(join(release, 'runtime-prepared.json'), JSON.stringify({ commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), files }))
}

test('accepts a complete release and rejects modified files', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-verify-'))
  try {
    const release = join(root, 'release')
    createRelease(release)
    const valid = run(release, root)
    assert.equal(valid.status, 0, valid.stderr)
    const manifest = join(release, 'runtime-build.json')
    const originalManifest = readFileSync(manifest)
    writeFileSync(manifest, 'modified')
    const changedManifest = run(release, root)
    assert.notEqual(changedManifest.status, 0)
    assert.match(changedManifest.stderr, /Release file changed: runtime-build\.json/)
    writeFileSync(manifest, originalManifest)
    writeFileSync(join(release, 'lib', 'index.js'), 'modified')
    const invalid = run(release, root)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Release file changed: lib\/index\.js/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects dependency directories in release ancestors', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-verify-external-'))
  try {
    const release = join(root, 'releases', 'candidate')
    createRelease(release)
    const external = join(root, 'releases', 'node_modules', 'unexpected')
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'index.js'), 'unexpected')
    const result = run(release, root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /External node_modules directory is not allowed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects unlisted nested dependency files', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-verify-unlisted-'))
  try {
    const release = join(root, 'release')
    createRelease(release)
    const nested = join(release, 'lib', 'node_modules', 'unexpected')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'index.js'), 'unexpected')
    const result = run(release, root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unlisted release file: lib\/node_modules\/unexpected\/index\.js/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects release root and internal junctions and invalid directories', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-verify-junction-'))
  try {
    const release = join(root, 'release')
    const external = join(root, 'external')
    createRelease(release)
    const rootLink = join(root, 'release-link')
    symlinkSync(release, rootLink, 'junction')
    const rootResult = run(rootLink, root)
    assert.notEqual(rootResult.status, 0)
    assert.match(rootResult.stderr, /Unsafe release directory/)
    const rootWithSeparator = run(`${rootLink}\\`, root)
    assert.notEqual(rootWithSeparator.status, 0)
    assert.match(rootWithSeparator.stderr, /Unsafe release directory/)
    assert.notEqual(run(join(root, 'missing'), root).status, 0)
    const fileRoot = join(root, 'file-root')
    writeFileSync(fileRoot, 'not a directory')
    assert.notEqual(run(fileRoot, root).status, 0)

    renameSync(join(release, 'lib', 'nested'), external)
    symlinkSync(external, join(release, 'lib', 'nested'), 'junction')
    const junction = run(release, root)
    assert.notEqual(junction.status, 0)
    assert.match(junction.stderr, /Unsafe release directory/)
    rmSync(join(release, 'lib', 'nested'))
    const missing = run(release, root)
    assert.notEqual(missing.status, 0)
    writeFileSync(join(release, 'lib', 'nested'), 'not a directory')
    const notDirectory = run(release, root)
    assert.notEqual(notDirectory.status, 0)
    assert.match(notDirectory.stderr, /Unsafe release directory/)
    rmSync(join(release, 'lib', 'nested'))
    renameSync(external, join(release, 'lib', 'nested'))
    const restored = run(release, root)
    assert.equal(restored.status, 0, restored.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
