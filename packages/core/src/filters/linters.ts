import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, EconomyFilterName, FilterInput } from '../types.ts'
import { globArgv } from './system-layout.ts'
import { NOT_PLAIN } from './noise.ts'
import { groupRecords } from './record-groups.ts'
import type { RecordGroups } from './record-groups.ts'

/** The value of a `-f x` / `--format x` / `--format=x` option, or undefined. */
function formatOption(argv: readonly string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === '--') break
    if (arg === '-f' || arg === '--format') return argv[index + 1] ?? ''
    if (arg.startsWith('--format=')) return arg.slice('--format='.length)
    if (/^-f\S/u.test(arg)) return arg.slice(2)
  }
  return undefined
}

interface LinterSpec {
  readonly name: EconomyFilterName
  readonly tool: string
  /** The output formats whose rows are `records`. */
  readonly formats: readonly (string | undefined)[]
  readonly records: RegExp
}

/**
 * A linter whose report is one diagnostic per row, each starting with its
 * file: consecutive rows of one file are listed under one
 * `[diagnostics in <file>]` header, each row keeping its line number and
 * the whole diagnostic. Every diagnostic, location, summary and unknown
 * line stays, in order.
 */
function linterFilter(spec: LinterSpec): EconomyFilter {
  const groups: RecordGroups = { record: spec.records, open: '[diagnostics in ', close: ']\n', label: `${spec.name}-layout` }
  const commands = (command: string) => {
    const argv = globArgv(command)
    return argv?.[0] === spec.tool && spec.formats.includes(formatOption(argv.slice(1)))
  }
  const projectMapped = (input: FilterInput): MappedProjection | undefined => {
    if (!commands(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
    return groupRecords(input.stdout, groups)
  }
  return {
    name: spec.name, transformation: 'lossless-formatting', projectMapped, commands,
    project: input => projectMapped(input)?.text,
  }
}

/** `path:line:` (gcc-style and parsable reports). */
const LINE_RECORD = /^([^:\r\n\0]+):[1-9]\d*:/u

/** hadolint's default (tty) report: `Dockerfile:3 DL3008 warning: Pin versions in apt get install. …`. */
export const hadolintFilter = linterFilter({
  name: 'hadolint', tool: 'hadolint', formats: [undefined, 'tty'],
  records: /^([^:\r\n\0]+):[1-9]\d* (?:DL|SC)\d+ /u,
})

/** `shellcheck -f gcc`: `deploy.sh:4:10: error: Iterating over ls output is fragile. Use globs. [SC2045]`. */
export const shellcheckFilter = linterFilter({ name: 'shellcheck', tool: 'shellcheck', formats: ['gcc'], records: LINE_RECORD })

/** `yamllint -f parsable`: `config.yml:3:1: [warning] missing document start "---" (document-start)`. */
export const yamllintFilter = linterFilter({ name: 'yamllint', tool: 'yamllint', formats: ['parsable'], records: LINE_RECORD })
