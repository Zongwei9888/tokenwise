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
import { gitLsTreeFilter, gitStashListFilter } from './git-listings.ts'
import { ghFilter } from './gh.ts'
import { gtFilter, yadmFilter } from './git-wrappers.ts'
import { diffFilter, jjFilter } from './unified-diff.ts'
import { jsTestFilter } from './js-test.ts'
import { playwrightFilter } from './playwright.ts'
import { nextBuildFilter } from './next-build.ts'
import { ngBuildFilter } from './ng-build.ts'
import { pnpmListFilter, pnpmOutdatedFilter } from './pnpm-deps.ts'
import { turboFilter } from './turbo.ts'
import { prismaMigrateFilter } from './prisma-migrate.ts'
import { prettierFilter } from './prettier.ts'
import { dockerImagesFilter, dockerPsFilter, kubectlGetFilter } from './containers.ts'
import { awsFilter, gcloudFilter, helmFilter, skopeoFilter } from './cloud-cli.ts'
import { terraformInitFilter } from './terraform-init.ts'
import { pulumiFilter } from './pulumi.ts'
import { ansiblePlaybookFilter } from './ansible.ts'
import { psqlFilter } from './psql.ts'
import { goBuildFilter } from './go-build.ts'
import { ccFilter } from './cc.ts'
import { swiftBuildFilter } from './swift-build.ts'
import { xcodebuildFilter } from './xcodebuild.ts'
import { pioRunFilter } from './pio-run.ts'
import { trunkBuildFilter } from './trunk-build.ts'
import { springBootFilter } from './spring-boot.ts'
import { gradleFilter } from './gradle.ts'
import { liquibaseFilter } from './liquibase.ts'
import { dotnetBuildFilter } from './dotnet-build.ts'
import { mixCompileFilter } from './mix-compile.ts'
import { mypyFilter } from './mypy.ts'
import { pyrightFilter } from './pyright.ts'
import { tyFilter } from './ty.ts'
import { ruffTextFilter } from './ruff-text.ts'
import { preCommitFilter } from './pre-commit.ts'
import { bundleInstallFilter, composerInstallFilter, poetryInstallFilter, uvSyncFilter } from './install-lists.ts'
import { rubocopFilter } from './rubocop.ts'
import { minitestFilter } from './minitest.ts'
import { phpunitFilter } from './phpunit.ts'
import { dfFilter, duFilter, iptablesFilter, psFilter, statFilter, wcFilter } from './system-tables.ts'
import { astGrepFilter } from './ast-grep.ts'
import { pingFilter, rsyncFilter } from './network.ts'
import { systemctlStatusFilter } from './systemctl.ts'
import { brewInstallFilter, goTaskFilter, quartoRenderFilter } from './task-tools.ts'
import { jqFilter } from './json-output.ts'
import { hadolintFilter, shellcheckFilter, yamllintFilter } from './linters.ts'
import type { EconomyFilter, FilterCandidate, FilterInput } from '../types.ts'

export const STATIC_FILTERS: readonly EconomyFilter[] = Object.freeze([
  pytestFilter, grepFilter, gitDiffFilter, tscFilter, eslintJsonFilter, viteBuildFilter, pnpmInstallFilter, pipInstallFilter, yarnInstallFilter,
  ruffJsonFilter, goTestJsonFilter, gitStatusFilter, searchContextFilter, searchLayoutFilter, pathListFilter, testProgressFilter, lsListingFilter, testReportFilter, cargoBuildFilter, gitShowFilter,
  gitLogFilter, gitBlameFilter, dockerBuildFilter, containerLogsFilter, makeFilter, mavenFilter,
  terraformFilter,
  gitStashListFilter, gitLsTreeFilter, ghFilter, gtFilter, yadmFilter, jjFilter, diffFilter,
  // After test-progress and test-report, which keep the Jest and Vitest output they already condense.
  jsTestFilter, playwrightFilter, nextBuildFilter, ngBuildFilter, pnpmOutdatedFilter, pnpmListFilter, turboFilter, prismaMigrateFilter, prettierFilter,
  dockerPsFilter, dockerImagesFilter, kubectlGetFilter, helmFilter, awsFilter, gcloudFilter, skopeoFilter, terraformInitFilter, pulumiFilter,
  ansiblePlaybookFilter, psqlFilter,
  // After maven, so `mvn spring-boot:run` keeps Maven's projection; before gradle, so `gradle bootRun` gets both folds.
  goBuildFilter, ccFilter, swiftBuildFilter, xcodebuildFilter, pioRunFilter, trunkBuildFilter, springBootFilter, gradleFilter,
  liquibaseFilter, dotnetBuildFilter, mixCompileFilter,
  mypyFilter, pyrightFilter, tyFilter, ruffTextFilter, preCommitFilter, uvSyncFilter, poetryInstallFilter, bundleInstallFilter,
  composerInstallFilter, rubocopFilter, minitestFilter, phpunitFilter,
  wcFilter, astGrepFilter, dfFilter, duFilter, psFilter, statFilter, pingFilter, rsyncFilter, systemctlStatusFilter, iptablesFilter,
  brewInstallFilter, goTaskFilter, jqFilter, quartoRenderFilter, hadolintFilter, shellcheckFilter, yamllintFilter,
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
