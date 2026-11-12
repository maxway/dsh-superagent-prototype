#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { observerStateDir } from './watchdog-update.mjs'

const DEFAULT_HOME = process.env.DSH_WATCHDOG_HOME || join(homedir(), '.dsh', 'watchdog-independent')
const DEFAULT_TASK = 'dsh-superagent-watchdog-observer'
const DEFAULT_URL = 'http://127.0.0.1:3083'
const VERSION = /^[A-Za-z0-9._-]+$/
const USAGE = `Usage: watchdog-control <status|start|stop|deploy> [options]

  status             Show read-only task, PID and service information.
  start|stop|deploy  Disabled pending a safe lifecycle implementation.

Options: --home <dir> --task <name> --url <url> --json --help
The recorded PID and its liveness are unverified and do not establish process identity.
`

function disabled() {
  throw new Error('Watchdog lifecycle and deployment are temporarily disabled for safety')
}

export function stopLauncherProcesses() { return disabled() }
export function buildFromRepo() { return disabled() }
export function installLaunchers() { return disabled() }
export function prepareArtifact() { return disabled() }
export async function deployArtifact() { return disabled() }
export async function startObserver() { return disabled() }
export async function stopObserver() { return disabled() }

function taskState(task) {
  const escaped = task.replace(/'/g, "''")
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$t=Get-ScheduledTask -TaskName '${escaped}' -ErrorAction SilentlyContinue; if ($t) { $t.State }`],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (result.error || result.status !== 0) return 'unknown'
  return (result.stdout ?? '').trim() || 'missing'
}

function observerPid(stateDir) {
  try {
    const text = readFileSync(join(stateDir, 'watchdog.pid'), 'utf8').trim()
    if (!/^[1-9]\d*$/.test(text)) return undefined
    const value = Number(text)
    return Number.isSafeInteger(value) ? value : undefined
  } catch { return undefined }
}

function pidAlive(pid) {
  if (!pid) return null
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    return null
  }
}

function readObserverUrl(home) {
  try {
    const value = JSON.parse(readFileSync(join(home, 'observer.json'), 'utf8'))
    return typeof value.url === 'string' && /^https?:\/\//i.test(value.url) ? value.url : DEFAULT_URL
  } catch { return DEFAULT_URL }
}

function readPointer(home, name) {
  try {
    const value = readFileSync(join(home, name), 'utf8').trim()
    return VERSION.test(value) ? value : null
  } catch { return null }
}

export function controlConfig(options) {
  if (!options.home || !options.task) throw new Error('Both --home and --task need a value')
  const home = resolve(options.home)
  return {
    watchdogHome: home,
    stagingRoot: join(home, 'staging'),
    requestPath: join(home, 'watchdog-deploy-request.json'),
    serviceUrl: (options.url || readObserverUrl(home)).replace(/\/+$/, ''),
    observerStopCommand: `schtasks /end /tn "${options.task}"`,
    observerStartCommand: `schtasks /run /tn "${options.task}"`,
    serviceVersion: '',
    reportChat: '',
    logFile: join(home, 'watchdog-deploy.log'),
    resultFile: join(home, 'watchdog-deploy-result.json'),
    heartbeatTimeoutSeconds: 180,
    pollSeconds: 3,
    lockStaleSeconds: 900,
  }
}

export function parseArgv(argv) {
  const options = { command: argv[0] ?? '', home: DEFAULT_HOME, task: DEFAULT_TASK, url: '', artifact: '', build: false,
    json: false, help: false }
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--home') { options.home = argv[++index] ?? ''; continue }
    if (word.startsWith('--home=')) { options.home = word.slice(7); continue }
    if (word === '--task') { options.task = argv[++index] ?? ''; continue }
    if (word.startsWith('--task=')) { options.task = word.slice(7); continue }
    if (word === '--url') { options.url = argv[++index] ?? ''; continue }
    if (word.startsWith('--url=')) { options.url = word.slice(6); continue }
    if (word === '--artifact') { options.artifact = argv[++index] ?? ''; continue }
    if (word.startsWith('--artifact=')) { options.artifact = word.slice(11); continue }
    if (word === '--build') { options.build = true; continue }
    if (word === '--json') { options.json = true; continue }
    if (word === '-h' || word === '--help') { options.help = true; continue }
    throw new Error(`unrecognized argument: ${word}`)
  }
  return options
}

async function snapshot(config) {
  try {
    const response = await fetch(`${config.serviceUrl}/orchestrator/api/watchdog?stale_minutes=30`,
      { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return { error: `HTTP ${response.status}` }
    const value = await response.json()
    return { lastRun: value.lastRun ?? null, install: value.install ?? null }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function observerStatus(options) {
  const config = controlConfig(options)
  const home = config.watchdogHome
  const pid = observerPid(observerStateDir(home))
  return { home, task: options.task, taskState: taskState(options.task), current: readPointer(home, 'current.txt'),
    previous: readPointer(home, 'previous.txt'), pid: pid ?? null, pidAlive: pidAlive(pid), pidVerified: false,
    url: config.serviceUrl, service: await snapshot(config) }
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  if (options.help || !options.command) { process.stdout.write(USAGE); process.exitCode = options.help ? 0 : 2; return }
  if (!['status', 'start', 'stop', 'deploy'].includes(options.command)) {
    process.stderr.write(`${USAGE}\n`); process.exitCode = 2; return
  }
  if (options.command !== 'status') disabled()
  process.stdout.write(`${JSON.stringify(await observerStatus(options), null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
