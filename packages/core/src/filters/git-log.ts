import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/** A commit header line of the default format: `commit <sha>` and optional decorations. */
const COMMIT = /^commit [0-9a-f]{7,64}(?: \(.*\))?$/u
/** Header fields of the default (`medium`) format, and of `--pretty=fuller` style output git may print. */
const FIELD = /^(?:Merge|Author|AuthorDate|Commit|CommitDate|Date):\s/u
/** A `--oneline` row: abbreviated hash, optional decorations, subject. */
const ONELINE = /^[0-9a-f]{7,64}(?: \([^)]*\))? \S/u
/** Words that make a commit (or a row) evidence the agent may be looking for; such commits are never omitted. */
const NOTABLE = /\b(?:errors?|warnings?|fail(?:ed|ing|s|ures?)?|fatal|panic(?:ked)?|traceback|exceptions?|conflicts?|revert(?:ed|s)?)\b|\w(?:Error|Exception|Warning)\b|\bFAIL(?:ED)?\b/iu
/**
 * Options that print something other than the default commit blocks or
 * `--oneline` rows: patches (left to git-show), stats, custom formats, graphs,
 * signatures, notes, boundary/left-right markers.
 */
const OTHER_LAYOUT = /^(?:-p|-u|-s|--patch|--no-patch|--stat|--numstat|--shortstat|--dirstat|--name-only|--name-status|--raw|--summary|--word-diff|--format|--pretty|--graph|--show-signature|--notes|--left-right|--boundary|--cc|-c|--patch-with-stat|--patch-with-raw|--compact-summary|--source|--children|--parents|--log-size|-z|--color|--color-words)(?:=|$)|^-[^-]*[puszc]/u

/**
 * A bare `git log` with more than LOG_MIN commits keeps the first LOG_HEAD
 * commits whole and the last LOG_TAIL. An agent that runs a bare `git log`
 * nearly always wants the recent history; ten commits with their full messages
 * cover that, and the oldest two show where the listing ends. Commits whose
 * message mentions a failure, error, warning, conflict or revert are kept
 * wherever they are. A log the agent scoped itself is left whole (SCOPED).
 */
const LOG_MIN = 15
const LOG_HEAD = 10
const LOG_TAIL = 2
/** `git log --oneline`: rows are short, so the cut starts later and keeps more. */
const ONELINE_MIN = 50
const ONELINE_HEAD = 30
const ONELINE_TAIL = 5

/**
 * Options with which the agent chose the commits itself: a count, a skip, a
 * time window, a search, a line range. Nothing it asked for is cut, so this is
 * also how it reads the commits a bare log left out (`git log -40`).
 */
const SCOPED = /^(?:-n|-\d+|--max-count|--skip|--since|--after|--until|--before|--author|--committer|--grep|-S|-G|-L|--follow)(?:=|$)|^-[nSGL]./u

function gitLogArgv(command: string): readonly string[] | undefined {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'git' || argv[1] !== 'log') return undefined
  return argv.slice(2)
}

/** Commit blocks of default-format output: [first line index, end index). Undefined unless every line fits the format. */
function commitBlocks(lines: readonly SourceLine[]): [number, number][] | undefined {
  const blocks: [number, number][] = []
  let i = 0
  while (i < lines.length) {
    if (!COMMIT.test(lines[i]!.text)) return undefined
    const start = i++
    while (i < lines.length && FIELD.test(lines[i]!.text)) i++
    if (i === start + 1) return undefined
    // A blank line, then the message indented by four spaces (or blank), up to the next commit.
    if (i < lines.length && lines[i]!.text !== '') return undefined
    while (i < lines.length && !COMMIT.test(lines[i]!.text)) {
      const text = lines[i]!.text
      if (text !== '' && !text.startsWith('    ')) return undefined
      i++
    }
    blocks.push([start, i])
  }
  return blocks
}

/**
 * Keep units [0, head) and [length - tail, length) and every notable unit in
 * between; each run of omitted units becomes one counted note.
 */
function previewUnits(raw: string, lines: readonly SourceLine[], units: readonly [number, number][], head: number, tail: number,
  notable: (unit: [number, number]) => boolean): MappedProjection {
  const builder = new ProjectionBuilder(raw)
  let omitted = 0
  const flush = () => {
    if (omitted === 0) return
    builder.generate(`[${omitted} commit${omitted === 1 ? '' : 's'} omitted]\n`, 'git-log-omitted-commits')
    omitted = 0
  }
  for (const [index, unit] of units.entries()) {
    if (index >= head && index < units.length - tail && !notable(unit)) { omitted++; continue }
    flush()
    builder.keep(lines[unit[0]]!.start, lines[unit[1] - 1]!.end)
  }
  flush()
  return builder.finish()
}

function projectMapped(input: FilterInput): MappedProjection | undefined {
  const args = gitLogArgv(input.command)
  if (args === undefined || input.exitCode !== 0 || /[\u001b\0\r]/u.test(input.stdout)) return undefined
  const oneline = args.includes('--oneline')
  if (args.some(arg => arg !== '--oneline' && OTHER_LAYOUT.test(arg))) return undefined
  // A revision, a range or a path (with or without `--`) scopes the log too.
  if (args.some(arg => !arg.startsWith('-') || arg === '--' || SCOPED.test(arg))) return undefined
  const lines = sourceLines(input.stdout)
  const notable = (unit: [number, number]) => lines.slice(unit[0], unit[1]).some(line => NOTABLE.test(line.text))
  if (oneline) {
    if (lines.length <= ONELINE_MIN || !lines.every(line => ONELINE.test(line.text))) return undefined
    return previewUnits(input.stdout, lines, lines.map((_, i) => [i, i + 1]), ONELINE_HEAD, ONELINE_TAIL, notable)
  }
  const blocks = commitBlocks(lines)
  if (blocks === undefined || blocks.length <= LOG_MIN) return undefined
  return previewUnits(input.stdout, lines, blocks, LOG_HEAD, LOG_TAIL, notable)
}

export const gitLogFilter: EconomyFilter = {
  name: 'git-log', transformation: 'preview', projectMapped,
  project: input => projectMapped(input)?.text,
}

/**
 * One default `git blame` row: hash (`^` for a boundary commit), then
 * `(<author> <date> <time> <tz> <line>)` and the code. Groups: hash, the
 * offset where the padded line number starts.
 */
const BLAME = /^(\^?[0-9a-f]{7,64}) \(.*? \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}( +\d+)\) /u
/** Options that change the row layout (porcelain, incremental, emails, file names, raw times, no author, annotate format). */
const BLAME_LAYOUT = /^(?:-p|--porcelain|--line-porcelain|--incremental|-s|-e|--show-email|-f|--show-name|-n|--show-number|-t|-c|--abbrev|--score-debug|--color-lines|--color-by-age|-b|--root|--date)(?:=|$)|^-[^-L]*[psefntcb]/u
/** Runs shorter than this are left whole: the note would cost about what the omitted headers save. */
const BLAME_RUN_MIN = 4

/**
 * Consecutive rows from one commit: the first row whole, the rest from their
 * padded line number on, after one note. Every line number and every code
 * line stays; only the repeated hash, author and date go.
 */
function projectBlame(input: FilterInput): MappedProjection | undefined {
  const argv = toolArgv(input.command)
  if (argv?.[0] !== 'git' || argv[1] !== 'blame' || input.exitCode !== 0 || /[\u001b\0\r]/u.test(input.stdout)) return undefined
  if (argv.slice(2).some(arg => BLAME_LAYOUT.test(arg))) return undefined
  const lines = sourceLines(input.stdout)
  const rows = lines.map(line => {
    const match = BLAME.exec(line.text)
    return match && { line, hash: match[1]!, numberAt: match[0].length - match[2]!.length - 2, number: Number(match[2]!.trim()) }
  })
  if (rows.length === 0 || rows.some(row => !row)) return undefined
  // Line numbers count up by one: a full blame or one -L range.
  if (rows.some((row, i) => i > 0 && row!.number !== rows[i - 1]!.number + 1)) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let grouped = false
  for (let i = 0; i < rows.length;) {
    let end = i + 1
    while (end < rows.length && rows[end]!.hash === rows[i]!.hash) end++
    const first = rows[i]!
    builder.keep(first.line.start, first.line.end)
    if (end - i >= BLAME_RUN_MIN) {
      builder.generate(`[hash, author and date of the next ${end - i - 1} lines omitted: same as above]\n`, 'git-blame-same-commit')
      for (let j = i + 1; j < end; j++) builder.keep(rows[j]!.line.start + rows[j]!.numberAt, rows[j]!.line.end)
      grouped = true
    } else {
      for (let j = i + 1; j < end; j++) builder.keep(rows[j]!.line.start, rows[j]!.line.end)
    }
    i = end
  }
  return grouped ? builder.finish() : undefined
}

export const gitBlameFilter: EconomyFilter = {
  name: 'git-blame', transformation: 'lossless-formatting', projectMapped: projectBlame,
  project: input => projectBlame(input)?.text,
}
