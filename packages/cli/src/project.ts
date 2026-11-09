import { EconomyEngine } from '@tokenwise/mechanisms'
import type { EconomyRecord } from '@tokenwise/protocol'
import { RuleStore, collectDaily } from '@tokenwise/store'
import type { ShellResult } from '@tokenwise/core'
import { cliContext } from './context.ts'

export interface OutputRequest {
  readonly host: string
  readonly delivery: EconomyRecord['delivery']
  readonly tool: string
  readonly sessionId: string | null
  readonly callId: string | null
  /** The command as the agent wrote it. */
  readonly command: string
  readonly exitCode: number
  readonly interrupted: boolean
  /** The host already cut the output. */
  readonly truncated?: boolean
  /** With `stderr`, the streams are filtered apart; without it, `stdout` is the host's merged output. */
  readonly stdout: string
  readonly stderr?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** A projection this long or longer passes instead (the host already delivers something as short). */
  readonly maxProjectedChars?: number
}

/**
 * Filter a finished command's output through Economy. Returns the text to
 * deliver for each stream, or undefined when nothing changes (Economy off, no
 * writable data directory, or no filter applies). The original is saved and
 * the decision journaled before a projection is returned.
 */
export function projectOutput(request: OutputRequest): { stdout: string; stderr?: string } | undefined {
  const context = cliContext({ ...request.cwd === undefined ? {} : { cwd: request.cwd }, ...request.env === undefined ? {} : { env: request.env } })
  const { config } = context.loaded
  if (config.economy.mode === 'off') return undefined
  // Originals must be savable before anything is filtered (sandboxed hosts may only allow TMPDIR).
  const store = context.writable()
  if (!store) return undefined
  const separate = request.stderr !== undefined
  // One store, so the rules compile once however many streams this run filters.
  const rules = new RuleStore(context.dataDir)
  const engine = new EconomyEngine({ host: request.host, journal: store.journal, artifacts: store.artifacts,
    config: config.economy, mode: config.economy.mode, delivery: request.delivery, streams: separate ? 'separate' : 'merged',
    learned: () => rules.load(), ...request.maxProjectedChars === undefined ? {} : { maxProjectedChars: request.maxProjectedChars },
    // `tokenwise` is on PATH here (it is running), so `tokenwise recall` reads the original; most hosts also offer the MCP tool.
    recallHint: config.lightshadow.mode !== 'off' })
  const base = { command: request.command, exitCode: request.exitCode, interrupted: request.interrupted, ...request.truncated ? { truncated: true } : {} }
  const process = (result: ShellResult) => engine.process({ sessionId: request.sessionId, callId: request.callId, tool: request.tool, result }).text
  const stdout = request.stdout === '' ? undefined : process({ ...base, rendered: request.stdout, stdout: { start: 0, text: request.stdout } })
  const stderr = !separate || request.stderr === '' ? undefined
    : process({ ...base, rendered: request.stderr!, stdout: { start: 0, text: '' }, stderr: { start: 0, text: request.stderr! } })
  try { collectDaily(store.dataDir, days => store.artifacts.prune(days), config.artifacts.retentionDays) } catch { /* Housekeeping only. */ }
  if (stdout === undefined && stderr === undefined) return undefined
  return { stdout: stdout ?? request.stdout, ...separate ? { stderr: stderr ?? request.stderr! } : {} }
}
