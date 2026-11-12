import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const agentSource = join(import.meta.dirname, '..', 'scripts', 'watchdog-agent', 'run.ps1')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function runAgent(script: string, args: string[]) {
  return new Promise<{ code: number, stderr: string }>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], { timeout: 10_000 },
      (error, _stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr }))
  })
}

it('never runs the gate or model, including when the gate would return 2', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-agent-disabled-'))
  const agent = join(directory, 'agent')
  mkdirSync(agent)
  const script = join(agent, 'run.ps1')
  copyFileSync(agentSource, script)
  const gateMarker = join(directory, 'gate-ran')
  const modelMarker = join(directory, 'model-ran')
  writeFileSync(join(agent, 'gate.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(gateMarker)}, 'ran'); process.exit(2)`)
  const model = join(directory, 'model.mjs')
  writeFileSync(model, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(modelMarker)}, 'ran')`)
  const config = join(directory, 'config.json')
  const original = JSON.stringify({ url: 'http://127.0.0.1:1', checkout: join(directory, 'checkout'), dshHome: directory,
    node: process.execPath, dsh: model, modelPatch: join(directory, 'patch'), chatId: 'test',
    logFile: join(directory, 'log'), workspace: join(directory, 'workspace') })
  writeFileSync(config, original)
  for (const args of [[], ['-Config', config], ['-Config', config, '-SkipLlm'], ['-Config', join(directory, 'missing')]]) {
    const result = await runAgent(script, args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('temporarily disabled')
  }
  expect(readFileSync(config, 'utf8')).toBe(original)
  for (const path of [gateMarker, modelMarker, join(directory, 'log'), join(directory, 'workspace')]) {
    expect(existsSync(path)).toBe(false)
  }
})
