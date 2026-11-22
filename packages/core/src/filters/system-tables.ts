import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection, SourceLine } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'
import { keepCompactRow, rowWords, splitRow, systemArgv } from './system-layout.ts'
import type { TableRow } from './system-layout.ts'

/** One word, whatever it says. */
const WORD = /^\S+$/u

/** A row split into `checks.length` fields whose words each pass their check, followed by the rest of the line (required unless `bare`). */
function checkedRow(text: string, checks: readonly RegExp[], options: { restAfterOneSpace?: boolean; bare?: boolean } = {}): TableRow | undefined {
  if (PROBLEM.test(text)) return undefined
  const row = splitRow(text, checks.length, options.restAfterOneSpace)
  if (row === undefined || (row.rest === undefined && !options.bare)) return undefined
  return rowWords(text, row).every((word, index) => checks[index]!.test(word)) ? row : undefined
}

// ——— wc ———

const WC_LONG: Readonly<Record<string, string>> = { '--lines': 'l', '--words': 'w', '--bytes': 'c', '--chars': 'm', '--max-line-length': 'L' }

/** How many count columns `wc` prints with these options; undefined for an option this filter does not read. */
function wcColumns(command: string): number | undefined {
  const argv = systemArgv(command)
  if (argv?.[0] !== 'wc') return undefined
  const kinds = new Set<string>()
  for (const arg of argv.slice(1)) {
    if (arg === '--') break
    if (Object.hasOwn(WC_LONG, arg)) kinds.add(WC_LONG[arg]!)
    else if (/^-[lwcmL]+$/u.test(arg)) for (const flag of arg.slice(1)) kinds.add(flag)
    else if (arg.startsWith('-') && arg !== '-') return undefined
  }
  // BSD wc lets -c and -m cancel each other; GNU prints both.
  if (kinds.has('c') && kinds.has('m')) return undefined
  return kinds.size || 3
}

const COUNT = /^\d+$/u

/**
 * `wc` over several files: the padding before and between the counts goes,
 * so `      30      96     978 src/main.rs` reads `30 96 978 src/main.rs`.
 * Each file name (after the one space wc prints before it) and every other
 * line stay as they are. One file's row is left alone: a few spaces are not
 * worth a different layout.
 */
function projectWc(input: FilterInput): MappedProjection | undefined {
  const columns = wcColumns(input.command)
  if (columns === undefined || NOT_PLAIN.test(input.stdout)) return undefined
  const checks = Array.from({ length: columns }, () => COUNT)
  const builder = new ProjectionBuilder(input.stdout)
  let rows = 0
  let dropped = 0
  for (const line of sourceLines(input.stdout)) {
    const row = checkedRow(line.text, checks, { restAfterOneSpace: true, bare: true })
    if (row === undefined) { builder.keep(line.start, line.end); continue }
    rows++
    dropped += keepCompactRow(builder, line, row)
  }
  return rows >= 3 && dropped > 0 ? builder.finish() : undefined
}

export const wcFilter: EconomyFilter = {
  name: 'wc', transformation: 'lossless-formatting', projectMapped: projectWc,
  commands: command => wcColumns(command) !== undefined,
  project: input => projectWc(input)?.text,
}

// ——— df ———

const SIZE = /^(?:\d+(?:[.,]\d+)?[BkKMGTPEZ]?i?|-)$/u
const PERCENT = /^(?:\d+%|-)$/u
/** df column headers (GNU, BSD, macOS) and what a cell under each looks like. */
const DF_COLUMNS: Readonly<Record<string, RegExp>> = {
  Filesystem: WORD, Type: WORD,
  Size: SIZE, Used: SIZE, Avail: SIZE, Available: SIZE, Inodes: SIZE, IUsed: SIZE, IFree: SIZE, iused: SIZE, ifree: SIZE,
  'Use%': PERCENT, Capacity: PERCENT, '%iused': PERCENT, 'IUse%': PERCENT,
}
const DF_BLOCKS = /^(?:\d+[KMG]?|1K)-blocks$/u

function dfCommand(command: string): boolean {
  const argv = systemArgv(command)
  // `--output` picks and orders the columns itself.
  return argv?.[0] === 'df' && !argv.some(arg => arg.startsWith('--output'))
}

/**
 * `df`: the column padding of the header and of each filesystem row goes;
 * the mount point (everything after the last number) stays as it is. A row
 * whose cells do not fit the header (a filesystem name with a space, a
 * wrapped row) stays as it is.
 */
function projectDf(input: FilterInput): MappedProjection | undefined {
  if (!dfCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const header = lines.find(line => line.text.trim() !== '')
  const names = header?.text.trim().split(/ +/u) ?? []
  if (names[0] !== 'Filesystem' || names.at(-2) !== 'Mounted' || names.at(-1) !== 'on') return undefined
  const checks = names.slice(0, -2).map(name => Object.hasOwn(DF_COLUMNS, name) ? DF_COLUMNS[name] : DF_BLOCKS.test(name) ? SIZE : undefined)
  if (checks.length < 2 || checks.some(check => check === undefined)) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let dropped = 0
  for (const line of lines) {
    const row = line === header ? splitRow(line.text, checks.length) : checkedRow(line.text, checks as RegExp[])
    if (row === undefined) builder.keep(line.start, line.end)
    else dropped += keepCompactRow(builder, line, row)
  }
  return dropped > 0 ? builder.finish() : undefined
}

export const dfFilter: EconomyFilter = {
  name: 'df', transformation: 'lossless-formatting', projectMapped: projectDf, commands: dfCommand,
  project: input => projectDf(input)?.text,
}

// ——— du ———

/** `4.0K\tsrc/a/file.txt`; BSD pads the size (` 48K\tsrc`). Groups: padding, size, path. */
const DU_ROW = /^( *)(\d+(?:[.,]\d+)?[BKMGTPEZ]?i?)\t(.+)$/u

function duCommand(command: string): boolean {
  const argv = systemArgv(command)
  // Timestamps go between the size and the path; NUL-separated rows are not lines.
  return argv?.[0] === 'du' && !argv.some(arg => /^--(?:time|null)(?:=|$)|^-[A-Za-z]*0/u.test(arg))
}

/** The directory part of a path (`src/a/` of `src/a/x.txt`); undefined for a bare name or a path ending in `/`. */
function directoryOf(path: string): string | undefined {
  const slash = path.lastIndexOf('/')
  return slash > 0 && slash < path.length - 1 ? path.slice(0, slash + 1) : undefined
}

/**
 * `du`: runs of three or more consecutive rows in one directory are listed
 * under one `[entries in <dir>]` header, each row keeping its size and the
 * rest of its path; the padding BSD puts before a size goes. Every size and
 * path stays, in order.
 */
function projectDu(input: FilterInput): MappedProjection | undefined {
  if (!duCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const rows = lines.map(line => PROBLEM.test(line.text) ? null : DU_ROW.exec(line.text))
  const directories = rows.map(row => row ? directoryOf(row[3]!) : undefined)
  const builder = new ProjectionBuilder(input.stdout)
  let changed = false
  const keepRow = (line: SourceLine, row: RegExpExecArray | null) => {
    if (row && row[1]!.length > 0) changed = true
    builder.keep(line.start + (row?.[1]!.length ?? 0), line.end)
  }
  for (let i = 0; i < lines.length;) {
    const directory = directories[i]
    let end = i + 1
    if (directory !== undefined) while (end < lines.length && directories[end] === directory) end++
    // A header costs about as much as the directory it saves on one row.
    if (directory === undefined || end - i < 3 || (end - i) * (directory.length - 2) <= directory.length + 16) {
      keepRow(lines[i]!, rows[i] ?? null); i++; continue
    }
    const first = lines[i]!, row = rows[i]!
    const path = first.start + row[1]!.length + row[2]!.length + 1
    builder.generate('[entries in ', 'du-layout')
    builder.keep(path, path + directory.length)
    builder.generate(']\n', 'du-layout')
    for (; i < end; i++) {
      const line = lines[i]!, cells = rows[i]!
      const size = line.start + cells[1]!.length
      builder.generate('  ', 'du-layout')
      builder.keep(size, size + cells[2]!.length + 1)
      builder.keep(size + cells[2]!.length + 1 + directory.length, line.end)
    }
    changed = true
  }
  return changed ? builder.finish() : undefined
}

export const duFilter: EconomyFilter = {
  name: 'du', transformation: 'lossless-formatting', projectMapped: projectDu, commands: duCommand,
  project: input => projectDu(input)?.text,
}

// ——— ps ———

const PID = /^\d+$/u
const PERCENTAGE = /^\d+(?:[.,]\d+)?$/u
/** Process columns whose cells are one word each (BSD, macOS and procps headers), and what a cell looks like where that pins the layout. */
const PS_COLUMNS: Readonly<Record<string, RegExp>> = {
  USER: WORD, UID: WORD, RUSER: WORD, RUID: WORD, GID: WORD, PID, PPID: PID, PGID: PID, SESS: WORD, JOBC: WORD,
  '%CPU': PERCENTAGE, '%MEM': PERCENTAGE, VSZ: PID, RSS: PID, TT: WORD, TTY: WORD, STAT: WORD, S: WORD,
  STARTED: WORD, START: WORD, STIME: WORD, TIME: /^(?:\d+-)?\d+(?:[:.]\d+)*$/u,
  C: WORD, CPU: WORD, PRI: WORD, NI: WORD, ADDR: WORD, SZ: WORD, WCHAN: WORD, F: WORD, LWP: WORD, NLWP: WORD, PSR: WORD,
  LIM: WORD, TSIZ: WORD, SL: WORD, RE: WORD, PAGEIN: WORD,
}
const PS_COMMAND = new Set(['COMMAND', 'CMD', 'ARGS'])
/** A listing longer than this keeps its first PS_HEAD and last PS_TAIL rows. */
const PS_PREVIEW_MIN = 80
const PS_HEAD = 30
const PS_TAIL = 10

function psCommand(command: string): boolean {
  const argv = systemArgv(command)
  if (argv?.[0] !== 'ps') return false
  // `-o`/`o`/`-O` and `--format` choose the columns, and a cell may then hold spaces.
  return !argv.slice(1).some((arg, index) => arg.startsWith('--format')
    || (arg.startsWith('-') || index === 0) && /^-?[A-Za-z]*[oO]/u.test(arg))
}

/**
 * `ps`: the column padding of the header and of every row goes; the command
 * (the last column) stays as it is. A listing of more than PS_PREVIEW_MIN
 * processes keeps its first PS_HEAD rows, its last PS_TAIL rows and every
 * zombie or row that mentions a problem; each run of rows left out becomes a
 * counted note saying how to find one (grep or pgrep).
 */
function projectPs(input: FilterInput): MappedProjection | undefined {
  if (!psCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  const headerIndex = lines.findIndex(line => line.text.trim() !== '')
  const header = lines[headerIndex]
  const names = header?.text.trim().split(/ +/u) ?? []
  if (names.length < 2 || !PS_COMMAND.has(names.at(-1)!) || !names.slice(0, -1).every(name => Object.hasOwn(PS_COLUMNS, name))) return undefined
  const checks = names.slice(0, -1).map(name => PS_COLUMNS[name]!)
  const state = names.findIndex(name => name === 'STAT' || name === 'S')
  const rows = lines.map((line, index) => index === headerIndex ? splitRow(line.text, checks.length, false)
    : index > headerIndex ? checkedRow(line.text, checks) : undefined)
  const processes = lines.map((_, index) => index > headerIndex && rows[index] !== undefined)
  const total = processes.filter(Boolean).length
  // Which process rows a long listing leaves out: not the first PS_HEAD, the last PS_TAIL, a zombie or a problem.
  const omit = lines.map(() => false)
  if (total > PS_PREVIEW_MIN) {
    let seen = 0
    for (const [index, line] of lines.entries()) {
      if (!processes[index]) continue
      seen++
      const words = rowWords(line.text, rows[index]!)
      const zombie = (state >= 0 && words[state]!.includes('Z')) || line.text.includes('<defunct>')
      omit[index] = seen > PS_HEAD && seen <= total - PS_TAIL && !zombie
    }
  }
  const builder = new ProjectionBuilder(input.stdout)
  let dropped = 0
  let omitted = 0
  const flush = () => {
    if (omitted === 0) return
    builder.generate(`[${omitted} process rows omitted]\n`, 'ps-omitted-rows')
    omitted = 0
  }
  for (const [index, line] of lines.entries()) {
    if (omit[index]) { omitted++; continue }
    flush()
    const row = rows[index]
    if (row === undefined) builder.keep(line.start, line.end)
    else dropped += keepCompactRow(builder, line, row)
  }
  flush()
  return dropped > 0 || omit.some(Boolean) ? builder.finish() : undefined
}

export const psFilter: EconomyFilter = {
  name: 'ps', transformation: 'preview', projectMapped: projectPs, commands: psCommand,
  project: input => projectPs(input)?.text,
}

// ——— stat ———

const STAT_FILE = /^ *File: /u
const STAT_SIZE = /^ *Size: /u
/** The rows of GNU `stat` and BSD `stat -x` that hold several padded fields. */
const STAT_FIELDS = /^ *(?:Size: |Device: |Mode: \(|Access: \()/u

function statCommand(command: string): boolean {
  const argv = systemArgv(command)
  if (argv?.[0] !== 'stat') return false
  // Any other option prints a custom, terse, file-system or one-line format.
  for (const arg of argv.slice(1)) {
    if (arg === '--') break
    if (arg.startsWith('-') && !['-x', '-L', '--dereference'].includes(arg)) return false
  }
  return true
}

/**
 * GNU `stat` and BSD `stat -x`: in the size, device and permission rows the
 * padding between fields (spaces and tabs) becomes one space and the
 * indentation goes. The `File:` row (a name may hold any spaces), the time
 * rows and every other line stay as they are.
 */
function projectStat(input: FilterInput): MappedProjection | undefined {
  if (!statCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some((line, index) => STAT_FILE.test(line.text) && STAT_SIZE.test(lines[index + 1]?.text ?? ''))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let changed = false
  for (const line of lines) {
    if (!STAT_FIELDS.test(line.text) || PROBLEM.test(line.text)) { builder.keep(line.start, line.end); continue }
    const text = line.text
    let from = text.length - text.trimStart().length
    if (from > 0) changed = true
    for (const run of text.matchAll(/[ \t]+/gu)) {
      const at = run.index
      if (at < from || run[0] === ' ') continue
      changed = true
      const trailing = at + run[0].length === text.length
      builder.keep(line.start + from, line.start + at + (run[0][0] === ' ' && !trailing ? 1 : 0))
      if (run[0][0] !== ' ' && !trailing) builder.generate(' ', 'stat-padding')
      from = at + run[0].length
    }
    builder.keep(line.start + from, line.end)
  }
  return changed ? builder.finish() : undefined
}

export const statFilter: EconomyFilter = {
  name: 'stat', transformation: 'lossless-formatting', projectMapped: projectStat, commands: statCommand,
  project: input => projectStat(input)?.text,
}

// ——— iptables -L ———

const PACKETS = /^\d+[KMGT]?$/u
/** iptables -L column headers and what a cell under each looks like; `opt` pins the layout. */
const IPTABLES_COLUMNS: Readonly<Record<string, RegExp>> = {
  num: PID, pkts: PACKETS, bytes: PACKETS, target: WORD, prot: WORD, opt: /^(?:--|-f|!f)$/u, in: WORD, out: WORD, source: WORD, destination: WORD,
}
const IPTABLES_HEADER = /^ *(?:num +)?(?:pkts +bytes +)?target +prot +opt +(?:in +out +)?source +destination *$/u

function iptablesCommand(command: string): boolean {
  const argv = systemArgv(command)
  if (!['iptables', 'iptables-legacy', 'iptables-nft'].includes(argv?.[0] ?? '')) return false
  const args = argv!.slice(1)
  return args.some(arg => arg === '--list' || /^-[A-Za-z]*L[A-Za-z]*$/u.test(arg))
    && !args.some(arg => arg === '--list-rules' || /^-[A-Za-z]*S/u.test(arg))
}

/**
 * `iptables -L`: the column padding of each chain's header row and of every
 * rule row goes; the match options after the destination stay as they are.
 * Chain lines, blank lines and any row whose cells do not fit the header (a
 * rule with no target) stay as they are.
 */
function projectIptables(input: FilterInput): MappedProjection | undefined {
  if (!iptablesCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let checks: RegExp[] | undefined
  let dropped = 0
  for (const line of sourceLines(input.stdout)) {
    let row: TableRow | undefined
    if (IPTABLES_HEADER.test(line.text)) {
      const names = line.text.trim().split(/ +/u)
      checks = names.map(name => IPTABLES_COLUMNS[name]!)
      row = splitRow(line.text, names.length)
    } else if (line.text.startsWith('Chain ')) checks = undefined
    else if (checks !== undefined && line.text.trim() !== '') row = checkedRow(line.text, checks, { bare: true })
    if (row === undefined) builder.keep(line.start, line.end)
    else dropped += keepCompactRow(builder, line, row)
  }
  return dropped > 0 ? builder.finish() : undefined
}

export const iptablesFilter: EconomyFilter = {
  name: 'iptables', transformation: 'lossless-formatting', projectMapped: projectIptables, commands: iptablesCommand,
  project: input => projectIptables(input)?.text,
}
