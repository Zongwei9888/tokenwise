import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'
import { systemArgv } from './system-layout.ts'

/** The first line of a unit's (or the system's) status block: `● nginx.service - …`, `○`, `×`, `↻`, `*`. */
const UNIT = /^[●○×↻*] \S/u
/** A property row, its label right-aligned to the block's colon column (`     Loaded: …`, `    Drop-In: …`, `TriggeredBy: …`). Groups: indentation, label. */
const PROPERTY = /^( *)([A-Z][A-Za-z-]*(?: [A-Za-z]+)*): /u

function statusCommand(command: string): boolean {
  const argv = systemArgv(command)
  // Options before the verb may only be flags (`--user`, `--no-pager`); `-H host` would read as the verb.
  return argv?.[0] === 'systemctl' && argv.slice(1).find(arg => !arg.startsWith('-')) === 'status'
}

/**
 * `systemctl status`: in each unit's property block the indentation that
 * right-aligns the labels goes, and continuation rows (more Docs entries,
 * the CGroup process tree) are indented by two spaces instead of the label
 * width. Every property, process row and journal line keeps its text; a row
 * that mentions a problem (a failed state or exit status) stays as it is.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!statusCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let block = false
  /** Where values start in the current block: the first label's colon plus two. */
  let column: number | undefined
  let changed = false
  for (const line of sourceLines(input.stdout)) {
    const text = line.text
    if (UNIT.test(text)) { block = true; column = undefined; builder.keep(line.start, line.end); continue }
    if (text.trim() === '') block = false
    if (block) {
      const property = PROPERTY.exec(text)
      const continuation = column !== undefined && text.length > column && text.slice(0, column).trim() === '' && text[column] !== ' '
      if (!continuation && property) column ??= property[1]!.length + property[2]!.length + 2
      if (!PROBLEM.test(text)) {
        if (continuation) {
          builder.generate('  ', 'systemctl-indent')
          builder.keep(line.start + column!, line.end)
          changed = true
          continue
        }
        if (property && property[1]!.length + property[2]!.length + 2 === column && property[1]!.length > 0) {
          builder.keep(line.start + property[1]!.length, line.end)
          changed = true
          continue
        }
      }
    }
    builder.keep(line.start, line.end)
  }
  return changed ? builder.finish() : undefined
}

export const systemctlStatusFilter: EconomyFilter = {
  name: 'systemctl-status', transformation: 'lossless-formatting', projectMapped, commands: statusCommand,
  project: input => projectMapped(input)?.text,
}
