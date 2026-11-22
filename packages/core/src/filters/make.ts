import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/** `make[1]: Entering directory '/repo/lib'` (GNU make 4 quotes '…', 3.81 `…'). */
const DIRECTORY = /^[\w./-]*make(?:\[(\d+)\])?: (Entering|Leaving) directory [`'"](.+)['"]$/u
/** Messages that say a target needed no work. */
const IDLE = /^[\w./-]*make(?:\[\d+\])?: (?:[`'"].+['"] is up to date\.|Nothing to be done for [`'"].+['"]\.)$/u

interface Section { readonly enter: number; readonly level: string; readonly directory: string; active: boolean }

/**
 * GNU make: the directory lines of sub-makes where nothing happened, and the
 * "is up to date" / "Nothing to be done" messages, become one counted note.
 * A directory where anything ran or was reported keeps its Entering and
 * Leaving lines, since compiler paths are relative to it. Every recipe line,
 * compiler message, warning, error and `make: ***` line stays verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const argv = toolArgv(input.command)
  if (argv === undefined || !['make', 'gmake'].includes(argv[0] ?? '') || /\0|\r(?!\n)/u.test(input.stdout)) return undefined
  // A database dump or a question run is not a build log.
  if (argv.slice(1).some(arg => /^(?:-[^-]*[pq]|--print-data-base|--question)$/u.test(arg))) return undefined
  const lines = sourceLines(input.stdout)
  const keep = lines.map(() => true)
  const stack: Section[] = []
  let idle = 0
  let directories = 0
  for (const [index, line] of lines.entries()) {
    const directory = DIRECTORY.exec(line.text)
    if (directory) {
      const [, level = '0', kind, path = ''] = directory
      if (kind === 'Entering') { stack.push({ enter: index, level, directory: path, active: false }); continue }
      const section = stack.pop()
      // Lines that do not pair up are not a log this filter understands.
      if (!section || section.level !== level || section.directory !== path) return undefined
      if (!section.active) { keep[section.enter] = false; keep[index] = false; directories += 2 }
      continue
    }
    if (IDLE.test(line.text)) { keep[index] = false; idle++; continue }
    if (line.text.trim() !== '') for (const section of stack) section.active = true
  }
  for (const section of stack) if (!section.active) { keep[section.enter] = false; directories++ }
  if (idle + directories === 0) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  for (const [index, line] of lines.entries()) if (keep[index]) builder.keep(line.start, line.end)
  const parts = [idle ? `${idle} "up to date" or "nothing to be done" messages` : '', directories ? `${directories} directory lines of sub-makes with nothing to report` : '']
  builder.newline()
  builder.generate(`[make: ${parts.filter(Boolean).join(' and ')} omitted]\n`, 'make-idle-lines')
  return builder.finish()
}

export const makeFilter: EconomyFilter = {
  name: 'make', transformation: 'noise-removal', projectMapped,
  commands: command => ['make', 'gmake'].includes(toolArgv(command)?.[0] ?? ''),
  project: input => projectMapped(input)?.text,
}
