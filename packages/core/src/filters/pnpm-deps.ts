import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** `pnpm <sub>` or `pnpm -r <sub>` / `pnpm --recursive <sub>`, with `sub` one of `names`. */
function pnpmSubcommand(command: string, names: readonly string[]): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'pnpm') return false
  const at = argv[1] === '-r' || argv[1] === '--recursive' ? 2 : 1
  return names.includes(argv[at] ?? '')
}

// ——— pnpm outdated ———

const TOP = /^┌─[─┬]*┐$/u
const ROW = /^│ .* │$/u
const SEPARATOR = /^├─[─┼]*┤$/u
const BOTTOM = /^└─[─┴]*┘$/u

const outdatedCommand = (command: string) => pnpmSubcommand(command, ['outdated'])

/**
 * `pnpm outdated` draws a rule between every two rows of its table. The rules
 * between package rows go (one count says how many) and the cell padding is
 * cut to one space; the borders, the header and its rule, and every package,
 * version and dependent stay. A table with a wrapped cell (two rows without a
 * rule between them) is left as it is.
 */
function projectOutdated(input: FilterInput): MappedProjection | undefined {
  if (!outdatedCommand(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const top = lines.findIndex(line => TOP.test(line.text))
  const bottom = lines.findIndex(line => BOTTOM.test(line.text))
  // top, header, rule, then row (rule row)* and the bottom border.
  if (top < 0 || bottom < top + 4 || (bottom - top) % 2 !== 0) return undefined
  for (let i = top + 1; i < bottom; i++) if (!((i - top) % 2 === 1 ? ROW : SEPARATOR).test(lines[i]!.text)) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let rules = 0
  for (const [index, line] of lines.entries()) {
    if (index <= top || index >= bottom || PROBLEM.test(line.text)) { builder.keep(line.start, line.end); continue }
    if ((index - top) % 2 === 0) {
      // The rule under the header stays; the ones between package rows go.
      if (index === top + 2) builder.keep(line.start, line.end)
      else rules++
      continue
    }
    let start = line.start
    for (const match of line.text.matchAll(/ {2,}/gu)) {
      const at = line.start + match.index
      builder.keep(start, at + 1)
      start = at + match[0].length
    }
    builder.keep(start, line.end)
  }
  if (rules === 0) return undefined
  // After the whole output, so the table itself stays in one piece.
  builder.newline()
  builder.generate(`[${rules} rule lines between table rows omitted; cell padding removed]\n`, 'pnpm-outdated-rules')
  return builder.finish()
}

export const pnpmOutdatedFilter: EconomyFilter = {
  name: 'pnpm-outdated', transformation: 'lossless-formatting', projectMapped: projectOutdated, commands: outdatedCommand,
  project: input => projectOutdated(input)?.text,
}

// ——— pnpm list ———

const LEGEND = /^Legend: production dependency, optional only, dev only$/u
/** A dependency section header: `dependencies:`, `devDependencies:`, `optionalDependencies:`, `unsavedDependencies:`. */
const SECTION = /^(?:dependencies|devDependencies|optionalDependencies|unsavedDependencies):$/u
/** A tree row: guides (`│ ` or two spaces per level), then `├── `, `└── `, `├─┬ ` or `└─┬ ` and the package. */
const TREE = /^((?:│ | {2})*)[├└]─[─┬] (\S.*)$/u
/** The fewest repeated dependency lines worth a note. */
const MIN_REPEAT = 3

const listCommand = (command: string) => pnpmSubcommand(command, ['list', 'ls', 'll', 'la'])

/**
 * `pnpm list --depth N` prints the whole dependency tree of a package each
 * time the package appears. When a package's dependency lines are identical
 * to those printed for it earlier (and there are at least three), they become
 * one note saying so; the package line itself stays. Every package the tree
 * names first, every header, section and unknown line stays verbatim.
 */
function projectList(input: FilterInput): MappedProjection | undefined {
  if (!listCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => LEGEND.test(line.text))) return undefined
  // Depth of each line in a dependency tree: 0 for a direct dependency, -1 outside a tree.
  const depth: number[] = []
  const key: string[] = []
  let inSection = false
  for (const line of lines) {
    const row = TREE.exec(line.text)
    if (SECTION.test(line.text)) inSection = true
    else if (line.text.trim() === '') inSection = false
    // A package is its name and version; a `peer` or `(dev)` mark does not change its dependencies.
    if (inSection && row) { depth.push(row[1]!.length / 2 + 1); key.push(row[2]!.split(' ').slice(0, 2).join(' ')) }
    else if (inSection && !SECTION.test(line.text) && /^\S/u.test(line.text)) { depth.push(0); key.push(line.text.split(' ').slice(0, 2).join(' ')) }
    else { depth.push(-1); key.push('') }
  }
  const builder = new ProjectionBuilder(input.stdout)
  const shown = new Set<string>()
  let omitted = 0
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    builder.keep(line.start, line.end)
    const d = depth[i]!
    let end = i + 1
    if (d >= 0) while (end < lines.length && depth[end]! > d) end++
    const count = end - i - 1
    if (d < 0 || count < MIN_REPEAT) { i++; continue }
    const below = lines.slice(i + 1, end)
    const signature = [key[i], ...below.map(row => row.text.slice(2 * d))].join('\n')
    if (!shown.has(signature) || below.some(row => PROBLEM.test(row.text))) { shown.add(signature); i++; continue }
    // Keep the first row's guides (the ancestors' │ columns) so the note sits where the rows were.
    builder.keep(below[0]!.start, below[0]!.start + 2 * d)
    builder.generate(`[${count} dependency lines omitted: the same as under ${key[i]} above]\n`, 'pnpm-list-repeat')
    omitted += count
    i = end
  }
  return omitted > 0 ? builder.finish() : undefined
}

export const pnpmListFilter: EconomyFilter = {
  name: 'pnpm-list', transformation: 'lossless-formatting', projectMapped: projectList, commands: listCommand,
  project: input => projectList(input)?.text,
}
