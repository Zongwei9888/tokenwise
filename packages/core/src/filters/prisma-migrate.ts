import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { jsToolArgv } from './js-tool.ts'
import { NOT_PLAIN } from './noise.ts'

/** ``Applying migration `20240101000000_init` ``, one per migration the engine applies. */
const APPLYING = /^Applying migration `([^`\s]+)`$/u
/** The summary tree's rows: `  └─ 20240101000000_init/` and its `    └─ migration.sql`. */
const FOLDER = /^ {2}└─ (\S+)\/$/u
const FILE = '    └─ migration.sql'

function migrateCommand(command: string): boolean {
  const argv = jsToolArgv(command, ['prisma'])
  return argv?.[1] === 'migrate' && ['dev', 'deploy', 'reset'].includes(argv[2] ?? '')
}

/**
 * `prisma migrate dev|deploy|reset` names each migration twice: as it applies
 * it (``Applying migration `…` ``) and again in a `migrations/` tree after
 * "The following migration(s) have been applied". When the tree lists exactly
 * the applied migrations, in order, each with only its migration.sql, the
 * tree becomes one counted note. Every Applying line, warning, prompt,
 * summary and generator line stays.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!migrateCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const applied = lines.flatMap(line => APPLYING.exec(line.text)?.[1] ?? [])
  const root = lines.findIndex(line => line.text === 'migrations/')
  if (root < 0 || applied.length < 2) return undefined
  for (const [n, id] of applied.entries()) {
    if (FOLDER.exec(lines[root + 1 + 2 * n]?.text ?? '')?.[1] !== id || lines[root + 2 + 2 * n]?.text !== FILE) return undefined
  }
  const end = root + 1 + 2 * applied.length
  // A longer tree (another file or folder) is not the applied list.
  if (FOLDER.test(lines[end]?.text ?? '') || /^ {4}└─ /u.test(lines[end]?.text ?? '')) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  for (const line of lines.slice(0, root)) builder.keep(line.start, line.end)
  builder.generate(`[migrations/ tree omitted: ${end - root} lines naming the ${applied.length} migrations applied above, each with its migration.sql]\n`, 'prisma-migration-tree')
  for (const line of lines.slice(end)) builder.keep(line.start, line.end)
  return builder.finish()
}

export const prismaMigrateFilter: EconomyFilter = {
  name: 'prisma-migrate', transformation: 'noise-removal', projectMapped, commands: migrateCommand,
  project: input => projectMapped(input)?.text,
}
