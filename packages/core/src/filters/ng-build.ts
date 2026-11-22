import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { jsToolArgv } from './js-tool.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** `Application bundle generation complete. [1.777 seconds] - …`, the build's own closing line. */
const DONE = /^Application bundle generation (?:complete|failed)\. \[/u
/** `Initial chunk files | Names | Raw size | Estimated transfer size`, the header of a bundle table. */
const TABLE = /^(?:Initial|Lazy) chunk files +\| /u
/** `                    | Initial total | 190.07 kB |   51.96 kB`, printed after the initial table's blank line. */
const TOTAL = /^ +\| Initial total +\| /u

function ngBuildCommand(command: string): boolean {
  const argv = jsToolArgv(command, ['ng'])
  return argv?.[1] === 'build' && !argv.some(arg => /^(?:--watch|-w)(?:=(?!false$)|$)/u.test(arg))
}

/**
 * `ng build` (the application builder): the column padding of the bundle
 * tables (chunk files, names, raw and transfer sizes, totals) is cut to one
 * space. Every row, size, budget warning, error, code frame and the output
 * location stay as they are.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!ngBuildCommand(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => DONE.test(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let changed = false
  let inTable = false
  for (const line of lines) {
    if (TABLE.test(line.text)) inTable = true
    else if (line.text.trim() === '') inTable = false
    if (!(inTable || TOTAL.test(line.text)) || !line.text.includes('|') || PROBLEM.test(line.text)) {
      builder.keep(line.start, line.end)
      continue
    }
    let start = line.start
    for (const match of line.text.matchAll(/ {2,}/gu)) {
      const at = line.start + match.index
      builder.keep(start, at + 1)
      start = at + match[0].length
    }
    builder.keep(start, line.end)
    changed ||= start !== line.start
  }
  return changed ? builder.finish() : undefined
}

export const ngBuildFilter: EconomyFilter = {
  name: 'ng-build', transformation: 'lossless-formatting', projectMapped, commands: ngBuildCommand,
  project: input => projectMapped(input)?.text,
}
