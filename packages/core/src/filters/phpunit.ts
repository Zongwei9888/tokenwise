import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM, foldRuns } from './noise.ts'
import { previewPositiveRows } from './test-preview.ts'

/** A progress row where every test passed: `......  63 / 110 ( 57%)`. Rows with F, E, W, R, S, I, D or N stay. */
const PASSING_PROGRESS = /^\.+ +\d+ \/ \d+ \( *\d+%\)$/u
/** A passing TestDox row: ` ✔ Email validation`. */
const TESTDOX_PASSED = /^ +✔ \S/u
const SUMMARY = /^(?:OK \(\d+ tests?, \d+ assertions?\)|OK, but .+!|Tests: \d+, Assertions: \d+.*|FAILURES!|ERRORS!|No tests executed!)$/u

function isPhpunit(command: string): boolean {
  const argv = toolArgv(command)
  return argv?.[0] === 'phpunit' || argv?.[0] === 'php' && /(?:^|\/)phpunit$/u.test(argv[1] ?? '')
}

/**
 * PHPUnit: runs of three or more progress rows in which every test passed
 * become one counted note; with `--testdox`, runs of six or more passing rows
 * keep their first and last row and count the rest. Progress rows with any
 * other status, every failure, error, warning, deprecation and risky report,
 * the header and the totals stay.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isPhpunit(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => SUMMARY.test(line.text))) return undefined
  if (lines.some(line => TESTDOX_PASSED.test(line.text))) return previewPositiveRows(input.stdout, text => TESTDOX_PASSED.test(text) && !PROBLEM.test(text))
  return foldRuns(input.stdout, {
    kind: text => PASSING_PROGRESS.test(text) ? 'progress' : undefined,
    note: count => `[${count} progress rows of passing tests omitted]\n`,
    label: 'phpunit-progress',
  })
}

export const phpunitFilter: EconomyFilter = {
  name: 'phpunit', transformation: 'noise-removal', commands: isPhpunit, projectMapped,
  project: input => projectMapped(input)?.text,
}
