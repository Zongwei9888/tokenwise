/**
 * LightShadow for OpenCode (full tier), verified against OpenCode 1.19.4:
 *
 * 1. `experimental.session.compacting` starts a compaction: the summarizer
 *    is told the tool results stay recoverable, and the previous summary is
 *    looked up (OpenCode passes it apart from the span, as `<prior-summary>`).
 * 2. `experimental.chat.messages.transform` then runs on a copy of the span
 *    being summarized: it is read as `ShadowMessage`s and left unchanged.
 * 3. `experimental.text.complete` on the summary message: the text becomes
 *    the checkpoint (summary, the user's exact messages, the catalog), which
 *    OpenCode stores and replays as the summary.
 * 4. `tokenwise_recall` reads any listed result again.
 *
 * Every hook catches everything: OpenCode does not contain a plugin's throw,
 * and an uncaught one aborts the compaction and garbles the next turn. On
 * any failure OpenCode's own summary stays. All compaction hooks are
 * `experimental.*`; when a release stops calling them, nothing happens.
 */
import {
  RECALL_INPUT_SCHEMA, RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME, SHADOW_SUMMARY_INSTRUCTION, callLabel, recallFromJournal, shadowCheckpoint,
} from '@tokenwise/mechanisms'
import type { ShadowMessage, ShadowStore } from '@tokenwise/mechanisms'
import type { ArtifactPort, JournalPort, JournalRecord } from '@tokenwise/protocol'

/** The parts of OpenCode's messages and client LightShadow reads. */
export interface OpenCodePart {
  readonly type?: string
  readonly text?: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
  readonly tool?: string
  readonly callID?: string
  readonly state?: { readonly status?: string; readonly input?: unknown; readonly output?: unknown; readonly time?: { readonly compacted?: unknown } }
}
export interface OpenCodeMessage {
  readonly info: { readonly id?: string; readonly sessionID?: string; readonly role?: string; readonly summary?: unknown; readonly mode?: string; readonly finish?: unknown; readonly error?: unknown }
  readonly parts: readonly OpenCodePart[]
}
type Reply<T> = T | { readonly data?: T }
export interface OpenCodeClient {
  readonly session?: {
    readonly message?: (options: { path: { id: string; messageID: string } }) => Promise<Reply<OpenCodeMessage>>
    readonly messages?: (options: { path: { id: string } }) => Promise<Reply<readonly OpenCodeMessage[]>>
  }
}

export interface ToolContext { readonly sessionID?: string; readonly callID?: string }
export interface ShadowHooks {
  'experimental.session.compacting': (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>
  'experimental.chat.messages.transform': (input: object, output: { messages: OpenCodeMessage[] }) => Promise<void>
  'experimental.text.complete': (input: { sessionID: string; messageID: string; partID: string }, output: { text: string }) => Promise<void>
  'tool.definition': (input: { toolID: string }, output: { description?: string; parameters?: unknown; jsonSchema?: unknown }) => Promise<void>
  event: (input: { event: { type?: string; properties?: { sessionID?: string; info?: { id?: string; parentID?: string } } } }) => Promise<void>
  tool: Record<string, { description: string; args: Record<string, unknown>; execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> }>
}

export interface OpenCodeShadowOptions {
  readonly host: string
  readonly journal: JournalPort
  readonly artifacts: ArtifactPort
  /** One session's journal records, and every record (recall finds references by content-derived ID). */
  readonly read: (sessionId: string) => readonly JournalRecord[]
  readonly readAll: () => readonly JournalRecord[]
  readonly client?: OpenCodeClient
  readonly onError?: (error: unknown) => void
  /** How long a client lookup may take before LightShadow gives up on it. */
  readonly lookupMs?: number
}

const unwrap = <T>(reply: Reply<T> | undefined): T | undefined =>
  reply && typeof reply === 'object' && 'data' in reply ? (reply as { data?: T }).data : reply as T | undefined

function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined)
  return Promise.race([promise, new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), ms).unref?.() })]).catch(() => undefined)
}

const textOf = (parts: readonly OpenCodePart[]) => parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored && typeof part.text === 'string')
  .map(part => part.text!).join('\n')

/** OpenCode's span as LightShadow reads it. Only completed tool results that pruning did not clear can become references. */
export function shadowMessagesOf(messages: readonly OpenCodeMessage[]): ShadowMessage[] {
  const out: ShadowMessage[] = []
  for (const message of messages) {
    const role = message.info.role
    if (role === 'user') {
      const text = textOf(message.parts)
      if (text) out.push({ role: 'user', text })
      continue
    }
    if (role !== 'assistant') continue
    const said: string[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && typeof part.text === 'string' && !part.synthetic) said.push(part.text)
      if (part.type !== 'tool') continue
      said.push(`${part.tool ?? 'tool'} ${JSON.stringify(part.state?.input ?? {})}`)
      const state = part.state
      if (state?.status === 'completed' && typeof state.output === 'string' && !state.time?.compacted) {
        if (said.length) { out.push({ role: 'assistant', text: said.join('\n') }); said.length = 0 }
        const call = callLabel(state.input)
        out.push({ role: 'tool', text: state.output, toolName: part.tool ?? 'tool', ...part.callID ? { callId: part.callID } : {}, ...call ? { call } : {} })
      }
    }
    if (said.length) out.push({ role: 'assistant', text: said.join('\n') })
  }
  return out
}

interface Pending {
  stage: 'compacting' | 'summarizing'
  prior?: string
  messages?: ShadowMessage[]
  done?: string
}

export function createShadowHooks(options: OpenCodeShadowOptions): ShadowHooks {
  const pending = new Map<string, Pending>()
  const lookupMs = options.lookupMs ?? 3000
  const store: ShadowStore = { journal: options.journal, artifacts: options.artifacts, read: options.read }
  const fail = (error: unknown) => { try { options.onError?.(error) } catch { /* Diagnostics only. */ } }

  /** The previous summary OpenCode passes as <prior-summary>: the last finished summary message. */
  async function priorSummary(sessionID: string): Promise<string | undefined> {
    const messages = unwrap(await within(options.client?.session?.messages?.({ path: { id: sessionID } }), lookupMs))
    if (!Array.isArray(messages)) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]!.info
      if (info.role === 'assistant' && info.summary === true && info.finish && !info.error) return textOf(messages[i]!.parts) || undefined
    }
    return undefined
  }

  /** Whether a finished text part belongs to the summary of the compaction this session is running. */
  async function isSummary(sessionID: string, messageID: string): Promise<boolean> {
    if (!options.client?.session?.message) return true
    const message = unwrap(await within(options.client.session.message({ path: { id: sessionID, messageID } }), lookupMs))
    // No answer: the stage alone decides (the transform for this session's compaction has run).
    if (!message?.info) return true
    return message.info.summary === true && message.info.mode === 'compaction'
  }

  return {
    'experimental.session.compacting': async (input, output) => {
      try {
        if (!input?.sessionID || !Array.isArray(output?.context)) return
        const entry: Pending = { stage: 'compacting' }
        pending.set(input.sessionID, entry)
        output.context.push(SHADOW_SUMMARY_INSTRUCTION)
        const prior = await priorSummary(input.sessionID)
        if (prior) entry.prior = prior
      } catch (error) { fail(error) }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        const sessionID = output?.messages?.[0]?.info?.sessionID
        const entry = sessionID ? pending.get(sessionID) : undefined
        // Only the transform right after this session's `compacting` sees the span; every other one is a normal request.
        if (!entry || entry.stage !== 'compacting') return
        entry.stage = 'summarizing'
        entry.messages = shadowMessagesOf(output.messages)
      } catch (error) { fail(error) }
    },
    'experimental.text.complete': async (input, output) => {
      try {
        const entry = pending.get(input?.sessionID)
        if (!entry || entry.stage !== 'summarizing' || !entry.messages || typeof output?.text !== 'string' || !output.text.trim()) return
        // A summary in several text parts: the checkpoint goes on the first.
        if (entry.done !== undefined) return
        if (!await isSummary(input.sessionID, input.messageID)) return
        entry.done = input.messageID
        const result = shadowCheckpoint({ host: options.host, sessionId: input.sessionID, messages: entry.messages, summary: output.text,
          ...entry.prior ? { prior: entry.prior } : {} }, store)
        if (result.text !== undefined) output.text = result.text
      } catch (error) { fail(error) }
    },
    'tool.definition': async (input, output) => {
      try {
        // OpenCode marks every plain-JSON argument required; only observation_id is.
        if (input?.toolID === RECALL_TOOL_NAME && output) output.jsonSchema = RECALL_INPUT_SCHEMA
      } catch (error) { fail(error) }
    },
    event: async ({ event }) => {
      try {
        if (event?.type === 'session.compacted' || event?.type === 'session.idle') {
          const id = event.properties?.sessionID ?? event.properties?.info?.id
          if (id) pending.delete(id)
        }
      } catch (error) { fail(error) }
    },
    tool: {
      [RECALL_TOOL_NAME]: {
        description: RECALL_TOOL_DESCRIPTION,
        args: { ...RECALL_INPUT_SCHEMA.properties },
        async execute(args, ctx) {
          try {
            return recallFromJournal(args ?? {}, { host: options.host, sessionId: ctx?.sessionID ?? null, callId: ctx?.callID ?? null,
              artifacts: options.artifacts, read: options.read, readAll: options.readAll, journal: options.journal }).text
          } catch (error) {
            fail(error)
            return `recall failed: ${String((error as Error)?.message ?? error)}`
          }
        },
      },
    },
  }
}
