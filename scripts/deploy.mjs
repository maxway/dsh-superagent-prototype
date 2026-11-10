#!/usr/bin/env node
/**
 * Independent deployment executor for one local superagent instance.
 *
 * A scheduled task runs `deploy.ps1`, which calls this file outside the production service and outside every DSH tool
 * command. A routine release is mechanical: read the operator's request, prove the service identity and idleness, stop
 * the service, copy a pre-built candidate over an explicit manifest, start the service, verify it survived, and roll
 * back the runtime files when the new build does not become usable. No model is called on that path; the headless DSH
 * agent remains an explicit fallback for the first deployment or a request the operator decides needs judgement.
 *
 * The preflight is deliberately small. It keeps the checks a switch actually needs — one running process, a ready
 * runtime, no setup problem, no running work, a candidate at the requested revision, an explicit file manifest, a
 * consistent stopped-database backup and a rollback copy of every replaced file. It does not repeat repository tests,
 * inspect unrelated health parts, enforce ACLs or hashes the whole checkout: CI owns code quality and the operator owns
 * the maintenance window. See docs/006-deployment.md.
 *
 * `--plan` prints the same preflight without changing anything (it does resolve the remote latest commit). Exit codes:
 * 0 requested work completed (or nothing to do), 1 the deployment did not finish usable.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WINDOWS = process.platform === 'win32'
const DATABASE = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i
/** Paths a routine release must never overwrite; state, dependencies and the deployment machinery live outside it. */
const FORBIDDEN_TARGETS = new Set(['.git', 'node_modules', '.artifacts', 'work', 'home', 'profiles', 'secrets', 'state', 'config', 'configs', 'settings', '.env', 'logs', 'log'])

class DeployError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'DeployError'
    this.code = code
    this.detail = detail
  }
}

const fail = (code, detail) => { throw new DeployError(code, detail) }

/** Hash a file in fixed-size blocks so a large state database does not have to fit in memory. */
function sha256(path) {
  const hash = createHash('sha256')
  const handle = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let read
    while ((read = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(handle)
  }
  return hash.digest('hex')
}

/** A filesystem-safe timestamp for backup directory names, including milliseconds so two runs cannot share one. */
function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace('.', '')
}

/** Compare two absolute paths using the host's case rules. */
function samePath(left, right) {
  const normalize = value => WINDOWS ? value.toLowerCase() : value
  return normalize(resolve(left)) === normalize(resolve(right))
}

/** Whether `child` is `parent` or below it, using the host's case rules. */
function inside(child, parent) {
  const value = WINDOWS ? resolve(child).toLowerCase() : resolve(child)
  const root = WINDOWS ? resolve(parent).toLowerCase() : resolve(parent)
  return value === root || value.startsWith(root.endsWith('\\') || root.endsWith('/') ? root : root + (WINDOWS ? '\\' : '/'))
}

/** Reject a manifest path that is absolute, traverses or uses a Windows separator or drive. */
function relativeSegments(value, what) {
  if (typeof value !== 'string' || value.length === 0) fail('invalid_manifest', `${what} must be a non-empty string`)
  if (value.includes('\\') || value.includes(':') || value.startsWith('/')) {
    fail('invalid_manifest', `${what} must be a relative POSIX-style path: ${value}`)
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    fail('invalid_manifest', `${what} must not contain empty, '.' or '..' segments: ${value}`)
  }
  return parts
}

function readJson(path, code) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    fail(code, `${path} is unreadable: ${error.message}`)
  }
  try { return JSON.parse(text) } catch (error) {
    fail(code, `${path} is not JSON: ${error.message}`)
  }
}

function writeJson(path, value) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function appendLog(config, text) {
  if (!config.logFile) return
  try {
    mkdirSync(dirname(config.logFile), { recursive: true })
    appendFileSync(config.logFile, text)
  } catch { /* The log is best effort; the result file still records the outcome. */ }
}

function log(config, message) {
  const line = `[${new Date().toISOString()}] ${message}`
  process.stdout.write(line + '\n')
  appendLog(config, line + '\n')
}

/** Write a child process's output to the log without hiding it from the task console. */
function relay(config, text) {
  if (!text) return
  process.stdout.write(text)
  appendLog(config, text)
}

const run = (config, command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd && existsSync(options.cwd) ? options.cwd : config.checkout,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    env: options.env ?? process.env,
    windowsHide: true,
  })
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

/** Run one command from the deployment configuration through the platform shell. */
function shell(config, command, options = {}) {
  if (!command) return { code: 0, stdout: '', stderr: '' }
  const [file, args] = WINDOWS
    ? ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]]
    : ['sh', ['-c', command]]
  const result = run(config, file, args, { timeout: options.timeout ?? 60_000 })
  relay(config, result.stdout)
  relay(config, result.stderr)
  return result
}

function git(config, args, cwd = config.checkout, timeout = 60_000) {
  const result = run(config, 'git', ['-C', cwd, ...args], { timeout })
  return result.code === 0 ? result.stdout.trim() : undefined
}

function controlArguments(config) {
  return ['--profile', config.serviceProfile, '--url', config.url, '--home', config.serviceHome]
}

/** The service's own environment: the deployment agent's DSH home is a different profile home. */
function serviceEnvironment(config) {
  const environment = { ...process.env, DSH_HOME: config.serviceHome }
  if (config.serviceAgentsHome) environment.DSH_AGENTS_HOME = config.serviceAgentsHome
  return environment
}

function control(config, command, args = [], timeout = 120_000) {
  const result = run(config, config.node, [config.control, command, ...controlArguments(config), ...args],
    { timeout, cwd: config.workdir ?? config.checkout, env: serviceEnvironment(config) })
  return result
}

function readStatus(config) {
  const result = control(config, 'status', [], 30_000)
  let value
  try { value = JSON.parse(result.stdout) } catch {
    fail('status_unreadable', result.error?.message ?? (result.stderr.trim() || result.stdout.trim().slice(0, 300) || 'no output'))
  }
  return value
}

function state(config) {
  return new Promise(resolvePromise => {
    let target
    try { target = new URL(config.url + '/orchestrator/api/state') } catch { resolvePromise(null); return }
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'GET',
      headers: { 'x-orchestrator-request': '1' },
      timeout: 3_000,
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try { resolvePromise(JSON.parse(body)) } catch { resolvePromise(null) }
      })
      response.on('error', () => resolvePromise(null))
    })
    request.on('timeout', () => { request.destroy(); resolvePromise(null) })
    request.on('error', () => resolvePromise(null))
    request.end()
  })
}

/** The checks a routine switch actually needs; unrelated part errors and Feishu setup do not block a release. */
function serviceBlocks(status, runtimeRoot) {
  const reasons = []
  if (!Array.isArray(status?.pids) || status.pids.length !== 1) {
    reasons.push(`expected exactly one running process, found ${Array.isArray(status?.pids) ? status.pids.length : 'unknown'}`)
  }
  if (status?.health?.runtime !== 'ready') reasons.push(`runtime health is ${status?.health?.runtime ?? 'unknown'}, not ready`)
  if (status?.setup) reasons.push(`setup is not complete: ${status.setup}`)
  if (status?.manually_stopped === true) reasons.push('the service is manually stopped')
  const bundle = status?.deployment?.bundleTarget
  if (!bundle) reasons.push('the running bundle link could not be resolved')
  else if (!inside(bundle, runtimeRoot)) reasons.push(`the running bundle points at ${bundle}, outside the runtime root ${runtimeRoot}`)
  return reasons
}

function readManifest(config) {
  const data = readJson(config.manifestPath, 'manifest_unreadable')
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries) || data.entries.length === 0) {
    fail('invalid_manifest', 'the manifest must contain a non-empty "entries" array')
  }
  const targets = []
  const entries = data.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => key !== 'source' && key !== 'target')) {
      fail('invalid_manifest', `entry ${index} must contain exactly source and target`)
    }
    const sourceParts = relativeSegments(entry.source, `entry ${index} source`)
    const targetParts = relativeSegments(entry.target, `entry ${index} target`)
    if (targetParts.some(part => part.toLowerCase() === '.git' || part.toLowerCase() === 'node_modules')
      || sourceParts.some(part => part.toLowerCase() === '.git' || part.toLowerCase() === 'node_modules')) {
      fail('invalid_manifest', `entry ${index} targets or copies .git/node_modules: ${entry.source} -> ${entry.target}`)
    }
    if (FORBIDDEN_TARGETS.has(targetParts[0].toLowerCase())) {
      fail('invalid_manifest', `entry ${index} targets a protected path: ${entry.target}`)
    }
    const source = resolve(config.candidateRoot, ...sourceParts)
    const target = resolve(config.runtimeRoot, ...targetParts)
    if (!inside(source, config.candidateRoot)) fail('invalid_manifest', `entry ${index} source escapes the candidate root`)
    if (!inside(target, config.runtimeRoot)) fail('invalid_manifest', `entry ${index} target escapes the runtime root`)
    if (!existsSync(source)) fail('invalid_manifest', `entry ${index} source does not exist: ${source}`)
    if (lstatSync(source).isSymbolicLink()) fail('invalid_manifest', `entry ${index} source is a symbolic link: ${source}`)
    for (const existing of targets) {
      if (inside(target, existing) || inside(existing, target)) {
        fail('invalid_manifest', `entry ${index} target overlaps another entry: ${entry.target}`)
      }
    }
    targets.push(target)
    const sourceStat = statSync(source)
    const targetParent = dirname(target)
    if (!existsSync(targetParent)) fail('invalid_manifest', `entry ${index} target parent does not exist: ${targetParent}`)
    return {
      source, target, kind: sourceStat.isDirectory() ? 'dir' : 'file', existed: existsSync(target),
    }
  })
  if (!entries.some(entry => entry.target === resolve(config.runtimeRoot, 'lib') && entry.kind === 'dir')) {
    fail('invalid_manifest', 'the manifest must replace the built "lib" directory')
  }
  return entries
}

function listDatabases(config, status) {
  const stateDir = config.stateDir ?? status?.deployment?.stateDir
  if (!stateDir) fail('state_dir_unknown', 'the deployment configuration or status must name the state directory')
  config.stateDir = resolve(stateDir)
  if (!existsSync(config.stateDir)) fail('state_dir_unknown', `the state directory does not exist: ${config.stateDir}`)
  const databases = readdirSync(config.stateDir)
    .filter(name => DATABASE.test(name))
    .map(name => join(config.stateDir, name))
    .filter(path => statSync(path).isFile())
  if (databases.length === 0) fail('state_database_missing', `no SQLite database found in ${config.stateDir}`)
  return databases
}

function resolveRevision(config, request) {
  const target = String(request.target ?? 'latest').trim()
  if (/^[0-9a-f]{40}$/i.test(target)) return target.toLowerCase()
  if (target !== '' && target !== 'latest') fail('invalid_target', `the request target must be "latest" or a full commit: ${target}`)
  if (config.targetRevision) {
    if (!/^[0-9a-f]{40}$/i.test(config.targetRevision)) fail('invalid_target', 'mechanical.targetRevision must be a full commit')
    return config.targetRevision.toLowerCase()
  }
  if (config.fetch !== false) {
    const fetched = git(config, ['fetch', '--quiet', '--no-tags', 'origin', 'main'])
    if (fetched === undefined) fail('fetch_failed', 'could not fetch origin/main; refusing to deploy an unverified latest commit')
  }
  const revision = git(config, ['rev-parse', 'origin/main'])
  if (!revision || !/^[0-9a-f]{40}$/i.test(revision)) fail('target_unknown', 'could not resolve origin/main')
  return revision.toLowerCase()
}

function inspectCandidate(config, revision) {
  if (!existsSync(config.candidateRoot)) fail('candidate_missing', `the candidate checkout does not exist: ${config.candidateRoot}`)
  const root = git(config, ['rev-parse', '--show-toplevel'], config.candidateRoot)
  if (!root || !samePath(root, config.candidateRoot)) fail('candidate_invalid', 'the candidate root is not a Git worktree root')
  const head = git(config, ['rev-parse', 'HEAD'], config.candidateRoot)
  if (!head || head.toLowerCase() !== revision) {
    fail('candidate_revision', `the candidate is at ${head ?? 'an unknown commit'}, not ${revision}`)
  }
  const dirty = git(config, ['status', '--porcelain', '--untracked-files=all'], config.candidateRoot)
  if (dirty === undefined) fail('candidate_invalid', 'could not read the candidate worktree status')
  if (dirty !== '') fail('candidate_dirty', `the candidate worktree has uncommitted files:\n${dirty.slice(0, 1_000)}`)
  return { root: resolve(config.candidateRoot), revision }
}

/** Build the read-only deployment plan; `deploy --plan` prints it and apply uses the same facts. */
export async function inspect(config, request) {
  if (!config.candidateRoot || !config.manifestPath || !config.backupRoot) {
    fail('mechanical_config', 'mechanical.candidateRoot, mechanical.manifestPath and mechanical.backupRoot are required')
  }
  for (const [name, path] of [['candidateRoot', config.candidateRoot], ['runtimeRoot', config.runtimeRoot], ['backupRoot', config.backupRoot]]) {
    if (!path) fail('mechanical_config', `mechanical.${name} is required`)
  }
  if (!existsSync(config.control)) fail('control_missing', `the control script does not exist: ${config.control}`)
  if (config.serviceScript && !existsSync(config.serviceScript)) {
    fail('service_script_missing', `the configured service wrapper does not exist: ${config.serviceScript}`)
  }
  if (!existsSync(config.runtimeRoot)) fail('runtime_missing', `the runtime root does not exist: ${config.runtimeRoot}`)
  if (samePath(config.candidateRoot, config.runtimeRoot) || inside(config.runtimeRoot, config.candidateRoot) || inside(config.candidateRoot, config.runtimeRoot)) {
    fail('overlapping_roots', 'the candidate and runtime roots must be separate, non-overlapping directories')
  }
  if (inside(config.candidateRoot, config.backupRoot) || inside(config.backupRoot, config.candidateRoot)) {
    fail('overlapping_roots', 'the candidate and backup roots must be separate, non-overlapping directories')
  }
  if (!existsSync(config.backupRoot)) fail('backup_root_missing', `the backup root does not exist: ${config.backupRoot}`)
  if (inside(config.backupRoot, config.runtimeRoot)) fail('backup_root_inside_runtime', 'the backup root must be outside the runtime root')

  const status = readStatus(config)
  const reasons = serviceBlocks(status, config.runtimeRoot)
  if (reasons.length) fail('service_not_ready', reasons.join('; '))
  if (status.manually_stopped === true) fail('service_not_ready', 'the service is manually stopped')

  const current = await state(config)
  if (!current || typeof current.load?.running !== 'number') fail('state_unavailable', `no usable /orchestrator/api/state answer at ${config.url}`)
  if (current.load.running !== 0) fail('service_busy', `the service is running ${current.load.running} assignments; wait for them to finish`)

  const revision = resolveRevision(config, request)
  const candidate = inspectCandidate(config, revision)
  const entries = readManifest(config)
  const databases = listDatabases(config, status)
  // The mechanical path swaps runtime files, not node_modules: a changed lockfile needs the agent fallback or a
  // deliberate dependency install before the switch. Refuse it before stopping anything.
  const candidateLock = join(config.candidateRoot, 'pnpm-lock.yaml')
  const runtimeLock = join(config.runtimeRoot, 'pnpm-lock.yaml')
  if (!existsSync(candidateLock) || !existsSync(runtimeLock) || sha256(candidateLock) !== sha256(runtimeLock)) {
    fail('dependency_change', 'the candidate lockfile differs from the runtime checkout; use the agent fallback or install the dependencies first')
  }
  if (inside(config.stateDir, config.backupRoot) || inside(config.backupRoot, config.stateDir)) {
    fail('overlapping_state', 'the state directory and backup root must not overlap')
  }
  const backupDirectory = join(config.backupRoot, `deploy-${revision.slice(0, 12)}-${stamp()}`)
  return {
    mode: 'mechanical',
    at: new Date().toISOString(),
    request: { at: request.at, requestedBy: request.requestedBy, target: request.target ?? 'latest', confirmation: request.confirmation },
    revision,
    candidate,
    entries,
    databases,
    backupDirectory,
    survivalSeconds: config.survivalSeconds,
    service: {
      pids: status.pids,
      start: status.start,
      inJob: status.inJob,
      foreignJob: status.foreignJob,
      bundleTarget: status.deployment?.bundleTarget,
      checkoutHead: status.deployment?.git?.head,
    },
    workload: { running: current.load.running, queued: current.load.queued },
  }
}

function planView(plan) {
  return {
    ok: true,
    mode: 'mechanical',
    planOnly: true,
    at: plan.at,
    request: { at: plan.request.at, requestedBy: plan.request.requestedBy, target: plan.request.target, confirmation: plan.request.confirmation },
    revision: plan.revision,
    shortRevision: plan.revision.slice(0, 12),
    candidateRoot: plan.candidate.root,
    entries: plan.entries.map(entry => ({ source: entry.source, target: entry.target, kind: entry.kind, existed: entry.existed })),
    databases: plan.databases.map(path => ({ path, bytes: statSync(path).size })),
    backupDirectory: plan.backupDirectory,
    survivalSeconds: plan.survivalSeconds,
    service: plan.service,
    workload: plan.workload,
    actions: [
      'stop the independent observer when configured',
      'stop the service gracefully and confirm its process exited',
      'back up the stopped SQLite state',
      `switch ${plan.entries.length} runtime path(s), keeping the previous copy of each`,
      'start the service outside every foreign Windows Job',
      `verify one process, a usable management API and survival for ${plan.survivalSeconds}s`,
      'roll the runtime files back and restart the previous build when verification fails',
    ],
  }
}

function validateView(config) {
  return {
    config: config.path,
    mode: config.mechanical ? 'mechanical' : 'agent',
    checkout: config.checkout,
    node: config.node,
    home: config.home,
    serviceHome: config.serviceHome,
    serviceAgentsHome: config.serviceAgentsHome,
    serviceScript: config.serviceScript,
    serviceProfile: config.serviceProfile,
    agentProfile: config.agentProfile,
    url: config.url,
    requestPath: config.requestPath,
    logFile: config.logFile,
    resultFile: config.resultFile,
    promptPath: config.promptPath,
    modelPatch: config.modelPatch,
    workdir: config.workdir,
    survivalSeconds: config.survivalSeconds,
    control: config.control,
    runtimeRoot: config.runtimeRoot,
    candidateRoot: config.candidateRoot,
    manifestPath: config.manifestPath,
    backupRoot: config.backupRoot,
    stateDir: config.stateDir,
    targetRevision: config.targetRevision,
  }
}

/** One exclusive executor lock; a stale lock from an interrupted run is removed after the configured window. */
function acquireLock(config) {
  mkdirSync(config.backupRoot, { recursive: true })
  const lockPath = join(config.backupRoot, 'deploy.lock')
  const create = () => {
    try {
      writeFileSync(lockPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, request: config.requestPath }) + '\n', { flag: 'wx' })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      return false
    }
  }
  if (!create()) {
    let age = Infinity
    try { age = Date.now() - statSync(lockPath).mtimeMs } catch { age = Infinity }
    if (age <= config.staleLockMinutes * 60_000) {
      fail('deploy_locked', `another deployment holds ${lockPath}; remove it only after confirming no deployment is running`)
    }
    log(config, `removing a stale deployment lock (${Math.round(age / 60_000)} minutes old)`)
    rmSync(lockPath, { force: true })
    if (!create()) fail('deploy_locked', `could not acquire ${lockPath}`)
  }
  return {
    path: lockPath,
    release() {
      try { rmSync(lockPath, { force: true }) } catch { /* The result file still records the run. */ }
    },
  }
}

function copyPath(source, target) {
  const sourceStat = statSync(source)
  if (sourceStat.isDirectory()) cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
  else copyFileSync(source, target)
}

/** Hash a tree by relative name and content so a copied runtime path can be compared with its source. */
function treeDigest(path) {
  const digest = createHash('sha256')
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) fail('copy_mismatch', `the runtime tree contains a symbolic link: ${absolute}`)
      if (info.isDirectory()) {
        digest.update(`d:${relative}/\n`)
        walk(absolute, relative)
      } else {
        digest.update(`f:${relative}:${sha256(absolute)}\n`)
      }
    }
  }
  walk(path, '')
  return digest.digest('hex')
}

function pathMatches(source, target, kind) {
  return kind === 'dir' ? treeDigest(source) === treeDigest(target) : sha256(source) === sha256(target)
}

function applyEntries(config, plan, journal) {
  const token = `${plan.revision.slice(0, 12)}-${Date.now().toString(36)}`
  for (const entry of plan.entries) {
    const previous = join(dirname(entry.target), `${basename(entry.target)}.previous-${token}`)
    // Journal the attempt before touching the target: a crash or copy failure must still leave a restore record.
    const record = { target: entry.target, source: entry.source, previous: entry.existed ? previous : null,
      existed: entry.existed, moved: false, copied: false }
    journal.entries.push(record)
    writeJson(journal.path, journal)
    if (entry.existed) {
      if (existsSync(previous)) fail('previous_exists', `refusing to overwrite ${previous}`)
      renameSync(entry.target, previous)
      record.moved = true
      writeJson(journal.path, journal)
    }
    copyPath(entry.source, entry.target)
    if (!pathMatches(entry.source, entry.target, entry.kind)) fail('copy_mismatch', `the copied path does not match its source: ${entry.target}`)
    record.copied = true
    writeJson(journal.path, journal)
  }
}

/** Put every replaced or newly created runtime path back; report whether all of them were restored. */
function restoreEntries(config, journal) {
  let restored = true
  for (const record of [...journal.entries].reverse()) {
    try {
      if (!record.moved && !record.copied) continue
      if (existsSync(record.target)) rmSync(record.target, { recursive: true, force: true })
      if (record.moved && record.previous && existsSync(record.previous)) renameSync(record.previous, record.target)
      else if (record.moved) {
        restored = false
        log(config, `the previous copy is missing: ${record.previous}`)
      }
    } catch (error) {
      restored = false
      log(config, `could not restore ${record.target}: ${error.message}`)
    }
  }
  return restored
}

/** Start or stop through the operator's service wrapper when configured, otherwise through the control script. */
function serviceAction(config, action, timeout) {
  if (config.serviceScript) {
    return run(config, 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', config.serviceScript, action],
      { timeout, cwd: config.checkout, env: serviceEnvironment(config) })
  }
  return control(config, action, [], timeout)
}

function stopService(config) {
  const result = serviceAction(config, 'stop', 330_000)
  relay(config, result.stdout)
  relay(config, result.stderr)
  if (result.code !== 0) fail('stop_failed', result.stderr.trim() || result.stdout.trim().slice(0, 500) || `stop exited ${result.code}`)
  return result
}

function startService(config) {
  const result = serviceAction(config, 'start', 180_000)
  relay(config, result.stdout)
  relay(config, result.stderr)
  // `start` returns 2 when the service is up but a non-runtime part (for example `evals`) reports an error. That is
  // not a failed start: the deployment continues and `verify` decides whether the service is usable. Code 3 means setup
  // is still pending and code 1 means the service or its runtime did not come up.
  if (result.code === 1 || result.code === 3) {
    fail('start_failed', result.stderr.trim() || result.stdout.trim().slice(0, 500) || `start exited ${result.code}`)
  }
  if (result.code === 2) log(config, 'the service started, but a non-runtime part reports an error; continuing to verification')
  return result
}

function verifyService(config, survivalSeconds) {
  const result = control(config, 'verify', ['--survival-seconds', String(survivalSeconds)], (survivalSeconds + 90) * 1_000)
  relay(config, result.stdout)
  relay(config, result.stderr)
  if (result.code !== 0) fail('verify_failed', result.stderr.trim() || result.stdout.trim().slice(0, 500) || `verify exited ${result.code}`)
  return result
}

function backupState(config, plan) {
  mkdirSync(join(plan.backupDirectory, 'state'), { recursive: true })
  const copies = []
  // A clean service stop lets SQLite checkpoint -wal and remove -shm, so list the remaining files after the stop.
  const databases = listDatabases(config, { deployment: { stateDir: config.stateDir } })
  for (const database of databases) {
    const destination = join(plan.backupDirectory, 'state', basename(database))
    const expected = sha256(database)
    copyFileSync(database, destination)
    const actual = sha256(destination)
    if (expected !== actual) fail('backup_mismatch', `the state backup does not match its source: ${database}`)
    copies.push({ path: database, copy: destination, sha256: expected, bytes: statSync(database).size })
  }
  writeJson(join(plan.backupDirectory, 'state.json'), { at: new Date().toISOString(), revision: plan.revision, copies })
  return copies
}

function report(config, note) {
  if (!config.reportChat) return { sent: false, reason: 'reportChat is not configured' }
  const result = control(config, 'watchdog', ['report', '--chat', config.reportChat, '--note', note.slice(0, 500)], 30_000)
  relay(config, result.stdout)
  relay(config, result.stderr)
  return result.code === 0 ? { sent: true } : { sent: false, code: result.code, error: (result.stderr || result.stdout).trim().slice(0, 500) }
}

function observer(config, action) {
  const command = action === 'stop' ? config.observerStopCommand : config.observerStartCommand
  if (!command) return { configured: false }
  const result = shell(config, command, { timeout: 60_000 })
  if (result.code !== 0) log(config, `observer ${action} command exited ${result.code}`)
  return { configured: true, code: result.code }
}

function outcome(config, result) {
  writeJson(config.resultFile, result)
  if (result.report?.sent === false && result.report.reason) log(config, `Feishu report not sent: ${result.report.reason}`)
  return result.ok ? 0 : 1
}

async function deployMechanical(config, request, options) {
  const startedAt = Date.now()
  let plan
  try {
    plan = await inspect(config, request)
  } catch (error) {
    const detail = error instanceof DeployError ? error.message : String(error)
    log(config, `preflight failed: ${detail}`)
    return outcome(config, {
      at: new Date().toISOString(), ok: false, phase: 'preflight_failed', mode: 'mechanical',
      request, checkout: config.checkout, serviceProfile: config.serviceProfile, url: config.url,
      error: detail, log: config.logFile, timings: { totalMs: Date.now() - startedAt },
    })
  }
  if (options.plan) {
    process.stdout.write(JSON.stringify(planView(plan), null, 2) + '\n')
    return 0
  }

  log(config, `mechanical deployment start: ${plan.revision} -> ${config.runtimeRoot}`)
  const timings = { preflightMs: Date.now() - startedAt }
  const backupDirectory = plan.backupDirectory
  const journal = { path: join(backupDirectory, 'switch.json'), phase: 'prepared', entries: [] }
  let lock
  let observerStopped = false
  let serviceStopped = false
  let phase = 'preparing'
  let lastError
  let backup = []
  try {
    lock = acquireLock(config)
    mkdirSync(backupDirectory, { recursive: true })
    if (request.fromFile) {
      const archive = join(dirname(config.requestPath), 'deploy-request.last.json')
      renameSync(config.requestPath, archive)
      log(config, `archived the deploy request at ${archive}`)
    }
    writeJson(journal.path, journal)

    phase = 'stopping'
    const stoppedObserver = observer(config, 'stop')
    observerStopped = stoppedObserver.configured
    // Re-read the live workload after the observer pause: a new Assignment may have started since the plan was made.
    const latest = await state(config)
    if (!latest || latest.load?.running !== 0) {
      phase = 'preflight_failed'
      fail('service_busy', `the service is running ${latest?.load?.running ?? 'an unknown number of'} assignments; wait for them to finish`)
    }
    let mark = Date.now()
    try { stopService(config) } catch (error) {
      phase = 'stop_failed'
      // A timed-out stop can still have exited the process. Never leave a service down merely because the command's
      // exit code was lost; if no process remains, the recovery branch below starts the unchanged previous build.
      try {
        const afterStop = readStatus(config)
        if (Array.isArray(afterStop.pids) && afterStop.pids.length === 0) serviceStopped = true
      } catch { /* The control script may be unavailable mid-stop; leave the scene to a person. */ }
      throw error
    }
    serviceStopped = true
    timings.stopMs = Date.now() - mark

    mark = Date.now()
    phase = 'backup'
    try { backup = backupState(config, plan) } catch (error) { phase = 'backup_failed'; throw error }
    timings.backupMs = Date.now() - mark

    mark = Date.now()
    phase = 'switching'
    journal.phase = 'switching'
    writeJson(journal.path, journal)
    try { applyEntries(config, plan, journal) } catch (error) { phase = 'switch_failed'; throw error }
    timings.switchMs = Date.now() - mark

    mark = Date.now()
    journal.phase = 'starting'
    writeJson(journal.path, journal)
    phase = 'starting'
    try { startService(config) } catch (error) { phase = 'start_failed'; throw error }
    timings.startMs = Date.now() - mark

    mark = Date.now()
    journal.phase = 'verifying'
    writeJson(journal.path, journal)
    phase = 'verifying'
    try { verifyService(config, plan.survivalSeconds) } catch (error) { phase = 'verify_failed'; throw error }
    timings.verifyMs = Date.now() - mark

    journal.phase = 'verified'
    writeJson(journal.path, journal)
    phase = 'verified'
    timings.totalMs = Date.now() - startedAt
    const result = {
      at: new Date().toISOString(), ok: true, phase, mode: 'mechanical', request,
      revision: plan.revision, checkout: config.checkout, runtimeRoot: config.runtimeRoot,
      candidateRoot: plan.candidate.root, serviceProfile: config.serviceProfile, url: config.url,
      survivalSeconds: plan.survivalSeconds, backup: { directory: backupDirectory, state: backup },
      entries: journal.entries.map(record => ({ target: record.target, source: record.source,
        previous: record.previous ?? undefined, moved: record.moved, copied: record.copied })),
      journal: journal.path, timings, log: config.logFile,
    }
    result.report = (() => {
      try { return report(config, `机械部署 ${plan.revision.slice(0, 12)} 已切换并通过存活校验；旧运行文件与停机状态备份保留在 ${backupDirectory}。`) } catch (error) {
        return { sent: false, error: error instanceof Error ? error.message : String(error) }
      }
    })()
    return outcome(config, result)
  } catch (error) {
    lastError = error instanceof DeployError ? error.message : error instanceof Error ? error.stack ?? error.message : String(error)
    log(config, `deployment failed in ${phase}: ${lastError}`)
    const rollback = { attempted: false }
    let rollbackStarted = false
    if (journal.entries.length > 0) {
      rollback.attempted = true
      try { stopService(config) } catch { /* The new build may already be down. */ }
      const restored = restoreEntries(config, journal)
      rollback.restored = restored
      if (restored) {
        try {
          startService(config)
          verifyService(config, plan.survivalSeconds)
          rollback.started = true
          rollbackStarted = true
          phase = 'rolled_back'
        } catch (rollbackError) {
          rollback.error = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          phase = 'rollback_failed'
        }
      } else {
        phase = 'rollback_failed'
      }
    } else if (serviceStopped) {
      // Nothing was switched, so start the build that was already there rather than leaving the service down.
      try {
        startService(config)
        verifyService(config, plan.survivalSeconds)
        rollback.recovered = true
        phase = 'recovered_before_switch'
      } catch (startError) {
        rollback.error = startError instanceof Error ? startError.message : String(startError)
        phase = 'service_stopped_manual_intervention'
      }
    } else if (phase === 'preparing') {
      phase = 'preflight_failed'
    }
    try { writeJson(journal.path, journal) } catch { /* Best effort during failure handling. */ }
    timings.totalMs = Date.now() - startedAt
    const result = {
      at: new Date().toISOString(), ok: false, phase, mode: 'mechanical', request,
      revision: plan.revision, checkout: config.checkout, runtimeRoot: config.runtimeRoot,
      candidateRoot: plan.candidate.root, serviceProfile: config.serviceProfile, url: config.url,
      survivalSeconds: plan.survivalSeconds, backup: { directory: backupDirectory, state: backup },
      entries: journal.entries.map(record => ({ target: record.target, source: record.source,
        previous: record.previous ?? undefined, moved: record.moved, copied: record.copied })),
      journal: journal.path, error: lastError, rollback, timings, log: config.logFile,
    }
    if (!rollbackStarted && (phase === 'rollback_failed' || phase === 'service_stopped_manual_intervention')) {
      result.manualIntervention = true
    }
    const note = result.phase === 'rolled_back'
      ? `机械部署 ${plan.revision.slice(0, 12)} 失败，已恢复旧运行文件并重启旧版；备份在 ${backupDirectory}。`
      : `机械部署 ${plan.revision.slice(0, 12)} 失败（${result.phase}），需要人工确认；备份与切换日志在 ${backupDirectory}。`
    try { result.report = report(config, note) } catch { /* The service may be down. */ }
    return outcome(config, result)
  } finally {
    try { journal.phase = phase; writeJson(journal.path, journal) } catch { /* Best effort. */ }
    if (observerStopped) {
      const started = observer(config, 'start')
      if (started.configured && started.code !== 0) log(config, 'the observer start command failed; start it from its scheduled task')
    }
    if (lock && phase !== 'rollback_failed' && phase !== 'service_stopped_manual_intervention') lock.release()
    else if (lock) log(config, `keeping the deployment lock at ${lock.path} for a human to inspect`)
  }
}

/** The explicit fallback: a full headless DSH agent performs the deployment from the operator's prompt. */
async function deployWithAgent(config, request, startedAt = Date.now()) {
  for (const name of ['promptPath', 'modelPatch', 'workdir', 'dsh']) {
    if (!config[name]) fail('agent_config', `the agent fallback needs ${name} in the deployment configuration`)
  }
  if (!existsSync(config.control)) fail('control_missing', `the control script does not exist: ${config.control}`)
  if (request.fromFile) {
    const archive = join(dirname(config.requestPath), 'deploy-request.last.json')
    renameSync(config.requestPath, archive)
  }
  const prompt = readFileSync(config.promptPath, 'utf8')
  const input = `操作者请求（${request.at}，${request.requestedBy}）：${request.confirmation}\n目标：${request.target ?? 'latest'}\n\n${prompt}`
  log(config, `no mechanical deployment configured; running the headless agent ${config.agentProfile}`)
  const agentCode = await new Promise(resolvePromise => {
    const child = spawn(config.node, [config.dsh, '--profile', config.agentProfile, '--patch', config.modelPatch,
      '--approval-policy', 'never', '--permission-mode', 'danger-full-access', '-'], {
      cwd: config.workdir, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let timer
    const finish = code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(typeof code === 'number' ? code : 1)
    }
    timer = setTimeout(() => {
      log(config, 'the deployment agent exceeded one hour; stopping it')
      child.kill()
    }, 3_600_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', text => relay(config, text))
    child.stderr.on('data', text => relay(config, text))
    child.on('error', error => { relay(config, `deployment agent error: ${error.message}\n`); finish(1) })
    child.on('close', code => finish(code))
    child.stdin.on('error', () => { /* The agent may exit before reading all input. */ })
    child.stdin.end(input)
  })
  log(config, `deployment agent exited code=${agentCode}`)
  let verifyCode = 1
  let verifyOutput = ''
  try {
    const verify = control(config, 'verify', ['--survival-seconds', String(config.survivalSeconds)], (config.survivalSeconds + 90) * 1_000)
    verifyOutput = verify.stdout + verify.stderr
    relay(config, verifyOutput)
    verifyCode = verify.code
  } catch (error) {
    verifyOutput = error instanceof Error ? error.message : String(error)
    relay(config, verifyOutput)
  }
  const ok = agentCode === 0 && verifyCode === 0
  const head = git(config, ['rev-parse', 'HEAD'])
  const result = {
    at: new Date().toISOString(),
    ok,
    phase: ok ? 'agent_exited_service_alive' : agentCode !== 0 ? 'agent_failed' : 'service_did_not_survive',
    mode: 'agent',
    agentExitCode: agentCode,
    verifyExitCode: verifyCode,
    request: { at: request.at, requestedBy: request.requestedBy, confirmation: request.confirmation, target: request.target ?? 'latest' },
    checkout: config.checkout,
    head: head ?? null,
    serviceProfile: config.serviceProfile,
    url: config.url,
    survivalSeconds: config.survivalSeconds,
    verify: verifyOutput,
    log: config.logFile,
    timings: { totalMs: Date.now() - startedAt },
  }
  if (ok) result.report = report(config, '独立部署任务已退出，服务存活检查通过。')
  return outcome(config, result)
}

export function loadConfig(path) {
  const value = readJson(path, 'config_unreadable')
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('config_unreadable', 'the deployment configuration must be a JSON object')
  const field = name => value[name] === undefined || value[name] === null ? undefined : value[name]
  const optionalPath = name => {
    const raw = field(name)
    return raw === undefined || raw === '' ? undefined : resolve(String(raw))
  }
  const checkout = optionalPath('checkout') ?? REPOSITORY_ROOT
  const mechanicalValue = field('mechanical')
  let mechanical
  if (mechanicalValue !== undefined) {
    if (!mechanicalValue || typeof mechanicalValue !== 'object' || Array.isArray(mechanicalValue)) {
      fail('config_unreadable', 'mechanical must be an object')
    }
    const valuePath = name => {
      const raw = mechanicalValue[name]
      return raw === undefined || raw === null || raw === '' ? undefined : resolve(String(raw))
    }
    mechanical = {
      candidateRoot: valuePath('candidateRoot'),
      manifestPath: valuePath('manifestPath'),
      backupRoot: valuePath('backupRoot'),
      runtimeRoot: valuePath('runtimeRoot') ?? checkout,
      stateDir: valuePath('stateDir'),
      control: valuePath('control') ?? join(checkout, 'scripts', 'dsh-superagent'),
      targetRevision: mechanicalValue.targetRevision === undefined ? undefined : String(mechanicalValue.targetRevision),
      fetch: mechanicalValue.fetch !== false,
      observerStopCommand: mechanicalValue.observerStopCommand === undefined ? undefined : String(mechanicalValue.observerStopCommand),
      observerStartCommand: mechanicalValue.observerStartCommand === undefined ? undefined : String(mechanicalValue.observerStartCommand),
      staleLockMinutes: Number(mechanicalValue.staleLockMinutes ?? 120),
    }
    if (!Number.isFinite(mechanical.staleLockMinutes) || mechanical.staleLockMinutes <= 0) {
      fail('config_unreadable', 'mechanical.staleLockMinutes must be a positive number')
    }
  }
  const config = {
    path: resolve(path),
    checkout,
    node: String(field('node') ?? process.execPath),
    home: optionalPath('home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    serviceHome: optionalPath('serviceHome') ?? optionalPath('home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    serviceAgentsHome: optionalPath('serviceAgentsHome'),
    serviceScript: optionalPath('serviceScript'),
    url: String(field('url') ?? 'http://127.0.0.1:3083').replace(/\/+$/, ''),
    serviceProfile: String(field('serviceProfile') ?? 'superagent'),
    agentProfile: String(field('agentProfile') ?? 'headless'),
    requestPath: optionalPath('requestPath'),
    logFile: optionalPath('logFile'),
    resultFile: optionalPath('resultFile'),
    promptPath: optionalPath('promptPath'),
    modelPatch: optionalPath('modelPatch') ?? (optionalPath('promptPath') ? join(dirname(optionalPath('promptPath')), 'model.patch.yml') : undefined),
    workdir: optionalPath('workdir'),
    dsh: field('dsh') === undefined ? undefined : String(field('dsh')),
    reportChat: field('reportChat') === undefined ? undefined : String(field('reportChat')),
    mechanical,
    survivalSeconds: Number(field('survivalSeconds') ?? (mechanicalValue !== undefined ? 3 : 30)),
    candidateRoot: mechanical?.candidateRoot,
    runtimeRoot: mechanical?.runtimeRoot ?? checkout,
    manifestPath: mechanical?.manifestPath,
    backupRoot: mechanical?.backupRoot,
    stateDir: mechanical?.stateDir,
    targetRevision: mechanical?.targetRevision,
    control: optionalPath('control') ?? mechanical?.control ?? join(checkout, 'scripts', 'dsh-superagent'),
    fetch: mechanical?.fetch ?? true,
    observerStopCommand: mechanical?.observerStopCommand,
    observerStartCommand: mechanical?.observerStartCommand,
    staleLockMinutes: mechanical?.staleLockMinutes ?? 120,
  }
  if (!config.requestPath) fail('config_unreadable', 'requestPath is required')
  if (!config.logFile) fail('config_unreadable', 'logFile is required')
  if (!config.resultFile) fail('config_unreadable', 'resultFile is required')
  if (!Number.isInteger(config.survivalSeconds) || config.survivalSeconds < 0 || config.survivalSeconds > 3_600) {
    fail('config_unreadable', 'survivalSeconds must be an integer between 0 and 3600')
  }
  return config
}

function readRequest(config, confirmation) {
  if (existsSync(config.requestPath)) {
    const value = readJson(config.requestPath, 'bad_request')
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.confirmation !== 'string' || value.confirmation.trim() === '') {
      fail('request_unconfirmed', `the deploy request has no operator confirmation: ${config.requestPath}`)
    }
    return { ...value, fromFile: true }
  }
  if (confirmation && confirmation.trim() !== '') {
    return { at: new Date().toISOString(), requestedBy: 'operator', confirmation, target: 'latest', fromFile: false }
  }
  return null
}

function parseArguments(argv) {
  const options = { config: process.env.DSH_SUPERAGENT_DEPLOY_CONFIG, confirmation: '', validate: false, plan: false, agent: false }
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--config') options.config = argv[++index]
    else if (word.startsWith('--config=')) options.config = word.slice('--config='.length)
    else if (word === '--confirmation') options.confirmation = argv[++index] ?? ''
    else if (word.startsWith('--confirmation=')) options.confirmation = word.slice('--confirmation='.length)
    else if (word === '--validate') options.validate = true
    else if (word === '--plan') options.plan = true
    else if (word === '--agent') options.agent = true
    else fail('invalid_arguments', `unknown argument: ${word}`)
  }
  if (!options.config) fail('invalid_arguments', 'no deployment configuration: pass --config or set DSH_SUPERAGENT_DEPLOY_CONFIG')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const config = loadConfig(options.config)
  if (options.validate) {
    process.stdout.write(JSON.stringify(validateView(config), null, 2) + '\n')
    return 0
  }
  if (options.plan && !config.mechanical) {
    fail('mechanical_config', '--plan requires a mechanical deployment configuration')
  }
  const request = readRequest(config, options.confirmation)
  if (!request) {
    log(config, 'no deploy request; nothing to do')
    return 0
  }
  if (config.mechanical && !options.agent) return deployMechanical(config, request, options)
  return deployWithAgent(config, request)
}

const invoked = process.argv[1] ? (() => {
  try { return realpathSync(process.argv[1]) } catch { return '' }
})() : ''
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(code => { process.exitCode = typeof code === 'number' ? code : 1 }).catch(error => {
    process.stderr.write((error instanceof DeployError ? error.message : error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exitCode = 1
  })
}