import type { Store } from './store.ts'
import type { LocalRefCleanup, LocalRefCleanupJournal, LocalRefCleanupResult } from '../executor/ref-cleanup.ts'

type Intent = Readonly<LocalRefCleanup> & { retainedRef: string }

/** Durable, fail-closed operation journal scoped to one previously verified repository identity. */
export class WorkspaceRefJournal implements LocalRefCleanupJournal {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>, private readonly repositoryIdentity: string) {
    if (!repositoryIdentity.trim()) throw new Error('A verified repository identity is required')
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_ref_operation (
      id TEXT PRIMARY KEY, repository TEXT NOT NULL, ref TEXT NOT NULL, intent TEXT NOT NULL, result TEXT,
      UNIQUE(repository, ref));
      CREATE TABLE IF NOT EXISTS workspace_ref_event (
      seq INTEGER PRIMARY KEY, operation TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);`)
  }

  async begin(intent: Intent): Promise<'created' | 'exists'> {
    return this.store.atomic(() => {
      const value = JSON.stringify(intent)
      const result = this.store.db.prepare('INSERT OR IGNORE INTO workspace_ref_operation (id, repository, ref, intent) VALUES (?, ?, ?, ?)')
        .run(intent.operationId, this.repositoryIdentity, intent.ref, value)
      if (Number(result.changes) !== 1) return 'exists'
      this.store.db.prepare('INSERT INTO workspace_ref_event (operation, at, kind, value) VALUES (?, ?, ?, ?)')
        .run(intent.operationId, new Date().toISOString(), 'intent', value)
      return 'created'
    })
  }

  async finish(intent: Intent, result: LocalRefCleanupResult): Promise<void> {
    this.store.atomic(() => {
      const value = JSON.stringify(result)
      const updated = this.store.db.prepare('UPDATE workspace_ref_operation SET result = ? WHERE id = ? AND repository = ? AND ref = ? AND intent = ? AND result IS NULL')
        .run(value, intent.operationId, this.repositoryIdentity, intent.ref, JSON.stringify(intent))
      if (Number(updated.changes) !== 1) throw new Error('Operation intent is absent, changed, or already finished')
      this.store.db.prepare('INSERT INTO workspace_ref_event (operation, at, kind, value) VALUES (?, ?, ?, ?)')
        .run(intent.operationId, new Date().toISOString(), 'result', value)
    })
  }
}
