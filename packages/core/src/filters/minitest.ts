import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'
import { previewPositiveRows } from './test-preview.ts'

/** A passing test in verbose mode (`-v`, `TESTOPTS=-v`): `CalcTest#test_add = 0.00 s = .`. */
const PASSED = /^\S+#\S+ = \d+\.\d+ s = \.$/u
/** The run's closing totals (`tests` with minitest-reporters). */
const SUMMARY = /^\d+ (?:runs|tests), \d+ assertions, \d+ failures, \d+ errors, \d+ skips$/u

function isMinitestRun(command: string): boolean {
  const argv = toolArgv(command)
  return ['rake', 'rails'].includes(argv?.[0] ?? '') && /^test(?::\S+)?$/u.test(argv![1] ?? '')
}

/**
 * Minitest through `rake test` or `rails test`, verbose: runs of six or more
 * passing-test rows keep their first and last row and count the rest. Every
 * failing, erroring or skipped row, every failure and error report with its
 * location and backtrace, test output and the totals stay. The default dots
 * line passes through.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isMinitestRun(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  if (!sourceLines(input.stdout).some(line => SUMMARY.test(line.text))) return undefined
  return previewPositiveRows(input.stdout, text => PASSED.test(text) && !PROBLEM.test(text))
}

export const minitestFilter: EconomyFilter = {
  name: 'minitest', transformation: 'preview', commands: isMinitestRun, projectMapped,
  project: input => projectMapped(input)?.text,
}
