import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/** A usage hint: two spaces and a parenthesized sentence telling the person which command to type. */
const HINT = /^ {2}\((?:use|fix|all conflicts fixed:?|run|commit or discard|see|create\/copy files) .*\)$/u
/** A closing line whose parenthesis is only a hint (the other closing lines say something in theirs). */
const CLOSING_HINT = /^(no changes added to commit|nothing added to commit but untracked files present) \(use "git add".*\)$/u

/** Long-format sections and the short format's column each one fills. */
const SECTIONS: Readonly<Record<string, 'staged' | 'unmerged' | 'unstaged' | 'untracked' | 'ignored'>> = {
  'Changes to be committed:': 'staged',
  'Unmerged paths:': 'unmerged',
  'Changes not staged for commit:': 'unstaged',
  'Untracked files:': 'untracked',
  'Ignored files:': 'ignored',
}
const STAGED: Readonly<Record<string, string>> = { modified: 'M', 'new file': 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' }
const UNSTAGED: Readonly<Record<string, string>> = { modified: 'M', 'new file': 'A', deleted: 'D', renamed: 'R', typechange: 'T' }
const UNMERGED: Readonly<Record<string, string>> = {
  'both deleted': 'DD', 'added by us': 'AU', 'deleted by them': 'UD', 'added by them': 'UA', 'deleted by us': 'DU', 'both added': 'AA', 'both modified': 'UU',
}
/** A tracked entry: a tab, the label padded to a column, the path (`old -> new` for a rename or copy). */
const ENTRY = /^\t([a-z ]+):\s+(\S.*)$/u
/** Short-form rows save about this much each over long-form ones; below a few rows the legend costs more. */
const SHORT_MIN_ROWS = 3
const LEGEND = '[short format: XY path, X = staged, Y = not staged, ?? untracked]\n'

interface Row { x: string; y: string; path: string }

/** The short format quotes a path with a space (the long one does not); one git quoted already stays as it is. */
const quote = (path: string) => path.startsWith('"') || !path.includes(' ') ? path : `"${path}"`
const quotePaths = (path: string, renamed: boolean) => renamed ? path.split(' -> ').map(quote).join(' -> ') : quote(path)

/**
 * The long format's file lists as `git status --short` rows: tracked changes
 * by path (a file staged and changed again is one `MM` row), then untracked,
 * then ignored. Every other line (branch, ahead/behind, merge or rebase state)
 * is kept, without its usage hints. Undefined when any line in a file list is
 * not one git prints, so nothing is ever guessed.
 */
function shortForm(raw: string, lines: readonly SourceLine[]): MappedProjection | undefined {
  const tracked = new Map<string, Row>(), untracked: string[] = [], ignored: string[] = []
  // Lines kept as they are, before the first file list (branch, state) and after it (what closes the status).
  const before: SourceLine[] = [], after: SourceLine[] = []
  let section: (typeof SECTIONS)[string] | undefined
  let closing: { text: string } | undefined
  let listed = false
  for (const line of lines) {
    const text = line.text
    if (text === '' || HINT.test(text)) continue
    if (SECTIONS[text]) { section = SECTIONS[text]; listed = true; continue }
    if (text.startsWith('\t')) {
      if (section === undefined) return undefined
      if (section === 'untracked' || section === 'ignored') { (section === 'untracked' ? untracked : ignored).push(quote(text.slice(1))); continue }
      const match = ENTRY.exec(text)
      if (!match) return undefined
      const [, label, path] = match as unknown as [string, string, string]
      // A rename's later change is listed by its new name: one row, `RM old -> new`.
      const renamed = section === 'staged' && (label === 'renamed' || label === 'copied')
      const key = renamed ? path.split(' -> ').at(-1)! : path
      const row = tracked.get(key) ?? { x: ' ', y: ' ', path: quotePaths(path, false) }
      if (section === 'unmerged') {
        const code = UNMERGED[label]
        if (!code) return undefined
        row.x = code[0]!; row.y = code[1]!
      } else {
        const code = (section === 'staged' ? STAGED : UNSTAGED)[label]
        if (!code) return undefined
        if (section === 'staged') { row.x = code; row.path = quotePaths(path, renamed) } else row.y = code
      }
      tracked.set(key, row)
      continue
    }
    // Lines after the lists close the status; the first one with a hint in parentheses loses only that.
    section = undefined
    const hinted = CLOSING_HINT.exec(text)
    if (hinted) closing = { text: hinted[1]! }
    else (listed ? after : before).push(line)
  }
  const rows = [...[...tracked.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => `${row.x}${row.y} ${row.path}`),
    ...untracked.map(path => `?? ${path}`), ...ignored.map(path => `!! ${path}`)]
  if (rows.length < SHORT_MIN_ROWS) return undefined
  const builder = new ProjectionBuilder(raw)
  for (const line of before) builder.keep(line.start, line.end)
  builder.generate(LEGEND, 'git-status-short-legend')
  builder.generate(rows.join('\n') + '\n', 'git-status-short-rows')
  for (const line of after) builder.keep(line.start, line.end)
  if (closing) builder.generate(`${closing.text}\n`, 'git-status-closing')
  return builder.finish()
}

function projectMapped(input: FilterInput) {
  const argv = toolArgv(input.command)
  if (argv?.[0] !== 'git' || argv[1] !== 'status' || input.exitCode !== 0 || /[\u001b\0]/.test(input.stdout)) return undefined
  if (argv.some(arg => /^(?:--(?:short|porcelain|null)(?:=|$)|-[^-]*[sz])/.test(arg))) return undefined
  const lines = sourceLines(input.stdout)
  if (!/^(?:On branch .+|HEAD detached (?:at|from) .+|Not currently on any branch\.)$/.test(lines[0]?.text ?? '')) return undefined
  const short = shortForm(input.stdout, lines)
  if (short) return short
  const builder = new ProjectionBuilder(input.stdout)
  for (const line of lines) {
    if (HINT.test(line.text)) continue
    const hinted = CLOSING_HINT.exec(line.text)
    if (hinted) builder.generate(`${hinted[1]}\n`, 'git-status-closing')
    else builder.keep(line.start, line.end)
  }
  return builder.finish()
}

/**
 * Long `git status` as the short format git itself prints with `--short`: one
 * `XY path` row per file, every path and status kept, with the branch and any
 * merge or rebase state lines as they were. Only the usage hints go. A short
 * status, or one with a line this does not know, keeps its layout and loses
 * only the hints.
 */
export const gitStatusFilter: EconomyFilter = {
  name: 'git-status', transformation: 'noise-removal', projectMapped,
  project: input => projectMapped(input)?.text,
}
