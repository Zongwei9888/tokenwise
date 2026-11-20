/**
 * One TokenWise toast at a time. DSH draws every Toast in the same place at the
 * top of the page, so two that arrive together (what a conversation saved, and
 * a learning notice, both at the end of a turn) would lie on top of each other.
 * Each toast takes a turn here and shows once the ones before it are gone.
 */
import { useEffect, useState } from 'react'

const queue: string[] = []
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** Whether the toast with this key may show now; it joins the queue while it has a key and leaves it on `done`. */
export function useToastTurn(key: string | undefined): { mine: boolean; done: () => void } {
  const [, redraw] = useState(0)
  useEffect(() => {
    const listener = () => redraw(n => n + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => {
    if (key === undefined) return undefined
    join(key)
    return () => leave(key)
  }, [key])
  return { mine: key !== undefined && queue[0] === key, done: () => { if (key !== undefined) leave(key) } }
}

/** A toast waits its turn; joining twice keeps its place. */
export function join(key: string): void {
  if (queue.includes(key)) return
  queue.push(key)
  changed()
}

/** A toast is done (or gone): the next one may show. */
export function leave(key: string): void {
  const at = queue.indexOf(key)
  if (at < 0) return
  queue.splice(at, 1)
  changed()
}

/** For tests: the keys waiting, the one showing first. */
export function toastQueue(): readonly string[] { return [...queue] }
