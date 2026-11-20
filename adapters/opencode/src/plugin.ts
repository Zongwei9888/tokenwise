/**
 * TokenWise for OpenCode. Economy: OpenCode's `tool.execute.after` hook hands
 * plugins a tool's result before it is stored and sent to the model; a
 * recognized `bash` result, and the complete result of OpenCode's own `glob`
 * and `grep` (./native.ts), is replaced by its deterministic projection, after
 * TokenWise saved the original and journaled the decision. The command runs
 * as the model wrote it, so permissions are untouched. Any failure delivers
 * the original. When an answer ends, a toast says what the conversation saved.
 * LightShadow (./shadow.ts): OpenCode's compaction summary becomes a
 * checkpoint whose tool results `tokenwise_recall` reads again.
 */
import { EconomyEngine, describeToolCall, markSavingsTold, repeatReadCandidate, savedCard, untoldSavings } from '@tokenwise/mechanisms'
import type { ConversationSavings } from '@tokenwise/mechanisms'
import { ECONOMY_SPEC, HOST_PROFILES, LIGHTSHADOW_SPEC, negotiate } from '@tokenwise/protocol'
import type { ArtifactPort } from '@tokenwise/protocol'
import { FileArtifactStore, FileJournal, RuleStore, collectDaily, dataDirs, loadConfig, readJournals, resolveDataDir, writableDataDir } from '@tokenwise/store'
import { bashShellResult } from './bash.ts'
import type { BashOutput } from './bash.ts'
import { NATIVE_TOOLS, nativeResult } from './native.ts'
import { readNotice, showNotice } from './notice.ts'
import { collapseRepeatReads } from './repeat.ts'
import type { ToastClient } from './notice.ts'
import { createShadowHooks } from './shadow.ts'
import type { OpenCodeClient, ShadowHooks } from './shadow.ts'

export const HOST = 'opencode'

/** The part of OpenCode's plugin context TokenWise reads. */
export interface PluginInput { readonly directory?: string; readonly client?: OpenCodeClient & ToastClient }
export interface ToolAfterInput { readonly tool: string; readonly sessionID?: string; readonly callID?: string; readonly args?: unknown }
export interface Hooks extends Partial<ShadowHooks> {
  'tool.execute.after'?: (input: ToolAfterInput, output: BashOutput) => Promise<void>
}

export interface TokenWiseOpenCodeOptions {
  readonly env?: NodeJS.ProcessEnv
  /** Diagnostics; errors never reach the tool result or the compaction. */
  readonly onError?: (error: unknown) => void
  /** The startup notice's text, and marking it told (tests); default: `tokenwise notice opencode --peek`, then `--told`. */
  readonly notice?: () => Promise<string | undefined>
  readonly told?: () => Promise<unknown>
}

/** The plugin: one instance per project directory OpenCode serves. */
export function createTokenWise(options: TokenWiseOpenCodeOptions = {}): (input: PluginInput) => Promise<Hooks> {
  return async ({ directory, client }) => {
    const env = options.env ?? process.env
    const configDir = resolveDataDir(env)
    const loaded = loadConfig({ dataDir: configDir, cwd: directory ?? process.cwd(), env })
    const [economy, shadow] = negotiate([ECONOMY_SPEC, LIGHTSHADOW_SPEC], HOST_PROFILES[HOST]!.capabilities,
      { economy: loaded.config.economy.mode, lightshadow: loaded.config.lightshadow.mode })
    // Originals must be savable before anything is filtered or compacted.
    const dataDir = writableDataDir(env)
    if (dataDir === undefined) return {}
    const journal = new FileJournal(dataDir), store = new FileArtifactStore(dataDir), rules = new RuleStore(configDir)
    const dirs = dataDirs(env)
    const artifacts: ArtifactPort = {
      save: text => store.save(text),
      read: hash => { for (const dir of dirs) { const text = new FileArtifactStore(dir).read(hash); if (text !== undefined) return text } return undefined },
    }
    try { collectDaily(dataDir, days => store.prune(days), loaded.config.artifacts.retentionDays) } catch { /* Housekeeping only. */ }
    const hooks: Hooks = {}
    if (shadow?.mode === 'apply') {
      Object.assign(hooks, createShadowHooks({ host: HOST, journal, artifacts, ...client ? { client } : {},
        read: sessionId => readJournals(dirs, { host: HOST, sessionId }), readAll: () => readJournals(dirs),
        ...options.onError ? { onError: options.onError } : {} }))
    }
    if (economy && economy.mode !== 'off') {
      const engine = new EconomyEngine({ host: HOST, journal, artifacts: store, config: loaded.config.economy, mode: economy.mode,
        delivery: 'in-process', streams: 'merged', learned: () => rules.load(),
        ...options.onError ? { onError: options.onError } : {} })
      hooks['tool.execute.after'] = async (input, output) => {
        // OpenCode's own glob and grep: their complete rendering, laid out without losing a path or a row.
        if (NATIVE_TOOLS.has(input.tool)) {
          try {
            const native = nativeResult(input.tool, output)
            if (!native?.projection) return
            const { text } = engine.process({ sessionId: input.sessionID || null, callId: input.callID || null, tool: input.tool,
              command: describeToolCall(input.tool, input.args), native })
            if (text !== undefined) output.output = text
          } catch (error) { options.onError?.(error) }
          return
        }
        // A read is journaled when it is sent (below); any other tool's text as it is.
        if (input.tool !== 'bash') {
          if (input.tool === 'read' || typeof output.output !== 'string' || output.output === '') return
          try {
            engine.process({ sessionId: input.sessionID || null, callId: input.callID || null, tool: input.tool,
              command: describeToolCall(input.tool, input.args), native: { rendered: output.output, projection: undefined } })
          } catch (error) { options.onError?.(error) }
          return
        }
        try {
          const result = bashShellResult(input.args, output)
          if (!result) return
          const { text } = engine.process({ sessionId: input.sessionID || null, callId: input.callID || null, tool: 'bash', result })
          // Only in place: OpenCode keeps this object, so reassigning the parameter would change nothing.
          if (text !== undefined) output.output = text
        } catch (error) { options.onError?.(error) }
      }
      // Reads, decided anew for every request on the copy OpenCode is about to send (./repeat.ts): a repeat of a read
      // still in that copy goes as a note. Each read is journaled once, the first time it is sent.
      if (economy.mode === 'apply') {
        const shadowTransform = hooks['experimental.chat.messages.transform']
        const journaled = new Set<string>()
        hooks['experimental.chat.messages.transform'] = async (input, output) => {
          await shadowTransform?.(input, output)
          try {
            if (!Array.isArray(output?.messages)) return
            for (const read of collapseRepeatReads(output.messages)) {
              if (!read.callId || journaled.has(read.callId)) continue
              journaled.add(read.callId)
              if (journaled.size > 4096) journaled.delete(journaled.values().next().value!)
              const what = (read.input as { filePath: string }).filePath
              engine.process({ sessionId: read.sessionId ?? null, callId: read.callId, tool: 'read', command: describeToolCall('read', read.input),
                native: { rendered: read.output, projection: read.collapsed ? repeatReadCandidate(read.output, what) : undefined } })
            }
          } catch (error) { options.onError?.(error) }
        }
      }
    }
    // Switched off: nothing at all.
    if (!Object.keys(hooks).length) return hooks
    // A new top-level session (not a subagent's) shows the startup notice, without holding up OpenCode's events.
    const shadowEvent = hooks.event
    // The end of an answer (session.idle) in a top-level session: what TokenWise saved in it so far, when that grew
    // since it was last said (kept on disk, so a restart or a resumed session does not say it again). Told once shown.
    const children = new Set<string>()
    const read = (id: string) => readJournals(dirs, { host: HOST, sessionId: id })
    // One at a time per session: a second idle before the first toast is told would say the same number again.
    const saying = new Set<string>()
    const sayConversation = async (sessionId: string) => {
      if (saying.has(sessionId)) return
      saying.add(sessionId)
      let savings: ConversationSavings | undefined
      try {
        await showNotice(client, async () => (savings = untoldSavings(read, dirs, HOST, sessionId)) && savedCard(savings, { lines: true, untitled: true }),
          async () => { if (savings) markSavingsTold(dataDir, HOST, sessionId, savings.savedTokens) }, 8_000)
      } finally { saying.delete(sessionId) }
    }
    hooks.event = async input => {
      if (shadowEvent) await shadowEvent(input)
      const event = input?.event
      const info = event?.properties?.info
      if (event?.type === 'session.created' && info?.parentID && typeof info.id === 'string') children.add(info.id)
      if (event?.type === 'session.created' && !info?.parentID) void showNotice(client, options.notice ?? (() => readNotice(env)), options.told ?? (() => readNotice(env, '--told')))
      const idle = event?.properties?.sessionID
      if (event?.type === 'session.idle' && economy && typeof idle === 'string' && !children.has(idle)) {
        void sayConversation(idle)
      }
    }
    return hooks
  }
}
