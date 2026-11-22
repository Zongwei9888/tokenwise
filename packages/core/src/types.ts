import type { MappedProjection } from './projection-map.ts'
import type { EconomyFilterName } from './filter-names.ts'
import type { FilterOptions } from './filter-options.ts'
export { ECONOMY_FILTER_NAMES } from './filter-names.ts'
export type { EconomyFilterName } from './filter-names.ts'

export type EconomyTransformation = 'noise-removal' | 'preview' | 'lossless-formatting' | 'diagnostic-deduplication'

export interface FilterInput {
  readonly command: string
  readonly stdout: string
  readonly exitCode: number
  readonly options?: FilterOptions
}

export interface FilterCandidate extends MappedProjection {
  readonly filter: EconomyFilterName
  readonly transformation: EconomyTransformation
  readonly text: string
}

export interface EconomyFilter {
  readonly name: EconomyFilterName
  readonly transformation: EconomyTransformation
  /**
   * The commands whose output this filter reads (the same check `projectMapped`
   * makes on the command). Agents that decide before a command runs (Codex,
   * CodeBuddy, a wrapped Claude Code call) route a command through TokenWise
   * only when some filter claims it, so a filter without this is never reached there.
   */
  readonly commands?: (command: string) => boolean
  project(input: FilterInput): string | undefined
  projectMapped(input: FilterInput): MappedProjection | undefined
}
