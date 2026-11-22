/** Shared by the system filters (wc, du, df, ps, stat, iptables, systemctl, rsync, ast-grep, linters): argv with globs and sudo, and padded-row splitting. */
import { toolArgv } from '../command.ts'
import type { ProjectionBuilder, SourceLine } from '../projection-map.ts'

/**
 * `toolArgv` of a command whose file operands may be glob patterns
 * (`wc -l src/*.ts`, `shellcheck scripts/*.sh`): each unquoted `*`, `?`, `[`
 * or `]` reads as `_`, so the options and the program are known exactly while
 * the operands only stand for some files. Every other shell construct still
 * makes it undefined.
 */
export function globArgv(command: string): readonly string[] | undefined {
  let quote: string | undefined
  let plain = ''
  for (const ch of command) {
    if (quote !== undefined) { if (ch === quote) quote = undefined }
    else if (ch === "'" || ch === '"') quote = ch
    else if ('*?[]'.includes(ch)) { plain += '_'; continue }
    plain += ch
  }
  return toolArgv(plain)
}

/** `globArgv`, past a bare `sudo` (`sudo iptables -L`, `sudo du -sh /var/log/*`). */
export function systemArgv(command: string): readonly string[] | undefined {
  const argv = globArgv(command)
  if (argv?.[0] !== 'sudo') return argv
  const rest = argv.slice(1)
  const name = rest[0]?.replace(/^.*\//u, '')
  return name && !name.startsWith('-') ? [name, ...rest.slice(1)] : undefined
}

/** A table row split into its leading words and the rest of the line, as offsets in the line text. */
export interface TableRow {
  readonly fields: readonly (readonly [number, number])[]
  /** Where the rest of the line starts; undefined when only spaces follow the fields. */
  readonly rest: number | undefined
}

/**
 * Split `text` into `count` space-separated words and the rest of the line.
 * The rest starts at the next word, or, with `restAfterOneSpace`, right after
 * the single space that follows the last field (a `wc` file name may itself
 * start with a space). Undefined when the row has fewer words.
 */
export function splitRow(text: string, count: number, restAfterOneSpace = false): TableRow | undefined {
  const fields: [number, number][] = []
  let i = 0
  while (fields.length < count) {
    while (text[i] === ' ') i++
    if (i >= text.length) return undefined
    const start = i
    while (i < text.length && text[i] !== ' ') i++
    fields.push([start, i])
  }
  if (i >= text.length) return { fields, rest: undefined }
  if (restAfterOneSpace) return { fields, rest: i + 1 }
  let rest = i
  while (text[rest] === ' ') rest++
  return { fields, rest: rest < text.length ? rest : undefined }
}

export function rowWords(text: string, row: TableRow): string[] {
  return row.fields.map(([start, end]) => text.slice(start, end))
}

/**
 * Copy a split row with the padding before, between and after its fields cut
 * to one space; the fields and the rest of the line are copied as they are.
 * Returns how many spaces were dropped.
 */
export function keepCompactRow(builder: ProjectionBuilder, line: SourceLine, row: TableRow): number {
  const { fields, rest } = row
  let dropped = fields[0]![0]
  for (const [index, [start, end]] of fields.entries()) {
    const next = index + 1 < fields.length ? fields[index + 1]![0] : rest
    if (next === undefined) {
      builder.keep(line.start + start, line.start + end)
      dropped += line.text.length - end
    } else {
      builder.keep(line.start + start, line.start + end + 1)
      dropped += next - end - 1
    }
  }
  builder.keep(line.start + (rest ?? line.text.length), line.end)
  return dropped
}
