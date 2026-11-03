import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../../adapters/codex/', import.meta.url)
const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))

describe('Codex plugin layout', () => {
  it('declares the Bash PreToolUse hook, the SessionStart hooks (startup check, compact) and the recall MCP server', () => {
    const manifest = json('.codex-plugin/plugin.json')
    expect(manifest).toMatchObject({ name: 'tokenwise', hooks: './hooks/hooks.json', mcpServers: './.mcp.json' })
    // The skill comes from tokenwise setup (~/.agents/skills), as for every agent; a second copy here would show twice.
    expect(manifest.skills).toBeUndefined()
    const hooks = json('hooks/hooks.json')
    expect(Object.keys(hooks).sort()).toEqual(['description', 'hooks'])
    expect(hooks.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'tokenwise hook codex', timeout: 10 }] }],
      // Codex spills additionalContext over 2,500 tokens to a file unless the handler raises the limit.
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: expect.stringContaining('then tokenwise hook codex; else'), timeout: 10 }] },
        { matcher: 'compact', hooks: [{ type: 'command', command: 'tokenwise hook codex', timeout: 60, additionalContextLimit: 6000 }] },
      ],
    })
    // The model sees the tool as mcp__<server>__<tool>; the catalog names it so.
    expect(json('.mcp.json').mcpServers).toEqual({ tokenwise: { command: 'tokenwise', args: ['mcp', '--host', 'codex'] } })
  })
})
