/**
 * LightShadow for pi: recoverable compaction through `session_before_compact`.
 * Tool results in the segment pi is about to summarize are saved and replaced
 * by references; pi's own summarizer (`compact`, the same call and model pi
 * uses) condenses what is left; TokenWise appends the user's messages word for
 * word and the catalog of references; `tokenwise_recall` reads any of them
 * again. A checkpoint that is not smaller, or any failure, leaves the
 * compaction to pi.
 */
import { compact } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { TSchema } from '@earendil-works/pi-ai'
import {
  RECALL_PROMPT_SNIPPET, RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME, SHADOW_SUMMARY_INSTRUCTION, callLabel, checkpointAdmitted, checkpointRecord, fitCheckpoint, planShadow, recallIndex, recallObservation,
  renderCheckpoint, renderRecall,
} from '@tokenwise/mechanisms'
import type { ShadowMessage } from '@tokenwise/mechanisms'
import type { ArtifactPort, EconomyRecord, JournalPort, JournalRecord, ShadowReference } from '@tokenwise/protocol'

type AgentMessage = SessionBeforeCompactEvent['preparation']['messagesToSummarize'][number]

/** Stored on pi's compaction entry, so a forked or resumed session can still recall what its checkpoints list. */
export interface LightShadowDetails {
  readonly lightshadow: { readonly version: 1; readonly references: readonly ShadowReference[] }
}

export interface PiShadowOptions {
  readonly host: string
  readonly journal: JournalPort
  readonly artifacts: ArtifactPort
  /** `apply`, `observe` or `off`, decided per session. */
  readonly mode: (ctx: ExtensionContext) => 'apply' | 'observe' | 'off'
  readonly sessionId: (ctx: ExtensionContext) => string | null
  readonly read: (sessionId: string) => readonly JournalRecord[]
  readonly onError?: (error: unknown) => void
  /** Tests replace pi's summarizer. */
  readonly summarize?: typeof compact
  readonly now?: () => Date
}

const RECALL_PARAMETERS = {
  type: 'object',
  properties: {
    observation_id: { type: 'string', description: 'Such as o-1a2b3c4d5e6f.' },
    query: { type: 'string', description: 'An exact string it contains: read around its first match.' },
    line: { type: 'integer', minimum: 1, description: 'A 1-based line to read around.' },
    original: { type: 'boolean', description: 'For a catalog entry marked original: the output before TokenWise shortened it.' },
  },
  required: ['observation_id'],
  additionalProperties: false,
} as unknown as TSchema

const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    text += (text ? '\n' : '') + block.text
  }
  return text
}

/** pi's messages as LightShadow reads them; a tool result carries the label of the call that produced it. */
export function shadowMessages(messages: readonly AgentMessage[]): ShadowMessage[] {
  const calls = new Map<string, string>()
  return messages.map(message => {
    const value = message as unknown as { role: string; content?: unknown }
    if (value.role === 'assistant' && Array.isArray(value.content)) {
      for (const block of value.content as { type?: string; id?: string; arguments?: unknown }[]) {
        const label = block.type === 'toolCall' && typeof block.id === 'string' ? callLabel(block.arguments) : undefined
        if (label) calls.set(block.id!, label)
      }
    }
    return shadowMessage(message, calls)
  })
}

/** pi's message as LightShadow reads it. Only all-text tool results can become references. */
export function shadowMessage(message: AgentMessage, calls?: ReadonlyMap<string, string>): ShadowMessage {
  const value = message as unknown as { role: string; content?: unknown; toolCallId?: string; toolName?: string }
  if (value.role === 'toolResult') {
    const text = textOf(value.content)
    const call = value.toolCallId ? calls?.get(value.toolCallId) : undefined
    if (text !== undefined) return { role: 'tool', text, ...value.toolName ? { toolName: value.toolName } : {}, ...value.toolCallId ? { callId: value.toolCallId } : {}, ...call ? { call } : {} }
  }
  if (value.role === 'user') {
    const text = typeof value.content === 'string' ? value.content
      : Array.isArray(value.content) ? (value.content as { type?: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
    return { role: 'user', text }
  }
  if (value.role === 'assistant' && Array.isArray(value.content)) {
    const parts = (value.content as { type?: string; text?: string; name?: string; arguments?: unknown }[]).map(block =>
      block.type === 'text' ? block.text ?? '' : block.type === 'toolCall' ? `${block.name ?? 'tool'} ${JSON.stringify(block.arguments ?? {})}` : '')
    return { role: 'assistant', text: parts.filter(Boolean).join('\n') }
  }
  return { role: 'other', text: JSON.stringify(message) }
}

/** References listed by LightShadow compaction entries on the current branch, newest last. */
export function branchReferences(entries: readonly SessionEntry[]): Map<string, ShadowReference> {
  const found = new Map<string, ShadowReference>()
  for (const entry of entries) {
    if (entry.type !== 'compaction') continue
    const details = (entry as { details?: Partial<LightShadowDetails> }).details?.lightshadow
    if (details?.version !== 1 || !Array.isArray(details.references)) continue
    for (const reference of details.references) if (typeof reference?.id === 'string') found.set(reference.id, reference)
  }
  return found
}

export function registerLightShadow(pi: ExtensionAPI, options: PiShadowOptions): void {
  const summarize = options.summarize ?? compact
  const time = () => (options.now?.() ?? new Date()).toISOString()
  const append = (record: JournalRecord) => {
    try { options.journal.append(record) } catch (error) { options.onError?.(error) }
  }
  const activate = () => {
    try {
      const active = pi.getActiveTools()
      if (!active.includes(RECALL_TOOL_NAME)) pi.setActiveTools([...active, RECALL_TOOL_NAME])
    } catch (error) { options.onError?.(error) }
  }

  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: 'Recall',
    description: RECALL_TOOL_DESCRIPTION,
    promptSnippet: RECALL_PROMPT_SNIPPET,
    parameters: RECALL_PARAMETERS,
    // Declared to the model only once a checkpoint lists something to recall.
    defaultActive: false,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const args = params as { observation_id?: unknown; query?: unknown; line?: unknown; original?: unknown }
      const references = branchReferences(ctx.sessionManager.getBranch())
      const sessionId = options.sessionId(ctx)
      let journal: Map<string, ShadowReference> | undefined
      // Outputs Economy shortened are reachable by the ID its hint names, before any compaction.
      const lookup = (id: string) => references.get(id) ?? (sessionId ? (journal ??= recallIndex(options.read(sessionId))).get(id) : undefined)
      const result = recallObservation(args, { lookup, artifacts: options.artifacts })
      const id = typeof args.observation_id === 'string' ? args.observation_id.trim() : ''
      const text = renderRecall(id, result)
      append({ schemaVersion: 1, type: 'shadow/recall', time: time(), host: options.host, sessionId: options.sessionId(ctx), callId: toolCallId,
        id, original: args.original === true, outcome: !result.ok ? 'failed' : result.complete ? 'returned' : 'window', bytes: Buffer.byteLength(text) })
      return { content: [{ type: 'text', text }], details: { observation_id: id, ok: result.ok } }
    },
  })

  pi.on('session_start', (_event, ctx) => {
    if (options.mode(ctx) !== 'apply') return
    if (branchReferences(ctx.sessionManager.getBranch()).size > 0) activate()
  })

  pi.on('session_before_compact', async (event, ctx) => {
    const mode = options.mode(ctx)
    if (mode === 'off') return undefined
    const sessionId = options.sessionId(ctx)
    const base = { host: options.host, sessionId, time: time() }
    const { preparation } = event
    try {
      const known = branchReferences(event.branchEntries)
      const originals = new Map<string, { sha256: string; bytes: number }>()
      if (sessionId) {
        for (const record of options.read(sessionId)) {
          const economy = record as EconomyRecord
          if (economy.type === 'economy/decision' && economy.outcome === 'projected' && economy.callId && economy.raw?.stored) {
            originals.set(economy.callId, { sha256: economy.raw.sha256, bytes: economy.raw.bytes })
          }
        }
      }
      const summarized = preparation.messagesToSummarize
      const prefix = preparation.turnPrefixMessages
      const plan = planShadow(shadowMessages([...summarized, ...prefix]), {
        artifacts: options.artifacts, knownReference: id => known.get(id), originalOf: id => originals.get(id),
        ...preparation.previousSummary === undefined ? {} : { prior: preparation.previousSummary },
      })
      if (mode === 'observe') {
        append(checkpointRecord(base, { kind: 'standard', plan, checkpointTokens: 0, reason: 'observe' }))
        return undefined
      }
      const model = ctx.model
      if (!model) throw new Error('no model selected')
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      if (!auth.ok) throw new Error(auth.error)
      const routed = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model
      // A null header value means "remove this default header" to pi; the summarizer takes plain strings.
      const headers = auth.headers === undefined ? undefined
        : Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      // The previous checkpoint's summary only: its user messages and catalog are carried in `plan`.
      const previousSummary = preparation.previousSummary === undefined ? undefined : plan.residualPrior
      const run = (instructions: string | undefined) => summarize({
        ...preparation,
        // The summarizer reads the tool results in full, so the summary keeps their findings (with references
        // only, agents re-ran commands instead of recalling); the checkpoint keeps references to them.
        messagesToSummarize: summarized,
        turnPrefixMessages: prefix,
        ...previousSummary === undefined ? {} : { previousSummary },
      }, routed, auth.apiKey, headers, instructions, event.signal, ctx.thinkingLevel)
      let result: Awaited<ReturnType<typeof summarize>>
      try {
        result = await run([event.customInstructions, SHADOW_SUMMARY_INSTRUCTION].filter(Boolean).join('\n\n'))
      } catch (error) {
        // A summary that ran past pi's output budget (a real DeepSeek run hit it once in a ~1M-token span) fails
        // compact(): summarize again with pi's own instructions, as pi's fallback would, and keep the references.
        if (event.signal.aborted) return undefined
        options.onError?.(error)
        result = await run(event.customInstructions)
      }
      if (event.signal.aborted) return undefined
      // Right after another compaction the earlier catalog can fill most of the segment: list it by call alone then.
      const text = fitCheckpoint(result.summary, plan, candidate => checkpointAdmitted(candidate, plan))
      if (text === undefined) {
        const compact = renderCheckpoint(result.summary, plan, { excerpts: 0 })
        append(checkpointRecord(base, { kind: 'standard', plan, checkpointTokens: Math.ceil(compact.length / 4), reason: 'checkpoint-not-smaller' }))
        return undefined
      }
      append(checkpointRecord(base, { kind: 'lightshadow', plan, checkpointTokens: Math.ceil(text.length / 4),
        addedTokens: Math.ceil(text.length / 4) - Math.ceil(result.summary.length / 4) }))
      if (plan.references.length > 0) activate()
      const details: LightShadowDetails & Record<string, unknown> = {
        ...typeof result.details === 'object' && result.details !== null ? result.details as Record<string, unknown> : {},
        lightshadow: { version: 1, references: plan.references },
      }
      return { compaction: { ...result, summary: text, details } }
    } catch (error) {
      if (event.signal.aborted) return undefined
      options.onError?.(error)
      append({ ...checkpointRecord(base, { kind: 'standard', plan: { references: [], contract: [], segmentTokens: 0 }, checkpointTokens: 0,
        reason: 'error', error }) })
      return undefined
    }
  })
}
