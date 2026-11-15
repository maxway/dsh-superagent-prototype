import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const wrapper = fileURLToPath(new URL('../scripts/dsh-superagent.ps1', import.meta.url))
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE'])
const baseEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase()))), LUMOS_API_KEY: 'test-only' }

test('lifecycle actions reject a missing selected or default configuration', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-missing-config-'))
  try {
    const env = { ...baseEnv, HOME: root, USERPROFILE: root }
    for (const action of ['start', 'stop', 'restart', 'status']) {
      for (const selected of action === 'status' ? [join(root, 'missing.json')] : [undefined, join(root, 'missing.json')]) {
        const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, action], {
          encoding: 'utf8', timeout: 15000, env: { ...env, ...(selected ? { DSH_SUPERAGENT_SERVICE_CONFIG: selected } : {}) },
        })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /service configuration does not exist/)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('control calls do not leave a lock bypass marker in their shell', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-lock-marker-'))
  try {
    const checkout = join(root, 'release'), home = join(root, 'home'), config = join(root, 'service.json')
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(checkout, 'scripts', 'dsh-superagent'), 'process.exit(0)')
    writeFileSync(config, JSON.stringify({ checkout, home, profile: 'test-installed', url: 'http://127.0.0.1:39193', node: process.execPath, installedOnly: true }))
    const complete = join(root, 'complete')
    const command = `$ErrorActionPreference = 'Stop'; foreach ($action in @('status', 'start')) { & $env:TEST_WRAPPER $action -Config $env:TEST_CONFIG; if (Test-Path Env:DSH_SUPERAGENT_LIFECYCLE_LOCKED) { throw 'Lock marker leaked' } }; Set-Content -LiteralPath $env:TEST_COMPLETE -Value 'done'`
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000, env: { ...baseEnv, HOME: root, USERPROFILE: root, TEST_WRAPPER: wrapper, TEST_CONFIG: config, TEST_COMPLETE: complete } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(complete), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup clears inherited deployment settings unless configured', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-installed-env-'))
  try {
    const checkout = join(root, 'release')
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'home'))
    const output = join(root, 'environment.json')
    writeFileSync(join(checkout, 'scripts', 'dsh-superagent'), `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({request: process.env.DSH_SUPERAGENT_DEPLOY_REQUEST, command: process.env.DSH_SUPERAGENT_DEPLOY_COMMAND}))`)
    const config = join(root, 'service.json')
    const settings = { checkout, home: join(root, 'home'), profile: 'test-installed', url: 'http://127.0.0.1:39193', node: process.execPath }
    const invoke = () => spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, 'start', '-Config', config], { encoding: 'utf8', timeout: 15000, env: { ...baseEnv, HOME: root, USERPROFILE: root, DSH_SUPERAGENT_DEPLOY_REQUEST: 'old-request', DSH_SUPERAGENT_DEPLOY_COMMAND: 'old-command' } })
    writeFileSync(config, JSON.stringify(settings))
    let result = invoke()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { request: '', command: '' })
    writeFileSync(config, JSON.stringify({ ...settings, deployRequest: 'new-request', deployCommand: 'new-command' }))
    result = invoke()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { request: 'new-request', command: 'new-command' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installed-only controls exclude the same home through an alias', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-installed-alias-'))
  const checkout = join(root, 'release'), home = join(root, 'home'), alias = join(root, 'alias')
  const ready = join(root, 'ready'), proceed = join(root, 'proceed')
  let child
  try {
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    mkdirSync(home)
    symlinkSync(home, alias, 'junction')
    writeFileSync(join(checkout, 'scripts', 'dsh-superagent'), `const fs = require('node:fs'); fs.writeFileSync(process.env.TEST_READY, 'ready'); const timer = setInterval(() => { if (fs.existsSync(process.env.TEST_PROCEED)) { clearInterval(timer) } }, 30)`)
    const settings = { checkout, profile: 'test-installed', url: 'http://127.0.0.1:39193', node: process.execPath, installedOnly: true }
    const firstConfig = join(root, 'first.json'), secondConfig = join(root, 'second.json')
    writeFileSync(firstConfig, JSON.stringify({ ...settings, home }))
    writeFileSync(secondConfig, JSON.stringify({ ...settings, home: alias }))
    const env = { ...baseEnv, HOME: root, USERPROFILE: root, TEST_READY: ready, TEST_PROCEED: proceed }
    child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, 'start', '-Config', firstConfig], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const exited = new Promise(resolve => child.once('close', resolve))
    const deadline = Date.now() + 20000
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(existsSync(ready), true, stderr)
    const second = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, 'start', '-Config', secondConfig], { encoding: 'utf8', timeout: 15000, env })
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /Another deployment or recovery is already in progress/)
    writeFileSync(proceed, 'go')
    assert.equal(await exited, 0, stderr)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('close', resolve))
      writeFileSync(proceed, 'go')
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('installed-only startup does not update the release', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-installed-'))
  try {
    const checkout = join(root, 'release')
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    mkdirSync(join(root, 'home'))
    const calls = join(root, 'calls.json')
    writeFileSync(join(checkout, 'scripts', 'dsh-superagent'), `require('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)))`)
    const config = join(root, 'service.json')
    writeFileSync(config, JSON.stringify({ checkout, home: join(root, 'home'), profile: 'test-installed', url: 'http://127.0.0.1:39193', node: process.execPath }))
    for (const action of ['start', 'restart']) {
      const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, action, '-Config', config], { encoding: 'utf8', timeout: 15000, env: { ...baseEnv, HOME: root, USERPROFILE: root } })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')).slice(0, 1), [action])
      assert.ok(JSON.parse(readFileSync(calls, 'utf8')).includes('--use-installed'))
    }
    writeFileSync(config, JSON.stringify({ checkout, home: join(root, 'home'), profile: 'test-installed', url: 'http://127.0.0.1:39193', installedOnly: true, node: 'node' }))
    const relativeNode = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, 'start', '-Config', config], { encoding: 'utf8', timeout: 15000, env: { ...baseEnv, HOME: root, USERPROFILE: root } })
    assert.notEqual(relativeNode.status, 0)
    assert.match(relativeNode.stderr, /absolute Node executable/)
    writeFileSync(config, JSON.stringify({ checkout, node: process.execPath, installedOnly: 'false' }))
    const invalid = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, 'start', '-Config', config], { encoding: 'utf8', timeout: 15000, env: { ...baseEnv, HOME: root, USERPROFILE: root } })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /installedOnly must be a boolean/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
