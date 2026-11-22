import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, commandIs } from './noise.ts'

/** The line ty adds to every diagnostic to say why its rule is on. */
const RULE_ORIGIN = /^info: rule `[a-z0-9-]+` (?:is enabled by default|was selected .+)$/u
const DIAGNOSTIC = /^(?:error|warning|info)\[[a-z0-9-]+\]: /u
const SUMMARY = /^Found \d+ diagnostics?$/u

const isTyCheck = (command: string) => commandIs(command, ['ty'], [['check']])

/**
 * `ty check` (full output): every diagnostic ends with a line saying why its
 * rule is enabled, the same line for every diagnostic of that rule. The first
 * such line of each rule stays; later identical ones are dropped and counted
 * in one note at the end. Every diagnostic, snippet, hint and the summary stay.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isTyCheck(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => SUMMARY.test(line.text)) || !lines.some(line => DIAGNOSTIC.test(line.text))) return undefined
  const seen = new Set<string>()
  const builder = new ProjectionBuilder(input.stdout)
  let dropped = 0
  for (const line of lines) {
    if (RULE_ORIGIN.test(line.text)) {
      if (seen.has(line.text)) { dropped++; continue }
      seen.add(line.text)
    }
    builder.keep(line.start, line.end)
  }
  if (dropped < 3) return undefined
  builder.newline()
  builder.generate(`[${dropped} repeated "info: rule \`…\`" lines omitted; the first one for each rule is kept]\n`, 'ty-rule-origin')
  return builder.finish()
}

export const tyFilter: EconomyFilter = {
  name: 'ty', transformation: 'diagnostic-deduplication', commands: isTyCheck, projectMapped,
  project: input => projectMapped(input)?.text,
}
