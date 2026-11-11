import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'restart-superagent.ps1')
let directory: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

async function fixture(status: number) {
  directory = mkdtempSync(join(tmpdir(), 'restart-superagent-'))
  const config = join(directory, 'service.json')
  const mock = join(directory, 'service.ps1')
  const calls = join(directory, 'calls.txt')
  const requests: string[] = []
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers['x-orchestrator-request']}`)
    response.writeHead(status, { connection: 'close' }).end()
    if (status === 200) server?.close()
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${port}` }))
  writeFileSync(mock, `param($Action, $Config)\nAdd-Content -LiteralPath '${calls.replaceAll("'", "''")}' -Value "$Action|$Config"\nexit 0\n`)
  return { config, mock, calls, requests }
}

function run(config: string, mock: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-File', script, '-Config', config, '-ServiceScript', mock], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', resolve)
  })
}

it.skipIf(process.platform !== 'win32')('requests the server to stop before starting', async () => {
  const value = await fixture(200)
  expect(await run(value.config, value.mock)).toBe(0)
  expect(value.requests).toEqual(['POST /orchestrator/api/service/stop 1'])
  expect(readFileSync(value.calls, 'utf8').trim()).toBe(`start|${value.config}`)
}, 30000)

it.skipIf(process.platform !== 'win32')('does not start when the stop request fails', async () => {
  const value = await fixture(503)
  expect(await run(value.config, value.mock)).not.toBe(0)
  expect(value.requests).toEqual(['POST /orchestrator/api/service/stop 1'])
  expect(() => readFileSync(value.calls, 'utf8')).toThrow()
}, 30000)
