import { gitDiffFilter, gitShowFilter } from './git-diff.ts'
import { gitBlameFilter, gitLogFilter } from './git-log.ts'
import { grepFilter } from './grep.ts'
import { pytestFilter } from './pytest.ts'
import { tscFilter } from './tsc.ts'
import { eslintJsonFilter } from './eslint-json.ts'
import { viteBuildFilter } from './vite-build.ts'
import { pnpmInstallFilter } from './pnpm-install.ts'
import { ruffJsonFilter } from './ruff-json.ts'
import { goTestJsonFilter } from './go-test-json.ts'
import { gitStatusFilter } from './git-status.ts'
import { searchLayoutFilter } from './search-layout.ts'
import { pathListFilter } from './path-list.ts'
import { testProgressFilter } from './test-progress.ts'
import { lsListingFilter } from './ls-listing.ts'
import { testReportFilter } from './test-report.ts'
import { cargoBuildFilter } from './cargo-build.ts'
import { containerLogsFilter, dockerBuildFilter } from './docker.ts'
import { makeFilter } from './make.ts'
import { mavenFilter } from './maven.ts'
import { searchContextFilter } from './search-context.ts'
import { pipInstallFilter } from './pip-install.ts'
import { yarnInstallFilter } from './yarn-install.ts'
import { terraformFilter } from './terraform.ts'
import { mypyFilter } from './mypy.ts'
import { pyrightFilter } from './pyright.ts'
import { tyFilter } from './ty.ts'
import { ruffTextFilter } from './ruff-text.ts'
import { preCommitFilter } from './pre-commit.ts'
import { bundleInstallFilter, composerInstallFilter, poetryInstallFilter, uvSyncFilter } from './install-lists.ts'
import { rubocopFilter } from './rubocop.ts'
import { minitestFilter } from './minitest.ts'
import { phpunitFilter } from './phpunit.ts'
import type { EconomyFilter, FilterCandidate, FilterInput } from '../types.ts'

export const STATIC_FILTERS: readonly EconomyFilter[] = Object.freeze([
  pytestFilter, grepFilter, gitDiffFilter, tscFilter, eslintJsonFilter, viteBuildFilter, pnpmInstallFilter, pipInstallFilter, yarnInstallFilter,
  ruffJsonFilter, goTestJsonFilter, gitStatusFilter, searchContextFilter, searchLayoutFilter, pathListFilter, testProgressFilter, lsListingFilter, testReportFilter, cargoBuildFilter, gitShowFilter,
  gitLogFilter, gitBlameFilter, dockerBuildFilter, containerLogsFilter, makeFilter, mavenFilter,
  terraformFilter, mypyFilter, pyrightFilter, tyFilter, ruffTextFilter, preCommitFilter, uvSyncFilter, poetryInstallFilter, bundleInstallFilter,
  composerInstallFilter, rubocopFilter, minitestFilter, phpunitFilter,
])

/** Some filter reads this command's output (see `EconomyFilter.commands`). */
export function filterCoversCommand(command: string): boolean {
  return STATIC_FILTERS.some(filter => filter.commands?.(command) === true)
}

export function projectStaticFilter(input: FilterInput): FilterCandidate | undefined {
  for (const filter of STATIC_FILTERS) {
    const projection = filter.projectMapped(input)
    if (projection !== undefined) return { filter: filter.name, transformation: filter.transformation, ...projection }
  }
  return undefined
}

export { gitBlameFilter, gitDiffFilter, gitLogFilter, gitShowFilter, grepFilter, pytestFilter }
export { tscFilter, eslintJsonFilter, viteBuildFilter, pnpmInstallFilter }
