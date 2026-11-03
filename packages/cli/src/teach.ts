/**
 * `tokenwise checkup`, `tokenwise teach` and `tokenwise preview`: the
 * commands the tokenwise skill runs when a person looks at what TokenWise
 * does for them, or teaches it about a command in their own agent. Plain
 * text for the agent to retell in the person's language; --json for the rest.
 */
import { checkup, currentTeach, describeReport, dropTeach, keepTeach, preview, startTeach, workspaceCheck } from '@tokenwise/mechanisms'
import type { NoisyCommand, Preview, VerificationReport } from '@tokenwise/mechanisms'
import { homedir } from 'node:os'
import { cliContext } from './context.ts'
import { checkerPrefix, toEvolveContext } from './evolve.ts'

const out = (text: string) => { process.stdout.write(text.endsWith('\n') ? text : `${text}\n`) }
const percent = (share: number) => `${Math.round(share * 100)}%`
const lines = (text: string) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

/** A command as the person would recognize it: their home directory as ~. */
const shown = (command: string) => { const home = homedir(); return command.startsWith(`${home}/`) ? `~${command.slice(home.length)}` : command }

function worthList(worth: readonly NoisyCommand[]): string[] {
  return worth.map((item, i) => `  ${i + 1}. ${shown(item.command).padEnd(18)} `
    + (item.outputs === item.total
      ? `${plural(item.outputs, 'output')}, about ${plural(item.lines, 'line')} each; the model reads ${percent(item.readShare)} of them now`
      : `${item.outputs} of its ${plural(item.total, 'output')} still come back long, about ${plural(item.lines, 'line')} each; the model reads ${percent(item.readShare)} of those`))
}

export function checkupCommand(json: boolean): number {
  const result = checkup(toEvolveContext(cliContext()))
  if (json) { out(JSON.stringify(result, null, 2)); return 0 }
  const text: string[] = []
  if (result.outputs === 0) {
    out('TokenWise checkup: no shell output recorded yet. Use your agents as usual and look again later.')
    return 0
  }
  text.push(`TokenWise checkup: ${plural(result.outputs, 'shell output')} from ${result.hosts.join(', ')}${result.since ? ` since ${result.since.slice(0, 10)}` : ''}.`, '')
  text.push(result.shortened.outputs
    ? `Already shortened: ${plural(result.shortened.outputs, 'output')}; the model read ${percent(result.shortened.readShare)} of their original`
      + `${result.shortened.byLearnedRules ? ` (${result.shortened.byLearnedRules} of them by learned rules)` : ''}.`
    : 'Nothing shortened yet.')
  const taught = result.rules.filter(rule => rule.taught).length
  if (result.rules.length) {
    text.push('', `Learned rules in use: ${result.rules.length} (${taught} you taught, ${result.rules.length - taught} learned in the background).`)
    for (const rule of result.rules) {
      text.push(`  ${rule.id.padEnd(28)} ${rule.taught ? 'taught by you' : 'learned'}${rule.command ? `, for ${rule.command}` : ''}; shortened ${plural(rule.uses, 'output')}`)
    }
  } else text.push('', 'No learned rules in use yet.')
  if (result.worth.length) {
    text.push('', 'Worth teaching (output TokenWise still leaves long):', ...worthList(result.worth), '', `Teach one: tokenwise teach "${result.worth[0]!.command}"`)
  } else text.push('', 'Nothing worth teaching right now: TokenWise already shortens the long output it has seen.')
  out(text.join('\n'))
  return 0
}

/** One line on a verdict, for the person: what passing means, or why it did not pass. */
function verdict(report: VerificationReport | undefined, error: string | undefined): string {
  if (!report) return `Check: the rule does not load (${error ?? 'unknown'}).`
  if (!report.accepted) return `Check: NOT ACCEPTED yet.\n${describeReport(report, { learner: true }).trimEnd()}`
  const g = report.generalization
  return 'Check: ACCEPTED. It keeps every error and failure, saves on the outputs it changes and costs nothing on any other'
    + (g?.status === 'confirmed' ? `, and also saves on ${plural(g.heldOutCases, 'recorded output')} it was not shown.` : '.')
}

function excerpt(text: string, max: number): string {
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all.length <= max ? all.join('\n') : `${all.slice(0, max).join('\n')}\n[… ${all.length - max} more lines]`
}

function printPreview(result: Preview, teaching: boolean): void {
  const { example } = result
  const original = lines(example.original), now = lines(example.now)
  const text = [`\`${result.command}\`: one recorded output (${example.time.slice(0, 10)}, exit ${example.exitCode ?? '?'}), before and after.`,
    `  original:             ${plural(original, 'line')}`,
    `  the model reads now:  ${now === original && example.now === example.original ? `${plural(now, 'line')} (all of it)` : plural(now, 'line')}`]
  if (teaching && example.after !== undefined) text.push(`  with the new rule:    ${plural(lines(example.after), 'line')}`)
  text.push('', `--- original, first lines (${plural(original, 'line')}) ---`, excerpt(example.original, 12))
  const shown = teaching && example.after !== undefined ? example.after : example.now
  text.push('', `--- what the model ${teaching ? 'would read with the new rule' : 'reads now'} ---`, excerpt(shown, 80), '---', '')
  text.push(teaching && result.readShareAfter !== undefined
    ? `Over all ${plural(result.outputs, 'recorded output')} of ${result.command}, the model would read ${percent(result.readShareAfter)} of the original instead of ${percent(result.readShareNow)}.`
    : `Over all ${plural(result.outputs, 'recorded output')} of ${result.command}, the model reads ${percent(result.readShareNow)} of the original.`)
  if (teaching) text.push(verdict(result.report, result.error), '', 'Keep it: tokenwise teach keep    Discard it: tokenwise teach drop')
  out(text.join('\n'))
}

export function previewCommand(command: string | undefined, json: boolean): number {
  const result = preview(toEvolveContext(cliContext()), command)
  if ('error' in result && !('example' in result)) { process.stderr.write(`tokenwise preview: ${result.error}\n`); return 1 }
  if (json) out(JSON.stringify(result, null, 2))
  else printPreview(result as Preview, false)
  return 0
}

export function teachCommand(action: string | undefined, rest: readonly string[], json: boolean): number {
  const context = toEvolveContext(cliContext())
  switch (action) {
    case undefined: case 'status': {
      const state = currentTeach(context.dataDir)
      out(state ? `Teaching TokenWise about \`${state.command}\` (started ${state.startedAt}). Workspace: ${state.workspace}`
        : 'Nothing is being taught. Start with: tokenwise teach "<command>" (tokenwise checkup lists the ones worth it)')
      return 0
    }
    case 'check': {
      const state = currentTeach(context.dataDir)
      if (!state) { process.stderr.write('tokenwise teach check: nothing is being taught\n'); return 1 }
      const result = workspaceCheck(context, state.workspace, json)
      out(result.text)
      return result.code
    }
    case 'preview': {
      const result = preview(context, undefined, { teach: true })
      if (!('example' in result)) { process.stderr.write(`tokenwise teach preview: ${result.error}\n`); return 1 }
      if (json) out(JSON.stringify(result, null, 2))
      else printPreview(result, true)
      return 0
    }
    case 'keep': {
      const result = keepTeach(context)
      if (json) { out(JSON.stringify(result, null, 2)); return result.kept ? 0 : 1 }
      if (!result.kept) {
        out(`Not kept: ${result.reason}.${result.report ? `\n${describeReport(result.report, { learner: true }).trimEnd()}` : ''}`)
        return 1
      }
      out(`Kept. From the next command on, every agent reads the shorter \`${result.command}\` output `
        + `(${result.rules.length === 1 ? `rule ${result.rules[0]}` : `rules ${result.rules.join(', ')}`}; you have taught TokenWise ${plural(result.taughtTotal, 'rule')}).\n`
        + 'Undo: tokenwise rules rollback')
      return 0
    }
    case 'drop': out(dropTeach(context.dataDir) ? 'Discarded the rule being taught.' : 'Nothing was being taught.'); return 0
    default: {
      const command = [action, ...rest].join(' ').trim()
      const started = startTeach(context, command, checkerPrefix())
      if (json) { out(JSON.stringify(started, null, 2)); return started.ok ? 0 : 1 }
      if (!started.ok) {
        const why = started.reason === 'no-output' ? `No recorded output of \`${started.command}\` is kept (originals are kept for ${started.retentionDays} days).`
          : started.reason === 'reads-files' ? `\`${started.command}\` prints file contents the agent asked to read, so every line can matter: TokenWise does not learn rules for it.`
          : started.reason === 'looks-up' ? `\`${started.command}\` prints what the agent asked to see (search results, listings, diffs), so any line can be the answer: TokenWise does not learn rules for it.`
          : started.reason === 'too-short' ? `\`${started.command}\` prints only a few lines, so there is nothing worth teaching.`
          : `TokenWise already shortens \`${started.command}\` to under half of its original, so there is nothing to teach.`
        out([why, ...started.worth.length ? ['', 'Worth teaching instead:', ...worthList(started.worth)] : []].join('\n'))
        return 1
      }
      const ws = started.state.workspace
      out([`Teaching TokenWise about \`${started.state.command}\`: ${plural(started.outputs, 'recorded output')}; ${started.shown} to study, `
        + `${started.heldOut} held back to test the rule.`,
      `Workspace: ${ws}`,
      `  1. Read ${ws}/PROMPT.md and write the rule in ${ws}/rules-work/.`,
      '  2. Check it:                 tokenwise teach check',
      '  3. Show the person:          tokenwise teach preview',
      '  4. Keep it when they agree:  tokenwise teach keep    (or discard: tokenwise teach drop)'].join('\n'))
      return 0
    }
  }
}
