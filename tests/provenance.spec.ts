import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newProvenance, preflightCreation, verifyCreation } from '../src/executor/provenance.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { gitEnv } from './fixtures/git.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-provenance-test-'))
  roots.push(root)
  const template = join(root, 'template'), hooks = join(root, 'hooks')
  await mkdir(template)
  await mkdir(hooks)
  const env = gitEnv({ HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1' })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim()
  git(root, 'init', 'repo')
  const repo = join(root, 'repo'), directory = join(root, 'ticket')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
  return { repo, directory, git, value: newProvenance('generation', repo, directory, 'sample', 'ticket-id') }
}
describe('creation provenance', () => {
  it('defaults off and rejects relative repositories', () => {
    expect(ExecutorConfigSchema.parse({}).managedRepository).toBe('')
    expect(ExecutorConfigSchema.safeParse({ managedRepository: 'relative' }).success).toBe(false)
  })
  it('verifies only after both refs were absent and a linked worktree was created', async () => {
    const { repo, directory, value, git } = await fixture()
    const checked = await preflightCreation(value)
    expect(checked.preflight).toMatchObject({ branchAbsent: true, refAbsent: true })
    git(repo, 'worktree', 'add', '-b', 'agent/sample', directory)
    git(repo, 'update-ref', value.ref, 'HEAD')
    const verified = await verifyCreation(checked)
    expect(verified.status).toBe('verified')
    expect(verified.branchOid).toBe(git(repo, 'rev-parse', value.branch))
    expect(verified.refOid).toBe(git(repo, 'rev-parse', value.ref))
    expect(verified.worktreeGitDir).toBeTruthy()
  })
  it('does not claim pre-existing refs or a failed git inspection', async () => {
    const { repo, value, git } = await fixture()
    git(repo, 'update-ref', value.ref, 'HEAD')
    expect((await preflightCreation(value)).preflight).toBeUndefined()
    expect((await preflightCreation(value, async () => { throw new Error('secret') })).preflight).toBeUndefined()
    expect((await verifyCreation(value)).status).toBe('unknown')
  })
  it('does not treat a dangling symbolic ref as absent', async () => {
    const { repo, value, git } = await fixture()
    git(repo, 'symbolic-ref', value.ref, 'refs/heads/missing')
    expect((await preflightCreation(value)).preflight).toBeUndefined()
  })
  it('rejects a different branch after a successful preflight', async () => {
    const { repo, directory, value, git } = await fixture()
    const checked = await preflightCreation(value)
    git(repo, 'worktree', 'add', '-b', 'other', directory)
    git(repo, 'branch', 'agent/sample')
    git(repo, 'update-ref', value.ref, 'HEAD')
    expect((await verifyCreation(checked)).status).toBe('unknown')
  })
})
