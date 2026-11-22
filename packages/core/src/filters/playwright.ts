import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { jsToolArgv } from './js-tool.ts'
import { foldRuns, NOT_PLAIN } from './noise.ts'

/** `Running 16 tests using 2 workers`, the list reporter's first line. */
const START = /^Running \d+ tests? using \d+ workers?\b/u
/** The closing count: `  13 passed (1.3s)`, `  2 failed`. */
const SUMMARY = /^ {2}\d+ (?:passed|failed|flaky|skipped|did not run|interrupted)\b/u
/** A passing list-reporter row: `  ✓   1 [chromium] › tests/a.spec.ts:3:7 › suite › title (3ms)`; a retried pass is flaky and stays. */
const PASSED = /^ {2}[✓✔] +\d+ (?:\[[^\]]+\] › )?\S+:\d+:\d+ › (?!.*\(retry #\d+\)).+$/u

function playwrightCommand(command: string): boolean {
  return jsToolArgv(command, ['playwright'])?.[1] === 'test'
}

/**
 * `playwright test` with the list reporter: runs of three or more passing
 * test rows become one counted note. Failing, flaky, skipped and retried
 * rows, every error block, code frame and attachment, the slow-file notes
 * and the closing counts stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!playwrightCommand(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => START.test(line.text)) || !lines.some(line => SUMMARY.test(line.text))) return undefined
  return foldRuns(input.stdout, {
    label: 'playwright-passing',
    kind: text => PASSED.test(text) ? 'passed' : undefined,
    note: count => `[${count} passing tests omitted]\n`,
  })
}

export const playwrightFilter: EconomyFilter = {
  name: 'playwright', transformation: 'noise-removal', projectMapped, commands: playwrightCommand,
  project: input => projectMapped(input)?.text,
}
