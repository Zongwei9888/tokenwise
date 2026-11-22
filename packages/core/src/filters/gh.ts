import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/**
 * Options that print another layout: JSON, a Go template, a browser, the
 * comments alone, a `--watch` refresh. Everything else (`-R owner/repo`,
 * `--required`, a number or a branch) keeps gh's own non-TTY layout.
 */
const OTHER_LAYOUT = /^(?:--(?:json|jq|template|web|comments|watch)(?:=|$)|-[qtwc]$)/u

type GhView = 'checks' | 'view'

function ghCommand(command: string): GhView | undefined {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'gh' || argv.slice(3).some(arg => OTHER_LAYOUT.test(arg))) return undefined
  if (argv[1] === 'pr' && argv[2] === 'checks') return 'checks'
  if ((argv[1] === 'pr' || argv[1] === 'issue') && argv[2] === 'view') return 'view'
  return undefined
}

// ——— gh pr checks ———

/** A non-TTY row: name, bucket (pass, fail, pending, skipping, cancel), elapsed, link, description. */
const CHECK = /^([^\t]+)\t([a-z]+)\t([^\t]*)\t([^\t]*)\t([^\t]*)$/u
/** The part of a GitHub Actions job link every job of the repository shares. */
const RUNS_PREFIX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/(?=\d+\/job\/\d+$)/u
/** The prefix is replaced in this many rows at least; on fewer the header costs more than it saves. */
const CHECKS_MIN = 3
const SHORT_PREFIX = 'runs/'
/** Rows whose link may be shortened; a failed or cancelled check keeps its whole link, ready to open. */
const QUIET_BUCKETS = new Set(['pass', 'pending', 'skipping'])

/**
 * `gh pr checks` (stdout not a terminal: tab-separated rows, no summary):
 * the job link prefix every GitHub Actions check shares,
 * `https://github.com/<owner>/<repo>/actions/runs/`, is written once in a
 * header and each passing, pending or skipped row's link starts `runs/`.
 * Every row, status, time and description stays; a failed or cancelled
 * check, or a row that mentions a problem, keeps its whole link, as do links
 * elsewhere.
 */
function projectChecks(raw: string, lines: readonly SourceLine[]): MappedProjection | undefined {
  const rows = lines.map(line => CHECK.exec(line.text))
  if (rows.length === 0 || rows.some(row => row === null)) return undefined
  const prefixOf = (row: RegExpExecArray) => !QUIET_BUCKETS.has(row[2]!) || PROBLEM.test(row[0]) ? undefined : RUNS_PREFIX.exec(row[4]!)?.[0]
  const prefix = rows.map(row => prefixOf(row!)).find(found => found !== undefined)
  if (prefix === undefined || rows.filter(row => prefixOf(row!) === prefix).length < CHECKS_MIN) return undefined
  const builder = new ProjectionBuilder(raw)
  builder.generate(`[${SHORT_PREFIX} in the links below stands for ${prefix}]\n`, 'gh-checks-link-prefix')
  for (const [index, line] of lines.entries()) {
    const row = rows[index]!
    if (prefixOf(row) !== prefix) { builder.keep(line.start, line.end); continue }
    // The link is the fourth field: after name, bucket and elapsed and their tabs.
    const linkAt = line.start + row[1]!.length + row[2]!.length + row[3]!.length + 3
    builder.keep(line.start, linkAt)
    builder.generate(SHORT_PREFIX, 'gh-checks-link-prefix')
    builder.keep(linkAt + prefix.length, line.end)
  }
  const projection = builder.finish()
  return projection.text.length < raw.length ? projection : undefined
}

// ——— gh pr view / gh issue view ———

/** A metadata row of the non-TTY layout: `title:\t…`, `state:\tOPEN`, `assignees:\t` (empty). */
const FIELD = /^[a-z][a-z-]*:\t/u
/** A fenced code block opens or closes: up to three spaces, then ``` or ~~~. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/u
/** A comment block is folded once it is this long; a short one costs about what its note does. */
const COMMENT_MIN_CHARS = 60

/**
 * `gh pr view` / `gh issue view` (stdout not a terminal: `field:\tvalue`
 * rows, `--`, then the body as written): HTML comments in the body, which
 * GitHub does not show (template guidance such as `<!-- Describe your
 * change -->`), become one counted note each. Only whole lines that are all
 * comment, outside code blocks, and no comment that mentions a problem. The
 * metadata rows and every other body line stay verbatim.
 */
function projectView(raw: string, lines: readonly SourceLine[]): MappedProjection | undefined {
  if (!lines[0]?.text.startsWith('title:\t')) return undefined
  const separator = lines.findIndex(line => line.text === '--')
  if (separator < 0 || lines.slice(0, separator).some(line => !FIELD.test(line.text))) return undefined
  const builder = new ProjectionBuilder(raw)
  for (const line of lines.slice(0, separator + 1)) builder.keep(line.start, line.end)
  let fence: string | undefined
  let folded = false
  for (let i = separator + 1; i < lines.length;) {
    const line = lines[i]!
    const opener = FENCE.exec(line.text)?.[1]
    if (fence !== undefined || opener !== undefined) {
      if (fence === undefined) fence = opener
      else if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length && line.text.trim() === opener) fence = undefined
      builder.keep(line.start, line.end); i++; continue
    }
    const end = commentEnd(lines, i)
    const block = end === undefined ? [] : lines.slice(i, end)
    if (end === undefined || block.some(row => PROBLEM.test(row.text)) || block.reduce((sum, row) => sum + row.text.length, 0) < COMMENT_MIN_CHARS) {
      builder.keep(line.start, line.end); i++; continue
    }
    builder.generate(`[${block.length} HTML comment line${block.length === 1 ? '' : 's'} omitted]\n`, 'gh-body-html-comment')
    folded = true
    i = end
  }
  return folded ? builder.finish() : undefined
}

/** The end (exclusive) of a comment that starts line `at` and closes at the end of a line, or undefined. */
function commentEnd(lines: readonly SourceLine[], at: number): number | undefined {
  const first = lines[at]!.text
  if (!/^\s*<!--/u.test(first)) return undefined
  for (let i = at; i < lines.length; i++) {
    const text = i === at ? first.slice(first.indexOf('<!--') + 4) : lines[i]!.text
    const close = text.indexOf('-->')
    if (close < 0) continue
    return text.slice(close + 3).trim() === '' ? i + 1 : undefined
  }
  return undefined
}

function projectMapped(input: FilterInput): MappedProjection | undefined {
  const view = ghCommand(input.command)
  if (view === undefined || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  // `gh pr checks` exits 1 when a check failed and 8 while some are pending: its rows are complete either way.
  if (view === 'checks') return [0, 1, 8].includes(input.exitCode) ? projectChecks(input.stdout, lines) : undefined
  return input.exitCode === 0 ? projectView(input.stdout, lines) : undefined
}

export const ghFilter: EconomyFilter = {
  name: 'gh', transformation: 'noise-removal', projectMapped,
  commands: command => ghCommand(command) !== undefined,
  project: input => projectMapped(input)?.text,
}
