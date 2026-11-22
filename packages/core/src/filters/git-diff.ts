import { toolArgv } from '../command.ts'
import { resolveFilterOptions } from '../filter-options.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

const NON_PATCH = /^(?:--(?:stat|numstat|shortstat|dirstat|name-only|name-status|raw|summary|check|word-diff|no-patch|quiet|binary)(?:=|$)|-s$)/
const METADATA = /^(?:index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/

/**
 * Paths after `--` (`git diff -- a.ts`, `git show HEAD -- a.ts`): the agent
 * chose the files itself, so their patch stays whole. This is also how it
 * reads a long hunk a broader diff previewed.
 */
const limitedToPaths = (argv: readonly string[]) => { const at = argv.indexOf('--'); return at >= 0 && at < argv.length - 1 }

/** Preserve headers and all file identities; only oversized, validated hunks are previewed. */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const options = resolveFilterOptions(input.options)
  if (options === undefined) return undefined
  const argv = toolArgv(input.command)
  if (argv === undefined || argv[0] !== 'git' || argv[1] !== 'diff'
    || argv.some(arg => NON_PATCH.test(arg)) || ![0, 1].includes(input.exitCode)
    || /[\u001b\0]/.test(input.stdout) || limitedToPaths(argv)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines[0]?.text.startsWith('diff --git ')) return undefined
  return previewPatch(input.stdout, lines, options['git-diff'].maxHunkLines, 'git')
}

/** A commit header line of the default `git show` / `git log` format: `commit <sha>` and optional decorations. */
const COMMIT = /^commit [0-9a-f]{7,64}(?: \(.*\))?$/u
/** Options that change the layout of each commit or leave out the patch. */
const NON_DEFAULT_LOG = /^(?:--(?:oneline|graph|pretty|format|stat|numstat|shortstat|name-only|name-status|raw|summary|no-patch|word-diff|color-words|cc|combined-all-paths|first-parent|show-signature|notes)(?:=|$)|-[^-]*[sc]|--format=|--pretty=)/u

/**
 * `git show <commit>` and `git log -p`: each commit's header (author, dates,
 * message) kept verbatim, its patch previewed exactly like `git diff`. Merge
 * diffs (`diff --cc`), other layouts and non-commit objects pass through.
 */
function projectCommitPatches(input: FilterInput): MappedProjection | undefined {
  const options = resolveFilterOptions(input.options)
  if (options === undefined) return undefined
  const argv = toolArgv(input.command)
  if (argv === undefined || argv[0] !== 'git' || input.exitCode !== 0 || /[\u001b\0]/.test(input.stdout)) return undefined
  const patchLog = argv[1] === 'log' && argv.slice(2).some(arg => arg === '-p' || arg === '-u' || arg === '--patch')
  if (!(argv[1] === 'show' || patchLog) || argv.slice(2).some(arg => NON_PATCH.test(arg) || NON_DEFAULT_LOG.test(arg))) return undefined
  // A file's whole history (`git log -p -- a.ts`) can be long: only `git show` keeps the paths it was given whole.
  if (argv[1] === 'show' && limitedToPaths(argv)) return undefined
  const lines = sourceLines(input.stdout)
  if (!COMMIT.test(lines[0]?.text ?? '')) return undefined
  return previewPatch(input.stdout, lines, options['git-diff'].maxHunkLines, 'commits')
}

/**
 * The lines plain `diff` prints about a pair of directories in place of a
 * patch, each one a whole file-level entry: `Only in a: x`, `Common
 * subdirectories: a/s and b/s`, `Binary files a/x and b/x differ`, `File a/x
 * is a directory while file b/x is a regular file`, `Symbolic links … differ`.
 */
const PLAIN_ENTRY = /^(?:Only in .+: .+|Common subdirectories: .+ and .+|(?:Binary files|Files|Symbolic links) .+ and .+ differ|File .+ is a .+ while file .+ is a .+)$/u

/**
 * Patch layouts `previewPatch` reads: `git` (`diff --git` sections),
 * `commits` (`commit <sha>` blocks, header and message kept verbatim, before
 * each commit's patch) and `plain` (POSIX `diff -u` / `diff -ru` of two
 * directories: `diff <options> a/x b/x` sections and PLAIN_ENTRY lines).
 */
export type PatchLayout = 'git' | 'commits' | 'plain'

/**
 * Keep every line of a unified patch except the middle of hunks longer than
 * `maxHunkLines`, which becomes a counted omission; undefined for anything
 * not recognized.
 */
export function previewPatch(raw: string, lines: readonly SourceLine[], maxHunkLines: number, layout: PatchLayout): MappedProjection | undefined {
  const commits = layout === 'commits'
  const plain = layout === 'plain'
  const builder = new ProjectionBuilder(raw)
  let inHeader = false
  let oldRemaining = 0
  let newRemaining = 0
  let hunkLines: SourceLine[] = []
  let added = 0
  let removed = 0
  let truncated = false
  const flush = () => {
    const head = Math.floor(maxHunkLines / 2)
    const tail = maxHunkLines - head
    for (const [index, line] of hunkLines.entries()) {
      if (hunkLines.length <= maxHunkLines || index < head || index >= hunkLines.length - tail) {
        builder.keep(line.start, line.end)
      } else if (index === head) {
        builder.newline()
        builder.generate(`  ... (${hunkLines.length - maxHunkLines} lines truncated)\n`, 'omitted-diff-lines')
        truncated = true
      }
    }
    hunkLines = []
  }
  const fileSummary = () => {
    if (added + removed > 0) {
      builder.newline()
      builder.generate(`  +${added} -${removed}\n`, 'diff-change-counts')
    }
    added = 0
    removed = 0
  }
  for (const line of lines) {
    const value = line.text
    if (value === '\\ No newline at end of file') {
      if (hunkLines.length === 0 || hunkLines.at(-1)?.text === value) return undefined
      hunkLines.push(line)
      continue
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      const prefix = value[0]
      if (prefix !== ' ' && prefix !== '+' && prefix !== '-') return undefined
      if (prefix !== '+') oldRemaining -= 1
      if (prefix !== '-') newRemaining -= 1
      if (oldRemaining < 0 || newRemaining < 0) return undefined
      if (prefix === '+') added += 1
      if (prefix === '-') removed += 1
      hunkLines.push(line)
      continue
    }
    flush()
    if (commits && COMMIT.test(value)) {
      fileSummary()
      inHeader = true
      builder.keep(line.start, line.end)
    } else if (value.startsWith('diff --git ') || plain && (value.startsWith('diff ') || PLAIN_ENTRY.test(value))) {
      fileSummary()
      inHeader = false
      builder.keep(line.start, line.end)
    } else if (value.startsWith('diff ')) return undefined
    else if (inHeader || (commits && value === '')) builder.keep(line.start, line.end)
    else if (value.startsWith('@@ ')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(value)
      if (hunk === null) return undefined
      oldRemaining = Number(hunk[2] ?? 1)
      newRemaining = Number(hunk[4] ?? 1)
      if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining)) return undefined
      builder.keep(line.start, line.end)
    } else if (METADATA.test(value)) builder.keep(line.start, line.end)
    else return undefined
  }
  if (oldRemaining !== 0 || newRemaining !== 0) return undefined
  flush()
  fileSummary()
  if (!truncated) {
    const unchanged = new ProjectionBuilder(raw)
    unchanged.keep(0, raw.length)
    return unchanged.finish()
  }
  if (truncated) builder.generate('[diff sample; omitted lines are counted above; not an applicable patch]\n', 'diff-preview-warning')
  return builder.finish()
}

export const gitDiffFilter: EconomyFilter = {
  name: 'git-diff',
  transformation: 'preview',
  project: input => projectMapped(input)?.text,
  projectMapped,
}

export const gitShowFilter: EconomyFilter = {
  name: 'git-show',
  transformation: 'preview',
  project: input => projectCommitPatches(input)?.text,
  projectMapped: projectCommitPatches,
}
