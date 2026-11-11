#!/usr/bin/env node
/**
 * Operator lifecycle for the standing Watchdog.
 *
 * `status`, `start`, `stop` and `deploy` are mechanical: they use the scheduled task, the artifact manifest
 * and the recorded heartbeat. No model, agent prompt or operator chat participates, and every
 * environment path has one default so a deploy needs only `deploy --build`.
 *
 * The scheduled task runs `launch-observer.vbs -Config observer.json`; the launcher reads `current.txt`, so a deploy
 * switches that pointer and restarts the task without rewriting the task action or restarting superagent.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArtifact, verifyArtifact } from './watchdog-artifact.mjs'
import { acquireLock, update } from './watchdog-update.mjs'

const DEFAULT_HOME = process.env.DSH_WATCHDOG_HOME || join(homedir(), '.dsh', 'watchdog-independent')
const DEFAULT_TASK = 'dsh-superagent-watchdog-observer'
const DEFAULT_URL = 'http://127.0.0.1:3083'
const VERSION = /^[A-Za-z0-9._-]+$/
const USAGE = `Usage: watchdog-control <status|start|stop|deploy> [options]

  status                 Show the active version, observer process, task state and recorded heartbeat.
  start                  Build and deploy latest origin/main, then start the standing observer.
  stop                   Stop the standing observer task and its exact process tree.
  deploy [--build]       Build and deploy the latest origin/main in a temporary clone.
  deploy --artifact <d>  Not supported: deploy requires a fresh build from origin/main.

Options:
  --home <dir>       Watchdog home (default: $DSH_WATCHDOG_HOME or ~/.dsh/watchdog-independent)
  --task <name>      Scheduled task name (default: ${DEFAULT_TASK})
  --url <url>        Management API URL (default: observer.json's url or ${DEFAULT_URL})
  --json             Print machine-readable status (status only)
  --help             Show this help.
`

function run(command, { allowFailure = false } = {}) {
  const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`)
  }
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

function taskCommand(action, task) {
  return `schtasks /${action} /tn "${task}"`
}

function taskState(task) {
  const escaped = task.replace(/'/g, "''")
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$t=Get-ScheduledTask -TaskName '${escaped}' -ErrorAction SilentlyContinue; if ($t) { $t.State }`],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (result.error || result.status !== 0) return 'missing'
  return (result.stdout ?? '').trim() || 'missing'
}

function observerPid(home) {
  try {
    const value = Number.parseInt(readFileSync(join(home, 'observer-state', 'watchdog.pid'), 'utf8').trim(), 10)
    return Number.isInteger(value) && value > 0 ? value : undefined
  } catch { return undefined }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Kill the task's launcher processes too: a surviving launcher loop would restart the observer from its old path. */
function stopLauncherProcesses(home) {
  const escaped = home.replace(/'/g, "''")
  const script = `$home='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($home) -and ($_.CommandLine.Contains('launch-observer.ps1') -or $_.CommandLine.Contains('launch-observer.vbs')) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.error) throw result.error
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
    observerStopCommand: taskCommand('end', options.task),
    observerStartCommand: taskCommand('run', options.task),
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

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0] === 'remote' ? args.slice(0, 3).join(' ') : args[0]} failed`)
  return (result.stdout ?? '').trim()
}

export function buildFromRepo(home, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const stagingRelative = relative(resolve(root), resolve(home, 'staging'))
  if (!stagingRelative || (!stagingRelative.startsWith(`..${sep}`) && stagingRelative !== '..' && !isAbsolute(stagingRelative))) {
    throw new Error('Watchdog staging must be outside the runtime checkout')
  }
  const origin = git(root, ['remote', 'get-url', 'origin'])
  const temporary = mkdtempSync(join(tmpdir(), 'watchdog-build-'))
  try {
    const checkout = join(temporary, 'checkout')
    git(root, ['clone', '--no-checkout', '--single-branch', '--branch', 'main', '--', origin, checkout])
    const commit = git(checkout, ['rev-parse', 'refs/remotes/origin/main^{commit}'])
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error('Could not resolve origin/main to a commit')
    git(checkout, ['checkout', '--detach', commit])
    const version = commit.slice(0, 7)
    const staging = join(home, 'staging')
    const out = join(staging, version)
    mkdirSync(staging, { recursive: true })
    rmSync(out, { recursive: true, force: true })
    buildArtifact(checkout, out, { version, commit })
    verifyArtifact(out)
    return out
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Copy the stable observer launcher from an artifact to the home the scheduled task runs from. */
export function installLaunchers(home, artifact, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  mkdirSync(home, { recursive: true })
  for (const name of ['launch-observer.ps1', 'launch-observer.vbs', 'watchdog-bootstrap.mjs', 'watchdog-control.mjs',
    'watchdog-update.mjs', 'watchdog-artifact.mjs', 'watchdog-smoke.mjs']) {
    const source = join(artifact, name)
    if (!existsSync(source)) throw new Error(`The artifact has no ${name}; rebuild it from this checkout`)
    copyFileSync(source, join(home, name))
  }
  writeFileSync(join(home, 'source-checkout.txt'), `${root}\n`)
}

/** Put an artifact under the staging root, install its launchers and return the verified local path. */
export function prepareArtifact(home, source) {
  const manifest = verifyArtifact(source)
  const staging = join(home, 'staging')
  const destination = join(staging, manifest.version)
  mkdirSync(staging, { recursive: true })
  if (resolve(source) !== resolve(destination)) {
    rmSync(destination, { recursive: true, force: true })
    cpSync(source, destination, { recursive: true })
    verifyArtifact(destination)
  }
  installLaunchers(home, destination)
  return { path: destination, manifest }
}

function deployedRequest(manifest, path) {
  return { confirmation: 'watchdog-control deploy', idempotencyKey: `control-${manifest.version}-${Date.now()}`,
    target: { version: manifest.version, artifactPath: path, sha256: manifest.sha256 } }
}

/** Mechanical deploy: install, switch the pointer and start the observer. */
export async function deployArtifact(options, dependencies = {}) {
  if (options.artifact) throw new Error('deploy --artifact is not supported; use deploy --build to build latest origin/main')
  const config = controlConfig(options)
  const source = (dependencies.buildFromRepo ?? buildFromRepo)(config.watchdogHome)
  const deadline = Date.now() + 180_000
  let release
  while (!release) {
    try { release = (dependencies.acquireLock ?? acquireLock)(config) } catch (error) {
      if (!String(error.message).startsWith('Another Watchdog update is in progress:') || Date.now() >= deadline) throw error
      await sleep(250)
    }
  }
  let prepared
  let result
  try {
    prepared = prepareArtifact(config.watchdogHome, source)
    await (dependencies.stopObserver ?? stopObserver)(options)
    const apply = dependencies.update ?? update
    result = await apply({ ...config, observerStopCommand: 'cmd /c exit 0' },
      deployedRequest(prepared.manifest, prepared.path), { lockHeld: true })
  } finally {
    release()
  }
  if (result.ok && result.phase === 'already-current' && !pidAlive(observerPid(config.watchdogHome))) {
    const started = await (dependencies.startObserver ?? startObserver)(options)
    return { ...result, ...started }
  }
  return result
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

async function waitFor(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(250)
  }
  return predicate()
}

export async function startObserver(options) {
  const config = controlConfig(options)
  if (!readPointer(config.watchdogHome, 'current.txt')) throw new Error(`No current Watchdog version under ${config.watchdogHome}`)
  if (taskState(options.task) === 'missing') throw new Error(`The scheduled task ${options.task} is not installed`)
  const started = run(taskCommand('run', options.task), { allowFailure: true })
  if (!await waitFor(() => pidAlive(observerPid(config.watchdogHome)), 30_000)) {
    throw new Error(`The observer task started but no live observer pid appeared within 30s: ${started.stderr}`)
  }
  return { started: true, pid: observerPid(config.watchdogHome), task: options.task }
}

export async function stopObserver(options) {
  const config = controlConfig(options)
  const state = taskState(options.task)
  if (state !== 'missing') run(taskCommand('end', options.task), { allowFailure: true })
  stopLauncherProcesses(config.watchdogHome)
  let pid = observerPid(config.watchdogHome)
  if (!await waitFor(() => !pidAlive(pid), 10_000)) {
    if (pid && pidAlive(pid)) run(`taskkill /pid ${pid} /t /f`, { allowFailure: true })
    if (!await waitFor(() => !pidAlive(pid), 10_000)) throw new Error(`The observer pid ${pid} is still alive`)
  }
  rmSync(join(config.watchdogHome, 'observer-state', 'watchdog.pid'), { force: true })
  return { stopped: true, pid: pid ?? null, task: options.task, ...(state === 'missing' ? { note: 'task not installed' } : {}) }
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
  const pid = observerPid(home)
  const result = { home, task: options.task, taskState: taskState(options.task), current: readPointer(home, 'current.txt'),
    previous: readPointer(home, 'previous.txt'), pid: pid ?? null, pidAlive: pidAlive(pid), url: config.serviceUrl,
    service: await snapshot(config) }
  return result
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  if (options.help || !options.command) { process.stdout.write(USAGE); process.exitCode = options.help ? 0 : 2; return }
  if (!['status', 'start', 'stop', 'deploy'].includes(options.command)) {
    process.stderr.write(`${USAGE}\n`); process.exitCode = 2; return
  }
  if (options.command === 'deploy' && options.build && options.artifact) {
    process.stderr.write('deploy takes --build or --artifact, not both\n'); process.exitCode = 2; return
  }
  if (options.command === 'status') {
    process.stdout.write(`${JSON.stringify(await observerStatus(options), null, 2)}\n`); return
  }
  if (options.command === 'stop') {
    process.stdout.write(`${JSON.stringify(await stopObserver(options), null, 2)}\n`); return
  }
  const result = await deployArtifact(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
