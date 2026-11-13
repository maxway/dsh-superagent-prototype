import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupLocalRef, type LocalRefCleanupDependencies, type LocalRefCleanupResult, type LocalRefCleanupRun } from '../src/executor/ref-cleanup.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const ref = 'refs/dsh-superagent/ticket-1'
const retained = 'refs/dsh-superagent-retained/ticket-1/operation-1'
let directory: string
let repo: string
let env: NodeJS.ProcessEnv
let first: string
let second: string
let dependencies: LocalRefCleanupDependencies
let records: Map<string, LocalRefCleanupResult | undefined>

const run: LocalRefCleanupRun = async (args, cwd) => {
  try {
    const result = await exec('git', args, { cwd, env, windowsHide: true })
    return { exitCode: 0, stdout: result.stdout }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    if (typeof failure.code !== 'number') throw error
    return { exitCode: failure.code, stdout: failure.stdout ?? '' }
  }
}
const git = async (...args: string[]) => {
  const result = await run(args, repo)
  if (result.exitCode !== 0) throw new Error(`git failed: ${args.join(' ')}`)
  return result.stdout.trim()
}
const readRef = async (name: string) => {
  const result = await run(['show-ref', '--verify', '--hash', name], repo)
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}
const request = () => ({ cwd: repo, ref, expectedOid: first, operationId: 'operation-1', creationEvidence: 'recorded-creation-1' })

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ref-cleanup-'))
  repo = join(directory, 'repo')
  const home = join(directory, 'home')
  const template = join(directory, 'template')
  mkdirSync(repo)
  mkdirSync(home)
  mkdirSync(template)
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'config'), GIT_TEMPLATE_DIR: template })
  await git('init', '--quiet')
  writeFileSync(join(repo, 'first'), 'first')
  writeFileSync(join(repo, 'second'), 'second')
  await git('add', 'first')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'first')
  first = await git('rev-parse', 'HEAD')
  await git('add', 'second')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'second')
  second = await git('rev-parse', 'HEAD')
  await git('update-ref', ref, first)
  await git('update-ref', 'refs/heads/unrelated', first)
  await git('update-ref', 'refs/dsh-superagent/other', second)
  records = new Map()
  dependencies = {
    run,
    guard: intent => intent.creationEvidence === 'recorded-creation-1',
    journal: {
      begin: async intent => {
        if (records.has(intent.operationId) || [...records.values()].some(value => !value || value.status === 'unknown')) return 'exists'
        records.set(intent.operationId, undefined)
        return 'created'
      },
      finish: async (intent, result) => { records.set(intent.operationId, result) },
    },
  }
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('local ticket ref cleanup', () => {
  it('records intent and result, retains the object, and touches no other refs', async () => {
    const invoke: LocalRefCleanupRun = async (args, cwd) => {
      expect(records.has('operation-1')).toBe(true)
      expect(records.get('operation-1')).toBeUndefined()
      return run(args, cwd)
    }
    dependencies.run = invoke
    const result = await cleanupLocalRef(request(), dependencies)
    expect(result).toEqual({ status: 'deleted', retainedRef: retained })
    expect(records.get('operation-1')).toEqual(result)
    expect(await readRef(ref)).toBeUndefined()
    expect(await readRef(retained)).toBe(first)
    expect(await readRef('refs/heads/unrelated')).toBe(first)
    expect(await readRef('refs/dsh-superagent/other')).toBe(second)
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed', reason: expect.stringContaining('reconciliation') })
  })

  it('preserves a ref and its history when a reflog exists even if its current object is protected', async () => {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
    await git(...identity, 'update-ref', '--create-reflog', ref, second, first)
    await git(...identity, 'update-ref', ref, first, second)
    const otherProtection = 'refs/dsh-superagent-retained/existing/protected'
    await git('update-ref', otherProtection, first)
    const history = await git('reflog', 'show', '--format=%H', ref)
    expect(history.split(/\r?\n/)).toEqual([first, second])
    const result = await cleanupLocalRef(request(), dependencies)
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('reflog') })
    expect(records.get('operation-1')).toEqual(result)
    expect(await readRef(ref)).toBe(first)
    expect(await git('reflog', 'show', '--format=%H', ref)).toBe(history)
    expect(await readRef(otherProtection)).toBe(first)
    expect(await readRef(retained)).toBeUndefined()
  })

  it('treats a reflog inspection error as unknown without writing refs', async () => {
    const invoke = vi.fn(async (args: string[], cwd: string) => args[0] === 'reflog' ? { exitCode: 2, stdout: '' } : run(args, cwd))
    dependencies.run = invoke
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('reflog') })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await readRef(ref)).toBe(first)
    expect(await readRef(retained)).toBeUndefined()
  })

  it('requires creation evidence, authorization, and all injected dependencies before Git', async () => {
    const invoke = vi.fn(run)
    dependencies.run = invoke
    expect(await cleanupLocalRef({ ...request(), creationEvidence: '' }, dependencies)).toMatchObject({ status: 'failed' })
    expect(await cleanupLocalRef({ ...request(), creationEvidence: 'untrusted' }, dependencies)).toMatchObject({ status: 'failed' })
    dependencies.guard = () => { throw new Error('unavailable') }
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await cleanupLocalRef(request(), undefined as unknown as LocalRefCleanupDependencies)).toMatchObject({ status: 'failed' })
    expect(invoke).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })

  it('records failure if authorization changes after intent', async () => {
    let count = 0
    dependencies.guard = () => ++count === 1
    dependencies.run = vi.fn(run)
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(dependencies.run).not.toHaveBeenCalled()
    expect(records.get('operation-1')).toMatchObject({ status: 'failed' })
  })

  it('never overwrites an existing direct or dangling symbolic retention ref', async () => {
    await git('symbolic-ref', retained, 'refs/heads/missing')
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await git('symbolic-ref', retained)).toBe('refs/heads/missing')
    expect(await readRef(ref)).toBe(first)
    await git('symbolic-ref', '--delete', retained)
    await git('update-ref', retained, second)
    records.clear()
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown' })
    expect(await readRef(retained)).toBe(second)
    expect(await readRef(ref)).toBe(first)
  })

  it('preserves target and protection if target changes before verification', async () => {
    dependencies.run = async (args, cwd) => {
      if (args[0] === 'for-each-ref') await git('update-ref', ref, second, first)
      return run(args, cwd)
    }
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await readRef(ref)).toBe(second)
    expect(await readRef(retained)).toBe(first)
  })

  it('refuses deletion if the retention ref changes before verification', async () => {
    dependencies.run = async (args, cwd) => {
      if (args[0] === 'for-each-ref') await git('update-ref', retained, second, first)
      return run(args, cwd)
    }
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await readRef(ref)).toBe(first)
    expect(await readRef(retained)).toBe(second)
  })

  it('stops after preservation if authorization is revoked', async () => {
    let count = 0
    dependencies.guard = () => ++count < 3
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await readRef(ref)).toBe(first)
    expect(await readRef(retained)).toBe(first)
  })

  it('uses CAS if the target changes after verification', async () => {
    dependencies.run = async (args, cwd) => {
      if (args.includes('-d')) await git('update-ref', ref, second, first)
      return run(args, cwd)
    }
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown' })
    expect(await readRef(ref)).toBe(second)
    expect(await readRef(retained)).toBe(first)
    expect(await cleanupLocalRef({ ...request(), operationId: 'other' }, dependencies)).toMatchObject({ status: 'failed' })
  })

  it('preserves protection on delete failure and refuses blind retry', async () => {
    dependencies.run = async (args, cwd) => args.includes('-d') ? { exitCode: 1, stdout: '' } : run(args, cwd)
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown' })
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await readRef(ref)).toBe(first)
    expect(await readRef(retained)).toBe(first)
  })

  it('keeps protection and requires reconciliation if creation confirmation is lost', async () => {
    dependencies.run = async (args, cwd) => {
      const result = await run(args, cwd)
      if (args[0] === 'update-ref') throw new Error('lost creation confirmation')
      return result
    }
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown' })
    expect(await readRef(ref)).toBe(first)
    expect(await readRef(retained)).toBe(first)
    expect(await cleanupLocalRef({ ...request(), operationId: 'other' }, dependencies)).toMatchObject({ status: 'failed' })
  })

  it('rejects an unfinished intent even with a new operation id', async () => {
    records.set('crashed-operation', undefined)
    dependencies.run = vi.fn(run)
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed', reason: expect.stringContaining('reconciliation') })
    expect(dependencies.run).not.toHaveBeenCalled()
  })

  it('treats an unconfirmed journal result as unknown and blocks retry after deletion', async () => {
    dependencies.journal.finish = async () => { throw new Error('crash before result persisted') }
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown' })
    expect(await readRef(ref)).toBeUndefined()
    expect(await readRef(retained)).toBe(first)
    expect(await cleanupLocalRef({ ...request(), operationId: 'other' }, dependencies)).toMatchObject({ status: 'failed' })
  })

  it('does not run Git when intent persistence is uncertain', async () => {
    dependencies.journal.begin = async intent => { records.set(intent.operationId, undefined); throw new Error('lost confirmation') }
    dependencies.run = vi.fn(run)
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'unknown' })
    expect(dependencies.run).not.toHaveBeenCalled()
    expect(records.has('operation-1')).toBe(true)
  })

  it('rejects symbolic target refs without affecting their referents', async () => {
    await git('update-ref', '-d', ref)
    await git('symbolic-ref', ref, 'refs/heads/unrelated')
    expect(await cleanupLocalRef(request(), dependencies)).toMatchObject({ status: 'failed' })
    expect(await readRef('refs/heads/unrelated')).toBe(first)
    expect(await readRef(retained)).toBe(first)
  })

  it('rejects malformed inputs without Git or journal writes', async () => {
    dependencies.run = vi.fn(run)
    for (const patch of [
      { ref: 'refs/heads/main' }, { ref: 'refs/dsh-superagent/ticket/child' },
      { ref: 'refs/dsh-superagent/-ticket' }, { ref: 'refs/dsh-superagent/ticket.lock' },
      { ref: 'refs/dsh-superagent/ticket\n--help' }, { expectedOid: '0'.repeat(40) },
      { expectedOid: first.toUpperCase() }, { expectedOid: `${first}x` },
      { operationId: '../other' }, { operationId: '-option' }, { cwd: '\0' },
    ]) expect(await cleanupLocalRef({ ...request(), ...patch }, dependencies)).toMatchObject({ status: 'failed' })
    expect(dependencies.run).not.toHaveBeenCalled()
    expect(records.size).toBe(0)
  })
})
