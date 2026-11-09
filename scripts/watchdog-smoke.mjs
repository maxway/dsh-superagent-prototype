#!/usr/bin/env node
/**
 * Smoke an uninstalled Watchdog artifact without the production service or Feishu.
 *
 * A local mock management API answers one quiet snapshot and accepts observation runs. The artifact's observer must
 * complete one `--once` cycle, and the artifact's agent gate must complete one quiet gate cycle from the same version;
 * both runs must carry the manifest version. This proves the artifact is self-contained before an update switches the
 * live `current` pointer.
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
  const runs = []
  let server
  try {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        if (request.method === 'POST' && request.url?.startsWith('/orchestrator/api/watchdog/runs')) {
          try { runs.push(JSON.parse(body)) } catch { /* A malformed body still gets an answer; the assertion fails. */ }
          response.end(JSON.stringify({ id: 'smoke-run', text: 'smoke' }))
          return
        }
        response.end(JSON.stringify(SNAPSHOT))
      })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${server.address().port}`
    const config = join(directory, 'watchdog.json')
    writeFileSync(config, JSON.stringify({ url, report: false, intervalSeconds: 60, staleMinutes: 30,
      stateDir: join(directory, 'state'), logFile: join(directory, 'watchdog.log') }))

    const observer = await run(node, [join(artifactDirectory, 'watchdog'), '--once', '--config', config],
      { cwd: directory }, timeoutMs)
    if (observer.code !== 0) throw new Error(`The artifact observer failed (exit ${observer.code}): ${observer.stderr.trim() || observer.stdout.trim()}`)
    const observerRun = runs.find(entry => entry.version === manifest.version)
    if (!observerRun) throw new Error(`The artifact observer recorded no run for version ${manifest.version}`)
    if (!observerRun.idempotencyKey) throw new Error('The artifact observer recorded a run without an idempotency key')

    const gate = await run(node, [join(artifactDirectory, 'agent', 'gate.mjs'), '--config', config], { cwd: directory }, timeoutMs)
    if (gate.code !== 0) throw new Error(`The artifact agent gate failed (exit ${gate.code}): ${gate.stderr.trim() || gate.stdout.trim()}`)
    const gateRun = runs.filter(entry => entry.version === manifest.version).at(-1)
    if (!gateRun || gateRun === observerRun) throw new Error(`The artifact agent gate recorded no run for version ${manifest.version}`)
    return { version: manifest.version, commit: manifest.commit, observerRun: observerRun.idempotencyKey, gateRun: gateRun.idempotencyKey }
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