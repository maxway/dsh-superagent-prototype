import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, resolveGitlabDeployment, type Machine, type Probe } from '../src/deployment.ts'
import { gitProvider, setupChanged, sourceSwitched } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub or GitLab Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', git: { provider: 'github', host: 'github.com', cli: join(dir, 'bin', 'gh'),
      login: 'Agent-Bot', commitEmail: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.git).toEqual({ provider: 'github', host: 'github.com', cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot',
      commitEmail: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
  it('restarts setup when a Git Source is switched on or off, even when its fields stay the same', () => {
    const base = SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
      gitlab: { enabled: false, config: { repository: 'acme/widgets', cli: 'glab' } } } })
    const switched = SettingsSchema.parse({ sources: { ...base.sources, github: { enabled: false, config: base.sources.github!.config },
      gitlab: { enabled: true, config: base.sources.gitlab!.config } } })
    expect(sourceSwitched(base, switched)).toBe(true)
    expect(setupChanged(base, switched)).toBe(false)
    const moved = SettingsSchema.parse({ sources: { ...base.sources, gitlab: { enabled: false, config: { ...base.sources.gitlab!.config, host: 'https://gitlab.example.com' } } } })
    expect(setupChanged(base, moved)).toBe(true)
    expect(sourceSwitched(base, moved)).toBe(false)
  })
  it('uses the one enabled Git Source, and refuses none or an ambiguous pair', () => {
    const settings = (sources: Record<string, unknown>) => SettingsSchema.parse({ sources })
    expect(gitProvider(settings({}))).toBe('github')
    expect(gitProvider(settings({}), kind => kind === 'gitlab')).toBe('gitlab')
    expect(gitProvider(settings({ github: { enabled: false, config: {} } }), kind => kind === 'gitlab')).toBe('gitlab')
    expect(() => gitProvider(settings({ gitlab: { enabled: false, config: {} } }), kind => kind === 'gitlab')).toThrow('No Git Source')
    expect(gitProvider(settings({ gitlab: { enabled: true, config: { repository: 'acme/widgets', cli: 'glab' } } }))).toBe('gitlab')
    expect(gitProvider(settings({ github: { enabled: false, config: {} }, gitlab: { enabled: true, config: {} } }))).toBe('gitlab')
    expect(() => gitProvider(settings({ github: { enabled: false, config: {} }, gitlab: { enabled: false, config: {} } }))).toThrow('No Git Source')
    expect(() => gitProvider(settings({ github: { enabled: true, config: {} }, gitlab: { enabled: true, config: {} } }))).toThrow('Both the GitHub and GitLab')
    expect(gitProvider(settings({ github: { enabled: true, config: {} }, gitlab: { enabled: true, config: { repository: 'acme/widgets', cli: 'glab' } } }))).toBe('gitlab')
    expect(() => gitProvider(settings({ github: { enabled: true, config: { repository: 'acme/gadgets', cli: 'gh' } },
      gitlab: { enabled: true, config: { repository: 'acme/widgets', cli: 'glab' } } }))).toThrow('Both the GitHub and GitLab')
  })
  it('reads the GitLab project and account from glab, including a self-managed host and a renamed project', async () => {
    const glab = (file: string, access = 30): string => program(file, `case "$*" in\n  "api user") echo '{"id":7,"username":"agent-bot","email":null}' ;;\n  "api projects/"*) echo '{"id":42,"path_with_namespace":"acme/widgets","default_branch":"main","permissions":{"project_access":{"access_level":${access}}}}' ;;\n  *) exit 1 ;;\nesac`)
    glab(join(dir, 'bin', 'glab'))
    const deployment = await resolveGitlabDeployment(machine(), { host: 'https://gitlab.example.com:8443/', repository: 'acme/gadgets', cli: 'glab' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', gitlab: { host: 'https://gitlab.example.com:8443', projectId: 42, defaultBranch: 'main' },
      git: { provider: 'gitlab', host: 'gitlab.example.com:8443', cli: join(dir, 'bin', 'glab'), login: 'agent-bot',
        commitEmail: '7-agent-bot@gitlab.example.com' } })
    glab(join(dir, 'bin', 'glab-reader'), 20)
    const needs = (place: string, code: string, values: Record<string, unknown>, gitlab: unknown) =>
      expect(resolveGitlabDeployment(machine(), gitlab, probe, path)).rejects.toEqual(setupError(place, code, values))
    await needs('gitlab', 'gitlabRepositoryUnset', {}, { cli: 'glab' })
    await needs('gitlab', 'gitlabCliUnset', {}, { repository: 'acme/widgets' })
    await needs('gitlab', 'gitlabHostInvalid', { host: 'not-a-url' }, { repository: 'acme/widgets', cli: 'glab', host: 'not-a-url' })
    await needs('gitlab', 'gitlabProjectReadOnly', { account: 'agent-bot', repository: 'acme/widgets' }, { repository: 'acme/widgets', cli: join(dir, 'bin', 'glab-reader') })
    await needs('gitlab', 'gitlabCliMissing', { output: expect.stringContaining('is not an executable file') }, { repository: 'acme/widgets', cli: join(dir, 'bin', 'missing') })
    await needs('gitlab', 'gitlabCliSignedOut', { output: expect.stringContaining('Command failed') }, { repository: 'acme/widgets', cli: program(join(dir, 'bin', 'glab-broken'), 'exit 1') })
  })
})
