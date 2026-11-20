import { literalCommand } from '@tokenwise/core'
import type { EconomyRecord, JournalRecord } from '@tokenwise/protocol'

export interface EconomySummary {
  readonly decisions: number
  readonly projected: number
  readonly previewed: number
  readonly passed: number
  readonly failedOpen: number
  /** Applied projections only. */
  readonly rawTokens: number
  readonly projectedTokens: number
  /** Every output decided on, shortened or not: what the model would have read without TokenWise. */
  readonly seenTokens: number
  readonly savedTokens: number
  readonly savedBytes: number
  /** Would-be savings of observe-mode previews. */
  readonly previewSavedTokens: number
  readonly byFilter: readonly { readonly filter: string; readonly count: number; readonly savedTokens: number }[]
  readonly passReasons: readonly { readonly reason: string; readonly count: number }[]
  /** Command heads that no filter covers: the best candidates for new filters. */
  readonly uncovered: readonly { readonly command: string; readonly count: number; readonly rawTokens: number }[]
  readonly rewrites: number
}

const ranked = <T extends { count: number }>(map: Map<string, T>) => [...map.values()].sort((a, b) => b.count - a.count)

export function summarizeEconomy(records: Iterable<JournalRecord>): EconomySummary {
  let decisions = 0, projected = 0, previewed = 0, passed = 0, failedOpen = 0, rewrites = 0
  let rawTokens = 0, projectedTokens = 0, savedBytes = 0, previewSavedTokens = 0, seenTokens = 0
  const filters = new Map<string, { filter: string; count: number; savedTokens: number }>()
  const reasons = new Map<string, { reason: string; count: number }>()
  const uncovered = new Map<string, { command: string; count: number; rawTokens: number }>()
  for (const item of records) {
    if (item.type === 'economy/command-rewrite') { rewrites++; continue }
    if (item.type !== 'economy/decision') continue
    const record = item as EconomyRecord
    decisions++
    seenTokens += record.raw?.tokens ?? 0
    if (record.outcome === 'projected' && record.raw && record.projected) {
      projected++
      rawTokens += record.raw.tokens
      projectedTokens += record.projected.tokens
      savedBytes += record.raw.bytes - record.projected.bytes
      const key = record.filter ?? 'unknown'
      const entry = filters.get(key) ?? { filter: key, count: 0, savedTokens: 0 }
      entry.count++
      entry.savedTokens += record.raw.tokens - record.projected.tokens
      filters.set(key, entry)
    } else if (record.outcome === 'previewed') {
      previewed++
      if (record.raw && record.projected) previewSavedTokens += record.raw.tokens - record.projected.tokens
    } else if (record.outcome === 'failed-open') failedOpen++
    else {
      passed++
      const reason = record.matchDetail ? `${record.reason}:${record.matchDetail}` : record.reason ?? 'unknown'
      const entry = reasons.get(reason) ?? { reason, count: 0 }
      entry.count++
      reasons.set(reason, entry)
      if (record.matchDetail === 'command-not-covered') {
        const head = literalCommand(record.command)?.[0] ?? record.command.trim().split(/\s+/)[0] ?? ''
        const miss = uncovered.get(head) ?? { command: head, count: 0, rawTokens: 0 }
        miss.count++
        miss.rawTokens += record.raw?.tokens ?? 0
        uncovered.set(head, miss)
      }
    }
  }
  return { decisions, projected, previewed, passed, failedOpen, rawTokens, projectedTokens, seenTokens,
    savedTokens: rawTokens - projectedTokens, savedBytes, previewSavedTokens,
    byFilter: ranked(filters).map(item => ({ ...item })), passReasons: ranked(reasons), uncovered: ranked(uncovered).slice(0, 20), rewrites }
}

export function formatTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export interface ShadowSummary {
  /** Compactions LightShadow wrote. */
  readonly checkpoints: number
  /** Compactions the host summarized, after which LightShadow added the catalog of what it kept recallable. */
  readonly assisted: number
  /** Compactions left to the host (observe mode, a checkpoint that was not smaller, or an error). */
  readonly standard: number
  /** Long results the host cut to a head and tail whose complete text LightShadow kept. */
  readonly cuts: number
  /** Distinct tool results kept recallable. */
  readonly references: number
  /** Estimated tokens of those results: what the summarizer no longer had to read or the model to re-read. */
  readonly referencedTokens: number
  readonly recalls: number
  readonly failedRecalls: number
}

export function summarizeShadow(records: Iterable<JournalRecord>): ShadowSummary {
  let checkpoints = 0, assisted = 0, standard = 0, cuts = 0, recalls = 0, failedRecalls = 0
  const references = new Map<string, number>()
  for (const record of records) {
    if (record.type === 'shadow/recall') {
      recalls++
      if (record.outcome === 'failed') failedRecalls++
      continue
    }
    if (record.type !== 'shadow/checkpoint') continue
    if (record.kind === 'lightshadow') checkpoints++
    else if (record.kind === 'assisted') assisted++
    else if (record.kind === 'cut') cuts++
    else standard++
    for (const reference of record.references) references.set(reference.id, Math.ceil(reference.bytes / 4))
  }
  return { checkpoints, assisted, standard, cuts, references: references.size,
    referencedTokens: [...references.values()].reduce((sum, value) => sum + value, 0), recalls, failedRecalls }
}
