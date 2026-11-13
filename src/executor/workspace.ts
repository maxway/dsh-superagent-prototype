/** Read-only inventory of a finished Ticket's workspace and Git references. */
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type GitRun = (argv: string[], cwd: string) => Promise<string>
export interface ReclaimTarget { id: string; name: string; directory: string; remote?: { url: string } }
export type ResourceState = 'present' | 'absent' | 'unknown'
export interface ResourceObservation { state: ResourceState; reason: string; oid?: string }
export interface WorkspaceReport {
  directory: string
  branch: string
  worktree: ResourceObservation
  localBranch: ResourceObservation
  ticketRef: ResourceObservation
  remoteBranch: ResourceObservation
  changes: ResourceObservation
  ignored: ResourceObservation
  commonDir?: string
  head?: string
}
export type ReclaimResult = { status: 'skipped'; reason: string; report: WorkspaceReport }

export const ticketBranch = (name: string): string => `agent/${name}`
export const ticketRef = (id: string): string => `refs/dsh-superagent/${id}`

async function attempt(run: GitRun, argv: string[], cwd: string): Promise<string | undefined> {
  try { return (await run(argv, cwd)).trim() } catch { return undefined }
}

/** Inspect only; a report is an observation, not permission to remove any resource. */
export async function reclaimWorkspace(run: GitRun, target: ReclaimTarget, stillEnded: () => boolean): Promise<ReclaimResult> {
  const directory = resolve(target.directory), branch = ticketBranch(target.name)
  const unknown = (reason: string): ResourceObservation => ({ state: 'unknown', reason })
  const report: WorkspaceReport = {
    directory, branch,
    worktree: unknown('The workspace has not been inspected'),
    localBranch: unknown('The repository is not established'),
    ticketRef: unknown('The repository is not established'),
    remoteBranch: unknown('Remote identity and current state have not been verified'),
    changes: unknown('Tracked and untracked changes are not inspected automatically'),
    ignored: unknown('Ignored files have not been inspected'),
  }
  const finish = (reason: string): ReclaimResult => ({ status: 'skipped', reason, report })
  if (!stillEnded()) return finish('The Ticket is running again')
  let info
  try { info = await lstat(directory) } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    report.worktree = missing ? { state: 'absent', reason: 'The directory is missing; its history and repository are unknown' }
      : unknown('The directory could not be inspected')
    return finish(report.worktree.reason)
  }
  if (!info.isDirectory()) {
    report.worktree = unknown('The workspace path is not a directory or is a symbolic link')
    return finish(report.worktree.reason)
  }
  try { await lstat(join(directory, '.git')) } catch {
    report.worktree = unknown('The directory is not a Git checkout, or its metadata is inaccessible')
    return finish(report.worktree.reason)
  }
  const common = await attempt(run, ['rev-parse', '--path-format=absolute', '--git-common-dir'], directory)
  const gitDir = await attempt(run, ['rev-parse', '--path-format=absolute', '--git-dir'], directory)
  if (!common || !gitDir) {
    report.worktree = unknown('Git metadata is missing, broken, or inaccessible')
    return finish(report.worktree.reason)
  }
  report.commonDir = resolve(common)
  const symbolic = await attempt(run, ['symbolic-ref', '--quiet', '--short', 'HEAD'], directory)
  const head = await attempt(run, ['rev-parse', '--verify', 'HEAD'], directory)
  if (head) report.head = head
  report.worktree = { state: 'present', reason: resolve(gitDir) === report.commonDir ? 'This is a main checkout, not a linked worktree'
    : symbolic === branch ? 'Linked checkout is on the expected branch; ownership is not verified'
      : `Linked checkout is not on the expected branch${symbolic ? ` (currently ${symbolic})` : ''}` }
  const refs = await attempt(run, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${branch}`, ticketRef(target.id)], directory)
  if (refs !== undefined) {
    const values = new Map(refs.split('\n').filter(Boolean).map(line => {
      const space = line.indexOf(' ')
      return [line.slice(0, space), line.slice(space + 1)] as const
    }))
    const observation = (ref: string): ResourceObservation => {
      const oid = values.get(ref)
      return oid ? { state: 'present', reason: 'Local reference exists; ownership and remote preservation are unverified', oid }
        : unknown('Git did not list the reference; a dangling symbolic ref or inaccessible reference cannot be ruled out')
    }
    report.localBranch = observation(`refs/heads/${branch}`)
    report.ticketRef = observation(ticketRef(target.id))
  }
  const ignored = await attempt(run, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], directory)
  if (ignored !== undefined) report.ignored = ignored ? { state: 'present', reason: 'Git reports ignored files or directories' }
    : unknown('Git reports no ignored entries, but cannot establish the absence of empty directories or other hidden data')
  return finish(stillEnded() ? 'Automatic destructive cleanup is disabled; all resources are preserved' : 'The Ticket is running again')
}
