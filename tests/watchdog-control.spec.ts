/** The mechanical Watchdog lifecycle resolves the remote before building or deploying. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error The mechanical lifecycle scripts are plain .mjs and are not part of the TypeScript build.
import { buildFromRepo, controlConfig, deployArtifact, observerStatus, parseArgv, stopLauncherProcesses, stopObserver } from '../scripts/watchdog-control.mjs'

const root = join(import.meta.dirname, '..')
let directory: string | undefined

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-'))
  const origin = join(directory, 'origin.git')
  const checkout = join(directory, 'checkout')
  const home = join(directory, 'home')
  mkdirSync(origin)
  mkdirSync(checkout)
  git(origin, 'init', '--bare')
  git(checkout, 'init', '-b', 'main')
  git(checkout, 'config', 'user.name', 'Test')
  git(checkout, 'config', 'user.email', 'test@example.invalid')
  for (const path of ['scripts/watchdog', 'scripts/watchdog-agent/gate.mjs', 'scripts/watchdog-agent/run.ps1',
    'scripts/watchdog-agent/prompt.md', 'scripts/watchdog-agent/config.example.json',
    'scripts/watchdog-agent/model.patch.example.yml', 'scripts/watchdog-launch-observer.ps1',
    'scripts/watchdog-launch-observer.vbs', 'scripts/watchdog-bootstrap.mjs', 'scripts/watchdog-control.mjs',
    'scripts/watchdog-deployment.mjs', 'scripts/watchdog-update.mjs', 'scripts/watchdog-artifact.mjs', 'scripts/watchdog-smoke.mjs']) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true })
    copyFileSync(join(root, path), join(checkout, path))
  }
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'initial')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'push', 'origin', 'main')
  return { origin, checkout, home }
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('accepts permission-denied owner probes but rejects a missing owner', async () => {
  // @ts-expect-error The bootstrap is a plain JavaScript module.
  const { ownerAlive } = await import('../scripts/watchdog-bootstrap.mjs')
  const error = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
  expect(ownerAlive(42, error('EPERM'))).toBe(true)
  expect(ownerAlive(42, error('EACCES'))).toBe(true)
  expect(ownerAlive(42, error('ESRCH'))).toBe(false)
  expect(() => ownerAlive(42, error('EIO'))).toThrow('EIO')
})

it.runIf(process.platform === 'win32')('targets only the configured launcher home and reports errors', () => {
  const home = "C:\\test\\watchdog's home"
  let output = ''
  stopLauncherProcesses(home, (command: string, args: string[], options: object) => {
    const mock = `function Get-CimInstance { @([pscustomobject]@{ ProcessId = 111; CommandLine = "C:\\test\\watchdog's home\\launch-observer.ps1" }, [pscustomobject]@{ ProcessId = 222; CommandLine = "C:\\Users\\other\\launch-observer.ps1" }, [pscustomobject]@{ ProcessId = 333; CommandLine = "C:\\test\\watchdog's home-other\\launch-observer.ps1" }) }; function taskkill { Write-Output $args[1]; $global:LASTEXITCODE = 0 }; `
    const result = spawnSync(command, [...args.slice(0, -1), mock + args.at(-1)], options)
    output = String(result.stdout).trim()
    return result
  })
  expect(output).toBe('111')
  expect(() => stopLauncherProcesses(home, () => ({ status: 1, stderr: 'failure' }))).toThrow('failure')
  stopLauncherProcesses(home, (command: string, args: string[], options: object) => {
    const mock = `function Get-CimInstance { [pscustomobject]@{ ProcessId = 99999999; CommandLine = "C:\\test\\watchdog's home\\launch-observer.ps1" } }; function taskkill { $global:LASTEXITCODE = 1 }; `
    return spawnSync(command, [...args.slice(0, -1), mock + args.at(-1)], options)
  })
})

it('parses lifecycle options and creates scheduler commands', () => {
  const options = parseArgv(['deploy', '--build', '--home', 'C:\\watchdog', '--task', 'watchdog-task'])
  expect(options).toMatchObject({ command: 'deploy', home: 'C:\\watchdog', task: 'watchdog-task', build: true, artifact: '' })
  const config = controlConfig(options)
  expect(config.observerStopCommand).toBe('schtasks /end /tn "watchdog-task"')
  expect(config.observerStartCommand).toBe('schtasks /run /tn "watchdog-task"')
  expect(config.heartbeatTimeoutSeconds).toBe(180)
  expect(config.serviceUrl).toBe('http://127.0.0.1:3083')
})

it('reports the PID from the configured observer state directory', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-state-'))
  const home = join(directory, 'home')
  mkdirSync(join(home, 'observer-state'), { recursive: true })
  writeFileSync(join(home, 'observer-state', 'watchdog.pid'), '99999999')
  for (const stateDir of [undefined, 'nested/state', join(directory, 'absolute-state')]) {
    const actual = resolve(home, stateDir ?? '.watchdog')
    mkdirSync(actual, { recursive: true })
    writeFileSync(join(home, 'observer.json'), JSON.stringify({ stateDir, url: 'http://127.0.0.1:1' }))
    writeFileSync(join(actual, 'watchdog.pid'), String(process.pid))
    const status = await observerStatus(parseArgv(['status', '--home', home, '--task', 'watchdog-isolated-test-not-installed', '--url', 'http://[invalid']))
    expect(status).toMatchObject({ pid: process.pid, pidAlive: true })
  }
  writeFileSync(join(home, 'observer.json'), '{')
  await expect(stopObserver(parseArgv(['stop', '--home', home]))).rejects.toThrow('not JSON')
  expect(readFileSync(join(home, 'observer-state', 'watchdog.pid'), 'utf8')).toBe('99999999')
})

it('builds the latest origin/main in a temporary clone', () => {
  const { checkout, home } = fixture()
  const commit = git(checkout, 'rev-parse', 'HEAD')
  const artifact = buildFromRepo(home, checkout)
  expect(JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'))).toMatchObject({ commit, version: commit.slice(0, 7) })
  expect(git(checkout, 'status', '--porcelain')).toBe('')
})

it('builds the newer remote while preserving a stale and dirty checkout', () => {
  const { origin, checkout, home } = fixture()
  const previous = git(checkout, 'rev-parse', 'HEAD')
  const other = join(directory!, 'other')
  git(directory!, 'clone', '-b', 'main', origin, other)
  git(other, 'config', 'user.name', 'Test')
  git(other, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(other, 'new-file'), 'new remote version')
  git(other, 'add', '.')
  git(other, 'commit', '-m', 'advance')
  git(other, 'push', 'origin', 'main')
  const remoteCommit = git(other, 'rev-parse', 'HEAD')
  const modified = join(checkout, 'scripts/watchdog')
  writeFileSync(modified, 'uncommitted change')
  const status = git(checkout, 'status', '--porcelain')
  const artifact = buildFromRepo(home, checkout)
  expect(JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8')).commit).toBe(remoteCommit)
  expect(readFileSync(join(artifact, 'watchdog'), 'utf8')).not.toBe('uncommitted change')
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(previous)
  expect(git(checkout, 'status', '--porcelain')).toBe(status)
  expect(readFileSync(modified, 'utf8')).toBe('uncommitted change')
})

it('fails without a usable origin/main and preserves uncommitted changes', () => {
  const { checkout, home } = fixture()
  const file = join(checkout, 'scripts/watchdog')
  writeFileSync(file, 'uncommitted change')
  git(checkout, 'remote', 'remove', 'origin')
  expect(() => buildFromRepo(home, checkout)).toThrow('remote get-url origin failed')
  expect(readFileSync(file, 'utf8')).toBe('uncommitted change')
  expect(existsSync(home)).toBe(false)
  git(checkout, 'remote', 'add', 'origin', join(directory!, 'missing.git'))
  expect(() => buildFromRepo(home, checkout)).toThrow('clone')
  const emptyOrigin = join(directory!, 'empty.git')
  mkdirSync(emptyOrigin)
  git(emptyOrigin, 'init', '--bare')
  git(checkout, 'remote', 'set-url', 'origin', emptyOrigin)
  expect(() => buildFromRepo(home, checkout)).toThrow('clone')
  expect(readFileSync(file, 'utf8')).toBe('uncommitted change')
  expect(existsSync(home)).toBe(false)
})

it('refuses to stage inside the runtime checkout', () => {
  const { checkout } = fixture()
  expect(() => buildFromRepo(checkout, checkout)).toThrow('staging must be outside the runtime checkout')
  expect(existsSync(join(checkout, 'staging'))).toBe(false)
})

it('uses the latest-build path by default and with --build', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-'))
  const home = join(directory, 'home')
  for (const args of [[], ['--build']]) {
    const options = parseArgv(['deploy', ...args, '--home', home])
    const calls: string[] = []
    await expect(deployArtifact(options, { buildFromRepo: (path: string) => {
      calls.push(path)
      throw new Error('isolated build sentinel')
    } })).rejects.toThrow('isolated build sentinel')
    expect(calls).toEqual([home])
  }
  expect(existsSync(home)).toBe(false)
})

it('routes CLI start through a latest build before touching the observer', () => {
  const { checkout, home } = fixture()
  git(checkout, 'remote', 'remove', 'origin')
  for (const name of ['watchdog-control.mjs', 'watchdog-update.mjs', 'watchdog-artifact.mjs', 'watchdog-smoke.mjs']) {
    copyFileSync(join(root, 'scripts', name), join(checkout, 'scripts', name))
  }
  const result = spawnSync(process.execPath, [join(checkout, 'scripts/watchdog-control.mjs'), 'start', '--home', home],
    { encoding: 'utf8', timeout: 30_000 })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('remote get-url origin failed')
  expect(existsSync(home)).toBe(false)
})

it('waits for an active bootstrap lock before stopping the observer', async () => {
  const { checkout, home } = fixture()
  const artifact = buildFromRepo(home, checkout)
  const lock = join(home, 'update.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, bootstrap: true }))
  const timer = setTimeout(() => rmSync(lock, { recursive: true }), 400)
  const options = parseArgv(['deploy', '--home', home])
  let stopped = false
  try {
    const result = await deployArtifact(options, { buildFromRepo: () => artifact,
      stopObserver: async () => {
        expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).bootstrap).toBeUndefined()
        stopped = true
      },
      update: async (_config: unknown, _request: unknown, dependencies: { lockHeld: boolean }) => {
        expect(stopped).toBe(true)
        expect(dependencies.lockHeld).toBe(true)
        expect(existsSync(lock)).toBe(true)
        return { ok: true, phase: 'updated' }
      } })
    expect(result.ok).toBe(true)
    expect(existsSync(lock)).toBe(false)
  } finally {
    clearTimeout(timer)
  }
})

it('reports an already-current restart after the observer starts', async () => {
  const { checkout, home } = fixture()
  const artifact = buildFromRepo(home, checkout)
  const version = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8')).version
  writeFileSync(join(home, 'current.txt'), version)
  const options = parseArgv(['start', '--home', home])
  const dependencies = { buildFromRepo: () => artifact, stopObserver: async () => ({}),
    update: async () => ({ ok: true, phase: 'already-current' }), startObserver: async () => ({ started: true }) }
  await expect(deployArtifact(options, dependencies)).resolves.toMatchObject({ ok: true, started: true })
})

it('bootstraps a remote artifact without touching the source checkout or a service', () => {
  const { checkout, home, origin } = fixture()
  const other = join(directory!, 'bootstrap-remote')
  git(directory!, 'clone', '-b', 'main', origin, other)
  git(other, 'config', 'user.name', 'Test')
  git(other, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(other, 'remote-change'), 'latest')
  git(other, 'add', '.')
  git(other, 'commit', '-m', 'latest')
  git(other, 'push', 'origin', 'main')
  const latest = git(other, 'rev-parse', 'HEAD')
  writeFileSync(join(checkout, 'scripts', 'watchdog'), 'preserved dirty checkout')
  mkdirSync(home)
  for (const name of ['watchdog-control.mjs', 'watchdog-update.mjs', 'watchdog-artifact.mjs', 'watchdog-smoke.mjs']) {
    copyFileSync(join(root, 'scripts', name), join(home, name))
  }
  writeFileSync(join(home, 'source-checkout.txt'), checkout)
  const status = git(checkout, 'status', '--porcelain')
  const bootstrap = join(root, 'scripts', 'watchdog-bootstrap.mjs')
  const run = () => spawnSync(process.execPath, [bootstrap, home], { encoding: 'utf8', timeout: 60_000 })
  const first = run()
  expect(first.status, first.stderr).toBe(0)
  expect(readFileSync(join(home, 'current.txt'), 'utf8').trim()).toBe(latest.slice(0, 7))
  expect(readFileSync(join(checkout, 'scripts', 'watchdog'), 'utf8')).toBe('preserved dirty checkout')
  expect(git(checkout, 'status', '--porcelain')).toBe(status)
  const lock = join(home, 'update.lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }))
  writeFileSync(join(lock, 'launch-version.txt'), readFileSync(join(home, 'current.txt')))
  expect(run().status).toBe(0)
  writeFileSync(join(lock, 'launch-version.txt'), 'wrong')
  const conflict = run()
  expect(conflict.status).toBe(1)
  expect(conflict.stderr).toContain('transaction pointer mismatch')
  rmSync(lock, { recursive: true })
  git(checkout, 'remote', 'remove', 'origin')
  const failure = run()
  expect(failure.status).toBe(1)
  expect(failure.stderr).toContain('remote get-url origin failed')
  expect(existsSync(lock)).toBe(false)
})

it('rejects explicit artifacts before touching the observer or updater', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-'))
  const options = parseArgv(['deploy', '--artifact', join(directory, 'old'), '--home', join(directory, 'home')])
  let called = false
  await expect(deployArtifact(options, { update: async () => { called = true } })).rejects.toThrow('deploy --artifact is not supported')
  expect(called).toBe(false)
  expect(existsSync(join(directory, 'home'))).toBe(false)
})
