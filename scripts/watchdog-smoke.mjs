#!/usr/bin/env node
/**
 * Smoke an uninstalled Watchdog artifact without the production service or Feishu.
 *
 * A local mock management API answers one quiet snapshot and rejects writes. The artifact's observer must complete one
 * read-only `--once` cycle and persist local state without sending requests that change the service.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyArtifact } from './watchdog-artifact.mjs'

const SNAPSHOT = {
  at: '2026-11-09T00:00:00.000Z', staleMinutes: 30, open: 0, tickets: [],
  state: { paused: false, load: { running: 0, queued: 0, maxWorkers: 3 }, health: { runtime: { state: 'ready' } },
    setup: { problem: null, feishuProblem: null } },
  watchdog: { mode: 'observe', actions: ['retry'], staleMinutes: 30 }, audit: [], lastRun: null,
}

/** Run one command with a timeout, returning its exit code and output. */
function run(command, args, options, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, stdout, stderr: `${stderr}\nThe artifact smoke run timed out after ${timeoutMs}ms.` })
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

/**
 * Smoke `artifactDirectory`. The returned object is the evidence the update task records. Throws with a short reason
 * when the artifact, its version or a cycle fails.
 */
export async function smokeArtifact(artifactDirectory, options = {}) {
  const manifest = verifyArtifact(artifactDirectory)
  const node = options.node ?? process.execPath
  const timeoutMs = (options.timeoutSeconds ?? 30) * 1000
  const directory = mkdtempSync(join(tmpdir(), 'watchdog-smoke-'))
  const requests = []
  let server
  try {
    server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.writeHead(request.method === 'GET' ? 200 : 405, { 'content-type': 'application/json' })
      response.end(JSON.stringify(SNAPSHOT))
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${server.address().port}`
    const config = join(directory, 'watchdog.json')
    writeFileSync(config, JSON.stringify({ url, report: false, intervalSeconds: 60, staleMinutes: 30,
      stateDir: join(directory, 'state'), logFile: join(directory, 'watchdog.log') }))

    const observer = await run(node, [join(artifactDirectory, 'watchdog'), '--once', '--config', config],
      { cwd: directory }, timeoutMs)
    if (observer.code !== 0) throw new Error(`The artifact observer failed (exit ${observer.code}): ${observer.stderr.trim() || observer.stdout.trim()}`)
    if (!requests.some(entry => entry.method === 'GET' && entry.url?.startsWith('/orchestrator/api/watchdog'))) {
      throw new Error('The artifact observer did not read a Watchdog snapshot')
    }
    if (requests.some(entry => entry.method !== 'GET')) throw new Error('The artifact observer sent a non-GET request')
    const state = JSON.parse(readFileSync(join(directory, 'state', 'state.json'), 'utf8'))
    if (state.reachable !== true) throw new Error('The artifact observer did not persist a reachable state')
    return { version: manifest.version, commit: manifest.commit, observer: 'read-only' }
  } finally {
    server?.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && process.argv[1].endsWith('watchdog-smoke.mjs')) {
  const directory = process.argv[2]
  if (!directory) {
    process.stderr.write('Usage: watchdog-smoke <artifact directory>\n')
    process.exitCode = 2
  } else {
    smokeArtifact(directory).then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    }).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}