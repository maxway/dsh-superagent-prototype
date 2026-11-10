/** The mechanical deployment executor: read-only plan, runtime switch, stopped-state backup and rollback without a model. */
import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const executor = join(import.meta.dirname, '..', 'scripts', 'deploy.mjs')
let directory: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

interface Fixture {
  root: string
  runtime: string
  candidate: string
  stateDir: string
  backups: string
  controlLog: string
  controlState: string
  request: string
  config: string
  revision: string
  url: string
  home: string
}

/** A fake control script: it owns the process state, fails the first verify when asked, and records every invocation. */
function fakeControl(root: string, runtime: string, stateDir: string, controlLog: string, controlState: string) {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const statePath = ${JSON.stringify(controlState)}
const runtime = ${JSON.stringify(runtime)}
const stateDir = ${JSON.stringify(stateDir)}
const logPath = ${JSON.stringify(controlLog)}
const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return { running: true, verifyCode: 0 } } }
const write = value => writeFileSync(statePath, JSON.stringify(value))
const value = read()
const action = process.argv[2]
appendFileSync(logPath, process.argv.slice(2).join(' ') + '\\n')
if (action === 'status') {
  const running = value.running !== false
  console.log(JSON.stringify({ pids: running ? [4242] : [], cwd: runtime, url: 'http://127.0.0.1:3083', profile: 'superagent',
    manually_stopped: false, deployment: { stateDir, bundleLink: join(runtime, 'link'), bundleTarget: runtime,
      git: { head: 'a'.repeat(40), branch: 'main', dirty: false } },
    health: running ? { runtime: 'ready', evals: 'error' } : null,
    errors: running ? { evals: 'error' } : null, setup: null, feishu: null, inJob: true, foreignJob: false, start: null }))
  process.exit(running ? 2 : 1)
}
if (action === 'stop') { write({ ...value, running: false }); console.log('stopped'); process.exit(0) }
if (action === 'start') { write({ ...value, running: true }); console.log('started'); process.exit(0) }
if (action === 'verify') {
  const code = Number(value.verifyCode ?? 0)
  write({ ...value, verifyCode: 0 })
  console.log(JSON.stringify({ ok: code === 0, pid: 4242 }))
  process.exit(code)
}
if (action === 'watchdog') { console.log('{}'); process.exit(0) }
process.exit(2)
`
}

function commitAll(path: string): string {
  execFileSync('git', ['-C', path, 'init', '-q'])
  execFileSync('git', ['-C', path, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', path, 'add', '-A'])
  execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'candidate'])
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

async function fixture(options: { workload?: { running: number, queued: number }, verifyCode?: number, manifest?: unknown, targetRevision?: string, candidateLock?: string } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superagent-deploy-'))
  directory = root
  const runtime = join(root, 'runtime')
  const candidate = join(root, 'candidate')
  const stateDir = join(root, 'state')
  const backups = join(root, 'backups')
  const home = join(root, 'home')
  for (const path of [runtime, candidate, stateDir, backups, home]) mkdirSync(path, { recursive: true })
  mkdirSync(join(runtime, 'lib'))
  mkdirSync(join(runtime, 'prompts'))
  mkdirSync(join(runtime, 'scripts'))
  mkdirSync(join(candidate, 'lib'))
  mkdirSync(join(candidate, 'prompts'))
  writeFileSync(join(runtime, 'lib', 'old.txt'), 'old lib\n')
  writeFileSync(join(runtime, 'prompts', 'old.txt'), 'old prompt\n')
  writeFileSync(join(candidate, 'lib', 'new.txt'), 'new lib\n')
  writeFileSync(join(candidate, 'prompts', 'new.txt'), 'new prompt\n')
  writeFileSync(join(candidate, 'pnpm-lock.yaml'), options.candidateLock ?? 'lockfileVersion: test\n')
  writeFileSync(join(runtime, 'pnpm-lock.yaml'), 'lockfileVersion: test\n')
  writeFileSync(join(runtime, 'package.json'), '{ "type": "module" }\n')
  const controlLog = join(root, 'control.log')
  const controlState = join(root, 'control-state.json')
  writeFileSync(controlState, JSON.stringify({ running: true, verifyCode: options.verifyCode ?? 0 }))
  const control = join(runtime, 'scripts', 'dsh-superagent')
  writeFileSync(control, fakeControl(root, runtime, stateDir, controlLog, controlState))
  writeFileSync(join(stateDir, 'orchestrator.sqlite'), 'sqlite bytes\n')
  writeFileSync(join(stateDir, 'orchestrator.sqlite-wal'), 'wal bytes\n')
  const revision = commitAll(candidate)
  const request = join(root, 'deploy-request.json')
  writeFileSync(request, JSON.stringify({ at: '2026-11-10T01:00:00.000Z', requestedBy: 'operator', confirmation: '部署 superagent', target: 'latest' }))

  const workload = options.workload ?? { running: 0, queued: 0 }
  server = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/orchestrator/api/state')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ load: workload }))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolvePromise => server!.listen(0, '127.0.0.1', resolvePromise))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  const manifest = join(root, 'manifest.json')
  writeFileSync(manifest, JSON.stringify(options.manifest ?? { entries: [
    { source: 'lib', target: 'lib' },
    { source: 'prompts', target: 'prompts' },
  ] }))
  const config = join(root, 'deploy-config.json')
  writeFileSync(config, JSON.stringify({
    requestPath: request,
    logFile: join(root, 'deploy.log'),
    resultFile: join(root, 'deploy-result.json'),
    node: process.execPath,
    url,
    home,
    serviceProfile: 'superagent',
    survivalSeconds: 0,
    mechanical: {
      candidateRoot: candidate,
      manifestPath: manifest,
      backupRoot: backups,
      runtimeRoot: runtime,
      stateDir,
      control,
      targetRevision: options.targetRevision ?? revision,
      fetch: false,
    },
  }))
  return { root, runtime, candidate, stateDir, backups, controlLog, controlState, request, config, revision, url, home }
}

function run(config: string, ...args: string[]) {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolvePromise => {
    execFile(process.execPath, [executor, '--config', config, ...args], { timeout: 60_000, env: { ...process.env } },
      (error, stdout, stderr) => resolvePromise({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
        stdout, stderr,
      }))
  })
}

const controlCalls = (fixtureValue: Fixture) => readFileSync(fixtureValue.controlLog, 'utf8').trim().split('\n').filter(Boolean)
const resultOf = (fixtureValue: Fixture) => JSON.parse(readFileSync(join(fixtureValue.root, 'deploy-result.json'), 'utf8')) as Record<string, unknown>

it('prints a read-only plan without stopping, switching or archiving the request', async () => {
  const value = await fixture()
  const planned = await run(value.config, '--plan')
  expect(planned.code).toBe(0)
  const plan = JSON.parse(planned.stdout) as Record<string, unknown>
  expect(plan).toMatchObject({ ok: true, mode: 'mechanical', planOnly: true, revision: value.revision })
  expect((plan.entries as unknown[]).length).toBe(2)
  expect(readFileSync(join(value.runtime, 'lib', 'old.txt'), 'utf8')).toBe('old lib\n')
  expect(existsSync(value.request)).toBe(true)
  expect(controlCalls(value).some(line => line.startsWith('stop '))).toBe(false)
  expect(existsSync(join(value.backups, 'deploy.lock'))).toBe(false)
})

it('stops, backs up the stopped state, switches the manifest, starts and verifies without a model', async () => {
  const value = await fixture()
  const deployed = await run(value.config)
  expect(deployed.stderr).toBe('')
  expect(deployed.code).toBe(0)
  const result = resultOf(value)
  expect(result).toMatchObject({ ok: true, phase: 'verified', mode: 'mechanical', revision: value.revision })

  expect(readFileSync(join(value.runtime, 'lib', 'new.txt'), 'utf8')).toBe('new lib\n')
  expect(readFileSync(join(value.runtime, 'prompts', 'new.txt'), 'utf8')).toBe('new prompt\n')
  expect(existsSync(join(value.runtime, 'lib', 'old.txt'))).toBe(false)
  const previous = readdirSync(value.runtime).filter(name => name.startsWith('lib.previous-'))
  expect(previous).toHaveLength(1)
  expect(previous[0]).toMatch(new RegExp(`^lib\\.previous-${value.revision.slice(0, 12)}-`))

  const backup = (result.backup as { directory: string }).directory
  expect(readFileSync(join(backup, 'state', 'orchestrator.sqlite'), 'utf8')).toBe('sqlite bytes\n')
  expect(readFileSync(join(backup, 'state', 'orchestrator.sqlite-wal'), 'utf8')).toBe('wal bytes\n')
  expect(JSON.parse(readFileSync(join(backup, 'switch.json'), 'utf8'))).toMatchObject({ phase: 'verified' })

  expect(existsSync(value.request)).toBe(false)
  expect(existsSync(join(value.root, 'deploy-request.last.json'))).toBe(true)
  expect(existsSync(join(value.backups, 'deploy.lock'))).toBe(false)
  const calls = controlCalls(value)
  expect(calls.some(line => line.startsWith('stop '))).toBe(true)
  expect(calls.some(line => line.startsWith('start '))).toBe(true)
  expect(calls.some(line => line.startsWith('verify ') && line.includes('--survival-seconds 0'))).toBe(true)
})

it('ignores an unrelated part error such as the evals health part', async () => {
  // The fake status always reports errors.evals=error and exits 2; a routine switch must not block on it.
  const value = await fixture()
  expect((await run(value.config)).code).toBe(0)
  expect(resultOf(value)).toMatchObject({ ok: true, phase: 'verified' })
})

it('does not stop or switch when the service is busy', async () => {
  const value = await fixture({ workload: { running: 1, queued: 2 } })
  const deployed = await run(value.config)
  expect(deployed.code).toBe(1)
  expect(resultOf(value)).toMatchObject({ ok: false, phase: 'preflight_failed' })
  expect((resultOf(value).error as string)).toContain('service_busy')
  expect(controlCalls(value).some(line => line.startsWith('stop '))).toBe(false)
  expect(readFileSync(join(value.runtime, 'lib', 'old.txt'), 'utf8')).toBe('old lib\n')
  expect(existsSync(value.request)).toBe(true)
})

it('restores the previous runtime files and restarts the old build when verification fails', async () => {
  const value = await fixture({ verifyCode: 1 })
  const deployed = await run(value.config)
  expect(deployed.code).toBe(1)
  const result = resultOf(value)
  expect(result).toMatchObject({ ok: false, phase: 'rolled_back', mode: 'mechanical' })
  expect((result.rollback as Record<string, unknown>)).toMatchObject({ attempted: true, restored: true, started: true })

  expect(readFileSync(join(value.runtime, 'lib', 'old.txt'), 'utf8')).toBe('old lib\n')
  expect(existsSync(join(value.runtime, 'lib', 'new.txt'))).toBe(false)
  expect(readdirSync(value.runtime).filter(name => name.startsWith('lib.previous-'))).toEqual([])
  expect(readFileSync(join(value.runtime, 'prompts', 'old.txt'), 'utf8')).toBe('old prompt\n')
  expect(existsSync(join(value.backups, 'deploy.lock'))).toBe(false)
  const calls = controlCalls(value)
  expect(calls.filter(line => line.startsWith('start '))).toHaveLength(2)
})

it('refuses a manifest that escapes the candidate or runtime root', async () => {
  const value = await fixture({ manifest: { entries: [{ source: '../candidate/lib', target: 'lib' }] } })
  const deployed = await run(value.config)
  expect(deployed.code).toBe(1)
  expect(resultOf(value)).toMatchObject({ ok: false, phase: 'preflight_failed' })
  expect((resultOf(value).error as string)).toContain('invalid_manifest')
  expect(controlCalls(value).some(line => line.startsWith('stop '))).toBe(false)
})

it('refuses a candidate that is not at the requested revision', async () => {
  const value = await fixture({ targetRevision: 'b'.repeat(40) })
  const deployed = await run(value.config)
  expect(deployed.code).toBe(1)
  expect((resultOf(value).error as string)).toContain('candidate_revision')
  expect(controlCalls(value).some(line => line.startsWith('stop '))).toBe(false)
})

it('refuses a dependency change instead of switching a stale node_modules tree', async () => {
  const value = await fixture({ candidateLock: 'lockfileVersion: changed\n' })
  const deployed = await run(value.config)
  expect(deployed.code).toBe(1)
  expect(resultOf(value)).toMatchObject({ ok: false, phase: 'preflight_failed' })
  expect((resultOf(value).error as string)).toContain('dependency_change')
  expect(controlCalls(value).some(line => line.startsWith('stop '))).toBe(false)
})

it('keeps the headless agent fallback when no mechanical block is configured', async () => {
  const value = await fixture()
  const dsh = join(value.root, 'fake-dsh.mjs')
  writeFileSync(dsh, 'process.stdin.resume()\nprocess.stdin.on("end", () => process.exit(0))\nsetTimeout(() => process.exit(0), 100)\n')
  const promptPath = join(value.root, 'deploy-prompt.md')
  writeFileSync(promptPath, 'deploy it\n')
  const modelPatch = join(value.root, 'model.patch.yml')
  writeFileSync(modelPatch, '')
  const config = join(value.root, 'agent-config.json')
  writeFileSync(config, JSON.stringify({
    requestPath: value.request,
    logFile: join(value.root, 'deploy.log'),
    resultFile: join(value.root, 'deploy-result.json'),
    node: process.execPath,
    dsh,
    home: join(value.root, 'home'),
    url: value.url,
    serviceProfile: 'superagent',
    survivalSeconds: 0,
    promptPath,
    modelPatch,
    workdir: value.root,
    control: join(value.runtime, 'scripts', 'dsh-superagent'),
  }))
  const deployed = await run(config)
  expect(deployed.code).toBe(0)
  expect(resultOf(value)).toMatchObject({ ok: true, phase: 'agent_exited_service_alive', mode: 'agent', agentExitCode: 0 })
  expect(existsSync(join(value.root, 'deploy-request.last.json'))).toBe(true)
  expect(controlCalls(value).some(line => line.startsWith('verify '))).toBe(true)
})

it.skipIf(process.platform !== 'win32')('starts and stops through the operator service wrapper when configured', async () => {
  const value = await fixture()
  const controlPath = join(value.runtime, 'scripts', 'dsh-superagent')
  const wrapper = join(value.root, 'service.ps1')
  writeFileSync(wrapper, [
    'param([string]$Action)',
    `& '${process.execPath}' '${controlPath}' $Action --profile superagent --url '${value.url}' --home '${value.home}'`,
    'exit $LASTEXITCODE',
    '',
  ].join('\n'))
  const settings = JSON.parse(readFileSync(value.config, 'utf8')) as Record<string, unknown>
  const config = join(value.root, 'wrapper-config.json')
  writeFileSync(config, JSON.stringify({ ...settings, serviceScript: wrapper }))
  const deployed = await run(config)
  expect(deployed.code).toBe(0)
  expect(resultOf(value)).toMatchObject({ ok: true, phase: 'verified' })
  const calls = controlCalls(value)
  expect(calls.some(line => line.startsWith('stop '))).toBe(true)
  expect(calls.some(line => line.startsWith('start '))).toBe(true)
})