import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'
import { groupPathRuns } from './path-list.ts'

// ——— git stash list ———

/** `stash@{0}: WIP on main: 1a2b3c4 subject`, `stash@{3}: On main: message`. */
const STASH = /^stash@\{(\d+)\}: (.+)$/u
/** A run of this many stashes with one description keeps the first and counts the rest. */
const STASH_RUN_MIN = 3

/** A bare `git stash list`; options pass to `git log` and change the layout. */
const stashListCommand = (command: string) => {
  const argv = toolArgv(command)
  return argv?.length === 3 && argv[0] === 'git' && argv[1] === 'stash' && argv[2] === 'list'
}

/**
 * `git stash list`: a run of three or more consecutive stashes with the same
 * description (stashing again and again on one commit gives `WIP on main:
 * <sha> <subject>` each time) keeps its first row whole and one note with the
 * indexes and count of the rest. Every other row stays verbatim; so does any
 * row that mentions a problem.
 */
function projectStashList(input: FilterInput): MappedProjection | undefined {
  if (!stashListCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const rows = lines.map(line => STASH.exec(line.text))
  // Every row is a stash, numbered from 0 in order: the whole list, as git prints it.
  if (rows.length === 0 || rows.some((row, i) => row === null || Number(row[1]) !== i)) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let folded = false
  for (let i = 0; i < rows.length;) {
    const description = rows[i]![2]!
    let end = i + 1
    if (!PROBLEM.test(description)) while (end < rows.length && rows[end]![2] === description) end++
    builder.keep(lines[i]!.start, lines[i]!.end)
    const note = `[${end - i - 1} stashes omitted (stash@{${i + 1}} to stash@{${end - 1}}): same description as stash@{${i}}]\n`
    // Short descriptions can cost less than the note: then the rows stay.
    if (end - i >= STASH_RUN_MIN && lines[end - 1]!.end - lines[i + 1]!.start > note.length) {
      builder.newline()
      builder.generate(note, 'git-stash-same-description')
      folded = true
    } else for (let j = i + 1; j < end; j++) builder.keep(lines[j]!.start, lines[j]!.end)
    i = end
  }
  return folded ? builder.finish() : undefined
}

export const gitStashListFilter: EconomyFilter = {
  name: 'git-stash-list', transformation: 'lossless-formatting', commands: stashListCommand,
  projectMapped: projectStashList, project: input => projectStashList(input)?.text,
}

// ——— git ls-tree ———

/** Options that leave `git ls-tree --name-only` a plain list of paths, one per line. */
const LS_TREE_PATH_OPTION = /^(?:--name-only|--name-status|--full-name|--full-tree|--abbrev(?:=\d+)?|-[rtd]+|--)$/u

/** `git ls-tree --name-only` (or its alias `--name-status`) with nothing else that changes the layout. */
const lsTreeCommand = (command: string) => {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'git' || argv[1] !== 'ls-tree') return false
  const args = argv.slice(2)
  return args.some(arg => arg === '--name-only' || arg === '--name-status')
    && args.every(arg => !arg.startsWith('-') || LS_TREE_PATH_OPTION.test(arg))
}

/**
 * `git ls-tree --name-only`: consecutive paths in one directory are listed
 * under one `[paths in <dir>/; original order]` header, as find's are. Every
 * path stays, in git's order. The default `<mode> <type> <object>\t<path>`
 * rows, `-l`, `-z` and `--format` pass through.
 */
function projectLsTree(input: FilterInput): MappedProjection | undefined {
  if (!lsTreeCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  // One path per line: no tab-separated object rows, no blank lines.
  if (sourceLines(input.stdout).some(line => line.text === '' || line.text.includes('\t'))) return undefined
  const grouped = groupPathRuns(input.stdout)
  // Short directory runs can cost more in headers than they save.
  return grouped !== undefined && grouped.text.length < input.stdout.length ? grouped : undefined
}

export const gitLsTreeFilter: EconomyFilter = {
  name: 'git-ls-tree', transformation: 'lossless-formatting', commands: lsTreeCommand,
  projectMapped: projectLsTree, project: input => projectLsTree(input)?.text,
}
