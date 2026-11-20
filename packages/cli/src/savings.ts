/**
 * What TokenWise saved: the tokens the model did not have to read because an
 * output was shortened (original minus what was delivered), over a period,
 * today, and per day or month. Read from the journals of every data location;
 * each file is parsed again only when it changed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type Period = 'week' | 'month' | 'all'
export const PERIODS: readonly Period[] = ['week', 'month', 'all']

interface Saving { readonly at: number; readonly host: string; readonly tokens: number }
export interface Bucket { readonly start: number; readonly tokens: number }
export interface Savings {
  readonly period: Period
  /** Tokens the model did not read in the period. */
  readonly tokens: number
  /** How many outputs were shortened in the period. */
  readonly outputs: number
  /** Tokens saved since local midnight. */
  readonly today: number
  /** Per day (week, month) or per month (all), oldest first; the last one is the current day or month. */
  readonly buckets: readonly Bucket[]
  /** The agents that saved something in the period, most first. */
  readonly agents: readonly string[]
  /** When the first saving was recorded, or null. */
  readonly since: number | null
}

const cache = new Map<string, { stamp: string; savings: Saving[] }>()

/** The shortened outputs in one journal file: a decision record whose outcome is `projected`. */
function fileSavings(path: string): Saving[] {
  let stamp: string
  try { const s = statSync(path); stamp = `${s.mtimeMs}:${s.size}` } catch { return [] }
  const hit = cache.get(path)
  if (hit?.stamp === stamp) return hit.savings
  const savings: Saving[] = []
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { /* Gone meanwhile. */ }
  for (const line of text.split('\n')) {
    if (!line.includes('"outcome":"projected"')) continue
    try {
      const r = JSON.parse(line) as { type?: string; time?: string; host?: string; raw?: { tokens?: number }; projected?: { tokens?: number } }
      const tokens = (r.raw?.tokens ?? 0) - (r.projected?.tokens ?? 0)
      const at = Date.parse(r.time ?? '')
      if (r.type === 'economy/decision' && tokens > 0 && Number.isFinite(at)) savings.push({ at, host: r.host ?? 'shell', tokens })
    } catch { /* A torn last line. */ }
  }
  cache.set(path, { stamp, savings })
  return savings
}

export function readSavings(dataDirs: readonly string[]): Saving[] {
  const all: Saving[] = []
  for (const dir of dataDirs) {
    const journal = join(dir, 'journal')
    let hosts: string[]
    try { hosts = readdirSync(journal) } catch { continue }
    for (const host of hosts) {
      let files: string[]
      try { files = readdirSync(join(journal, host)) } catch { continue }
      for (const file of files) if (file.endsWith('.jsonl')) all.push(...fileSavings(join(journal, host, file)))
    }
  }
  return all
}

const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime() }
const month = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime() }
const addMonths = (t: number, n: number) => { const d = new Date(t); d.setMonth(d.getMonth() + n); return d.getTime() }

export function summarize(all: readonly Saving[], period: Period, now = Date.now()): Savings {
  const today = day(now)
  const since = all.length ? Math.min(...all.map(s => s.at)) : null
  // Week: the last 7 days; month: the last 30 days, per day. All: per month since the first saving (at least 6).
  const starts: number[] = []
  if (period === 'all') {
    const first = month(since ?? now), last = month(now)
    for (let m = Math.min(first, addMonths(last, -5)); m <= last; m = addMonths(m, 1)) starts.push(m)
  } else {
    const n = period === 'week' ? 7 : 30
    for (let i = n - 1; i >= 0; i--) starts.push(addDays(today, -i))
  }
  const from = starts[0]!
  const inPeriod = all.filter(s => s.at >= from && s.at <= now)
  const tokens = new Array<number>(starts.length).fill(0)
  const byHost = new Map<string, number>()
  for (const s of inPeriod) {
    let i = starts.length - 1
    while (i > 0 && s.at < starts[i]!) i--
    tokens[i]! += s.tokens
    byHost.set(s.host, (byHost.get(s.host) ?? 0) + s.tokens)
  }
  return {
    period, tokens: inPeriod.reduce((n, s) => n + s.tokens, 0), outputs: inPeriod.length,
    today: all.filter(s => s.at >= today && s.at <= now).reduce((n, s) => n + s.tokens, 0),
    buckets: starts.map((start, i) => ({ start, tokens: tokens[i]! })),
    agents: [...byHost].sort((a, b) => b[1] - a[1]).map(([host]) => host),
    since,
  }
}

export const savingsOf = (dataDirs: readonly string[], period: Period, now = Date.now()): Savings => summarize(readSavings(dataDirs), period, now)

/** The names people know the agents by; `shell` is `tokenwise run` in any terminal. */
export const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot CLI', hermes: 'Hermes', opencode: 'OpenCode', codebuddy: 'CodeBuddy',
  grok: 'Grok Build', dsh: 'DeepSeek Harness', pi: 'pi', shell: 'Terminal',
}
