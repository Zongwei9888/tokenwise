import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, EconomyFilterName, EconomyTransformation, FilterInput } from '../types.ts'

/**
 * Words that mark a line as a possible report of a problem. A line that has
 * one is never folded, whatever pattern it also matches.
 */
export const PROBLEM = /error|fail|fatal|panic|warn|denied|refused|invalid|cannot|can't|unable|not found|missing|conflict|deprecat|abort|exception|traceback|timed? ?out/iu

/** Control bytes, terminal escapes and carriage-return progress: not plain text a line filter can read. */
export const NOT_PLAIN = /[\u001b\0]|\r(?!\n)/u

export interface FoldRunsOptions {
  /** A kind name for this line (e.g. 'download'), or undefined to keep it. */
  readonly kind: (text: string) => string | undefined
  /** The note that replaces a run, from its length and kind. Must end with a newline. */
  readonly note: (count: number, kind: string) => string
  /** The shortest run that is folded (default 3): one or two lines cost less than a note. */
  readonly minRun?: number
  /** Projection label recorded in the source map. */
  readonly label: string
}

/**
 * Fold runs of consecutive lines of one kind into one counted note each and
 * keep every other line verbatim, in order. Lines that mention a problem are
 * never folded. Undefined when nothing was folded.
 */
export function foldRuns(stdout: string, options: FoldRunsOptions): MappedProjection | undefined {
  const minRun = options.minRun ?? 3
  const lines = sourceLines(stdout)
  const kinds = lines.map(line => PROBLEM.test(line.text) ? undefined : options.kind(line.text))
  const builder = new ProjectionBuilder(stdout)
  let folded = 0
  for (let i = 0; i < lines.length;) {
    const kind = kinds[i]
    let end = i
    if (kind !== undefined) while (end < lines.length && kinds[end] === kind) end++
    if (kind !== undefined && end - i >= minRun) {
      builder.generate(options.note(end - i, kind), options.label)
      folded += end - i
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  }
  return folded > 0 ? builder.finish() : undefined
}

/** argv[0] is one of `names`, and argv[1..] starts with one of `subcommands` (any, when none are given). */
export function commandIs(command: string, names: readonly string[], subcommands?: readonly (readonly string[])[]): boolean {
  const argv = toolArgv(command)
  if (argv === undefined || !names.includes(argv[0] ?? '')) return false
  if (subcommands === undefined) return true
  return subcommands.some(words => words.every((word, index) => argv[index + 1] === word))
}

export interface NoiseFilterSpec {
  readonly name: EconomyFilterName
  readonly transformation?: EconomyTransformation
  readonly commands: (command: string) => boolean
  /** Exit codes whose output this filter reads (default: any). */
  readonly exitCodes?: readonly number[]
  /** The output must contain a line this matches, so it is the tool's own report. */
  readonly recognize?: RegExp
  readonly fold: Omit<FoldRunsOptions, 'label'>
  /** The tool prints this report on stderr (see `EconomyFilter.stderr`). */
  readonly stderr?: boolean
}

/** A filter that only folds runs of recognized noise lines; every other line stays as it is. */
export function noiseFilter(spec: NoiseFilterSpec): EconomyFilter {
  const projectMapped = (input: FilterInput): MappedProjection | undefined => {
    if (!spec.commands(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
    if (spec.exitCodes !== undefined && !spec.exitCodes.includes(input.exitCode)) return undefined
    if (spec.recognize !== undefined && !sourceLines(input.stdout).some(line => spec.recognize!.test(line.text))) return undefined
    return foldRuns(input.stdout, { ...spec.fold, label: `${spec.name}-folded` })
  }
  return {
    name: spec.name, transformation: spec.transformation ?? 'noise-removal', commands: spec.commands,
    ...spec.stderr ? { stderr: true } : {},
    projectMapped, project: input => projectMapped(input)?.text,
  }
}
