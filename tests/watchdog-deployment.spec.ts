import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error The Watchdog module is plain JavaScript.
import { createDeploymentPoller } from '../scripts/watchdog-deployment.mjs'

let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function fixture(script: string) {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-deploy-'))
  const checkout = join(directory, 'checkout')
  mkdirSync(join(checkout, 'scripts'), { recursive: true })
  const record = join(directory, 'record')
  const request = join(directory, 'request.json')
  const resultFile = join(directory, 'results', 'result.json')
  const deployConfig = join(directory, 'config.json')
  writeFileSync(join(checkout, 'scripts', 'deploy.mjs'), script.replaceAll('RECORD_PATH', JSON.stringify(record)))
  writeFileSync(deployConfig, JSON.stringify({ requestPath: request, resultFile }))
  writeFileSync(request, '{"confirmation":"test","target":"latest"}')
  return { checkout, deployConfig, record, request, resultFile }
}

it('runs asynchronously and claims a request across competing pollers', async () => {
  const value = fixture("import { appendFileSync } from 'node:fs'; appendFileSync(RECORD_PATH, 'x'); await new Promise(resolve => setTimeout(resolve, 150));")
  const first = createDeploymentPoller(value)
  const second = createDeploymentPoller(value)
  let responsive = false
  const results = Promise.all([first.poll(), first.poll(), second.poll()])
  await new Promise<void>(resolve => setTimeout(() => { responsive = true; resolve() }, 10))
  expect(responsive).toBe(true)
  await results
  expect(readFileSync(value.record, 'utf8')).toBe('x')
  expect((await second.poll()).status).toBe('already-attempted')
})

it('chooses the checkout configured for deployment over the fallback checkout', async () => {
  const value = fixture("import { writeFileSync } from 'node:fs'; writeFileSync(RECORD_PATH, 'configured')")
  const fallback = join(directory!, 'fallback')
  mkdirSync(join(fallback, 'scripts'), { recursive: true })
  writeFileSync(join(fallback, 'scripts', 'deploy.mjs'), 'process.exitCode = 9')
  writeFileSync(value.deployConfig, JSON.stringify({ checkout: value.checkout, requestPath: value.request, resultFile: value.resultFile }))
  expect((await createDeploymentPoller({ ...value, checkout: fallback }).poll()).status).toBe('exited')
  expect(readFileSync(value.record, 'utf8')).toBe('configured')
})

it('suppresses failed requests across restarts and accepts changed content', async () => {
  const value = fixture("import { appendFileSync } from 'node:fs'; appendFileSync(RECORD_PATH, 'x'); process.exitCode = 1")
  expect((await createDeploymentPoller(value).poll()).status).toBe('failed')
  expect((await createDeploymentPoller(value).poll()).status).toBe('already-attempted')
  writeFileSync(value.request, '{"confirmation":"another request"}')
  expect((await createDeploymentPoller(value).poll()).status).toBe('failed')
  expect(readFileSync(value.record, 'utf8')).toBe('xx')
})

it('keeps a detached deployment running after the observer exits and suppresses its failure', async () => {
  const value = fixture("import { writeFileSync } from 'node:fs'; await new Promise(resolve => setTimeout(resolve, 800)); writeFileSync(RECORD_PATH, 'failed'); process.exitCode = 1")
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'watchdog-deployment.mjs')).href
  const script = `import { createDeploymentPoller } from ${JSON.stringify(moduleUrl)}; createDeploymentPoller(${JSON.stringify(value)}).start(); setTimeout(() => process.exit(0), 300)`
  await new Promise<void>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 }, error => error ? reject(error) : resolve()))
  expect((await createDeploymentPoller(value).poll()).status).toBe('already-attempted')
  const deadline = Date.now() + 5000
  while (!existsSync(value.record) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  expect(readFileSync(value.record, 'utf8')).toBe('failed')
  expect((await createDeploymentPoller(value).poll()).status).toBe('already-attempted')
})

it('retries lock contention but does not spin on other errors', async () => {
  const value = fixture("process.stderr.write('deploy_locked: busy\\n'); process.exitCode = 1")
  const poller = createDeploymentPoller(value)
  expect((await poller.poll()).status).toBe('locked')
  expect((await poller.poll()).status).toBe('locked')
  rmSync(value.request)
  expect((await poller.poll()).status).toBe('idle')
  expect(existsSync(value.record)).toBe(false)
})
