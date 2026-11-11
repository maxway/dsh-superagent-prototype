#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function ownerAlive(pid, probe = process.kill) {
  try {
    probe(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return true
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function bootstrap(home) {
  const lock = join(home, 'update.lock')
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner
    let version
    try {
      owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
      version = readFileSync(join(lock, 'launch-version.txt'), 'utf8').trim()
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !/^[A-Za-z0-9._-]+$/.test(version)) throw new Error('invalid transaction')
      if (!ownerAlive(owner.pid)) throw new Error('transaction owner is not running')
      if (readFileSync(join(home, 'current.txt'), 'utf8').trim() !== version) throw new Error('transaction pointer mismatch')
    } catch (cause) {
      throw new Error(`Watchdog update is in progress or its lock is stale; cannot bootstrap: ${cause.message}`)
    }
    return
  }
  let temporary
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    const root = readFileSync(join(home, 'source-checkout.txt'), 'utf8').trim()
    if (!root) throw new Error('Watchdog source checkout is not configured')
    const load = name => import(pathToFileURL(join(home, name)).href)
    const { buildFromRepo } = await load('watchdog-control.mjs')
    const { verifyArtifact } = await load('watchdog-artifact.mjs')
    const { installArtifact, readCurrent, writePointer } = await load('watchdog-update.mjs')
    temporary = mkdtempSync(join(tmpdir(), 'watchdog-bootstrap-'))
    const artifact = buildFromRepo(temporary, root)
    const manifest = verifyArtifact(artifact)
    installArtifact(home, artifact, manifest)
    const current = readCurrent(home)
    if (current !== manifest.version) {
      writePointer(home, 'previous.txt', current ?? null)
      writePointer(home, 'current.txt', manifest.version)
    }
    process.stdout.write(`Watchdog bootstrap built latest ${manifest.version}\n`)
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    rmSync(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.argv[2]
  if (!home) {
    process.stderr.write('Usage: watchdog-bootstrap <home>\n')
    process.exitCode = 2
  } else {
    bootstrap(resolve(home)).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
