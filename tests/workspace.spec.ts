/** Reclaiming a finished Ticket's git worktree and local branch, against real git repositories. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reclaimWorkspace, ticketBranch, ticketRef, type GitRun } from '../src/executor/workspace.ts'
import { gitEnv } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'workspace-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** Run git as the worker does, without the test process's repository-locating variables. */
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd, env: gitEnv(), timeout: 20_000, windowsHide: true })).stdout
const run: GitRun = async (argv, cwd) => (await exec('git', argv, { cwd, env: gitEnv(), timeout: 20_000, windowsHide: true })).stdout

/** A repository with a bare remote, its main branch pushed, and a parent directory for worktrees. */
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
/** Add a linked worktree on the Ticket's branch, named after `name`. */
async function worktree(main: string, name: string, branch = ticketBranch(name), start = 'HEAD'): Promise<string> {
  const path = join(directory, 'worktrees', name)
  await git(main, 'worktree', 'add', '-b', branch, path, start)
  return path
}
/** Commit everything in a worktree with the configured identity. */
const commit = (cwd: string, message: string) => git(cwd, ...IDENTITY, 'commit', '-am', message)

describe('reclaiming a finished workspace', () => {
  it('removes a clean linked worktree on the Ticket branch and deletes that local branch', async () => {
    const { main } = await repository()
    const name = 'fix-abcdef123456'
    const path = await worktree(main, name)
    const result = await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path }, () => true)
    expect(result).toMatchObject({ status: 'reclaimed', branch: ticketBranch(name) })
    expect(existsSync(path)).toBe(false)
    expect((await git(main, 'branch', '--list', ticketBranch(name))).trim()).toBe('')
  })

  it('keeps a worktree with uncommitted or untracked changes', async () => {
    const { main } = await repository()
    const name = 'fix-abcdef123456'
    const path = await worktree(main, name)
    writeFileSync(join(path, 'draft.txt'), 'not committed\n')
    const result = await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path }, () => true)
    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining('uncommitted') })
    expect(existsSync(join(path, 'draft.txt'))).toBe(true)
    expect((await git(main, 'branch', '--list', ticketBranch(name))).trim()).not.toBe('')
  })

  it('keeps a worktree whose commits are not on any remote ref', async () => {
    const { main } = await repository()
    const name = 'fix-abcdef123456'
    const path = await worktree(main, name)
    writeFileSync(join(path, 'README.md'), 'local change\n')
    await commit(path, 'local only')
    const result = await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path }, () => true)
    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining('not on a remote') })
    expect(existsSync(path)).toBe(true)
  })

  it('removes a worktree whose branch, including its commits, was pushed to the remote, and deletes that remote branch', async () => {
    const { main, remote } = await repository()
    const name = 'fix-abcdef123456'
    const path = await worktree(main, name)
    writeFileSync(join(path, 'README.md'), 'pushed change\n')
    await commit(path, 'pushed')
    await git(path, 'push', '-u', 'origin', ticketBranch(name))
    const result = await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path, remote: { url: remote } }, () => true)
    expect(result).toMatchObject({ status: 'reclaimed' })
    expect(existsSync(path)).toBe(false)
    expect((await git(directory, 'ls-remote', '--heads', remote, ticketBranch(name))).trim()).toBe('')
  })

  it('keeps a remote branch someone else moved on, though it still reclaims the local worktree', async () => {
    const { main, remote } = await repository()
    const name = 'fix-abcdef123456'
    const path = await worktree(main, name)
    writeFileSync(join(path, 'README.md'), 'pushed change\n')
    await commit(path, 'pushed')
    await git(path, 'push', '-u', 'origin', ticketBranch(name))
    // Another person pushes a commit on the same remote branch after this checkout.
    await git(main, 'switch', '-c', 'later-work', `origin/${ticketBranch(name)}`)
    writeFileSync(join(main, 'later.txt'), 'later\n')
    await git(main, 'add', '.')
    await commit(main, 'later')
    await git(main, 'push', 'origin', `HEAD:refs/heads/${ticketBranch(name)}`)
    const result = await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path, remote: { url: remote } }, () => true)
    expect(result).toMatchObject({ status: 'reclaimed' })
    expect(existsSync(path)).toBe(false)
    expect((await git(directory, 'ls-remote', '--heads', remote, ticketBranch(name))).trim()).not.toBe('')
  })

  it('treats the Ticket\'s fetched ref as remote, so a worktree based on it is reclaimable', async () => {
    const { main } = await repository()
    const name = 'fix-abcdef123456'
    const base = (await git(main, 'rev-parse', 'HEAD')).trim()
    // A commit only in the local repository, as the prepare command's fetch leaves a pull request head.
    writeFileSync(join(main, 'README.md'), 'fetched base\n')
    await commit(main, 'fetched base')
    const fetched = (await git(main, 'rev-parse', 'HEAD')).trim()
    await git(main, 'update-ref', ticketRef('ticket-1'), fetched)
    const path = await worktree(main, name, ticketBranch(name), fetched)
    expect(fetched).not.toBe(base)
    const result = await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path }, () => true)
    expect(result).toMatchObject({ status: 'reclaimed' })
    expect(existsSync(path)).toBe(false)
  })

  it('keeps a worktree of another branch and a main worktree', async () => {
    const { main } = await repository()
    const name = 'fix-abcdef123456'
    const other = await worktree(main, 'other', 'someone-else')
    expect(await reclaimWorkspace(run, { id: 'ticket-1', name, directory: other }, () => true))
      .toMatchObject({ status: 'skipped', reason: expect.stringContaining('not agent/') })
    // A main checkout on the expected branch is still not a linked worktree.
    const solo = join(directory, 'solo')
    await git(directory, 'init', '-b', ticketBranch(name), solo)
    writeFileSync(join(solo, 'README.md'), 'main checkout\n')
    await git(solo, 'add', '.')
    await git(solo, ...IDENTITY, 'commit', '-m', 'init')
    expect(await reclaimWorkspace(run, { id: 'ticket-1', name, directory: solo }, () => true))
      .toMatchObject({ status: 'skipped', reason: expect.stringContaining('main worktree') })
    expect(existsSync(main)).toBe(true)
    expect(existsSync(solo)).toBe(true)
  })

  it('keeps the worktree when the Ticket is running again, and reports an absent directory', async () => {
    const { main } = await repository()
    const name = 'fix-abcdef123456'
    const path = await worktree(main, name)
    expect(await reclaimWorkspace(run, { id: 'ticket-1', name, directory: path }, () => false))
      .toMatchObject({ status: 'skipped', reason: expect.stringContaining('running again') })
    expect(existsSync(path)).toBe(true)
    expect(await reclaimWorkspace(run, { id: 'ticket-1', name, directory: join(directory, 'gone') }, () => true))
      .toEqual({ status: 'absent' })
    // A directory a prepare command created without a checkout stays.
    const empty = join(directory, 'empty')
    mkdirSync(empty)
    expect(await reclaimWorkspace(run, { id: 'ticket-1', name, directory: empty }, () => true))
      .toMatchObject({ status: 'skipped', reason: expect.stringContaining('not a git checkout') })
  })
})