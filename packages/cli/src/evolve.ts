import { resolve } from 'node:path'
import { formatTokens, LEARNER_INSTRUCTION, LEARNERS, runEvolution, describeReport, workspaceCheck, workspaceTry } from '@tokenwise/mechanisms'
import type { EvolveContext } from '@tokenwise/mechanisms'
import { RuleStore } from '@tokenwise/store'
import { cliContext, shellQuote } from './context.ts'
import type { CliContext } from './context.ts'

/**
 * `tokenwise evolve`: one evolution step of the learned rules. Collect evidence from
 * the journal, write a workspace for a learner (a coding agent: pi, DeepSeek
 * Harness, Claude Code, Codex or any command), run it, verify what it left in
 * `rules-work/`, and adopt that only if verification accepts it. The work
 * itself is `runEvolution` in @tokenwise/mechanisms, which the pi and DSH
 * plugins run too.
 */

export { LEARNERS }

const DURATION = /^(\d+)(m|h|d)$/u
export function parseDuration(value: string): number | undefined {
  const match = DURATION.exec(value.trim())
  if (!match) return undefined
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd']
}

export function toEvolveContext(context: CliContext): EvolveContext {
  const { filterOptions, minimumSavedTokens } = context.loaded.config.economy
  return { dataDir: context.dataDir, retentionDays: context.loaded.config.artifacts.retentionDays,
    readJournal: filter => context.readJournal(filter), readArtifact: hash => context.readArtifact(hash),
    economy: { minimumSavedTokens, ...filterOptions === undefined ? {} : { filterOptions } } }
}

/** The command prefix the workspace's ./check and ./try run: this same tokenwise, with node, whatever the learner's PATH holds. */
export function checkerPrefix(): string[] {
  return [process.execPath, ...process.execArgv, resolve(process.argv[1] ?? 'tokenwise'), 'evolve']
}

export async function evolve(args: {
  learner?: string; profile?: string; since?: string; maxCases?: number; timeout?: string; dryRun?: boolean; json?: boolean
}): Promise<number> {
  const context = cliContext()
  const since = args.since === undefined ? undefined : parseDuration(args.since)
  const timeoutMs = args.timeout === undefined ? 30 * 60_000 : parseDuration(args.timeout)
  if (args.since !== undefined && since === undefined || timeoutMs === undefined) {
    process.stderr.write('tokenwise evolve: durations look like 30m, 12h or 7d\n')
    return 2
  }
  if (!args.learner) { process.stderr.write(`tokenwise evolve: choose a learner with --learner ${Object.keys(LEARNERS).join('|')}|"<command>"\n`); return 2 }
  const preset = LEARNERS[args.learner]
  const custom = preset === undefined
  const argv = custom ? [args.learner.replaceAll('{prompt}', shellQuote(LEARNER_INSTRUCTION))] : preset(LEARNER_INSTRUCTION, args.profile === undefined ? {} : { profile: args.profile })
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let result
  try {
    result = await runEvolution(toEvolveContext(context), {
      learner: { argv, shell: custom, label: custom ? 'custom command' : args.learner }, checker: checkerPrefix(), host: 'cli', timeoutMs, echo: true,
      signal: abort.signal, ...args.dryRun ? { dryRun: true } : {},
      ...since === undefined ? {} : { since }, ...args.maxCases === undefined ? {} : { maxCases: args.maxCases },
    })
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  if (!result) { process.stderr.write('tokenwise evolve: another learning run is in progress (see /tokenwise in pi or DSH, or try again later)\n'); return 1 }
  if (result.outcome.result === 'nothing-to-learn' || result.outcome.result === 'cancelled') {
    process.stderr.write(`tokenwise evolve: ${result.evidence} observations as evidence, ${result.shown} shown to the learner; workspace ${result.workspace}\n`)
    if (result.outcome.result === 'cancelled') process.stderr.write('tokenwise evolve: cancelled; nothing adopted\n')
    else process.stderr.write('tokenwise evolve: nothing to learn from yet: no recorded output with tokens left to save. Use TokenWise for a while and try again.\n')
    if (args.json) process.stdout.write(JSON.stringify({ accepted: false, reasons: [result.outcome.result], cases: result.evidence, adopted: null, workspace: result.workspace }, null, 2) + '\n')
    return result.outcome.result === 'cancelled' ? 1 : 0
  }
  process.stderr.write(`tokenwise evolve: ${result.evidence} observations as evidence, ${result.shown} shown to the learner; workspace ${result.workspace}\n`)
  if (result.learnerExit === null) process.stderr.write(`tokenwise evolve: the learner did not run (see ${resolve(result.runDir, 'learner.log')})\n`)
  else if (result.learnerExit !== undefined && result.learnerExit !== 0) process.stderr.write(`tokenwise evolve: the learner exited with ${result.learnerExit}; verified what it left\n`)
  if (!result.report) {
    process.stdout.write(`NOT ACCEPTED: ${result.error}\n`)
    return 1
  }
  const report = result.report
  if (args.json) process.stdout.write(JSON.stringify({ ...report, adopted: result.adopted, workspace: result.workspace }, null, 2) + '\n')
  else {
    process.stdout.write(describeReport(report))
    process.stdout.write(result.adopted ? `adopted rules ${result.adopted.slice(0, 12)}; sessions use them from their next output on (undo: tokenwise rules rollback)\n`
      : report.accepted ? 'dry run: nothing adopted\n' : `kept the current rules${result.parent ? ` ${result.parent.slice(0, 12)}` : ' (none)'}\n`)
  }
  return report.accepted || report.reasons.includes('unchanged') ? 0 : 1
}

/** `tokenwise evolve check --workspace W`: the learner's checker. */
export function evolveCheck(workspace: string | undefined, json: boolean): number {
  if (!workspace) { process.stderr.write('tokenwise evolve check: --workspace must be an tokenwise evolve workspace\n'); return 2 }
  const result = workspaceCheck(toEvolveContext(cliContext()), resolve(workspace), json)
  ;(result.code === 2 ? process.stderr : process.stdout).write(result.code === 2 ? `tokenwise evolve ${result.text}` : result.text)
  return result.code
}

/** `tokenwise evolve try --workspace W <case file>`: what rules-work delivers for one case. */
export function evolveTry(workspace: string | undefined, caseFile: string | undefined): number {
  if (!workspace || !caseFile) { process.stderr.write('tokenwise evolve try: --workspace W <cases/NNNN.json>\n'); return 2 }
  const result = workspaceTry(workspace, caseFile)
  process.stdout.write(result.text)
  return result.code
}

/** `tokenwise rules`: what is adopted, and switching. */
export function rules(action: string | undefined, json: boolean): number {
  const context = cliContext()
  const store = new RuleStore(context.dataDir)
  const state = store.state()
  switch (action ?? 'list') {
    case 'list': {
      if (json) { process.stdout.write(JSON.stringify(state, null, 2) + '\n'); return 0 }
      if (state.history.length === 0) { process.stdout.write('No learned rules yet. Run `tokenwise evolve --learner <agent>` to learn some.\n'); return 0 }
      process.stdout.write(`active: ${state.active ? state.active.slice(0, 12) : 'none (learned rules are off)'}${context.loaded.config.economy.learnedRules ? '' : ' — disabled by output.learnedRules: false'}\n`)
      for (const item of [...state.history].reverse()) {
        process.stdout.write(`  ${item.hash.slice(0, 12)}  ${item.adoptedAt}  ${item.rules} rule${item.rules === 1 ? '' : 's'}${item.gainTokens === undefined ? '' : `, +${formatTokens(item.gainTokens)} tokens on ${item.cases} observations`}${item.hash === state.active ? '  (active)' : ''}\n`)
      }
      return 0
    }
    case 'show': {
      if (!state.active) { process.stdout.write('No learned rules are active.\n'); return 0 }
      for (const file of store.files(state.active)) process.stdout.write(`--- ${file.path}\n${file.text}${file.text.endsWith('\n') ? '' : '\n'}`)
      return 0
    }
    case 'path': process.stdout.write(`${state.active ? store.dirOf(state.active) : store.root}\n`); return 0
    case 'off': store.deactivate(); process.stdout.write('Learned rules are off for new sessions (tokenwise rules on switches the last adopted rules back on).\n'); return 0
    case 'on': {
      if (state.active) { process.stdout.write(`Rules ${state.active.slice(0, 12)} are already active.\n`); return 0 }
      const last = store.rollback()
      process.stdout.write(last ? `Active rules are now ${last.slice(0, 12)}.\n` : 'No learned rules have been adopted yet.\n')
      return 0
    }
    case 'rollback': {
      if (!state.active) { process.stdout.write('No learned rules are active (tokenwise rules on switches the last adopted ones back on).\n'); return 0 }
      const previous = store.rollback()
      process.stdout.write(previous ? `Active rules are now ${previous.slice(0, 12)}.\n` : 'No learned rules are active now.\n')
      return 0
    }
    default: process.stderr.write('tokenwise rules [list|show|path|off|on|rollback] [--json]\n'); return 2
  }
}

