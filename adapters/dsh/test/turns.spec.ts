import { describe, expect, it, vi } from 'vitest'
import { join, leave, toastQueue } from '../src/client/turns.ts'

// React comes from the DSH page; the queue itself needs none of it.
vi.mock('react', () => ({ useEffect: () => {}, useState: (value: unknown) => [value, () => {}] }))

describe('one TokenWise toast at a time', () => {
  it('shows a toast that arrives with another only after the first is done', () => {
    // A turn ends: what the conversation saved, and a learning notice, both at once.
    join('saved:s1:2402')
    join('ready:1')
    expect(toastQueue()[0]).toBe('saved:s1:2402')
    join('saved:s1:2402')
    expect(toastQueue()).toEqual(['saved:s1:2402', 'ready:1'])
    leave('saved:s1:2402')
    expect(toastQueue()).toEqual(['ready:1'])
    // A toast that goes away unseen (its page closed) frees its place too.
    join('saved:s2:10')
    leave('ready:1')
    leave('ready:1')
    expect(toastQueue()).toEqual(['saved:s2:10'])
    leave('saved:s2:10')
    expect(toastQueue()).toEqual([])
  })
})
