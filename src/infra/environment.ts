/**
 * Process environment and CLI shims that bind git, the active Git CLI (`gh` or `glab`), and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 *
 * The account layer differs by platform. POSIX keeps the extensionless `#!/bin/sh` shims that redirect the CLIs to wrapper
 * scripts. Native Windows cannot execute those, and forwarding arbitrary argv through `cmd.exe` would corrupt JSON and
 * message text, so a `.cmd` shim exists only for blocked and inactive commands, while `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR`
 * and `LARKSUITE_CLI_CONFIG_DIR` select the agent account for the real executables.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { launch } from './launch.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'glab', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
/**
 * The `credential.helper` command that makes git authenticate through the agent's CLI.
 * Git runs a `!` helper through sh on every platform, and Git for Windows' sh resolves forward slashes, so a Windows
 * executable path is rewritten to them instead of relying on backslash interpretation.
 */
export const credentialHelper = (cli: string, platform: NodeJS.Platform = process.platform): string =>
  `!${shellQuote(platform === 'win32' ? cli.replaceAll('\\', '/') : cli)} auth git-credential`

/** Configuration directories, one per CLI, that hold the deployment's agent account instead of the operator's. */
export interface AccountDirectories { gh?: string; glab?: string; lark?: string }
/** Environment variable overrides that select the agent account for each CLI; a missing directory keeps the CLI's own configuration. */
export function accountVariables(dirs: AccountDirectories): Record<string, string> {
  return { ...dirs.gh ? { GH_CONFIG_DIR: dirs.gh } : {}, ...dirs.glab ? { GLAB_CONFIG_DIR: dirs.glab } : {},
    ...dirs.lark ? { LARKSUITE_CLI_CONFIG_DIR: dirs.lark } : {} }
}
/** Account environment overrides for the active Git provider and, when configured, the Feishu bot. */
export function deploymentAccountVariables(deployment: Pick<Deployment, 'git' | 'feishu'>): Record<string, string> {
  const { git, feishu } = deployment
  return accountVariables({ ...git.provider === 'github' ? { gh: git.configDir } : { glab: git.configDir },
    ...feishu ? { lark: feishu.configDir } : {} })
}

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GLAB_TOKEN: undefined, GITLAB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.trimEnd())
  // Windows command scripts carry the same marker on an inert `rem` line, since a leading `#` is not a comment there.
  return head.some(line => [MARKER, ...LEGACY_MARKERS].some(marker => line === marker || line === `rem ${marker}` || line === `@rem ${marker}`))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * On POSIX each shim strips the shim directory from PATH before exec so wrapper scripts resolving the Git CLI or `lark-cli` by name reach the real binary.
 * On Windows a shim is a `.cmd` guardrail for a blocked or inactive command only: the active CLIs run as native executables
 * selected by environment variables, so arbitrary argv never passes through `cmd.exe` quoting.
 * The shim of the inactive Git provider fails, so a worker cannot accidentally act through the other host.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'git' | 'feishu'>, blockedCommands: readonly string[],
  platform: NodeJS.Platform = process.platform): Promise<void> {
  const { stateDir, repository, git, feishu } = deployment
  const dir = workerBin(stateDir)
  const windows = platform === 'win32'
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string, whole = false): Promise<void> => {
    const file = windows ? `${name}.cmd` : name
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    await writeFile(temporary, whole ? body : `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: windows ? 0o644 : 0o755 })
    await rename(temporary, join(dir, file))
    kept.add(file)
  }
  /** A `.cmd` script that prints one message to stderr and fails; cmd needs `%`, `^`, `&`, `|`, `<`, `>` and parentheses escaped. */
  const windowsFail = (message: string): string => `@echo off\r\nrem ${MARKER}\r\n`
    + `echo ${message.replace(/[%^&|<>()]/g, char => `^${char}`)} 1>&2\r\nexit /b 1\r\n`
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => windows ? windowsFail(message) : `echo ${shellQuote(message)} >&2\nexit 1`
  const gitlab = git.provider === 'gitlab'
  const blocked = new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))
  if (windows) {
    // The active CLI resolves from PATH as its native executable, with the account selected by the environment.
    if (gitlab) await shim('gh', fail('gh is unavailable: this installation uses GitLab; use glab.'), true)
    else await shim('glab', fail('glab is unavailable: this installation uses GitHub; use gh.'), true)
    if (!feishu) await shim('lark-cli', fail('lark-cli is unavailable: this installation has no Feishu bot.'), true)
    for (const name of blocked) await shim(name, fail(`${name} is blocked in this installation; use ${gitlab ? 'glab' : 'gh'}, which acts as ${git.login}.`), true)
  } else {
    await shim('gh', gitlab ? fail('gh is unavailable: this installation uses GitLab; use glab.') : run(git.cli))
    await shim('glab', gitlab ? run(git.cli) : fail('glab is unavailable: this installation uses GitHub; use gh.'))
    await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
    for (const name of blocked) await shim(name, fail(`${name} is blocked in this installation; use ${gitlab ? 'glab' : 'gh'}, which acts as ${git.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  const host = git.host
  const scheme = git.protocol ?? 'https'
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    `[credential "${scheme}://${host}"]`, `\thelper = ${gitQuote(credentialHelper(git.cli, platform))}`,
    `[url "${scheme}://${host}/"]`, `\tinsteadOf = git@${host}:`, `\tinsteadOf = ssh://git@${host}/`,
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const resolved = launch(argv)
  const handle = subprocess.spawn({ argv: [resolved.program, ...resolved.args], cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's active-host credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'git' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { git, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', `credential.${git.protocol ?? 'https'}://${git.host}.helper`], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  // Git for Windows prints a file origin with forward slashes, so compare path spellings on a common form.
  const common = (value: string): string => value.replaceAll('\\', '/')
  if (helpers.map(common).join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(git.cli), ''].map(common).join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
