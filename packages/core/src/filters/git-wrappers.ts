import { toolArgv } from '../command.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, EconomyTransformation, FilterInput } from '../types.ts'
import { gitDiffFilter, gitShowFilter } from './git-diff.ts'
import { gitBlameFilter, gitLogFilter } from './git-log.ts'
import { gitStatusFilter } from './git-status.ts'
import { gitLsTreeFilter, gitStashListFilter } from './git-listings.ts'

/** A word as `literalCommand` reads it back: bare when plain, single-quoted otherwise; undefined if it holds a quote. */
const shellWord = (word: string) => /^[\w@%+=:,./-]+$/u.test(word) ? word : word.includes("'") ? undefined : `'${word}'`

/** The same command with `git` in place of the wrapper (`yadm diff -- .vimrc` → `git diff -- .vimrc`). */
function asGit(argv: readonly string[]): string | undefined {
  const words = ['git', ...argv.slice(1)].map(shellWord)
  return words.some(word => word === undefined) ? undefined : words.join(' ')
}

/**
 * A filter for a program that hands its arguments to git and prints git's
 * output as it is: the git filters read it as the git command it ran. Each
 * of them still checks the subcommand, its options and the output's layout.
 */
function gitWrapper(name: 'yadm' | 'gt', transformation: EconomyTransformation, commands: (argv: readonly string[]) => boolean, delegates: readonly EconomyFilter[]): EconomyFilter {
  const claims = (command: string) => { const argv = toolArgv(command); return argv !== undefined && commands(argv) }
  const projectMapped = (input: FilterInput): MappedProjection | undefined => {
    const argv = toolArgv(input.command)
    const command = argv !== undefined && commands(argv) ? asGit(argv) : undefined
    if (command === undefined) return undefined
    for (const filter of delegates) {
      const projection = filter.projectMapped({ ...input, command })
      // A git filter may hand back its input unchanged (nothing previewed): that is no projection here.
      if (projection !== undefined && projection.text !== input.stdout) return projection
    }
    return undefined
  }
  return { name, transformation, commands: claims, projectMapped, project: input => projectMapped(input)?.text }
}

/** git subcommands that print what a git filter reads. */
const YADM_GIT = new Set(['status', 'diff', 'show', 'log', 'blame', 'ls-tree'])

/**
 * yadm (dotfiles in a bare git repository): `yadm status`, `diff`, `show`,
 * `log`, `blame`, `stash list` and `ls-tree` run git and print its output,
 * so git-status, git-diff, git-show, git-log, git-blame, git-stash-list and
 * git-ls-tree read them, under the same rules. yadm's own commands pass through.
 */
export const yadmFilter = gitWrapper('yadm', 'preview',
  argv => argv[0] === 'yadm' && (YADM_GIT.has(argv[1] ?? '') || argv[1] === 'stash' && argv[2] === 'list'),
  [gitStatusFilter, gitDiffFilter, gitShowFilter, gitLogFilter, gitBlameFilter, gitStashListFilter, gitLsTreeFilter])

/**
 * Graphite: `gt status` is not one of gt's own commands, so gt passes it to
 * git; git-status reads the output. `gt log` and gt's other commands pass through.
 */
export const gtFilter = gitWrapper('gt', 'noise-removal', argv => argv[0] === 'gt' && argv[1] === 'status', [gitStatusFilter])
