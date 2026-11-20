/**
 * Commands an agent runs in the background. Their output reaches the model
 * later, through another tool (Claude Code's task output file, a job or
 * process reader), which does not say what ran. The start of such a command
 * is remembered under the agent, the conversation and the agent's task ID
 * (`background/<host>/<conversation>/<task>.json` in the data directory), so
 * a later read of the task's complete output can be filtered as that
 * command's output.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, pathSegment } from '@tokenwise/store'

export interface BackgroundCommand {
  readonly command: string
  readonly cwd?: string
}

/** A background command older than this is forgotten; its output is long read by then. */
const KEEP_MS = 3 * 86_400_000

const taskPath = (dir: string, host: string, sessionId: string, taskId: string) =>
  join(dir, 'background', pathSegment(host), pathSegment(sessionId), `${pathSegment(taskId)}.json`)

/** Remember that `taskId` in this conversation runs `command`. Conversations untouched for three days lose theirs. */
export function rememberBackground(dir: string, host: string, sessionId: string, taskId: string, started: BackgroundCommand): void {
  const path = taskPath(dir, host, sessionId, taskId)
  ensurePrivateDir(dirname(path))
  writeFileSync(path, JSON.stringify({ command: started.command, ...started.cwd === undefined ? {} : { cwd: started.cwd } }), { mode: 0o600 })
  const hostDir = dirname(dirname(path))
  try {
    for (const session of readdirSync(hostDir)) {
      const sessionDir = join(hostDir, session)
      if (Date.now() - statSync(sessionDir).mtimeMs > KEEP_MS) rmSync(sessionDir, { recursive: true, force: true })
    }
  } catch { /* Housekeeping only. */ }
}

/** The command `taskId` runs in this conversation, from any data directory; undefined when it was not seen start. */
export function backgroundCommand(dirs: readonly string[], host: string, sessionId: string, taskId: string): BackgroundCommand | undefined {
  for (const dir of dirs) {
    const path = taskPath(dir, host, sessionId, taskId)
    if (!existsSync(path)) continue
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { command?: unknown; cwd?: unknown }
      if (typeof value.command !== 'string' || value.command === '') return undefined
      return { command: value.command, ...typeof value.cwd === 'string' ? { cwd: value.cwd } : {} }
    } catch { return undefined }
  }
  return undefined
}
