import { ProjectionBuilder } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import { PROBLEM } from './noise.ts'

export interface FoldMarkedOptions {
  /** The note that replaces a run: its non-blank line count, its kind and those lines. Must end with a newline. */
  readonly note: (count: number, kind: string, texts: readonly string[]) => string
  /** The fewest non-blank lines a run must have to be folded (default 3). */
  readonly minRun?: number
  readonly label: string
}

/**
 * `foldRuns` for kinds a filter decided line by line beforehand, so a kind
 * may depend on the lines around it (a task header with nothing under it, a
 * build step that printed nothing). A blank line between two lines of one
 * kind joins their run; lines that mention a problem are never folded.
 * Undefined when nothing was folded.
 */
export function foldMarked(stdout: string, lines: readonly SourceLine[], marks: readonly (string | undefined)[], options: FoldMarkedOptions): MappedProjection | undefined {
  const minRun = options.minRun ?? 3
  const kinds = lines.map((line, i) => PROBLEM.test(line.text) ? undefined : marks[i])
  const blank = (i: number) => lines[i]!.text.trim() === ''
  // A blank line inside a run of one kind belongs to it.
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] !== undefined || !blank(i) || i === 0) continue
    let next = i
    while (next < lines.length && blank(next) && kinds[next] === undefined) next++
    const kind = kinds[i - 1]
    if (kind !== undefined && next < lines.length && kinds[next] === kind) for (let j = i; j < next; j++) kinds[j] = kind
    i = next - 1
  }
  const builder = new ProjectionBuilder(stdout)
  let folded = 0
  for (let i = 0; i < lines.length;) {
    const kind = kinds[i]
    let end = i
    if (kind !== undefined) while (end < lines.length && kinds[end] === kind) end++
    // Blank lines that close a run stay: they separate what follows.
    while (end > i && blank(end - 1)) end--
    const texts = lines.slice(i, end).map(line => line.text).filter(text => text.trim() !== '')
    if (kind !== undefined && texts.length >= minRun) {
      builder.generate(options.note(texts.length, kind, texts), options.label)
      folded += texts.length
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  }
  return folded > 0 ? builder.finish() : undefined
}
