/** The Watchdog artifact is self-contained and its manifest detects any changed file before an update installs it. */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const artifact = join(import.meta.dirname, '..', 'scripts', 'watchdog-artifact.mjs')
const smoke = join(import.meta.dirname, '..', 'scripts', 'watchdog-smoke.mjs')
let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function build(out: string, version: string, builtAt = '2026-11-09T00:00:00.000Z') {
  return new Promise<{ code: number, stdout: string, stderr: string }>(resolve => {
    execFile(process.execPath, [artifact, '--out', out, '--version', version, '--commit', `${version}000000000000000000000000000000000000`,
      '--built-at', builtAt], { timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }))
  })
}

it('builds a verifiable self-contained Watchdog artifact with a stable digest', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-artifact-'))
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  expect(await build(first, 'artifact-1')).toMatchObject({ code: 0 })
  const manifest = JSON.parse(readFileSync(join(first, 'manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({ name: 'dsh-superagent-watchdog', version: 'artifact-1', apiVersion: 1,
    minServiceVersion: '0.1.0', builtAt: '2026-11-09T00:00:00.000Z' })
  expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(Object.keys(manifest.files).sort()).toEqual(['launch-observer.ps1', 'launch-observer.vbs', 'package.json', 'watchdog',
    'watchdog-artifact.mjs', 'watchdog-control.mjs', 'watchdog-smoke.mjs', 'watchdog-update.mjs'])
  expect(JSON.parse(readFileSync(join(first, 'package.json'), 'utf8'))).toMatchObject({ type: 'module' })

  // The same sources and inputs produce the same digest, so a request can pin one artifact.
  expect(await build(second, 'artifact-1')).toMatchObject({ code: 0 })
  expect(JSON.parse(readFileSync(join(second, 'manifest.json'), 'utf8')).sha256).toBe(manifest.sha256)

  const result = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [smoke, first], { timeout: 60_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolve(stdout))
  })
  expect(JSON.parse(result)).toMatchObject({ version: 'artifact-1', commit: 'artifact-1000000000000000000000000000000000000' })
})

it('defaults the CLI artifact version and timestamp to the current commit and time', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-artifact-default-'))
  const out = join(directory, 'artifact')
  const result = await new Promise<{ code: number, stderr: string }>(resolve => {
    execFile(process.execPath, [artifact, '--out', out], { timeout: 30_000 }, (error, _stdout, stderr) =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr }))
  })
  expect(result.code, result.stderr).toBe(0)
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  expect(manifest.commit).toMatch(/^[a-f0-9]{40,64}$/)
  expect(manifest.version).toBe(manifest.commit)
  expect(Number.isFinite(Date.parse(manifest.builtAt))).toBe(true)
})

it('refuses an artifact whose file changed after the manifest was written', async () => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-artifact-tamper-'))
  const out = join(directory, 'artifact')
  expect(await build(out, 'artifact-2')).toMatchObject({ code: 0 })
  writeFileSync(join(out, 'watchdog'), 'export {}\n')
  const result = await new Promise<{ code: number, stderr: string }>(resolve => {
    execFile(process.execPath, [smoke, out], { timeout: 60_000 }, (error, _stdout, stderr) =>
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr }))
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('changed')
}, 30_000)