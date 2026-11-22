import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { groupFileRows } from './file-groups.ts'
import { NOT_PLAIN } from './noise.ts'

/** A concise (or pre-0.5 `text`) row: `app/models.py:2:8: F401 [*] …`. */
const ROW = /^(\S[^:]*):\d+:\d+: \S/u
const SUMMARY = /^(?:Found \d+ errors?\b|All checks passed!$)/u

function isRuffCheck(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'ruff' || argv[1] !== 'check') return false
  // Other layouts, diffs, statistics and watch mode are not this report.
  const formats = argv.flatMap((arg, i) => arg === '--output-format' ? [argv[i + 1]] : arg.startsWith('--output-format=') ? [arg.slice(16)] : [])
  return formats.every(format => format === 'full' || format === 'concise')
    && !argv.some(arg => ['--diff', '--statistics', '--watch', '-w', '--show-settings', '--show-files'].includes(arg))
}

/**
 * `ruff check` text output: runs of three or more consecutive concise rows of
 * one file are listed under the file's name, each row keeping its line,
 * column, code, fix mark and message. The full format (the default) has no
 * such runs: each diagnostic is followed by its code frame and fix, and it
 * passes through. Summaries and every other line stay.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isRuffCheck(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  if (!sourceLines(input.stdout).some(line => SUMMARY.test(line.text))) return undefined
  return groupFileRows(input.stdout, {
    row: text => {
      const path = ROW.exec(text)?.[1]
      return path === undefined ? undefined : { path, rest: path.length + 1 }
    },
    header: ['[diagnostics in ', ']\n'],
    label: 'ruff-file-group',
  })
}

export const ruffTextFilter: EconomyFilter = {
  name: 'ruff-text', transformation: 'lossless-formatting', commands: isRuffCheck, projectMapped,
  project: input => projectMapped(input)?.text,
}
