#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    throw new Error(`Cannot read JSON ${path}: ${error.message}`)
  }
}

export function loadConfig(path) {
  const value = readJson(path)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Deployment configuration must be an object')
  const requiredPath = name => {
    if (typeof value[name] !== 'string' || !value[name].trim()) throw new Error(`${name} is required`)
    return resolve(value[name])
  }
  const serviceHome = value.serviceHome || value.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  const serviceConfig = value.serviceConfig ? resolve(value.serviceConfig) : join(resolve(serviceHome), 'service.json')
  if (value.serviceConfig && !existsSync(serviceConfig)) throw new Error(`service_config_missing: ${serviceConfig}`)
  const base = existsSync(serviceConfig) ? readJson(serviceConfig) : {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('Service configuration must be an object')
  const allowed = ['checkout', 'home', 'agentsHome', 'profile', 'url', 'node', 'timeout', 'stopTimeout', 'survivalSeconds', 'path', 'deployRequest', 'deployCommand']
  const service = Object.fromEntries(allowed.filter(name => base[name] !== undefined).map(name => [name, base[name]]))
  const checkout = resolve(value.checkout || service.checkout || ROOT)
  service.checkout = checkout
  service.home = resolve(value.serviceHome || service.home || serviceHome)
  if (value.serviceAgentsHome) service.agentsHome = resolve(value.serviceAgentsHome)
  service.profile = String(value.serviceProfile || service.profile || 'superagent')
  service.url = String(value.url || service.url || 'http://127.0.0.1:3083')
  service.node = String(value.node || service.node || process.execPath)
  return {
    checkout,
    requestPath: requiredPath('requestPath'),
    resultFile: requiredPath('resultFile'),
    logFile: value.logFile ? resolve(value.logFile) : undefined,
    restartScript: value.restartScript ? resolve(value.restartScript) : join(checkout, 'scripts', 'restart-superagent.ps1'),
    serviceScript: join(checkout, 'scripts', 'dsh-superagent.ps1'),
    service,
  }
}

function parseArguments(argv) {
  const options = { config: process.env.DSH_SUPERAGENT_DEPLOY_CONFIG, confirmation: '', validate: false, plan: false }
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--config') options.config = argv[++index]
    else if (word.startsWith('--config=')) options.config = word.slice(9)
    else if (word === '--confirmation') options.confirmation = argv[++index] ?? ''
    else if (word.startsWith('--confirmation=')) options.confirmation = word.slice(15)
    else if (word === '--validate') options.validate = true
    else if (word === '--plan') options.plan = true
    else if (word === '--agent') throw new Error('agent_disabled: model-driven deployment is disabled')
    else throw new Error(`invalid_arguments: ${word}`)
  }
  if (!options.config) throw new Error('No deployment configuration: pass --config or set DSH_SUPERAGENT_DEPLOY_CONFIG')
  return options
}

function requestFor(config, confirmation) {
  if (existsSync(config.requestPath)) {
    const text = readFileSync(config.requestPath, 'utf8')
    let request
    try { request = JSON.parse(text) } catch (error) { throw new Error(`Cannot read JSON ${config.requestPath}: ${error.message}`) }
    if (!request || typeof request.confirmation !== 'string' || !request.confirmation.trim()) throw new Error('request_unconfirmed: operator confirmation is required')
    return { request, text }
  }
  if (confirmation.trim()) return { request: { at: new Date().toISOString(), requestedBy: 'operator', confirmation, target: 'latest' } }
  return null
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const config = loadConfig(options.config)
  if (options.validate) {
    process.stdout.write(JSON.stringify({ mode: 'mechanical', checkout: config.checkout, restartScript: config.restartScript, serviceScript: config.serviceScript }, null, 2) + '\n')
    return 0
  }
  let selected = requestFor(config, options.confirmation)
  if (!selected) {
    process.stdout.write('No deploy request; nothing to do.\n')
    return 0
  }
  const target = String(selected.request.target ?? 'latest').trim()
  if (target && target !== 'latest') throw new Error('invalid_target: normal deployment only supports latest')
  if (!existsSync(config.restartScript)) throw new Error(`restart_missing: ${config.restartScript}`)
  if (!existsSync(config.serviceScript)) throw new Error(`service_script_missing: ${config.serviceScript}`)
  if (options.plan) {
    process.stdout.write(JSON.stringify({ ok: true, planOnly: true, target: 'latest', checkout: config.checkout, restartScript: config.restartScript }, null, 2) + '\n')
    return 0
  }
  mkdirSync(dirname(config.resultFile), { recursive: true })
  const lockPath = `${config.resultFile}.lock`
  let lock
  try { lock = openSync(lockPath, 'wx') } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`deploy_locked: ${lockPath}`)
    throw error
  }
  let temporary
  try {
    selected = requestFor(config, selected.text === undefined ? options.confirmation : '')
    if (!selected) {
      process.stdout.write('No deploy request; nothing to do.\n')
      return 0
    }
    const expectedRequest = process.env.DSH_WATCHDOG_REQUEST_SHA256
    if (expectedRequest && (selected.text === undefined || createHash('sha256').update(selected.text).digest('hex') !== expectedRequest)) {
      process.stdout.write('Deploy request changed; nothing to do.\n')
      return 0
    }
    const lockedTarget = String(selected.request.target ?? 'latest').trim()
    if (lockedTarget && lockedTarget !== 'latest') throw new Error('invalid_target: normal deployment only supports latest')
    const requestDigest = selected.text === undefined ? undefined : createHash('sha256').update(selected.text).digest('hex')
    if (requestDigest && existsSync(config.resultFile)) {
      try {
        const previous = readJson(config.resultFile)
        if (previous.requestDigest === requestDigest && (previous.ok || expectedRequest)) {
          process.stdout.write(previous.ok ? 'Deploy request already completed; nothing to do.\n' : 'Deploy request already failed; nothing to do.\n')
          return previous.ok ? 0 : 1
        }
      } catch {}
    }
    temporary = mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
    const serviceConfig = join(temporary, 'service.json')
    writeFileSync(serviceConfig, JSON.stringify(config.service))
    const execution = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', config.restartScript,
      '-Config', serviceConfig, '-ServiceScript', config.serviceScript], { cwd: config.checkout, encoding: 'utf8', windowsHide: true, timeout: 1_800_000 })
    const stdout = execution.stdout ?? ''
    const stderr = execution.stderr ?? ''
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    if (config.logFile) {
      try {
        mkdirSync(dirname(config.logFile), { recursive: true })
        appendFileSync(config.logFile, stdout + stderr)
      } catch {}
    }
    const ok = execution.status === 0
    const result = { at: new Date().toISOString(), ok, phase: ok ? 'completed' : 'restart_failed', mode: 'mechanical',
      request: selected.request, ...(requestDigest ? { requestDigest } : {}), checkout: config.checkout, exitCode: execution.status,
      ...(execution.error ? { error: execution.error.message } : {}), stdout, stderr }
    writeFileSync(config.resultFile, JSON.stringify(result, null, 2) + '\n')
    if (ok && selected.text !== undefined) {
      writeFileSync(join(dirname(config.requestPath), 'deploy-request.last.json'), selected.text)
    }
    return ok ? 0 : 1
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]) } catch { return '' } })() : ''
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
