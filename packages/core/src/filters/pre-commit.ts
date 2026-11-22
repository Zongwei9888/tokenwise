import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** `check yaml.........Passed`, `rst check....(no files to check)Skipped`, `flake8.....Failed`. */
const HOOK = /^\S.*?\.+(?:\([^)]*\))?(Passed|Skipped|Failed)$/u
/** Details pre-commit prints under a hook's row: `- hook id: …`, `- exit code: 1`, `- duration: 0.1s`. */
const DETAIL = /^- /u
/** First-run messages while hook environments are set up. */
const SETUP = /^\[INFO\] (?:Initializing environment for \S+\.|Installing environment for \S+\.|Once installed this environment will be reused\.|This may take a few minutes\.\.\.)$/u

function isPreCommitRun(command: string): boolean {
  const argv = toolArgv(command)
  return argv?.[0] === 'pre-commit' && (argv.length === 1 || argv[1] === 'run')
}

/**
 * `pre-commit run`: runs of three or more Passed or Skipped hook rows, and of
 * environment setup messages, become one counted note each. Every Failed
 * hook, its details and output, every row with details under it, and every
 * other line stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isPreCommitRun(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => HOOK.test(line.text))) return undefined
  const kinds = lines.map((line, i) => {
    if (PROBLEM.test(line.text)) return undefined
    if (SETUP.test(line.text)) return 'setup'
    const status = HOOK.exec(line.text)?.[1]
    // A row followed by details (verbose mode, or a hook that printed) keeps them attached.
    return status === 'Failed' || status === undefined || DETAIL.test(lines[i + 1]?.text ?? '') ? undefined : status
  })
  const builder = new ProjectionBuilder(input.stdout)
  let folded = 0
  // Passed and Skipped rows fold together; setup messages on their own.
  const group = (i: number) => kinds[i] === undefined ? undefined : kinds[i] === 'setup' ? 'setup' : 'hook'
  for (let i = 0; i < lines.length;) {
    const kind = group(i)
    let end = i
    while (kind !== undefined && end < lines.length && group(end) === kind) end++
    if (kind === undefined || end - i < 3) {
      for (const stop = Math.max(end, i + 1); i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
      continue
    }
    const run = kinds.slice(i, end)
    const passed = run.filter(k => k === 'Passed').length
    const note = kind === 'setup' ? `${end - i} hook environment setup lines`
      : passed === 0 || passed === end - i ? `${end - i} ${passed ? 'Passed' : 'Skipped'} hook rows`
      : `${end - i} hook rows (${passed} Passed, ${end - i - passed} Skipped)`
    builder.generate(`[${note} omitted]\n`, 'pre-commit-folded')
    folded += end - i
    i = end
  }
  return folded > 0 ? builder.finish() : undefined
}

export const preCommitFilter: EconomyFilter = {
  name: 'pre-commit', transformation: 'noise-removal', commands: isPreCommitRun, projectMapped,
  project: input => projectMapped(input)?.text,
}
