#!/usr/bin/env node
/**
 * Cheap mechanical gate in front of the full Watchdog agent. Every cycle it reads the read-only panel snapshot and
 * decides whether the situation is risky enough to spend an LLM run on. A quiet cycle records the mechanical
 * observation itself; a risky cycle exits 2 and the caller runs the full agent. Exit codes: 0 quiet (recorded),
 * 1 management API unreachable or the run record failed, 2 risk.
 *
 * This file lives inside the versioned Watchdog artifact; `../watchdog` is the observer from the same artifact, so the
 * gate never imports source from the running superagent checkout. `--config` reads the same JSON as the agent wrapper;
 * `--url`/`--stale-minutes` remain available for a direct run.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { artifactFacts, gateFindings, readSnapshot } from '../watchdog'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const configPath = option('--config', '')
let config = {}
if (configPath) {
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch (error) {
    console.error(`GATE_ERROR cannot read ${configPath}: ${error.message}`)
    process.exit(2)
  }
}
const url = String(option('--url', config.url ?? 'http://127.0.0.1:3083')).replace(/\/+$/, '')
const staleMinutes = Number(option('--stale-minutes', String(config.staleMinutes ?? 30)))
const quietNote = option('--quiet-note', '机械预检无风险：没有需要关注的信号、服务错误或安装问题；本轮的详细判定未调用模型。')
const facts = artifactFacts()

function post(path, content) {
  return new Promise(resolve => {
    let target
    try { target = new URL(url + path) } catch { resolve(null); return }
    const payload = Buffer.from(JSON.stringify(content))
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers: {
      'x-orchestrator-request': '1', 'content-type': 'application/json', 'content-length': String(payload.length) },
      timeout: 10_000 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
      response.on('error', () => resolve(null))
    })
    request.on('timeout', () => { request.destroy(); resolve(null) })
    request.on('error', () => resolve(null))
    request.end(payload)
  })
}

/** One-line mechanical summary for the log and the recorded risk note. */
function describe(findings) {
  return findings.map(finding => finding.kind === 'ticket'
    ? `${String(finding.id).slice(0, 8)} ${finding.signals.join('/')}`
    : finding.kind === 'health' ? `${finding.part} ${finding.state}` : `setup ${finding.code}`).join('; ').slice(0, 400)
}

async function main() {
  try {
    const snapshot = await readSnapshot({ url, staleMinutes })
    const findings = gateFindings(snapshot)
    if (findings.length > 0) {
      const summary = describe(findings)
      console.log(`RISK findings=${findings.length} ${summary}`)
      // Record the mechanical risk first: the heartbeat exists even if the full agent fails.
      await post('/orchestrator/api/watchdog/runs', {
        idempotencyKey: randomUUID(),
        note: `机械预检发现高风险（${summary}），已升级完整 agent 判定。`.slice(0, 500),
        ...facts,
      })
      process.exitCode = 2
      return
    }
    const response = await post('/orchestrator/api/watchdog/runs', { idempotencyKey: randomUUID(), note: quietNote, ...facts })
    if (!response || response.status < 200 || response.status >= 300) {
      console.error(`GATE_ERROR run record answered ${response?.status ?? 'no answer'}`)
      process.exitCode = 1
      return
    }
    const cpu = process.cpuUsage()
    console.log(`QUIET recorded cpuMs=${Math.round((cpu.user + cpu.system) / 1000)} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`)
    process.exitCode = 0
  } catch (error) {
    console.error(`GATE_ERROR ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

await main()