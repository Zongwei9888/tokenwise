import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/** A line that may report a problem: never removed or folded. */
const DIAGNOSTIC = /error|warn|fail|fatal|panic|exception|denied|refused|timeout|timed out|killed|oom|crashloop|backoff|unhealthy|cannot|could not|unable/iu

// ——— docker build (BuildKit plain progress) ———

/** `#<step> <rest>`, the shape of every BuildKit plain progress line. */
const STEP = /^#(\d+) (.*)$/u
/** Bookkeeping rows of a step: timing, transfers, resolution, layer download and export progress. */
const PROGRESS = [
  /^DONE \d+(?:\.\d+)?s$/u,
  /^building with ".*" instance using \S+ driver$/u,
  /^transferring (?:dockerfile|context): .*$/u,
  /^resolve \S+ (?:\d+(?:\.\d+)?s )?done$/u,
  /^sha256:[0-9a-f]{64} \d+(?:\.\d+)?[kMG]?B \/ \d+(?:\.\d+)?[kMG]?B(?: \d+(?:\.\d+)?s)?(?: done)?$/u,
  /^extracting sha256:[0-9a-f]{64}(?: \d+(?:\.\d+)?s)?(?: done)?$/u,
  /^(?:exporting layers|exporting manifest(?: list)? sha256:[0-9a-f]{64}|exporting config sha256:[0-9a-f]{64}|exporting attestation manifest sha256:[0-9a-f]{64}|preparing layers for inline cache)(?: \d+(?:\.\d+)?s)?(?: done)?$/u,
]
/** The steps BuildKit runs to read the Dockerfile, the context and the base image metadata. */
const INTERNAL = /^\[internal\] (?:load build definition from .+|load metadata for .+|load \.dockerignore|load build context)$/u

function buildCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'docker') return false
  const at = argv[1] === 'build' ? 2 : (argv[1] === 'buildx' || argv[1] === 'image') && argv[2] === 'build' ? 3 : 0
  if (at === 0) return false
  const args = argv.slice(at)
  // Quiet builds print only an image ID; a TTY progress display is not plain text.
  return !args.some((arg, i) => arg === '-q' || arg === '--quiet' || /^--progress=(?!plain$)/u.test(arg)
    || (arg === '--progress' && args[i + 1] !== 'plain'))
}

/**
 * BuildKit plain progress: drop step timing (`DONE 0.3s`), transfers, image
 * resolution, layer download and extraction rows, and the internal steps that
 * load the Dockerfile and context. Every build step header, every line a step
 * printed (`#7 0.239 …`), CACHED and ERROR rows, the image ID and name, and any
 * line outside the progress format stay verbatim. A step with a problem keeps
 * all of its lines.
 */
function projectBuild(input: FilterInput): MappedProjection | undefined {
  if (!buildCommand(input.command) || /[\u001b\0]|\r(?!\n)/u.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const first = lines.find(line => line.text !== '')
  if (first === undefined || !STEP.test(first.text)) return undefined
  // Steps whose lines mention a problem, and the internal steps (by number).
  const troubled = new Set<string>()
  const internal = new Set<string>()
  for (const line of lines) {
    const step = STEP.exec(line.text)
    if (!step) continue
    if (DIAGNOSTIC.test(step[2]!) && !/^(?:DONE|CACHED)\b/u.test(step[2]!)) troubled.add(step[1]!)
    if (INTERNAL.test(step[2]!)) internal.add(step[1]!)
  }
  const builder = new ProjectionBuilder(input.stdout)
  let omitted = 0
  for (const line of lines) {
    const step = STEP.exec(line.text)
    const drop = line.text === ''
      || (step !== null && !troubled.has(step[1]!) && !DIAGNOSTIC.test(line.text)
        && (internal.has(step[1]!) || PROGRESS.some(pattern => pattern.test(step[2]!))))
    if (drop) { if (line.text !== '') omitted++; continue }
    builder.keep(line.start, line.end)
  }
  if (omitted === 0) return undefined
  builder.newline()
  builder.generate(`[${omitted} build progress lines omitted]\n`, 'docker-build-progress')
  return builder.finish()
}

export const dockerBuildFilter: EconomyFilter = {
  name: 'docker-build', transformation: 'noise-removal', projectMapped: projectBuild, commands: buildCommand, stderr: true,
  project: input => projectBuild(input)?.text,
}

// ——— container logs ———

/** A leading RFC 3339 timestamp, as `docker logs --timestamps` and `kubectl logs --timestamps` print it. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) /u

function logsCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (!argv) return false
  if (argv[0] === 'kubectl') return argv[1] === 'logs'
  if (argv[0] === 'docker-compose') return argv[1] === 'logs'
  if (argv[0] !== 'docker') return false
  return argv[1] === 'logs' || ((argv[1] === 'container' || argv[1] === 'compose') && argv[2] === 'logs')
}

/**
 * Container logs: a run of three or more consecutive lines that are identical,
 * or identical but for a leading RFC 3339 timestamp, keeps its first line (and,
 * with timestamps, its last) and a count of the lines in between. Every
 * distinct line stays in order; a line that may report a problem is never
 * folded.
 */
function projectLogs(input: FilterInput): MappedProjection | undefined {
  if (!logsCommand(input.command) || input.exitCode !== 0 || /[\u001b\0]|\r(?!\n)/u.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const key = (text: string) => text.replace(TIMESTAMP, '')
  const builder = new ProjectionBuilder(input.stdout)
  let folded = false
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!
    let end = i + 1
    const value = key(first.text)
    if (value.trim() !== '' && !DIAGNOSTIC.test(value)) while (end < lines.length && key(lines[end]!.text) === value) end++
    const run = end - i
    if (run < 3) { builder.keep(first.start, first.end); i++; continue }
    const last = lines[end - 1]!
    const exact = last.text === first.text
    builder.keep(first.start, first.end)
    builder.newline()
    builder.generate(exact ? `[${run - 1} identical lines omitted]\n` : `[${run - 2} repeated lines omitted]\n`, 'repeated-log-lines')
    if (!exact) builder.keep(last.start, last.end)
    folded = true
    i = end
  }
  return folded ? builder.finish() : undefined
}

export const containerLogsFilter: EconomyFilter = {
  name: 'container-logs', transformation: 'preview', projectMapped: projectLogs, commands: logsCommand,
  project: input => projectLogs(input)?.text,
}
