/** Host-neutral Token Economy decision for one shell execution. No I/O, no host types. */
import { projectStaticFilter } from './filters/index.ts'
import { ProjectionBuilder } from './projection-map.ts'
import type { MappedProjection, SourceMap } from './projection-map.ts'
import { hasBuiltinCommand, inspectShell } from './shell-inspection.ts'
import { estimateTokens as defaultEstimate } from './tokens.ts'
import type { TokenEstimator } from './tokens.ts'
import type { EconomyPolicy } from './policy.ts'
import type { EconomyFilterName, EconomyTransformation, FilterCandidate } from './types.ts'

/** A stream body that appears verbatim inside the rendered result. */
export interface RenderedStream {
  readonly start: number
  readonly text: string
}

/** One shell execution, exactly as the host would otherwise deliver it to the model. */
export interface ShellResult {
  /** Command text as the agent wrote it (before any TokenWise wrapping). */
  readonly command: string
  readonly exitCode: number
  /** Complete text the model would receive without TokenWise. */
  readonly rendered: string
  readonly stdout: RenderedStream
  /** Present only when the host keeps stderr apart from stdout. */
  readonly stderr?: RenderedStream
  /** The host already cut the output; a projection could hide that. */
  readonly truncated?: boolean
  /** Timeout, signal or cancellation: the output is not a complete report. */
  readonly interrupted?: boolean
}

export type EconomyPassReason =
  | 'invalid-command'
  | 'already-truncated'
  | 'interrupted-result'
  | 'unsupported-result-shape'
  | 'no-filter-match'
  | 'filter-error'
  | 'stream-policy-rejected'
  | 'non-growth-rejected'
  /** Even the projection is over what the host keeps inline; its own spill keeps the whole original instead. */
  | 'over-host-inline-limit'

export type EconomyMatchDetail =
  | 'unsupported-shell-syntax'
  | 'compound-output-unrecognized'
  | 'command-not-covered'
  | 'output-format-unrecognized'
  | 'stderr-transformation-not-approved'
  | 'stderr-deduplication-contract-failed'

export interface EconomySizes {
  readonly rawBytes: number
  readonly projectedBytes: number
  readonly rawTokens: number
  readonly projectedTokens: number
}

export interface EconomyProjection extends EconomySizes {
  readonly kind: 'project'
  readonly filter: EconomyFilterName
  /** The learned rule, when `filter` is `learned-rule`. */
  readonly rule?: string
  readonly transformation: EconomyTransformation
  readonly stream: 'stdout' | 'stderr'
  /** Replacement for the whole rendered result. */
  readonly text: string
  /** Maps `text` back to the rendered result, in UTF-16 code units. */
  readonly sourceMap: SourceMap
  readonly policyHash: string
}

export interface EconomyPass extends Partial<EconomySizes> {
  readonly kind: 'pass'
  readonly reason: EconomyPassReason
  readonly matchDetail?: EconomyMatchDetail
  readonly filter?: EconomyFilterName
  readonly rule?: string
  readonly transformation?: EconomyTransformation
  readonly policyHash: string
}

export type EconomyDecision = EconomyProjection | EconomyPass

export interface EconomyDecisionOptions {
  readonly policy: EconomyPolicy
  /** At least 1: a projection must save tokens, not only bytes. */
  readonly minimumSavedTokens?: number
  readonly estimateTokens?: TokenEstimator
}

function streamAt(rendered: string, stream: RenderedStream | undefined): stream is RenderedStream {
  return stream !== undefined && Number.isSafeInteger(stream.start) && stream.start >= 0
    && rendered.startsWith(stream.text, stream.start)
}

/**
 * Replace one verbatim region of `rendered` with a projection of that region,
 * keeping everything around it byte-for-byte and remapping the source map.
 */
export function embedProjection(rendered: string, region: RenderedStream, projection: MappedProjection): MappedProjection {
  const end = region.start + region.text.length
  const builder = new ProjectionBuilder(rendered)
  builder.keep(0, region.start)
  builder.append({
    text: projection.text,
    sourceMap: {
      ...projection.sourceMap,
      sourceLength: rendered.length,
      spans: projection.sourceMap.spans.map(span => span.sourceStart === undefined ? span : {
        ...span, sourceStart: span.sourceStart + region.start, sourceEnd: span.sourceEnd! + region.start,
      }),
    },
  })
  const suffix = rendered.slice(end)
  if (suffix !== '' && !suffix.startsWith('\n')) builder.newline()
  builder.keep(end, rendered.length)
  return builder.finish()
}

function linesWithEndings(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Accept only an exact representation of consecutive duplicate diagnostic rows. */
export function exactDiagnosticDeduplication(raw: string, candidate: string): boolean {
  const source = linesWithEndings(raw), output = linesWithEndings(candidate)
  let i = 0, j = 0, collapsed = false
  while (i < source.length) {
    let end = i + 1
    while (end < source.length && source[end] === source[i]) end++
    if (output[j] !== source[i]) return false
    j++
    const omitted = end - i - 1
    if (omitted > 0 && source[i]!.endsWith('\n')
      && output[j] === `[${omitted} identical lines omitted]\n`) {
      j++; collapsed = true
    } else {
      for (let k = i + 1; k < end; k++, j++) if (output[j] !== source[k]) return false
    }
    i = end
  }
  return collapsed && j === output.length
}

/** Why no filter applied: unsupported syntax, an uncovered command, or an unrecognized format. */
export function classifyMiss(command: string): EconomyMatchDetail {
  const shell = inspectShell(command)
  return shell === undefined ? 'unsupported-shell-syntax'
    : shell.compound ? 'compound-output-unrecognized'
    : hasBuiltinCommand(command) ? 'output-format-unrecognized' : 'command-not-covered'
}

/**
 * Decide whether to replace a shell result with a deterministic projection.
 * stdout is filtered by the full filter set; stderr only by filters whose
 * stderr contract is proven (Cargo reports, exact duplicate folding). The
 * projection is admitted only when it is strictly smaller in UTF-8 bytes and
 * saves at least `minimumSavedTokens` tokens; otherwise the result passes.
 */
/** A command line that runs the tokenwise CLI (by name or path, after variable assignments). */
const OWN_COMMAND = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:tokenwise|tw)(?:\s|$)/u

export function decideShellProjection(result: ShellResult, options: EconomyDecisionOptions): EconomyDecision {
  const { policy } = options
  const minimumSavedTokens = Math.max(1, options.minimumSavedTokens ?? 1)
  const estimate = options.estimateTokens ?? defaultEstimate
  const pass = (reason: EconomyPassReason, extra: Omit<EconomyPass, 'kind' | 'reason' | 'policyHash'> = {}): EconomyPass =>
    ({ kind: 'pass', reason, ...extra, policyHash: policy.policyHash })
  if (typeof result.command !== 'string' || result.command.trim() === '') return pass('invalid-command')
  // TokenWise's own output (a checkup, a before-and-after preview) is meant to be read as it is.
  if (OWN_COMMAND.test(result.command)) return pass('no-filter-match', { matchDetail: 'command-not-covered' })
  if (result.interrupted) return pass('interrupted-result')
  if (result.truncated) return pass('already-truncated')
  if (!Number.isSafeInteger(result.exitCode) || !streamAt(result.rendered, result.stdout)) return pass('unsupported-result-shape')
  const filterOptions = policy.filterOptions

  let projection: FilterCandidate | undefined
  let composed: MappedProjection | undefined
  let stream: 'stdout' | 'stderr' = 'stdout'
  try {
    const stdoutInput = { command: result.command, stdout: result.stdout.text, exitCode: result.exitCode, options: filterOptions }
    // Learned rules first (they never throw), then the built-in filters.
    projection = policy.learned?.project(stdoutInput) ?? projectStaticFilter(stdoutInput)
    if (projection !== undefined) composed = embedProjection(result.rendered, result.stdout, projection)
    // Cargo emits its build report on stderr. Only the diagnostic-preserving
    // Cargo parser or an exact duplicate-row fold may touch that stream; never
    // feed a merged stdout/stderr blob to a stdout filter.
    if (projection === undefined && result.stderr !== undefined && result.stderr.text !== ''
      && streamAt(result.rendered, result.stderr)) {
      const candidate = projectStaticFilter({ command: result.command, stdout: result.stderr.text, exitCode: result.exitCode, options: filterOptions })
      if (candidate !== undefined) {
        const approved = candidate.filter === 'cargo-build'
          || candidate.transformation === 'diagnostic-deduplication' && exactDiagnosticDeduplication(result.stderr.text, candidate.text)
        if (!approved) {
          return pass('stream-policy-rejected', { filter: candidate.filter, transformation: candidate.transformation,
            matchDetail: candidate.transformation !== 'diagnostic-deduplication'
              ? 'stderr-transformation-not-approved' : 'stderr-deduplication-contract-failed' })
        }
        projection = candidate
        composed = embedProjection(result.rendered, result.stderr, candidate)
        stream = 'stderr'
      }
    }
  } catch {
    return pass('filter-error')
  }
  if (projection === undefined || composed === undefined) {
    return pass('no-filter-match', { matchDetail: classifyMiss(result.command) })
  }
  const rule = (projection as { rule?: unknown }).rule
  const identity = { filter: projection.filter, transformation: projection.transformation, ...typeof rule === 'string' ? { rule } : {} }
  if (projection.text.trim() === '') return pass('unsupported-result-shape', identity)
  const sizes: EconomySizes = {
    rawBytes: Buffer.byteLength(result.rendered, 'utf8'),
    projectedBytes: Buffer.byteLength(composed.text, 'utf8'),
    rawTokens: estimate(result.rendered),
    projectedTokens: estimate(composed.text),
  }
  if (sizes.projectedBytes >= sizes.rawBytes || sizes.rawTokens - sizes.projectedTokens < minimumSavedTokens) {
    return pass('non-growth-rejected', { ...identity, ...sizes })
  }
  return { kind: 'project', ...identity, stream, text: composed.text, sourceMap: composed.sourceMap, ...sizes, policyHash: policy.policyHash }
}

/** A host tool's own result (no shell), with the layout its adapter verified against that exact text. */
export interface NativeResult {
  /** Complete text the model would receive without TokenWise. */
  readonly rendered: string
  /** From the `native*` functions; undefined when the text is not the shape they accept. */
  readonly projection: FilterCandidate | undefined
}

/** The admission rule of {@link decideShellProjection}, for a host tool's own result. */
export function decideNativeProjection(result: NativeResult, options: EconomyDecisionOptions): EconomyDecision {
  const { policy } = options
  const minimumSavedTokens = Math.max(1, options.minimumSavedTokens ?? 1)
  const estimate = options.estimateTokens ?? defaultEstimate
  const pass = (reason: EconomyPassReason, extra: Omit<EconomyPass, 'kind' | 'reason' | 'policyHash'> = {}): EconomyPass =>
    ({ kind: 'pass', reason, ...extra, policyHash: policy.policyHash })
  if (typeof result.rendered !== 'string') return pass('unsupported-result-shape')
  const projection = result.projection
  if (projection === undefined) return pass('no-filter-match', { matchDetail: 'output-format-unrecognized' })
  const identity = { filter: projection.filter, transformation: projection.transformation }
  if (projection.text.trim() === '') return pass('unsupported-result-shape', identity)
  const sizes: EconomySizes = {
    rawBytes: Buffer.byteLength(result.rendered, 'utf8'),
    projectedBytes: Buffer.byteLength(projection.text, 'utf8'),
    rawTokens: estimate(result.rendered),
    projectedTokens: estimate(projection.text),
  }
  if (sizes.projectedBytes >= sizes.rawBytes || sizes.rawTokens - sizes.projectedTokens < minimumSavedTokens) {
    return pass('non-growth-rejected', { ...identity, ...sizes })
  }
  return { kind: 'project', ...identity, stream: 'stdout', text: projection.text, sourceMap: projection.sourceMap, ...sizes, policyHash: policy.policyHash }
}

const SEARCH_AND_LISTING_HEADS = new Set(['grep', 'rg', 'ripgrep', 'find', 'ls', 'fd', 'git'])

/**
 * Cheap pre-execution check: could any filter apply to this command's output?
 * Wrappers use it to leave every other command untouched. False negatives
 * only cost savings; a true result does not promise a projection.
 */
export function mayProject(command: string): boolean {
  if (hasBuiltinCommand(command)) return true
  const shell = inspectShell(command)
  return shell !== undefined && shell.heads.some(head => SEARCH_AND_LISTING_HEADS.has(head))
}
