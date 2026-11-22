import { inspectShell } from '../shell-inspection.ts'
import { groupRecords, SEARCH_RECORDS } from './record-groups.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/**
 * Group consecutive filename:line:text records, including those inside mixed
 * shell output. All matches, line numbers and non-record text remain in order.
 * No assumption that the last pipeline command owns the complete stdout.
 */
function projectMapped(input: FilterInput) {
  const shell = inspectShell(input.command)
  if (!shell?.heads.some(head => ['grep', 'rg', 'ripgrep'].includes(head))
    || ![0, 1].includes(input.exitCode) || /[\u001b\0]|\r(?!\n)/.test(input.stdout)) return undefined
  return groupRecords(input.stdout, SEARCH_RECORDS)
}

export const searchLayoutFilter: EconomyFilter = {
  name: 'search-layout', transformation: 'lossless-formatting', projectMapped,
  project: input => projectMapped(input)?.text,
}
