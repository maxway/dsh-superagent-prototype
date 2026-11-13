import { isAbsolute, win32 } from 'node:path'

export interface RemoteDeletion {
  remoteUrl: string
  ref: string
  expectedOid: string
  cwd: string
  guard: () => boolean | Promise<boolean>
}

export type RemoteDeletionResult =
  | { status: 'deleted' }
  | { status: 'cancelled' | 'failed' | 'unknown'; reason: string }

/**
 * The caller must supply a trusted Git runner and isolate its environment,
 * repository and Git configuration, hooks, authentication and URL rewriting.
 * The runner must return only the result of the requested command.
 */
export type TrustedRemoteDeletionRun = (args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>

function validRef(ref: string): boolean {
  if (!ref.startsWith('refs/heads/') || ref.endsWith('/') || ref.endsWith('.') || ref.includes('..') || ref.includes('@{')) return false
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)) return false
  return ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

function validRemote(url: string): boolean {
  if (!url || url.startsWith('-') || /[\x00-\x1f\x7f]/.test(url)) return false
  if (isAbsolute(url) || win32.isAbsolute(url)) return true
  return /^(?:https?|ssh|git|file):\/\//i.test(url) && !/\s/.test(url)
}

/**
 * Delete an exact remote ref using a caller-supplied expected OID. This primitive
 * does not establish ownership, remote identity, merge status or exclusive use.
 * The guard and push are not atomic. No scheduling or authorization is implied.
 */
export async function deleteRemoteBranch(target: RemoteDeletion, run: TrustedRemoteDeletionRun): Promise<RemoteDeletionResult> {
  if (!target) return { status: 'failed', reason: 'Missing deletion request' }
  const { remoteUrl, ref, expectedOid, cwd, guard } = target
  if (typeof remoteUrl !== 'string' || !validRemote(remoteUrl) || typeof ref !== 'string' || !validRef(ref)
    || typeof expectedOid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedOid)
    || /^0+$/.test(expectedOid) || typeof cwd !== 'string' || !cwd || typeof guard !== 'function' || typeof run !== 'function') {
    return { status: 'failed', reason: 'Invalid remote URL, ref, object ID, directory, guard, or runner' }
  }
  try {
    if (await guard() !== true) return { status: 'cancelled', reason: 'Guard did not authorize deletion' }
    if (await guard() !== true) return { status: 'cancelled', reason: 'Guard changed before push' }
  } catch {
    return { status: 'cancelled', reason: 'Guard could not authorize deletion' }
  }
  try {
    const result = await run(['push', '--porcelain', `--force-with-lease=${ref}:${expectedOid}`, '--', remoteUrl, `:${ref}`], cwd)
    const lines = result.stdout.split(/\r?\n/)
    const deletion = lines.some(line => line === `-\t:${ref}\t[deleted]`)
    if (result.exitCode === 0 && deletion) return { status: 'deleted' }
    const rejected = lines.some(line => line.startsWith(`!\t(delete):${ref}\t[rejected]`))
    if (result.exitCode !== 0 && rejected) return { status: 'failed', reason: 'Remote rejected the deletion' }
    return { status: 'unknown', reason: 'Git did not confirm the deletion' }
  } catch {
    return { status: 'unknown', reason: 'Git push could not be confirmed' }
  }
}
