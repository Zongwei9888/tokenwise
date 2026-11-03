/**
 * The startup notice in OpenCode: what Claude Code and Codex show from their
 * SessionStart hook (a learning run finished, or a command keeps coming back
 * long), as a toast when a session starts. The text comes from
 * `tokenwise notice opencode`, so every agent says the same thing once; with
 * no `tokenwise` command there is no notice.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

export interface ToastClient {
  readonly tui?: {
    readonly showToast?: (options: { body: { title?: string; message: string; variant: 'info' | 'success' | 'warning' | 'error'; duration?: number } }) => Promise<unknown>
  }
}

// An OpenCode started from the desktop may not have npm's global binaries on PATH.
const FALLBACKS = [join(homedir(), '.local', 'bin', 'tokenwise'), '/opt/homebrew/bin/tokenwise', '/usr/local/bin/tokenwise']
const TIMEOUT_MS = 10_000

const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true } catch { return false } }

/** The `tokenwise` command: $TOKENWISE_BIN, else PATH, else where npm puts global binaries. */
export function findTokenwise(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = (env.TOKENWISE_BIN ?? env.TW_BIN)?.trim()
  if (explicit) return isAbsolute(explicit) && executable(explicit) ? explicit : undefined
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && isAbsolute(dir) && executable(join(dir, 'tokenwise'))) return join(dir, 'tokenwise')
  }
  return FALLBACKS.find(executable)
}

/**
 * `tokenwise notice opencode --peek`: the notice's text, left to be told, or undefined when there is nothing to
 * say or no way to ask. With `--told`, marks it told once the toast is up.
 */
export function readNotice(env: NodeJS.ProcessEnv, flag: '--peek' | '--told' = '--peek'): Promise<string | undefined> {
  const tokenwise = findTokenwise(env)
  if (!tokenwise) return Promise.resolve(undefined)
  return new Promise(resolve => {
    execFile(tokenwise, ['notice', 'opencode', flag], { env, timeout: TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      const text = error ? '' : stdout.trim()
      resolve(text || undefined)
    })
  })
}

/** Shows the notice, if any, then marks it told; never throws. */
export async function showNotice(client: ToastClient | undefined, read: () => Promise<string | undefined>, told: () => Promise<unknown>): Promise<void> {
  try {
    const tui = client?.tui
    if (typeof tui?.showToast !== 'function') return
    const message = await read()
    // Called on the client, not detached: the SDK's methods use `this`.
    if (!message) return
    await tui.showToast({ body: { title: 'TokenWise', message, variant: 'info', duration: 15_000 } })
    await told()
  } catch { /* The notice is a courtesy. */ }
}
