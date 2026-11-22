import { toolArgv } from '../command.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { afterGlobalOptions } from './containers.ts'
import { NOT_PLAIN } from './noise.ts'
import { capitalHeader, compactAlignedTables } from './table-layout.ts'

function pulumiCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'pulumi') return false
  return ['preview', 'up', 'update', 'destroy', 'refresh', 'stack'].includes(afterGlobalOptions(argv, ['-C', '--cwd'])[0] ?? '')
}

/** The resource table's header: `Type  Name  Plan` (preview) or `Status` (up, destroy, refresh), maybe `Info`; or a capital one (`stack ls`, stack outputs and resources). */
function pulumiHeader(cells: readonly string[]): boolean {
  if (cells[0] === 'Type') return cells[1] === 'Name' && ['Plan', 'Status'].includes(cells[2] ?? '') && cells.length <= 4 && (cells[3] ?? 'Info') === 'Info'
  return capitalHeader(cells)
}

function projectPulumi(input: FilterInput): MappedProjection | undefined {
  if (!pulumiCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  return compactAlignedTables(input.stdout, { header: pulumiHeader })
}

/**
 * pulumi preview, up, destroy, refresh and stack: the resource table (and the
 * stack, output and resource listings of `pulumi stack`) have their column
 * padding replaced by one tab between cells. The change symbol before each
 * row, the tree prefixes, every resource, status and value stay; a row whose
 * status or info may report a problem keeps its layout, and every line
 * outside a table (the update link, Outputs, Resources, Diagnostics,
 * Duration) stays verbatim.
 */
export const pulumiFilter: EconomyFilter = {
  name: 'pulumi', transformation: 'lossless-formatting', commands: pulumiCommand,
  projectMapped: projectPulumi, project: input => projectPulumi(input)?.text,
}
