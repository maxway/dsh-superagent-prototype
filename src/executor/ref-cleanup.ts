export const localRefCleanupRequirements = 'The caller must verify durable authorization and creation evidence establishing resource ownership, provide a trusted isolated Git runner and durable atomic journal, prohibit checked-out branches, and ensure no concurrent modification or recreation of this ticket ref, its reflog, or the retention ref throughout the operation. This object-level operational exclusion is not enforced here. The journal must atomically persist intent before returning created, reject an existing operation and any unresolved or unknown intent for the same verified common repository and ref even with a new operation ID, and durably append results without overwriting audit history. Any unresolved or unknown intent requires manual reconciliation. Other Git objects may be shared. This primitive does not remove worktrees or local branches.'

export interface LocalRefCleanup {
  cwd: string
  ref: string
  expectedOid: string
  operationId: string
  creationEvidence: string
}

export type LocalRefCleanupResult =
  | { status: 'deleted'; retainedRef: string }
  | { status: 'failed' | 'unknown'; reason: string; retainedRef?: string }

export type LocalRefCleanupRun = (args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>

export interface LocalRefCleanupJournal {
  begin: (intent: Readonly<LocalRefCleanup> & { retainedRef: string }) => Promise<'created' | 'exists'>
  finish: (intent: Readonly<LocalRefCleanup> & { retainedRef: string }, result: LocalRefCleanupResult) => Promise<void>
}

export interface LocalRefCleanupDependencies {
  run: LocalRefCleanupRun
  guard: (intent: Readonly<LocalRefCleanup> & { retainedRef: string }) => boolean | Promise<boolean>
  journal: LocalRefCleanupJournal
}

const component = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,127})$/

export async function cleanupLocalRef(target: LocalRefCleanup, dependencies: LocalRefCleanupDependencies): Promise<LocalRefCleanupResult> {
  if (!target || typeof target.cwd !== 'string' || !target.cwd || target.cwd.includes('\0')
    || typeof target.ref !== 'string' || typeof target.expectedOid !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target.expectedOid) || /^0+$/.test(target.expectedOid)
    || typeof target.operationId !== 'string' || !component.test(target.operationId)
    || typeof target.creationEvidence !== 'string' || !target.creationEvidence.trim() || target.creationEvidence.includes('\0')
    || !dependencies || typeof dependencies.run !== 'function' || typeof dependencies.guard !== 'function'
    || !dependencies.journal || typeof dependencies.journal.begin !== 'function' || typeof dependencies.journal.finish !== 'function') {
    return { status: 'failed', reason: 'Invalid request or missing trusted dependencies' }
  }
  const match = /^refs\/dsh-superagent\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(target.ref)
  if (!match) return { status: 'failed', reason: 'Invalid ticket ref' }
  const retainedRef = `refs/dsh-superagent-retained/${match[1]}/${target.operationId}`
  const intent = Object.freeze({ cwd: target.cwd, ref: target.ref, expectedOid: target.expectedOid, operationId: target.operationId, creationEvidence: target.creationEvidence, retainedRef })
  try {
    if (await dependencies.guard(intent) !== true) return { status: 'failed', reason: 'Creation evidence or authorization not approved' }
  } catch {
    return { status: 'failed', reason: 'Creation evidence or authorization could not be approved' }
  }
  try {
    const begun = await dependencies.journal.begin(intent)
    if (begun === 'exists') return { status: 'failed', reason: 'Operation already recorded; manual reconciliation required', retainedRef }
    if (begun !== 'created') return { status: 'unknown', reason: 'Intent persistence could not be confirmed; manual reconciliation required', retainedRef }
  } catch {
    return { status: 'unknown', reason: 'Intent persistence could not be confirmed; manual reconciliation required', retainedRef }
  }
  const result = await execute(intent, dependencies)
  try {
    await dependencies.journal.finish(intent, result)
  } catch {
    return { status: 'unknown', reason: 'Result persistence could not be confirmed; manual reconciliation required', retainedRef }
  }
  return result
}

async function execute(intent: Readonly<LocalRefCleanup> & { retainedRef: string }, dependencies: LocalRefCleanupDependencies): Promise<LocalRefCleanupResult> {
  const { cwd, ref, expectedOid, retainedRef } = intent
  try {
    if (await dependencies.guard(intent) !== true) return { status: 'failed', reason: 'Authorization changed after intent', retainedRef }
  } catch {
    return { status: 'failed', reason: 'Authorization could not be confirmed after intent', retainedRef }
  }
  const zero = '0'.repeat(expectedOid.length)
  try {
    const reflog = await dependencies.run(['reflog', 'exists', ref], cwd)
    if (reflog.exitCode === 0) return { status: 'failed', reason: 'Ticket ref has a reflog and must be preserved', retainedRef }
    if (reflog.exitCode !== 1) return { status: 'unknown', reason: 'Ticket ref reflog could not be checked', retainedRef }
  } catch {
    return { status: 'unknown', reason: 'Ticket ref reflog could not be checked', retainedRef }
  }
  try {
    const symbolic = await dependencies.run(['symbolic-ref', '--no-recurse', '-q', retainedRef], cwd)
    if (symbolic.exitCode === 0) return { status: 'failed', reason: 'Retention ref already exists as a symbolic ref', retainedRef }
    if (symbolic.exitCode !== 1) return { status: 'unknown', reason: 'Retention ref type could not be confirmed', retainedRef }
    const create = await dependencies.run(['update-ref', '--no-deref', retainedRef, expectedOid, zero], cwd)
    if (create.exitCode !== 0) return { status: 'unknown', reason: 'Retention ref creation failed; manual reconciliation required', retainedRef }
  } catch {
    return { status: 'unknown', reason: 'Retention ref creation could not be confirmed', retainedRef }
  }
  try {
    const inspect = await dependencies.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref, retainedRef], cwd)
    if (inspect.exitCode !== 0) return { status: 'failed', reason: 'Could not verify refs', retainedRef }
    const lines = inspect.stdout.split(/\r?\n/).filter(Boolean)
    const valid = (name: string) => {
      const entries = lines.filter(line => line.split('\0')[0] === name)
      return entries.length === 1 && entries[0] === `${name}\0${expectedOid}\0`
    }
    if (!valid(ref) || !valid(retainedRef)) return { status: 'failed', reason: 'Ref verification failed', retainedRef }
    if (await dependencies.guard(intent) !== true) return { status: 'failed', reason: 'Authorization changed before deletion', retainedRef }
    const deletion = await dependencies.run(['update-ref', '--no-deref', '-d', ref, expectedOid], cwd)
    if (deletion.exitCode !== 0) return { status: 'unknown', reason: 'Conditional deletion failed; manual reconciliation required', retainedRef }
    return { status: 'deleted', retainedRef }
  } catch {
    return { status: 'unknown', reason: 'Ref verification or deletion could not be confirmed', retainedRef }
  }
}
