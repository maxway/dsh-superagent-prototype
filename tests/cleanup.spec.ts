/** The Executor reclaims a finished Ticket's checkout and local branch without a person asking it to. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'

it('reclaims a Ticket\'s checkout after the Ticket ends', async () => {
  const h = await startRuntime()
  try {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const directory = h.runtime.store.tickets.get(ticket.id)!.execution!.directory
    // A placeholder worktree marker: the cleanup reads it before it asks git for the branch, which the fake answers empty.
    writeFileSync(join(directory, '.git'), 'gitdir: nowhere\n')
    // Its turn is over when its Ticket ends, so the cleanup may start at once.
    h.agents.get(sessionId)!.status = 'idle'
    await h.runtime.engine.stopTicket(ticket.id)
    await h.runtime.idle()
    const git = h.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).filter(argv => argv[0] === 'git')
    expect(git.some(argv => argv.includes('symbolic-ref'))).toBe(true)
  } finally { await h.stop() }
})