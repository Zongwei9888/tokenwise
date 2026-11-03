/**
 * LightShadow from the command line, for host adapters that are not
 * JavaScript or run outside the host process (hooks, Python plugins):
 *
 *   tokenwise shadow instruction            the line to add to the host's summary instruction
 *   tokenwise shadow checkpoint             stdin {host, session_id, messages, summary, prior?, user_messages?} → {text, refs}
 *   tokenwise shadow catalog                stdin {host, session_id, messages, tool_name?, budget_tokens?} → {text}
 *   tokenwise recall <observation_id> ...   the recall tool
 *
 * `messages` are `ShadowMessage`s: {role: user|assistant|tool|summary|other,
 * text, tool_name?, call_id?, call?}. Output is one JSON object. A failure
 * prints `{"text": null, "error": ...}` and exits 0, so a host falls back to
 * its own compaction without parsing stderr.
 */
import {
  RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME, SHADOW_SUMMARY_INSTRUCTION, recallFromJournal, shadowCatalog, shadowCheckpoint, shadowMessagesFrom,
} from '@tokenwise/mechanisms'
import type { ShadowMessage, ShadowStore } from '@tokenwise/mechanisms'
import type { ArtifactPort } from '@tokenwise/protocol'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, pathSegment } from '@tokenwise/store'
import { cliContext } from './context.ts'
import type { CliContext } from './context.ts'
import { readStdin } from './hook.ts'

/** A compaction span can be the whole conversation. */
const MAX_SPAN_INPUT = 256 * 1024 * 1024

/** Saves go to the first writable location; reads look in every one. */
export function shadowStore(context: CliContext, host: string): ShadowStore | undefined {
  const writable = context.writable()
  if (!writable) return undefined
  const artifacts: ArtifactPort = { save: text => writable.artifacts.save(text), read: hash => context.readArtifact(hash) }
  return { journal: writable.journal, artifacts, read: sessionId => context.readJournal({ host, sessionId }) }
}

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : undefined

function reply(value: Record<string, unknown>): number {
  process.stdout.write(JSON.stringify(value) + '\n')
  return 0
}

/**
 * The catalog to add after the host's compaction: this span's tool results
 * saved, every reference the session has listed, under `maxChars`. Undefined
 * when LightShadow is not in apply mode, nothing is recallable, or nothing
 * can be stored.
 */
export function catalogText(options: { host: string; sessionId: string | null; cwd?: unknown; messages: readonly ShadowMessage[]
  toolName?: string; lead?: string; maxChars: number }): string | undefined {
  const context = cliContext(typeof options.cwd === 'string' ? { cwd: options.cwd } : {})
  if (context.loaded.config.lightshadow.mode !== 'apply') return undefined
  const store = shadowStore(context, options.host)
  if (!store) return undefined
  // Tokens are estimated at four characters; leave room for the lead line.
  const result = shadowCatalog({ host: options.host, sessionId: options.sessionId, messages: options.messages, budgetTokens: Math.floor((options.maxChars - 800) / 4),
    ...options.toolName ? { toolName: options.toolName } : {}, ...options.lead ? { lead: options.lead } : {} }, store)
  return result.text ? result.text.slice(0, options.maxChars) : undefined
}

/** The catalog as `{hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext}}` (Claude Code and Codex read this shape). */
export function catalogContext(options: Parameters<typeof catalogText>[0]): string | undefined {
  const text = catalogText(options)
  return text === undefined ? undefined : JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
}

/** A catalog waiting for the host's next chance to add context (Grok), one file per session. */
function pendingPath(dir: string, host: string, sessionId: string): string {
  return join(dir, 'shadow', 'pending', pathSegment(host), `${pathSegment(sessionId)}.txt`)
}

export function keepPending(host: string, sessionId: string, text: string): void {
  const writable = cliContext().writable()
  if (!writable) return
  const path = pendingPath(writable.dataDir, host, sessionId)
  ensurePrivateDir(dirname(path))
  writeFileSync(path, text, { mode: 0o600 })
  // A session that ended before its next chance leaves its file: those go after a week.
  try {
    for (const name of readdirSync(dirname(path))) {
      const file = join(dirname(path), name)
      if (Date.now() - statSync(file).mtimeMs > 7 * 86_400_000) rmSync(file, { force: true })
    }
  } catch { /* Housekeeping only. */ }
}

/** The waiting catalog, removed as it is read, so it is delivered once. */
export function takePending(host: string, sessionId: string): string | undefined {
  for (const dir of cliContext().dataDirs) {
    const path = pendingPath(dir, host, sessionId)
    if (!existsSync(path)) continue
    try { const text = readFileSync(path, 'utf8'); rmSync(path, { force: true }); return text || undefined } catch { /* Next location. */ }
  }
  return undefined
}

/** Whether LightShadow applies for a project directory (configuration can lower it). */
export function shadowApplies(cwd: unknown): boolean {
  return cliContext(typeof cwd === 'string' ? { cwd } : {}).loaded.config.lightshadow.mode === 'apply'
}

export async function shadow(sub: string | undefined): Promise<number> {
  if (sub === 'instruction') { process.stdout.write(SHADOW_SUMMARY_INSTRUCTION + '\n'); return 0 }
  if (sub === 'tool') {
    return reply({ name: RECALL_TOOL_NAME, description: RECALL_TOOL_DESCRIPTION })
  }
  if (sub !== 'checkpoint' && sub !== 'catalog') {
    process.stderr.write('tokenwise shadow: use instruction, tool, checkpoint or catalog\n')
    return 2
  }
  try {
    const input = JSON.parse(await readStdin(MAX_SPAN_INPUT)) as Record<string, unknown>
    const host = text(input.host) ?? 'shell'
    const context = cliContext({ ...text(input.cwd) ? { cwd: input.cwd as string } : {} })
    if (context.loaded.config.lightshadow.mode !== 'apply') return reply({ text: null, reason: `lightshadow is ${context.loaded.config.lightshadow.mode}` })
    const store = shadowStore(context, host)
    if (!store) return reply({ text: null, error: 'no writable TokenWise data directory' })
    const span = { host, sessionId: text(input.session_id) ?? null, messages: shadowMessagesFrom(input.messages),
      ...text(input.prior) ? { prior: input.prior as string } : {} }
    if (sub === 'checkpoint') {
      if (typeof input.summary !== 'string' || input.summary.trim() === '') return reply({ text: null, error: 'summary is required' })
      const result = shadowCheckpoint({ ...span, summary: input.summary, ...input.user_messages === false ? { userMessages: false } : {} }, store)
      return reply({ text: result.text ?? null, references: result.references, refs: result.list.map(item => ({ id: item.id, call_id: item.callId })) })
    }
    const budget = typeof input.budget_tokens === 'number' && Number.isSafeInteger(input.budget_tokens) && input.budget_tokens > 0 ? input.budget_tokens : undefined
    const result = shadowCatalog({ ...span, ...text(input.tool_name) ? { toolName: input.tool_name as string } : {}, ...budget ? { budgetTokens: budget } : {} }, store)
    return reply({ text: result.text || null, references: result.references, added: result.added })
  } catch (error) {
    return reply({ text: null, error: String((error as Error)?.message ?? error) })
  }
}

export interface RecallOptions {
  readonly id: string | undefined
  readonly query?: string
  readonly line?: string
  readonly original?: boolean
  readonly host?: string
  readonly session?: string
  readonly call?: string
}

/** `tokenwise recall`: prints what the recall tool would return; exit 1 when it failed. */
export function recall(options: RecallOptions): number {
  const context = cliContext()
  const host = options.host ?? 'shell'
  const writable = context.writable()
  const result = recallFromJournal({
    observation_id: options.id, ...options.query === undefined ? {} : { query: options.query },
    ...options.line === undefined ? {} : { line: options.line }, ...options.original ? { original: true } : {},
  }, {
    host, sessionId: options.session ?? null, callId: options.call ?? null,
    artifacts: { save: () => { throw new Error('read only') }, read: hash => context.readArtifact(hash) },
    read: sessionId => context.readJournal({ sessionId }),
    readAll: () => context.readJournal({}),
    ...writable ? { journal: writable.journal } : {},
  })
  process.stdout.write(result.text.endsWith('\n') ? result.text : result.text + '\n')
  return result.ok ? 0 : 1
}
