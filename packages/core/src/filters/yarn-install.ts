import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

const HEADER = /^yarn (?:add|install|upgrade|remove) v1\.\d+\.\d+$/u
const TREE_ROW = /^[├└]─ \S+@\S+$/u
const DONE = /^Done in \d+(?:\.\d+)?s\.$/u

/**
 * Successful Yarn 1 `add`/`install`/`upgrade`/`remove`: the `info All
 * dependencies` tree (every installed package, after the direct ones were
 * listed) becomes a counted note. The direct-dependency list, every warning,
 * step and success line, and the final timing stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const argv = toolArgv(input.command)
  if (argv?.[0] !== 'yarn' || !(argv.length === 1 || ['add', 'install', 'upgrade', 'remove'].includes(argv[1] ?? ''))
    || input.exitCode !== 0 || /[\u001b\0]|\r(?!\n)/u.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const last = lines.findLast(line => line.text.trim() !== '')
  if (!HEADER.test(lines[0]?.text ?? '') || !DONE.test(last?.text ?? '')) return undefined
  const tree = lines.findIndex(line => line.text === 'info All dependencies')
  if (tree < 0) return undefined
  let end = tree + 1
  while (end < lines.length && TREE_ROW.test(lines[end]!.text)) end++
  if (end - tree - 1 < 3) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  for (let i = 0; i <= tree; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  const direct = lines.slice(0, tree).some(line => line.text === 'info Direct dependencies')
  builder.generate(`[${end - tree - 1} installed packages omitted${direct ? '; the direct dependencies are listed above' : ''}]\n`, 'yarn-dependency-tree')
  for (let i = end; i < lines.length; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  return builder.finish()
}

export const yarnInstallFilter: EconomyFilter = {
  commands: command => {
    const argv = toolArgv(command)
    return argv?.[0] === 'yarn' && (argv.length === 1 || ['add', 'install', 'upgrade', 'remove'].includes(argv[1] ?? ''))
  },
  name: 'yarn-install', transformation: 'noise-removal',
  project: input => projectMapped(input)?.text, projectMapped,
}
