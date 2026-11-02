/**
 * TokenWise for OpenCode. Economy: OpenCode's `tool.execute.after` hook hands
 * plugins the bash result before it is stored and sent to the model; a
 * recognized result is replaced by its deterministic projection, after
 * TokenWise saved the original and journaled the decision. The command runs
 * as the model wrote it, so permissions are untouched. Any failure delivers
 * the original. LightShadow (./shadow.ts): OpenCode's compaction summary
 * becomes a checkpoint whose tool results `tokenwise_recall` reads again.
 */
import { EconomyEngine } from '@tokenwise/mechanisms'
import { ECONOMY_SPEC, HOST_PROFILES, LIGHTSHADOW_SPEC, negotiate } from '@tokenwise/protocol'
import type { ArtifactPort } from '@tokenwise/protocol'
import { FileArtifactStore, FileJournal, RuleStore, collectDaily, dataDirs, loadConfig, readJournals, resolveDataDir, writableDataDir } from '@tokenwise/store'
import { bashShellResult } from './bash.ts'
import type { BashOutput } from './bash.ts'
import { readNotice, showNotice } from './notice.ts'
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
        delivery: 'in-process', streams: 'merged', learned: () => rules.load(), recallHint: shadow?.mode === 'apply',
        ...options.onError ? { onError: options.onError } : {} })
      hooks['tool.execute.after'] = async (input, output) => {
        if (input.tool !== 'bash') return
        try {
          const result = bashShellResult(input.args, output)
          if (!result) return
          const { text } = engine.process({ sessionId: input.sessionID || null, callId: input.callID || null, tool: 'bash', result })
          // Only in place: OpenCode keeps this object, so reassigning the parameter would change nothing.
          if (text !== undefined) output.output = text
        } catch (error) { options.onError?.(error) }
      }
    }
    // Switched off: nothing at all.
    if (!Object.keys(hooks).length) return hooks
    // A new top-level session (not a subagent's) shows the startup notice, without holding up OpenCode's events.
    const shadowEvent = hooks.event
    hooks.event = async input => {
      if (shadowEvent) await shadowEvent(input)
      const event = input?.event
      if (event?.type === 'session.created' && !event.properties?.info?.parentID) void showNotice(client, options.notice ?? (() => readNotice(env)), options.told ?? (() => readNotice(env, '--told')))
    }
    return hooks
  }
}
