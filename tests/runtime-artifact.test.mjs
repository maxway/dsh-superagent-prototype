import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, run } from '../scripts/runtime-artifact.mjs'

const commit = 'a'.repeat(40)
const controls = ['dsh-superagent', 'dsh-superagent.ps1', 'service-start.ps1', 'superagent-lifecycle-lock.ps1', 'launch-hidden.vbs', 'prepare-runtime.ps1', 'initialize-runtime.ps1', 'activate-runtime.ps1', 'deploy-runtime.ps1', 'deploy-runtime-local.ps1', 'runtime-activation-core.ps1', 'runtime-paths.ps1', 'runtime-verify.ps1']

function fixture(t, failAt = '', realZip = false) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = []
  const execute = (command, args, options) => {
    calls.push({ command, args, options })
    if (failAt && (command === failAt || args.includes(failAt))) throw new Error(`failed ${failAt}`)
    if (command === 'git' && args.includes('rev-parse')) return `${commit}\n`
    if (command === 'tar' && args.includes('-xf')) {
      const source = args[args.indexOf('-C') + 1]
      mkdirSync(join(source, 'scripts'))
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'test', version: '1', files: ['lib', 'locale/*.json', 'skills'], packageManager: 'pnpm@11.7.0' }))
      writeFileSync(join(source, 'pnpm-lock.yaml'), 'lock')
      for (const name of controls) writeFileSync(join(source, 'scripts', name), name)
      for (const directory of ['docs', 'examples']) mkdirSync(join(source, directory))
      for (const path of ['docs/runtime-windows.md', 'examples/service.runtime.windows.json', 'examples/deploy-runtime.local.windows.json', 'examples/profile.cordis.patch.yml']) writeFileSync(join(source, path), path)
    }
    if (command.startsWith('pnpm') && args.includes('--version')) return '11.7.0\n'
    if (command.startsWith('npm')) return JSON.stringify([{ filename: 'test.tgz' }])
    if (command === 'tar' && args.includes('-xzf')) {
      const stage = args[args.indexOf('-C') + 1]
      for (const name of ['lib', 'locale', 'skills']) mkdirSync(join(stage, name))
      writeFileSync(join(stage, 'package.json'), '{}')
      writeFileSync(join(stage, 'lib', 'index.js'), 'built')
      writeFileSync(join(stage, 'locale', 'en.json'), '{}')
      writeFileSync(join(stage, 'skills', 'asset.txt'), 'asset')
      if (failAt === 'sensitive') writeFileSync(join(stage, 'skills', '.env'), 'secret')
    }
    if (command === 'pwsh' && realZip) return run(command, args, options)
    if (command === 'pwsh') writeFileSync(options.env.RUNTIME_ZIP, JSON.stringify(JSON.parse(readFileSync(join(options.env.RUNTIME_STAGE, 'runtime-build.json'), 'utf8'))))
    return ''
  }
  return { directory, calls, execute, options: { root: directory, out: directory, commit, execute, id: 'unique' } }
}

test('builds from the exact commit with isolated environment and complete manifest', t => {
  const { options, calls } = fixture(t)
  const result = buildRuntime(options)
  assert.equal(result.manifest.commit, commit)
  for (const path of ['package.json', 'pnpm-lock.yaml', 'lib/index.js', 'locale/en.json', 'skills/asset.txt', 'docs/runtime-windows.md', 'examples/service.runtime.windows.json', 'examples/deploy-runtime.local.windows.json', 'examples/profile.cordis.patch.yml', ...controls.map(name => `scripts/${name}`)]) assert.ok(result.manifest.files[path], path)
  const contents = readFileSync(result.archive)
  assert.equal(readFileSync(result.checksum, 'utf8'), `${createHash('sha256').update(contents).digest('hex')}  dsh-superagent-runtime-${commit.slice(0, 12)}-unique.zip\n`)
  assert.ok(calls.some(call => call.command === 'git' && call.args.includes('archive') && call.args.includes(commit)))
  const install = calls.find(call => call.args.includes('install'))
  assert.ok(install.args.includes('--frozen-lockfile'))
  assert.ok(install.args.includes('--store-dir'))
  assert.notEqual(install.options.env.HOME, process.env.HOME)
  assert.equal(install.options.env.DSH_HOME, undefined)
  assert.ok(calls.find(call => call.command === 'pwsh').options.env.RUNTIME_STAGE)
})

test('does not overwrite an existing archive or checksum', t => {
  const { options } = fixture(t)
  const archive = join(options.out, `dsh-superagent-runtime-${commit.slice(0, 12)}-unique.zip`)
  writeFileSync(archive, 'keep')
  assert.throws(() => buildRuntime(options))
  assert.equal(readFileSync(archive, 'utf8'), 'keep')
  rmSync(archive)
  writeFileSync(`${archive}.sha256`, 'keep checksum')
  assert.throws(() => buildRuntime(options))
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), 'keep checksum')
  assert.throws(() => readFileSync(archive))
})

test('fails closed on command failure or sensitive files', t => {
  for (const failure of ['archive', 'install', 'build', 'pack', 'pwsh', 'sensitive']) {
    const { options } = fixture(t, failure)
    assert.throws(() => buildRuntime(options), failure === 'sensitive' ? /Sensitive/ : /failed/)
  }
})

test('produces a real zip with files directly at its root', { skip: process.platform !== 'win32' }, t => {
  const { options } = fixture(t, '', true)
  const result = buildRuntime(options)
  const entries = run('tar', ['-tf', result.archive], { cwd: options.out, env: process.env }).split(/\r?\n/).filter(Boolean)
  assert.ok(entries.includes('package.json'))
  assert.ok(entries.includes('runtime-build.json'))
  assert.ok(entries.includes('lib/index.js'))
  assert.ok(entries.includes('scripts/dsh-superagent.ps1'))
  assert.ok(!entries.some(entry => entry.startsWith('package/')))
})

test('runs Windows command shims and propagates their exit status', { skip: process.platform !== 'win32' }, t => {
  const { directory } = fixture(t)
  const shim = join(directory, 'fake.cmd')
  writeFileSync(shim, '@echo off\r\necho %1\r\nexit /b 9\r\n')
  assert.throws(() => run(shim, ['argument with spaces'], { cwd: directory, env: process.env }), /failed \(9\)/)
})

test('propagates nonzero process exit status', t => {
  const { directory } = fixture(t)
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(7)'], { cwd: directory, env: process.env }), /failed \(7\)/)
})

test('rejects non-full commit IDs before running commands', t => {
  const { options, calls } = fixture(t)
  assert.throws(() => buildRuntime({ ...options, commit: 'HEAD' }), /full lowercase/)
  assert.equal(calls.length, 0)
})
