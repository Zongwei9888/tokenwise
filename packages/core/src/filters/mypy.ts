import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { groupFileRows } from './file-groups.ts'
import { NOT_PLAIN } from './noise.ts'

/** `app/models.py:12: error: …`, with `--show-column-numbers` (`12:5`) or `--show-error-end` (`12:5:12:9`). */
const ROW = /^(\S[^:]*\.pyi?):(\d+(?::\d+){0,3}): (?:error|warning|note): /u
const LOCATION = /^(\d+(?::\d+){0,3}): (note: .+)$/u
/** mypy's closing line: a run that did not reach it is not a report this filter reads. */
const SUMMARY = /^(?:Found \d+ errors? in \d+ files? \(checked \d+ source files?\)|Success: no issues found in \d+ source files?)$/u

function isMypy(command: string): boolean {
  const argv = toolArgv(command)
  if (argv === undefined) return false
  return argv[0] === 'mypy' || /^python[\d.]*$/u.test(argv[0] ?? '') && argv[1] === '-m' && argv[2] === 'mypy'
}

/**
 * mypy: runs of three or more consecutive diagnostics of one file are listed
 * under the file's name, each row keeping its line, severity, message and
 * error code; consecutive notes with the same text (the `annotation-unchecked`
 * hint, say) share one row that lists all their line numbers. Every
 * diagnostic, the summary and every other line stay.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isMypy(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  if (!sourceLines(input.stdout).some(line => SUMMARY.test(line.text))) return undefined
  return groupFileRows(input.stdout, {
    row: text => {
      const path = ROW.exec(text)?.[1]
      return path === undefined ? undefined : { path, rest: path.length + 1 }
    },
    mergeable: rest => {
      const match = LOCATION.exec(rest)
      return match ? { location: match[1]!, body: match[2]! } : undefined
    },
    header: ['[diagnostics in ', ']\n'],
    label: 'mypy-file-group',
  })
}

export const mypyFilter: EconomyFilter = {
  name: 'mypy', transformation: 'lossless-formatting', commands: isMypy, projectMapped,
  project: input => projectMapped(input)?.text,
}
