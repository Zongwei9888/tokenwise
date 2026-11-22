import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, commandIs } from './noise.ts'

const RESULT = /^Build (?:succeeded|FAILED)\.$/u
const WARNINGS = /^ +\d+ Warning\(s\)$/u
const ERRORS = /^ +\d+ Error\(s\)$/u

const dotnetBuildCommand = (command: string) => commandIs(command, ['dotnet'], [['build'], ['publish'], ['pack'], ['msbuild']])

/**
 * `dotnet build` (also publish, pack, msbuild) with MSBuild's console
 * logger: after `Build succeeded.` / `Build FAILED.` the summary prints every
 * warning and error again. When each of those lines is word for word a line
 * printed above, they become one counted note. Every diagnostic as first
 * printed, the restore and project output lines, the result, the warning
 * and error counts and the elapsed time stay verbatim; a summary with any
 * line not printed above stays whole.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!dotnetBuildCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const result = lines.findIndex(line => RESULT.test(line.text))
  if (result < 0) return undefined
  const counts = lines.findIndex((line, i) => i > result && WARNINGS.test(line.text))
  if (counts < 0 || !ERRORS.test(lines[counts + 1]?.text ?? '')) return undefined
  const printed = new Set(lines.slice(0, result).map(line => line.text))
  const summary = lines.slice(result + 1, counts).filter(line => line.text.trim() !== '')
  if (summary.length === 0 || !summary.every(line => printed.has(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let noted = false
  for (const [i, line] of lines.entries()) {
    if (i <= result || i >= counts || line.text.trim() === '') { builder.keep(line.start, line.end); continue }
    if (!noted) builder.generate(summary.length === 1
      ? '[1 warning or error line omitted: the build summary repeats it word for word as printed above]\n'
      : `[${summary.length} warning and error lines omitted: the build summary repeats them, each word for word as printed above]\n`, 'dotnet-summary-repeat')
    noted = true
  }
  return builder.finish()
}

export const dotnetBuildFilter: EconomyFilter = {
  name: 'dotnet-build', transformation: 'diagnostic-deduplication', commands: dotnetBuildCommand, projectMapped,
  project: input => projectMapped(input)?.text,
}
