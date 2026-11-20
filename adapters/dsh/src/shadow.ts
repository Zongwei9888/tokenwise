/**
 * LightShadow for DeepSeek Harness 0.2.x. DSH compacts with
 * `@deepseek-ai/dsh-compaction-basic`, mounted once per agent preset (the Web
 * app isolates it inside each preset), and cuts long tool results first with
 * `@deepseek-ai/dsh-compaction-tool-result-pruner`. Neither offers a hook, so
 * LightShadow finds each engine through the `agent/pre-step` listener it
 * registers and wraps two of its methods on that instance:
 *
 * - `summarize(input, agent, signal)`, which BasicCompactionEngine documents
 *   as its customization point: DSH's own summarizer condenses the span, tool
 *   results in full, and the checkpoint is its summary, the user's exact
 *   messages and the catalog of the saved results. A checkpoint that is not
 *   smaller, or any failure, runs DSH's summarizer on the original span instead.
 * - the pruner's `pruneContent(blocks)`: the complete text of a result it cuts
 *   to a head and tail is saved, and its marker names the observation to recall.
 *
 * Everything else (range selection, the transaction, retries, the session
 * log) stays DSH's. `tokenwise_recall` reads a reference again.
 */
import {
  RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME, SHADOW_SUMMARY_INSTRUCTION, callLabel, checkpointRecord, cutNote, externalizeCut,
  fitCheckpoint, planShadow, recallIndex, recallObservation, referenceIndex, renderCheckpoint, renderRecall,
} from '@tokenwise/mechanisms'
import type { RecallResult, ShadowMessage, ShadowPlan } from '@tokenwise/mechanisms'
import type { ArtifactPort, EconomyRecord, JournalPort, JournalRecord, MechanismMode, ShadowReference } from '@tokenwise/protocol'
import type { ContentBlock, HostSession } from './host.ts'

/** DSH's pruner marker (`PRUNE_MARKER` of the pruner package, 0.2.x). */
export const DSH_PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
/** Room for DSH's checkpoint preamble and tags when comparing sizes. */
const FRAMING_TOKENS = 96
const WRAPPED = Symbol.for('tokenwise.lightshadow.wrapped')

interface HostMessage {
  readonly role: string
  readonly content: readonly ContentBlock[]
  readonly source?: { readonly kind?: string }
  readonly toolCallId?: string
  readonly [key: string]: unknown
}

/** `SummarizationInput` of compaction-basic (not exported by the package). */
export interface SummarizationInput { readonly tools?: readonly unknown[]; readonly messages: readonly HostMessage[] }
export interface SummaryResult { summary: ContentBlock[]; readonly [key: string]: unknown }
export interface HostAgent { readonly session: HostSession }

type Summarize = (input: SummarizationInput, agent: HostAgent, signal?: AbortSignal) => Promise<SummaryResult>
interface Engine { summarize?: Summarize; [WRAPPED]?: true }
interface Pruner { pruneContent?: (blocks: readonly ContentBlock[]) => ContentBlock[] | null; [WRAPPED]?: true }
/** The part of cordis LightShadow reads to find the engines: `ctx.events._hooks`. */
interface HookRegistry { readonly _hooks?: Record<string, readonly { readonly ctx?: { get?: (name: string) => unknown } }[]> }

export interface DshShadowOptions {
  readonly host: string
  /** Negotiated LightShadow mode for a session. */
  readonly mode: (session: { id: string; cwd?: string | undefined }) => MechanismMode
  readonly journal: () => JournalPort
  readonly artifacts: () => ArtifactPort
  readonly read: (sessionId: string) => readonly JournalRecord[]
  readonly warn?: (message: string) => void
  readonly now?: () => Date
}

/** DSH's token meter (`ctx.tokenMeter.estimateMessage`) as the agent's context offers it, if any. */
function meterOf(agent: HostAgent): ((message: HostMessage) => number) | undefined {
  try {
    const ctx = (agent as { ctx?: { get?: (name: string) => unknown } }).ctx
    const meter = ctx?.get?.('tokenMeter') as { estimateMessage?: (message: unknown) => unknown } | undefined
    if (typeof meter?.estimateMessage !== 'function') return undefined
    return message => {
      const value = meter.estimateMessage!(message)
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('token meter returned no number')
      return value
    }
  } catch { return undefined }
}

const texts = (blocks: readonly ContentBlock[]): string | undefined => {
  let text = ''
  for (const [i, block] of blocks.entries()) {
    if (block.type !== 'text' || typeof block.text !== 'string') return undefined
    text += (i ? '\n' : '') + block.text
  }
  return text
}

/** Text blocks as they are; any other block (an image, a file) as a short placeholder. */
const describeBlocks = (blocks: readonly ContentBlock[]) =>
  blocks.map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type}]`).join('\n')

/** DSH messages as LightShadow reads them; the system head is no part of the segment. */
export function shadowMessages(messages: readonly HostMessage[]): { segment: ShadowMessage[]; indexes: number[] } {
  const names = new Map<string, string>()
  const calls = new Map<string, string>()
  const segment: ShadowMessage[] = []
  const indexes: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') continue
    let item: ShadowMessage
    if (message.role === 'assistant') {
      const parts: string[] = []
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block.type === 'tool-call' && typeof block.id === 'string') {
          names.set(block.id, String(block.name))
          const label = callLabel(block.arguments)
          if (label) calls.set(block.id, label)
          parts.push(`${String(block.name)} ${String(block.arguments ?? '')}`)
        }
      }
      item = { role: 'assistant', text: parts.join('\n') }
    } else if (message.role === 'tool') {
      const text = texts(message.content)
      const name = message.toolCallId === undefined ? undefined : names.get(message.toolCallId)
      const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId)
      item = text === undefined ? { role: 'other', text: describeBlocks(message.content) }
        : { role: 'tool', text, ...name ? { toolName: name } : {}, ...message.toolCallId ? { callId: message.toolCallId } : {}, ...call ? { call } : {} }
    } else if (message.role === 'user') {
      const text = message.content.filter(block => block.type === 'text').map(block => String(block.text)).join('\n')
      const kind = message.source?.kind
      item = { role: kind === 'compact-checkpoint' ? 'summary' : kind === 'user' ? 'user' : 'other', text }
    } else {
      item = { role: 'other', text: describeBlocks(message.content) }
    }
    segment.push(item)
    indexes.push(index)
  }
  return { segment, indexes }
}

export interface DshShadow {
  /** Find compaction engines and pruners DSH mounted since the last call, and wrap them. */
  discover(events: unknown): void
  /** The `tokenwise_recall` tool's work, for one session. */
  recall(session: { id: string }, args: unknown, callId: string | null): { text: string; result: RecallResult }
  /** Engines and pruners wrapped so far. */
  readonly attached: { engines: number; pruners: number }
}

export function createDshShadow(options: DshShadowOptions): DshShadow {
  const time = () => (options.now?.() ?? new Date()).toISOString()
  const append = (record: JournalRecord) => {
    try { options.journal().append(record) } catch (error) { options.warn?.(`TokenWise: ${String(error)}`) }
  }
  const attached = { engines: 0, pruners: 0 }
  /** The session whose results the pruner is cutting (pruneSession runs synchronously). */
  let cutting: { id: string; cwd?: string | undefined } | undefined

  const sessionOf = (agent: HostAgent) => ({ id: String(agent.session.id), cwd: agent.session.header?.cwd })

  const wrapEngine = (engine: Engine) => {
    if (engine[WRAPPED] || typeof engine.summarize !== 'function') return
    const original = engine.summarize.bind(engine)
    engine.summarize = async (input, agent, signal) => {
      const session = sessionOf(agent)
      let mode: MechanismMode
      try { mode = options.mode(session) } catch { mode = 'off' }
      if (mode === 'off') return original(input, agent, signal)
      const base = () => ({ host: options.host, sessionId: session.id, time: time() })
      let prepared: { plan: ShadowPlan; messages: HostMessage[]; spanTokens: number; measure: (text: string) => number } | undefined
      try {
        const records = options.read(session.id)
        const known = referenceIndex(records)
        const originals = new Map<string, { sha256: string; bytes: number }>()
        for (const record of records) {
          const economy = record as EconomyRecord
          if (economy.type === 'economy/decision' && economy.outcome === 'projected' && economy.callId && economy.raw?.stored) {
            originals.set(economy.callId, { sha256: economy.raw.sha256, bytes: economy.raw.bytes })
          }
        }
        const { segment, indexes } = shadowMessages(input.messages)
        const plan = planShadow(segment, { artifacts: options.artifacts(), knownReference: id => known.get(id), originalOf: id => originals.get(id) })
        if (mode === 'observe') {
          append(checkpointRecord(base(), { kind: 'standard', plan, checkpointTokens: 0, reason: 'observe' }))
          return original(input, agent, signal)
        }
        // Price the span and the checkpoint the way DSH's own size check does, when its meter is reachable.
        const meter = meterOf(agent)
        const measure = (text: string) => meter ? meter({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }) : Math.ceil(text.length / 4) + FRAMING_TOKENS
        const spanTokens = meter ? input.messages.filter(message => message.role !== 'system').reduce((sum, message) => sum + meter(message), 0) : plan.segmentTokens
        // What the checkpoint adds besides the summary must leave room for one. Right after another compaction,
        // the span is mostly the earlier checkpoint: its catalog, listed by call alone, still leaves room, and
        // DSH's own summary of that span would drop every observation_id.
        if (fitCheckpoint('', plan, text => measure(text) < spanTokens * 0.6) === undefined) {
          append(checkpointRecord(base(), { kind: 'standard', plan, checkpointTokens: measure(renderCheckpoint('', plan, { excerpts: 0 })), reason: 'checkpoint-not-smaller' }))
          return original(input, agent, signal)
        }
        const messages = [...input.messages]
        for (const [i, index] of indexes.entries()) {
          const item = segment[i]!, residual = plan.residual[i]!
          // The summarizer reads the tool results in full, so the summary keeps their findings (with references
          // only, agents re-ran commands instead of recalling). An earlier checkpoint loses the user messages and
          // catalog the plan carries.
          if (item.role === 'summary' && residual.text !== item.text) {
            messages[index] = { ...messages[index]!, content: [{ type: 'text', text: residual.text }] }
          }
        }
        // DSH's summarizer appends its own instruction after the conversation; LightShadow's note goes last in the span.
        messages.push({ role: 'user', content: [{ type: 'text', text: SHADOW_SUMMARY_INSTRUCTION }], source: { kind: 'user' } })
        prepared = { plan, messages, spanTokens, measure }
      } catch (error) {
        if (signal?.aborted) throw error
        options.warn?.(`TokenWise compaction: ${String(error)}; using DSH's own compaction`)
        append(checkpointRecord(base(), { kind: 'standard', plan: { references: [], contract: [], segmentTokens: 0 }, checkpointTokens: 0, reason: 'error', error }))
        return original(input, agent, signal)
      }
      // DSH's own errors (rate limits, overflow) go to DSH's recovery unchanged.
      const result = await original({ ...input, messages: prepared.messages }, agent, signal)
      const { plan, spanTokens, measure } = prepared
      const summary = result.summary.filter(block => block.type === 'text').map(block => String(block.text)).join('\n')
      const text = fitCheckpoint(summary, plan, candidate => measure(candidate) < spanTokens * 0.9)
      if (text === undefined) {
        append(checkpointRecord(base(), { kind: 'standard', plan, checkpointTokens: measure(renderCheckpoint(summary, plan, { excerpts: 0 })), reason: 'checkpoint-not-smaller' }))
        return original(input, agent, signal)
      }
      const tokens = measure(text)
      append(checkpointRecord(base(), { kind: 'lightshadow', plan, checkpointTokens: tokens, addedTokens: tokens - measure(summary) }))
      return { ...result, summary: [{ type: 'text', text }] }
    }
    engine[WRAPPED] = true
    attached.engines++
  }

  const wrapPruner = (pruner: Pruner & { pruneSession?: (session: HostSession) => unknown }) => {
    if (pruner[WRAPPED] || typeof pruner.pruneContent !== 'function' || typeof pruner.pruneSession !== 'function') return
    const content = pruner.pruneContent.bind(pruner)
    const session = pruner.pruneSession.bind(pruner)
    pruner.pruneSession = (target: HostSession) => {
      cutting = { id: String(target.id), cwd: target.header?.cwd }
      try { return session(target) } finally { cutting = undefined }
    }
    pruner.pruneContent = blocks => {
      const pruned = content(blocks)
      if (pruned === null || cutting === undefined) return pruned
      try {
        if (options.mode(cutting) !== 'apply') return pruned
        const full = texts(blocks)
        const markerAt = pruned.findIndex(block => block.type === 'text' && typeof block.text === 'string' && block.text.includes(DSH_PRUNE_MARKER))
        if (full === undefined || markerAt < 0) return pruned
        const reference = externalizeCut(full, { artifacts: options.artifacts(), tool: 'tool' })
        if (!reference) return pruned
        const kept = texts(pruned)?.length ?? full.length
        const note = cutNote(reference, full.length - kept + DSH_PRUNE_MARKER.length)
        // The pruner checked its own size before this note replaced its marker: stay within its threshold,
        // or the next pass would cut the result again.
        const threshold = (pruner as { config?: { thresholdChars?: unknown } }).config?.thresholdChars
        if (typeof threshold === 'number' && kept - DSH_PRUNE_MARKER.length + note.length > threshold) return pruned
        const block = pruned[markerAt]!
        const next = [...pruned]
        next[markerAt] = { ...block, text: String(block.text).replace(DSH_PRUNE_MARKER, note) }
        append(checkpointRecord({ host: options.host, sessionId: cutting.id, time: time() },
          { kind: 'cut', plan: { references: [reference], contract: [], segmentTokens: Math.ceil(full.length / 4) }, checkpointTokens: Math.ceil(kept / 4),
            addedTokens: Math.ceil((note.length - DSH_PRUNE_MARKER.length) / 4) }))
        return next
      } catch (error) {
        options.warn?.(`TokenWise compaction: ${String(error)}; keeping DSH's cut`)
        return pruned
      }
    }
    pruner[WRAPPED] = true
    attached.pruners++
  }

  return {
    attached,
    discover(events) {
      const hooks = (events as HookRegistry | undefined)?._hooks?.['agent/pre-step']
      if (!Array.isArray(hooks)) return
      for (const hook of hooks) {
        const get = hook.ctx?.get
        if (typeof get !== 'function') continue
        let engine: unknown, pruner: unknown
        try { engine = get.call(hook.ctx, 'compaction'); pruner = get.call(hook.ctx, 'toolResultPruner') } catch { continue }
        if (engine && typeof engine === 'object') wrapEngine(engine as Engine)
        if (pruner && typeof pruner === 'object') wrapPruner(pruner as Pruner & { pruneSession?: (session: HostSession) => unknown })
      }
    },
    recall(session, args, callId) {
      const index = recallIndex(options.read(session.id))
      const input = (args ?? {}) as { observation_id?: unknown; query?: unknown; line?: unknown; original?: unknown }
      const result = recallObservation(input, { lookup: id => index.get(id), artifacts: options.artifacts() })
      const id = typeof input.observation_id === 'string' ? input.observation_id.trim() : ''
      const text = renderRecall(id, result)
      append({ schemaVersion: 1, type: 'shadow/recall', time: time(), host: options.host, sessionId: session.id, callId,
        id, original: input.original === true, outcome: !result.ok ? 'failed' : result.complete ? 'returned' : 'window', bytes: Buffer.byteLength(text) })
      return { text, result }
    },
  }
}

export const RECALL_TOOL = { name: RECALL_TOOL_NAME, description: RECALL_TOOL_DESCRIPTION } as const
export type { ShadowReference }
