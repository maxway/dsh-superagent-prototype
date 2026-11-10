/** The mechanical Watchdog lifecycle: one command surface, scheduler commands and a model-free deploy request. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error The mechanical lifecycle scripts are plain .mjs and are not part of the TypeScript build.
import { buildArtifact } from '../scripts/watchdog-artifact.mjs'
// @ts-expect-error The mechanical lifecycle scripts are plain .mjs and are not part of the TypeScript build.
import { controlConfig, deployArtifact, parseArgv } from '../scripts/watchdog-control.mjs'

const root = join(import.meta.dirname, '..')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

it('parses the lifecycle options and creates scheduler commands without extra parameters', () => {
  const options = parseArgv(['deploy', '--build', '--home', 'C:\\watchdog', '--task', 'watchdog-task'])
  expect(options).toMatchObject({ command: 'deploy', home: 'C:\\watchdog', task: 'watchdog-task', build: true, artifact: '' })
  const config = controlConfig(options)
  expect(config).toMatchObject({
    watchdogHome: 'C:\\watchdog',
    stagingRoot: 'C:\\watchdog\\staging',
    observerStopCommand: 'schtasks /end /tn "watchdog-task"',
    observerStartCommand: 'schtasks /run /tn "watchdog-task"',
    heartbeatTimeoutSeconds: 180,
  })
  expect(config.requestPath).toBe('C:\\watchdog\\watchdog-deploy-request.json')
  expect(config.serviceUrl).toBe('http://127.0.0.1:3083')
  expect(parseArgv(['status', '--json'])).toMatchObject({ command: 'status', json: true })
})

it('prepares the artifact and hands one mechanical request to the updater', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-control-'))
  const artifact = join(directory, 'artifact')
  buildArtifact(root, artifact, { version: 'ctl-1', commit: 'a'.repeat(40), builtAt: '2026-11-10T00:00:00.000Z' })
  const home = join(directory, 'home')
  mkdirSync(home, { recursive: true })
  const calls: unknown[] = []
  const options = parseArgv(['deploy', '--artifact', artifact, '--home', home, '--task', 'watchdog-task',
    '--url', 'http://127.0.0.1:9'])
  const result = await deployArtifact(options, { update: async (config: unknown, request: unknown) => {
    calls.push({ config, request })
    return { ok: true, phase: 'updated', version: 'ctl-1' }
  } })
  expect(result).toMatchObject({ ok: true, version: 'ctl-1' })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ request: { target: { version: 'ctl-1', artifactPath: join(home, 'staging', 'ctl-1') } },
    config: { watchdogHome: home, observerStartCommand: 'schtasks /run /tn "watchdog-task"',
      observerStopCommand: 'schtasks /end /tn "watchdog-task"' } })
  expect(existsSync(join(home, 'staging', 'ctl-1', 'manifest.json'))).toBe(true)
  expect(existsSync(join(home, 'launch-observer.ps1'))).toBe(true)
  expect(existsSync(join(home, 'launch-observer.vbs'))).toBe(true)
  expect(JSON.parse(readFileSync(join(home, 'staging', 'ctl-1', 'manifest.json'), 'utf8'))).toMatchObject({ version: 'ctl-1' })
})