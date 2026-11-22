import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { compactNestedJson } from './json-output.ts'
import { globArgv } from './system-layout.ts'
import { NOT_PLAIN } from './noise.ts'
import { groupRecords, SEARCH_RECORDS } from './record-groups.ts'

/**
 * The output an `ast-grep` / `sg` search prints: `run` (named, or implied by a
 * leading option such as `-p`), as `path:line:` records or, with `--json`
 * (pretty), as a JSON array. Undefined for other subcommands (`scan`, `test`,
 * `lsp`, …), interactive runs and the compact JSON styles.
 */
function searchOutput(command: string): 'records' | 'json' | undefined {
  const argv = globArgv(command)
  if (!['ast-grep', 'sg'].includes(argv?.[0] ?? '')) return undefined
  const first = argv![1]
  if (first !== 'run' && !first?.startsWith('-')) return undefined
  let output: 'records' | 'json' = 'records'
  for (const arg of argv!.slice(1)) {
    if (arg === '--') break
    if (arg === '-i' || arg === '--interactive') return undefined
    if (arg === '--json' || arg === '--json=pretty') output = 'json'
    else if (arg.startsWith('--json=')) return undefined
  }
  return output
}

/**
 * `ast-grep run`: consecutive `path:line:` records of one file are listed
 * under one header, as for grep (every match line, line number and order
 * kept); `--json` output keeps one match object per line, without the
 * indentation inside it.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const output = searchOutput(input.command)
  if (output === undefined || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  return output === 'json' ? compactNestedJson(input.stdout) : groupRecords(input.stdout, SEARCH_RECORDS)
}

export const astGrepFilter: EconomyFilter = {
  name: 'ast-grep', transformation: 'lossless-formatting', projectMapped,
  commands: command => searchOutput(command) !== undefined,
  project: input => projectMapped(input)?.text,
}
