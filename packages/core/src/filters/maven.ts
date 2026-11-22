import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/** Artifact transfers: `Downloading from central: <url>`, `Downloaded from central: <url> (8.1 kB at 11 kB/s)`, Maven 3.0's `Downloading: <url>`, `Uploading to <repo>: <url>`. */
const TRANSFER = /^(?:\[INFO\] )?(?:Down|Up)load(?:ing|ed)(?: (?:from|to) [\w.-]+)?: [a-z][\w+.-]*:\/\/\S+(?: \([^)]*\))?$/u
/** Transfer progress: `Progress (1): 4.1/37 kB`, several transfers at once separated by `|`. */
const PROGRESS = /^Progress \(\d+\): .+$/u
/** The blank line Maven prints to clear a progress line. */
const ERASER = /^ +$/u
const MAVEN_LINE = /^\[(?:INFO|WARNING|ERROR)\]/u

/**
 * Maven: artifact download/upload lines and transfer progress become one
 * counted note per run of them. Plugin banners, compiler and test output,
 * every [WARNING] and [ERROR], stack traces, results and BUILD status stay
 * verbatim, and so does any line not recognized.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const argv = toolArgv(input.command)
  if (argv === undefined || !['mvn', 'mvnw'].includes(argv[0] ?? '') || /\0|\r(?!\n)/u.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => MAVEN_LINE.test(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let run = 0
  let total = 0
  let previousRemoved = false
  const flush = () => {
    if (run > 0) builder.newline()
    if (run > 0) builder.generate(`[${run} Maven download lines omitted]\n`, 'maven-transfer-lines')
    total += run
    run = 0
  }
  for (const line of lines) {
    const removed: boolean = TRANSFER.test(line.text) || PROGRESS.test(line.text) || (previousRemoved && ERASER.test(line.text))
    if (removed) run++
    else { flush(); builder.keep(line.start, line.end) }
    previousRemoved = removed
  }
  flush()
  return total >= 3 ? builder.finish() : undefined
}

export const mavenFilter: EconomyFilter = {
  commands: command => ['mvn', 'mvnw'].includes(toolArgv(command)?.[0] ?? ''),
  name: 'maven', transformation: 'noise-removal', projectMapped,
  project: input => projectMapped(input)?.text,
}
