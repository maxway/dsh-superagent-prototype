import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error The scripts are plain JavaScript modules.
import { buildFromRepo, deployArtifact, installLaunchers, observerStatus, parseArgv, prepareArtifact, startObserver, stopLauncherProcesses, stopObserver } from '../scripts/watchdog-control.mjs'

const script = join(import.meta.dirname, '..', 'scripts', 'watchdog-control.mjs')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('rejects all lifecycle and deployment entry points without using untrusted PID or launcher text', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-safety-'))
  const home = join(directory, 'home')
  const state = join(home, 'observer-state')
  mkdirSync(state, { recursive: true })
  const pidFile = join(state, 'watchdog.pid')
  writeFileSync(pidFile, String(process.pid))
  writeFileSync(join(home, 'current.txt'), 'original\n')
  const options = parseArgv(['stop', '--home', home, '--task', 'isolated-test-task'])
  let called = false
  expect(() => stopLauncherProcesses(home, () => { called = true })).toThrow('temporarily disabled')
  expect(() => buildFromRepo(home)).toThrow('temporarily disabled')
  expect(() => installLaunchers(home, directory)).toThrow('temporarily disabled')
  expect(() => prepareArtifact(home, directory)).toThrow('temporarily disabled')
  await expect(stopObserver(options)).rejects.toThrow('temporarily disabled')
  await expect(startObserver(options)).rejects.toThrow('temporarily disabled')
  await expect(deployArtifact(options, { buildFromRepo: () => { called = true } })).rejects.toThrow('temporarily disabled')
  for (const command of ['start', 'stop', 'deploy']) {
    const result = spawnSync(process.execPath, [script, command, '--home', home, '--task', 'isolated-test-task'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('temporarily disabled')
  }
  expect(called).toBe(false)
  expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid))
  expect(readFileSync(join(home, 'current.txt'), 'utf8')).toBe('original\n')
  expect(existsSync(join(home, 'staging'))).toBe(false)
  expect(() => process.kill(process.pid, 0)).not.toThrow()
})

it('reports configured PID only as unverified and rejects malformed PID text', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-status-'))
  const home = join(directory, 'home')
  const state = join(home, 'custom-state')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(home, 'observer.json'), JSON.stringify({ stateDir: 'custom-state' }))
  const options = parseArgv(['status', '--home', home, '--task', 'isolated-test-task', '--url', 'http://[invalid'])
  writeFileSync(join(state, 'watchdog.pid'), String(process.pid))
  expect(await observerStatus(options)).toMatchObject({ pid: process.pid, pidAlive: true, pidVerified: false })
  writeFileSync(join(state, 'watchdog.pid'), `${process.pid}junk`)
  expect(await observerStatus(options)).toMatchObject({ pid: null, pidAlive: null, pidVerified: false })
})
