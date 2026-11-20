import { collectSubagents, formatTokens, overheadOf, summarizeEconomy, summarizeShadow } from '@tokenwise/mechanisms'
import type { EconomySummary, ShadowSummary } from '@tokenwise/mechanisms'
import type { JournalRecord } from '@tokenwise/protocol'
import { cliContext } from './context.ts'

/** `overhead`: what TokenWise itself put in front of the model (`overheadOf`), said with what it saved net of it. */
export function formatSummary(summary: EconomySummary, scope: string, overhead?: number): string {
  const lines = [`TokenWise — ${scope}`]
  if (summary.decisions === 0 && summary.rewrites === 0) return `${lines[0]}\nNo recorded decisions yet.\n`
  const percent = summary.rawTokens ? ` (${Math.round(100 * summary.savedTokens / summary.rawTokens)}% of filtered outputs)` : ''
  lines.push(`  tool outputs seen     ${summary.decisions}`)
  lines.push(`  projected             ${summary.projected}`)
  if (summary.previewed) lines.push(`  previewed (observe)   ${summary.previewed}, would save ~${formatTokens(summary.previewSavedTokens)} tokens`)
  lines.push(`  passed unchanged      ${summary.passed}`)
  if (summary.failedOpen) lines.push(`  failed open           ${summary.failedOpen}`)
  lines.push(`  tokens saved          ~${formatTokens(summary.savedTokens)}${percent}`)
  if (overhead) {
    lines.push(`  TokenWise's own text  ~${formatTokens(overhead)} (the recall tool once per conversation, recalls, compaction catalogs)`)
    lines.push(`  net saved             ~${formatTokens(summary.savedTokens - overhead)}`)
  }
  if (summary.rewrites) lines.push(`  command rewrites      ${summary.rewrites}`)
  if (summary.byFilter.length) {
    lines.push('', '  by filter')
    for (const item of summary.byFilter.slice(0, 12)) lines.push(`    ${item.filter.padEnd(22)} ${String(item.count).padStart(5)}  ~${formatTokens(item.savedTokens)} tokens`)
  }
  if (summary.uncovered.length) {
    lines.push('', '  most frequent uncovered commands')
    for (const item of summary.uncovered.slice(0, 8)) lines.push(`    ${item.command.slice(0, 22).padEnd(22)} ${String(item.count).padStart(5)}  ~${formatTokens(item.rawTokens)} tokens`)
  }
  return lines.join('\n') + '\n'
}

export function formatShadow(summary: ShadowSummary): string {
  if (summary.checkpoints + summary.assisted + summary.standard + summary.cuts === 0) return ''
  const lines = ['', 'Compaction']
  lines.push(`  compactions           ${summary.checkpoints}${summary.standard ? ` (${summary.standard} left to the host)` : ''}`)
  if (summary.assisted) lines.push(`  host-summarized       ${summary.assisted} (catalog added after the host's summary)`)
  if (summary.cuts) lines.push(`  long results cut      ${summary.cuts} (complete text kept)`)
  lines.push(`  results recallable    ${summary.references} (~${formatTokens(summary.referencedTokens)} tokens)`)
  lines.push(`  recalls               ${summary.recalls}${summary.failedRecalls ? ` (${summary.failedRecalls} failed)` : ''}`)
  return lines.join('\n') + '\n'
}

export function report(options: { host?: string; session?: string; json?: boolean }): number {
  const context = cliContext()
  const host = options.host === undefined ? {} : { host: options.host }
  // A session includes the subagent sessions it started. With a host each session is one file;
  // without one, every file is read once and indexed rather than once per subagent.
  let read: (sessionId: string) => readonly JournalRecord[] = sessionId => context.readJournal({ ...host, sessionId })
  if (options.session !== undefined && options.host === undefined) {
    const bySession = new Map<string | null, JournalRecord[]>()
    for (const record of context.readJournal({})) {
      const list = bySession.get(record.sessionId)
      if (list) list.push(record)
      else bySession.set(record.sessionId, [record])
    }
    read = sessionId => bySession.get(sessionId) ?? []
  }
  const records = options.session === undefined ? context.readJournal(host) : read(options.session)
  const subagents = options.session === undefined ? undefined : collectSubagents(read, options.session)
  const all = subagents ? [...records, ...subagents.records] : records
  const summary = summarizeEconomy(all)
  const shadow = summarizeShadow(all)
  const overhead = overheadOf(all)
  const n = subagents?.sessions.length ?? 0
  const session = options.session ? `session ${options.session}${n > 0 ? ` and its ${n} subagent session${n === 1 ? '' : 's'}` : ''}` : 'all sessions'
  const scope = [options.host ?? 'all hosts', session].join(', ')
  process.stdout.write(options.json ? JSON.stringify({ ...summary, overheadTokens: overhead, netSavedTokens: summary.savedTokens - overhead, lightshadow: shadow }, null, 2) + '\n'
    : formatSummary(summary, scope, overhead) + formatShadow(shadow))
  return 0
}
