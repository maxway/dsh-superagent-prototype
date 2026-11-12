import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error The scripts are plain JavaScript modules.
import { acquireLock, claimLatestRequest, installArtifact, loadConfig, observerStateDir, update, writePointer } from '../scripts/watchdog-update.mjs'

const script = join(import.meta.dirname, '..', 'scripts', 'watchdog-update.mjs')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('refuses update, request claim and bootstrap mutation before any side effects', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-update-safety-'))
  const home = join(directory, 'home')
  const state = join(home, 'observer-state')
  mkdirSync(state, { recursive: true })
  const request = join(directory, 'request.json')
  const requestText = JSON.stringify({ confirmation: 'test', idempotencyKey: 'test' })
  writeFileSync(request, requestText)
  writeFileSync(join(home, 'current.txt'), 'original\n')
  writeFileSync(join(state, 'watchdog.pid'), String(process.pid))
  const marker = join(directory, 'command-ran')
  const command = `"${process.execPath}" -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'ran')"`
  const configPath = join(directory, 'config.json')
  writeFileSync(configPath, JSON.stringify({ watchdogHome: home, requestPath: request, serviceUrl: 'http://127.0.0.1:1',
    observerStopCommand: command, observerStartCommand: command, logFile: join(directory, 'log'), resultFile: join(directory, 'result') }))
  const config = loadConfig(configPath)
  const archive = join(directory, 'archive')
  let triggered = false
  await expect(update(config, {}, { trigger: () => { triggered = true } })).rejects.toThrow('temporarily disabled')
  expect(() => claimLatestRequest(request, archive)).toThrow('temporarily disabled')
  expect(() => installArtifact(home, directory, { version: 'v2' })).toThrow('temporarily disabled')
  expect(() => writePointer(home, 'current.txt', 'v2')).toThrow('temporarily disabled')
  expect(() => acquireLock(config)).toThrow('temporarily disabled')
  for (const args of [[], ['--request', request]]) {
    const result = spawnSync(process.execPath, [script, '--config', configPath, ...args], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('temporarily disabled')
  }
  expect(triggered).toBe(false)
  expect(readFileSync(request, 'utf8')).toBe(requestText)
  expect(readFileSync(join(home, 'current.txt'), 'utf8')).toBe('original\n')
  expect(readFileSync(join(state, 'watchdog.pid'), 'utf8')).toBe(String(process.pid))
  for (const path of [marker, join(directory, 'archive'), join(directory, 'result'), join(directory, 'log'), join(home, 'update.lock')]) {
    expect(existsSync(path)).toBe(false)
  }
  expect(() => process.kill(process.pid, 0)).not.toThrow()
})

it('retains read-only configuration validation and state directory resolution', () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-update-config-'))
  const home = join(directory, 'home')
  mkdirSync(home)
  expect(observerStateDir(home)).toBe(join(home, 'observer-state'))
  writeFileSync(join(home, 'observer.json'), JSON.stringify({ stateDir: 'custom' }))
  expect(observerStateDir(home)).toBe(join(home, 'custom'))
  const config = join(directory, 'config.json')
  writeFileSync(config, JSON.stringify({ watchdogHome: home, requestPath: join(directory, 'request'), serviceUrl: 'http://127.0.0.1:1',
    observerStopCommand: 'unused', observerStartCommand: 'unused', logFile: join(directory, 'log'), resultFile: join(directory, 'result') }))
  const result = spawnSync(process.execPath, [script, '--config', config, '--validate'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).watchdogHome).toBe(home)
  expect(existsSync(join(directory, 'request'))).toBe(false)
})
