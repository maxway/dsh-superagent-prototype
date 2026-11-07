/** Reclaims a Ticket's linked git worktree and local branch after the Ticket ended, when no local work would be lost. */
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Runs one git command in `cwd` and resolves its standard output, or rejects with why it failed. */
export type GitRun = (argv: string[], cwd: string) => Promise<string>
/** What the workspace of a finished Ticket is reclaimed from: its short name, directory and id. */
export interface ReclaimTarget { id: string; name: string; directory: string }
/** The outcome of one reclaim attempt: the worktree and branch removed, a reason it was kept, or no directory at all. */
export type ReclaimResult =
  | { status: 'reclaimed'; worktree: string; branch: string }
  | { status: 'skipped'; reason: string }
  | { status: 'absent' }

/** The local branch a Ticket's prepare command creates for its worktree. */
export const ticketBranch = (name: string): string => `agent/${name}`
/** The local ref a Ticket's prepare command fetches the remote starting point into. */
export const ticketRef = (id: string): string => `refs/dsh-superagent/${id}`

/** Runs a git command and returns its trimmed output, or undefined when it failed. */
async function attempt(run: GitRun, argv: string[], cwd: string): Promise<string | undefined> {
  try { return (await run(argv, cwd)).trim() } catch { return undefined }
}
/**
 * Remove the linked worktree and local branch of a finished Ticket when the worktree is on the branch the prepare
 * command names, has no uncommitted, untracked or submodule changes, and every commit is reachable from a remote ref or
 * the Ticket's fetched ref. Any failure to establish one of those facts keeps the worktree. The remote branch, the pull
 * request and the main checkout are not touched; `stillEnded` is checked again immediately before removal, so a Ticket
 * that resumed meanwhile keeps its worktree.
 * @throws when git cannot remove the worktree or the branch after the safety checks passed, so a later attempt can retry.
 */
export async function reclaimWorkspace(run: GitRun, target: ReclaimTarget, stillEnded: () => boolean): Promise<ReclaimResult> {
  const worktree = resolve(target.directory)
  if (!await stat(worktree).then(() => true, () => false)) return { status: 'absent' }
  // An empty directory from a prepare command that checks nothing out is not a git worktree.
  if (!await stat(join(worktree, '.git')).then(() => true, () => false)) return { status: 'skipped', reason: 'the directory is not a git checkout' }
  const branch = ticketBranch(target.name)
  const head = await attempt(run, ['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree)
  if (head === undefined) return { status: 'skipped', reason: 'the directory is not a git checkout with a checked-out branch' }
  if (head !== branch) return { status: 'skipped', reason: `the checkout is on ${head}, not ${branch}` }
  const gitDir = await attempt(run, ['rev-parse', '--path-format=absolute', '--git-dir'], worktree)
  const common = await attempt(run, ['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree)
  if (!gitDir || !common) return { status: 'skipped', reason: 'the directory is not a git checkout' }
  if (resolve(gitDir) === resolve(common)) return { status: 'skipped', reason: 'the directory is a main worktree, not one linked to it' }
  // Worktree commands need another checkout of the same repository as their working directory; the first listed is the
  // main worktree in the ordinary layout, and this also finds one when the repository keeps its git directory elsewhere.
  const listing = await attempt(run, ['worktree', 'list', '--porcelain'], worktree)
  const peer = listing?.split('\n').filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length).trim())).find(path => path !== worktree)
  if (!peer) return { status: 'skipped', reason: 'the checkout is the only worktree of its repository' }
  const dirty = await attempt(run, ['status', '--porcelain', '--untracked-files=all'], worktree)
  if (dirty === undefined) return { status: 'skipped', reason: 'git could not read the checkout status' }
  if (dirty) return { status: 'skipped', reason: 'the checkout has uncommitted or untracked changes' }
  const fetched = await attempt(run, ['rev-parse', '--verify', '--quiet', ticketRef(target.id)], worktree)
  const local = await attempt(run, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...fetched ? [ticketRef(target.id)] : []], worktree)
  if (local === undefined) return { status: 'skipped', reason: 'git could not compare the commits with their remotes' }
  if (local !== '0') return { status: 'skipped', reason: 'the checkout has commits that are not on a remote' }
  if (!stillEnded()) return { status: 'skipped', reason: 'the Ticket is running again' }
  // Remove the checkout first, then the branch it had checked out; `-D` is safe because every commit is on a remote or
  // the Ticket's fetched ref. `--force` covers a clean worktree that git still guards, such as one with submodules.
  await run(['worktree', 'remove', '--force', worktree], peer)
  await run(['branch', '-D', branch], peer)
  await attempt(run, ['update-ref', '-d', ticketRef(target.id)], peer)
  return { status: 'reclaimed', worktree, branch }
}