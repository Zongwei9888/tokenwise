import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ago, checkAgents, describeAgents, lastSeen, pluginState, probeAgents, probeCommand, probeTargets, sawProbe } from '../src/check.ts'
import type { Sources } from '../src/setup.ts'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-check-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function record(dataDir: string, host: string, command: string, at?: Date): void {
  const dir = join(dataDir, 'journal', host)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `s-${Math.random().toString(16).slice(2)}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'economy/decision', host, command }) + '\n')
  if (at) utimesSync(file, at, at)
}

/** A HOME with the given agents on PATH and, for some, the tokenwise skill installed. */
function machine(onPath: string[], skills: Record<string, string>) {
  const home = temp()
  const bin = join(home, 'bin')
  mkdirSync(bin)
  for (const name of onPath) { writeFileSync(join(bin, name), '#!/bin/sh\n'); chmodSync(join(bin, name), 0o755) }
  const where: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills', grok: '.grok/skills', opencode: '.config/opencode/skills' }
  for (const [id, text] of Object.entries(skills)) {
    const dir = join(home, where[id]!, 'tokenwise')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), text)
  }
  // Each agent's own settings, with TokenWise's plugin on.
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tokenwise@tokenwise': true } }))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), '[plugins."tokenwise@tokenwise"]\nenabled = true\n')
  mkdirSync(join(home, '.grok'), { recursive: true })
  writeFileSync(join(home, '.grok', 'config.toml'), '[plugins]\nenabled = [\n    "tokenwise",\n]\n')
  const source = join(home, 'source-skill')
  mkdirSync(source)
  writeFileSync(join(source, 'SKILL.md'), 'current')
  const from: Sources = { marketplace: '', pi: '', dsh: '', opencode: '', hermes: '', skill: source }
  return { env: { HOME: home, PATH: bin }, from }
}

describe('tokenwise doctor: your agents', () => {
  it('knows when it last saw each agent, across every data location', () => {
    const a = temp(), b = temp()
    expect(lastSeen([a, b], 'claude')).toBeNull()
    record(a, 'claude', 'ls', new Date('2026-11-01T10:00:00Z'))
    record(b, 'claude', 'ls', new Date('2026-11-02T10:00:00Z'))
    record(a, 'codex', 'ls', new Date('2026-11-05T10:00:00Z'))
    expect(lastSeen([a, b], 'claude')?.toISOString()).toBe('2026-11-02T10:00:00.000Z')
  })

  it('tells working, set up, out of date, not set up and missing apart', () => {
    const data = temp()
    const { env, from } = machine(['claude', 'codex', 'grok', 'opencode'], { claude: 'current', codex: 'current', grok: 'old' })
    const now = new Date('2026-11-08T12:00:00Z')
    record(data, 'claude', 'npm test', new Date('2026-11-08T11:57:00Z'))
    record(data, 'grok', 'npm test', new Date('2026-11-06T12:00:00Z'))
    record(data, 'pi', 'npm test', new Date('2026-11-08T07:00:00Z'))
    const checks = checkAgents([data], env, from)
    expect(checks.find(check => check.id === 'claude')).toMatchObject({ installed: true, skill: 'current' })
    expect(checks.find(check => check.id === 'grok')).toMatchObject({ installed: true, skill: 'outdated' })
    // pi reads the skill where Codex does; it is not on PATH. DeepSeek Harness, also sharing it, was never seen: not listed.
    expect(checks.find(check => check.id === 'pi')).toMatchObject({ installed: false, skill: 'current' })
    expect(describeAgents(checks, now)).toEqual([
      '  -  pi           not found on PATH (last command 5 h ago)',
      '  ✓  Claude Code  working, last command 3 min ago',
      '  ·  Codex        set up, no command seen yet (Open Codex and trust the TokenWise hooks in /hooks.)',
      '  !  Grok Build   working, last command 2 days ago; its tokenwise skill is out of date: tokenwise setup grok',
      '  !  OpenCode     not set up: tokenwise setup opencode',
    ])
    // Probing goes to the agents that are here and set up, unless some are named.
    expect(probeTargets([], checks)).toEqual(['claude', 'codex', 'grok'])
    expect(probeTargets(['opencode'], checks)).toEqual(['opencode'])
  })

  it('reads whether each agent has TokenWise\'s plugin on, from that agent\'s own settings', () => {
    const home = temp()
    const env = { HOME: home }
    for (const id of ['claude', 'codebuddy', 'codex', 'grok', 'opencode', 'hermes']) expect(pluginState(id, env), id).toBe('off')
    expect(pluginState('pi', env)).toBeUndefined()
    const write = (path: string, text: string) => { mkdirSync(join(home, path, '..'), { recursive: true }); writeFileSync(join(home, path), text) }
    write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'tokenwise@tokenwise': false } }))
    write('.codebuddy/settings.json', JSON.stringify({ enabledPlugins: { 'tokenwise@tokenwise': true } }))
    // Codex as it was after the plugin was taken out: hooks still trusted, the plugin gone.
    write('.codex/config.toml', '[hooks.state."tokenwise@tokenwise:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:x"\n\n[plugins."slack@openai-curated"]\nenabled = true\n')
    write('.grok/config.toml', '[[marketplace.sources]]\nname = "tokenwise"\n\n[plugins]\nenabled = [\n    "other",\n    "tokenwise",\n]\n')
    write('.config/opencode/plugins/tokenwise.js', '')
    write('.hermes/plugins/tokenwise/__init__.py', '')
    write('.hermes/config.yaml', 'plugins:\n  enabled:\n    - other\n    - tokenwise\n  disabled: []\n')
    expect(['claude', 'codebuddy', 'codex', 'grok', 'opencode', 'hermes'].map(id => pluginState(id, env))).toEqual(['off', 'on', 'off', 'on', 'on', 'on'])
    write('.codex/config.toml', '[plugins."tokenwise@tokenwise"]\nenabled = true\n')
    write('.hermes/config.yaml', 'plugins:\n  enabled: []\n  disabled:\n    - tokenwise\n')
    expect([pluginState('codex', env), pluginState('hermes', env)]).toEqual(['on', 'off'])
    // A switched-off plugin shows, however recently the agent was seen.
    const [line] = describeAgents([{ id: 'codex', name: 'Codex', installed: true, skill: 'current', plugin: 'off', lastSeen: new Date() }])
    expect(line).toBe('  !  Codex  TokenWise is not on in it: tokenwise setup codex')
  })

  it('says how long ago in words', () => {
    const now = new Date('2026-11-08T12:00:00Z')
    expect(ago(new Date('2026-11-08T11:59:50Z'), now)).toBe('just now')
    expect(ago(new Date('2026-11-08T09:00:00Z'), now)).toBe('3 h ago')
    expect(ago(new Date('2026-11-01T12:00:00Z'), now)).toBe('7 days ago')
  })
})

describe('tokenwise doctor --probe', () => {
  it('allows the agent that one command and nothing else, where the agent can say so', () => {
    const command = 'tokenwise probe tw12345678'
    expect(probeCommand('claude', 'p', command)).toEqual(['claude', '-p', 'p', '--allowedTools', `Bash(${command})`])
    expect(probeCommand('codebuddy', 'p', command)).toEqual(['codebuddy', '-p', 'p', '--allowedTools', `Bash(${command})`])
    expect(probeCommand('grok', 'p', command)).toEqual(['grok', '-p', 'p', '--allow', `Bash(${command})`])
    for (const argv of ['claude', 'codex', 'codebuddy', 'grok', 'opencode', 'hermes', 'pi'].map(id => probeCommand(id, 'p', command)!)) {
      expect(argv.join(' ')).not.toMatch(/dangerously|yolo|bypass|--auto|always-approve/u)
    }
    expect(probeCommand('dsh', 'p', command)).toBeUndefined()
  })

  it('passes only when the agent\'s own records hold the command it was asked to run', async () => {
    const data = temp()
    const asked: string[][] = []
    const { env } = machine([], {})
    const results = await probeAgents(['claude', 'codex', 'grok', 'hermes', 'dsh'], {
      dataDirs: [data], timeoutMs: 1000, env,
      run: async (argv, cwd) => {
        asked.push([...argv])
        expect(cwd).toContain('tokenwise-probe-')
        const command = /tokenwise probe tw[0-9a-f]{8}/u.exec(argv.join(' '))![0]
        if (argv[0] === 'claude') { record(data, 'claude', command); return { code: 0, tail: 'done' } }
        // Another agent's record of the same command does not count.
        if (argv[0] === 'grok') { record(data, 'claude', command); return { code: 0, tail: 'done' } }
        if (argv[0] === 'hermes') return { code: null, tail: '' }
        return { code: 0, tail: 'I ran it.' }
      },
    })
    expect(asked.map(argv => argv[0])).toEqual(['claude', 'codex', 'grok', 'hermes'])
    expect(results).toEqual([
      { id: 'claude', name: 'Claude Code', ok: true, detail: 'TokenWise saw the command it ran' },
      { id: 'codex', name: 'Codex', ok: false, detail: 'it answered, but TokenWise saw no command from it (Open Codex and trust the TokenWise hooks in /hooks.)' },
      { id: 'grok', name: 'Grok Build', ok: false, detail: 'it answered, but TokenWise saw no command from it' },
      { id: 'hermes', name: 'Hermes Agent', ok: false, detail: 'it did not finish within 1 s (TokenWise is not on in it: tokenwise setup hermes)' },
      { id: 'dsh', name: 'DeepSeek Harness', ok: undefined, detail: 'cannot be asked from here: run any command in it, then tokenwise doctor shows when it last saw one' },
    ])
  })

  it('reports why an agent failed, and ignores records older than the probe', async () => {
    const data = temp()
    record(data, 'pi', 'tokenwise probe tw00000000', new Date('2026-01-01T00:00:00Z'))
    expect(sawProbe([data], 'pi', 'tw00000000', Date.now())).toBe(false)
    const [result] = await probeAgents(['pi'], { dataDirs: [data], env: { HOME: temp() }, run: async () => ({ code: 1, tail: 'starting\nError: no API key\n' }) })
    expect(result).toMatchObject({ ok: false, detail: 'it exited with code 1: Error: no API key' })
  })

  it('runs for real against an agent that runs the command through tokenwise', async () => {
    // A stand-in agent: it runs the probe command through `tokenwise run`, as a hooked agent would.
    const data = temp()
    const bin = temp()
    writeFileSync(join(bin, 'tokenwise'), `#!/bin/sh\nexec '${process.execPath}' --conditions=source '${main}' "$@"\n`)
    writeFileSync(join(bin, 'pi'), '#!/bin/sh\nfor a; do last="$a"; done\nexec tokenwise run --host pi -c "${last#*: }"\n')
    for (const name of ['tokenwise', 'pi']) chmodSync(join(bin, name), 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TOKENWISE_HOME: data }
    const [result] = await probeAgents(['pi'], { dataDirs: [data], env, timeoutMs: 60_000 })
    expect(result).toMatchObject({ ok: true })
  }, 90_000)

  it('the probe command says what it proves', () => {
    const out = spawnSync(process.execPath, ['--conditions=source', main, 'probe', 'tw1'], { encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(out.stdout).toMatch(/^TokenWise probe tw1: this agent's commands go through TokenWise\.\n/u)
    expect(out.stdout.length).toBeGreaterThan(256)
  })
})
