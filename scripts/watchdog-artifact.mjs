#!/usr/bin/env node
/**
 * Build an immutable Watchdog artifact from this checkout.
 *
 * The artifact contains the observer (`watchdog`), the agent wrapper and gate, the prompt/config/model templates, the
 * stable launcher and a manifest whose digest covers every file. A host installs it under `watchdog\versions\<version>`
 * and switches `current.txt`; the agent imports `../watchdog` from the artifact, never source from the superagent
 * checkout. Build output is written only under `--out`; this script does not install or switch anything.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME = 'dsh-superagent-watchdog'
export const API_VERSION = 1

/** Files copied into every artifact, with the path they take inside it. */
const FILES = [
  ['scripts/watchdog', 'watchdog'],
  ['scripts/watchdog-agent/gate.mjs', 'agent/gate.mjs'],
  ['scripts/watchdog-agent/run.ps1', 'agent/run.ps1'],
  ['scripts/watchdog-agent/prompt.md', 'agent/prompt.md'],
  ['scripts/watchdog-agent/config.example.json', 'agent/config.example.json'],
  ['scripts/watchdog-agent/model.patch.example.yml', 'agent/model.patch.example.yml'],
  ['scripts/watchdog-launch-observer.ps1', 'launch-observer.ps1'],
  ['scripts/watchdog-launch-observer.vbs', 'launch-observer.vbs'],
]

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const slash = value => value.split('\\').join('/')

/** Hash every file and the sorted list into one digest; the manifest's own hash is not part of it. */
export function artifactDigest(files) {
  return sha256(JSON.stringify(Object.keys(files).sort().map(path => [path, files[path]])))
}

/** Verify an artifact directory against its manifest; returns the manifest or throws with the first difference. */
export function verifyArtifact(directory) {
  const manifestPath = join(directory, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`No artifact manifest at ${manifestPath}`)
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (error) {
    throw new Error(`The artifact manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!manifest || manifest.name !== NAME) throw new Error(`Not a ${NAME} manifest`)
  if (typeof manifest.version !== 'string' || !/^[A-Za-z0-9._-]+$/.test(manifest.version)) throw new Error('The manifest names no valid version')
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('The manifest lists no files')
  for (const [path, expected] of Object.entries(manifest.files)) {
    const file = join(directory, ...path.split('/'))
    if (!existsSync(file)) throw new Error(`The artifact is missing ${path}`)
    const actual = sha256(readFileSync(file))
    if (actual !== expected) throw new Error(`The artifact file changed: ${path}`)
  }
  const digest = artifactDigest(manifest.files)
  if (digest !== manifest.sha256) throw new Error('The artifact digest does not match its manifest')
  return manifest
}

/** Build an artifact from `root` into `out`; `out` must not already contain files. */
export function buildArtifact(root, out, options = {}) {
  const commit = options.commit ?? gitCommit(root) ?? ''
  const version = options.version ?? commit
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Invalid artifact version: ${version}`)
  if (existsSync(out) && readdirSync(out).length) throw new Error(`The artifact output is not empty: ${out}`)
  mkdirSync(out, { recursive: true })
  const files = {}
  try {
    for (const [source, target] of FILES) {
      const from = join(root, ...source.split('/'))
      if (!existsSync(from)) throw new Error(`The artifact source is missing: ${from}`)
      const to = join(out, ...target.split('/'))
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      files[target] = sha256(readFileSync(to))
    }
    // The extensionless observer is ESM because its directory is a module; the agents import it directly.
    const packageFile = join(out, 'package.json')
    writeFileSync(packageFile, `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`)
    files['package.json'] = sha256(readFileSync(packageFile))
    const manifest = {
      name: NAME,
      version,
      commit,
      sha256: artifactDigest(files),
      builtAt: options.builtAt ?? new Date().toISOString(),
      apiVersion: API_VERSION,
      minServiceVersion: options.minServiceVersion || packageVersion(root),
      files,
    }
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } catch (error) {
    rmSync(out, { recursive: true, force: true })
    throw error
  }
}

function gitCommit(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() || undefined
  } catch { return undefined }
}

function packageVersion(root) {
  try { return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0') } catch { return '0.0.0' }
}

/** Compare dotted versions numerically; a pre-release suffix sorts before the release. */
export function versionAtLeast(actual, minimum) {
  const parse = value => String(value).split('-')[0].split('.').map(part => Number(part))
  const left = parse(actual)
  const right = parse(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return String(actual).includes('-') === String(minimum).includes('-') ? true : String(minimum).includes('-')
}

function parseArgv(argv) {
  const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), out: '', commit: '', version: '',
    builtAt: '', minServiceVersion: '', help: false }
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--out') { options.out = argv[++index] ?? ''; continue }
    if (word.startsWith('--out=')) { options.out = word.slice(6); continue }
    if (word === '--root') { options.root = argv[++index] ?? ''; continue }
    if (word === '--commit') { options.commit = argv[++index] ?? ''; continue }
    if (word === '--version') { options.version = argv[++index] ?? ''; continue }
    if (word === '--built-at') { options.builtAt = argv[++index] ?? ''; continue }
    if (word === '--min-service-version') { options.minServiceVersion = argv[++index] ?? ''; continue }
    if (word === '-h' || word === '--help') { options.help = true; continue }
    throw new Error(`unrecognized argument: ${word}`)
  }
  return options
}

const usage = 'Usage: watchdog-artifact --out <directory> [--root <checkout>] [--commit <sha>] [--version <id>] '
  + '[--built-at <iso>] [--min-service-version <version>]'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgv(process.argv.slice(2))
    if (options.help) { process.stdout.write(`${usage}\n`); process.exitCode = 0 }
    else if (!options.out) { process.stderr.write(`${usage}\n`); process.exitCode = 2 }
    else {
      const manifest = buildArtifact(resolve(options.root), resolve(options.out), options)
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}