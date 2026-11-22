import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { commandIs, NOT_PLAIN, noiseFilter, PROBLEM } from './noise.ts'

// ——— brew install / upgrade ———

/**
 * Download chatter: the download queue's status rows (`✔︎ Bottle Manifest jq (1.7.1)`, one per
 * bottle, manifest, resource, patch or cask), its headings, and the older serial
 * `==> Fetching jq` / `==> Downloading https://…` / `Already downloaded: …` rows.
 * A failed download (`✘ …`) does not match.
 */
const BREW_DOWNLOAD = [
  /^✔︎? (?:Bottle Manifest|Bottle|Formula|Resource|Patch|API Source|JSON API|Cask) \S.*$/u,
  /^==> (?:Fetching downloads for: .+|Downloading bottle manifests|Downloading Homebrew API data|Fetching dependencies for \S+: .+|Fetching \S+|Downloading https?:\/\/\S+)$/u,
  /^Already downloaded: \S.*$/u,
  /^#{10,} *100\.0%$/u,
]

/**
 * `brew install` / `upgrade` / `reinstall`: runs of three or more download
 * rows become one counted note. Every `==> Installing`, `==> Pouring`,
 * `==> Upgrading` and summary (`🍺 …`) line, caveats, warnings, errors and
 * failed downloads stay.
 */
export const brewInstallFilter = noiseFilter({
  name: 'brew-install',
  commands: command => commandIs(command, ['brew'], [['install'], ['upgrade'], ['reinstall']]),
  recognize: /^==> \S/u,
  fold: {
    kind: text => BREW_DOWNLOAD.some(pattern => pattern.test(text)) ? 'download' : undefined,
    note: count => `[${count} download lines omitted]\n`,
  },
})

// ——— go-task ———

const UP_TO_DATE = /^task: Task "([^"\n]+)" is up to date$/u

function taskCommand(command: string): boolean {
  return ['task', 'go-task'].includes(toolArgv(command)?.[0] ?? '')
}

/**
 * go-task (`task`): runs of three or more `task: Task "x" is up to date`
 * lines become one note that names every task in the run. Each
 * `task: [name] command` line and all command output stay.
 */
function projectTask(input: FilterInput): MappedProjection | undefined {
  if (!taskCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const names = lines.map(line => PROBLEM.test(line.text) ? undefined : UP_TO_DATE.exec(line.text)?.[1])
  const builder = new ProjectionBuilder(input.stdout)
  let folded = false
  for (let i = 0; i < lines.length;) {
    let end = i
    while (end < lines.length && names[end] !== undefined) end++
    if (end - i >= 3) {
      builder.generate(`[${end - i} tasks up to date: ${names.slice(i, end).map(name => `"${name}"`).join(', ')}]\n`, 'go-task-up-to-date')
      folded = true
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  }
  return folded ? builder.finish() : undefined
}

export const goTaskFilter: EconomyFilter = {
  name: 'go-task', transformation: 'noise-removal', projectMapped: projectTask, commands: taskCommand,
  project: input => projectTask(input)?.text,
}

// ——— quarto render ———

/** The headers of the option echo Quarto prints before each pandoc run: `pandoc ` then the options, `metadata` then the document metadata. */
const ECHO_HEADER = /^(?:pandoc ?|metadata)$/u
/** A row of that echo: `  to: html`, a nested value (`    - header.html`), or the blank `  ` line that ends a section. */
const ECHO_ROW = /^ {2}[A-Za-z][\w-]*:(?: .*)?$|^ {4}\S.*$|^ {0,2}$/u
/** A Jupyter cell that ran: `  Cell 2/5: 'plot'.......Done`. */
const CELL_DONE = /^ {2}Cell \d+\/\d+: '[^']*'\.+Done$/u
const FOLD_MIN = 3

function quartoCommand(command: string): boolean {
  return commandIs(command, ['quarto'], [['render']])
}

/**
 * `quarto render`: the pandoc option and metadata echo (one block per output
 * format) and runs of three or more finished Jupyter cell rows become counted
 * notes. `processing file:`, `Executing`, `[n/N]` progress, `Output created:`,
 * every warning, error and unknown line stay. Output without Quarto's own
 * report (`Output created:` or a pandoc echo) passes through.
 */
function projectQuarto(input: FilterInput): MappedProjection | undefined {
  if (!quartoCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  // Which lines belong to an echo block (from its header until a line that is not an echo row) or are finished cells.
  const kinds: (string | undefined)[] = []
  let inEcho = false
  for (const line of lines) {
    if (PROBLEM.test(line.text)) { inEcho = false; kinds.push(undefined); continue }
    if (ECHO_HEADER.test(line.text)) inEcho = true
    else if (inEcho && !ECHO_ROW.test(line.text)) inEcho = false
    kinds.push(inEcho ? 'echo' : CELL_DONE.test(line.text) ? 'cell' : undefined)
  }
  if (!lines.some(line => /^Output created: \S/u.test(line.text)) && !kinds.includes('echo')) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let folded = false
  for (let i = 0; i < lines.length;) {
    const kind = kinds[i]
    let end = i
    if (kind !== undefined) while (end < lines.length && kinds[end] === kind) end++
    // A trailing blank line of an echo block is not worth a note of its own.
    const rows = lines.slice(i, end).filter(line => line.text.trim() !== '').length
    if (kind !== undefined && rows >= FOLD_MIN) {
      builder.generate(kind === 'echo' ? `[${rows} pandoc option and metadata lines omitted]\n` : `[${rows} finished cell lines omitted]\n`, 'quarto-render-folded')
      folded = true
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  }
  return folded ? builder.finish() : undefined
}

export const quartoRenderFilter: EconomyFilter = {
  name: 'quarto-render', transformation: 'noise-removal', projectMapped: projectQuarto, commands: quartoCommand,
  project: input => projectQuarto(input)?.text,
}
