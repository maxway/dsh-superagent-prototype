#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const controls = ['dsh-superagent', 'dsh-superagent.ps1', 'service-start.ps1', 'superagent-lifecycle-lock.ps1', 'launch-hidden.vbs', 'prepare-runtime.ps1', 'initialize-runtime.ps1', 'activate-runtime.ps1', 'deploy-runtime.ps1', 'deploy-runtime-local.ps1', 'runtime-activation-core.ps1', 'runtime-paths.ps1', 'runtime-verify.ps1']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function run(command, args, options) {
  let executable = command
  let argumentsList = args
  let environment = options.env
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    executable = 'pwsh'
    argumentsList = ['-NoProfile', '-NonInteractive', '-Command', '$data = $env:RUNTIME_COMMAND | ConvertFrom-Json; & $data.command @($data.arguments); exit $LASTEXITCODE']
    environment = { ...environment, RUNTIME_COMMAND: JSON.stringify({ command, arguments: args }) }
  }
  const result = spawnSync(executable, argumentsList, { ...options, env: environment, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message ?? result.signal}): ${result.stderr || ''}`)
  return result.stdout
}

function listFiles(directory, prefix = '') {
  const files = []
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(join(directory, path))
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${path}`)
    if (stat.isDirectory()) files.push(...listFiles(directory, path))
    else if (stat.isFile()) files.push(path)
    else throw new Error(`Unsupported file: ${path}`)
  }
  return files
}

function checkPath(path) {
  const parts = path.toLowerCase().split('/')
  if (parts.some(part => part === '.git' || part === 'node_modules' || part === '.npmrc' || part === '.env' || part.startsWith('.env.') || part === 'credentials' || part === 'credentials.json' || part === 'config.production.json' || part.endsWith('.pem') || part.endsWith('.key'))) {
    throw new Error(`Sensitive or dependency path is not allowed: ${path}`)
  }
}

export function buildRuntime({ root, commit, out, execute = run, id = randomUUID() }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error('Commit must be a full lowercase Git object ID')
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('Invalid artifact ID')
  root = resolve(root)
  out = resolve(out)
  const temporary = mkdtempSync(join(tmpdir(), 'superagent-runtime-'))
  const home = join(temporary, 'home')
  const source = join(temporary, 'source')
  const stage = join(temporary, 'stage')
  const archive = join(temporary, 'source.tar')
  const zip = join(temporary, 'runtime.zip')
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), TEMP: temporary, TMP: temporary, TMPDIR: temporary, npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'global-npmrc'), npm_config_cache: join(home, 'npm-cache'), PNPM_HOME: join(home, 'pnpm'), COREPACK_HOME: join(home, 'corepack'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' }
  const call = (command, args, cwd = source, extra = {}) => execute(command, args, { cwd, env: { ...env, ...extra } })
  let published = ''
  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(source)
    mkdirSync(stage)
    const resolved = call('git', ['-C', root, 'rev-parse', '--verify', `${commit}^{commit}`], temporary).trim()
    if (resolved !== commit) throw new Error('Git did not resolve the requested commit exactly')
    call('git', ['-C', root, 'archive', '--format=tar', `--output=${archive}`, commit], temporary)
    call('tar', ['-xf', archive, '-C', source], temporary)
    listFiles(source)
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    if (!Array.isArray(pkg.files) || !pkg.files.length) throw new Error('package.json must declare files')
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager || '')) throw new Error('package.json must pin pnpm')
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    if (call(pnpm, ['--version']).trim() !== pkg.packageManager.slice(5)) throw new Error(`Expected ${pkg.packageManager}`)
    call(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(home, 'store')])
    call(pnpm, ['run', 'build'])
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const packed = JSON.parse(call(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]))
    if (!Array.isArray(packed) || packed.length !== 1 || basename(packed[0].filename) !== packed[0].filename) throw new Error('Unexpected npm pack result')
    call('tar', ['-xzf', join(temporary, packed[0].filename), '-C', stage, '--strip-components=1'], temporary)
    copyFileSync(join(source, 'pnpm-lock.yaml'), join(stage, 'pnpm-lock.yaml'), constants.COPYFILE_EXCL)
    mkdirSync(join(stage, 'scripts'), { recursive: true })
    for (const name of controls) copyFileSync(join(source, 'scripts', name), join(stage, 'scripts', name), constants.COPYFILE_EXCL)
    for (const directory of ['docs', 'examples']) mkdirSync(join(stage, directory), { recursive: true })
    for (const path of ['docs/runtime-windows.md', 'examples/service.runtime.windows.json', 'examples/deploy-runtime.local.windows.json', 'examples/profile.cordis.patch.yml']) {
      copyFileSync(join(source, path), join(stage, path), constants.COPYFILE_EXCL)
    }
    const files = listFiles(stage)
    for (const path of files) checkPath(path)
    if (!files.includes('package.json') || !files.some(path => path.startsWith('lib/'))) throw new Error('Package must include package.json and built lib')
    const hashes = Object.fromEntries(files.map(path => [path, hash(readFileSync(join(stage, path)))]))
    const manifest = { format: 1, commit, package: { name: pkg.name, version: pkg.version }, files: hashes, buildDependencies: 'Node.js, Git, tar, PowerShell, npm and pinned pnpm; pnpm install requires registry access', targetDependencies: 'Node.js, DSH and package dependencies must be installed separately; dependencies are not included' }
    writeFileSync(join(stage, 'runtime-build.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(`Commit: ${commit}\nFiles:\n${[...files, 'runtime-build.json'].sort().join('\n')}\n`)
    call('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:RUNTIME_STAGE, $env:RUNTIME_ZIP)"], temporary, { RUNTIME_STAGE: stage, RUNTIME_ZIP: zip })
    const filename = `dsh-superagent-runtime-${commit.slice(0, 12)}-${id}.zip`
    published = join(out, filename)
    copyFileSync(zip, published, constants.COPYFILE_EXCL)
    try {
      writeFileSync(`${published}.sha256`, `${hash(readFileSync(published))}  ${filename}\n`, { flag: 'wx' })
    } catch (error) {
      rmSync(published)
      throw error
    }
    return { archive: published, checksum: `${published}.sha256`, manifest }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || args[0] !== '--commit' || args[2] !== '--out') throw new Error('Usage: node scripts/runtime-artifact.mjs --commit <full-commit-id> --out <existing-directory>')
    const result = buildRuntime({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), commit: args[1], out: args[3] })
    process.stdout.write(`Archive: ${result.archive}\nSHA256: ${result.checksum}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
