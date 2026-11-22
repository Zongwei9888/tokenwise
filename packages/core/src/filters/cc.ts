import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN } from './noise.ts'

/** `gcc`, `g++`, `cc`, `c++`, `clang`, `clang++`, versioned (`gcc-13`, `clang++-17`) or cross (`arm-none-eabi-gcc`). */
const COMPILER = /^(?:[a-z0-9_]+(?:-[a-z0-9_.]+)*-)?(?:gcc|g\+\+|cc|c\+\+|clang|clang\+\+)(?:-\d+(?:\.\d+)*)?$/u
/** Flags that make the compiler print something other than diagnostics: preprocessed source, dependencies, versions, its own configuration. */
const OTHER_OUTPUT = /^(?:-E|-M|-MM|-###|--version|--help|-dump\w*|-print-.*|-fdiagnostics-format=.*)$/u
/** A diagnostic's first line: `m.c:5:11: warning: format specifies …`, `o.cpp:3:6: note: candidate …`. */
const HEADLINE = /^[^\s:][^:]*:\d+(?::\d+)?: (?:warning|error|note|fatal error|remark): .+$/u
/** Its source excerpt (GCC 9+, Clang 17+): `    5 |   LOG_INT(a);`, `      |   ~~~~^~`, `  +++ |+#include <stdio.h>`. */
const EXCERPT = /^ *(?:\d+ |\+\+\+ )?\|(?:[ +].*)?$/u

export function compilerCommand(command: string): boolean {
  const argv = toolArgv(command)
  return argv !== undefined && COMPILER.test(argv[0] ?? '') && !argv.slice(1).some(arg => OTHER_OUTPUT.test(arg))
}

const note = (count: number) => count === 1 ? '[source excerpt: same as above]\n' : `[source excerpts of these ${count}: same as above]\n`

/** A diagnostic: its first line and the excerpt lines under it (`start` up to `end`). */
interface Block { readonly start: number; readonly end: number; readonly repeat: boolean }

/**
 * C and C++ compiler diagnostics (GCC and Clang): a diagnostic whose first
 * line and source excerpt are identical to one printed earlier (a macro's
 * "expanded from" note at every use, the same candidate list for every
 * failing call, a header's warning once per file) keeps its first line, and
 * its excerpt becomes a note; one note covers a run of them, and only when
 * the note is shorter. Every diagnostic line, include chain, `In function`
 * line, linker message and count stays, as does every excerpt seen for the
 * first time.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!compilerCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const items: (Block | number)[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length;) {
    if (!HEADLINE.test(lines[i]!.text)) { items.push(i++); continue }
    let end = i + 1
    while (end < lines.length && EXCERPT.test(lines[end]!.text)) end++
    const text = lines.slice(i, end).map(line => line.text).join('\n')
    items.push({ start: i, end, repeat: end > i + 1 && seen.has(text) })
    seen.add(text)
    i = end
  }
  const builder = new ProjectionBuilder(input.stdout)
  let omitted = 0
  for (let k = 0; k < items.length;) {
    const item = items[k]!
    if (typeof item === 'number') { builder.keep(lines[item]!.start, lines[item]!.end); k++; continue }
    let stop = k
    while (stop < items.length && typeof items[stop] !== 'number' && (items[stop] as Block).repeat) stop++
    const run = items.slice(k, stop) as Block[]
    const excerptLength = run.reduce((sum, block) => sum + lines[block.end - 1]!.end - lines[block.start]!.end, 0)
    if (run.length > 0 && excerptLength > note(run.length).length) {
      for (const block of run) builder.keep(lines[block.start]!.start, lines[block.start]!.end)
      builder.generate(note(run.length), 'cc-repeated-excerpts')
      omitted += run.length
      k = stop
      continue
    }
    // A diagnostic seen for the first time, or repeats whose excerpts are shorter than a note.
    for (const block of run.length > 0 ? run : [item]) builder.keep(lines[block.start]!.start, lines[block.end - 1]!.end)
    k = Math.max(stop, k + 1)
  }
  return omitted > 0 ? builder.finish() : undefined
}

export const ccFilter: EconomyFilter = {
  name: 'cc', transformation: 'diagnostic-deduplication', commands: compilerCommand, projectMapped, stderr: true,
  project: input => projectMapped(input)?.text,
}
