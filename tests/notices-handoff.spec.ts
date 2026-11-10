import { expect, it } from 'vitest'
import { eventNotice } from '../src/app/notices.ts'
import type { Ticket } from '../src/core/index.ts'

it('reports a handoff without classifying the thread as unrelated', () => {
  const event = { type: 'thread.unsubscribed' as const, at: '2026-11-10T00:00:00Z',
    data: { ticketId: 'old', threadKey: 'feishu:topic', by: 'executor' as const, reason: 'handoff' } }
  const notice = eventNotice(event, () => ({ id: 'old', handoffTo: 'new' } as Ticket))!
  expect(notice[1]).toMatchObject({ thread_handoff: { ticket_id: 'old', thread: 'feishu:topic', successor_ticket_id: 'new' } })
  expect(notice[1]).not.toHaveProperty('thread_unrelated')
  expect(eventNotice({ ...event, data: { ...event.data, reason: 'unrelated' } })![1]).toHaveProperty('thread_unrelated')
})
