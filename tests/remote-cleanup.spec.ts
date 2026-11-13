import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteRemoteBranch, type RemoteDeletion, type TrustedRemoteDeletionRun } from '../src/executor/remote-cleanup.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const ref = 'refs/heads/agent/ticket'
const otherRefs = ['refs/heads/agent/ticket-other', 'refs/heads/agent/other', 'refs/tags/ticket']
let directory: string
let env: NodeJS.ProcessEnv
let main: string
let remote: string
let expectedOid: string

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env, windowsHide: true, timeout: 20_000 })).stdout
}

const run: TrustedRemoteDeletionRun = async (args, cwd) => {
  try { return { exitCode: 0, stdout: await git(cwd, ...args) } } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    if (typeof failure.code !== 'number') throw error
    return { exitCode: failure.code, stdout: failure.stdout ?? '' }
  }
}

const target = (): RemoteDeletion => ({ remoteUrl: remote, ref, expectedOid, cwd: main, guard: () => true })
const remoteTip = async (name = ref) => (await git(directory, 'ls-remote', '--', remote, name)).trim()

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'remote-cleanup-'))
  const home = join(directory, 'home'), hooks = join(directory, 'hooks')
  mkdirSync(home)
  mkdirSync(hooks)
  env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: directory, TMP: directory, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'config'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1',
  }
  main = join(directory, 'main')
  remote = join(directory, 'remote.git')
  await git(directory, 'init', '--bare', remote)
  await git(directory, 'init', '-b', 'main', main)
  writeFileSync(join(main, 'file'), 'initial')
  await git(main, 'add', 'file')
  await git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')
  expectedOid = (await git(main, 'rev-parse', 'HEAD')).trim()
  await git(main, 'push', '--', remote, ...[ref, ...otherRefs].map(name => `HEAD:${name}`))
})

afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('remote branch deletion', () => {
  it('deletes only the exact ref with an explicit expected-OID lease', async () => {
    const invoke = vi.fn(run)
    expect(await deleteRemoteBranch(target(), invoke)).toEqual({ status: 'deleted' })
    expect(await remoteTip()).toBe('')
    for (const name of otherRefs) expect(await remoteTip(name)).toBe(`${expectedOid}\t${name}`)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(['push', '--porcelain', `--force-with-lease=${ref}:${expectedOid}`, '--', remote, `:${ref}`], main)
  })

  it('rejects a lease after the server tip advances without ordinary deletion', async () => {
    writeFileSync(join(main, 'file'), 'advanced')
    await git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'advance')
    const advanced = (await git(main, 'rev-parse', 'HEAD')).trim()
    await git(main, 'push', '--', remote, `HEAD:${ref}`)
    const invoke = vi.fn(run)
    expect(await deleteRemoteBranch(target(), invoke)).toMatchObject({ status: 'failed' })
    expect(await remoteTip()).toBe(`${advanced}\t${ref}`)
    for (const name of otherRefs) expect(await remoteTip(name)).toBe(`${expectedOid}\t${name}`)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0]?.[0]).toEqual(['push', '--porcelain', `--force-with-lease=${ref}:${expectedOid}`, '--', remote, `:${ref}`])
  })

  it('checks async and sync guards again immediately before pushing', async () => {
    const guard = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const invoke = vi.fn(run)
    expect(await deleteRemoteBranch({ ...target(), guard }, invoke)).toMatchObject({ status: 'cancelled' })
    expect(guard).toHaveBeenCalledTimes(2)
    expect(await deleteRemoteBranch({ ...target(), guard: () => false }, invoke)).toMatchObject({ status: 'cancelled' })
    expect(await deleteRemoteBranch({ ...target(), guard: () => { throw new Error('cancel') } }, invoke)).toMatchObject({ status: 'cancelled' })
    expect(invoke).not.toHaveBeenCalled()
    expect(await remoteTip()).toBe(`${expectedOid}\t${ref}`)
  })

  it('does not claim success or retry when the remote is missing', async () => {
    const invoke = vi.fn(run)
    expect(await deleteRemoteBranch({ ...target(), remoteUrl: join(directory, 'missing.git') }, invoke)).toMatchObject({ status: 'unknown' })
    expect(invoke).toHaveBeenCalledOnce()
    expect(await remoteTip()).toBe(`${expectedOid}\t${ref}`)
  })

  it('treats unrecognized output, transport failures and timeouts as unknown', async () => {
    for (const result of [
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: `-\t:${ref}\t[unexpected]` },
      { exitCode: 1, stdout: `-\t:${ref}\t[deleted]` },
    ]) expect(await deleteRemoteBranch(target(), async () => result)).toMatchObject({ status: 'unknown' })
    const timeout = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    expect(await deleteRemoteBranch(target(), timeout)).toMatchObject({ status: 'unknown' })
    expect(timeout).toHaveBeenCalledOnce()
    expect(await remoteTip()).toBe(`${expectedOid}\t${ref}`)
  })

  it('rejects invalid refs, OIDs, URL options and absent guard or runner', async () => {
    const invoke = vi.fn(run)
    const invalid = [
      { ref: 'main' }, { ref: 'refs/heads/-bad..name' }, { ref: 'refs/heads/a.lock' },
      { ref: 'refs/heads/a:refs/heads/main' }, { ref: 'refs/heads/a\nother' },
      { expectedOid: 'HEAD' }, { expectedOid: '0'.repeat(40) }, { expectedOid: 'a'.repeat(39) },
      { remoteUrl: '--upload-pack=evil' }, { remoteUrl: 'origin' }, { remoteUrl: 'ext::evil' },
      { guard: undefined },
    ]
    for (const override of invalid) {
      expect(await deleteRemoteBranch({ ...target(), ...override } as RemoteDeletion, invoke)).toMatchObject({ status: 'failed' })
    }
    expect(await deleteRemoteBranch(target(), undefined as unknown as TrustedRemoteDeletionRun)).toMatchObject({ status: 'failed' })
    expect(invoke).not.toHaveBeenCalled()
    expect(await remoteTip()).toBe(`${expectedOid}\t${ref}`)
  })
})
