/**
 * OpenCode's own search tools (OpenCode 1.19): `glob` lists absolute paths, one
 * per line (newest first), and `grep` lists `path:` blocks of `  Line N: text`
 * rows. Only those exact renderings are laid out; anything else passes.
 */
import { nativeAbsolutePathLines, nativeGrepBlocks } from '@tokenwise/core'
import type { NativeResult } from '@tokenwise/core'

export const NATIVE_TOOLS: ReadonlySet<string> = new Set(['glob', 'grep'])

export function nativeResult(tool: string, output: { readonly output?: unknown }): NativeResult | undefined {
  const rendered = output.output
  if (typeof rendered !== 'string' || rendered === '') return undefined
  if (tool === 'glob') return { rendered, projection: nativeAbsolutePathLines(rendered) }
  if (tool === 'grep') return { rendered, projection: nativeGrepBlocks(rendered) }
  return undefined
}
