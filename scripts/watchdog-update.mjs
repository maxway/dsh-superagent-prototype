#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = /^[A-Za-z0-9._-]+$/
const KEY = /^[A-Za-z0-9._:-]+$/

function disabled() {
  throw new Error('Watchdog updates and deployment are temporarily disabled for safety')
}

export function writePointer() { return disabled() }
export function installArtifact() { return disabled() }
export function acquireLock() { return disabled() }
export function claimLatestRequest() { return disabled() }
export async function update() { return disabled() }

export function readJson(path, what) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) { throw new Error(`Cannot read the ${what} at ${path}: ${error.message}`) }
  try { return JSON.parse(text) } catch (error) { throw new Error(`The ${what} at ${path} is not JSON: ${error.message}`) }
}

export function observerStateDir(home) {
  const path = join(home, 'observer.json')
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return join(home, 'observer-state')
    throw new Error(`Cannot read the observer configuration at ${path}: ${error.message}`)
  }
  let value
  try { value = JSON.parse(text) } catch (error) { throw new Error(`The observer configuration at ${path} is not JSON: ${error.message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The observer configuration must be a JSON object')
  return resolve(home, String(value.stateDir ?? '.watchdog'))
}

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
  if (!observerStopCommand || !observerStartCommand) throw new Error('The update configuration needs observerStopCommand and observerStartCommand')
  return { watchdogHome, stagingRoot: value.stagingRoot ? resolve(String(value.stagingRoot)) : dirname(requestPath), requestPath,
    serviceUrl: serviceUrl.replace(/\/+$/, ''), observerStopCommand, observerStartCommand,
    serviceVersion: typeof value.serviceVersion === 'string' ? value.serviceVersion : '',
    reportChat: typeof value.reportChat === 'string' ? value.reportChat : '', logFile: required('logFile'),
    resultFile: required('resultFile'), heartbeatTimeoutSeconds: number('heartbeatTimeoutSeconds', 180),
    pollSeconds: number('pollSeconds', 5), lockStaleSeconds: number('lockStaleSeconds', 900) }
}

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
  const normalized = process.platform === 'win32' ? path => path.toLowerCase() : path => path
  if (!normalized(artifactPath).startsWith(normalized(root) + sep)) throw new Error(`The artifact path is outside the staging root: ${artifactPath}`)
  return { ...request, target: { ...target, artifactPath } }
}

export function readCurrent(home) {
  try {
    const value = readFileSync(join(home, 'current.txt'), 'utf8').trim()
    return VERSION.test(value) ? value : undefined
  } catch { return undefined }
}

export async function verifyObserverHeartbeat(config, since) {
  const heartbeatPath = join(observerStateDir(config.watchdogHome), 'heartbeat.json')
  const deadline = Date.now() + config.heartbeatTimeoutSeconds * 1000
  while (Date.now() < deadline) {
    try {
      const value = readJson(heartbeatPath, 'observer heartbeat')
      const at = Date.parse(value.at)
      if (Number.isInteger(value.pid) && value.pid > 0 && at >= since && at <= Date.now() + 5000) {
        process.kill(value.pid, 0)
        return { pid: value.pid, lastHeartbeat: new Date(at).toISOString() }
      }
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
  }
  throw new Error('No fresh live observer heartbeat after the start request')
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

const usage = 'Usage: watchdog-update --config <path> [--request <path>] [--validate] (updates disabled)'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgv(process.argv.slice(2))
    if (options.help) { process.stdout.write(`${usage}\n`); process.exitCode = 0 }
    else if (!options.config) { process.stderr.write(`${usage}\n`); process.exitCode = 2 }
    else if (!options.validate) disabled()
    else { process.stdout.write(`${JSON.stringify(loadConfig(options.config), null, 2)}\n`) }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
