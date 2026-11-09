/**
 * Learning from inside an agent: `tokenwise learn` starts a run in the
 * background (the plugins' /tokenwise:learn commands and the tokenwise skill call
 * it), `tokenwise learn status` and `cancel` follow it, and the startup notice
 * tells the user when recorded output is worth learning from or a run has
 * finished. The run is the same `runEvolution` that `tokenwise evolve` runs in
 * the foreground.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cancelEvolution, formatTokens, LEARNER_INSTRUCTION, LEARNERS, outcomeRules, outcomeSentence, readEvolveStatus, refreshScan, startEvolution,
  takeAnnouncement, takeReadyNotice } from '@tokenwise/mechanisms'
import type { BackgroundOptions } from '@tokenwise/mechanisms'
import { cliContext } from './context.ts'

/** The learning runner next to this CLI: dist/evolve.js, or the TypeScript source under tests. */
function runner(): BackgroundOptions {
  const source = import.meta.url.endsWith('.ts')
  return { runner: fileURLToPath(new URL(source ? './evolve-runner.ts' : './evolve.js', import.meta.url)), node: process.execPath,
    nodeArgs: source ? process.execArgv : [] }
}

/** How each agent's own learn command is spelled, for the notice. */
const LEARN_COMMAND: Readonly<Record<string, string>> = {
  claude: '/tokenwise:learn', codebuddy: '/tokenwise:learn', grok: '/tokenwise:learn', codex: '$tokenwise learn',
}
/** How each agent calls the tokenwise skill. */
const SKILL_COMMAND: Readonly<Record<string, string>> = {
  claude: '/tokenwise', codebuddy: '/tokenwise', grok: '/tokenwise', codex: '$tokenwise', hermes: '/tokenwise', opencode: '@tokenwise',
  copilot: '/tokenwise',
}
/** The agents that show `startupNotice`: through hooks, or (OpenCode, Hermes) their plugin calling `tokenwise notice`. */
export const NOTICE_HOSTS: ReadonlySet<string> = new Set(Object.keys(SKILL_COMMAND))

/** Where each learner keeps its own state. */
function learnerHome(learner: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = homedir()
  switch (learner) {
    case 'dsh': return env.DSH_HOME || join(home, '.dsh')
    case 'codex': return env.CODEX_HOME || join(home, '.codex')
    case 'claude': return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
    case 'codebuddy': return join(home, '.codebuddy')
    case 'grok': return join(home, '.grok')
    case 'pi': return join(home, '.pi')
    default: return undefined
  }
}

/** Throws (EPERM, EACCES) when `dir` exists but cannot be written. */
function checkWritable(dir: string | undefined): void {
  if (dir === undefined || !existsSync(dir)) return
  const probe = join(dir, `.tokenwise-write-check-${process.pid}`)
  writeFileSync(probe, '')
  rmSync(probe, { force: true })
}

export function learnStart(learner: string | undefined): number {
  const preset = learner === undefined ? undefined : LEARNERS[learner]
  if (!learner || !preset) {
    process.stderr.write(`tokenwise learn: choose the agent that learns with --learner ${Object.keys(LEARNERS).join('|')}\n`)
    return 2
  }
  // Started from an agent's sandbox, the learner inherits it: check it can write its own state first (an
  // error here asks, via main, for the command to be run again outside the sandbox).
  checkWritable(learnerHome(learner, process.env))
  const { dataDir } = cliContext()
  const started = startEvolution(dataDir, { ...runner(), host: 'cli', learner: { argv: preset(LEARNER_INSTRUCTION, {}), shell: false, label: learner } })
  if ('error' in started) {
    process.stdout.write(started.error === 'running' ? 'A learning run is already in progress: tokenwise learn status\n' : 'The learning run did not start.\n')
    return 1
  }
  process.stdout.write(`Learning with ${learner} in the background (at most 20 minutes). It reads up to 40 recorded outputs from this machine, `
    + `which go to ${learner}'s model provider, and adopts rules only if they are verified. Follow it with: tokenwise learn status\n`)
  return 0
}

export function learnStatus(): number {
  const { dataDir } = cliContext()
  const status = readEvolveStatus(dataDir)
  const lines: string[] = []
  const run = status.run
  if (run?.running) lines.push(`Learning with ${run.learner}: ${run.phase} (started ${run.startedAt}).`)
  else if (run?.outcome) lines.push(`Last run (${run.learner}, ${run.finishedAt ?? run.startedAt}): ${outcomeSentence(run.outcome)}.`)
  else lines.push('No learning run yet.')
  const rules = status.rules
  lines.push(rules.active ? `Learned rules in use: ${rules.rules.map(rule => rule.id).join(', ') || 'none'}.` : 'No learned rules in use.')
  const ready = status.scan?.ready ? status.scan.opportunities.slice(0, 3) : []
  if (ready.length) lines.push(`Worth learning from: ${ready.map(item => `${item.command} (${item.cases} outputs, ${formatTokens(item.leftTokens)} tokens left)`).join('; ')}.`)
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

export function learnCancel(): number {
  process.stdout.write(cancelEvolution(cliContext().dataDir) ? 'Stopping the learning run.\n' : 'No learning run in progress.\n')
  return 0
}

/**
 * At an agent's startup: refresh the evidence scan in the background, then say
 * once when a learning run finished or when recorded output became worth
 * learning from. Undefined when there is nothing to say.
 */
export function startupNotice(host: string, env: NodeJS.ProcessEnv = process.env, options: { peek?: boolean } = {}): string | undefined {
  // A learner's own session (and a disabled TokenWise) says nothing.
  if (env.TOKENWISE_DISABLE === '1') return undefined
  const { dataDir } = cliContext({ env })
  try { refreshScan(dataDir, { ...runner(), env }) } catch { /* The notice uses the last scan. */ }
  const skill = SKILL_COMMAND[host] ?? 'the tokenwise skill'
  // A peek leaves the notice to be told (a host that is not sure it can show it asks again once it has).
  const peek = options.peek === true
  const done = takeAnnouncement(dataDir, host, peek)
  if (done?.outcome?.result === 'adopted') {
    // The commands it now shortens better, as the checker found them; else the rules.
    const commands = done.outcome.generalization?.commands ?? []
    const what = commands.length ? `output from ${commands.slice(0, 3).join(', ')} is now shorter` : `${outcomeRules(done.outcome).join(', ')} now shorten output`
    return `TokenWise learned something about your project: ${what} for every agent. See the before and after with ${skill}.`
  }
  if (done?.outcome) return `TokenWise learning: ${outcomeSentence(done.outcome)}.`
  const ready = takeReadyNotice(dataDir, host, peek)
  if (!ready?.length) return undefined
  const names = ready.slice(0, 3).map(item => item.command).join(', ')
  // OpenCode and Hermes cannot be learners: the skill picks one when asked.
  const learn = LEARN_COMMAND[host] ?? (Object.hasOwn(LEARNERS, host) ? `tokenwise learn --learner ${host}` : undefined)
  return `TokenWise: output from ${names} keeps coming back long. Teach TokenWise about it with ${skill}`
    + (learn ? `, or let it learn in the background with ${learn}.` : '.')
}
