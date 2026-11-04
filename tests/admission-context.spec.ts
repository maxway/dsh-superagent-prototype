import { expect, it } from 'vitest'
import { admissionContext, threadWindow } from '../src/sources/admission-context.ts'
import type { ContextMessage, TriggerContext } from '../src/sources/kind.ts'
const message = (index: number): ContextMessage => ({ id: `om_${index}`, from: 'ou_user', at: String(index), text: `Message ${index}` })
it('returns the thread opening and trigger neighbors with exact internal and trailing gaps', () => {
  const result = threadWindow(Array.from({ length: 40 }, (_, i) => message(i)), 'om_25')
  expect(result.entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  expect(result.entries[5]?.omitted_before).toBe(15)
  expect(result.omitted_after).toBe(9)
  expect(result.source_found).toBe(true)
})
it('deduplicates overlapping windows and reports an absent source without inventing neighbors', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  expect(threadWindow(messages, 'om_3').entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(threadWindow(messages, 'om_absent')).toMatchObject({ source_found: false, loaded_messages: 12, omitted_after: 7 })
})
it('retains pagination limits and exact loaded counts rather than claiming complete history', async () => {
  const pages: string[] = []
  // A Source context that answers the first page with a cursor and the next page without one.
  const context: TriggerContext = { messageId: 'om_9', images: () => [], read: async (_commands, _part, cursor) => {
    pages.push(cursor ?? 'first')
    return cursor === undefined
      ? { messages: [message(0), message(1)], next: 'next', body: {} }
      : { messages: [message(2), message(3)], body: {} }
  }, image: async () => { throw new Error('no images') } }
  const result = await admissionContext(context, {} as never, 2)
  expect(result).toMatchObject({ complete: true, next: null, window: { loaded_messages: 4, source_found: false } })
  expect(pages).toEqual(['first', 'next'])
  const limited = await admissionContext(context, {} as never, 1)
  expect(limited).toMatchObject({ complete: false, next: 'next' })
  expect(pages).toEqual(['first', 'next', 'first'])
})