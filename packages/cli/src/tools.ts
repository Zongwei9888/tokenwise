/**
 * Every tool's result passes through TokenWise, not only shell output: it is
 * journaled (so what TokenWise reports saving is a share of everything the
 * model read), and changed only where nothing is lost. A file read is
 * delivered whole the first time; read again, unchanged, while the first
 * read is still in the model's context, it is a one-line note pointing back
 * to it (`passTool` in @tokenwise/mechanisms).
 */
import { EconomyEngine, describeToolCall, passTool } from '@tokenwise/mechanisms'
import type { ToolPass } from '@tokenwise/mechanisms'
import { cliContext } from './context.ts'

export interface ToolOutputRequest extends Omit<ToolPass, 'command'> {
  /** The call's arguments, as the journal describes the call. */
  readonly args: unknown
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Journal a tool's result; for a read that repeats one still in context, the note to deliver instead. */
export function passToolOutput(request: ToolOutputRequest): string | undefined {
  if (request.text === '') return undefined
  const context = cliContext({ ...request.cwd === undefined ? {} : { cwd: request.cwd }, ...request.env === undefined ? {} : { env: request.env } })
  const { config } = context.loaded
  if (config.economy.mode === 'off') return undefined
  const store = context.writable()
  if (!store) return undefined
  const engine = new EconomyEngine({ host: request.host, journal: store.journal, artifacts: store.artifacts,
    config: config.economy, mode: config.economy.mode, delivery: 'result-hook', streams: 'merged' })
  return passTool(engine, store.dataDir, context.dataDirs, { ...request, command: describeToolCall(request.tool, request.args) })
}
