import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'

/** A requirement pulled in by another package (`(from requests)`), not one the user named or a requirements file listed (`(from -r …)`). */
const TRANSITIVE = / \(from (?!-[rc] )[^)]*\)/u
const SATISFIED = /^Requirement already satisfied: \S+ in \S/u
const COLLECTING = /^Collecting \S+/u
/** Download detail under `Collecting`, the download phase rows, and pip's final progress bars (rich and legacy). */
const DOWNLOAD = /^\s*(?:Downloading|Using cached) \S+(?: \([\d.]+ [kMGT]?B\))?$/u
const PROGRESS = /^\s+(?:[━╸╺─]+\s+[\d.]+\/[\d.]+ [kMGT]?B\b.*|\|[█▉▊▋▌▍▎▏ ]+\| [\d.]+ [kMGT]?B\b.*)$/u
const DIAGNOSTIC = /error|warn|fail|conflict|deprecat|incompatible|yanked/iu

/** A line pip prints that the agent does not need: resolution and download chatter for packages it did not name. */
function removable(text: string): boolean {
  if (DIAGNOSTIC.test(text)) return false
  if (DOWNLOAD.test(text) || PROGRESS.test(text)) return true
  return (SATISFIED.test(text) || COLLECTING.test(text)) && TRANSITIVE.test(text)
}

/**
 * `pip install` (also `pip3`, `python -m pip`): runs of three or more
 * dependency-resolution and download rows become a counted note. Requirements
 * the user named, `Installing collected packages`, `Successfully installed`,
 * every warning, error and unknown line stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  const argv = toolArgv(input.command)
  if (argv === undefined) return undefined
  const offset = /^pip[\d.]*$/u.test(argv[0] ?? '') ? 1
    : /^python[\d.]*$/u.test(argv[0] ?? '') && argv[1] === '-m' && argv[2] === 'pip' ? 3 : -1
  if (offset < 0 || argv[offset] !== 'install' || ![0, 1].includes(input.exitCode) || /[\u001b\0]|\r(?!\n)/u.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => SATISFIED.test(line.text) || COLLECTING.test(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let removed = 0
  for (let i = 0; i < lines.length;) {
    let end = i
    while (end < lines.length && removable(lines[end]!.text)) end++
    if (end - i >= 3) {
      builder.generate(`[${end - i} dependency resolution and download lines omitted]\n`, 'pip-dependency-lines')
      removed += end - i
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  }
  return removed > 0 ? builder.finish() : undefined
}

export const pipInstallFilter: EconomyFilter = {
  name: 'pip-install', transformation: 'noise-removal',
  commands: command => {
    const argv = toolArgv(command)
    if (argv === undefined) return false
    const offset = /^pip[\d.]*$/u.test(argv[0] ?? '') ? 1 : /^python[\d.]*$/u.test(argv[0] ?? '') && argv[1] === '-m' && argv[2] === 'pip' ? 3 : -1
    return offset > 0 && argv[offset] === 'install'
  },
  project: input => projectMapped(input)?.text, projectMapped,
}
