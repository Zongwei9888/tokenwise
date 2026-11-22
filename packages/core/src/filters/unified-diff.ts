import { toolArgv } from '../command.ts'
import { resolveFilterOptions } from '../filter-options.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { previewPatch } from './git-diff.ts'
import type { PatchLayout } from './git-diff.ts'
import { NOT_PLAIN } from './noise.ts'

/**
 * The patch previewed like `git diff`'s (head and tail of each hunk longer
 * than `git-diff.maxHunkLines`, counted, with the not-an-applicable-patch
 * warning); undefined when no hunk is that long, so the output passes whole.
 */
function preview(input: FilterInput, layout: PatchLayout): MappedProjection | undefined {
  const options = resolveFilterOptions(input.options)
  if (options === undefined || NOT_PLAIN.test(input.stdout)) return undefined
  const projection = previewPatch(input.stdout, sourceLines(input.stdout), options['git-diff'].maxHunkLines, layout)
  return projection === undefined || projection.text === input.stdout ? undefined : projection
}

// ——— diff -u / diff -ru ———

/** A unified-format option: `-u`, `-U 5`, `-U5`, `--unified[=5]`, or short flags with `u` (`-ru`, `-Naur`, `-urN`). */
const UNIFIED = /^(?:-[abBdEiNprsTw]*u[abBdEiNprsTw]*|-U\d*|--unified(?:=\d+)?)$/u
/** Options that print another layout: brief, side by side, context, ed, RCS, normal, if-then-else. */
const OTHER_FORMAT = /^(?:-[^-]*[qyceCnD]|--(?:brief|side-by-side|context|ed|rcs|normal|ifdef|[a-z]*-?(?:line|group)-format)(?:=|$))/u

const diffCommand = (command: string) => {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'diff') return false
  const args = argv.slice(1)
  return args.some(arg => UNIFIED.test(arg)) && !args.some(arg => OTHER_FORMAT.test(arg))
}

/**
 * Plain `diff -u` / `diff -ru` of two directories: each file's patch is
 * previewed as `git diff`'s is, and every `diff <options> a/x b/x` header,
 * `---`/`+++` line, hunk header and `Only in`, `Binary files … differ` or
 * `Common subdirectories` line stays. A diff of two files the agent named
 * (no `diff …` section headers) passes whole, as `git diff -- <path>` does:
 * that is also how it reads a hunk a directory diff previewed.
 */
function projectDiff(input: FilterInput): MappedProjection | undefined {
  if (!diffCommand(input.command) || ![0, 1].includes(input.exitCode)) return undefined
  if (!sourceLines(input.stdout).some(line => line.text.startsWith('diff '))) return undefined
  return preview(input, 'plain')
}

export const diffFilter: EconomyFilter = {
  name: 'diff', transformation: 'preview', commands: diffCommand,
  projectMapped: projectDiff, project: input => projectDiff(input)?.text,
}

// ——— jj diff --git ———

/** Options of `jj diff` that choose revisions or set the repository; their value is the next word, or after `=`. */
const JJ_VALUE_OPTION = /^(?:-r|--revisions?|-f|--from|-t|--to|-R|--repository|--context|--at-op|--at-operation)$/u
const JJ_FLAG = /^(?:--git|--no-pager|--ignore-working-copy|--color=never|--quiet|(?:-r|-f|-t|-R).+|--(?:revisions?|from|to|repository|context|at-op|at-operation)=.+)$/u

/** `jj diff --git` over revisions, without paths: with paths, the agent chose the files and their patch stays whole. */
const jjDiffCommand = (command: string) => {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'jj' || argv[1] !== 'diff' || !argv.includes('--git')) return false
  for (let i = 2; i < argv.length; i++) {
    if (JJ_VALUE_OPTION.test(argv[i]!)) i++
    else if (!JJ_FLAG.test(argv[i]!)) return false
  }
  return true
}

/**
 * `jj diff --git` prints git's patch layout (`diff --git`, `index`, `---`,
 * `+++`, hunks): oversized hunks are previewed exactly as `git diff`'s are.
 * jj's default color-words layout, `jj log` and `jj status` pass through.
 */
function projectJj(input: FilterInput): MappedProjection | undefined {
  if (!jjDiffCommand(input.command) || input.exitCode !== 0) return undefined
  if (!input.stdout.startsWith('diff --git ')) return undefined
  return preview(input, 'git')
}

export const jjFilter: EconomyFilter = {
  name: 'jj', transformation: 'preview', commands: jjDiffCommand,
  projectMapped: projectJj, project: input => projectJj(input)?.text,
}
