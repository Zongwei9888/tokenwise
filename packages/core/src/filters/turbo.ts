import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { jsToolArgv } from './js-tool.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** The run summary: ` Tasks:    3 successful, 3 total`. */
const SUMMARY = /^ Tasks: +\d+ successful, \d+ total$/u
/** A task's first line, which names its prefix: `web:build: cache miss, executing 1d8f8e7e5d7a1b2c`. */
const CACHE_STATUS = /^(@?[\w.-]+(?:\/[\w.-]+)?:[\w.:-]+?): cache (?:hit|miss|bypass)\b/u
/** Subcommands that do not run tasks (`turbo build` is short for `turbo run build`). */
const NOT_RUN = new Set(['bin', 'boundaries', 'completion', 'config', 'daemon', 'devtools', 'docs', 'gen', 'generate', 'info', 'link', 'login',
  'logout', 'ls', 'prune', 'query', 'scan', 'telemetry', 'unlink', 'watch'])

function turboCommand(command: string): boolean {
  const argv = jsToolArgv(command, ['turbo'])
  if (argv === undefined) return false
  const sub = argv[1] ?? ''
  return sub === 'run' ? argv.length > 2 : sub !== '' && !sub.startsWith('-') && !NOT_RUN.has(sub)
}

/**
 * `turbo run`: Turborepo prefixes every line a task prints with its
 * `package:task: ` name. A run of consecutive lines of one task, long enough
 * that the prefixes cost more than a header, is listed under one header
 * naming the task, each line indented and
 * otherwise verbatim. Only prefixes that a task's cache-status line
 * announces are grouped. A line that may report a problem keeps its prefix
 * and ends the run; interleaved lines, the run header, the summary and every
 * other line stay as they are.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!turboCommand(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => SUMMARY.test(line.text))) return undefined
  const tasks = new Set(lines.flatMap(line => CACHE_STATUS.exec(line.text)?.[1] ?? []))
  // The longest announced prefix the line starts with (`web:build:css: …` is not `web:build`'s).
  const taskOf = (text: string): string | undefined => {
    if (PROBLEM.test(text)) return undefined
    let found: string | undefined
    for (const task of tasks) {
      if ((text === `${task}:` || text.startsWith(`${task}: `)) && task.length > (found?.length ?? -1)) found = task
    }
    return found
  }
  const builder = new ProjectionBuilder(input.stdout)
  let grouped = false
  for (let i = 0; i < lines.length;) {
    const task = taskOf(lines[i]!.text)
    let end = i + 1
    if (task !== undefined) while (end < lines.length && taskOf(lines[end]!.text) === task) end++
    const header = `[lines from ${task}; every line retained]\n`
    // Each line gives up its prefix for a two-space indent.
    if (task === undefined || (end - i) * task.length <= header.length) {
      for (; i < end; i++) builder.keep(lines[i]!.start, lines[i]!.end)
      continue
    }
    builder.generate(header, 'turbo-task-lines')
    for (; i < end; i++) {
      const line = lines[i]!
      // `web:build: text`, or `web:build: ` / `web:build:` for an empty line.
      const rest = Math.min(task.length + 2, line.text.length)
      if (rest < line.text.length) builder.generate('  ', 'turbo-task-lines')
      builder.keep(line.start + rest, line.end)
    }
    grouped = true
  }
  return grouped ? builder.finish() : undefined
}

export const turboFilter: EconomyFilter = {
  name: 'turbo', transformation: 'lossless-formatting', projectMapped, commands: turboCommand,
  project: input => projectMapped(input)?.text,
}
