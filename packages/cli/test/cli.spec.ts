import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { codexPreToolUse } from '../src/hook.ts'
import { commandText } from '../src/run.ts'
import { shellQuote } from '../src/context.ts'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-cli-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tokenwise(args: string[], options: { cwd?: string; home?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.execPath, ['--conditions=source', main, ...args], {
    cwd: options.cwd, input: options.input === undefined ? undefined : Buffer.from(options.input), encoding: 'buffer',
    env: { ...process.env, SHELL: '/bin/sh', TOKENWISE_HOME: options.home ?? temp(), ...options.env },
  })
  return { ...result, out: result.stdout.toString('utf8'), err: result.stderr.toString('utf8') }
}

function project() {
  const dir = temp()
  mkdirSync(join(dir, 'src'))
  for (let f = 0; f < 3; f++) {
    writeFileSync(join(dir, 'src', `f${f}.ts`), Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i} // value line`).join('\n') + '\n')
  }
  return dir
}

describe('tokenwise run', () => {
  it('passes exit codes and unfiltered output through unchanged', () => {
    const result = tokenwise(['run', '-c', 'printf "a\\nb\\n"; exit 3'])
    expect(result.status).toBe(3)
    expect(result.out).toBe('a\nb\n')
    expect(tokenwise(['run', '--', 'definitely-not-a-command-xyz']).status).toBe(127)
  })
  it('keeps binary output byte-for-byte', () => {
    const result = tokenwise(['run', '-c', "printf '\\377\\376\\000x'"])
    expect([...result.stdout]).toEqual([0xff, 0xfe, 0x00, 0x78])
  })
  it('re-raises the signal that killed the command', () => {
    const result = tokenwise(['run', '-c', 'kill -TERM $$'])
    expect(result.signal).toBe('SIGTERM')
  })
  it('filters recognized output, saves the original and reports it', () => {
    const cwd = project(), home = temp()
    const raw = spawnSync('/bin/sh', ['-c', 'grep -rn value src'], { cwd, encoding: 'utf8' }).stdout
    const result = tokenwise(['run', '--host', 'test', '--session', 's1', '-c', 'grep -rn value src'], { cwd, home })
    expect(result.status).toBe(0)
    expect(result.out.length).toBeLessThan(raw.length)
    expect(result.out).toContain('omitted')
    const report = JSON.parse(tokenwise(['report', '--host', 'test', '--json'], { home }).out)
    expect(report).toMatchObject({ projected: 1, byFilter: [{ filter: 'grep', count: 1 }] })
    const journal = spawnSync('/bin/sh', ['-c', 'cat journal/test/s1.jsonl'], { cwd: home, encoding: 'utf8' }).stdout
    const record = JSON.parse(journal.trim())
    expect(tokenwise(['show', record.raw.sha256], { home }).out).toBe(raw)
    expect(record.tool).toBe('bash')
  })
  it("records Codex's shell tool name, matching the hook's rewrite records", () => {
    const cwd = project(), home = temp()
    tokenwise(['run', '--host', 'codex', '--session', 's1', '--call', 'c1', '-c', 'grep -rn value src'], { cwd, home })
    const journal = spawnSync('/bin/sh', ['-c', 'cat journal/codex/s1.jsonl'], { cwd: home, encoding: 'utf8' }).stdout
    expect(JSON.parse(journal.trim())).toMatchObject({ host: 'codex', callId: 'c1', tool: 'exec_command' })
  })
  it('falls back to a private TMPDIR location when the data directory is not writable', () => {
    const cwd = project(), tmp = temp(), blocked = join(temp(), 'file')
    writeFileSync(blocked, '')
    const env = { TMPDIR: tmp }
    const home = join(blocked, 'home')
    expect(tokenwise(['run', '--host', 'test', '-c', 'grep -rn value src'], { cwd, home, env }).out).toContain('omitted')
    expect(JSON.parse(tokenwise(['report', '--json'], { home, env }).out)).toMatchObject({ projected: 1 })
  })
  it('passes everything through when disabled', () => {
    const cwd = project()
    const raw = spawnSync('/bin/sh', ['-c', 'grep -rn value src'], { cwd, encoding: 'utf8' }).stdout
    expect(tokenwise(['run', '-c', 'grep -rn value src'], { cwd, env: { TOKENWISE_DISABLE: '1' } }).out).toBe(raw)
  })
  it('rejects ambiguous invocations', () => {
    expect(tokenwise(['run']).status).toBe(2)
    expect(tokenwise(['run', '-c', 'true', '--', 'true']).status).toBe(2)
  })
  it('counts a session\'s subagent sessions in its report', () => {
    const cwd = project(), home = temp()
    tokenwise(['run', '--host', 'test', '--session', 'child', '-c', 'grep -rn value src'], { cwd, home })
    tokenwise(['run', '--host', 'test', '--session', 'parent', '-c', 'printf x'], { cwd, home })
    expect(JSON.parse(tokenwise(['report', '--host', 'test', '--session', 'parent', '--json'], { home }).out)).toMatchObject({ decisions: 1, projected: 0 })
    writeFileSync(join(home, 'journal', 'test', 'parent.jsonl'), JSON.stringify({ schemaVersion: 1, type: 'session/subagent',
      time: '2026-10-13T00:00:00.000Z', host: 'test', sessionId: 'parent', childSessionId: 'child' }) + '\n', { flag: 'a' })
    expect(JSON.parse(tokenwise(['report', '--host', 'test', '--session', 'parent', '--json'], { home }).out)).toMatchObject({ decisions: 2, projected: 1 })
    expect(tokenwise(['report', '--host', 'test', '--session', 'parent'], { home }).out).toContain('session parent and its 1 subagent session')
    expect(JSON.parse(tokenwise(['report', '--host', 'test', '--json'], { home }).out)).toMatchObject({ decisions: 2, projected: 1 })
    // Without a host, every host's records of those sessions count.
    expect(JSON.parse(tokenwise(['report', '--session', 'parent', '--json'], { home }).out)).toMatchObject({ decisions: 2, projected: 1 })
    expect(tokenwise(['report', '--session', 'parent'], { home }).out).toContain('all hosts, session parent and its 1 subagent session')
  })
})

describe('commandText and quoting', () => {
  it('filters on the script, not on the shell wrapper', () => {
    expect(commandText({ script: 'pytest -x' })).toBe('pytest -x')
    expect(commandText({ argv: ['bash', '-lc', 'git status'] })).toBe('git status')
    expect(commandText({ argv: ['git', 'diff', 'a b'] })).toBe("git diff 'a b'")
  })
  it('round-trips arbitrary text through the shell', () => {
    for (const value of ["it's", 'a "b" $HOME `x` \\n', 'line1\nline2', '中文 😀', '']) {
      expect(spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }).stdout).toBe(value)
    }
  })
})

describe('Codex PreToolUse hook', () => {
  const input = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'thread-1', tool_use_id: 'call_1', tool_input: { command } })
  const withLc = () => {
    const bin = temp()
    writeFileSync(join(bin, 'tokenwise'), '#!/bin/sh\n')
    chmodSync(join(bin, 'tokenwise'), 0o755)
    return { TOKENWISE_HOME: temp(), PATH: bin }
  }
  it('wraps recognizable commands and normalizes them', () => {
    const output = JSON.parse(codexPreToolUse(input('rg value src'), withLc())!)
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { command: "tokenwise run --host codex --session thread-1 --call call_1 -c 'rg -n -H value src'" } } })
  })
  it('wraps without normalizing in observe mode, and not at all when tokenwise is not on PATH', () => {
    const observed = JSON.parse(codexPreToolUse(input('rg value src'), { ...withLc(), TOKENWISE_OUTPUT: 'observe' })!)
    expect(observed.hookSpecificOutput.updatedInput.command).toBe("tokenwise run --host codex --session thread-1 --call call_1 -c 'rg value src'")
    expect(codexPreToolUse(input('rg value src'), { TOKENWISE_HOME: temp(), PATH: temp() })).toBeUndefined()
  })
  it('leaves other commands, patches, wrapped commands and other events alone', () => {
    const env = withLc()
    expect(codexPreToolUse(input('echo hello'), env)).toBeUndefined()
    expect(codexPreToolUse(input("apply_patch <<'EOF'\n*** Begin Patch\nEOF"), env)).toBeUndefined()
    expect(codexPreToolUse(input("tokenwise run -c 'pytest'"), env)).toBeUndefined()
    expect(codexPreToolUse({ ...input('pytest'), hook_event_name: 'PostToolUse' }, env)).toBeUndefined()
    expect(codexPreToolUse({ ...input('pytest'), tool_name: 'apply_patch' }, env)).toBeUndefined()
    expect(codexPreToolUse(input('pytest'), { ...env, TOKENWISE_DISABLE: '1' })).toBeUndefined()
  })
  it('never fails a tool call through the CLI', () => {
    const result = tokenwise(['hook', 'codex'], { input: 'not json' })
    expect(result.status).toBe(0)
    expect(result.out).toBe('')
  })
})

describe('tokenwise usage errors', () => {
  it('prints the usage for `tokenwise <command> --help`, and one line for an unknown option', () => {
    for (const command of ['evolve', 'report', 'doctor', 'rules']) {
      const help = tokenwise([command, '--help'])
      expect(help.status).toBe(0)
      expect(help.out).toContain('Usage:')
    }
    const bad = tokenwise(['report', '--bogus'])
    expect(bad.status).toBe(2)
    expect(bad.err).toBe("tokenwise report: Unknown option '--bogus'\nRun `tokenwise --help` for usage.\n")
    // `tokenwise run` hands --help to the program, not to itself. The shell's own printf prints it
    // (a standalone echo or printf, such as the Rust coreutils on Ubuntu 26.04, may answer --help itself).
    expect(tokenwise(['run', '--', 'sh', '-c', 'printf "%s\\n" "$1"', 'sh', '--help']).out).toBe('--help\n')
  })
})

describe('tokenwise --version', () => {
  it('matches the published package version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(tokenwise(['--version']).out.trim()).toBe(manifest.version)
  })
})

describe('tokenwise doctor', () => {
  it('reports per-host negotiation', () => {
    const result = tokenwise(['doctor', '--json'])
    const doctor = JSON.parse(result.out)
    expect(doctor.hosts.find((host: { host: string }) => host.host === 'codex').mechanisms[0]).toMatchObject({ mechanism: 'economy', mode: 'apply' })
    expect(doctor.config.problems).toEqual([])
  })
})
