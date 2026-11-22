import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import { PROBLEM } from './noise.ts'

/**
 * A row of a container, cluster or release listing that may report a
 * problem: `PROBLEM`'s words, and the states docker, kubectl and helm print
 * for something that is not well (`CrashLoopBackOff`, `ErrImagePull`,
 * `OOMKilled`, `Exited (137)`, `pending-upgrade`, `NotReady`, ...). Such a row
 * keeps its layout.
 */
export const ROW_PROBLEM = new RegExp(String.raw`${PROBLEM.source}|backoff|crashloop|oomkilled|evicted|unhealthy|unknown|notready|unschedulable|pending|terminating|restarting|\bdead\b|\berr|exited \((?!0\))\d+\)`, 'iu')

/** Header cells in capitals, as docker, kubectl, helm, gcloud and pulumi print them (`CONTAINER ID`, `PORT(S)`, `APP VERSION`, `MACHINE_TYPE`). */
export function capitalHeader(cells: readonly string[]): boolean {
  return cells.every(cell => /^[A-Z][A-Z0-9_()./%:-]*(?: [A-Z0-9_()./%:-]+)*$/u.test(cell))
}

/** A cell of a line: offsets in the line's text, padding excluded. */
interface Cell { readonly start: number; readonly end: number }
interface Row { readonly line: SourceLine; readonly cells: readonly Cell[] }

export interface TableLayoutOptions {
  /** Whether a line's cells are a table header. */
  readonly header: (cells: readonly string[]) => boolean
  /** Rows (and headers) this matches keep their layout (default `ROW_PROBLEM`). */
  readonly verbatim?: RegExp
}

/**
 * The cells of `text` on columns that start at `starts`, or undefined when
 * the line is not laid out on them: every column starts after two spaces of
 * padding, a cell starts exactly at its column (or is empty) and never runs
 * into the next one.
 */
function cellsOn(text: string, starts: readonly number[]): Cell[] | undefined {
  if (text.trim() === '' || text.includes('\t')) return undefined
  const cells: Cell[] = []
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]!
    if (start >= text.length) { cells.push({ start: text.length, end: text.length }); continue }
    if (start > 0 && text.slice(Math.max(0, start - 2), start).trim() !== '') return undefined
    const end = k + 1 < starts.length ? Math.min(starts[k + 1]!, text.length) : text.length
    const value = text.slice(start, end).trimEnd()
    if (value.startsWith(' ')) return undefined
    cells.push({ start, end: start + value.length })
  }
  // A line with text in its first column only is not a row of these listings.
  return cells.filter(cell => cell.end > cell.start).length >= 2 ? cells : undefined
}

/** The space-aligned table whose header is line `at`, up to a blank line or the end; undefined when there is none. */
function alignedTable(lines: readonly SourceLine[], at: number, header: TableLayoutOptions['header']): { rows: Row[]; end: number } | undefined {
  const head = lines[at]!
  if (head.text.includes('\t')) return undefined
  const names = [...head.text.matchAll(/\S+(?: \S+)*/gu)]
  if (names.length < 2 || !header(names.map(name => name[0]))) return undefined
  const starts = names.map(name => name.index)
  const rows: Row[] = [{ line: head, cells: names.map(name => ({ start: name.index, end: name.index + name[0].length })) }]
  let end = at + 1
  for (; end < lines.length; end++) {
    const cells = cellsOn(lines[end]!.text, starts)
    if (cells === undefined) break
    rows.push({ line: lines[end]!, cells })
  }
  if (rows.length < 2 || (end < lines.length && lines[end]!.text.trim() !== '')) return undefined
  return { rows, end }
}

/** Copy a row as its lead (the text before the first column) and its cells, one tab apart; trailing empty cells are left out. */
function writeRow(builder: ProjectionBuilder, row: Row): void {
  const { line, cells } = row
  let last = cells.length - 1
  while (last > 0 && cells[last]!.end === cells[last]!.start) last--
  builder.keep(line.start, line.start + cells[0]!.start)
  for (let k = 0; k <= last; k++) {
    if (k > 0) builder.generate('\t', 'table-cell-separator')
    builder.keep(line.start + cells[k]!.start, line.start + cells[k]!.end)
  }
  builder.keep(line.start + line.text.length, line.end)
}

/**
 * Space-aligned tables, as Go's tabwriter (docker, kubectl), gcloud and pulumi
 * print them: a header whose cells are two or more spaces apart, then rows
 * whose cells start exactly at the header's columns, up to a blank line or
 * the end of the output. In each table the padding between cells becomes one
 * tab (an empty cell stays an empty field) and the text before the first
 * column stays as it is. A row that may report a problem keeps its layout,
 * and every line outside a table is copied verbatim. Undefined when no table
 * was compacted.
 */
export function compactAlignedTables(raw: string, options: TableLayoutOptions): MappedProjection | undefined {
  const verbatim = options.verbatim ?? ROW_PROBLEM
  const lines = sourceLines(raw)
  const builder = new ProjectionBuilder(raw)
  let compacted = 0
  for (let i = 0; i < lines.length;) {
    const table = alignedTable(lines, i, options.header)
    if (table === undefined) {
      builder.keep(lines[i]!.start, lines[i]!.end)
      i++
      continue
    }
    const rows = table.rows.slice(1).filter(row => !verbatim.test(row.line.text))
    for (const row of table.rows) {
      if (rows.length === 0 || verbatim.test(row.line.text)) builder.keep(row.line.start, row.line.end)
      else writeRow(builder, row)
    }
    compacted += rows.length
    i = table.end
  }
  return compacted > 0 ? builder.finish() : undefined
}

/**
 * Tables whose cells are padded to the column's width and joined by tabs, as
 * helm (uitable) prints them: the padding before each tab and at the end of
 * the line goes, every tab stays. A table is a capital header and the rows
 * after it with the same number of tabs, up to a blank line or the end; every
 * cell of a column but the last must have the same width. A row that may
 * report a problem keeps its layout. Undefined when no table was compacted.
 */
export function compactPaddedTabTables(raw: string, options: TableLayoutOptions): MappedProjection | undefined {
  const verbatim = options.verbatim ?? ROW_PROBLEM
  const lines = sourceLines(raw)
  const builder = new ProjectionBuilder(raw)
  const tabs = (text: string) => text.split('\t').length - 1
  let compacted = 0
  for (let i = 0; i < lines.length;) {
    const count = tabs(lines[i]!.text)
    let end = i + 1
    while (count > 0 && end < lines.length && tabs(lines[end]!.text) === count) end++
    const block = lines.slice(i, end)
    const split = block.map(line => line.text.split('\t'))
    const valid = block.length >= 2 && (end === lines.length || lines[end]!.text.trim() === '')
      && options.header(split[0]!.map(cell => cell.trimEnd()))
      && split[0]!.slice(0, -1).every((cell, k) => split.every(cells => cells[k]!.length === cell.length))
    const rows = valid ? block.slice(1).filter(line => !verbatim.test(line.text)) : []
    if (rows.length === 0) {
      for (const line of block) builder.keep(line.start, line.end)
      i = end
      continue
    }
    block.forEach((line, row) => {
      if (verbatim.test(line.text)) { builder.keep(line.start, line.end); return }
      let at = line.start
      for (const [k, cell] of split[row]!.entries()) {
        if (k > 0) builder.keep(at, at + 1)
        at += k > 0 ? 1 : 0
        builder.keep(at, at + cell.trimEnd().length)
        at += cell.length
      }
      builder.keep(line.start + line.text.length, line.end)
    })
    compacted += rows.length
    i = end
  }
  const projection = builder.finish()
  return compacted > 0 && projection.text.length < raw.length ? projection : undefined
}
