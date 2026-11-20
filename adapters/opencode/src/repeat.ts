/**
 * A file read again, unchanged, in what OpenCode is about to send. OpenCode
 * hands `experimental.chat.messages.transform` the message list of each
 * request (after any compaction, with pruned parts marked), a copy that is
 * rebuilt from the session for every request. In that copy, a completed `read`
 * whose output is byte-identical to an earlier `read` of the same file and
 * range still in the list becomes a one-line note pointing back to it. The
 * session keeps every read whole, so once the earlier one leaves the list (a
 * compaction, pruning), the later one is sent whole again. The decision is
 * the same for the same list, so the prompt cache stays stable.
 */
import { repeatReadNote } from '@tokenwise/mechanisms'
import type { OpenCodeMessage, OpenCodePart } from './shadow.ts'

/** A whole read in this request: its call, arguments and text, and whether it was sent as the note. */
export interface SentRead {
  readonly sessionId: string | undefined
  readonly callId: string
  readonly input: unknown
  readonly output: string
  readonly collapsed: boolean
}

const readKey = (input: unknown) => {
  const args = input as { filePath?: unknown; offset?: unknown; limit?: unknown } | null | undefined
  return typeof args?.filePath === 'string' ? JSON.stringify([args.filePath, args.offset ?? null, args.limit ?? null]) : undefined
}

/** A completed read whose output the model is sent whole: not pruned, not an error, text only. */
const wholeRead = (part: OpenCodePart): part is OpenCodePart & { state: { output: string } } => part.type === 'tool' && part.tool === 'read'
  && part.state?.status === 'completed' && typeof part.state.output === 'string' && part.state.time?.compacted === undefined
  && !(part.state as { attachments?: readonly unknown[] }).attachments?.length

/**
 * Replace, in `messages` (the outgoing copy), each repeat read with the note.
 * Message and part objects are replaced, never edited, so nothing OpenCode
 * keeps changes. Returns every whole read, collapsed or not.
 */
export function collapseRepeatReads(messages: OpenCodeMessage[]): SentRead[] {
  // Per file and range: the text last sent whole, and whether the read after it became a note. A read right after
  // a note is sent whole (the note promises the text again to a model that asks again).
  const seen = new Map<string, { output: string; noted: boolean }>()
  const sent: SentRead[] = []
  for (let m = 0; m < messages.length; m++) {
    const message = messages[m]!
    let parts: OpenCodePart[] | undefined
    for (let p = 0; p < message.parts.length; p++) {
      const part = message.parts[p]!
      if (!wholeRead(part)) continue
      const key = readKey(part.state.input)
      if (key === undefined) continue
      const output = part.state.output
      const read = { sessionId: message.info.sessionID, callId: part.callID ?? '', input: part.state.input, output }
      const last = seen.get(key)
      const note = repeatReadNote((part.state.input as { filePath: string }).filePath)
      if (last?.output !== output || last.noted || note.length >= output.length) {
        seen.set(key, { output, noted: false })
        sent.push({ ...read, collapsed: false })
        continue
      }
      last.noted = true
      parts ??= [...message.parts]
      parts[p] = { ...part, state: { ...part.state, output: note } }
      sent.push({ ...read, collapsed: true })
    }
    if (parts) messages[m] = { ...message, parts }
  }
  return sent
}
