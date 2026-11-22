import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { foldMarked } from './build-folds.ts'
import { NOT_PLAIN, commandIs } from './noise.ts'

/** `==> jason`: Mix starts compiling a dependency (or an umbrella app). */
const HEADER = /^==> ([\w.-]+)$/u
/** What a dependency compiled without messages prints: Mix's file count, rebar3's steps. */
const QUIET = /^(?:Compiling \d+ files? \(\.[\w, .]+\)|===> Analyzing applications\.\.\.|===> Compiling [\w.-]+)$/u

const mixCompileCommand = (command: string) => commandIs(command, ['mix'], [['compile'], ['deps.compile']])

/**
 * `mix compile` / `mix deps.compile`: a dependency section (`==> name`,
 * `Compiling N files (.ex)`, `Generated name app`) with nothing else in it
 * is folded; a run of them becomes one note that counts them. A section with
 * any warning or other line in it stays whole, and so does the project's own
 * compile output, every warning and error with its location, and any line
 * not recognized.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!mixCompileCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const marks: (string | undefined)[] = lines.map(() => undefined)
  for (let i = 0; i < lines.length; i++) {
    const name = HEADER.exec(lines[i]!.text)?.[1]
    if (name === undefined) continue
    let end = i + 1
    while (end < lines.length && QUIET.test(lines[end]!.text)) end++
    // The section ends with its own `Generated` line, or right where the next one starts.
    if (lines[end]?.text === `Generated ${name} app`) end++
    else if (end >= lines.length || !HEADER.test(lines[end]!.text)) continue
    for (let j = i; j < end; j++) marks[j] = 'dependency'
    i = end - 1
  }
  return foldMarked(input.stdout, lines, marks, {
    label: 'mix-quiet-dependencies',
    note: (count, _kind, texts) => {
      const apps = texts.filter(text => HEADER.test(text)).length
      return `[${apps} ${apps === 1 ? 'app' : 'apps'} (dependencies or umbrella children) compiled with no messages: ${count} lines omitted]\n`
    },
  })
}

export const mixCompileFilter: EconomyFilter = {
  name: 'mix-compile', transformation: 'noise-removal', commands: mixCompileCommand, projectMapped,
  project: input => projectMapped(input)?.text,
}
