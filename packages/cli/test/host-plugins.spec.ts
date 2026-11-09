import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../../../', import.meta.url)
const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const version = json('packages/cli/package.json').version as string
const hook = (host: string) => [{ type: 'command', command: `tokenwise hook ${host}`, timeout: 10 }]
const check = (host: string) => [{ type: 'command', command: expect.stringContaining(`then tokenwise hook ${host}; else`), timeout: 10 }]
const PLUGINS = ['adapters/claude-code', 'adapters/codex', 'adapters/codebuddy', 'adapters/grok']

describe('GitHub Copilot CLI plugin layout', () => {
  const copilot = (command: string) => [{ type: 'command', bash: command, timeoutSec: 10 }]
  it('is listed in the marketplace Copilot reads first, and hooks the events it can use', () => {
    // Copilot reads .github/plugin/marketplace.json before .claude-plugin/ (seen on 1.0.103), so it finds its own plugin.
    expect(json('.github/plugin/marketplace.json')).toMatchObject({ name: 'tokenwise', plugins: [{ name: 'tokenwise', source: './adapters/copilot', version }] })
    expect(json('adapters/copilot/plugin.json')).toMatchObject({ name: 'tokenwise', version, hooks: 'hooks.json' })
    const hooks = json('adapters/copilot/hooks.json')
    expect(hooks.version).toBe(1)
    expect(hooks.hooks.postToolUse).toEqual(copilot('tokenwise hook copilot'))
    // preToolUse starts tokenwise only during tokenwise doctor --probe.
    expect(hooks.hooks.preToolUse).toEqual(copilot(expect.stringContaining('if [ -n "$TOKENWISE_PROBE" ]; then tokenwise hook copilot; else cat >/dev/null; fi')))
  })

  it('says at startup, as a timeline line, when the tokenwise command is missing', () => {
    const bin = mkdtempSync(join(tmpdir(), 'tokenwise-path-'))
    try {
      writeFileSync(join(bin, 'tokenwise'), '#!/bin/sh\ncat >/dev/null\n')
      chmodSync(join(bin, 'tokenwise'), 0o755)
      const command = json('adapters/copilot/hooks.json').hooks.sessionStart[0].bash as string
      const missing = spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin' }, input: '{}', encoding: 'utf8' })
      expect(missing.status).toBe(0)
      expect(JSON.parse(missing.stdout)).toEqual({ type: 'progress', message: expect.stringMatching(/^TokenWise: the tokenwise command is not on PATH.*#install$/u) })
      const present = spawnSync('/bin/sh', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin` }, input: '{}', encoding: 'utf8' })
      expect(present).toMatchObject({ status: 0, stdout: '' })
    } finally { rmSync(bin, { recursive: true, force: true }) }
  })
})

describe('Claude Code, CodeBuddy and Grok plugin layouts', () => {
  it('lists one plugin per host in that host\'s marketplace file', () => {
    // CodeBuddy reads .codebuddy-plugin before .claude-plugin, and Grok .grok-plugin before it, so each finds its own.
    expect(json('.claude-plugin/marketplace.json').plugins).toMatchObject([{ name: 'tokenwise', source: './adapters/claude-code', version }])
    expect(json('.codebuddy-plugin/marketplace.json').plugins).toMatchObject([{ name: 'tokenwise', source: './adapters/codebuddy', version }])
    expect(json('.grok-plugin/marketplace.json').plugins).toMatchObject([{ name: 'tokenwise', source: { type: 'local', path: './adapters/grok' }, version }])
    for (const manifest of ['adapters/claude-code/.claude-plugin/plugin.json', 'adapters/codebuddy/.codebuddy-plugin/plugin.json', 'adapters/grok/plugin.json']) {
      expect(json(manifest)).toMatchObject({ name: 'tokenwise', version })
    }
  })

  it('calls tokenwise with the host\'s own name, on the events that host can use', () => {
    expect(json('adapters/claude-code/hooks/hooks.json').hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: hook('claude') }, { matcher: 'mcp__plugin_tokenwise_tokenwise__tokenwise_recall', hooks: hook('claude') }],
      PostToolUse: [{ matcher: 'Bash', hooks: hook('claude') }],
      PreCompact: [{ hooks: hook('claude') }],
      SessionStart: [{ matcher: 'startup', hooks: check('claude') }, { matcher: 'compact', hooks: [{ type: 'command', command: 'tokenwise hook claude', timeout: 60 }] }],
    })
    // The recall tool's name is mcp__plugin_<plugin>_<server>__<tool>; the PreToolUse matcher above must follow it.
    expect(json('adapters/claude-code/.mcp.json').mcpServers).toEqual({ tokenwise: { command: 'tokenwise', args: ['mcp', '--host', 'claude'], alwaysLoad: true } })
    expect(json('adapters/codebuddy/hooks/hooks.json').hooks).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: hook('codebuddy') }],
      SessionStart: [{ matcher: 'startup', hooks: check('codebuddy') }] })
    // LightShadow on CodeBuddy is a mod: an ES module the plugin's hooks.json lists.
    expect(json('adapters/codebuddy/hooks/hooks.json').modules).toEqual(['./compaction.js'])
    expect(json('adapters/codebuddy/package.json')).toMatchObject({ type: 'module' })
    // Grok: every PostToolUse (the catalog rides the first tool result after a compaction), PostCompact and Stop.
    expect(json('adapters/grok/hooks/hooks.json').hooks).toEqual({ SessionStart: [{ hooks: check('grok') }], PostToolUse: [{ hooks: hook('grok') }],
      PostCompact: [{ hooks: [{ type: 'command', command: 'tokenwise hook grok', timeout: 60 }] }], Stop: [{ hooks: hook('grok') }] })
    // Grok names MCP tools <server key>__<tool>: tokenwise__tokenwise_recall.
    expect(json('adapters/grok/.mcp.json').mcpServers).toEqual({ tokenwise: { command: 'tokenwise', args: ['mcp', '--host', 'grok'] } })
  })

  it('has /tokenwise:learn and /tokenwise:rules commands that learn with the host itself', () => {
    for (const [plugin, learner] of [['adapters/claude-code', 'claude'], ['adapters/codebuddy', 'codebuddy'], ['adapters/grok', 'grok']]) {
      const learn = readFileSync(new URL(`${plugin}/commands/learn.md`, root), 'utf8')
      expect(learn).toMatch(/^---\ndescription: .+\nargument-hint: .+\nallowed-tools: Bash\(tokenwise learn:\*\)\n---\n/u)
      // The arguments are never pasted into the command: CodeBuddy fills an empty $ARGUMENTS with the command's own name.
      for (const command of ['tokenwise learn status', 'tokenwise learn cancel', `tokenwise learn --learner ${learner}`]) expect(learn).toContain(`\`${command}\``)
      expect(learn).not.toMatch(/tokenwise learn \$ARGUMENTS/u)
      const rules = readFileSync(new URL(`${plugin}/commands/rules.md`, root), 'utf8')
      expect(rules).toContain('allowed-tools: Bash(tokenwise rules:*)')
      for (const command of ['tokenwise rules off', 'tokenwise rules rollback', 'tokenwise rules']) expect(rules).toContain(`\`${command}\``)
      expect(rules).not.toMatch(/tokenwise rules \$ARGUMENTS/u)
    }
  })

  it('tells the user at startup when the tokenwise command is missing, and stays quiet when it is there', () => {
    const bin = mkdtempSync(join(tmpdir(), 'tokenwise-path-'))
    try {
      writeFileSync(join(bin, 'tokenwise'), '#!/bin/sh\n')
      chmodSync(join(bin, 'tokenwise'), 0o755)
      for (const plugin of PLUGINS) {
        const command = json(`${plugin}/hooks/hooks.json`).hooks.SessionStart[0].hooks[0].command as string
        const missing = spawnSync('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
        expect(missing.status).toBe(0)
        expect(JSON.parse(missing.stdout).systemMessage).toMatch(/^TokenWise: the tokenwise command is not on PATH.*#install$/)
        const present = spawnSync('/bin/sh', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
        expect(present).toMatchObject({ status: 0, stdout: '' })
      }
    } finally { rmSync(bin, { recursive: true, force: true }) }
  })
})
