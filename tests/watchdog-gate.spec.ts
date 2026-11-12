import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const gate = join(import.meta.dirname, '..', 'scripts', 'watchdog-agent', 'gate.mjs')
let directory: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function runGate(args: string[]) {
  return new Promise<{ code: number, stderr: string }>(resolve => {
    execFile(process.execPath, [gate, ...args], { timeout: 10_000 }, (error, _stdout, stderr) => resolve({
      code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr,
    }))
  })
}

it('fails closed without reading configuration or accessing the service', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-gate-disabled-'))
  let requests = 0
  server = createServer((_request, response) => { requests++; response.end('{}') })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const config = join(directory, 'config.json')
  const original = JSON.stringify({ url })
  writeFileSync(config, original)
  for (const args of [[], ['--config', config], ['--config', join(directory, 'missing')], ['--url', url]]) {
    const result = await runGate(args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('temporarily disabled')
  }
  expect(requests).toBe(0)
  expect(readFileSync(config, 'utf8')).toBe(original)
})
