import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** The rule under an aligned table's header: `----+-------+----`. */
const RULE = /^-+(?:\+-+)*$/u
const FOOTER = /^\(\d+ rows?\)$/u
/** A value psql right-aligns: an integer, decimal or float. */
const NUMBER = /^[-+]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u
const EXEC_VALUED = ['-u', '--user', '-e', '--env', '-w', '--workdir', '--env-file', '--index']

/** `psql …`, also run in a container: `docker exec -i db psql …`, `docker compose exec -T db psql …`. */
function psqlCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv === undefined) return false
  const at = argv[0] === 'docker' && argv[1] === 'exec' ? 2 : argv[0] === 'docker' && argv[1] === 'compose' && argv[2] === 'exec' ? 3 : 0
  if (at === 0) return argv[0] === 'psql'
  let i = at
  while (i < argv.length && argv[i]!.startsWith('-')) i += EXEC_VALUED.includes(argv[i]!) ? 2 : 1
  return argv[i + 1] === 'psql'
}

/** A cell's value, and how many spaces stood before it in its slot (one is psql's margin). */
interface Cell { readonly start: number; readonly end: number; readonly lead: number }

/**
 * The cells of an aligned row whose separators sit under the rule's `+`:
 * ` value | value`. Undefined when the row is not on them, or a cell carries
 * psql's wrapped-value or newline marker (`+` or `.` where the padding space
 * would be).
 */
function cellsUnder(text: string, rule: string, bars: readonly number[]): Cell[] | undefined {
  if (text.length > rule.length || !text.startsWith(' ') || text.includes('\t')) return undefined
  if (text.length === rule.length && !text.endsWith(' ')) return undefined
  for (const bar of bars) if (text[bar] !== '|' || text[bar - 1] !== ' ' || (bar + 1 < text.length && text[bar + 1] !== ' ')) return undefined
  const edges = [-1, ...bars, text.length]
  return edges.slice(1).map((to, k) => {
    const from = edges[k]! + 1
    const value = text.slice(from, to)
    const lead = value.length - value.trimStart().length
    return { start: from + lead, end: from + lead + value.trim().length, lead }
  })
}

interface Row { readonly line: SourceLine; readonly cells: readonly Cell[] }

/** The aligned table whose header is line `at`: its header cells, its rows up to the `(N rows)` footer, and the footer's index. */
function alignedTable(lines: readonly SourceLine[], at: number): { header: Cell[]; rows: Row[]; end: number } | undefined {
  const rule = lines[at + 1]?.text ?? ''
  if (!RULE.test(rule)) return undefined
  const bars = [...rule.matchAll(/\+/gu)].map(match => match.index)
  const header = cellsUnder(lines[at]!.text, rule, bars)
  if (header === undefined) return undefined
  const rows: Row[] = []
  let end = at + 2
  for (; end < lines.length; end++) {
    const cells = cellsUnder(lines[end]!.text, rule, bars)
    if (cells === undefined) break
    rows.push({ line: lines[end]!, cells })
  }
  if (rows.length === 0 || !FOOTER.test(lines[end]?.text ?? '')) return undefined
  // psql right-aligns numbers and left-aligns everything else. In a column that is not all numbers, a cell
  // with more than the one-space margin before it holds a value that starts with spaces: keep the table as printed.
  for (let k = 0; k < header.length; k++) {
    const values = rows.map(row => row.line.text.slice(row.cells[k]!.start, row.cells[k]!.end)).filter(value => value !== '')
    if (values.every(value => NUMBER.test(value))) continue
    if (rows.some(row => row.cells[k]!.lead > 1 && row.cells[k]!.end > row.cells[k]!.start)) return undefined
  }
  return { header, rows, end }
}

function writeCells(builder: ProjectionBuilder, line: SourceLine, cells: readonly Cell[]): void {
  cells.forEach((cell, k) => {
    if (k > 0) builder.generate('\t', 'table-cell-separator')
    builder.keep(line.start + cell.start, line.start + cell.end)
  })
  builder.keep(line.start + line.text.length, line.end)
}

/**
 * psql's aligned result tables (the default): each table, from its header to
 * its `(N rows)` footer, becomes tab-separated cells without their padding,
 * and the `---+---` rule under the header goes. Every column name, row,
 * value (an empty one stays an empty field) and footer stays; a row that may
 * report a problem keeps its layout. A table where a text value starts with
 * spaces of its own passes through, since they would read as padding. Notices, errors, command tags
 * (`INSERT 0 1`), timing and any table psql wrapped, split over lines or
 * printed in another format pass through verbatim.
 */
function projectPsql(input: FilterInput): MappedProjection | undefined {
  if (!psqlCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const builder = new ProjectionBuilder(input.stdout)
  let compacted = 0
  for (let i = 0; i < lines.length;) {
    const table = alignedTable(lines, i)
    const plain = table?.rows.filter(row => !PROBLEM.test(row.line.text)) ?? []
    if (table === undefined || plain.length === 0) {
      builder.keep(lines[i]!.start, lines[i]!.end)
      i++
      continue
    }
    writeCells(builder, lines[i]!, table.header)
    for (const row of table.rows) {
      if (PROBLEM.test(row.line.text)) builder.keep(row.line.start, row.line.end)
      else writeCells(builder, row.line, row.cells)
    }
    compacted += plain.length
    i = table.end
  }
  return compacted > 0 ? builder.finish() : undefined
}

export const psqlFilter: EconomyFilter = {
  name: 'psql', transformation: 'lossless-formatting', commands: psqlCommand,
  projectMapped: projectPsql, project: input => projectPsql(input)?.text,
}
