import { developerCommand } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { jsToolArgv } from './js-tool.ts'
import { foldRuns, NOT_PLAIN } from './noise.ts'

/** Vitest's closing summary: ` Test Files  1 failed | 6 passed (7)` and `      Tests  2 failed | 19 passed (21)`. */
const VITEST_FILES = /^ Test Files {2}.*\(\d+\)$/u
const VITEST_TESTS = /^ {6}Tests {2}.*\(\d+\)$/u
/** Jest's closing summary: `Test Suites: 1 failed, 5 passed, 6 total` and `Tests:       1 failed, 17 passed, 18 total`. */
const JEST_SUITES = /^Test Suites: .*\b\d+ total$/u
const JEST_TESTS = /^Tests: +.*\b\d+ total$/u

/** A passing test row: Vitest ` ✓ src/a.test.ts > suite > name 1ms`, Jest `    ✓ name (2 ms)` (`√` on Windows). */
const PASSED_TEST = /^ +[✓✔√] \S/u
/** A passing file row: Vitest ` ✓ src/a.test.ts (5 tests) 3ms`, Jest `PASS src/a.test.js` or `PASS src/a.test.js (5.1 s)`. */
const PASSED_FILE = /^(?: [✓✔] \S.* \(\d+ tests?\)(?: \d+(?:\.\d+)?m?s)?|PASS \S.*)$/u

function testCommand(command: string): boolean {
  const tool = jsToolArgv(command, ['jest', 'vitest'])
  // A watch session never finishes its report; other reporters fail the summary check below.
  if (tool) return tool[1] !== 'watch' && tool[1] !== 'dev' && !tool.some(arg => /^(?:--watch|--watchAll|-w)(?:=(?!false$)|$)/u.test(arg))
  // A package test script: the output itself must then be Jest's or Vitest's report.
  const argv = developerCommand(command) ?? []
  return ['npm', 'pnpm', 'yarn', 'bun'].includes(argv[0] ?? '') && (argv[1] === 'test' || argv[1] === 'run' && argv[2] === 'test')
}

/**
 * Jest and Vitest default and verbose reporters: runs of three or more
 * passing rows (a test file that passed, or a test that passed) become one
 * counted note. Every failing or skipped row, failure block, code frame,
 * console output, the summary and the timing stay verbatim; a passing row
 * whose name mentions a problem is kept too.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!testCommand(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout).map(line => line.text)
  const vitest = lines.some(text => VITEST_FILES.test(text)) && lines.some(text => VITEST_TESTS.test(text))
  const jest = lines.some(text => JEST_SUITES.test(text)) && lines.some(text => JEST_TESTS.test(text))
  if (vitest === jest) return undefined
  return foldRuns(input.stdout, {
    label: 'js-test-passing',
    kind: text => PASSED_FILE.test(text) ? 'file' : PASSED_TEST.test(text) ? 'test' : undefined,
    note: (count, kind) => `[${count} passing ${kind === 'file' ? 'test files' : 'tests'} omitted]\n`,
  })
}

export const jsTestFilter: EconomyFilter = {
  name: 'js-test', transformation: 'noise-removal', projectMapped, commands: testCommand, stderr: true,
  project: input => projectMapped(input)?.text,
}
