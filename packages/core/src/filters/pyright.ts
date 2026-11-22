import { developerCommand } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN } from './noise.ts'

/** A file header: the path alone, at the start of the line. */
const HEADER = /^\S.*\.pyi?$/u
/** `12:5 - error: …` after the header's path and `:`. */
const LOCATION = /^:\d+:\d+ - (?:error|warning|information): /u
/** `3 errors, 1 warning, 0 informations ` (pyright) or `… 0 notes` (basedpyright). */
const SUMMARY = /^\d+ errors?, \d+ warnings?, \d+ (?:informations?|notes?) ?$/u

function isPyright(command: string): boolean {
  return ['pyright', 'basedpyright'].includes(developerCommand(command)?.[0] ?? '')
}

/**
 * pyright / basedpyright text output names each file once on a header line
 * and again at the start of every diagnostic row under it. The repeated path
 * is dropped from those rows, which keep their line, column, severity,
 * message, continuation lines and rule; one note at the end says so. Headers,
 * the summary and every other line stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isPyright(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => SUMMARY.test(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let path: string | undefined
  let trimmed = 0
  for (const line of lines) {
    if (HEADER.test(line.text)) path = line.text
    else if (path !== undefined && line.text.startsWith(`  ${path}`) && LOCATION.test(line.text.slice(2 + path.length))) {
      builder.keep(line.start, line.start + 2)
      builder.keep(line.start + 3 + path.length, line.end)
      trimmed++
      continue
    } else if (!line.text.startsWith('    ')) path = undefined
    builder.keep(line.start, line.end)
  }
  if (trimmed < 3) return undefined
  builder.newline()
  builder.generate(`[file path omitted from ${trimmed} diagnostic rows: each is in the file on the header line above it]\n`, 'pyright-row-paths')
  return builder.finish()
}

export const pyrightFilter: EconomyFilter = {
  name: 'pyright', transformation: 'lossless-formatting', commands: isPyright, projectMapped,
  project: input => projectMapped(input)?.text,
}
