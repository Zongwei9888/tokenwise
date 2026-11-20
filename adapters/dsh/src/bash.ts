import type { ShellResult } from '@tokenwise/core'
import type { BashForegroundValue, ContentBlock } from './host.ts'

const STDERR_HEADER = '[stderr]\n'

/**
 * A finished DSH `bash` call as TokenWise sees it. DSH renders the model text
 * from the canonical value as: stdout, then `[stderr]\n` and stderr, then
 * status markers (`[exit code: N]`, timeout, signal, sandbox). Both streams are
 * located verbatim in the rendered text, so a projection replaces exactly one
 * stream and keeps every marker byte-for-byte. Any other layout (a result
 * another plugin already rewrote, a future renderer) is reported as
 * unsupported (an invalid stream offset), never guessed at.
 */
export function bashShellResult(command: unknown, value: unknown, content: readonly ContentBlock[]): ShellResult | undefined {
  if (typeof command !== 'string' || !isForeground(value)) return undefined
  if (content.length !== 1 || content[0]!.type !== 'text' || typeof content[0]!.text !== 'string') return undefined
  const rendered = content[0]!.text
  const base = { command, rendered }
  const exitCode = value.exitCode
  // Killed, timed out, stopped or cancelled: the output is not a complete report.
  if (exitCode === null || value.signal !== null || value.timedOut || value.aborted || value.stopped !== undefined
    || value.sandbox?.denied === true || value.sandbox?.runnerFailed === true) {
    return { ...base, exitCode: exitCode ?? -1, interrupted: true, stdout: { start: 0, text: rendered } }
  }
  const truncated = value.stdout.truncated || value.stderr.truncated
  const unsupported = { ...base, exitCode, truncated, stdout: { start: -1, text: '' } }
  const out = value.stdout.text, err = value.stderr.text
  if (!rendered.startsWith(out)) return unsupported
  if (err === '') return { ...base, exitCode, truncated, stdout: { start: 0, text: out } }
  const start = out.length + (out.length > 0 && !out.endsWith('\n') ? 1 : 0) + STDERR_HEADER.length
  if (!rendered.startsWith(STDERR_HEADER, start - STDERR_HEADER.length) || !rendered.startsWith(err, start)) return unsupported
  return { ...base, exitCode, truncated, stdout: { start: 0, text: out }, stderr: { start, text: err } }
}

function isForeground(value: unknown): value is BashForegroundValue {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<BashForegroundValue>
  const stream = (s: unknown) => s !== null && typeof s === 'object'
    && typeof (s as { text?: unknown }).text === 'string' && typeof (s as { truncated?: unknown }).truncated === 'boolean'
  return v.kind === 'foreground' && (v.exitCode === null || Number.isSafeInteger(v.exitCode))
    && (v.signal === null || typeof v.signal === 'string') && typeof v.timedOut === 'boolean' && typeof v.aborted === 'boolean'
    && stream(v.stdout) && stream(v.stderr)
}

const JOB_STATUS = /^\[status: completed, exit code: (\d+)\]$/u
const JOB_DROPPED = /\[some output was dropped from memory; full output: [^\n]*\]$/u

/**
 * A DSH `job_output` read (0.2.1) holding the whole output of a finished
 * background `bash` job, as the `ShellResult` of the command that started it
 * (the job's label is that command, exactly as the model wrote it). A read
 * returns only what is new since the previous one, so it is the whole output
 * only when its bytes are all the job ever wrote: `total` (the job registry's
 * count) must equal the read's stdout and stderr bytes, which DSH renders as
 * stdout, a `[stderr]` header and stderr. Anything else (a job still running,
 * killed or failed, output read before, dropped from memory, or another
 * layout) is undefined.
 */
export function jobShellResult(value: unknown, content: readonly ContentBlock[], total: (jobId: string) => number | undefined): ShellResult | undefined {
  const v = value as { text?: unknown; job?: { id?: unknown; kind?: unknown; label?: unknown; status?: unknown; detail?: unknown } } | null
  if (v === null || typeof v !== 'object' || typeof v.text !== 'string' || v.text === '' || !v.job) return undefined
  const { id, kind, label, status, detail } = v.job
  if (kind !== 'bash' || status !== 'completed' || typeof id !== 'string' || typeof label !== 'string' || label === '' || typeof detail !== 'string') return undefined
  if (content.length !== 1 || content[0]!.type !== 'text' || typeof content[0]!.text !== 'string') return undefined
  const rendered = content[0]!.text, text = v.text
  const tail = rendered.slice(text.length + (text.endsWith('\n') ? 0 : 1))
  const code = JOB_STATUS.exec(tail)
  if (!rendered.startsWith(text) || (!text.endsWith('\n') && rendered[text.length] !== '\n') || !code || `exit code: ${code[1]}` !== detail) return undefined
  if (JOB_DROPPED.test(text.trimEnd())) return undefined
  const written = total(id)
  if (written === undefined) return undefined
  const extra = Buffer.byteLength(text, 'utf8') - written
  const base = { command: label, rendered, exitCode: Number(code[1]) }
  if (extra === 0) return text.startsWith(STDERR_HEADER) || text.includes(`\n${STDERR_HEADER}`) ? undefined : { ...base, stdout: { start: 0, text } }
  // `[stderr]\n`, after a `\n` that ends stdout when stdout does not end with one itself.
  if (extra !== STDERR_HEADER.length && extra !== STDERR_HEADER.length + 1) return undefined
  const at = text.startsWith(STDERR_HEADER) ? 0 : text.indexOf(`\n${STDERR_HEADER}`) + 1
  if (at < 0 || (at > 0 && text.indexOf(`\n${STDERR_HEADER}`, at) !== -1)) return undefined
  const out = at === 0 ? '' : text.slice(0, extra === STDERR_HEADER.length ? at : at - 1)
  if (extra === STDERR_HEADER.length + 1 && (out.endsWith('\n') || out === '')) return undefined
  if (extra === STDERR_HEADER.length && at > 0 && !out.endsWith('\n')) return undefined
  const start = at + STDERR_HEADER.length
  return { ...base, stdout: { start: 0, text: out }, stderr: { start, text: text.slice(start) } }
}
