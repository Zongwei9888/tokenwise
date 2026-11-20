/**
 * A file read again, unchanged, in what pi is about to send. pi hands
 * `context_with_system` the full message list of each request (after any
 * compaction and context edit), and sends what the handler returns; the
 * session keeps its own copy. In the returned list, a `read` result
 * byte-identical to an earlier `read` result of the same file and range still
 * in the list becomes a one-line note pointing back to it. Once the earlier
 * one leaves the list (a compaction), the later one is sent whole again; the
 * same list always gets the same answer, so the prompt cache stays stable.
 */
import { repeatReadNote } from '@tokenwise/mechanisms'

/** The parts of pi's messages this reads: assistant tool calls and tool results. */
interface PiMessage {
  readonly role?: string
  readonly content?: unknown
  readonly toolCallId?: string
  readonly toolName?: string
  readonly isError?: boolean
}

/** A whole read in this request: its call, arguments and text, and whether it was sent as the note. */
export interface SentRead {
  readonly callId: string
  readonly input: unknown
  readonly output: string
  readonly collapsed: boolean
}

/** The text of a content list that holds text only (no image); undefined otherwise. */
export const textOnly = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length === 0) return undefined
  if (!content.every(block => block?.type === 'text' && typeof block.text === 'string')) return undefined
  return content.map(block => block.text as string).join('\n')
}

/**
 * The list to send, with each repeat read replaced by the note (new message
 * objects; nothing pi keeps is edited), and every whole read in it; the list
 * is undefined when nothing changed. A read right after a note is sent whole
 * (the note promises the text again to a model that asks again).
 */
export function collapseRepeatReads<T>(messages: readonly T[]): { messages?: T[]; reads: SentRead[] } {
  const args = new Map<string, unknown>()
  for (const message of messages as readonly PiMessage[]) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) if (block?.type === 'toolCall' && block.name === 'read' && typeof block.id === 'string') args.set(block.id, block.arguments)
  }
  const seen = new Map<string, { output: string; noted: boolean }>()
  const reads: SentRead[] = []
  let out: T[] | undefined
  messages.forEach((item, index) => {
    const message = item as PiMessage
    if (message?.role !== 'toolResult' || message.toolName !== 'read' || message.isError || typeof message.toolCallId !== 'string') return
    const input = args.get(message.toolCallId) as { path?: unknown; offset?: unknown; limit?: unknown } | undefined
    const output = textOnly(message.content)
    if (typeof input?.path !== 'string' || output === undefined) return
    const key = JSON.stringify([input.path, input.offset ?? null, input.limit ?? null])
    const read = { callId: message.toolCallId, input, output }
    const last = seen.get(key)
    const note = repeatReadNote(input.path)
    if (last?.output !== output || last.noted || note.length >= output.length) {
      seen.set(key, { output, noted: false })
      reads.push({ ...read, collapsed: false })
      return
    }
    last.noted = true
    out ??= [...messages]
    out[index] = { ...item, content: [{ type: 'text', text: note }] } as T
    reads.push({ ...read, collapsed: true })
  })
  return { ...out ? { messages: out } : {}, reads }
}
