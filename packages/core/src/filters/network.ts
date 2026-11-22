import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { commandIs, NOT_PLAIN, noiseFilter, PROBLEM } from './noise.ts'
import { globArgv } from './system-layout.ts'

// ——— ping ———

/**
 * One echo reply: BSD/macOS and iputils (`64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.157 ms`,
 * `… from localhost (127.0.0.1): …`), macOS ping6 (`16 bytes from ::1, icmp_seq=0 hlim=64 time=0.1 ms`),
 * BusyBox (`seq=0`) and Windows (`Reply from 192.0.2.1: bytes=32 time=14ms TTL=56`). A duplicate
 * (`(DUP!)`) or any other reply detail does not match.
 */
const REPLY = /^\d+ bytes from \S+(?: \([^()\s]+\))?[:,] (?:icmp_)?seq=\d+ (?:ttl|hlim)=\d+ time[=<]\d+(?:\.\d+)? ?ms$|^Reply from \S+: bytes=\d+ time[=<]\d+ms TTL=\d+$/u
/** The statistics block that ends a completed run (BSD, iputils, BusyBox; Windows). */
const STATISTICS = /^--- \S+ ping statistics ---$|^Ping statistics for \S+:$/u

/**
 * `ping`: runs of three or more echo reply rows become one counted note.
 * The PING header, every timeout, unreachable, duplicate or other row, and
 * the statistics (packets sent, received, loss, round-trip times) stay. A
 * run without its statistics (interrupted) passes through.
 */
export const pingFilter = noiseFilter({
  name: 'ping',
  commands: command => commandIs(command, ['ping', 'ping6']),
  recognize: STATISTICS,
  fold: {
    kind: text => REPLY.test(text) ? 'reply' : undefined,
    note: count => `[${count} echo reply lines omitted]\n`,
  },
})

// ——— rsync ———

const SENT = /^sent [\d,.]+ bytes {1,2}received [\d,.]+ bytes {1,2}[\d,.]+ bytes\/sec$/u
const TOTAL = /^total size is [\d,.]+ {1,2}speedup is [\d,.]+$/u
/** A row of the file list: ordinary path characters (`./`, `src/main.c`, `My Notes.txt`), or a symlink `link -> target`. */
const FILE_ROW = /^[\p{L}\p{N}_.@%+~#=,-][\p{L}\p{N}_.@%+~#=,/ ()[\]'&-]*(?: -> \S.*)?$/u
/** rsync's own messages, which can look like paths: never part of a file list run. */
const MESSAGE = /^(?:rsync\b|deleting |created directory |skipping |cannot |file has vanished|IO error|Transfer starting|sent |total size is |sending incremental|receiving incremental|building file list|delta-transmission|done$)/u
/** A run of file rows longer than this keeps its first RSYNC_HEAD and last RSYNC_TAIL rows. */
const RSYNC_MIN = 30
const RSYNC_HEAD = 10
const RSYNC_TAIL = 5

function rsyncCommand(command: string): boolean {
  const argv = globArgv(command)
  if (argv?.[0] !== 'rsync') return false
  // A dry run or a listing prints the file list as the answer itself.
  return !argv.slice(1).some(arg => arg === '--dry-run' || arg === '--list-only' || /^-[A-Za-z0-9]*n/u.test(arg) && !arg.startsWith('--'))
}

function fileRow(text: string): boolean {
  return FILE_ROW.test(text) && !MESSAGE.test(text) && !PROBLEM.test(text)
}

/**
 * `rsync -v`: a run of more than RSYNC_MIN transferred-file rows keeps its
 * first RSYNC_HEAD and last RSYNC_TAIL rows, with the rows between counted in
 * one note. Every error, warning, deletion and other message, and the
 * `sent … received …` and `total size is …` summary, stay. Output without
 * that summary (an interrupted or failed run) passes through.
 */
function projectRsync(input: FilterInput): MappedProjection | undefined {
  if (!rsyncCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => SENT.test(line.text)) || !lines.some(line => TOTAL.test(line.text))) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let omitted = 0
  for (let i = 0; i < lines.length;) {
    let end = i
    while (end < lines.length && fileRow(lines[end]!.text)) end++
    if (end - i > RSYNC_MIN) {
      for (let k = i; k < i + RSYNC_HEAD; k++) builder.keep(lines[k]!.start, lines[k]!.end)
      builder.generate(`[${end - i - RSYNC_HEAD - RSYNC_TAIL} file list rows omitted]\n`, 'rsync-file-rows')
      for (let k = end - RSYNC_TAIL; k < end; k++) builder.keep(lines[k]!.start, lines[k]!.end)
      omitted += end - i - RSYNC_HEAD - RSYNC_TAIL
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) builder.keep(lines[i]!.start, lines[i]!.end)
  }
  return omitted > 0 ? builder.finish() : undefined
}

export const rsyncFilter: EconomyFilter = {
  name: 'rsync', transformation: 'preview', projectMapped: projectRsync, commands: rsyncCommand,
  project: input => projectRsync(input)?.text,
}
