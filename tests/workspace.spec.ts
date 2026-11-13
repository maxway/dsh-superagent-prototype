import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reclaimWorkspace, ticketBranch, ticketRef, type GitRun } from '../src/executor/workspace.ts'
import { gitEnv } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
const name = 'fix-abcdef123456'
const id = 'ticket-1'
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'workspace-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd, env: gitEnv(), timeout: 20_000, windowsHide: true })).stdout
const run: GitRun = async (argv, cwd) => git(cwd, ...argv)

async function repository() {
  const main = join(directory, 'main'), remote = join(directory, 'remote.git')
  mkdirSync(join(directory, 'worktrees'))
  await git(directory, 'init', '--bare', remote)
  await git(directory, 'init', '-b', 'main', main)
  writeFileSync(join(main, 'README.md'), 'readme\n')
  await git(main, 'add', '.')
  await git(main, ...IDENTITY, 'commit', '-m', 'init')
  await git(main, 'remote', 'add', 'origin', remote)
  await git(main, 'push', '-u', 'origin', 'main')
  return { main, remote }
}

async function worktree(main: string, branch = ticketBranch(name), start = 'HEAD'): Promise<string> {
  const path = join(directory, 'worktrees', 'ticket')
  await git(main, 'worktree', 'add', '-b', branch, path, start)
  return path
}

const target = (path: string) => ({ id, name, directory: path })
const oid = async (cwd: string, ref: string) => (await git(cwd, 'rev-parse', '--verify', ref)).trim()
const state = (value: string) => ({ state: value, reason: expect.any(String) })

describe('read-only workspace inventory', () => {
  it('reports and preserves a clean linked worktree and its local branch', async () => {
    const { main } = await repository()
    const path = await worktree(main)
    const head = await oid(path, 'HEAD')
    const result = await reclaimWorkspace(run, target(path), () => true)
    expect(result).toMatchObject({
      status: 'skipped', reason: expect.stringContaining('disabled'),
      report: {
        directory: resolve(path), branch: ticketBranch(name), commonDir: resolve(main, '.git'), head,
        worktree: { ...state('present'), reason: expect.stringContaining('expected branch') },
        localBranch: { ...state('present'), oid: head }, ticketRef: state('unknown'),
        remoteBranch: state('unknown'), changes: state('unknown'), ignored: state('unknown'),
      },
    })
    expect(existsSync(path)).toBe(true)
    expect(await oid(main, `refs/heads/${ticketBranch(name)}`)).toBe(head)
    expect(await git(main, 'worktree', 'list', '--porcelain')).toContain(path.replaceAll('\\', '/'))
  })

  it('reports and preserves tracked, untracked, and ignored files', async () => {
    const { main } = await repository()
    const path = await worktree(main)
    writeFileSync(join(path, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(path, 'README.md'), 'dirty\n')
    writeFileSync(join(path, 'draft.txt'), 'untracked\n')
    writeFileSync(join(path, 'ignored.txt'), 'ignored\n')
    const before = await git(path, 'status', '--porcelain', '--untracked-files=all')
    const result = await reclaimWorkspace(run, target(path), () => true)
    expect(result).toMatchObject({ status: 'skipped', report: { changes: state('unknown'), ignored: state('present') } })
    expect(await git(path, 'status', '--porcelain', '--untracked-files=all')).toBe(before)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('dirty\n')
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('untracked\n')
    expect(readFileSync(join(path, 'ignored.txt'), 'utf8')).toBe('ignored\n')
    expect(await oid(main, `refs/heads/${ticketBranch(name)}`)).toBe(await oid(path, 'HEAD'))
  })

  it('does not claim ignored data is absent when Git omits an empty ignored directory', async () => {
    const { main } = await repository()
    const path = await worktree(main)
    writeFileSync(join(path, '.gitignore'), 'cache/\n')
    mkdirSync(join(path, 'cache'))
    const result = await reclaimWorkspace(run, target(path), () => true)
    expect(result.report.ignored).toMatchObject({ state: 'unknown', reason: expect.stringContaining('empty directories') })
    expect(existsSync(join(path, 'cache'))).toBe(true)
  })

  it('does not execute repository clean filters during automatic inventory', async () => {
    const { main } = await repository()
    const path = await worktree(main)
    const marker = join(directory, 'filter-ran')
    const command = `"${process.execPath.replaceAll('\\', '/')}" -e "require('node:fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'ran')"`
    await git(main, 'config', 'filter.inventory-test.clean', command)
    writeFileSync(join(path, '.gitattributes'), 'README.md filter=inventory-test\n')
    writeFileSync(join(path, 'README.md'), 'changed\n')
    const commands: string[][] = []
    const checked: GitRun = (argv, cwd) => { commands.push(argv); return run(argv, cwd) }
    await reclaimWorkspace(checked, target(path), () => true)
    expect(existsSync(marker)).toBe(false)
    expect(commands.some(argv => argv[0] === 'status')).toBe(false)
    await git(path, 'status', '--porcelain')
    expect(existsSync(marker)).toBe(true)
  })

  it('reports and preserves a fetched ticket ref, local commits and the remote branch', async () => {
    const { main, remote } = await repository()
    const path = await worktree(main)
    writeFileSync(join(path, 'README.md'), 'pushed\n')
    await git(path, ...IDENTITY, 'commit', '-am', 'pushed')
    const pushed = await oid(path, 'HEAD')
    await git(path, 'push', 'origin', `HEAD:refs/heads/${ticketBranch(name)}`)
    await git(main, 'fetch', 'origin', `refs/heads/${ticketBranch(name)}:${ticketRef(id)}`)
    writeFileSync(join(path, 'README.md'), 'local only\n')
    await git(path, ...IDENTITY, 'commit', '-am', 'local only')
    const head = await oid(path, 'HEAD')
    const result = await reclaimWorkspace(run, { ...target(path), remote: { url: remote } }, () => true)
    expect(result).toMatchObject({ status: 'skipped', report: {
      head, worktree: state('present'), localBranch: { ...state('present'), oid: head },
      ticketRef: { ...state('present'), oid: pushed }, remoteBranch: state('unknown'), changes: state('unknown'),
    } })
    expect(existsSync(path)).toBe(true)
    expect(await oid(main, `refs/heads/${ticketBranch(name)}`)).toBe(head)
    expect(await oid(main, ticketRef(id))).toBe(pushed)
    expect((await git(directory, 'ls-remote', '--heads', remote, ticketBranch(name))).trim()).toBe(`${pushed}\trefs/heads/${ticketBranch(name)}`)
  })

  it('does not report a dangling symbolic Ticket ref as absent', async () => {
    const { main } = await repository()
    const path = await worktree(main)
    await git(main, 'symbolic-ref', ticketRef(id), 'refs/heads/missing-target')
    const result = await reclaimWorkspace(run, target(path), () => true)
    expect(result.report.ticketRef).toMatchObject({ state: 'unknown', reason: expect.stringContaining('dangling symbolic ref') })
    expect((await git(main, 'symbolic-ref', ticketRef(id))).trim()).toBe('refs/heads/missing-target')
  })

  it('reports a missing directory without assuming its Git resources are absent', async () => {
    const path = join(directory, 'missing')
    const invoke = vi.fn(run)
    const result = await reclaimWorkspace(invoke, target(path), () => true)
    expect(result).toMatchObject({ status: 'skipped', report: {
      worktree: state('absent'), localBranch: state('unknown'), ticketRef: state('unknown'),
      remoteBranch: state('unknown'), changes: state('unknown'), ignored: state('unknown'),
    } })
    expect(invoke).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it('fails closed for missing and broken Git metadata', async () => {
    const empty = join(directory, 'empty'), broken = join(directory, 'broken')
    mkdirSync(empty)
    mkdirSync(broken)
    writeFileSync(join(broken, '.git'), 'gitdir: nonexistent\n')
    for (const path of [empty, broken]) {
      const result = await reclaimWorkspace(run, target(path), () => true)
      expect(result).toMatchObject({ status: 'skipped', report: {
        worktree: state('unknown'), localBranch: state('unknown'), ticketRef: state('unknown'),
        remoteBranch: state('unknown'), changes: state('unknown'), ignored: state('unknown'),
      } })
      expect(existsSync(path)).toBe(true)
    }
    expect(readFileSync(join(broken, '.git'), 'utf8')).toBe('gitdir: nonexistent\n')
  })

  it('reports a different branch and a main checkout without removing either', async () => {
    const { main } = await repository()
    const path = await worktree(main, 'someone-else')
    const result = await reclaimWorkspace(run, target(path), () => true)
    expect(result).toMatchObject({ status: 'skipped', report: {
      worktree: { ...state('present'), reason: expect.stringContaining('not on the expected branch') },
      localBranch: state('unknown'),
    } })
    expect(await oid(path, 'HEAD')).toBe(await oid(main, 'refs/heads/someone-else'))
    const mainResult = await reclaimWorkspace(run, target(main), () => true)
    expect(mainResult).toMatchObject({ status: 'skipped', report: {
      worktree: { ...state('present'), reason: expect.stringContaining('main checkout') },
    } })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(main)).toBe(true)
  })

  it('fails closed when Git inspection fails, including individual report queries', async () => {
    const { main } = await repository()
    const path = await worktree(main)
    const failed: GitRun = async () => { throw new Error('git failed') }
    const result = await reclaimWorkspace(failed, target(path), () => true)
    expect(result).toMatchObject({ status: 'skipped', report: {
      worktree: state('unknown'), localBranch: state('unknown'), ticketRef: state('unknown'),
      remoteBranch: state('unknown'), changes: state('unknown'), ignored: state('unknown'),
    } })
    const partial: GitRun = async (argv, cwd) => {
      if (['for-each-ref', 'status', 'ls-files'].includes(argv[0] ?? '')) throw new Error('git failed')
      return run(argv, cwd)
    }
    const partialResult = await reclaimWorkspace(partial, target(path), () => true)
    expect(partialResult).toMatchObject({ status: 'skipped', report: {
      worktree: state('present'), localBranch: state('unknown'), ticketRef: state('unknown'),
      remoteBranch: state('unknown'), changes: state('unknown'), ignored: state('unknown'),
    } })
    expect(existsSync(path)).toBe(true)
    expect(await oid(main, `refs/heads/${ticketBranch(name)}`)).toBe(await oid(path, 'HEAD'))
  })

  it('does not mutate resources when the Ticket is running or becomes running during inspection', async () => {
    const { main, remote } = await repository()
    const path = await worktree(main)
    await git(path, 'push', 'origin', `HEAD:refs/heads/${ticketBranch(name)}`)
    const head = await oid(path, 'HEAD')
    await git(main, 'update-ref', ticketRef(id), head)
    writeFileSync(join(path, 'draft.txt'), 'keep\n')
    const invoke = vi.fn(run)
    const stopped = await reclaimWorkspace(invoke, { ...target(path), remote: { url: remote } }, () => false)
    expect(stopped).toMatchObject({ status: 'skipped', reason: expect.stringContaining('running again'), report: { worktree: state('unknown') } })
    expect(invoke).not.toHaveBeenCalled()
    let checks = 0
    const commands: string[][] = []
    const guarded: GitRun = async (argv, cwd) => {
      commands.push(argv)
      if (!['rev-parse', 'symbolic-ref', 'for-each-ref', 'status', 'ls-files'].includes(argv[0] ?? '')) throw new Error(`unexpected Git operation: ${argv.join(' ')}`)
      return run(argv, cwd)
    }
    const changed = await reclaimWorkspace(guarded, { ...target(path), remote: { url: remote } }, () => ++checks === 1)
    expect(changed).toMatchObject({ status: 'skipped', reason: expect.stringContaining('running again'), report: { changes: state('unknown') } })
    expect(checks).toBe(2)
    expect(commands.length).toBeGreaterThan(0)
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('keep\n')
    expect(await oid(main, `refs/heads/${ticketBranch(name)}`)).toBe(head)
    expect(await oid(main, ticketRef(id))).toBe(head)
    expect((await git(directory, 'ls-remote', '--heads', remote, ticketBranch(name))).trim()).toBe(`${head}\trefs/heads/${ticketBranch(name)}`)
  })
})
