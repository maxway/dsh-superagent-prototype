#!/usr/bin/env node
/**
 * Independent Watchdog update task.
 *
 * The task runs outside the superagent service. It validates an operator request and an artifact, installs it under
 * `versions/<version>`, switches `current.txt`, starts the observer task and waits for a fresh local heartbeat.
 * A failed start or heartbeat leaves the candidate and pointer in place for investigation. It never
 * restarts or reconfigures the superagent service and never asks a model to decide anything.
 */
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyArtifact, versionAtLeast } from './watchdog-artifact.mjs'

const VERSION = /^[A-Za-z0-9._-]+$/
const KEY = /^[A-Za-z0-9._:-]+$/

export function readJson(path, what) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) { throw new Error(`Cannot read the ${what} at ${path}: ${error.message}`) }
  try { return JSON.parse(text) } catch (error) { throw new Error(`The ${what} at ${path} is not JSON: ${error.message}`) }
}

/** Load the operator configuration; the environment-specific paths stay outside the repository. */
export function loadConfig(path) {
  const value = readJson(path, 'watchdog update configuration')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The update configuration must be a JSON object')
  const required = (name, fallback = '') => {
    const field = value[name] ?? fallback
    if (typeof field !== 'string' || !field.trim()) throw new Error(`The update configuration needs ${name}`)
    return resolve(field)
  }
  const number = (name, fallback) => {
    const field = value[name] ?? fallback
    if (!Number.isInteger(field) || field < 1) throw new Error(`The update configuration needs a positive integer ${name}`)
    return field
  }
  const watchdogHome = required('watchdogHome')
  const requestPath = required('requestPath')
  const serviceUrl = String(value.serviceUrl ?? '').trim()
  if (!serviceUrl) throw new Error('The update configuration needs serviceUrl')
  const observerStopCommand = typeof value.observerStopCommand === 'string' ? value.observerStopCommand : ''
  const observerStartCommand = typeof value.observerStartCommand === 'string' ? value.observerStartCommand : ''
  if (!observerStopCommand || !observerStartCommand) {
    throw new Error('The update configuration needs observerStopCommand and observerStartCommand')
  }
  return {
    watchdogHome,
    stagingRoot: value.stagingRoot ? resolve(String(value.stagingRoot)) : dirname(requestPath),
    requestPath,
    serviceUrl: serviceUrl.replace(/\/+$/, ''),
    observerStopCommand,
    observerStartCommand,
    serviceVersion: typeof value.serviceVersion === 'string' ? value.serviceVersion : '',
    reportChat: typeof value.reportChat === 'string' ? value.reportChat : '',
    logFile: required('logFile'),
    resultFile: required('resultFile'),
    heartbeatTimeoutSeconds: number('heartbeatTimeoutSeconds', 180),
    pollSeconds: number('pollSeconds', 5),
    lockStaleSeconds: number('lockStaleSeconds', 900),
  }
}

/** Validate the operator request and that its artifact is inside the allowed staging root. */
export function validateRequest(request, config) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('The update request must be a JSON object')
  if (typeof request.confirmation !== 'string' || !request.confirmation.trim()) throw new Error('The update request has no operator confirmation')
  if (typeof request.idempotencyKey !== 'string' || !KEY.test(request.idempotencyKey)) throw new Error('The update request needs an idempotencyKey')
  const target = request.target
  if (!target || typeof target !== 'object') throw new Error('The update request needs a target')
  if (typeof target.version !== 'string' || !VERSION.test(target.version)) throw new Error('The update request target needs a version')
  if (typeof target.artifactPath !== 'string' || !target.artifactPath) throw new Error('The update request target needs an artifactPath')
  const artifactPath = resolve(target.artifactPath)
  const root = resolve(config.stagingRoot)
  const normalized = process.platform === 'win32' ? (path) => path.toLowerCase() : (path) => path
  if (!normalized(artifactPath).startsWith(normalized(root) + sep)) {
    throw new Error(`The artifact path is outside the staging root: ${artifactPath}`)
  }
  return { ...request, target: { ...target, artifactPath } }
}

export function readCurrent(home) {
  try {
    const value = readFileSync(join(home, 'current.txt'), 'utf8').trim()
    return VERSION.test(value) ? value : undefined
  } catch { return undefined }
}

/** Write a pointer atomically; a null value removes it. */
export function writePointer(home, name, value) {
  const path = join(home, name)
  if (value === null || value === undefined) { rmSync(path, { force: true }); return }
  mkdirSync(home, { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${value}\n`)
  renameSync(temporary, path)
}

/** Install one verified artifact under `versions/<version>`; an identical installation is reused. */
export function installArtifact(home, source, manifest) {
  const versions = join(home, 'versions')
  mkdirSync(versions, { recursive: true })
  const destination = join(versions, manifest.version)
  if (existsSync(destination)) {
    const installed = verifyArtifact(destination)
    if (installed.version !== manifest.version || installed.sha256 !== manifest.sha256) {
      throw new Error(`A different artifact is already installed at ${destination}`)
    }
    return { installed: false, destination }
  }
  const temporary = join(versions, `.${manifest.version}.${process.pid}.tmp`)
  rmSync(temporary, { recursive: true, force: true })
  cpSync(source, temporary, { recursive: true })
  try { verifyArtifact(temporary) } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
  renameSync(temporary, destination)
  return { installed: true, destination }
}

function log(config, message) {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    mkdirSync(dirname(config.logFile), { recursive: true })
    writeFileSync(config.logFile, line, { flag: 'a' })
  } catch { process.stderr.write(`Cannot write ${config.logFile}: ${line}`) }
}

function writeResult(config, result) {
  mkdirSync(dirname(config.resultFile), { recursive: true })
  const temporary = `${config.resultFile}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`)
  renameSync(temporary, config.resultFile)
}

export function acquireLock(config) {
  const lock = join(config.watchdogHome, 'update.lock')
  mkdirSync(config.watchdogHome, { recursive: true })
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let age = Infinity
    try { age = Date.now() - statSync(lock).mtimeMs } catch { /* It disappeared. */ }
    if (age < config.lockStaleSeconds * 1000) throw new Error(`Another Watchdog update is in progress: ${lock}`)
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock)
  }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  return () => rmSync(lock, { recursive: true, force: true })
}

/** Run one operator-configured observer or agent command with the target version in its environment. */
function runCommand(config, command, version) {
  const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, DSH_WATCHDOG_VERSION: version, DSH_WATCHDOG_SERVICE_URL: config.serviceUrl } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`The Watchdog command failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`)
  return { command, at: new Date().toISOString() }
}

/** Start the new standing observer after the pointer switches. */
function runTrigger(config, manifest) {
  if (!config.observerStartCommand) throw new Error('The update configuration needs observerStartCommand')
  return runCommand(config, config.observerStartCommand, manifest.version)
}

/** The old observer may outlive the task's top process; stop exactly its recorded pid before switching versions. */
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

async function waitForExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  return !pidAlive(pid)
}

/** Stop the old observer before the pointer switches; the scheduled task owns the lifecycle. */
async function stopObserver(config, version) {
  if (!config.observerStopCommand) return undefined
  const evidence = runCommand(config, config.observerStopCommand, version)
  const pid = observerPid(config.watchdogHome)
  if (pid && pidAlive(pid)) {
    if (!await waitForExit(pid, 10_000)) {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
      if (!await waitForExit(pid, 10_000)) throw new Error(`The old observer pid ${pid} did not stop`)
    }
  }
  rmSync(join(config.watchdogHome, 'observer-state', 'watchdog.pid'), { force: true })
  return evidence
}

export async function verifyObserverHeartbeat(config, since) {
  const heartbeatPath = join(config.watchdogHome, 'observer-state', 'heartbeat.json')
  const deadline = Date.now() + config.heartbeatTimeoutSeconds * 1000
  let heartbeat
  while (Date.now() < deadline) {
    try {
      const value = readJson(heartbeatPath, 'observer heartbeat')
      const at = Date.parse(value.at)
      if (Number.isInteger(value.pid) && value.pid > 0 && at >= since && at <= Date.now() + 5000 && pidAlive(value.pid)) {
        heartbeat = { pid: value.pid, at }
        break
      }
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
  }
  if (!heartbeat) throw new Error('No fresh live observer heartbeat after the start request')
  return { pid: heartbeat.pid, lastHeartbeat: new Date(heartbeat.at).toISOString() }
}

async function report(config, note, idempotencyKey) {
  if (!config.reportChat || !config.serviceUrl) return false
  try {
    const response = await fetch(new URL('/orchestrator/api/watchdog/report', `${config.serviceUrl}/`), {
      method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: config.reportChat, idempotencyKey, note: note.slice(0, 500) }),
      signal: AbortSignal.timeout(20_000),
    })
    return response.ok
  } catch { return false }
}

/**
 * Apply one validated update request. Injectable trigger and heartbeat functions allow isolated tests without touching
 * a real scheduled task or the production service.
 */
export async function update(config, rawRequest, dependencies = {}) {
  const request = validateRequest(rawRequest, config)
  const logLine = message => log(config, message)
  const trigger = dependencies.trigger ?? runTrigger
  const now = dependencies.now ?? (() => new Date())
  const release = dependencies.lock === false || dependencies.lockHeld ? () => {} : acquireLock(config)
  const finish = (result) => {
    writeResult(config, result)
    logLine(`end ${result.ok ? 'ok' : 'failed'} ${result.phase} version=${result.version ?? '-'}`)
    return result
  }
  try {
    const startedAt = now().toISOString()
    const previousResult = (() => { try { return readJson(config.resultFile, 'update result') } catch { return undefined } })()
    if (previousResult?.request?.idempotencyKey === request.idempotencyKey
      && (!previousResult.ok || pidAlive(observerPid(config.watchdogHome)))) {
      logLine(`request ${request.idempotencyKey} was already applied; returning its result`)
      return { ...previousResult, idempotent: true }
    }
    const artifact = verifyArtifact(request.target.artifactPath)
    if (artifact.version !== request.target.version) {
      throw new Error(`The artifact is version ${artifact.version}, not ${request.target.version}`)
    }
    if (request.target.sha256 && artifact.sha256 !== request.target.sha256) throw new Error('The artifact digest does not match the request')
    if (config.serviceVersion && !versionAtLeast(config.serviceVersion, artifact.minServiceVersion)) {
      throw new Error(`The service version ${config.serviceVersion} is older than the artifact requires (${artifact.minServiceVersion})`)
    }
    const current = readCurrent(config.watchdogHome)
    if (current === artifact.version) {
      const installed = verifyArtifact(join(config.watchdogHome, 'versions', current))
      if (installed.sha256 !== artifact.sha256 || installed.commit !== artifact.commit) {
        throw new Error(`The installed artifact ${current} does not match the candidate`)
      }
      if (pidAlive(observerPid(config.watchdogHome))) {
        return finish({ at: now().toISOString(), ok: true, phase: 'already-current', version: artifact.version,
          previousVersion: previousResult?.previousVersion ?? null, request, startedAt })
      }
      if (dependencies.lock !== false) writeFileSync(join(config.watchdogHome, 'update.lock', 'launch-version.txt'), artifact.version)
      const triggerAt = Date.now()
      let triggerEvidence
      try { triggerEvidence = trigger(config, artifact) } catch (error) {
        return finish({ at: now().toISOString(), ok: false, phase: 'start-failed', version: artifact.version,
          previousVersion: previousResult?.previousVersion ?? null, request, startedAt, manualIntervention: true,
          error: error instanceof Error ? error.message : String(error) })
      }
      try {
        const observer = await (dependencies.verifyObserverHeartbeat ?? verifyObserverHeartbeat)(config, triggerAt)
        return finish({ at: now().toISOString(), ok: true, phase: 'started', version: artifact.version,
          previousVersion: previousResult?.previousVersion ?? null, request, startedAt, trigger: triggerEvidence, heartbeat: 'local', observer })
      } catch (error) {
        return finish({ at: now().toISOString(), ok: false, phase: 'heartbeat-unverified', version: artifact.version,
          previousVersion: previousResult?.previousVersion ?? null, request, startedAt, trigger: triggerEvidence, manualIntervention: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    }
    logLine(`updating ${current ?? '(none)'} -> ${artifact.version}; staging ${request.target.artifactPath}`)
    const installed = installArtifact(config.watchdogHome, request.target.artifactPath, artifact)
    logLine(`artifact ${installed.installed ? 'installed' : 'reused'} at ${installed.destination}`)
    let stopped
    try {
      stopped = await stopObserver(config, current ?? '')
    } catch (error) {
      return finish({ at: now().toISOString(), ok: false, phase: 'failed', version: artifact.version,
        previousVersion: current ?? null, request, startedAt,
        error: `The old observer could not be stopped, so the switch was not attempted: ${error instanceof Error ? error.message : String(error)}` })
    }
    writePointer(config.watchdogHome, 'previous.txt', current ?? null)
    writePointer(config.watchdogHome, 'current.txt', artifact.version)
    if (dependencies.lock !== false) writeFileSync(join(config.watchdogHome, 'update.lock', 'launch-version.txt'), artifact.version)
    const triggerAt = Date.now()
    let triggerEvidence
    try {
      triggerEvidence = trigger(config, artifact)
    } catch (error) {
      return finish({ at: now().toISOString(), ok: false, phase: 'start-failed', version: artifact.version,
        previousVersion: current ?? null, request, startedAt, stop: stopped, manualIntervention: true,
        error: error instanceof Error ? error.message : String(error) })
    }
    let observer
    try {
      observer = await (dependencies.verifyObserverHeartbeat ?? verifyObserverHeartbeat)(config, triggerAt)
    } catch (error) {
      return finish({ at: now().toISOString(), ok: false, phase: 'heartbeat-unverified', version: artifact.version,
        previousVersion: current ?? null, request, startedAt, stop: stopped, trigger: triggerEvidence,
        manualIntervention: true, error: error instanceof Error ? error.message : String(error) })
    }
    const result = finish({ at: now().toISOString(), ok: true, phase: 'updated', version: artifact.version, commit: artifact.commit,
      previousVersion: current ?? null, request, startedAt, stop: stopped, trigger: triggerEvidence, heartbeat: 'local', observer })
    if (config.reportChat) {
      const note = `Watchdog 已更新到 ${artifact.version}${current ? `（上一版 ${current}）` : ''}；服务未重启；已确认本地心跳。`
      if (!(await report(config, note, `watchdog-update-${request.idempotencyKey}`))) logLine('the update report could not be sent')
    }
    return result
  } catch (error) {
    return finish({ at: now().toISOString(), ok: false, phase: 'failed', request,
      error: error instanceof Error ? error.message : String(error) })
  } finally {
    release()
  }
}

function parseArgv(argv) {
  const options = { config: '', request: '', validate: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--config') { options.config = argv[++index] ?? ''; continue }
    if (word.startsWith('--config=')) { options.config = word.slice(9); continue }
    if (word === '--request') { options.request = argv[++index] ?? ''; continue }
    if (word === '--validate') { options.validate = true; continue }
    if (word === '-h' || word === '--help') { options.help = true; continue }
    throw new Error(`unrecognized argument: ${word}`)
  }
  return options
}

const usage = 'Usage: watchdog-update --config <path> [--request <path>] [--validate]'

function validateLatestRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('The update request must be a JSON object')
  if (typeof request.confirmation !== 'string' || !request.confirmation.trim()) throw new Error('The update request has no operator confirmation')
  const idempotencyKey = request.idempotencyKey ?? randomUUID()
  if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) throw new Error('The update request needs a valid idempotencyKey')
  return { ...request, idempotencyKey }
}

export function claimLatestRequest(requestPath, archive) {
  const claimed = `${requestPath}.${randomUUID()}.claimed`
  try { renameSync(requestPath, claimed) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  let request
  try {
    request = validateLatestRequest(readJson(claimed, 'Watchdog update request'))
  } catch (error) {
    try {
      linkSync(claimed, requestPath)
      rmSync(claimed)
    } catch (restoreError) {
      throw new Error(`${error.message}; request retained at ${claimed}: ${restoreError.message}`)
    }
    throw error
  }
  renameSync(claimed, archive)
  return request
}

async function updateLatest(config, request) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const stagingRelative = relative(root, config.stagingRoot)
  if (!stagingRelative || (!stagingRelative.startsWith(`..${sep}`) && stagingRelative !== '..' && !isAbsolute(stagingRelative))) {
    throw new Error('Watchdog staging must be outside the runtime checkout')
  }
  mkdirSync(config.stagingRoot, { recursive: true })
  const temporary = mkdtempSync(join(config.stagingRoot, 'watchdog-latest-'))
  try {
    const { buildFromRepo, installLaunchers } = await import('./watchdog-control.mjs')
    const artifactPath = buildFromRepo(temporary, root)
    const manifest = verifyArtifact(artifactPath)
    installLaunchers(config.watchdogHome, artifactPath, root)
    return await update(config, { ...request, idempotencyKey: `${request.idempotencyKey}:${manifest.commit}`,
      target: { version: manifest.version, artifactPath, sha256: manifest.sha256 } })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgv(process.argv.slice(2))
    if (options.help) { process.stdout.write(`${usage}\n`); process.exitCode = 0 }
    else if (!options.config) { process.stderr.write(`${usage}\n`); process.exitCode = 2 }
    else {
      const config = loadConfig(options.config)
      if (options.validate) {
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
        process.exitCode = 0
      } else {
        const requestPath = options.request ? resolve(options.request) : config.requestPath
        const request = requestPath === config.requestPath
          ? claimLatestRequest(requestPath, join(dirname(config.requestPath), 'watchdog-update-request.last.json'))
          : validateLatestRequest(readJson(requestPath, 'Watchdog update request'))
        if (!request) {
          log(config, 'no Watchdog update request; nothing to do')
          process.exitCode = 0
        } else {
          updateLatest(config, request).then(result => { process.exitCode = result.ok ? 0 : 1 })
            .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
        }
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}