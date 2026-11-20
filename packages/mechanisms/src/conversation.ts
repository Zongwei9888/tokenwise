/**
 * What TokenWise saved in one conversation, said at the end of a turn when it
 * grew since it was last said. The number last said is kept on disk for each
 * agent and conversation (`told/<host>/<conversation>.txt` in the data
 * directory), so a restarted agent, a resumed conversation or a switch between
 * conversations never says the same number again. Every agent shares it: the
 * hook-driven ones through `tokenwise notice`, the plugins in-process.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { JournalRecord } from '@tokenwise/protocol'
import { ensurePrivateDir, pathSegment } from '@tokenwise/store'
import { overheadOf } from './overhead.ts'
import { summarizeEconomy } from './receipts.ts'
import type { EconomySummary } from './receipts.ts'
import { collectSubagents } from './subagents.ts'

/**
 * A conversation's savings: the tokens the model did not read, net of what
 * TokenWise itself put in front of it (`overheadOf`), of every tool output
 * TokenWise saw.
 */
export type ConversationSavings = Pick<EconomySummary, 'savedTokens' | 'seenTokens'>

const MONTH_MS = 30 * 86_400_000

const toldPath = (dir: string, host: string, sessionId: string) => join(dir, 'told', pathSegment(host), `${pathSegment(sessionId)}.txt`)

/** The saved tokens last said for this conversation; 0 when never. */
export function toldSavings(dirs: readonly string[], host: string, sessionId: string): number {
  for (const dir of dirs) {
    const path = toldPath(dir, host, sessionId)
    if (!existsSync(path)) continue
    try { return Number(readFileSync(path, 'utf8')) || 0 } catch { /* Next location. */ }
  }
  return 0
}

/** Records that `saved` tokens were said for this conversation. Conversations untouched for a month lose their file. */
export function markSavingsTold(dir: string, host: string, sessionId: string, saved: number): void {
  const path = toldPath(dir, host, sessionId)
  ensurePrivateDir(dirname(path))
  writeFileSync(path, String(saved), { mode: 0o600 })
  try {
    for (const name of readdirSync(dirname(path))) {
      const file = join(dirname(path), name)
      if (Date.now() - statSync(file).mtimeMs > MONTH_MS) rmSync(file, { force: true })
    }
  } catch { /* Housekeeping only. */ }
}

/**
 * This conversation's savings, its subagents' included, when they grew since
 * they were last said; otherwise undefined (nothing saved, or nothing more).
 */
export function untoldSavings(read: (sessionId: string) => readonly JournalRecord[], dirs: readonly string[], host: string,
  sessionId: string): ConversationSavings | undefined {
  const records = [...read(sessionId), ...collectSubagents(read, sessionId).records]
  const summary = summarizeEconomy(records)
  const saved = summary.savedTokens - overheadOf(records)
  if (!(saved > toldSavings(dirs, host, sessionId))) return undefined
  return { savedTokens: saved, seenTokens: summary.seenTokens }
}
