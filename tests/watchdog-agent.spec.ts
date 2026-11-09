/** The Watchdog agent runs in its own workspace and never turns the checkout into its DSH workspace. */
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const agentSource = join(import.meta.dirname, '..', 'scripts', 'watchdog-agent')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

/** Run one cycle of the agent wrapper with a stub gate (exit 2) and a stub DSH that records its working directory. */
function runCycle(root: string, config: string, extraArgs: string[] = []) {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolve => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(root, 'agent', 'run.ps1'),
      '-Config', config, ...extraArgs], { timeout: 60_000, env: {
      ...process.env,
      WATCHDOG_TEST_CWD: join(root, 'cwd.txt'),
      WATCHDOG_TEST_PROMPT: join(root, 'prompt.txt'),
    } }, (error, stdout, stderr) => resolve({
      code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
      stdout, stderr,
    }))
  })
}

/** A temporary artifact-shaped agent directory, a fake checkout and a fake DSH that records how it was launched. */
function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-agent-workspace-'))
  const root = directory
  mkdirSync(join(root, 'agent'))
  cpSync(join(agentSource, 'run.ps1'), join(root, 'agent', 'run.ps1'))
  cpSync(join(agentSource, 'prompt.md'), join(root, 'agent', 'prompt.md'))
  writeFileSync(join(root, 'agent', 'gate.mjs'), 'process.exit(2)\n')
  const checkout = join(root, 'checkout')
  const dshHome = join(root, 'dsh-home')
  mkdirSync(checkout)
  mkdirSync(dshHome)
  const dsh = join(root, 'dsh.mjs')
  writeFileSync(dsh, [
    "import { writeFileSync } from 'node:fs'",
    "let input = ''",
    "process.stdin.on('data', chunk => { input += chunk })",
    "process.stdin.on('end', () => {",
    "  writeFileSync(process.env.WATCHDOG_TEST_CWD, `${process.cwd()}\\n`)",
    "  writeFileSync(process.env.WATCHDOG_TEST_PROMPT, input)",
    '  process.exit(0)',
    '})',
    '',
  ].join('\n'))
  const config = (fields: Record<string, unknown> = {}, name = 'agent.json') => {
    const path = join(root, name)
    writeFileSync(path, JSON.stringify({
      url: 'http://127.0.0.1:1', checkout, dshHome, node: process.execPath, dsh,
      modelPatch: join(root, 'model.patch.yml'), logFile: join(root, 'agent.log'), chatId: 'oc_test',
      ...fields,
    }))
    return path
  }
  return { root, checkout, dshHome, config, dsh }
}

it.skipIf(process.platform !== 'win32')('starts the full agent in its own workspace with absolute checkout commands', async () => {
  const { root, checkout, config } = fixture()
  const workspace = join(root, 'workspace')
  const result = await runCycle(root, config({ workspace }))
  expect(result.code).toBe(0)
  expect(readFileSync(join(root, 'cwd.txt'), 'utf8').trim()).toBe(workspace)
  const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8')
  expect(prompt).toContain(`独立工作区（当前工作目录）：${workspace}`)
  expect(prompt).toContain(`${checkout}\\scripts\\dsh-superagent`)
  expect(prompt).not.toContain('{{workspace}}')
  expect(prompt).not.toContain('{{checkout}}')
  expect(readFileSync(join(root, 'agent.log'), 'utf8')).toContain(`workspace=${workspace}`)
}, 60_000)

it.skipIf(process.platform !== 'win32')('refuses a workspace inside the checkout instead of mixing their DSH workspaces', async () => {
  const { root, checkout, config } = fixture()
  const workspace = join(checkout, 'workspace')
  const result = await runCycle(root, config({ workspace }))
  expect(result.code).not.toBe(0)
  expect(`${result.stdout}${result.stderr}`).toContain('workspace must be outside the checkout')
  expect(existsSync(workspace)).toBe(false)
  expect(existsSync(join(root, 'cwd.txt'))).toBe(false)
}, 60_000)

it.skipIf(process.platform !== 'win32')('derives a workspace from the service profile when none is configured', async () => {
  const { root, config } = fixture()
  const result = await runCycle(root, config({}, 'existing-agent.json'))
  expect(result.code).toBe(0)
  expect(readFileSync(join(root, 'cwd.txt'), 'utf8').trim()).toBe(join(root, 'workspaces', 'watchdog_superagent'))
}, 60_000)

it.skipIf(process.platform !== 'win32')('names each watchdog workspace after its own service profile', async () => {
  const { root, config } = fixture()
  const result = await runCycle(root, config({ serviceProfile: 'sheepdoku' }, 'sheepdoku-agent.json'))
  expect(result.code).toBe(0)
  expect(readFileSync(join(root, 'cwd.txt'), 'utf8').trim()).toBe(join(root, 'workspaces', 'watchdog_sheepdoku'))
}, 60_000)