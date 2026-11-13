import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { WorkspaceRefJournal } from '../src/app/workspace-journal.ts'
import { cleanupLocalRef, type LocalRefCleanupRun } from '../src/executor/ref-cleanup.ts'
import { gitEnv } from './fixtures/git.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('durably records each intent once and refuses duplicate or unresolved resources after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-journal-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite')
  const intent = { cwd: '/verified/repository', ref: 'refs/dsh-superagent/ticket', expectedOid: 'a'.repeat(40),
    operationId: 'operation-1', creationEvidence: 'evidence-1', retainedRef: 'refs/dsh-superagent-retained/ticket/operation-1' }
  const store = new Store(path)
  const journal = new WorkspaceRefJournal(store, 'repository-identity')
  expect(await journal.begin(intent)).toBe('created')
  expect(await journal.begin(intent)).toBe('exists')
  expect(await journal.begin({ ...intent, operationId: 'operation-2' })).toBe('exists')
  store.close()
  const reopened = new Store(path)
  try {
    const next = new WorkspaceRefJournal(reopened, 'repository-identity')
    expect(await next.begin({ ...intent, operationId: 'operation-3' })).toBe('exists')
    await expect(next.finish({ ...intent, expectedOid: 'b'.repeat(40) }, { status: 'deleted', retainedRef: intent.retainedRef })).rejects.toThrow()
    await next.finish(intent, { status: 'unknown', reason: 'response lost', retainedRef: intent.retainedRef })
    await expect(next.finish(intent, { status: 'deleted', retainedRef: intent.retainedRef })).rejects.toThrow()
    expect(reopened.db.prepare('SELECT kind FROM workspace_ref_event ORDER BY seq').all().map(row => row.kind)).toEqual(['intent', 'result'])
    expect(await next.begin({ ...intent, operationId: 'operation-4' })).toBe('exists')
  } finally { reopened.close() }
})

it('keeps the protected object and records a real conditional deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-journal-git-'))
  directories.push(directory)
  const exec = promisify(execFile)
  const template = join(directory, 'template')
  mkdirSync(template)
  const env = { ...gitEnv(), HOME: directory, XDG_CONFIG_HOME: directory, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_ASKPASS: '' }
  const git = async (...args: string[]) => (await exec('git', args, { cwd: directory, env, windowsHide: true })).stdout.trim()
  await git('init', '-q')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial')
  const oid = await git('rev-parse', 'HEAD')
  await git('update-ref', 'refs/dsh-superagent/ticket', oid)
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const journal = new WorkspaceRefJournal(store, `repository:${directory}`)
    const run: LocalRefCleanupRun = async (args, cwd) => {
      try { return { exitCode: 0, stdout: (await exec('git', args, { cwd, env, windowsHide: true })).stdout } }
      catch (error) {
        const failure = error as Error & { code?: number; stdout?: string }
        if (typeof failure.code !== 'number') throw error
        return { exitCode: failure.code, stdout: failure.stdout ?? '' }
      }
    }
    const result = await cleanupLocalRef({ cwd: directory, ref: 'refs/dsh-superagent/ticket', expectedOid: oid,
      operationId: 'operation-1', creationEvidence: 'fixture' }, { run, guard: () => true, journal })
    expect(result).toEqual({ status: 'deleted', retainedRef: 'refs/dsh-superagent-retained/ticket/operation-1' })
    expect(await git('rev-parse', '--verify', result.status === 'deleted' ? result.retainedRef : '')).toBe(oid)
    expect(store.db.prepare('SELECT kind FROM workspace_ref_event ORDER BY seq').all().map(row => row.kind)).toEqual(['intent', 'result'])
  } finally { store.close() }
})

it('rejects an empty repository identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-journal-'))
  directories.push(directory)
  const store = new Store(join(directory, 'state.sqlite'))
  try { expect(() => new WorkspaceRefJournal(store, ' ')).toThrow('repository identity') } finally { store.close() }
})
