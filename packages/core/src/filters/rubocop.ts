import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { groupFileRows } from './file-groups.ts'
import { NOT_PLAIN } from './noise.ts'

/** `app/models/user.rb:3:3: C: [Correctable] Style/Documentation: …` (progress and clang formatters). */
const OFFENSE = /^([^\s:][^:]*):\d+:\d+: [CWEFRI]: /u
/** The highlight under an offense's source line. */
const CARET = /^ *\^+$/u
const SUMMARY = /^\d+ files? inspected, (?:no offenses|\d+ offenses?) detected/u

const isRubocop = (command: string) => toolArgv(command)?.[0] === 'rubocop'

/**
 * RuboCop's default (progress) output: runs of three or more consecutive
 * offenses in one file are listed under the file's name, each offense keeping
 * its line, column, severity, cop and message, and its source line and
 * highlight verbatim. The progress line, the summary and every other line stay.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!isRubocop(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  if (!sourceLines(input.stdout).some(line => SUMMARY.test(line.text))) return undefined
  return groupFileRows(input.stdout, {
    row: text => {
      const path = OFFENSE.exec(text)?.[1]
      return path === undefined ? undefined : { path, rest: path.length + 1 }
    },
    // The source line and its highlight, when RuboCop prints them.
    attached: (lines, index) => CARET.test(lines[index + 2]?.text ?? '') && !OFFENSE.test(lines[index + 1]!.text) ? 2 : 0,
    header: ['[offenses in ', ']\n'],
    label: 'rubocop-file-group',
  })
}

export const rubocopFilter: EconomyFilter = {
  name: 'rubocop', transformation: 'lossless-formatting', commands: isRubocop, projectMapped,
  project: input => projectMapped(input)?.text,
}
