/**
 * Token Economy over DSH's `tools/post-execute` waterfall, without cordis:
 * `apply` in ./index.ts only wires these functions to the harness.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { EconomyEngine, collectSubagents, describeToolCall, formatTokens, recordSubagent, summarizeEconomy, summarizeShadow } from '@tokenwise/mechanisms'
import type { EconomySummary } from '@tokenwise/mechanisms'
import { HOST_PROFILES, V0_2_SPECS, negotiate } from '@tokenwise/protocol'
import type { ArtifactPort, JournalPort, JournalRecord, MechanismMode, Negotiation } from '@tokenwise/protocol'
import { FileArtifactStore, FileJournal, RuleStore, collectDaily, dataDirs, loadConfig, readJournals, resolveDataDir, writableDataDir } from '@tokenwise/store'
import type { LoadedConfig } from '@tokenwise/store'
import { bashShellResult, jobShellResult } from './bash.ts'
import { NATIVE_TOOLS, nativeResult } from './native.ts'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from './host.ts'

export const HOST = 'dsh'
export const MODES: readonly MechanismMode[] = ['apply', 'observe', 'off']
const RANK: Record<MechanismMode, number> = { off: 0, observe: 1, apply: 2 }
const MAX_SESSIONS = 256
const MAX_LINKED = 1024
const MAX_WARNINGS = 32
/**
 * DSH's spill policy keeps a result inline up to `maxInlineTokens` (12,500 by
 * default), estimated as characters / 4; past it the model reads a head/tail
 * preview and the full text goes to a spill file. A projection must stay
 * under that line, or the spill file would hold a sample instead of the original.
 */
export const INLINE_LIMIT_CHARS = 48_000

/** The learned rules new sessions use, for `/tokenwise`. */
function learnedRulesLine(store: RuleStore, enabled: boolean): string {
  const active = store.state().active
  if (!active) return 'Learned rules: none (/tokenwise learn learns them from your sessions).'
  const set = store.load()
  return `Learned rules: ${active.slice(0, 12)}, ${set ? `${set.rules.length} rule${set.rules.length === 1 ? '' : 's'}` : 'not loadable'}${enabled ? '' : ' (off: output.learnedRules is false)'}.`
}

export interface DshEconomyOptions {
  /** The plugin's live `mode` setting: a ceiling that can only lower TokenWise's own configuration. */
  readonly mode: () => MechanismMode
  /** Longest projection delivered; see {@link INLINE_LIMIT_CHARS}. */
  readonly inlineLimitChars?: number
  /** Bytes a background job has output so far (DSH's job registry); without it, `job_output` reads pass. */
  readonly jobOutputTotal?: (jobId: string, exec: ToolExecution) => number | undefined
  /** Defaults to `$TOKENWISE_HOME` or `~/.tokenwise`. */
  readonly dataDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly warn?: (message: string) => void
}

interface SessionState {
  readonly loaded: LoadedConfig
  /** Identity of the configuration files `loaded` was read from; a change reloads them. */
  readonly stamp: string
  readonly engines: Map<'apply' | 'observe', EconomyEngine>
}

export interface DshEconomy {
  /** Transform the downstream decision for one finished tool call; never throws. */
  postExecute(exec: ToolExecution, result: ToolExecutionResult, decision: PostToolDecision): PostToolDecision
  /** Negotiated mechanisms for a session (or the defaults when unknown). */
  negotiated(session?: { id: string; cwd?: string | undefined }): readonly Negotiation[]
  summary(sessionId: string): EconomySummary
  /** The `/tokenwise` text for one session. */
  report(session: { id: string; cwd?: string | undefined }): string
  /** Where originals and the journal are written (resolved on first use). */
  readonly dataDir: string
  /** Every location records may be in, primary first. */
  readonly dataDirs: readonly string[]
  /** Where configuration and learned rules live. */
  readonly configDir: string
  /** Negotiated LightShadow mode for a session. */
  shadowMode(session: { id: string; cwd?: string | undefined }): MechanismMode
  /** LightShadow as the user's own configuration and environment set it, before any session. */
  configuredShadowMode(): MechanismMode
  journal(): JournalPort
  artifacts(): ArtifactPort
  read(sessionId: string): readonly JournalRecord[]
  /** Extra lines for `/tokenwise`, such as LightShadow's state. */
  extraReport?: (sessionId: string) => readonly string[]
}

const fileStamp = (path: string) => {
  try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}` } catch { return '-' }
}

export function createDshEconomy(options: DshEconomyOptions): DshEconomy {
  const env = options.env ?? process.env
  const configDir = options.dataDir ?? resolveDataDir(env)
  const readDirs = options.dataDir ? [options.dataDir] : dataDirs(env)
  // Nothing is created on disk until TokenWise first has something to keep.
  let store: { dataDir: string; journal: FileJournal; artifacts: FileArtifactStore } | undefined
  const storage = () => {
    if (!store) {
      const dataDir = options.dataDir ?? writableDataDir(env) ?? configDir
      store = { dataDir, journal: new FileJournal(dataDir), artifacts: new FileArtifactStore(dataDir) }
    }
    return store
  }
  const ruleStore = new RuleStore(configDir)
  const sessions = new Map<string, SessionState>()
  const warned = new Set<string>()
  const warn = (message: string) => {
    if (warned.has(message) || warned.size >= MAX_WARNINGS) return
    warned.add(message)
    options.warn?.(message)
  }
  let lastCollected = 0

  const requestedMode = (): MechanismMode => {
    try {
      const requested = options.mode()
      return MODES.includes(requested) ? requested : 'off'
    } catch { return 'off' }
  }

  const sessionState = (id: string, cwd: string | undefined): SessionState => {
    const stamp = `${fileStamp(join(configDir, 'config.json'))}|${cwd === undefined ? '' : fileStamp(join(cwd, '.tokenwise', 'config.json'))}`
    let state = sessions.get(id)
    if (!state || state.stamp !== stamp) {
      const loaded = loadConfig({ dataDir: configDir, ...cwd === undefined ? {} : { cwd }, env })
      state = { loaded, stamp, engines: new Map() }
      sessions.delete(id)
      sessions.set(id, state)
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
    }
    return state
  }

  const negotiateFor = (loaded: LoadedConfig, requested = requestedMode()): readonly Negotiation[] => {
    const lower = (own: MechanismMode) => RANK[requested] < RANK[own] ? requested : own
    // DSH 0.2 cannot rewrite tool arguments, so command normalization negotiates off.
    return negotiate(V0_2_SPECS, HOST_PROFILES[HOST]!.capabilities, {
      economy: lower(loaded.config.economy.mode), 'command-normalization': 'off', lightshadow: lower(loaded.config.lightshadow.mode),
    })
  }

  const engineFor = (state: SessionState, mode: 'apply' | 'observe'): EconomyEngine => {
    let engine = state.engines.get(mode)
    if (!engine) {
      const { journal, artifacts } = storage()
      engine = new EconomyEngine({ host: HOST, journal, artifacts, config: state.loaded.config.economy, mode,
        maxProjectedChars: options.inlineLimitChars ?? INLINE_LIMIT_CHARS,
        delivery: 'in-process', streams: 'separate', onError: error => warn(`TokenWise: ${String(error)}; delivering the original output`),
        learned: () => ruleStore.load(error => warn(`TokenWise: learned rules not loaded: ${String(error)}`)) })
      state.engines.set(mode, engine)
    }
    return engine
  }

  /** Expire old originals at most daily, after the current tool result has been delivered. */
  const housekeeping = (retentionDays: number) => {
    const now = Date.now()
    if (now - lastCollected < 3_600_000) return
    lastCollected = now
    const { dataDir, artifacts } = storage()
    setTimeout(() => {
      try { collectDaily(dataDir, days => artifacts.prune(days), retentionDays) } catch { /* Housekeeping only. */ }
    }, 0).unref?.()
  }

  const sessionOf = (exec: ToolExecution) => {
    const session = exec.agent?.session
    return session === undefined ? undefined : { id: String(session.id), cwd: session.header?.cwd }
  }

  /** Subagent sessions already recorded under their parent. */
  const linked = new Set<string>()
  const linkSubagent = (exec: ToolExecution) => {
    const session = exec.agent?.session
    const header = session?.header
    // In-process subagents (spawn and fork) record their parent; a conversation the user forked is no subagent.
    if (!session || header?.origin !== 'subagent' || typeof header.parentSession !== 'string') return
    const child = String(session.id)
    if (linked.has(child)) return
    try {
      recordSubagent(storage().journal, HOST, header.parentSession, child)
    } catch (error) {
      // Only the parent's report loses this subagent; the tool result is still filtered.
      warn(`TokenWise: could not record subagent session ${child}: ${String(error)}`)
    }
    linked.add(child)
    if (linked.size > MAX_LINKED) linked.delete(linked.values().next().value!)
  }

  const observe = (exec: ToolExecution, result: ToolExecutionResult, decision: PostToolDecision) => {
    if (result.isError || decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.name === 'tokenwise_recall') return
    const content = decision.content ?? result.content
    if (content.length === 0 || !content.every(block => block.type === 'text' && typeof block.text === 'string')) return
    const text = content.map(block => block.text as string).join('\n')
    if (text === '') return
    const session = sessionOf(exec)
    const state = sessionState(session?.id ?? '', session?.cwd)
    const mode = negotiateFor(state.loaded, requestedMode()).find(item => item.mechanism === 'economy')!.mode
    if (mode === 'off') return
    engineFor(state, mode).process({ sessionId: session?.id ?? null, callId: String(exec.callId), tool: exec.name,
      command: describeToolCall(exec.name, exec.arguments), native: { rendered: text, projection: undefined } })
  }

  const postExecute = (exec: ToolExecution, result: ToolExecutionResult, decision: PostToolDecision): PostToolDecision => {
    try {
      const requested = requestedMode()
      if (requested === 'off') return decision
      // Only the model's own calls: a run_code sub-dispatch hands its value to a program, not the model.
      const job = exec.name === 'job_output'
      const native = !job && exec.name !== 'bash' && NATIVE_TOOLS.has(exec.name)
      if (exec.parent !== undefined || result.isError) return decision
      // Any other tool: its text is journaled as it is (what the model read, TokenWise's own recall aside).
      if (exec.name !== 'bash' && !native && !job) { observe(exec, result, decision); return decision }
      // Keep blocks, value replacements and anything another listener already rewrote.
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      // A search tool's or job read's own text only; one DSH capped or spilled (it rewrites those itself) is left alone.
      if ((native || job) && decision.content !== undefined) return decision
      const session = sessionOf(exec)
      const state = sessionState(session?.id ?? '', session?.cwd)
      const mode = negotiateFor(state.loaded, requested).find(item => item.mechanism === 'economy')!.mode
      if (mode === 'off') return decision
      linkSubagent(exec)
      const call = { sessionId: session?.id ?? null, callId: String(exec.callId), tool: exec.name }
      let output
      if (native) {
        const found = nativeResult(exec.name, result.value, result.content)
        if (!found) return decision
        output = engineFor(state, mode).process({ ...call, command: describeToolCall(exec.name, exec.arguments), native: found })
      } else if (job) {
        // The whole output of a finished background bash job, filtered as the command that started it.
        const written = options.jobOutputTotal
        const shell = written ? jobShellResult(result.value, result.content, id => written(id, exec)) : undefined
        if (!shell) return decision
        output = engineFor(state, mode).process({ ...call, result: shell })
      } else {
        const content = decision.content ?? result.content
        const shell = bashShellResult((exec.arguments as { command?: unknown } | undefined)?.command, result.value, content)
        if (!shell) return decision
        output = engineFor(state, mode).process({ ...call, result: shell })
      }
      housekeeping(state.loaded.config.artifacts.retentionDays)
      if (output.text === undefined) return decision
      return { kind: 'accept', content: [{ type: 'text', text: output.text }],
        ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts } }
    } catch (error) {
      warn(`TokenWise: ${String(error)}; delivering the original output`)
      return decision
    }
  }

  const read = (sessionId: string) => readJournals(readDirs, { host: HOST, sessionId })
  const summary = (sessionId: string) => summarizeEconomy(read(sessionId))

  const api: DshEconomy = {
    postExecute,
    negotiated: session => negotiateFor(session ? sessionState(session.id, session.cwd).loaded : loadConfig({ dataDir: configDir, env })),
    summary,
    report: session => {
      const loaded = sessionState(session.id, session.cwd).loaded
      const s = summary(session.id)
      const shadow = summarizeShadow(read(session.id))
      const subagents = collectSubagents(read, session.id)
      const c = summarizeEconomy(subagents.records)
      const n = subagents.sessions.length
      const lines = [
        s.projected > 0
          ? `TokenWise saved ~${formatTokens(s.savedTokens)} tokens in this session (${s.projected} of ${s.projected + s.passed + s.previewed} outputs filtered).`
          : `TokenWise has not filtered any output in this session yet (${s.passed + s.previewed} seen).`,
        ...n > 0 ? [`Its subagents (${n} session${n === 1 ? '' : 's'}) saved ~${formatTokens(c.savedTokens)} tokens (${c.projected} of ${c.projected + c.passed + c.previewed} outputs filtered).`] : [],
        ...s.previewed > 0 ? [`Observe mode: ${s.previewed} outputs would have been filtered, saving ~${formatTokens(s.previewSavedTokens)} tokens.`] : [],
        ...c.previewed > 0 ? [`Observe mode, subagents: ${c.previewed} outputs would have been filtered, saving ~${formatTokens(c.previewSavedTokens)} tokens.`] : [],
        ...s.byFilter.slice(0, 5).map(item => `  ${item.filter}: ${item.count}× −${formatTokens(item.savedTokens)} tokens`),
        ...shadow.checkpoints + shadow.standard + shadow.cuts > 0 ? [`Compaction: ${shadow.checkpoints} compaction${shadow.checkpoints === 1 ? '' : 's'}, ${shadow.cuts} long result${shadow.cuts === 1 ? '' : 's'} cut, `
          + `${shadow.references} tool results kept recallable (~${formatTokens(shadow.referencedTokens)} tokens), ${shadow.recalls} recalled${shadow.standard ? `; ${shadow.standard} compaction${shadow.standard === 1 ? '' : 's'} left to DSH` : ''}.`] : [],
        ...negotiateFor(loaded).map(item => `${item.mechanism}: ${item.mode} (${item.reason})`),
        ...loaded.problems.map(problem => `config problem: ${problem}`),
        ...api.extraReport?.(session.id) ?? [],
        learnedRulesLine(ruleStore, loaded.config.economy.learnedRules),
        `Originals are kept in ${store?.dataDir ?? configDir}.`,
      ]
      return lines.join('\n')
    },
    get dataDir() { return storage().dataDir },
    dataDirs: readDirs,
    configDir,
    shadowMode: session => negotiateFor(sessionState(session.id, session.cwd).loaded).find(item => item.mechanism === 'lightshadow')!.mode,
    configuredShadowMode: () => loadConfig({ dataDir: configDir, env }).config.lightshadow.mode,
    journal: () => storage().journal,
    artifacts: () => storage().artifacts,
    read,
  }
  return api
}
