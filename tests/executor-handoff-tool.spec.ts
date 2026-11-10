import { expect, it, vi } from 'vitest'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { mandateInstructions } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'

const ticket = (tier?: 'low' | 'high') => ({ id: 'original', tier } as Ticket)
const setup = (tier?: 'low' | 'high') => {
  const handoff = vi.fn(() => ({ id: 'successor' } as Ticket))
  const host = { engine: { handoff }, git: { deployment: { git: { login: 'bot' } } } } as unknown as ExecutorToolsHost
  const tools = executorTools(host, ticket(tier))
  return { handoff, tool: tools.find(item => item.name === 'orchestrator_ticket_handoff') }
}

it('offers handoff only to low-tier workers', () => {
  expect(setup('low').tool).toBeDefined()
  expect(setup('high').tool).toBeUndefined()
  expect(setup().tool).toBeUndefined()
})

it('validates and forwards the summary using the current ticket, then tells the worker to stop', async () => {
  const { handoff, tool } = setup('low')
  expect(tool!.schema.safeParse({ summary: '   ' }).success).toBe(false)
  expect(tool!.schema.safeParse({ summary: 'x'.repeat(8000) }).success).toBe(true)
  expect(tool!.schema.safeParse({ summary: 'x'.repeat(8001) }).success).toBe(false)
  expect(tool!.schema.safeParse({ summary: 'done', ticket_id: 'other' }).success).toBe(false)
  const args = tool!.schema.parse({ summary: '  Done: inspected. Remaining: fix. Risks: migration.  ' })
  expect(await tool!.execute(args, new AbortController().signal)).toEqual({ handed_off: true, ticket_id: 'successor',
    next_action: 'Stop working immediately; the high-tier worker will continue the original task.' })
  expect(handoff).toHaveBeenCalledExactlyOnceWith('original', 'Done: inspected. Remaining: fix. Risks: migration.')
  expect(tool!.description).toContain('cannot expand scope')
  expect(tool!.description).toContain('cancelled before the result arrives')
})

it('instructs the worker to preserve authorization and stop after handoff', () => {
  for (const strength of ['explicit', 'inferred', 'reply'] as const) {
    const low = mandateInstructions({ strength, tier: 'low' })
    expect(low).toContain('orchestrator_ticket_handoff')
    expect(low).toContain('what you have done, what remains unfinished, and risks')
    expect(low).toContain('inherits the original authorization only')
    expect(low).toContain('stop work immediately')
    expect(low).toContain('cancelled before the tool result arrives')
    expect(mandateInstructions({ strength, tier: 'high' })).not.toContain('orchestrator_ticket_handoff')
    expect(mandateInstructions({ strength })).not.toContain('orchestrator_ticket_handoff')
    const successor = mandateInstructions({ strength, tier: 'high', handoffFrom: 'original' })
    expect(successor).toContain('Before executing the original request, read the complete assignment and its handoff summary')
    expect(successor).toContain('follow assignment_read and pagination')
    expect(mandateInstructions({ strength, tier: 'high' })).not.toContain('assignment_read')
  }
})

it('propagates a failed handoff rather than claiming success', async () => {
  const { handoff, tool } = setup('low')
  handoff.mockImplementation(() => { throw new Error('Ticket ended') })
  await expect(tool!.execute({ summary: 'Done: none. Remaining: fix. Risks: unknown.' }, new AbortController().signal)).rejects.toThrow('Ticket ended')
})
