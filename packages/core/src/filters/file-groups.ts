import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'

/** A diagnostic row that starts with its file: `app/models.py:12: error: …`. */
export interface FileRow {
  readonly path: string
  /** Offset in the row where the text after `path` and its `:` starts. */
  readonly rest: number
}

/** The parts of a row's rest that consecutive rows may share: `25` and `note: By default …`. */
export interface RowLocation {
  readonly location: string
  readonly body: string
}

export interface FileGroupOptions {
  readonly row: (text: string) => FileRow | undefined
  /** How many lines after row `index` belong to it (a source snippet); they stay verbatim inside the group. */
  readonly attached?: (lines: readonly SourceLine[], index: number) => number
  /** Rows whose bodies are identical may share one row listing all their locations; undefined keeps the row as it is. */
  readonly mergeable?: (rest: string) => RowLocation | undefined
  /** Header text before and after the copied path. */
  readonly header: readonly [string, string]
  readonly label: string
}

/** The fewest rows of one file that are grouped: fewer cost less as they are. */
const MIN_ROWS = 3

/**
 * Group runs of three or more consecutive diagnostic rows of one file under
 * a header naming the file once; each row keeps everything after its path.
 * Lines that are not rows of the run's file end it and stay verbatim.
 * Undefined when nothing was grouped.
 */
export function groupFileRows(stdout: string, options: FileGroupOptions): MappedProjection | undefined {
  const lines = sourceLines(stdout)
  const builder = new ProjectionBuilder(stdout)
  let grouped = false
  for (let i = 0; i < lines.length;) {
    const first = options.row(lines[i]!.text)
    if (first === undefined) { builder.keep(lines[i]!.start, lines[i]!.end); i++; continue }
    const members: { index: number; rest: number; attached: number }[] = []
    let end = i
    while (end < lines.length) {
      const row = options.row(lines[end]!.text)
      if (row === undefined || row.path !== first.path) break
      const attached = Math.min(options.attached?.(lines, end) ?? 0, lines.length - end - 1)
      members.push({ index: end, rest: row.rest, attached })
      end += 1 + attached
    }
    if (members.length < MIN_ROWS) {
      for (; i < end; i++) builder.keep(lines[i]!.start, lines[i]!.end)
      continue
    }
    builder.newline()
    builder.generate(options.header[0], options.label)
    builder.keep(lines[i]!.start, lines[i]!.start + first.path.length)
    builder.generate(options.header[1], options.label)
    for (let m = 0; m < members.length;) {
      const member = members[m]!
      const line = lines[member.index]!
      const shared = options.mergeable?.(line.text.slice(member.rest))
      let next = m + 1
      // Rows with the same body share one row only when nothing sits between them.
      const locations = shared === undefined || member.attached > 0 ? [] : [shared.location]
      while (locations.length > 0 && next < members.length && members[next]!.attached === 0) {
        const candidate = members[next]!
        const other = options.mergeable?.(lines[candidate.index]!.text.slice(candidate.rest))
        if (other?.body !== shared!.body) break
        locations.push(other.location)
        next++
      }
      builder.generate('  ', options.label)
      if (next - m > 1) {
        for (let k = m; k < next; k++) {
          const from = lines[members[k]!.index]!.start + members[k]!.rest
          if (k > m) builder.generate(', ', options.label)
          builder.keep(from, from + locations[k - m]!.length)
        }
        builder.keep(line.start + member.rest + shared!.location.length, line.end)
      } else {
        builder.keep(line.start + member.rest, line.end)
        for (let a = 1; a <= member.attached; a++) builder.keep(lines[member.index + a]!.start, lines[member.index + a]!.end)
      }
      m = next
    }
    grouped = true
    i = end
  }
  return grouped ? builder.finish() : undefined
}
