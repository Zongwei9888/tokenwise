/**
 * The person's side of self-evolution, driven from their own agent through
 * the tokenwise skill:
 *
 * - checkup: what TokenWise already shortens, the rules it has (taught by the
 *   person or learned in the background), and the commands whose output it
 *   still leaves long;
 * - teach: the person's agent writes a rule for one of those commands in a
 *   workspace, checks it, shows the person what the model would read before
 *   and after, and keeps it only when they say so. Keeping it goes through
 *   the same verification as a background run.
 */
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileLearnedRules, createPolicy, looksUp, parseRuleIndex, readsFileContent, sha256 } from '@tokenwise/core'
import type { LearnedRuleSet } from '@tokenwise/core'
import type { EconomyRecord, JournalRecord } from '@tokenwise/protocol'
import { ensurePrivateDir, RuleStore, readRuleDirectory, removeTree } from '@tokenwise/store'
import { collectEvidence, commandHead, replayCase, scriptRun } from './evolution.ts'
import type { EvidenceCase, VerificationReport } from './evolution.ts'
import {
  activeRulesView, checkWorkspace, compileCandidate, evolveDir, newRunId, prepareRun, readJson, readOnlyArtifacts, ruleChanges, sameCommand, teachCheckerState, writeJsonAtomic,
} from './learning.ts'
import type { EvolveContext } from './learning.ts'

/** A command whose recorded output TokenWise still leaves long. */
export interface NoisyCommand {
  readonly command: string
  /** Recorded outputs that still come back long (repeats included), and distinct ones. */
  readonly outputs: number
  readonly cases: number
  /** All its recorded outputs, the short ones included. */
  readonly total: number
  /** Lines of a typical long output (the median). */
  readonly lines: number
  /** Share of the original the model reads now, over the long ones. */
  readonly readShare: number
  readonly leftTokens: number
}

const lineCount = (text: string) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0 }


/** Below this many tokens left over all its outputs (a short listing run once), a command is not worth a rule. */
const WORTH_TEACHING = 1_000

/** Commands with the most tokens left, of observations where the policy saves less than half (as the evidence scan counts them). */
export function noisyCommands(cases: readonly EvidenceCase[], policy: ReturnType<typeof createPolicy>, minimumSavedTokens: number, limit = 5): NoisyCommand[] {
  const groups = new Map<string, { outputs: number; cases: number; lines: number[]; raw: number; left: number }>()
  const totals = new Map<string, number>()
  for (const item of cases) {
    const head = commandHead(item.result.command)
    totals.set(head, (totals.get(head) ?? 0) + item.occurrences)
    if (scriptRun(head)) continue
    const row = replayCase(policy, item, { minimumSavedTokens })
    if (row.rawTokens < 100 || row.saving >= row.rawTokens / 2) continue
    const group = groups.get(head) ?? { outputs: 0, cases: 0, lines: [], raw: 0, left: 0 }
    group.outputs += item.occurrences
    group.cases++
    group.lines.push(lineCount(item.result.rendered))
    group.raw += row.rawTokens * item.occurrences
    group.left += (row.rawTokens - row.saving) * item.occurrences
    groups.set(head, group)
  }
  return [...groups].map(([command, group]) => ({ command, outputs: group.outputs, cases: group.cases, total: totals.get(command) ?? group.outputs, lines: median(group.lines),
    readShare: group.raw ? group.left / group.raw : 1, leftTokens: group.left }))
    // A rule earns its keep on output that keeps coming back long: seen twice at least, with lines to work on (one long JSON line has none).
    .filter(item => item.leftTokens >= WORTH_TEACHING && item.outputs >= 2 && item.lines >= 10)
    .sort((a, b) => b.leftTokens - a.leftTokens).slice(0, limit)
}

/** For rules a background run added or changed, the command its check found them saving on (the latest run wins). */
function learnedCommands(dataDir: string): Map<string, string> {
  const found = new Map<string, string>()
  let text = ''
  try { text = readFileSync(join(evolveDir(dataDir), 'history.jsonl'), 'utf8') } catch { return found }
  for (const line of text.split('\n')) {
    let run: { outcome?: { result?: string; changes?: { added?: string[]; changed?: string[] }; generalization?: { commands?: string[] } } }
    try { run = JSON.parse(line) } catch { continue }
    const command = run.outcome?.generalization?.commands?.[0]
    if (run.outcome?.result !== 'adopted' || typeof command !== 'string') continue
    for (const id of [...run.outcome.changes?.added ?? [], ...run.outcome.changes?.changed ?? []]) found.set(id, command)
  }
  return found
}

/** The active learned rules, compiled for this call only (the caller disposes of them). */
function activeSet(dataDir: string): LearnedRuleSet | undefined {
  const store = new RuleStore(dataDir)
  const active = store.state().active
  return active ? compileLearnedRules(store.files(active)) : undefined
}

export interface Checkup {
  /** Shell outputs TokenWise saw, from which agents, since when. */
  readonly outputs: number
  readonly hosts: readonly string[]
  readonly since?: string
  /** Outputs it shortened, the share of their original the model read, and how many a learned rule shortened. */
  readonly shortened: { readonly outputs: number; readonly readShare: number; readonly byLearnedRules: number }
  /** Active learned rules: who made them, what they shorten and how often they did. */
  readonly rules: readonly { readonly id: string; readonly taught: boolean; readonly command?: string; readonly uses: number }[]
  /** Commands worth teaching TokenWise about. */
  readonly worth: readonly NoisyCommand[]
  /** Rules the person taught so far, across every adoption. */
  readonly taughtTotal: number
}

export function checkup(context: EvolveContext, now = new Date()): Checkup {
  expireTeach(context, now)
  const records: JournalRecord[] = [...context.readJournal({})]
  let outputs = 0, shortened = 0, byLearned = 0, raw = 0, read = 0
  let since: string | undefined
  const hosts = new Set<string>()
  const ruleCommands = new Map<string, Map<string, number>>()
  for (const item of records) {
    if (item.type !== 'economy/decision') continue
    const record = item as EconomyRecord
    outputs++
    hosts.add(record.host)
    if (since === undefined || record.time < since) since = record.time
    if (record.outcome !== 'projected' || !record.raw || !record.projected) continue
    shortened++
    raw += record.raw.tokens
    read += record.projected.tokens
    if (record.filter === 'learned-rule' && record.rule) {
      byLearned++
      const counts = ruleCommands.get(record.rule) ?? new Map<string, number>()
      const head = commandHead(record.command)
      counts.set(head, (counts.get(head) ?? 0) + 1)
      ruleCommands.set(record.rule, counts)
    }
  }
  const store = new RuleStore(context.dataDir)
  const history = store.state().history
  const taughtBy = new Map<string, string>()
  for (const adoption of history) for (const id of adoption.taught?.rules ?? []) taughtBy.set(id, adoption.taught!.command)
  const learnedFor = learnedCommands(context.dataDir)
  const rules = activeRulesView(context.dataDir).rules.map(rule => {
    const counts = ruleCommands.get(rule.id)
    const command = counts ? [...counts].sort((a, b) => b[1] - a[1])[0]![0] : taughtBy.get(rule.id) ?? learnedFor.get(rule.id)
    return { id: rule.id, taught: taughtBy.has(rule.id), ...command === undefined ? {} : { command }, uses: [...counts?.values() ?? []].reduce((a, b) => a + b, 0) }
  })
  const evidence = collectEvidence(records, readOnlyArtifacts(context), { maxCases: 2000 })
  const set = activeSet(context.dataDir)
  let worth: NoisyCommand[]
  try { worth = noisyCommands(evidence, createPolicy(context.economy.filterOptions, set), context.economy.minimumSavedTokens) } finally { set?.dispose() }
  return { outputs, hosts: [...hosts].sort(), ...since === undefined ? {} : { since },
    shortened: { outputs: shortened, readShare: raw ? read / raw : 1, byLearnedRules: byLearned }, rules, worth,
    taughtTotal: new Set(history.flatMap(adoption => adoption.taught?.rules ?? [])).size }
}

// ——— Teaching one command ———

export interface TeachState {
  readonly schemaVersion: 1
  readonly id: string
  readonly command: string
  readonly startedAt: string
  readonly dir: string
  readonly workspace: string
  /** The active rules the workspace started from. */
  readonly parent: string | null
}

/**
 * Teaching happens in a private temporary directory, one per data directory: agents' sandboxes (Codex, DSH)
 * let their commands write there, so the agent writes and checks the rule without asking, and only keeping it
 * writes to the data directory.
 */
const teachName = (dataDir: string) => `tokenwise-teach-${process.getuid?.() ?? 'user'}-${sha256(resolve(dataDir)).slice(0, 12)}`
const teachRoot = (dataDir: string) => join(resolve(process.env.TMPDIR?.trim() || tmpdir()), teachName(dataDir))
const teachFile = (dataDir: string) => join(teachRoot(dataDir), 'current.json')

/**
 * Where a teach for `dataDir` may have started: this process's temporary directory first, then the system's, /tmp,
 * and this user's folders in /tmp. An agent's sandbox may set its own TMPDIR that the commands it runs escalated
 * do not get (Claude Code's: /tmp/claude-<uid>), and `teach keep` must still find the workspace.
 */
function* teachRoots(dataDir: string): Generator<string> {
  const name = teachName(dataDir)
  const seen = new Set<string>()
  const at = (base: string) => { const root = join(resolve(base), name); if (seen.has(root)) return undefined; seen.add(root); return root }
  for (const base of [process.env.TMPDIR?.trim() || tmpdir(), tmpdir(), '/tmp', '/private/tmp']) { const root = at(base); if (root) yield root }
  for (const tmp of ['/tmp', '/private/tmp']) {
    let children: string[] = []
    try { children = readdirSync(tmp) } catch { continue }
    for (const child of children) {
      if (child.startsWith('tokenwise-teach-') || !ownDir(join(tmp, child))) continue
      const root = at(join(tmp, child))
      if (root) yield root
    }
  }
}

/** The teach in progress and the folder it is in. */
function findTeach(dataDir: string): { root: string; state: TeachState } | undefined {
  for (const root of teachRoots(dataDir)) {
    if (!ownDir(root)) continue
    const state = readJson<TeachState>(join(root, 'current.json'))
    if (state?.schemaVersion === 1 && existsSync(state.workspace)) return { root, state }
  }
  return undefined
}

/** Whether `dir` is a directory of this user's own (in a shared /tmp, another user could have made it first). */
function ownDir(dir: string): boolean {
  try {
    const stat = lstatSync(dir)
    return stat.isDirectory() && (!process.getuid || stat.uid === process.getuid())
  } catch { return false }
}

/** The teach folder, private and this user's own. */
function ensureTeachRoot(dataDir: string): string {
  const root = ensurePrivateDir(teachRoot(dataDir))
  if (!ownDir(root)) {
    throw Object.assign(new Error(`${root} is not a folder of this user's own`), {
      tokenwiseMessage: `${root} is not a folder of your own (another user's, or a link), so TokenWise cannot teach there. Remove it, or set TMPDIR to a folder of your own.` })
  }
  chmodSync(root, 0o700)
  return root
}

export function currentTeach(dataDir: string): TeachState | undefined {
  return findTeach(dataDir)?.state
}

/** A workspace left unfinished holds copies of recorded output: it goes when the originals would. */
function expireTeach(context: EvolveContext, now: Date): void {
  const state = findTeach(context.dataDir)?.state
  if (!state || now.getTime() - Date.parse(state.startedAt) <= (context.retentionDays ?? 14) * 86_400_000) return
  // A checkup only reads; in a sandbox that cannot write, the old workspace waits for the next chance.
  try { dropTeach(context.dataDir) } catch { /* Not writable here. */ }
}

/** Remove the teaching workspace (it holds copies of recorded output), and any left behind; all but `keep`, when given. */
export function dropTeach(dataDir: string, keep?: string): boolean {
  const found = findTeach(dataDir)
  const primary = teachRoot(dataDir)
  for (const root of new Set([primary, ...found ? [found.root] : []])) {
    if (!ownDir(root)) continue
    let names: string[] = []
    try { names = readdirSync(root) } catch { /* Nothing to remove. */ }
    for (const name of names) if (root !== primary || name !== keep) removeTree(join(root, name))
    try { rmdirSync(root) } catch { /* Gone already, or something else is in it. */ }
  }
  return found !== undefined
}

export type TeachStart =
  | { readonly ok: true; readonly state: TeachState; readonly shown: number; readonly heldOut: number; readonly outputs: number }
  | { readonly ok: false; readonly reason: 'no-output' | 'too-short' | 'already-short' | 'looks-up' | 'reads-files'; readonly command: string; readonly worth: readonly NoisyCommand[]; readonly retentionDays: number }

/** Write a workspace for teaching `command`, replacing any earlier one. `checker` runs `check` and `try` (see prepareRun). */
export function startTeach(context: EvolveContext, command: string, checker: readonly string[], now = new Date()): TeachStart {
  const wanted = commandHead(command)
  /** Why there is nothing to teach, with the commands worth it instead. */
  const refuse = (evidence: readonly EvidenceCase[], matched: number): TeachStart => {
    const set = activeSet(context.dataDir)
    let worth: NoisyCommand[], short: boolean
    try {
      const policy = createPolicy(context.economy.filterOptions, set)
      worth = noisyCommands(evidence, policy, context.economy.minimumSavedTokens)
      // Under 100 tokens, an output is not worth a rule (the same floor learnerCases uses).
      short = evidence.filter(item => sameCommand(commandHead(item.result.command), wanted))
        .every(item => replayCase(policy, item, { minimumSavedTokens: context.economy.minimumSavedTokens }).rawTokens < 100)
    } finally { set?.dispose() }
    const reason = looksUp(command) ? 'looks-up' : readsFileContent(command) ? 'reads-files' : matched === 0 ? 'no-output' : short ? 'too-short' : 'already-short'
    return { ok: false, reason, command: wanted, worth, retentionDays: context.retentionDays ?? 14 }
  }
  // Decided before anything is written, so a sandbox that cannot write still gets the reason.
  if (looksUp(command) || readsFileContent(command)) return refuse(collectEvidence(context.readJournal({}), readOnlyArtifacts(context), { maxCases: 2000 }), 0)
  ensureTeachRoot(context.dataDir)
  const id = newRunId(now)
  const dir = join(teachRoot(context.dataDir), id)
  const prepared = prepareRun(context, { checker, runId: id, runDir: dir, teach: wanted, now })
  if (prepared.shown === 0) {
    // A command with nothing to teach leaves any teaching in progress as it was.
    removeTree(dir)
    try { rmdirSync(teachRoot(context.dataDir)) } catch { /* Not empty, or gone. */ }
    return refuse(prepared.evidence, prepared.matched)
  }
  dropTeach(context.dataDir, id)
  const state: TeachState = { schemaVersion: 1, id, command: wanted, startedAt: now.toISOString(), dir, workspace: prepared.workspace, parent: prepared.parent }
  writeJsonAtomic(teachFile(context.dataDir), state)
  const outputs = prepared.evidence.filter(item => sameCommand(commandHead(item.result.command), wanted)).reduce((sum, item) => sum + item.occurrences, 0)
  return { ok: true, state, shown: prepared.shown, heldOut: prepared.heldOut, outputs }
}

/** One recorded output as the model would read it under two policies. */
export interface PreviewExample {
  readonly command: string
  readonly time: string
  readonly exitCode: number | null
  readonly original: string
  readonly now: string
  readonly after?: string
}

export interface Preview {
  readonly command: string
  /** Recorded outputs of the command (repeats included). */
  readonly outputs: number
  /** Share of the original the model reads, over all of them: now, and with the rule being taught. */
  readonly readShareNow: number
  readonly readShareAfter?: number
  readonly example: PreviewExample
  /** The verdict on the rule being taught. */
  readonly report?: VerificationReport
  readonly error?: string
}

/**
 * Before and after for `command` on its recorded outputs: the original, what
 * the model reads now, and (when teaching) what it would read with the rules
 * in the workspace. The example is the output the change helps most, else the
 * largest.
 */
export function preview(context: EvolveContext, command: string | undefined, options: { teach?: boolean } = {}): Preview | { readonly error: string } {
  const teaching = options.teach ? currentTeach(context.dataDir) : undefined
  if (options.teach && !teaching) return { error: 'nothing is being taught (start with tokenwise teach "<command>")' }
  const wanted = teaching?.command ?? (command === undefined ? undefined : commandHead(command))
  if (!wanted) return { error: 'name the command to show, such as tokenwise preview "make test"' }
  const evidence = collectEvidence(context.readJournal({}), readOnlyArtifacts(context), { maxCases: 2000 })
    .filter(item => sameCommand(commandHead(item.result.command), wanted))
  if (!evidence.length) {
    if (command !== undefined && (readsFileContent(command) || looksUp(command))) return { error: `${wanted} prints what the agent asked to see (file contents, search results, listings), which TokenWise leaves as it is` }
    return { error: `no recorded output of ${wanted} is kept (originals are kept for ${context.retentionDays ?? 14} days)` }
  }
  const store = new RuleStore(context.dataDir)
  let nowSet: LearnedRuleSet | undefined, afterSet: LearnedRuleSet | undefined
  try {
    nowSet = teaching ? (teaching.parent ? compileLearnedRules(store.files(teaching.parent)) : undefined) : activeSet(context.dataDir)
    if (teaching) {
      try { afterSet = compileCandidate(readRuleDirectory(join(teaching.workspace, 'rules-work'))) } catch (error) {
        return { error: `the rule does not load: ${String((error as Error).message ?? error)}` }
      }
    }
    const { filterOptions, minimumSavedTokens } = context.economy
    const nowPolicy = createPolicy(filterOptions, nowSet)
    const afterPolicy = teaching ? createPolicy(filterOptions, afterSet) : undefined
    let raw = 0, readNow = 0, readAfter = 0, outputs = 0
    let best: { item: EvidenceCase; now: string; after?: string; gain: number; raw: number } | undefined
    for (const item of evidence) {
      const row = replayCase(nowPolicy, item, { minimumSavedTokens })
      const next = afterPolicy ? replayCase(afterPolicy, item, { minimumSavedTokens }) : undefined
      outputs += item.occurrences
      raw += row.rawTokens * item.occurrences
      readNow += (row.rawTokens - row.saving) * item.occurrences
      if (next) readAfter += (next.rawTokens - next.saving) * item.occurrences
      const gain = next ? next.saving - row.saving : row.saving
      if (!best || gain > best.gain || (gain === best.gain && row.rawTokens > best.raw)) {
        best = { item, now: row.delivered, ...next ? { after: next.delivered } : {}, gain, raw: row.rawTokens }
      }
    }
    const example: PreviewExample = { command: best!.item.result.command, time: best!.item.time, exitCode: best!.item.result.exitCode,
      original: best!.item.result.rendered, now: best!.now, ...best!.after === undefined ? {} : { after: best!.after } }
    let report: VerificationReport | undefined
    let error: string | undefined
    if (teaching) {
      const checked = checkWorkspace(context, teaching.workspace, teachCheckerState(context, teaching.command, teaching.parent))
      report = checked.report
      error = checked.error
    }
    return { command: wanted, outputs, readShareNow: raw ? readNow / raw : 1, ...afterPolicy ? { readShareAfter: raw ? readAfter / raw : 1 } : {},
      example, ...report ? { report } : {}, ...error ? { error } : {} }
  } finally {
    nowSet?.dispose()
    afterSet?.dispose()
  }
}

export type TeachKeep =
  | { readonly kept: true; readonly command: string; readonly rules: readonly string[]; readonly hash: string; readonly taughtTotal: number }
  | { readonly kept: false; readonly reason: string; readonly report?: VerificationReport }

/** Verify the workspace's rules as a background run would, and adopt them, marked as taught. */
export function keepTeach(context: EvolveContext, now = new Date()): TeachKeep {
  const teaching = currentTeach(context.dataDir)
  if (!teaching) return { kept: false, reason: 'nothing is being taught' }
  const store = new RuleStore(context.dataDir)
  // Verified against the rules in use and all recorded output, read from the data directory: the teaching agent can edit the workspace's checker files.
  const active = store.state().active
  if (active !== teaching.parent) return { kept: false, reason: 'the learned rules changed meanwhile (another adoption); start teaching again' }
  const checked = checkWorkspace(context, teaching.workspace, teachCheckerState(context, teaching.command, active))
  if (!checked.report) return { kept: false, reason: `the rule does not load: ${checked.error ?? 'unknown'}` }
  const report = checked.report
  if (!report.accepted) return { kept: false, reason: 'the rule did not pass the check', report }
  const parentFiles = teaching.parent ? store.files(teaching.parent) : []
  const changes = ruleChanges(parentFiles, checked.files!)
  const rules = [...changes.added, ...changes.changed]
  const hash = store.installFiles(checked.files!)
  if (hash !== report.candidateHash) return { kept: false, reason: 'the rule changed while it was being checked; check it again' }
  const adopted = store.activate(hash, { cases: report.cases, gainTokens: report.gainTokens, taught: { command: teaching.command, rules } }, now, teaching.parent)
  if (!adopted) return { kept: false, reason: 'the learned rules changed meanwhile (another adoption); start teaching again' }
  dropTeach(context.dataDir)
  const taughtTotal = new Set(store.state().history.flatMap(item => item.taught?.rules ?? [])).size
  return { kept: true, command: teaching.command, rules: rules.length ? rules : parseRuleIndex(checked.files!).map(rule => rule.id), hash, taughtTotal }
}
