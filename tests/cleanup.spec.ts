/** Finished Tickets retain their workspaces, including when old cleanup effects are replayed. */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'

it('keeps a finished workspace on stop, restart and legacy cleanup replay', async () => {
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
    expect(h.runtime.effects.pending('cleanup', ticket.id)).toBe(false)
    h.runtime.executor.resume()
    await h.runtime.idle()
    expect(h.runtime.effects.pending('cleanup', ticket.id)).toBe(false)
    h.runtime.effects.enqueue('cleanup', ticket.id, { ticketId: ticket.id })
    await h.runtime.idle()
    expect(h.runtime.effects.pending('cleanup', ticket.id)).toBe(false)
    expect(existsSync(marker)).toBe(true)
    expect(h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).filter(argv => argv[0] === 'git')).toEqual([])
  } finally { await h.stop() }
})
