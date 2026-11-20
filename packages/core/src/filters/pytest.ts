import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

const COUNTS = /^(?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?))(?:, \d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?))*$/

/** A final `| tail`/`| head` line window: the output is a slice of the run, and the exit status is the window's. */
const WINDOW = /\s*\|\s*(?:tail|head)\s+(?:-n\s*)?-?\d+\s*$/u
/** A verbose pytest row of a passing test (`-v`), and a progress row with nothing but passes and skips. */
const PASSED_ROW = /^\S+\.py::\S.*\s+PASSED\s+\[\s*\d+%\]$/u
const PASS_PROGRESS = /^(?:\S+\.py\s+)?[.s]+\s*(?:\[\s*\d+%\])?$/u
/**
 * The session header's environment lines (interpreter and pytest versions,
 * cache and root paths, config file, plugins, asyncio mode): the same in every
 * run of a project. `collected N items` and anything a plugin adds (a random
 * seed, a hypothesis profile) stay.
 */
const ENV_HEADER = /^(?:platform \S+ -- Python |cachedir: |rootdir: |configfile: |testpaths: |plugins: |asyncio: mode=)/u
/** Section rules (`=== FAILURES ===`, `--- Captured stdout ---`): what follows is diagnostics, kept verbatim. */
const SECTION = /^[-=]{3,}.*[-=]{3,}$/u

/** Remove only recognized progress; diagnostics and failure bodies remain verbatim. */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const window = WINDOW.test(input.command)
  const argv = toolArgv(window ? input.command.replace(WINDOW, '') : input.command)
  if (argv === undefined) return undefined
  const pytest = argv[0] === 'pytest'
    || (/^python\d*(?:\.\d+)*$/.test(argv[0] ?? '') && argv[1] === '-m' && argv[2] === 'pytest')
  if (!pytest || /[\u001b\0]/.test(input.stdout)) return undefined
  if (!window && ![0, 1].includes(input.exitCode)) return undefined
  // Live test output can look exactly like pytest progress; do not classify it.
  if (argv.some((arg, index) => /^-[^-]*s/.test(arg)
    || /^--capture=(?:no|tee-sys)$/.test(arg)
    || (arg === '--capture' && ['no', 'tee-sys'].includes(argv[index + 1] ?? '')))) return undefined
  const lines = sourceLines(input.stdout)
  if (window) return projectWindow(input.stdout, lines)
  const last = lines.findLast(line => line.text.trim() !== '')
  if (last === undefined) return undefined
  const summary = last.text.trim().replace(/^=+\s*/, '').replace(/\s*=+$/, '')
  const match = /^(.*?) in \d+(?:\.\d+)?s(?: \([^)]*\))?$/.exec(summary)
  if (match?.[1] === undefined || !COUNTS.test(match[1])) return undefined
  const hasFailure = /\b[1-9]\d* (?:failed|errors?)\b/.test(match[1])
  // Behind `| tee`, the exit status is tee's: the summary line alone tells the outcome.
  const teed = /\|\s*tee(?:\s+-a)?\s+\S+\s*$/u.test(input.command)
  if (!teed && ((input.exitCode === 0 && hasFailure) || (input.exitCode === 1 && !hasFailure))) return undefined
  // A log prefix from an unrelated command is not a pytest session.
  const first = lines.find(line => line.text.trim() !== '')
  if (first !== last && !/^=+ test session starts =+$/.test(first?.text.trim() ?? '')
    && !/^[.sFxXE]+\s*(?:\[\s*\d+%\])?$/.test(first?.text.trim() ?? '')) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let diagnostics = false
  // Right after the session banner, up to the first line that is not an environment line.
  let header = false
  for (const line of lines) {
    // Keep the original summary, including elapsed time and every status count.
    if (line === last) {
      builder.keep(line.start, line.end)
      continue
    }
    const value = line.text.trim()
    const banner = /^=+ test session starts =+$/.test(value)
    header = banner || (header && ENV_HEADER.test(line.text))
    if (header && !banner) continue
    // PASSES and captured-output sections can also contain progress-looking text.
    if (/^[-=]{3,}.*[-=]{3,}$/.test(value) && !banner) diagnostics = true
    if (!diagnostics && (banner
      || /^(?:\S+\.py\s+)?[.s]+\s*(?:\[\s*\d+%\])?$/.test(value)
      || /^\S+\.py::\S+\s+PASSED\s+\[\s*\d+%\]$/.test(value)
      || value === '')) continue
    builder.keep(line.start, line.end)
  }
  return builder.finish()
}

/**
 * A `| tail` or `| head` slice of a run: no header or summary to check, so
 * only rows that are unambiguous passes (verbose `PASSED [ NN%]` rows, all-pass
 * progress rows) before the first section rule go, and only when there are at
 * least five. Everything from a section rule on is diagnostics, kept verbatim.
 */
function projectWindow(raw: string, lines: readonly SourceLine[]): MappedProjection | undefined {
  const builder = new ProjectionBuilder(raw)
  let removed = 0
  let diagnostics = false
  for (const line of lines) {
    const value = line.text.trim()
    if (SECTION.test(value)) diagnostics = true
    if (!diagnostics && (PASSED_ROW.test(value) || (PASS_PROGRESS.test(value) && value !== ''))) { removed++; continue }
    builder.keep(line.start, line.end)
  }
  if (removed < 5) return undefined
  // On a line of its own, also after output whose last line has no newline (Claude Code strips it).
  builder.newline()
  builder.generate(`[${removed} passing test rows omitted]\n`, 'pytest-passing-rows')
  return builder.finish()
}

export const pytestFilter: EconomyFilter = {
  name: 'pytest',
  transformation: 'noise-removal',
  project: input => projectMapped(input)?.text,
  projectMapped,
}
