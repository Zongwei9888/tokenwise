import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { foldMarked } from './build-folds.ts'
import { NOT_PLAIN } from './noise.ts'

/** `> Task :app:compileJava`, with the outcome Gradle prints for a task that did no work. */
const TASK = /^> Task :[\w.-]*(?::[\w.-]+)*(?: (UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE))?$/u
const CONFIGURE = /^> Configure project :[\w.:-]*$/u
/** The first and last lines of the message a new Gradle version prints once per user home. */
const WELCOME = /^Welcome to Gradle ([\w.-]+)!$/u
const WELCOME_END = /^For more details see https:\/\/docs\.gradle\.org\/\S+\/release-notes\.html$/u
/** Gradle's standard advice under `* Try:` (7.x on one line, 8.x one `>` row per sentence), and its help link. */
const ADVICE = /^(?:> )?(?:Run with --[\w-]+(?: or --[\w-]+)?(?: option)? to (?:get|generate) [^.]*\.(?: |$))+$/u
const HELP = /^(?:\* |> )Get more help at https:\/\/help\.gradle\.org\.?$/u
/** Artifact downloads, which Gradle 4 printed in plain console output. */
const DOWNLOAD = /^Download https?:\/\/\S+$/u
const RESULT = /^BUILD (?:SUCCESSFUL|FAILED) in \S+$/u

export function isGradleCommand(command: string): boolean {
  return ['gradle', 'gradlew'].includes(toolArgv(command)?.[0] ?? '')
}

/**
 * What each line of a plain-console Gradle log is, when it is a kind the
 * agent does not need: `task` (a task or project-configuration header with
 * nothing printed under it), `welcome`, `advice` or `download`. Undefined for
 * every other line.
 */
export function gradleNoise(lines: readonly SourceLine[]): (string | undefined)[] {
  const marks: (string | undefined)[] = lines.map(() => undefined)
  const nextText = (i: number): string | undefined => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.text.trim() !== '') return lines[j]!.text
    return undefined
  }
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text
    const task = TASK.exec(text)
    if (task?.[1] !== undefined) { marks[i] = 'task'; continue }
    if (task || CONFIGURE.test(text)) {
      // A header with lines under it says which task printed them: it stays.
      const next = nextText(i)
      if (next === undefined || next.startsWith('> Task :') || CONFIGURE.test(next) || RESULT.test(next)) marks[i] = 'task'
      continue
    }
    if (WELCOME.test(text)) {
      let end = i + 1
      while (end < lines.length && end - i < 30 && !WELCOME_END.test(lines[end]!.text)) end++
      if (end < lines.length && WELCOME_END.test(lines[end]!.text)) {
        for (let j = i; j <= end; j++) marks[j] = 'welcome'
        i = end
      }
      continue
    }
    if (text === '* Try:') {
      let end = i + 1
      while (end < lines.length && (ADVICE.test(lines[end]!.text) || HELP.test(lines[end]!.text))) end++
      // The header goes only when every line under it is the standard advice.
      if (end > i + 1 && (end === lines.length || lines[end]!.text.trim() === '' || lines[end]!.text.startsWith('* '))) marks[i] = 'advice'
      continue
    }
    if (ADVICE.test(text) || HELP.test(text)) marks[i] = 'advice'
    else if (DOWNLOAD.test(text)) marks[i] = 'download'
  }
  return marks
}

const OUTCOMES = ['UP-TO-DATE', 'NO-SOURCE', 'SKIPPED', 'FROM-CACHE'] as const

/** The note for a folded run of `gradleNoise` lines. */
export function gradleNote(count: number, kind: string, texts: readonly string[]): string {
  if (kind === 'welcome') return `[${count} lines of the Gradle ${WELCOME.exec(texts[0] ?? '')?.[1] ?? ''} welcome message omitted]\n`
  if (kind === 'advice') return `[${count} lines of Gradle's standard --stacktrace/--info/--scan advice omitted]\n`
  if (kind === 'download') return `[${count} Gradle download lines omitted]\n`
  const tally = new Map<string, number>()
  for (const text of texts) {
    const outcome = CONFIGURE.test(text) ? 'project configuration' : OUTCOMES.find(word => text.endsWith(` ${word}`)) ?? 'ran'
    tally.set(outcome, (tally.get(outcome) ?? 0) + 1)
  }
  return `[${count} Gradle task rows with nothing printed under them omitted: ${[...tally].map(([outcome, n]) => `${n} ${outcome}`).join(', ')}]\n`
}

/**
 * Gradle in plain console output (what an agent's shell gets): runs of task
 * rows that printed nothing (`UP-TO-DATE`, `NO-SOURCE`, executed with no
 * output) become one counted note with their outcomes, and so do the
 * once-per-version welcome message, the standard `* Try:` advice and Gradle
 * 4's download lines. A task header with output under it, every FAILED task,
 * compiler and test output, FAILURE sections, BUILD status and the
 * actionable-task summary stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isGradleCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => RESULT.test(line.text))) return undefined
  return foldMarked(input.stdout, lines, gradleNoise(lines), { note: gradleNote, label: 'gradle-folded' })
}

export const gradleFilter: EconomyFilter = {
  name: 'gradle', transformation: 'noise-removal', commands: isGradleCommand, projectMapped,
  project: input => projectMapped(input)?.text,
}
