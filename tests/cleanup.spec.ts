/** Finished Tickets retain their workspaces and receive read-only inventory reports. */
import { existsSync, writeFileSync } from 'node:fs'
import { KV } from '../src/kv.ts'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { newProvenance } from '../src/executor/provenance.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

it('records a read-only report and retains a finished workspace on legacy cleanup replay', async () => {
  const h = await startRuntime()
  try {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const directory = h.runtime.store.tickets.get(ticket.id)!.execution!.directory
    const marker = join(directory, '.git')
    writeFileSync(marker, 'gitdir: nowhere\n')
    h.agents.get(sessionId)!.status = 'idle'
    h.subprocess.spawn.mockClear()
    await h.runtime.engine.stopTicket(ticket.id)
    await h.runtime.idle()
    h.runtime.executor.resume()
    await h.runtime.idle()
    h.runtime.effects.enqueue('cleanup', ticket.id, { ticketId: ticket.id })
    await h.runtime.idle()
    expect(h.runtime.effects.pending('cleanup', ticket.id)).toBe(false)
    const report = h.runtime.store.get(KV.workspace.report(ticket.id))
    expect(report).toMatchObject({ endedAt: h.runtime.store.tickets.get(ticket.id)!.ended!.at,
      report: { directory, worktree: { state: 'unknown' }, remoteBranch: { state: 'unknown' } } })
    expect(existsSync(join(directory, '.git'))).toBe(true)
    const git = h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).filter(argv => argv[0] === 'git')
    expect(git.some(argv => argv.includes('worktree') || argv.includes('push') || argv.includes('update-ref'))).toBe(false)
  } finally { await h.stop() }
})

it('does not delete even when creation evidence and the Ticket ref are present', async () => {
  const h = await startRuntime()
  try {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('2', '@bot 修二'))
    const execution = h.runtime.store.tickets.get(ticket.id)!.execution!
    const oid = 'a'.repeat(40)
    writeFileSync(join(execution.directory, '.git'), 'gitdir: elsewhere\n')
    h.runtime.store.set(KV.workspace.provenance(ticket.id), {
      ...newProvenance('generation', execution.directory, execution.directory, execution.name, ticket.id),
      status: 'verified', refOid: oid,
    })
    h.subprocess.spawn.mockImplementation(spec => {
      const args = [...spec.argv]
      const output = args.includes('for-each-ref') ? `refs/dsh-superagent/${ticket.id} ${oid}\n`
        : args.includes('--git-common-dir') ? join(execution.directory, 'common')
          : args.includes('--git-dir') ? join(execution.directory, 'admin') : ''
      const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(output), stderr: reader('') } }
    })
    h.agents.get(sessionId)!.status = 'idle'
    await h.runtime.engine.stopTicket(ticket.id)
    await h.runtime.idle()
    expect(h.runtime.store.get(KV.workspace.report(ticket.id))?.report.ticketRef).toMatchObject({ state: 'present', oid })
    const git = h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).filter(argv => argv.includes('git'))
    expect(git.some(argv => argv.includes('update-ref') || argv.includes('push') || argv.includes('remove'))).toBe(false)
  } finally { await h.stop() }
})
