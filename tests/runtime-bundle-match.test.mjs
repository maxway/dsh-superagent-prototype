import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const core = fileURLToPath(new URL('../scripts/runtime-activation-core.ps1', import.meta.url))
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase())))
const expected = 'F:\\runtime\\releases\\old'

function check(status) {
  const command = '. $env:TEST_CORE; $ErrorActionPreference = "Stop"; $status = $env:TEST_STATUS | ConvertFrom-Json; Assert-ProfileBundleTarget $status $env:TEST_EXPECTED'
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 15000, env: { ...baseEnv, TEST_CORE: core, TEST_STATUS: JSON.stringify(status), TEST_EXPECTED: expected },
  })
}

test('a running service remains blocked even when the profile link matches', { skip: process.platform !== 'win32' }, () => {
  for (const status of [
    { pids: [123], deployment: { bundleTarget: 'F:\\runtime\\releases\\other' } },
    { pids: [123], deployment: { bundleTarget: 'relative' } },
    { pids: [123], deployment: {} },
    { pids: [123] },
  ]) {
    const result = check(status)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Profile bundle link does not match/)
  }
  for (const target of [expected, expected.toLowerCase()]) {
    const result = check({ pids: [123], deployment: { bundleTarget: target } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /running service loaded release cannot be established/)
  }
  const stopped = check({ pids: [], deployment: {} })
  assert.equal(stopped.status, 0, stopped.stderr)
})
