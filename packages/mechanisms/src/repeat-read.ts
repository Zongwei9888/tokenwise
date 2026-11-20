/**
 * A file read again, unchanged. When the model reads the same file over the
 * same range in one conversation, the text is the same as last time, and the
 * last read reached the model whole and is still in its context (the host
 * says so: nothing compacted or cleared it), the new read can be a one-line
 * note pointing back to it. Each read is remembered per agent and
 * conversation (`reads/<host>/<conversation>.json` in the data directory)
 * by what it read and the text's digest; a repeat is answered with the note
 * once, and the read after a note gets the whole text again, so a model that
 * asks again is never left without it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256 } from '@tokenwise/core'
import type { FilterCandidate } from '@tokenwise/core'
import { ensurePrivateDir, pathSegment } from '@tokenwise/store'
import type { EconomyEngine } from './economy.ts'

/** The last read of one file and range in a conversation. */
export interface SeenRead {
  readonly sha256: string
  /** The call whose result holds the text in the model's context. */
  readonly callId: string
  /** The last read was answered with the note (the next one gets the text). */
  readonly noted: boolean
}

/** Reads remembered per conversation; the oldest go first past this. */
const MAX_READS = 2000

const statePath = (dir: string, host: string, sessionId: string) => join(dir, 'reads', pathSegment(host), `${pathSegment(sessionId)}.json`)

function load(dirs: readonly string[], host: string, sessionId: string): Record<string, SeenRead> {
  for (const dir of dirs) {
    const path = statePath(dir, host, sessionId)
    if (!existsSync(path)) continue
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, SeenRead> : {}
    } catch { return {} }
  }
  return {}
}

/** The last read of `key` (a tool and what it read) in this conversation. */
export function seenRead(dirs: readonly string[], host: string, sessionId: string, key: string): SeenRead | undefined {
  const seen = load(dirs, host, sessionId)[key]
  return seen && typeof seen.sha256 === 'string' && typeof seen.callId === 'string' ? seen : undefined
}

/** Remember the read of `key` the model was just given. */
export function rememberRead(dir: string, host: string, sessionId: string, key: string, read: SeenRead): void {
  const path = statePath(dir, host, sessionId)
  ensurePrivateDir(dirname(path))
  const state = load([dir], host, sessionId)
  delete state[key]
  state[key] = read
  const keys = Object.keys(state)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_READS))) delete state[old]
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
  renameSync(temp, path)
}

/** What the model reads instead of a repeat. */
export function repeatReadNote(what: string): string {
  return `[TokenWise: ${what} is unchanged since you read it earlier in this conversation (same range, same text); that result is still above. Read it again if you need the text repeated.]`
}

/**
 * The note for this read as a projection (for the Economy engine to journal
 * and deliver), when it repeats the last read of `key` exactly and that read
 * reached the model whole and is still in its context; otherwise undefined.
 */
export function repeatReadProjection(seen: SeenRead | undefined, text: string, what: string,
  stillInContext: (callId: string) => boolean): FilterCandidate | undefined {
  if (!seen || seen.noted || seen.sha256 !== sha256(text) || !stillInContext(seen.callId)) return undefined
  return repeatReadCandidate(text, what)
}

/** The note standing for `text` (a read the model has whole earlier in its context), as a projection to journal. */
export function repeatReadCandidate(text: string, what: string): FilterCandidate {
  const note = repeatReadNote(what)
  return { filter: 'repeat-read', transformation: 'lossless-formatting', text: note,
    sourceMap: { version: 1, unit: 'utf16', sourceLength: text.length, outputLength: note.length, spans: [{ outputStart: 0, outputEnd: note.length, generated: note }] } }
}

/** A tool's result passing through TokenWise. */
export interface ToolPass {
  readonly host: string
  readonly sessionId: string | null
  readonly callId: string | null
  readonly tool: string
  /** How the call reads in the journal (see `describeToolCall`). */
  readonly command: string
  /** The text the model reads. */
  readonly text: string
  /** A file read: one key per distinct file and range, how the note names it, and whether an earlier call's result is still in context. */
  readonly read?: { readonly key: string; readonly what: string; readonly stillInContext: (callId: string) => boolean }
}

/**
 * Journal a tool's result through `engine` (unchanged unless it is a read
 * that repeats one still in context), remember a read, and return the note
 * to deliver instead, if any.
 */
export function passTool(engine: EconomyEngine, dataDir: string, dirs: readonly string[], pass: ToolPass): string | undefined {
  if (pass.text === '') return undefined
  const { read, sessionId, callId } = pass
  const seen = read && sessionId && callId ? seenRead(dirs, pass.host, sessionId, read.key) : undefined
  const projection = read && seen ? repeatReadProjection(seen, pass.text, read.what, read.stillInContext) : undefined
  const output = engine.process({ sessionId, callId, tool: pass.tool, command: pass.command, native: { rendered: pass.text, projection } })
  if (read && sessionId && callId) {
    try {
      rememberRead(dataDir, pass.host, sessionId, read.key, output.text !== undefined && seen
        ? { ...seen, noted: true } : { sha256: sha256(pass.text), callId, noted: false })
    } catch { /* The next read is then delivered whole. */ }
  }
  return output.text
}
