import { toolArgv } from '../command.ts'
import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, EconomyFilterName, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** A row of a newly installed package (`added`), a row with nothing to report (`quiet`, by kind), or any other line. */
type InstallLine = { readonly kind: 'added' } | { readonly kind: 'quiet'; readonly label: string } | undefined

interface InstallSpec {
  readonly name: EconomyFilterName
  readonly commands: (command: string) => boolean
  /** The output must contain a line this matches: the tool's own report. */
  readonly report: RegExp
  /** Classify each line; `named` holds the packages the command line names, whose rows always stay. */
  readonly classify: (lines: readonly SourceLine[], named: ReadonlySet<string>) => (index: number) => InstallLine
  /** The packages the command line names, normalized as `classify` compares them. */
  readonly named: (args: readonly string[]) => readonly string[]
  readonly addedRows: string
  readonly quietRows: Readonly<Record<string, string>>
}

/** A run with at least this many new-package rows is previewed: its first three and last two stay. */
const PREVIEW_MIN = 12
const HEAD = 3
const TAIL = 2

/**
 * In each run of consecutive new-package and quiet rows: quiet rows are
 * dropped when there are three or more, and a list of twelve or more new
 * packages keeps its first three and last two rows. One note at the place of
 * the omitted rows counts each kind and names the command that lists the
 * packages. Lines that mention a problem are never classified.
 */
function foldInstallRuns(stdout: string, spec: InstallSpec, named: ReadonlySet<string>): MappedProjection | undefined {
  const lines = sourceLines(stdout)
  const classify = spec.classify(lines, named)
  const classes = lines.map((line, i) => PROBLEM.test(line.text) ? undefined : classify(i))
  const builder = new ProjectionBuilder(stdout)
  let omitted = 0
  for (let i = 0; i < lines.length;) {
    if (classes[i] === undefined) { builder.keep(lines[i]!.start, lines[i]!.end); i++; continue }
    let end = i
    while (end < lines.length && classes[end] !== undefined) end++
    const added: number[] = []
    const quiet = new Map<string, number>()
    for (let k = i; k < end; k++) {
      const line = classes[k]!
      if (line.kind === 'added') added.push(k)
      else quiet.set(line.label, (quiet.get(line.label) ?? 0) + 1)
    }
    const quietCount = end - i - added.length
    const cut = added.length >= PREVIEW_MIN ? added.length - HEAD - TAIL : 0
    if (cut === 0 && quietCount < 3) {
      for (; i < end; i++) builder.keep(lines[i]!.start, lines[i]!.end)
      continue
    }
    const parts = [cut > 0 ? `${cut} more ${spec.addedRows}` : '', ...[...quiet].map(([label, count]) => `${count} ${spec.quietRows[label]}`)]
    const note = `[${parts.filter(Boolean).join(', ')} omitted]\n`
    const head = cut > 0 ? added.slice(0, HEAD) : added
    for (const k of head) builder.keep(lines[k]!.start, lines[k]!.end)
    builder.newline()
    builder.generate(note, `${spec.name}-folded`)
    if (cut > 0) for (const k of added.slice(-TAIL)) builder.keep(lines[k]!.start, lines[k]!.end)
    omitted += cut + quietCount
    i = end
  }
  return omitted > 0 ? builder.finish() : undefined
}

function installFilter(spec: InstallSpec): EconomyFilter {
  const projectMapped = (input: FilterInput): MappedProjection | undefined => {
    if (!spec.commands(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
    if (!sourceLines(input.stdout).some(line => spec.report.test(line.text))) return undefined
    const argv = toolArgv(input.command)!
    return foldInstallRuns(input.stdout, spec, new Set(spec.named(argv)))
  }
  return { name: spec.name, transformation: 'preview', commands: spec.commands, projectMapped, project: input => projectMapped(input)?.text }
}

/** Positional words after the subcommand at `from`. */
const positional = (argv: readonly string[], from: number) => argv.slice(from).filter(arg => !arg.startsWith('-'))
/** PEP 503 name: `Typing_Extensions` and `typing.extensions` are `typing-extensions`. */
const pythonName = (spec: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(spec)?.[0] ?? '').toLowerCase().replace(/[-_.]+/gu, '-')

/** ` + requests==2.31.0` (a local or URL install, ` + demo==0.1.0 (from file:…)`, stays). */
const UV_ADDED = /^ \+ ([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==[^\s(]+$/u
const UV_REMOVED = /^ - ([A-Za-z0-9][A-Za-z0-9._-]*)/u
/** uv's non-terminal progress for large downloads: `Downloading numpy (15.2MiB)`, ` Downloaded numpy`. */
const UV_DOWNLOAD = /^(?:Downloading \S+ \([\d.]+ ?[KMGT]?i?B\)| ?Downloaded \S+)$/u

/**
 * `uv sync`, `uv pip install` and `uv pip sync` (stderr merged): a list of
 * twelve or more ` + package==version` rows is previewed, and runs of large
 * download progress rows are counted. Removed (` - `) and reinstalled (` ~ `)
 * packages, the new version of each upgraded or named package, the
 * Resolved / Prepared / Installed counts and every other line stay.
 */
export const uvSyncFilter = installFilter({
  name: 'uv-sync',
  commands: command => {
    const argv = toolArgv(command)
    return argv?.[0] === 'uv' && (argv[1] === 'sync' || argv[1] === 'pip' && ['install', 'sync'].includes(argv[2] ?? ''))
  },
  report: /^(?:Resolved|Prepared|Installed|Uninstalled|Audited) \d+ packages? in /u,
  named: argv => argv[1] === 'pip' && argv[2] === 'install' ? positional(argv, 3).map(pythonName) : [],
  classify: (lines, named) => {
    const removed = new Set(lines.flatMap(line => { const name = UV_REMOVED.exec(line.text)?.[1]; return name ? [pythonName(name)] : [] }))
    return i => {
      const text = lines[i]!.text
      const name = UV_ADDED.exec(text)?.[1]
      if (name !== undefined) return removed.has(pythonName(name)) || named.has(pythonName(name)) ? undefined : { kind: 'added' }
      return UV_DOWNLOAD.test(text) ? { kind: 'quiet', label: 'download' } : undefined
    }
  },
  addedRows: '"+" rows of installed packages',
  quietRows: { download: 'download progress rows' },
})

/** `  - Installing certifi (2024.2.2)` (Poetry 1.2+), `  • Installing …` (1.1). */
const POETRY_ADDED = /^ {2}[-•] Installing ([A-Za-z0-9][A-Za-z0-9._-]*) \([^)\s]+\)$/u

/**
 * `poetry install`, `poetry sync` and `poetry update`: a list of twelve or
 * more `Installing` rows is previewed. Updating, Downgrading and Removing
 * rows, rows of the packages the command names, Package operations, the
 * current project's install line and every other line stay.
 */
export const poetryInstallFilter = installFilter({
  name: 'poetry-install',
  commands: command => {
    const argv = toolArgv(command)
    return argv?.[0] === 'poetry' && ['install', 'sync', 'update'].includes(argv[1] ?? '')
  },
  report: /^(?:Installing dependencies from lock file|Updating dependencies|Package operations: \d+ installs?)/u,
  named: argv => positional(argv, 2).map(pythonName),
  classify: (lines, named) => i => {
    const name = POETRY_ADDED.exec(lines[i]!.text)?.[1]
    return name !== undefined && !named.has(pythonName(name)) ? { kind: 'added' } : undefined
  },
  addedRows: '"Installing" rows',
  quietRows: {},
})

const COMPOSER_PACKAGE = String.raw`([a-z0-9][\w.-]*\/[\w.-]+)`
/** `  - Installing psr/log (3.0.0): Extracting archive`. */
const COMPOSER_ADDED = new RegExp(String.raw`^ {2}- Installing ${COMPOSER_PACKAGE} \([^)]+\)(?:: .+)?$`, 'u')
/** Any row that installs a package, so a Downloading or Locking row of it says nothing more. */
const COMPOSER_CHANGE = new RegExp(String.raw`^ {2}- (?:Installing|Upgrading|Downgrading) ${COMPOSER_PACKAGE} \(`, 'u')
const COMPOSER_QUIET = new RegExp(String.raw`^ {2}- (Downloading|Locking) ${COMPOSER_PACKAGE} \([^)]+\)$`, 'u')

/**
 * `composer install`, `update` and `require`: Downloading and Locking rows
 * of packages that are then installed are counted, and a list of twelve or
 * more `Installing` rows is previewed. Upgrading, Downgrading and Removing
 * rows, rows of the packages the command names, every Downloading or Locking
 * row of a package not installed after it, and every other line stay.
 */
export const composerInstallFilter = installFilter({
  name: 'composer-install',
  commands: command => {
    const argv = toolArgv(command)
    return argv?.[0] === 'composer' && ['install', 'update', 'require'].includes(argv[1] ?? '')
  },
  report: /^(?:Installing dependencies from lock file|Updating dependencies|Package operations: |Lock file operations: )/u,
  named: argv => positional(argv, 2).map(arg => arg.split(':')[0]!.toLowerCase()),
  classify: (lines, named) => {
    const installed = new Set(lines.flatMap(line => { const name = COMPOSER_CHANGE.exec(line.text)?.[1]; return name ? [name] : [] }))
    return i => {
      const text = lines[i]!.text
      const added = COMPOSER_ADDED.exec(text)?.[1]
      if (added !== undefined) return named.has(added) ? undefined : { kind: 'added' }
      const quiet = COMPOSER_QUIET.exec(text)
      return quiet && installed.has(quiet[2]!) ? { kind: 'quiet', label: quiet[1]! } : undefined
    }
  },
  addedRows: '"Installing" rows',
  quietRows: { Downloading: '"Downloading" rows of packages installed in this run', Locking: '"Locking" rows of packages installed in this run' },
})

/** `Using rake 13.1.0`, `Using nokogiri 1.16.0 (arm64-darwin)`, `Using app 0.1.0 from source at \`.\``. */
const BUNDLE_USING = /^Using (\S+) (\S+)(?: \([^)]*\))?(?: from .+)?$/u
const BUNDLE_INSTALLING = /^Installing (\S+) (\S+)(?: \([^)]*\))?(?: with native extensions)?$/u
const BUNDLE_FETCHING = /^Fetching (\S+) (\S+)(?: \([^)]*\))?$/u
/** A version change, `(was 1.2.0)`: always kept. */
const WAS = /\(was /u

/**
 * `bundle install` and `bundle update`: `Using` rows of gems already
 * installed and `Fetching` rows of gems then installed are counted, and a
 * list of twelve or more `Installing` rows is previewed. Every version change
 * (`(was …)`), rows of the gems the command names, Bundle complete, post-install
 * messages and every other line stay.
 */
export const bundleInstallFilter = installFilter({
  name: 'bundle-install',
  commands: command => {
    const argv = toolArgv(command)
    return argv?.[0] === 'bundle' && (argv.length === 1 || ['install', 'update'].includes(argv[1] ?? ''))
  },
  report: /^Bundle (?:complete|updated)!/u,
  named: argv => positional(argv, 2),
  classify: (lines, named) => {
    const installing = new Set(lines.flatMap(line => { const name = BUNDLE_INSTALLING.exec(line.text)?.[1]; return name ? [name] : [] }))
    return i => {
      const text = lines[i]!.text
      if (WAS.test(text)) return undefined
      const using = BUNDLE_USING.exec(text)?.[1]
      if (using !== undefined) return named.has(using) ? undefined : { kind: 'quiet', label: 'using' }
      const added = BUNDLE_INSTALLING.exec(text)?.[1]
      if (added !== undefined) return named.has(added) ? undefined : { kind: 'added' }
      const fetching = BUNDLE_FETCHING.exec(text)?.[1]
      return fetching !== undefined && installing.has(fetching) ? { kind: 'quiet', label: 'fetching' } : undefined
    }
  },
  addedRows: '"Installing" rows',
  quietRows: { using: '"Using" rows of gems already installed', fetching: '"Fetching" rows of gems installed in this run' },
})
