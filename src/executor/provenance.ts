import { execFile } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { ticketBranch, ticketRef } from './workspace.ts'

export interface CreationProvenance {
  generation: string
  repository: string
  directory: string
  branch: string
  ref: string
  status: 'unknown' | 'verified'
  preflight?: { commonDir: string; branchAbsent: true; refAbsent: true }
  worktreeGitDir?: string
  commonIdentity?: { device: string; inode: string }
  worktreeIdentity?: { device: string; inode: string }
  branchOid?: string
  refOid?: string
}

const exec = promisify(execFile)
export async function isolatedGit(argv: string[], cwd: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' })
  const result = await exec('git', argv, { cwd, env, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (result.stderr.trim()) throw new Error('Git emitted a diagnostic')
  return result.stdout
}

type Runner = typeof isolatedGit
export async function pathIdentity(path: string): Promise<{ device: string; inode: string } | undefined> {
  const info = await stat(path, { bigint: true })
  return info.isDirectory() && info.ino !== 0n ? { device: String(info.dev), inode: String(info.ino) } : undefined
}
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
async function refs(run: Runner, cwd: string, names: string[]): Promise<Map<string, string>> {
  const output = await run(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ...names], cwd)
  const result = new Map<string, string>()
  for (const line of output.split('\n').filter(Boolean)) {
    const match = /^(\S+) ([a-f0-9]+) (\S*)$/.exec(line)
    if (!match || match[3] || !oidPattern.test(match[2]!)) throw new Error('Invalid ref listing')
    if (names.includes(match[1]!)) result.set(match[1]!, match[2]!)
  }
  return result
}
async function absoluteGitPath(run: Runner, cwd: string, option: string): Promise<string> {
  const value = (await run(['rev-parse', '--path-format=absolute', option], cwd)).trim()
  if (!isAbsolute(value)) throw new Error('Invalid Git path')
  return realpath(value)
}
export function newProvenance(generation: string, repository: string, directory: string, name: string, id: string): CreationProvenance {
  return { generation, repository, directory, branch: `refs/heads/${ticketBranch(name)}`, ref: ticketRef(id), status: 'unknown' }
}
export async function preflightCreation(value: CreationProvenance, run: Runner = isolatedGit): Promise<CreationProvenance> {
  try {
    const commonDir = await absoluteGitPath(run, value.repository, '--git-common-dir')
    for (const name of [value.branch, value.ref]) {
      try { await run(['show-ref', '--exists', name], value.repository); return value }
      catch (error) {
        const failure = error as { code?: unknown; stderr?: unknown; killed?: boolean; signal?: unknown }
        if (failure.code !== 2 || failure.killed || failure.signal || typeof failure.stderr !== 'string'
          || failure.stderr.trim() !== 'error: reference does not exist') return value
      }
    }
    return { ...value, preflight: { commonDir, branchAbsent: true, refAbsent: true } }
  } catch { return value }
}
export async function verifyCreation(value: CreationProvenance, run: Runner = isolatedGit): Promise<CreationProvenance> {
  if (!value.preflight) return value
  try {
    const directory = await realpath(value.directory)
    if (!(await lstat(value.directory)).isDirectory() || !(await lstat(join(directory, '.git'))).isFile()) return value
    const commonDir = await absoluteGitPath(run, directory, '--git-common-dir')
    const worktreeGitDir = await absoluteGitPath(run, directory, '--git-dir')
    if (commonDir !== value.preflight.commonDir || commonDir === worktreeGitDir
      || await realpath(dirname(worktreeGitDir)) !== await realpath(join(commonDir, 'worktrees'))
      || await absoluteGitPath(run, value.repository, '--git-common-dir') !== commonDir) return value
    const top = (await run(['rev-parse', '--path-format=absolute', '--show-toplevel'], directory)).trim()
    if (!isAbsolute(top) || await realpath(top) !== directory) return value
    const branch = (await run(['symbolic-ref', '--quiet', 'HEAD'], directory)).trim()
    if (branch !== value.branch) return value
    const listing = await run(['worktree', 'list', '--porcelain', '-z'], value.repository)
    const entries = listing.split('\0\0').map(entry => entry.split('\0'))
    let registered = false
    for (const entry of entries) {
      const path = entry.find(field => field.startsWith('worktree '))?.slice('worktree '.length)
      if (path && entry.includes(`branch ${value.branch}`) && await realpath(path) === directory) registered = true
    }
    if (!registered) return value
    const found = await refs(run, value.repository, [value.branch, value.ref])
    const branchOid = found.get(value.branch), refOid = found.get(value.ref)
    if (!branchOid || !refOid) return value
    for (const [name, oid] of [[value.branch, branchOid], [value.ref, refOid]]) {
      const resolved = (await run(['rev-parse', '--verify', `${name}^{object}`], value.repository)).trim()
      if (resolved !== oid) return value
    }
    const commonIdentity = await pathIdentity(commonDir), worktreeIdentity = await pathIdentity(worktreeGitDir)
    if (!commonIdentity || !worktreeIdentity) return value
    return { ...value, status: 'verified', worktreeGitDir, commonIdentity, worktreeIdentity, branchOid, refOid }
  } catch { return value }
}
