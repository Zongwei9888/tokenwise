import { developerCommand } from '../command.ts'

/**
 * The argv of a JavaScript tool from `tools`, run directly, through `npx` or
 * `pnpm exec` (see `developerCommand`), or as `pnpm <tool>`, `yarn <tool>` or
 * `bunx <tool>`. `pnpm <name>` and `yarn <name>` run a package script of that
 * name when there is one, so every filter that uses this also checks that the
 * output is the tool's own report.
 */
export function jsToolArgv(command: string, tools: readonly string[]): readonly string[] | undefined {
  const argv = developerCommand(command)
  if (argv === undefined) return undefined
  const tool = ['pnpm', 'yarn', 'bunx'].includes(argv[0] ?? '') && tools.includes(argv[1] ?? '') ? argv.slice(1) : argv
  return tools.includes(tool[0] ?? '') ? tool : undefined
}
