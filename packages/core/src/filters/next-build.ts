import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { jsToolArgv } from './js-tool.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** `  ▲ Next.js 14.2.24`, the build's first line. */
const BANNER = /^ +▲ Next\.js \d+\.\d+/u
/** `Route (app)   Size   First Load JS`, the header of a route table. */
const TABLE = /^Route \((?:app|pages)\) /u
/** Intermediate page-generation progress: `   Generating static pages (2/9) ` (the final `✓ … (9/9)` row stays). */
const PROGRESS = /^ {3}Generating static pages \(\d+\/\d+\)(?: \.\.\.| )?$/u
/** Column padding: two or more spaces before a size or a column header. */
const PADDING = / {2,}(?=\d+(?:\.\d+)? (?:B|kB|MB|GB)\b|Size\b|First Load JS\b|Revalidate\b|Expire\b)/gu
/** `ƒ Middleware   26.6 kB`, printed under the route tables. */
const MIDDLEWARE = /^ƒ Middleware +\d+(?:\.\d+)? (?:B|kB|MB|GB)$/u

/** Copy a table row with each run of column padding cut to one space. */
function keepCollapsed(builder: ProjectionBuilder, line: SourceLine): boolean {
  let start = line.start
  for (const match of line.text.matchAll(PADDING)) {
    const at = line.start + match.index
    builder.keep(start, at + 1)
    start = at + match[0].length
  }
  builder.keep(start, line.end)
  return start !== line.start
}

function nextBuildCommand(command: string): boolean {
  return jsToolArgv(command, ['next'])?.[1] === 'build'
}

/**
 * A successful `next build`: the column padding of the route tables is cut
 * to one space, and runs of three or more intermediate "Generating static
 * pages (k/N)" progress rows become one counted note. Every route, size,
 * chunk, legend, phase line, warning and the final page count stay.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!nextBuildCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => BANNER.test(line.text)) || !lines.some(line => TABLE.test(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let changed = false
  let inTable = false
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    let end = i
    while (end < lines.length && PROGRESS.test(lines[end]!.text)) end++
    if (end - i >= 3) {
      builder.generate(`[${end - i} static page progress lines omitted]\n`, 'next-build-progress')
      changed = true
      i = end
      continue
    }
    if (TABLE.test(line.text)) inTable = true
    else if (line.text.trim() === '') inTable = false
    const row = (inTable || MIDDLEWARE.test(line.text)) && !PROBLEM.test(line.text)
    if (row) changed = keepCollapsed(builder, line) || changed
    else builder.keep(line.start, line.end)
    i++
  }
  return changed ? builder.finish() : undefined
}

export const nextBuildFilter: EconomyFilter = {
  name: 'next-build', transformation: 'noise-removal', projectMapped, commands: nextBuildCommand,
  project: input => projectMapped(input)?.text,
}
