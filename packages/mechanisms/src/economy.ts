import { createPolicy, decideNativeProjection, decideShellProjection, ECONOMY_RUNTIME_VERSION, estimateTokens as defaultEstimate, rewriteCommand, sha256 } from '@tokenwise/core'
import type { EconomyPolicy, LearnedRuleSet, NativeResult, ShellResult, TokenEstimator } from '@tokenwise/core'
import type { ArtifactPort, EconomyFailure, EconomyRecord, JournalPort, TextMeasure } from '@tokenwise/protocol'
import type { EconomyConfig } from '@tokenwise/store'
import { recallHint, referenceId } from './shadow.ts'

export interface EconomyEngineOptions {
  readonly host: string
  readonly journal: JournalPort
  readonly artifacts: ArtifactPort
  readonly config: EconomyConfig
  /** Negotiated mode; `observe` records what would change and delivers the original. */
  readonly mode: 'apply' | 'observe'
  readonly delivery: EconomyRecord['delivery']
  readonly streams: EconomyRecord['streams']
  readonly estimateTokens?: TokenEstimator
  /**
   * The most characters (UTF-16 code units) the host delivers inline. A larger
   * projection passes the original instead, so the host's own spill keeps the
   * complete text rather than a sample of it.
   */
  readonly maxProjectedChars?: number
  readonly now?: () => Date
  /** Diagnostics only. Errors never reach the host's tool result. */
  readonly onError?: (error: unknown) => void
  /** The adopted learned rules; read at every decision, so it should be cheap (RuleStore.load caches by active.json). */
  readonly learned?: () => LearnedRuleSet | undefined
  /**
   * End a shortened output with a line naming its complete original, which the
   * recall tool (or `tokenwise recall`) reads. Only where the host has a way to read
   * it; added only when the projection still saves enough with it.
   */
  readonly recallHint?: boolean
}

/** Originals larger than this are not kept as evidence (projections always keep theirs). */
const MAX_EVIDENCE_BYTES = 1_048_576
/** Commands that print the environment or read credentials are never kept as evidence. */
const SENSITIVE_COMMAND = /(?:^|[\s/;|&(])(?:env|printenv|export|set)(?:\s*$|\s*[;|&)])|\.env\b|secret|token|passw|credential|\.netrc|id_(?:rsa|ed25519|ecdsa|dsa)\b|\.pem\b|\.p12\b|\.key\b|auth\.json|\b(?:aws|gcloud|az|gh|npm|docker|kubectl)\s+(?:configure|auth|login|token)/iu
/** Output that carries something that looks like a credential is never kept as evidence either. */
const SENSITIVE_OUTPUT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\b(?:api[_-]?key|secret|password|token)\s*[=:]\s*\S{8,}/iu

/** Whether an output may be kept as evidence for `tokenwise evolve`. */
export function evidenceAllowed(command: string, rendered: string): boolean {
  return !SENSITIVE_COMMAND.test(command) && !SENSITIVE_OUTPUT.test(rendered)
}

export interface EconomyRequest {
  readonly sessionId: string | null
  readonly callId: string | null
  readonly tool: string
  readonly result: ShellResult
}

/** A host tool's own result (grep, glob, find): no shell and no exit code. */
export interface NativeEconomyRequest {
  readonly sessionId: string | null
  readonly callId: string | null
  readonly tool: string
  /** How the call reads in the journal, such as `grep {"pattern":"x"}`. */
  readonly command: string
  readonly native: NativeResult
}

export interface EconomyOutput {
  /** Defined only when the host should deliver this text instead of the original. */
  readonly text?: string
  readonly record?: EconomyRecord
}

/**
 * Token Economy over the journal and artifact ports. The original is saved and
 * the decision journaled before a projection is released; any failure on the
 * way delivers the original (fail-open).
 */
export class EconomyEngine {
  private readonly policies = new Map<string, EconomyPolicy>()
  private readonly options: EconomyEngineOptions
  constructor(options: EconomyEngineOptions) {
    this.options = options
  }

  /**
   * One policy per session, captured at its first decision and renewed when
   * the adopted learned rules change (an adoption, rollback or switch-off
   * reaches running sessions from their next output on; outputs already
   * delivered keep what they were given).
   */
  policyFor(sessionId: string | null): EconomyPolicy {
    const key = sessionId ?? ''
    let learned: LearnedRuleSet | undefined
    if (this.options.config.learnedRules !== false) {
      try { learned = this.options.learned?.() } catch (error) { this.options.onError?.(error) }
    }
    let policy = this.policies.get(key)
    if (!policy || policy.learnedRulesHash !== (learned?.hash ?? null)) {
      policy = createPolicy(this.options.config.filterOptions, learned)
      this.policies.delete(key)
      this.policies.set(key, policy)
      if (this.policies.size > 256) this.policies.delete(this.policies.keys().next().value!)
    }
    return policy
  }

  /**
   * Decide and, for a projection in apply mode, save the original and source
   * map. Passes and previews are journaled here. A returned `Prepared` must be
   * committed (journaled) before its text reaches the model.
   */
  prepare(request: EconomyRequest | NativeEconomyRequest): Prepared | EconomyOutput {
    const { options } = this
    const native = 'native' in request ? request : undefined
    const shell = 'result' in request ? request.result : undefined
    const rendered = (native ? native.native.rendered : shell?.rendered) ?? ''
    const estimate = options.estimateTokens ?? defaultEstimate
    const measure = (text: string): TextMeasure => ({ sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), tokens: estimate(text) })
    let policyHash = 'unavailable'
    let learnedRulesHash: string | null = null
    const layout = shell && typeof shell.rendered === 'string' && typeof shell.stdout?.text === 'string' ? {
      stdout: { start: shell.stdout.start, length: shell.stdout.text.length },
      ...shell.stderr && typeof shell.stderr.text === 'string' ? { stderr: { start: shell.stderr.start, length: shell.stderr.text.length } } : {},
      ...shell.truncated ? { truncated: true as const } : {}, ...shell.interrupted ? { interrupted: true as const } : {},
    } : undefined
    const base = () => ({
      schemaVersion: 1 as const, type: 'economy/decision' as const, time: (options.now?.() ?? new Date()).toISOString(),
      host: options.host, sessionId: request.sessionId, callId: request.callId, tool: request.tool,
      command: (native ? native.command : shell?.command) ?? '', exitCode: shell !== undefined && Number.isSafeInteger(shell.exitCode) ? shell.exitCode : null,
      delivery: options.delivery, streams: options.streams, mode: options.mode, runtimeVersion: ECONOMY_RUNTIME_VERSION, policyHash,
      ...learnedRulesHash ? { learnedRulesHash } : {}, ...layout ? { layout } : {},
    })
    /** The original as evidence for `tokenwise evolve`: shell output only, when kept. */
    const evidence = (): TextMeasure & { stored: boolean } => {
      const measured = measure(rendered)
      if (!shell || options.config.evidence === false || measured.bytes > MAX_EVIDENCE_BYTES || rendered === ''
        || !evidenceAllowed(shell.command, rendered)) return { ...measured, stored: false }
      try {
        options.artifacts.save(rendered)
        return { ...measured, stored: true }
      } catch (error) {
        options.onError?.(error)
        return { ...measured, stored: false }
      }
    }
    try {
      const policy = this.policyFor(request.sessionId)
      policyHash = policy.policyHash
      learnedRulesHash = policy.learnedRulesHash
      const decisionOptions = { policy, minimumSavedTokens: options.config.minimumSavedTokens, estimateTokens: estimate }
      const decision = native ? decideNativeProjection(native.native, decisionOptions) : decideShellProjection(shell!, decisionOptions)
      if (decision.kind === 'pass') {
        const record: EconomyRecord = { ...base(), outcome: 'passed', reason: decision.reason,
          ...decision.matchDetail === undefined ? {} : { matchDetail: decision.matchDetail },
          ...decision.filter === undefined ? {} : { filter: decision.filter },
          ...decision.rule === undefined ? {} : { rule: decision.rule },
          ...decision.transformation === undefined ? {} : { transformation: decision.transformation },
          raw: evidence() }
        this.append(record)
        return { record }
      }
      const identity = { filter: decision.filter, ...decision.rule === undefined ? {} : { rule: decision.rule },
        transformation: decision.transformation, stream: decision.stream }
      if (options.maxProjectedChars !== undefined && decision.text.length > options.maxProjectedChars) {
        const record: EconomyRecord = { ...base(), outcome: 'passed', reason: 'over-host-inline-limit', filter: decision.filter,
          ...decision.rule === undefined ? {} : { rule: decision.rule },
          transformation: decision.transformation, raw: evidence(), projected: measure(decision.text) }
        this.append(record)
        return { record }
      }
      if (options.mode === 'observe') {
        const record: EconomyRecord = { ...base(), outcome: 'previewed', ...identity,
          raw: evidence(), projected: measure(decision.text) }
        this.append(record)
        return { record }
      }
      let raw, map
      try {
        raw = options.artifacts.save(rendered)
        map = options.artifacts.save(JSON.stringify(decision.sourceMap))
      } catch (error) { return this.failOpen(base(), 'artifact-save-failed', error) }
      let text = decision.text, projectedBytes = decision.projectedBytes, projectedTokens = decision.projectedTokens
      // Not after a lossless layout (nothing was left out), nor a host tool's own result (it has no shell layout).
      if (options.recallHint && shell && decision.transformation !== 'lossless-formatting') {
        // Right after the shortened stream, before what the host appends to it (an exit-code footer, a stderr block).
        const span = decision.stream === 'stderr' ? shell.stderr : shell.stdout
        const tail = span ? rendered.slice(span.start + span.text.length) : ''
        const head = tail !== '' && text.endsWith(tail) ? text.slice(0, text.length - tail.length) : text
        const rest = head === text ? '' : tail
        const hinted = `${head}${head.endsWith('\n') || head === '' ? '' : '\n'}${recallHint(referenceId(raw.sha256))}\n${rest.startsWith('\n') ? rest.slice(1) : rest}`
        const hintedTokens = estimate(hinted), hintedBytes = Buffer.byteLength(hinted, 'utf8')
        if (hintedBytes < decision.rawBytes && decision.rawTokens - hintedTokens >= Math.max(1, options.config.minimumSavedTokens)
          && (options.maxProjectedChars === undefined || hinted.length <= options.maxProjectedChars)) {
          text = hinted; projectedBytes = hintedBytes; projectedTokens = hintedTokens
        }
      }
      const record: EconomyRecord = { ...base(), outcome: 'projected', ...identity,
        raw: { sha256: raw.sha256, bytes: raw.bytes, tokens: decision.rawTokens, stored: true },
        projected: { sha256: sha256(text), bytes: projectedBytes, tokens: projectedTokens },
        sourceMap: map }
      return { kind: 'prepared', text, record }
    } catch (error) {
      return this.failOpen(base(), 'engine-error', error)
    }
  }

  /** Journal a prepared projection. Undefined means: deliver the original instead. */
  commit(prepared: Prepared): EconomyOutput {
    const record = { ...prepared.record, time: (this.options.now?.() ?? new Date()).toISOString() }
    try { this.options.journal.append(record) } catch (error) { this.options.onError?.(error); return {} }
    return { text: prepared.text, record }
  }

  /** Decide, save and journal in one step (for wrappers that deliver immediately). */
  process(request: EconomyRequest | NativeEconomyRequest): EconomyOutput {
    const prepared = this.prepare(request)
    return isPrepared(prepared) ? this.commit(prepared) : prepared
  }

  private append(record: EconomyRecord): void {
    try { this.options.journal.append(record) } catch (error) { this.options.onError?.(error) }
  }

  private failOpen(base: Omit<EconomyRecord, 'outcome'>, reason: EconomyFailure, error: unknown): EconomyOutput {
    this.options.onError?.(error)
    this.append({ ...base, outcome: 'failed-open', reason })
    return {}
  }
}

/** How a host tool's own call reads in the journal: its name and arguments, bounded. */
export function describeToolCall(tool: string, args: unknown): string {
  let text: string
  try { text = JSON.stringify(args) ?? '' } catch { text = '' }
  return `${tool} ${text.length > 1000 ? `${text.slice(0, 1000)}…` : text}`.trimEnd()
}

/** A projection whose original is saved but which is not yet journaled or delivered. */
export interface Prepared {
  readonly kind: 'prepared'
  readonly text: string
  readonly record: EconomyRecord
}

export function isPrepared(value: Prepared | EconomyOutput): value is Prepared {
  return (value as Prepared).kind === 'prepared'
}

export interface CommandNormalizerOptions {
  readonly host: string
  readonly journal: JournalPort
  readonly now?: () => Date
}

/** Presentation-only rewrites (line numbers, no colour) recorded before execution. */
export function normalizeShellCommand(options: CommandNormalizerOptions,
  call: { sessionId: string | null; callId: string | null; tool: string; command: string }): string | undefined {
  let rewrite
  try { rewrite = rewriteCommand(call.command) } catch { return undefined }
  if (!rewrite) return undefined
  try {
    options.journal.append({ schemaVersion: 1, type: 'economy/command-rewrite', time: (options.now?.() ?? new Date()).toISOString(),
      host: options.host, sessionId: call.sessionId, callId: call.callId, tool: call.tool, rule: rewrite.rule,
      original: call.command, rewritten: rewrite.command })
  } catch { return undefined }
  return rewrite.command
}
