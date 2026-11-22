import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'

export interface RecordGroups {
  /** A record row; group 1 is its file. The file and the one separator after it move into the group header. */
  readonly record: RegExp
  /** Header text before and after the file name. */
  readonly open: string
  readonly close: string
  /** Projection label recorded in the source map. */
  readonly label: string
}

/**
 * Group runs of three or more consecutive records of one file under one
 * header naming the file; each record keeps everything after `file:`. Every
 * record, line number and non-record line stays, in order. Undefined when no
 * run was grouped.
 */
export function groupRecords(stdout: string, groups: RecordGroups): MappedProjection | undefined {
  const lines = sourceLines(stdout)
  const builder = new ProjectionBuilder(stdout)
  let grouped = false
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!
    const file = groups.record.exec(first.text)?.[1]
    let end = i + 1
    if (file !== undefined) while (end < lines.length && groups.record.exec(lines[end]!.text)?.[1] === file) end++
    if (file === undefined || end - i < 3 || file.length < 4) {
      builder.keep(first.start, first.end); i++; continue
    }
    builder.generate(groups.open, groups.label)
    builder.keep(first.start, first.start + file.length)
    builder.generate(groups.close, groups.label)
    for (; i < end; i++) {
      const line = lines[i]!
      builder.generate('  ', groups.label)
      builder.keep(line.start + file.length + 1, line.end)
    }
    grouped = true
  }
  return grouped ? builder.finish() : undefined
}

/** `path:line:` search records (grep, rg, ast-grep). */
export const SEARCH_RECORDS: RecordGroups = {
  record: /^([^:\r\n\0]+):([1-9]\d*):/, open: '[matches in ', close: '; every match retained]\n', label: 'search-layout',
}
