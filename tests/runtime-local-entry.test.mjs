import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../scripts/deploy-runtime-local.ps1', import.meta.url))
const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'])
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-local-entry-'))
  const local = join(root, 'deploy-runtime-local.ps1')
  const config = join(root, 'deploy-runtime.local.json')
  const marker = join(root, 'called.json')
  copyFileSync(entry, local)
  writeFileSync(join(root, 'deploy-runtime.ps1'), `param($SourceRepo, $Remote, $Ref, $RuntimeRoot, $Config, $Node, $Git, $Pnpm)
@{ SourceRepo = $SourceRepo; Remote = $Remote; Ref = $Ref; RuntimeRoot = $RuntimeRoot; Config = $Config; Node = $Node; Git = $Git; Pnpm = $Pnpm } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:TEST_MARKER
if ($env:TEST_FAIL) { exit 23 }
`)
  const settings = { SourceRepo: join(root, 'source.git'), Remote: 'origin', Ref: 'refs/heads/main', RuntimeRoot: join(root, 'runtime'), Config: join(root, 'service.json'), Node: process.execPath, Git: join(root, 'git.exe'), Pnpm: join(root, 'pnpm.cmd') }
  const invoke = extra => spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', local], { env: { ...env, TEST_MARKER: marker, ...extra }, encoding: 'utf8', timeout: 15000 })
  return { root, config, marker, settings, invoke }
}

test('fixed local entry passes its configuration and propagates coordinator failures', () => {
  const instance = fixture()
  try {
    writeFileSync(instance.config, JSON.stringify(instance.settings))
    const success = instance.invoke()
    assert.equal(success.status, 0, success.stderr)
    assert.deepEqual(JSON.parse(readFileSync(instance.marker, 'utf8')), instance.settings)
    const failure = instance.invoke({ TEST_FAIL: '1' })
    assert.equal(failure.status, 23, failure.stderr)
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})

test('fixed local entry rejects missing, unknown and relative configuration before invoking the coordinator', () => {
  const instance = fixture()
  try {
    for (const settings of [null, {}, { ...instance.settings, Extra: 'unexpected' }, { ...instance.settings, Node: 'node' }, { ...instance.settings, Ref: '' }]) {
      writeFileSync(instance.config, JSON.stringify(settings))
      const result = instance.invoke()
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(instance.marker), false)
    }
  } finally { rmSync(instance.root, { recursive: true, force: true }) }
})
