import { inspectShell } from '../shell-inspection.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/**
 * Runs of three or more consecutive path rows in one directory become a
 * `[paths in <dir>/; original order]` header and the rows' names under it.
 * Every path stays, in order; metadata, headings and every other line stay
 * verbatim. Undefined when nothing was grouped.
 */
export function groupPathRuns(raw: string): MappedProjection | undefined {
  const lines = sourceLines(raw)
  const builder = new ProjectionBuilder(raw)
  let grouped = false
  // Complete path rows only; metadata, headings and every other line stay verbatim.
  const directoryOf = (text: string): string | undefined => {
    if (!/^(?:\/?[\w.-]+\/)+[^/\r\n]+$/.test(text)) return undefined
    return text.slice(0, text.lastIndexOf('/') + 1)
  }
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!
    const directory = directoryOf(first.text)
    let end = i + 1
    if (directory !== undefined) while (end < lines.length && directoryOf(lines[end]!.text) === directory) end++
    if (directory === undefined || directory.length < 5 || end - i < 3) {
      builder.keep(first.start, first.end); i++; continue
    }
    builder.generate('[paths in ', 'path-layout')
    builder.keep(first.start, first.start + directory.length)
    builder.generate('; original order]\n', 'path-layout')
    for (; i < end; i++) {
      builder.generate('  ', 'path-layout')
      builder.keep(lines[i]!.start + directory.length, lines[i]!.end)
    }
    grouped = true
  }
  return grouped ? builder.finish() : undefined
}

function projectMapped(input: FilterInput) {
  const shell = inspectShell(input.command)
  if (!shell?.heads.includes('find') || input.exitCode !== 0
    || /[\u001b\0]|\r(?!\n)/.test(input.stdout)) return undefined
  return groupPathRuns(input.stdout)
}

export const pathListFilter: EconomyFilter = {
  name: 'path-list', transformation: 'lossless-formatting', projectMapped,
  project: input => projectMapped(input)?.text,
}
