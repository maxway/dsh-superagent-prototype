/** The Executor reclaims a finished Ticket's checkout and local branch without a person asking it to. */
import { expect, it } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'

it('reclaims a Ticket\'s checkout after the Ticket ends', async () => {
  const h = await startRuntime()
  try {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一'))
    expect(h.runtime.store.tickets.get(ticket.id)!.execution?.directory).toBeTruthy()
    // Its turn is over when its Ticket ends, so the cleanup may start at once.
    h.agents.get(sessionId)!.status = 'idle'
    await h.runtime.engine.stopTicket(ticket.id)
    await h.runtime.idle()
    const git = h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).filter(argv => argv[0] === 'git')
    expect(git.some(argv => argv.includes('symbolic-ref'))).toBe(true)
  } finally { await h.stop() }
})