#!/usr/bin/env node
/**
 * Independent Watchdog update task.
 *
 * The task runs outside the superagent service. It validates an operator request and an immutable artifact, smokes the
 * artifact against a local mock (no production Feishu or credentials), installs it under `versions/<version>`, switches
 * the `current.txt` pointer atomically, triggers the Watchdog agent task and waits for a recorded run from the new
 * version. A failed smoke, trigger or heartbeat restores the previous pointer. It never restarts or reconfigures the
 * superagent service. A persistent observer is not started here: the scheduled Watchdog agent task owns that lifecycle.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyArtifact, versionAtLeast } from './watchdog-artifact.mjs'
import { smokeArtifact } from './watchdog-smoke.mjs'

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
  const triggerCommand = typeof value.triggerCommand === 'string' ? value.triggerCommand : ''
  const agentTask = typeof value.agentTask === 'string' ? value.agentTask : ''
  if (!triggerCommand && !agentTask) throw new Error('The update configuration needs triggerCommand or agentTask')
  return {
    watchdogHome,
    stagingRoot: value.stagingRoot ? resolve(String(value.stagingRoot)) : dirname(requestPath),
    requestPath,
    serviceUrl: serviceUrl.replace(/\/+$/, ''),
    triggerCommand,
    agentTask,
    serviceVersion: typeof value.serviceVersion === 'string' ? value.serviceVersion : '',
    reportChat: typeof value.reportChat === 'string' ? value.reportChat : '',
    logFile: required('logFile'),
    resultFile: required('resultFile'),
    heartbeatTimeoutSeconds: number('heartbeatTimeoutSeconds', 180),
    pollSeconds: number('pollSeconds', 5),
    smokeTimeoutSeconds: number('smokeTimeoutSeconds', 30),
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

function acquireLock(config) {
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

function runTrigger(config, manifest) {
  const command = config.triggerCommand || (config.agentTask ? `schtasks /run /tn ${config.agentTask}` : '')
  if (!command) throw new Error('The update configuration needs triggerCommand or agentTask')
  const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, DSH_WATCHDOG_VERSION: manifest.version, DSH_WATCHDOG_SERVICE_URL: config.serviceUrl } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`The Watchdog trigger failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`)
  return { command, at: new Date().toISOString() }
}

/** Ask the service for its newest recorded runs; an unavailable service is reported, not treated as a bad artifact. */
async function recordedRuns(config) {
  const url = new URL('/orchestrator/api/watchdog/runs?limit=20', `${config.serviceUrl}/`)
  const response = await fetch(url, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`The management API answered ${response.status}`)
  const value = await response.json()
  return Array.isArray(value.runs) ? value.runs : []
}

async function waitForHeartbeat(config, version, since) {
  const deadline = Date.now() + config.heartbeatTimeoutSeconds * 1000
  while (Date.now() < deadline) {
    const runs = await recordedRuns(config)
    const match = runs.find(run => run?.version === version && Number.isFinite(Date.parse(run.at)) && Date.parse(run.at) >= since)
    if (match) return match
    await new Promise(resolvePromise => setTimeout(resolvePromise, config.pollSeconds * 1000))
  }
  throw new Error(`No recorded run from Watchdog ${version} within ${config.heartbeatTimeoutSeconds}s`)
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
 * Apply one validated update request. Injectable smoke/trigger functions keep the switch and rollback testable without
 * touching a real scheduled task or the production service.
 */
export async function update(config, rawRequest, dependencies = {}) {
  const request = validateRequest(rawRequest, config)
  const logLine = message => log(config, message)
  const smoke = dependencies.smoke ?? smokeArtifact
  const trigger = dependencies.trigger ?? runTrigger
  const now = dependencies.now ?? (() => new Date())
  const release = dependencies.lock === false ? () => {} : acquireLock(config)
  const finish = (result) => {
    writeResult(config, result)
    logLine(`end ${result.ok ? 'ok' : 'failed'} ${result.phase} version=${result.version ?? '-'}`)
    return result
  }
  try {
    const startedAt = now().toISOString()
    const previousResult = (() => { try { return readJson(config.resultFile, 'update result') } catch { return undefined } })()
    if (previousResult?.request?.idempotencyKey === request.idempotencyKey) {
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
      return finish({ at: now().toISOString(), ok: true, phase: 'already-current', version: artifact.version,
        previousVersion: previousResult?.previousVersion ?? null, request, startedAt, smoke: 'skipped' })
    }
    logLine(`updating ${current ?? '(none)'} -> ${artifact.version}; staging ${request.target.artifactPath}`)
    const smokeEvidence = await smoke(request.target.artifactPath, { timeoutSeconds: config.smokeTimeoutSeconds, node: dependencies.node })
    logLine(`smoke passed version=${artifact.version}`)
    const installed = installArtifact(config.watchdogHome, request.target.artifactPath, artifact)
    logLine(`artifact ${installed.installed ? 'installed' : 'reused'} at ${installed.destination}`)
    writePointer(config.watchdogHome, 'previous.txt', current ?? null)
    writePointer(config.watchdogHome, 'current.txt', artifact.version)
    const triggerAt = Date.now()
    let triggerEvidence
    try {
      triggerEvidence = trigger(config, artifact)
    } catch (error) {
      writePointer(config.watchdogHome, 'current.txt', current ?? null)
      return finish({ at: now().toISOString(), ok: false, phase: 'rolled-back', version: artifact.version,
        previousVersion: current ?? null, request, startedAt, smoke: smokeEvidence, error: error instanceof Error ? error.message : String(error) })
    }
    let heartbeat = 'unverified'
    let reachable = true
    try { await recordedRuns(config) } catch { reachable = false }
    if (reachable) {
      try {
        await waitForHeartbeat(config, artifact.version, triggerAt)
        heartbeat = 'recorded'
      } catch (error) {
        writePointer(config.watchdogHome, 'current.txt', current ?? null)
        return finish({ at: now().toISOString(), ok: false, phase: 'rolled-back', version: artifact.version,
          previousVersion: current ?? null, request, startedAt, smoke: smokeEvidence, trigger: triggerEvidence,
          error: error instanceof Error ? error.message : String(error) })
      }
    } else {
      heartbeat = 'unreachable'
      logLine('the management API is unreachable; installed the artifact without a recorded-run proof')
    }
    const result = finish({ at: now().toISOString(), ok: true, phase: 'updated', version: artifact.version, commit: artifact.commit,
      previousVersion: current ?? null, request, startedAt, smoke: smokeEvidence, trigger: triggerEvidence, heartbeat })
    if (config.reportChat) {
      const note = `Watchdog 已更新到 ${artifact.version}${current ? `（上一版 ${current}）` : ''}；服务未重启；心跳 ${heartbeat === 'recorded' ? '已记录' : '未验证'}。`
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
        const requestPath = options.request || config.requestPath
        if (!existsSync(requestPath)) {
          log(config, 'no Watchdog update request; nothing to do')
          process.exitCode = 0
        } else {
          const request = readJson(requestPath, 'Watchdog update request')
          // An invalid request stays in place so the operator can correct it; only a validated task request is archived.
          validateRequest(request, config)
          const archive = join(dirname(config.requestPath), 'watchdog-update-request.last.json')
          if (requestPath === config.requestPath) {
            const temporary = `${config.requestPath}.${process.pid}.tmp`
            writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`)
            renameSync(temporary, archive)
          }
          update(config, request).then(result => { process.exitCode = result.ok ? 0 : 1 })
            .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
        }
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}